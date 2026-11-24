"""追加機能: 前提MOD・バックアップと巻き戻し・お掃除（ごみ箱）・更新履歴・Windows通知・ツールの更新確認"""
from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WorkshopManager", "Accept-Language": "ja,en;q=0.8"}


def folder_size(p: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def is_workshop_item_dir(path: str, appid: str) -> bool:
    """steamapps/workshop/content/<appid>/<数字> の直下フォルダか（誤削除防止）"""
    p = Path(path).resolve()
    return (p.name.isdigit() and p.parent.name == str(appid) and p.parent.parent.name.lower() == "content"
            and p.parent.parent.parent.name.lower() == "workshop" and p.is_dir())


# ------------------------------------------------------------ 前提 MOD ----
def dependency_graph(adapter, items: list[dict]) -> dict:
    """{wid: {provides, requires, requiresItems(前提のワークショップID), missing(どこにも無い前提MOD)}}"""
    info = adapter.deps(items)
    provider = {}
    for wid, d in info.items():
        for mid in d["provides"]:
            provider[mid.lower()] = wid
    out = {}
    for wid, d in info.items():
        req_items, missing = [], []
        for mid in d["requires"]:
            p = provider.get(mid.lower())
            if p is None:
                missing.append(mid)
            elif p != wid and p not in req_items:
                req_items.append(p)
        out[wid] = {"provides": d["provides"], "requires": d["requires"],
                    "requiresItems": req_items, "missing": missing}
    return out


# ---------------------------------------------------------- バックアップ ----
class Backups:
    KEEP = 3  # 1 アイテムあたり保持する版の数

    def __init__(self, root: Path):
        self.root = root

    def _dir(self, appid: str, wid: str) -> Path:
        return self.root / str(appid) / str(wid)

    def list(self, appid: str, wid: str) -> list[dict]:
        d = self._dir(appid, wid)
        out = []
        if d.is_dir():
            for v in d.iterdir():
                meta = v / "meta.json"
                if v.is_dir() and meta.is_file():
                    try:
                        out.append({**json.loads(meta.read_text(encoding="utf-8")), "key": v.name})
                    except (OSError, ValueError):
                        pass
        # 新しい順（同じ秒に作られた場合は版の新しさで並べる）
        return sorted(out, key=lambda m: (m.get("created", 0), int(m.get("timeupdated") or 0)), reverse=True)

    def summary(self) -> dict:
        """{appid: {wid: [版...]}} と合計サイズ"""
        out, total = {}, 0
        if self.root.is_dir():
            for a in self.root.iterdir():
                if not a.is_dir():
                    continue
                for w in a.iterdir():
                    vs = self.list(a.name, w.name)
                    if vs:
                        out.setdefault(a.name, {})[w.name] = vs
                        total += sum(v.get("size", 0) for v in vs)
        return {"items": out, "total": total}

    def create(self, appid: str, item: dict, title: str = "", reason: str = "manual") -> dict | None:
        """現在の版を保存。同じ版（timeupdated）が既にあれば何もしない"""
        if not item.get("path") or not is_workshop_item_dir(item["path"], appid):
            raise ValueError("バックアップできるフォルダがありません")
        key = str(item.get("timeupdated") or int(time.time()))
        dst = self._dir(appid, item["id"]) / key
        if (dst / "meta.json").is_file():
            return None
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(item["path"], dst / "files")
        meta = {"created": int(time.time()), "timeupdated": item.get("timeupdated", 0),
                "size": folder_size(dst / "files"), "title": title, "reason": reason}
        (dst / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        for old in self.list(appid, item["id"])[self.KEEP:]:
            shutil.rmtree(self._dir(appid, item["id"]) / old["key"], ignore_errors=True)
        return {**meta, "key": key}

    def restore(self, appid: str, item: dict, key: str, title: str = "") -> None:
        src = self._dir(appid, item["id"]) / key / "files"
        if not src.is_dir():
            raise ValueError("バックアップが見つかりません")
        target = Path(item["path"] or "")
        if not is_workshop_item_dir(str(target), appid):
            raise ValueError("復元先のフォルダが見つかりません")
        if str(item.get("timeupdated")) != key:  # 今の版も残しておく（戻せるように）
            self.create(appid, item, title, reason="before-restore")
        tmp = target.with_name(target.name + ".wsm-restoring")
        old = target.with_name(target.name + ".wsm-old")
        for p in (tmp, old):
            if p.exists():
                shutil.rmtree(p)
        shutil.copytree(src, tmp)
        target.rename(old)
        tmp.rename(target)
        shutil.rmtree(old, ignore_errors=True)

    def delete(self, appid: str, wid: str, key: str) -> None:
        d = self._dir(appid, wid) / key
        if d.resolve().parent.parent.parent != self.root.resolve():
            raise ValueError("不正なバックアップです")
        shutil.rmtree(d, ignore_errors=True)


# --------------------------------------------------------------- ごみ箱 ----
def to_recycle_bin(paths: list[str]) -> None:
    """エクスプローラーと同じくごみ箱へ送る（完全削除はしない）"""
    if sys.platform != "win32":
        raise RuntimeError("ごみ箱への移動は Windows でのみ対応しています")
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                    ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", wintypes.BOOL),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]

    FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 3, 0x4, 0x10, 0x40, 0x400
    op = SHFILEOPSTRUCTW(None, FO_DELETE, "\0".join(paths) + "\0\0", None,
                         FOF_SILENT | FOF_NOCONFIRMATION | FOF_ALLOWUNDO | FOF_NOERRORUI, False, None, None)
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if rc != 0 or op.fAnyOperationsAborted:
        raise RuntimeError(f"ごみ箱へ移動できませんでした（コード {rc}）")


# ------------------------------------------------------------- 更新履歴 ----
_changelog_cache: dict = {}


def fetch_changelog(wid: str) -> list[dict]:
    """ワークショップの「変更履歴」ページから [{time, text}] を取り出す（新しい順）"""
    wid = re.sub(r"\D", "", str(wid))
    hit = _changelog_cache.get(wid)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]
    url = f"https://steamcommunity.com/sharedfiles/filedetails/changelog/{wid}?l=japanese"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
        page = r.read().decode("utf-8", "replace")
    entries = []
    for m in re.finditer(r'<p id="(\d{9,11})"[^>]*>(.*?)</p>', page, re.S):
        text = re.sub(r"<br\s*/?>", "\n", m.group(2))
        text = html.unescape(re.sub(r"<[^>]+>", "", text)).strip()
        entries.append({"time": int(m.group(1)), "text": text})
    entries.sort(key=lambda e: e["time"], reverse=True)
    _changelog_cache[wid] = (time.time(), entries)
    return entries


# ---------------------------------------------------------------- 通知 ----
def notify(title: str, text: str, icon: str) -> None:
    """Windows の通知（バルーン）を出す。PowerShell の NotifyIcon を使うので追加ソフト不要"""
    if sys.platform != "win32":
        return
    ps = ("Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;"
          "$n = New-Object System.Windows.Forms.NotifyIcon;"
          "try { $n.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:WSM_ICON) } catch { $n.Icon = [System.Drawing.SystemIcons]::Information };"
          "$n.Text = 'Workshop Manager'; $n.Visible = $true;"
          "$n.ShowBalloonTip(8000, $env:WSM_T, $env:WSM_X, 'Info'); Start-Sleep -Seconds 9; $n.Dispose()")
    env = {**os.environ, "WSM_T": title[:60], "WSM_X": text[:250], "WSM_ICON": icon}
    subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
                     env=env, creationflags=NO_WINDOW, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ------------------------------------------------------ ツールの更新確認 ----
def version_tuple(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v or "0")[:4])


