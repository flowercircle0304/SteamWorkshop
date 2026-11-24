"""ゲームごとの MOD 有効/無効設定との連動.

ワークショップの購読とは別に、ゲーム自身が MOD の ON/OFF を設定ファイルで管理している場合がある。
そのゲーム用のアダプタを用意し、ツールの有効/無効・ロード順と相互に同期する。
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path


class Sts2Adapter:
    """Slay the Spire 2: %APPDATA%/SlayTheSpire2/steam/<SteamID>/settings.save の mod_settings.mod_list"""

    appid = "2868840"
    label = "Slay the Spire 2 のゲーム内MOD設定"

    def files(self) -> list[Path]:
        base = Path(os.environ.get("APPDATA", "")) / "SlayTheSpire2" / "steam"
        fs = [f for f in base.glob("*/settings.save") if f.is_file()]
        return sorted(fs, key=lambda f: f.stat().st_mtime, reverse=True)

    def available(self) -> bool:
        return bool(self.files())

    @staticmethod
    def manifests(folder: str | None) -> list[dict]:
        """ワークショップアイテムに含まれる MOD マニフェスト（{"id":…, "has_dll"/"has_pck":…} の JSON）"""
        if not folder or not Path(folder).is_dir():
            return []
        root = Path(folder)
        out = []
        for f in root.rglob("*.json"):
            if len(f.relative_to(root).parts) > 3:
                continue
            try:
                j = json.loads(f.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                continue
            if isinstance(j, dict) and isinstance(j.get("id"), str) and ("has_dll" in j or "has_pck" in j):
                out.append(j)
        return out

    @classmethod
    def mod_ids(cls, folder: str | None) -> list[str]:
        return [m["id"] for m in cls.manifests(folder)]

    def deps(self, items: list[dict]) -> dict[str, dict]:
        """{ワークショップID: {"provides": [MOD id], "requires": [前提 MOD id]}}"""
        out = {}
        for it in items:
            ms = self.manifests(it.get("path"))
            if not ms:
                continue
            provides = [m["id"] for m in ms]
            requires = []
            for m in ms:
                for d in m.get("dependencies") or []:
                    did = d.get("id") if isinstance(d, dict) else d
                    if isinstance(did, str) and did not in provides and did not in requires:
                        requires.append(did)
            out[it["id"]] = {"provides": provides, "requires": requires}
        return out

    @staticmethod
    def _load(f: Path) -> tuple[dict, bytes]:
        raw = f.read_bytes()
        return json.loads(raw.decode("utf-8-sig")), raw

    def read(self, items: list[dict]) -> dict[str, bool]:
        """{ワークショップID: ゲーム内で有効か}（MOD マニフェストを持つアイテムのみ）"""
        files = self.files()
        if not files:
            return {}
        data, _ = self._load(files[0])
        ml = (data.get("mod_settings") or {}).get("mod_list") or []
        status = {str(m.get("id", "")).lower(): bool(m.get("is_enabled", True)) for m in ml if isinstance(m, dict)}
        out = {}
        for it in items:
            ids = self.mod_ids(it.get("path"))
            if ids:
                # アイテム内の MOD が 1 つでも無効なら無効扱い（未登録の MOD はゲームの既定＝有効）
                out[it["id"]] = all(status.get(i.lower(), True) for i in ids)
        return out

    def write(self, items: list[dict], disabled: set[str], order: list[str]) -> int:
        """ツールの有効/無効（とロード順）を設定ファイルに書く。変更したアイテム数を返す"""
        pos = {wid: n for n, wid in enumerate(order)}
        mapped = [(it, self.mod_ids(it.get("path"))) for it in items]
        mapped = [(it, ids) for it, ids in mapped if ids]
        changed_total = 0
        for f in self.files():
            data, raw = self._load(f)
            ms = data.setdefault("mod_settings", {})
            ml = ms.setdefault("mod_list", [])
            idx = {str(m.get("id", "")).lower(): m for m in ml if isinstance(m, dict)}
            changed = 0
            for it, ids in mapped:
                en = it["id"] not in disabled
                for mid in ids:
                    m = idx.get(mid.lower())
                    if m is None:
                        m = {"id": mid, "is_enabled": en, "source": "steam_workshop"}
                        ml.append(m)
                        idx[mid.lower()] = m
                        changed += 1
                    elif m.get("is_enabled") != en:
                        m["is_enabled"] = en
                        changed += 1
            if order:  # 並べ替えたことがある場合だけロード順も反映（ツールが知らない MOD は末尾に元の順で残す）
                rank = {}
                for it, ids in mapped:
                    for k, mid in enumerate(ids):
                        rank[mid.lower()] = (pos.get(it["id"], len(order)), k)
                new = sorted(ml, key=lambda m: rank.get(str(m.get("id", "")).lower(), (10 ** 9, 0)))
                if [id(m) for m in new] != [id(m) for m in ml]:
                    ml[:] = new
                    changed += 1
            if not changed:
                continue
            shutil.copy2(f, f.with_name(f.name + ".wsm-backup"))
            text = json.dumps(data, ensure_ascii=False, indent=2)
            if b"\r\n" in raw:
                text = text.replace("\n", "\r\n")
            if raw.endswith(b"\n"):
                text += "\r\n" if b"\r\n" in raw else "\n"
            f.write_bytes(text.encode("utf-8"))
            changed_total += changed
        return changed_total


ADAPTERS = {a.appid: a for a in (Sts2Adapter(),)}


def get(appid: str):
    a = ADAPTERS.get(str(appid))
    return a if a and a.available() else None
