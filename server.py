"""Steam Workshop Manager - Steamクライアントと連携するワークショップ/MOD管理ツール.

`python server.py` でデスクトップウィンドウ (pywebview) が開きます。
`--browser` を付けると開発用にブラウザで開きます。
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import features
import game_adapters
import steam_bridge

# コンソール無しのexeでは stdout/stderr が None になるので捨て先を用意する
for _n in ("stdout", "stderr"):
    if getattr(sys, _n) is None:
        setattr(sys, _n, open(os.devnull, "w", encoding="utf-8"))

FROZEN = getattr(sys, "frozen", False)
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# exe化時: 同梱ファイルは一時展開先、設定データはexeの隣に置く
ROOT = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent
STATIC = (Path(getattr(sys, "_MEIPASS", ROOT)) / "static").resolve()
VERSION = "1.6.2"
APP_NAME = "Workshop Manager"
# 設定の保存先: exe の隣に data フォルダがあればそこ（ポータブル利用）、無ければ %APPDATA%\WorkshopManager
if not FROZEN or (ROOT / "data").is_dir() or not os.environ.get("APPDATA"):
    DATA = ROOT / "data"
else:
    DATA = Path(os.environ["APPDATA"]) / "WorkshopManager"
STATE_FILE = DATA / "state.json"
CACHE_FILE = DATA / "meta_cache.json"
HOST = "127.0.0.1"
PORT = int(os.environ.get("WSM_PORT", "0"))  # 0 = 空いているポートを自動選択
TOKEN = secrets.token_urlsafe(24)
API = "https://api.steampowered.com/ISteamRemoteStorage"
DEPLOY_MARK = ".wsm_deployed"
# ツールの更新確認先（GitHub の releases/latest API か {"version","url","notes"} の JSON）。空なら確認しない
UPDATE_URL = "https://api.github.com/repos/flowercircle0304/SteamWorkshop/releases/latest"

lock = threading.RLock()


# ---------------------------------------------------------------- VDF ----
def parse_vdf(text: str) -> dict:
    toks: list = []
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"|([{}])', text):
        if m.group(2):
            toks.append(m.group(2))
        else:
            toks.append(("s", m.group(1).replace('\\"', '"').replace("\\\\", "\\")))

    def obj(i: int):
        d: dict = {}
        while i < len(toks):
            t = toks[i]
            if t == "}":
                return d, i + 1
            if t == "{":  # malformed, skip
                i += 1
                continue
            key = t[1]
            i += 1
            if i >= len(toks):
                break
            nxt = toks[i]
            if nxt == "{":
                v, i = obj(i + 1)
            elif nxt == "}":
                v = ""
            else:
                v = nxt[1]
                i += 1
            d[key] = v
        return d, i

    return obj(0)[0]


def ci(d, key, default=None):
    """case-insensitive dict get"""
    if not isinstance(d, dict):
        return default
    if key in d:
        return d[key]
    lk = key.lower()
    for k, v in d.items():
        if k.lower() == lk:
            return v
    return default


def read_vdf(p: Path) -> dict:
    try:
        return parse_vdf(p.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return {}


# -------------------------------------------------------------- Steam ----
def steam_path() -> Path | None:
    env = os.environ.get("STEAM_PATH")
    if env:
        return Path(env)
    if sys.platform == "win32":
        import winreg

        for hive, sub in (
            (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam"),
        ):
            try:
                with winreg.OpenKey(hive, sub) as k:
                    for name in ("SteamPath", "InstallPath"):
                        try:
                            return Path(winreg.QueryValueEx(k, name)[0])
                        except OSError:
                            pass
            except OSError:
                pass
        p = Path(r"C:\Program Files (x86)\Steam")
        return p if p.exists() else None
    for p in (Path.home() / ".steam/steam", Path.home() / ".local/share/Steam",
              Path.home() / "Library/Application Support/Steam"):
        if p.exists():
            return p
    return None


def library_paths() -> list[Path]:
    sp = steam_path()
    if not sp:
        return []
    libs: list[Path] = []
    data = read_vdf(sp / "steamapps" / "libraryfolders.vdf")
    for v in (ci(data, "libraryfolders") or {}).values():
        if isinstance(v, dict) and ci(v, "path"):
            libs.append(Path(ci(v, "path")))
    norm = {str(p).lower().replace("/", "\\") for p in libs}
    if str(sp).lower().replace("/", "\\") not in norm:
        libs.insert(0, sp)
    return [p for p in libs if p.exists()]


def item_needs_update(det: dict, tu: int, branch: str) -> bool:
    """更新が必要か。作者がゲームのブランチごとに別の版を出している場合
    （author_snapshots）は、自分のブランチ向けの版と比べる"""
    snaps = [s for s in (ci(det, "author_snapshots") or {}).values() if isinstance(s, dict)]
    have = str(ci(det, "manifest", ""))
    if snaps:
        mine = [s for s in snaps if branch in (ci(s, "game_branch_min"), ci(s, "game_branch_max"))]
        if not mine:  # ブランチが一致しなければ、今の版がどれかの版と同じなら最新とみなす
            if have in {str(ci(s, "manifest", "")) for s in snaps}:
                return False
            mine = snaps
        target = max(mine, key=lambda s: int(ci(s, "timeupdated", 0) or 0))
        return str(ci(target, "manifest", "")) != have
    if str(ci(det, "manifest", "")) == "-1":  # 古い形式の項目は Steam も更新しない
        return False
    latest_mf = str(ci(det, "latest_manifest", "") or "")
    if latest_mf and have and latest_mf == have:
        return False
    return int(ci(det, "latest_timeupdated", 0) or 0) > tu


def scan() -> dict:
    libs = library_paths()
    names: dict[str, str] = {}
    branches: dict[str, str] = {}  # appid → 使っているベータブランチ（なければ public）
    for lib in libs:
        for mf in (lib / "steamapps").glob("appmanifest_*.acf"):
            st = ci(read_vdf(mf), "AppState") or {}
            if ci(st, "appid"):
                names[str(ci(st, "appid"))] = ci(st, "name", "")
                cfg = ci(st, "MountedConfig") or ci(st, "UserConfig") or {}
                branches[str(ci(st, "appid"))] = str(ci(cfg, "BetaKey", "") or "public")

    names.setdefault("241100", "Steam コントローラー設定")
    games: dict[str, dict] = {}
    for lib in libs:
        ws = lib / "steamapps" / "workshop"
        if not ws.exists():
            continue
        appids = {m.group(1) for f in ws.glob("appworkshop_*.acf")
                  if (m := re.match(r"appworkshop_(\d+)\.acf", f.name))}
        content_root = ws / "content"
        if content_root.exists():
            appids |= {d.name for d in content_root.iterdir() if d.is_dir() and d.name.isdigit()}
        for appid in appids:
            aw = ci(read_vdf(ws / f"appworkshop_{appid}.acf"), "AppWorkshop") or {}
            installed = ci(aw, "WorkshopItemsInstalled") or {}
            details = ci(aw, "WorkshopItemDetails") or {}
            cdir = content_root / appid
            folders = {d.name: d for d in cdir.iterdir() if d.is_dir()} if cdir.exists() else {}
            g = games.setdefault(appid, {
                "appid": appid, "name": names.get(appid) or f"App {appid}",
                "library": str(lib), "items": {}})
            for iid in set(installed) | set(details) | set(folders):
                if not iid.isdigit():
                    continue
                inst = installed.get(iid) or {}
                det = details.get(iid) or {}
                path = folders.get(iid)
                g["items"][iid] = {
                    "id": iid,
                    "appid": appid,
                    "path": str(path) if path else None,
                    "installed": bool(path),
                    # Steam の記録（appworkshop_*.acf）から購読状態と更新の有無を読む。
                    # これで画面表示のために Steam API へ接続する（＝ゲームを「実行中」にする）必要がなくなる
                    "subscribed": str(ci(det, "subscribedby", "0") or "0") not in ("", "0"),
                    "size": int(ci(inst, "size", 0) or 0),
                    "timeupdated": int(ci(inst, "timeupdated", 0) or ci(det, "timeupdated", 0) or 0),
                    "timetouched": int(ci(det, "timetouched", 0) or 0),
                }
                tu = g["items"][iid]["timeupdated"]
                g["items"][iid]["needsUpdate"] = bool(path and tu and item_needs_update(det, tu, branches.get(appid, "public")))
                # Steam が更新を確認済みの項目は、Web の更新日時ではなく Steam の記録で判定する
                g["items"][iid]["steamChecked"] = bool(ci(det, "latest_timeupdated"))
    for g in games.values():
        g["items"] = list(g["items"].values())
    return {"steamPath": str(steam_path() or ""), "libraries": [str(p) for p in libs],
            "games": sorted(games.values(), key=lambda g: g["name"].lower())}


# ----------------------------------------------------------- storage ----
def load_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(p: Path, data) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=1)
    tmp = p.with_suffix(".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, p)  # 書き込み途中で壊れないよう一時ファイル経由で置き換える
    except OSError:
        # リダイレクト/仮想化されたフォルダでは置き換えが失敗することがあるので直接書く
        p.write_text(text, encoding="utf-8")
        try:
            tmp.unlink()
        except OSError:
            pass


state = load_json(STATE_FILE, {"games": {}})
meta_cache: dict = load_json(CACHE_FILE, {})


def game_state(appid: str) -> dict:
    g = state.setdefault("games", {}).setdefault(appid, {})
    g.setdefault("disabled", [])
    g.setdefault("order", [])
    g.setdefault("notes", {})
    g.setdefault("profiles", {})
    g.setdefault("deploy", {"path": "", "mode": "junction", "naming": "id"})
    g.setdefault("deployed", [])
    g.setdefault("launch", {"args": "", "deploy": False})
    return g


# ------------------------------------------------------------ Steam API --
def steam_post(method: str, fields: dict) -> dict:
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(f"{API}/{method}/v1/", data=body,
                                 headers={"User-Agent": "WorkshopManager/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_meta(ids: list[str], force: bool = False) -> dict:
    now = time.time()
    todo = [i for i in ids if force or i not in meta_cache
            or now - meta_cache[i].get("_fetched", 0) > 6 * 3600]
    for start in range(0, len(todo), 100):
        chunk = todo[start:start + 100]
        fields = {"itemcount": len(chunk)}
        for n, i in enumerate(chunk):
            fields[f"publishedfileids[{n}]"] = i
        res = steam_post("GetPublishedFileDetails", fields)
        for d in ((res.get("response") or {}).get("publishedfiledetails") or []):
            iid = str(d.get("publishedfileid"))
            meta_cache[iid] = {
                "ok": d.get("result") == 1,
                "title": d.get("title"),
                "description": d.get("description", ""),
                "preview": d.get("preview_url"),
                "creator": d.get("creator"),
                "tags": [t.get("tag") for t in d.get("tags") or []],
                "time_updated": d.get("time_updated", 0),
                "time_created": d.get("time_created", 0),
                "file_size": int(d.get("file_size") or 0),
                "subscriptions": d.get("lifetime_subscriptions") or d.get("subscriptions", 0),
                "favorited": d.get("lifetime_favorited") or d.get("favorited", 0),
                "views": d.get("views", 0),
                "_fetched": now,
            }
    with lock:
        save_json(CACHE_FILE, meta_cache)
    return {i: meta_cache.get(i) for i in ids}


def fetch_collection(cid: str) -> dict:
    res = steam_post("GetCollectionDetails", {"collectioncount": 1, "publishedfileids[0]": cid})
    det = ((res.get("response") or {}).get("collectiondetails") or [{}])[0]
    children = [str(c.get("publishedfileid")) for c in det.get("children") or []]
    meta = fetch_meta([cid] + children) if children else fetch_meta([cid])
    return {"id": cid, "title": (meta.get(cid) or {}).get("title"), "children": children,
            "meta": {k: v for k, v in meta.items() if k != cid}}


# ------------------------------------------------------------- deploy ----
def find_item(appid: str, iid: str):
    for g in scan()["games"]:
        if g["appid"] == appid:
            for it in g["items"]:
                if it["id"] == iid:
                    return it
    return None


def safe_name(s: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", s or "").strip(" .")
    return s[:80] or "mod"


def is_link(p: Path) -> bool:
    try:
        return p.is_symlink() or (hasattr(p, "is_junction") and p.is_junction())
    except OSError:
        return False


def undeploy(appid: str) -> list[str]:
    g = game_state(appid)
    target = Path(g["deploy"].get("path") or "")
    removed = []
    if target.is_dir():
        for name in g.get("deployed", []):
            p = target / name
            if is_link(p):
                os.rmdir(p) if p.is_dir() else os.unlink(p)
                removed.append(name)
            elif p.is_dir() and (p / DEPLOY_MARK).exists():
                shutil.rmtree(p)
                removed.append(name)
    g["deployed"] = []
    return removed


def deploy(appid: str) -> dict:
    g = game_state(appid)
    cfg = g["deploy"]
    target = Path(cfg.get("path") or "")
    if not cfg.get("path") or not target.is_dir():
        raise ValueError("デプロイ先フォルダが存在しません")
    game = next((x for x in scan()["games"] if x["appid"] == appid), None)
    if not game:
        raise ValueError("ゲームが見つかりません")
    items = {it["id"]: it for it in game["items"]}
    ordered = [i for i in g["order"] if i in items] + sorted(i for i in items if i not in g["order"])
    enabled = [i for i in ordered if i not in g["disabled"] and items[i]["installed"]]
    removed = undeploy(appid)
    done, skipped = [], []
    for n, iid in enumerate(enabled, 1):
        title = (meta_cache.get(iid) or {}).get("title") or iid
        naming = cfg.get("naming", "id")
        name = {"order_id": f"{n:03d}_{iid}", "title": safe_name(title),
                "order_title": f"{n:03d}_{safe_name(title)}"}.get(naming, iid)
        dst = target / name
        if dst.exists() or is_link(dst):
            skipped.append(f"{name} (既に存在)")
            continue
        src = Path(items[iid]["path"])
        try:
            if cfg.get("mode") == "copy":
                shutil.copytree(src, dst)
                (dst / DEPLOY_MARK).write_text(iid, encoding="utf-8")
            elif sys.platform == "win32":
                r = subprocess.run(["cmd", "/c", "mklink", "/J", str(dst), str(src)],
                                   capture_output=True, text=True, creationflags=NO_WINDOW)
                if r.returncode != 0:
                    raise OSError(r.stderr.strip() or r.stdout.strip())
            else:
                os.symlink(src, dst, target_is_directory=True)
            done.append(name)
        except OSError as e:
            skipped.append(f"{name} ({e})")
    g["deployed"] = done
    return {"removed": len(removed), "deployed": done, "skipped": skipped}


# ------------------------------------------------------------- server ----
def open_target(target: str) -> None:
    if re.match(r"^(steam://|https://steamcommunity\.com/|https://store\.steampowered\.com/)", target):
        webbrowser.open(target)
        return
    p = Path(target)
    if not p.is_dir():
        raise ValueError("フォルダが存在しません")
    if sys.platform == "win32":
        os.startfile(p)  # noqa
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(p)])


class Handler(BaseHTTPRequestHandler):
    server_version = "WorkshopManager/1.0"

    def log_message(self, fmt, *args):  # quieter
        if args and "/api/" in str(args[0]):
            sys.stderr.write("[api] " + (fmt % args) + "\n")

    def do_HEAD(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        f = (STATIC / path.lstrip("/")).resolve()
        if STATIC not in f.parents or not f.is_file():
            self.send_error(404)
            return
        body = f.read_bytes()
        if f.name == "index.html":
            body = body.replace(b"__TOKEN__", TOKEN.encode())
        ctype = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                 ".svg": "image/svg+xml"}.get(f.suffix, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            body = {}
        if self.headers.get("X-WSM-Token") != TOKEN:
            self.send_json({"error": "forbidden"}, 403)
            return
        try:
            route = urllib.parse.urlparse(self.path).path
            if route in STEAM_ROUTES:  # Steam呼び出しは時間がかかるので全体ロックを取らない
                self.send_json(STEAM_ROUTES[route](body))
                return
            fn = ROUTES.get(route)
            if not fn:
                self.send_json({"error": "not found"}, 404)
                return
            with lock:
                result = fn(body)
            self.send_json(result)
        except Exception as e:  # noqa: BLE001
            self.send_json({"error": str(e)}, 400)


def r_scan(_b):
    data = scan()
    for g in data["games"]:
        g["state"] = game_state(g["appid"])
        ad = game_adapters.get(g["appid"])
        g["adapter"] = ad.label if ad else None
    for g in data["games"]:  # お掃除でごみ箱へ送ったものは Steam の記録が残っていても表示しない
        cleaned = set(g["state"].get("cleaned", []))
        g["items"] = [i for i in g["items"] if i["installed"] or i["id"] not in cleaned]
    data["meta"] = {i["id"]: meta_cache[i["id"]] for g in data["games"]
                    for i in g["items"] if i["id"] in meta_cache}
    data["version"] = VERSION
    return data


def r_update(b):
    g = game_state(str(b["appid"]))
    for k in ("disabled", "order", "notes", "steamSync", "orderCustom", "gameSync"):
        if k in b:
            g[k] = b[k]
    if "launch" in b:
        g["launch"].update({k: v for k, v in b["launch"].items() if k in ("args", "deploy", "profile")})
    if "deploy" in b:
        g["deploy"].update({k: v for k, v in b["deploy"].items() if k in ("path", "mode", "naming")})
    save_json(STATE_FILE, state)
    return {"state": g}


def unique_name(profiles: dict, name: str) -> str:
    base, n = name, 2
    while name in profiles:
        name, n = f"{base} ({n})", n + 1
    return name


def clean_mods(mods) -> list[dict]:
    out, seen = [], set()
    for m in mods or []:
        iid = str(m.get("id", "")) if isinstance(m, dict) else ""
        if iid.isdigit() and iid not in seen:
            seen.add(iid)
            out.append({"id": iid, "enabled": bool(m.get("enabled", True))})
    return out


def make_profile(mods: list[dict], **extra) -> dict:
    return {"mods": mods, "disabled": [m["id"] for m in mods if not m["enabled"]],
            "order": [m["id"] for m in mods], "saved": int(time.time()), **extra}


def r_profile(b):
    g = game_state(str(b["appid"]))
    action = b.get("action")
    if action == "import":
        added = []
        for p in b.get("profiles") or []:
            mods = clean_mods(p.get("mods"))
            if not mods:
                continue
            name = unique_name(g["profiles"], (str(p.get("name") or "").strip() or "インポート")[:60])
            g["profiles"][name] = make_profile(mods, imported=True, customOrder=bool(p.get("customOrder")))
            added.append(name)
        if not added:
            raise ValueError("読み込めるプロファイルがありませんでした")
        save_json(STATE_FILE, state)
        return {"state": g, "added": added}

    name = (b.get("name") or "").strip()
    if not name:
        raise ValueError("プロファイル名が空です")
    if action == "save":
        ids = [str(i) for i in b.get("mods") or g["order"]]
        g["profiles"][name] = make_profile([{"id": i, "enabled": i not in g["disabled"]} for i in ids],
                                           customOrder=bool(g.get("orderCustom")))
    elif action == "apply":
        p = g["profiles"].get(name)
        if not p:
            raise ValueError("プロファイルが見つかりません")
        if p.get("mods"):
            # プロファイルに含まれない MOD は無効にする（共有されたプロファイルを再現するため）
            enabled = {m["id"] for m in p["mods"] if m["enabled"]}
            current = {str(i) for i in b.get("current") or []}
            g["order"] = [m["id"] for m in p["mods"]]
            g["disabled"] = sorted((current | set(g["order"])) - enabled)
            g["orderCustom"] = bool(p.get("customOrder"))
            g["appliedProfile"] = name  # 足りない MOD を一覧に表示するため
        else:  # 旧形式
            g["disabled"], g["order"] = list(p.get("disabled", [])), list(p.get("order", []))
    elif action == "rename":
        new = (b.get("newName") or "").strip()[:60]
        if not new or name not in g["profiles"]:
            raise ValueError("名前を変更できません")
        if new != name:
            new = unique_name(g["profiles"], new)
            g["profiles"][new] = g["profiles"].pop(name)
            if g.get("appliedProfile") == name:
                g["appliedProfile"] = new
    elif action == "delete":
        g["profiles"].pop(name, None)
        if g.get("appliedProfile") == name:
            g.pop("appliedProfile", None)
    else:
        raise ValueError("unknown action")
    save_json(STATE_FILE, state)
    return {"state": g}


def game_items(appid: str) -> list[dict]:
    for gm in scan()["games"]:
        if gm["appid"] == appid:
            return [i for i in gm["items"] if i["installed"]]
    return []


def game_write(appid: str) -> dict:
    """ツールの有効/無効をゲームの設定に書く。ゲーム実行中は終了後に回す"""
    ad = game_adapters.get(appid)
    g = game_state(appid)
    if not ad or g.get("gameSync") is False:
        return {"supported": bool(ad), "written": 0}
    if game_running(appid):
        g["gamePending"] = True
        save_json(STATE_FILE, state)
        return {"supported": True, "pending": True, "state": g}
    n = ad.write(game_items(appid), set(g["disabled"]), g["order"] if g.get("orderCustom") else [])
    g["gamePending"] = False
    save_json(STATE_FILE, state)
    return {"supported": True, "written": n, "state": g}


def r_game_read(b):
    """ゲームの設定を読み、ツールの有効/無効に取り込む（保留中の変更があれば先に書く）"""
    appid = str(b["appid"])
    ad = game_adapters.get(appid)
    g = game_state(appid)
    if not ad or g.get("gameSync") is False:
        return {"supported": bool(ad)}
    if g.get("gamePending"):
        res = game_write(appid)
        if not res.get("pending"):
            return {**res, "flushed": True}
        return res
    enabled = ad.read(game_items(appid))
    dis = set(g["disabled"])
    for wid, en in enabled.items():
        (dis.discard if en else dis.add)(wid)
    if dis != set(g["disabled"]):
        g["disabled"] = sorted(dis)
        save_json(STATE_FILE, state)
    return {"supported": True, "state": g, "mapped": len(enabled)}


def r_deploy(b):
    res = deploy(str(b["appid"]))
    save_json(STATE_FILE, state)
    return res


def r_undeploy(b):
    removed = undeploy(str(b["appid"]))
    save_json(STATE_FILE, state)
    return {"removed": removed}


ROUTES = {
    "/api/scan": r_scan,
    "/api/meta": lambda b: fetch_meta([str(i) for i in b.get("ids", [])], bool(b.get("force"))),
    "/api/update": r_update,
    "/api/profile": r_profile,
    "/api/deploy": r_deploy,
    "/api/undeploy": r_undeploy,
    "/api/open": lambda b: (open_target(str(b.get("target", ""))), {"ok": True})[1],
    "/api/game/read": r_game_read,
    "/api/game/write": lambda b: game_write(str(b["appid"])),
    "/api/collection": lambda b: fetch_collection(re.sub(r"\D", "", str(b.get("id", "")))),
}

# -------------------------------------------------------------- Steam ----
def _find_dll() -> str:
    info = steam_bridge.find_dll(ROOT, library_paths(), state.get("steam_dll"))
    with lock:
        if state.get("steam_dll") != info["path"]:
            state["steam_dll"] = info["path"]
            save_json(STATE_FILE, state)
    return info["path"]


steam = steam_bridge.SteamManager(
    [sys.executable] if FROZEN else [sys.executable, str(Path(__file__).resolve())], _find_dll)
STEAM_ACTIONS = ("subscribe", "unsubscribe", "download", "set_disabled", "set_load_order")


def running_apps() -> set[str]:
    """Steam が実行中としているゲームの AppID（HKCU/Software/Valve/Steam/Apps/<id> の Running 値）"""
    if sys.platform != "win32":
        return set()
    import winreg

    out: set[str] = set()
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam\Apps") as root:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(root, i)
                except OSError:
                    break
                i += 1
                try:
                    with winreg.OpenKey(root, sub) as k:
                        if winreg.QueryValueEx(k, "Running")[0] == 1:
                            out.add(sub)
                except OSError:
                    pass
    except OSError:
        pass
    return out


def our_appid() -> str | None:
    w = steam.worker
    return w.appid if w and w.alive() else None


def game_dir(appid: str) -> Path | None:
    for lib in library_paths():
        mf = lib / "steamapps" / f"appmanifest_{appid}.acf"
        if mf.exists():
            d = ci(ci(read_vdf(mf), "AppState") or {}, "installdir")
            if d:
                return lib / "steamapps" / "common" / d
    return None


def process_in_dir(folder: Path) -> bool:
    """folder の中の exe が動いているか"""
    if sys.platform != "win32" or not folder:
        return False
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    arr = (wintypes.DWORD * 4096)()
    got = wintypes.DWORD()
    if not psapi.EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(got)):
        return False
    prefix = str(folder.resolve()).lower().rstrip("\\") + "\\"
    buf = ctypes.create_unicode_buffer(1024)
    for pid in arr[:got.value // ctypes.sizeof(wintypes.DWORD)]:
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            continue
        try:
            n = wintypes.DWORD(len(buf))
            if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)) and buf.value.lower().startswith(prefix):
                return True
        finally:
            k32.CloseHandle(h)
    return False


def game_running(appid: str) -> bool:
    """ゲーム本体が実行中か。このツールの Steam 連携も Steam 上は「実行中」になるので、
    その場合はゲームのフォルダの exe が動いているかで判断する"""
    if appid not in running_apps():
        return False
    if our_appid() != appid:
        return True
    d = game_dir(appid)
    return process_in_dir(d) if d else False


def flush_pending() -> list[str]:
    """ゲームの終了を待っていた設定の書き込みを行う"""
    done = []
    for appid, g in list(state.get("games", {}).items()):
        if isinstance(g, dict) and g.get("gamePending") and not game_running(appid):
            try:
                with lock:
                    if game_write(appid).get("written") is not None:
                        done.append(appid)
            except Exception:  # noqa: BLE001
                pass
    return done


def r_running(_b):
    flushed = flush_pending()
    return {"running": sorted(running_apps()), "ours": our_appid(), "flushed": flushed,
            "states": {a: game_state(a) for a in flushed}}


def guard_running(appid: str) -> None:
    """ゲーム本体が起動中なら Steam 連携を始めない（同じ AppID で接続すると競合するため）"""
    if our_appid() != appid and appid in running_apps():
        raise RuntimeError("ゲームの実行中は Steam 連携を一時停止しています")


def r_launch(b):
    appid = str(b["appid"])
    if not appid.isdigit():
        raise ValueError("AppID が不正です")
    g = game_state(appid)
    if "launch" in b:
        g["launch"].update({k: v for k, v in b["launch"].items() if k in ("args", "deploy", "profile")})
        save_json(STATE_FILE, state)
    applied = None
    pname = g["launch"].get("profile")
    if pname and pname in g["profiles"]:  # 起動時にプロファイルを適用
        with lock:
            r_profile({"appid": appid, "action": "apply", "name": pname,
                       "current": [i["id"] for i in game_items(appid)]})
            game_write(appid)
        applied = pname
        w = steam.worker
        if g.get("steamSync") and w and w.alive() and w.appid == appid:  # Steam 同期中なら Steam にも反映
            try:
                subs = [i["id"] for i in w.call("info").get("items", []) if i.get("subscribed")]
                dis = set(g["disabled"])
                w.call("set_disabled", ids=[i for i in subs if i in dis], disabled=True)
                w.call("set_disabled", ids=[i for i in subs if i not in dis], disabled=False)
            except RuntimeError:
                pass
    deployed = None
    if g["launch"].get("deploy"):
        with lock:
            deployed = deploy(appid)
            save_json(STATE_FILE, state)
    # 連携ワーカーが同じ AppID で接続していると「既に実行中」扱いになるので先に切断する
    was = steam.worker.appid if steam.worker else None
    steam.disconnect()
    if was == appid:  # Steam が連携ワーカーの終了を認識するまで待つ
        for _ in range(30):
            if appid not in running_apps():
                break
            time.sleep(0.1)
    args = (g["launch"].get("args") or "").strip()
    url = f"steam://run/{appid}//{urllib.parse.quote(args)}/" if args else f"steam://rungameid/{appid}"
    if sys.platform == "win32":
        os.startfile(url)  # noqa
    else:
        webbrowser.open(url)
    return {"ok": True, "url": url, "deployed": deployed, "applied": applied, "state": g}


def r_steam_connect(b):
    guard_running(str(b["appid"]))
    info = steam.call(str(b["appid"]), "info", ids=[str(i) for i in b.get("ids", [])])
    return {**steam.status(), **info}


def r_steam_status(b):
    return steam.call(str(b["appid"]), "status", ids=[str(i) for i in b.get("ids", [])])


def r_steam_action(b):
    guard_running(str(b["appid"]))
    action = b.get("action")
    if action not in STEAM_ACTIONS:
        raise ValueError("unknown action")
    return steam.call(str(b["appid"]), action, ids=[str(i) for i in b.get("ids", [])],
                      disabled=bool(b.get("disabled")))


def r_steam_disconnect(_b):
    steam.disconnect()
    return steam.status()


backups = features.Backups(DATA / "backups")


def find_game_item(appid: str, wid: str) -> dict:
    for it in game_items(appid):
        if it["id"] == str(wid):
            return it
    raise ValueError("アイテムが見つかりません")


def r_deps(b):
    appid = str(b["appid"])
    ad = game_adapters.get(appid)
    if not ad or not hasattr(ad, "deps"):
        return {"supported": False}
    return {"supported": True, "graph": features.dependency_graph(ad, game_items(appid))}


def r_backup_create(b):
    appid = str(b["appid"])
    made = []
    for wid in b.get("ids") or []:
        it = find_game_item(appid, wid)
        title = (meta_cache.get(it["id"]) or {}).get("title") or ""
        r = backups.create(appid, it, title, reason=b.get("reason") or "manual")
        if r:
            made.append(it["id"])
    return {"created": made}


def r_backup_restore(b):
    appid = str(b["appid"])
    if game_running(appid):
        raise RuntimeError("ゲームの実行中は復元できません。ゲームを終了してください")
    it = find_game_item(appid, b["id"])
    backups.restore(appid, it, str(b["key"]), (meta_cache.get(it["id"]) or {}).get("title") or "")
    return {"ok": True}


def r_cleanup_delete(b):
    """購読していないアイテムのフォルダをごみ箱へ送る"""
    appid = str(b["appid"])
    ids = [str(i) for i in b.get("ids") or []]
    if game_running(appid):
        raise RuntimeError("ゲームの実行中は削除できません。ゲームを終了してください")
    # 購読状態は Steam の記録から判定する（Steam に接続しない）
    st = {i["id"]: i for i in game_items(appid)}
    paths, done = [], []
    for wid in ids:
        if st.get(wid, {}).get("subscribed"):
            raise ValueError("購読中のアイテムは削除できません。先に購読を解除してください")
        it = find_game_item(appid, wid)
        if not features.is_workshop_item_dir(it["path"], appid):
            raise ValueError(f"削除できないフォルダです: {it['path']}")
        paths.append(it["path"])
        done.append(wid)
    if paths:
        features.to_recycle_bin(paths)
    with lock:
        g = game_state(appid)
        g["cleaned"] = sorted(set(g.get("cleaned", [])) | set(done))
        g["disabled"] = [i for i in g["disabled"] if i not in done]
        save_json(STATE_FILE, state)
    return {"deleted": done}


def r_steam_search(b):
    appid = str(b["appid"])
    guard_running(appid)
    res = steam.call(appid, "search", text=b.get("text") or "", sort=b.get("sort") or "trend",
                     page=int(b.get("page") or 1))
    res["meta"] = fetch_meta(res["ids"]) if res.get("ids") else {}
    return res


def r_tool_update(_b):
    url = state.get("updateUrl") or UPDATE_URL
    try:
        r = features.check_tool_update(url, VERSION)
        r["canInstall"] = FROZEN and bool(r.get("zipUrl"))
        return r
    except Exception as e:  # noqa: BLE001
        return {"configured": bool(url), "error": str(e), "current": VERSION}


updater = features.SelfUpdater()
quit_event = threading.Event()
WINDOW = None


def request_quit() -> None:
    """更新のためにアプリを終了する（画面に再起動を伝えるため少し待つ）"""
    def later():
        time.sleep(1.5)
        quit_event.set()
        if WINDOW is not None:
            try:
                WINDOW.destroy()
            except Exception:  # noqa: BLE001
                pass
    threading.Thread(target=later, daemon=True).start()


def r_tool_install(_b):
    if not FROZEN:
        raise ValueError("開発用の表示では本体の更新はできません（exe 版で使えます）")
    if updater.status().get("phase") in ("download", "verify", "install", "restart"):
        return updater.status()
    info = features.check_tool_update(state.get("updateUrl") or UPDATE_URL, VERSION)
    if not info.get("available"):
        raise ValueError("新しいバージョンはありません")
    args = [a for a in sys.argv[1:] if a in ("--browser", "--no-open")]
    updater._set(phase="download", done=0, total=info.get("zipSize") or 0, version=info.get("latest"), error="")
    threading.Thread(target=updater.run, args=(info, Path(sys.executable).resolve(), args, request_quit),
                     daemon=True).start()
    return updater.status()


def r_config(b):
    if "updateUrl" in b:
        with lock:
            state["updateUrl"] = str(b["updateUrl"] or "").strip()
            save_json(STATE_FILE, state)
    return {"updateUrl": state.get("updateUrl", ""), "defaultUpdateUrl": UPDATE_URL, "version": VERSION}


STEAM_ROUTES = {
    "/api/deps": r_deps,
    "/api/backup/list": lambda b: {"items": backups.list(str(b["appid"]), str(b["id"]))},
    "/api/backup/summary": lambda _b: backups.summary(),
    "/api/backup/create": r_backup_create,
    "/api/backup/restore": r_backup_restore,
    "/api/backup/delete": lambda b: (backups.delete(str(b["appid"]), str(b["id"]), str(b["key"])), {"ok": True})[1],
    "/api/cleanup/delete": r_cleanup_delete,
    "/api/changelog": lambda b: {"entries": features.fetch_changelog(str(b["id"]))},
    "/api/notify": lambda b: (features.notify(str(b.get("title") or APP_NAME), str(b.get("text") or ""),
                                              sys.executable), {"ok": True})[1],
    "/api/steam/search": r_steam_search,
    "/api/tool/update": r_tool_update,
    "/api/tool/install": r_tool_install,
    "/api/tool/install/status": lambda _b: updater.status(),
    "/api/config": r_config,
    "/api/steam/connect": r_steam_connect,
    "/api/steam/status": r_steam_status,
    "/api/steam/action": r_steam_action,
    "/api/steam/disconnect": r_steam_disconnect,
    "/api/steam/state": lambda _b: steam.status(),
    "/api/launch": r_launch,
    "/api/running": r_running,
}


# --------------------------------------------------------------- main ----
def already_running() -> bool:
    if sys.platform != "win32":
        return False
    import ctypes

    k32 = ctypes.windll.kernel32
    k32.CreateMutexW(None, False, r"Local\WorkshopManager_SingleInstance")
    if k32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        ctypes.windll.user32.MessageBoxW(None, "Workshop Manager は既に起動しています。", APP_NAME, 0x40)
        return True
    return False


def main():
    if "--steam-worker" in sys.argv:
        i = sys.argv.index("--steam-worker")
        steam_bridge.worker_main(sys.argv[i + 1], sys.argv[i + 2])
        return
    browser_mode = "--browser" in sys.argv
    # 開発用のブラウザ表示は設定フォルダもポートも別なので、二重起動チェックをしない
    if not browser_mode and already_running():
        return
    if FROZEN:
        features.cleanup_old_exe(Path(sys.executable).resolve())
    srv = ThreadingHTTPServer((HOST, PORT or (8765 if browser_mode else 0)), Handler)
    url = f"http://{HOST}:{srv.server_address[1]}/"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"Workshop Manager: {url}")
    if browser_mode or not run_window(url):
        if "--no-open" not in sys.argv:
            webbrowser.open(url)
        try:
            while not quit_event.wait(1):
                pass
        except KeyboardInterrupt:
            pass
    steam.disconnect()
    srv.shutdown()


def message_box(text: str) -> None:
    if sys.platform == "win32":
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x30)


def run_window(url: str) -> bool:
    """専用ウィンドウ (WebView2) で開く。使えない環境では False を返し、ブラウザ表示に切り替える。"""
    global WINDOW
    try:
        import webview

        webview.settings["ALLOW_DOWNLOADS"] = True
        win = webview.create_window(f"{APP_NAME} v{VERSION}", url, width=1440, height=900, min_size=(1100, 680),
                                    background_color="#0f1218", text_select=True)
        WINDOW = win
        win.events.shown += lambda: win.restore()  # 最小化状態で起動することがあるため通常表示に戻す
        DATA.mkdir(parents=True, exist_ok=True)
        webview.start(gui="edgechromium", private_mode=False, storage_path=str(DATA / "webview"))
        return True
    except Exception as e:  # noqa: BLE001  WebView2 ランタイムが無い等
        message_box("専用ウィンドウを開けなかったため、ブラウザで表示します。\n"
                    "Microsoft Edge WebView2 ランタイムをインストールすると専用ウィンドウで使えます。\n\n"
                    f"詳細: {e}")
        return False


if __name__ == "__main__":
    main()