def check_tool_update(url: str, current: str) -> dict:
    """url: GitHub の releases/latest API か {"version","url","notes"} の JSON"""
    if not url:
        return {"configured": False}
    with urllib.request.urlopen(urllib.request.Request(url, headers={**UA, "Accept": "application/json"}),
                                timeout=15) as r:
        d = json.loads(r.read().decode("utf-8"))
    latest = d.get("version") or d.get("tag_name") or ""
    link = d.get("url") or d.get("html_url") or ""
    notes = d.get("notes") or d.get("body") or ""
    # GitHub のリリースに添付された配布 ZIP と SHA256 ファイル
    assets = d.get("assets") or []
    zips = [a for a in assets if re.fullmatch(r"WorkshopManager.*\.zip", a.get("name") or "", re.I)]
    sums = [a for a in assets if (a.get("name") or "").lower().endswith(".sha256.txt")]
    z = zips[0] if zips else None
    return {"configured": True, "current": current, "latest": latest.lstrip("vV"), "url": link,
            "notes": notes[:2000], "available": version_tuple(latest) > version_tuple(current),
            "zipUrl": (z or {}).get("browser_download_url") or d.get("zip") or "",
            "zipName": (z or {}).get("name") or "", "zipSize": int((z or {}).get("size") or 0),
            "sha256Url": (sums[0] if sums else {}).get("browser_download_url") or d.get("sha256") or ""}


class SelfUpdater:
    """ツール本体の更新: ZIP をダウンロード → SHA256 を確認 → exe を入れ替え → 再起動"""

    def __init__(self):
        self.state = {"phase": "idle"}

    def status(self) -> dict:
        return dict(self.state)

    def _set(self, **kw):
        self.state = {**self.state, **kw}

    def _download(self, url: str, dest: Path, size: int) -> None:
        req = urllib.request.Request(url, headers={**UA, "Accept": "application/octet-stream"})
        with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
            total = int(r.headers.get("Content-Length") or size or 0)
            done = 0
            while chunk := r.read(256 * 1024):
                f.write(chunk)
                done += len(chunk)
                self._set(done=done, total=total)

    def run(self, info: dict, exe: Path, relaunch_args: list, on_ready) -> None:
        """別スレッドで実行する。成功したら on_ready() を呼んでアプリを終了させる"""
        import hashlib
        import tempfile
        import zipfile

        tmp = Path(tempfile.mkdtemp(prefix="wsm-update-"))
        new = exe.with_name(exe.stem + ".new.exe")
        old = exe.with_name(exe.stem + ".old.exe")
        try:
            if not info.get("zipUrl"):
                raise RuntimeError("リリースに配布用 ZIP（WorkshopManager_v〜.zip）が添付されていません")
            self._set(phase="download", version=info.get("latest"), done=0, total=info.get("zipSize") or 0, error="")
            zpath = tmp / "update.zip"
            self._download(info["zipUrl"], zpath, int(info.get("zipSize") or 0))

            self._set(phase="verify")
            if info.get("sha256Url"):
                with urllib.request.urlopen(urllib.request.Request(info["sha256Url"], headers=UA), timeout=30) as r:
                    m = re.search(r"\b[0-9a-fA-F]{64}\b", r.read().decode("utf-8", "replace"))
                if not m:
                    raise RuntimeError("SHA256 ファイルを読めませんでした")
                h = hashlib.sha256(zpath.read_bytes()).hexdigest()
                if h.lower() != m.group(0).lower():
                    raise RuntimeError("ダウンロードしたファイルが壊れています（SHA256 が一致しません）")
            with zipfile.ZipFile(zpath) as zf:
                members = [n for n in zf.namelist()
                           if n.replace("\\", "/").split("/")[-1].lower() == "workshopmanager.exe"]
                if not members:
                    raise RuntimeError("ZIP の中に WorkshopManager.exe がありません")
                data = zf.read(members[0])
            if data[:2] != b"MZ":
                raise RuntimeError("ZIP の中の exe が正しくありません")

            self._set(phase="install")
            new.write_bytes(data)
            # 実行中の exe は削除できないが、名前の変更はできる
            if old.exists():
                try:
                    old.unlink()
                except OSError:
                    old = exe.with_name(f"{exe.stem}.old-{int(time.time())}.exe")
            os.replace(exe, old)
            try:
                os.replace(new, exe)
            except OSError:
                os.replace(old, exe)  # 元に戻す
                raise
            self._relaunch(exe, relaunch_args)
            self._set(phase="restart")
            on_ready()
        except PermissionError:
            self._set(phase="error", error="exe を置き換える権限がありません。"
                      "Program Files など保護されたフォルダに置いている場合は、ZIP を手動でダウンロードしてください")
        except Exception as e:  # noqa: BLE001
            self._set(phase="error", error=str(e))
        finally:
            try:
                new.unlink(missing_ok=True)
            except OSError:
                pass
            shutil.rmtree(tmp, ignore_errors=True)

    @staticmethod
    def _relaunch(exe: Path, args: list) -> None:
        """今のプロセス（と PyInstaller の親プロセス）が終わるのを待ってから新しい exe を起動する"""
        import base64

        pids = ",".join(str(p) for p in {os.getpid(), os.getppid()} if p)
        q = lambda s: "'" + str(s).replace("'", "''") + "'"  # noqa: E731
        import tempfile

        log = Path(tempfile.gettempdir()) / "WorkshopManager-update.log"
        ps = (f"$log = {q(log)}; function L($m) {{ Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + ' ' + $m) }}; "
              f"try {{ L 'waiting {pids}'; Wait-Process -Id {pids} -Timeout 120 -ErrorAction SilentlyContinue; "
              f"Start-Sleep -Milliseconds 800; L 'starting'; "
              f"Start-Process -FilePath {q(exe)} -WorkingDirectory {q(exe.parent)}"
              + (f" -ArgumentList @({','.join(q(a) for a in args)})" if args else "")
              + "; L 'started' } catch { L ('error: ' + $_) }")
        enc = base64.b64encode(ps.encode("utf-16-le")).decode()
        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", enc]
        # PyInstaller の内部用の環境変数を引き継ぐと、新しい exe が古い一時フォルダを使おうとして起動に失敗する
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("_PYI_", "_MEI"))}
        env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
        flags = NO_WINDOW | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        # exe 版は親プロセスのジョブに入っていて、終了時に一緒に止められるのでジョブから外す
        breakaway = getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)
        for f in (flags | breakaway, flags):
            try:
                subprocess.Popen(cmd, creationflags=f, close_fds=True, stdin=subprocess.DEVNULL, env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except OSError:
                continue
        raise RuntimeError("再起動の準備ができませんでした。ツールを手動で起動し直してください")


def cleanup_old_exe(exe: Path) -> None:
    """前回の更新で残った古い exe を削除する"""
    for p in exe.parent.glob(exe.stem + ".old*.exe"):
        try:
            p.unlink()
        except OSError:
            pass
