"""Steamクライアント連携 (Steamworks ISteamUGC / flat API を ctypes で呼ぶ).

SteamAPI はプロセスごとに 1 つの AppID でしか初期化できないため、
ゲームごとにワーカープロセス (`--steam-worker <appid> <dll>`) を起動し、
標準入出力の JSON 行で命令をやり取りする。
"""
from __future__ import annotations

import ctypes as C
import json
import os
import queue
import re
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# EItemState
ST_SUBSCRIBED, ST_LEGACY, ST_INSTALLED, ST_NEEDS_UPDATE = 1, 2, 4, 8
ST_DOWNLOADING, ST_DOWNLOAD_PENDING, ST_DISABLED_LOCALLY = 16, 32, 64

INIT_ERRORS = {1: "Steam初期化に失敗しました", 2: "Steamクライアントが起動していません",
               3: "Steamクライアントのバージョンが古いです"}


# ------------------------------------------------------------ DLL 探索 ----
def pe_exports(path: Path) -> set[str]:
    d = path.read_bytes()
    pe = struct.unpack_from("<I", d, 0x3C)[0]
    nsec = struct.unpack_from("<H", d, pe + 6)[0]
    opt = pe + 24
    dd = opt + (112 if struct.unpack_from("<H", d, opt)[0] == 0x20B else 96)
    exp_rva = struct.unpack_from("<I", d, dd)[0]
    sec = opt + struct.unpack_from("<H", d, pe + 20)[0]
    secs = [struct.unpack_from("<8sIIII", d, sec + 40 * i) for i in range(nsec)]

    def off(rva):
        for _, vsz, va, rsz, ro in secs:
            if va <= rva < va + max(vsz, rsz):
                return rva - va + ro
        raise ValueError("bad rva")

    e = off(exp_rva)
    n = struct.unpack_from("<I", d, e + 24)[0]
    names = off(struct.unpack_from("<I", d, e + 32)[0])
    out = set()
    for i in range(n):
        s = off(struct.unpack_from("<I", d, names + 4 * i)[0])
        out.add(d[s:d.index(b"\0", s)].decode("ascii", "replace"))
    return out


def ugc_version(exports: set[str]) -> int:
    vs = [int(m.group(1)) for x in exports if (m := re.fullmatch(r"SteamAPI_SteamUGC_v(\d+)", x))]
    return max(vs, default=0)


def valve_signed(path: Path) -> bool:
    if sys.platform != "win32":
        return True
    ps = ("$s=Get-AuthenticodeSignature -LiteralPath $env:WSM_DLL;"
          "if($s.Status -eq 'Valid'){$s.SignerCertificate.Subject}")
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                           capture_output=True, text=True, timeout=30, creationflags=NO_WINDOW,
                           env={**os.environ, "WSM_DLL": str(path)})
        return "Valve" in r.stdout
    except (OSError, subprocess.SubprocessError):
        return False


def dll_candidates(app_dir: Path, libraries: list[Path]):
    yield app_dir / "steam_api64.dll"
    for lib in libraries:
        common = lib / "steamapps" / "common"
        if not common.is_dir():
            continue
        for root, dirs, files in os.walk(common):
            depth = len(Path(root).relative_to(common).parts)
            if depth >= 5:
                dirs[:] = []
            if "steam_api64.dll" in files:
                yield Path(root) / "steam_api64.dll"


def find_dll(app_dir: Path, libraries: list[Path], cached: str | None = None) -> dict:
    """使える steam_api64.dll を探す。最新の UGC インターフェースを持つ Valve 署名済みのもの。"""
    if cached and Path(cached).is_file():
        try:
            ex = pe_exports(Path(cached))
            if ugc_version(ex) and "SteamAPI_InitFlat" in ex:
                return {"path": cached, "ugc": ugc_version(ex)}
        except (OSError, ValueError, struct.error):
            pass
    best = None
    for p in dll_candidates(app_dir, libraries):
        if not p.is_file():
            continue
        try:
            ex = pe_exports(p)
        except (OSError, ValueError, struct.error):
            continue
        v = ugc_version(ex)
        if v and "SteamAPI_InitFlat" in ex and (best is None or v > best[1]):
            best = (p, v)
    if best and valve_signed(best[0]):
        return {"path": str(best[0]), "ugc": best[1]}
    if best:
        raise RuntimeError(f"steam_api64.dll の署名を確認できません: {best[0]}")
    raise RuntimeError("steam_api64.dll が見つかりません。アプリと同じフォルダに置いてください。")


# ---------------------------------------------------------- ワーカー側 ----
class UGC:
    def __init__(self, dll_path: str, appid: str):
        os.environ["SteamAppId"] = str(appid)
        os.environ["SteamGameId"] = str(appid)
        self.exports = pe_exports(Path(dll_path))
        self.dll = C.CDLL(dll_path)
        d = self.dll
        u64, u32, vp, b = C.c_uint64, C.c_uint32, C.c_void_p, C.c_bool
        err = C.create_string_buffer(1024)
        d.SteamAPI_InitFlat.restype = C.c_int
        d.SteamAPI_InitFlat.argtypes = [C.c_char_p]
        res = d.SteamAPI_InitFlat(err)
        if res != 0:
            msg = err.value.decode("utf-8", "replace") or INIT_ERRORS.get(res, f"code {res}")
            raise RuntimeError(f"Steam連携を開始できません: {msg}")
        acc = getattr(d, f"SteamAPI_SteamUGC_v{ugc_version(self.exports):03d}")
        acc.restype = vp
        self.ugc = acc()
        if not self.ugc:
            raise RuntimeError("ISteamUGC を取得できません")

        def fn(name, res, *args):
            f = getattr(d, "SteamAPI_ISteamUGC_" + name, None)
            if f is not None:
                f.restype, f.argtypes = res, [vp, *args]
            return f

        self.f_num = fn("GetNumSubscribedItems", u32, b)
        self.f_list = fn("GetSubscribedItems", u32, C.POINTER(u64), u32, b)
        self.f_state = fn("GetItemState", u32, u64)
        self.f_install = fn("GetItemInstallInfo", b, u64, C.POINTER(u64), C.c_char_p, u32, C.POINTER(u32))
        self.f_dlinfo = fn("GetItemDownloadInfo", b, u64, C.POINTER(u64), C.POINTER(u64))
        self.f_download = fn("DownloadItem", b, u64, b)
        self.f_sub = fn("SubscribeItem", u64, u64)
        self.f_unsub = fn("UnsubscribeItem", u64, u64)
        self.f_disable = fn("SetItemsDisabledLocally", b, C.POINTER(u64), u32, b)
        self.f_order = fn("SetSubscriptionsLoadOrder", b, C.POINTER(u64), u32)
        # ワークショップ検索（UGC クエリ）
        self.f_query = fn("CreateQueryAllUGCRequestPage", u64, C.c_int, C.c_int, u32, u32, u32)
        self.f_search_text = fn("SetSearchText", b, u64, C.c_char_p)
        self.f_trend_days = fn("SetRankedByTrendDays", b, u64, u32)
        self.f_only_ids = fn("SetReturnOnlyIDs", b, u64, b)
        self.f_send = fn("SendQueryUGCRequest", u64, u64)
        self.f_result = fn("GetQueryUGCResult", b, u64, u32, C.c_void_p)
        self.f_release = fn("ReleaseQueryUGCRequest", b, u64)
        self.appid = int(appid)
        self.utils = None
        uv = [int(m.group(1)) for x in self.exports if (m := re.fullmatch(r"SteamAPI_SteamUtils_v(\d+)", x))]
        if uv:
            ua = getattr(d, f"SteamAPI_SteamUtils_v{max(uv):03d}")
            ua.restype = vp
            self.utils = ua()
            self.f_done = d.SteamAPI_ISteamUtils_IsAPICallCompleted
            self.f_done.restype, self.f_done.argtypes = b, [vp, u64, C.POINTER(b)]
            self.f_callres = d.SteamAPI_ISteamUtils_GetAPICallResult
            self.f_callres.restype, self.f_callres.argtypes = b, [vp, u64, C.c_void_p, C.c_int, C.c_int, C.POINTER(b)]
        d.SteamAPI_RunCallbacks.restype = None
        self.persona = ""
        fv = [int(m.group(1)) for x in self.exports if (m := re.fullmatch(r"SteamAPI_SteamFriends_v(\d+)", x))]
        if fv:
            fa = getattr(d, f"SteamAPI_SteamFriends_v{max(fv):03d}")
            fa.restype = vp
            pn = d.SteamAPI_ISteamFriends_GetPersonaName
            pn.restype, pn.argtypes = C.c_char_p, [vp]
            fr = fa()
            if fr:
                self.persona = (pn(fr) or b"").decode("utf-8", "replace")

    @staticmethod
    def arr(ids):
        a = (C.c_uint64 * len(ids))(*[int(i) for i in ids])
        return a, len(ids)

    def subscribed(self) -> list[str]:
        n = self.f_num(self.ugc, True)
        buf = (C.c_uint64 * max(n, 1))()
        got = self.f_list(self.ugc, buf, n, True)
        return [str(buf[i]) for i in range(got)]

    def item(self, iid) -> dict:
        i = int(iid)
        st = self.f_state(self.ugc, i)
        out = {"id": str(iid), "state": st, "subscribed": bool(st & ST_SUBSCRIBED),
               "installed": bool(st & ST_INSTALLED), "needsUpdate": bool(st & ST_NEEDS_UPDATE),
               "downloading": bool(st & (ST_DOWNLOADING | ST_DOWNLOAD_PENDING)),
               "disabledLocally": bool(st & ST_DISABLED_LOCALLY)}
        if st & ST_INSTALLED:
            size, ts = C.c_uint64(), C.c_uint32()
            folder = C.create_string_buffer(1024)
            if self.f_install(self.ugc, i, C.byref(size), folder, 1024, C.byref(ts)):
                out.update(size=size.value, folder=folder.value.decode("utf-8", "replace"), timestamp=ts.value)
        if out["downloading"]:
            done, total = C.c_uint64(), C.c_uint64()
            if self.f_dlinfo(self.ugc, i, C.byref(done), C.byref(total)) and total.value:
                out["progress"] = done.value / total.value
        return out

    QUERY_TYPES = {"trend": 3, "subs": 12, "new": 1, "updated": 19, "vote": 0}
    QUERY_COMPLETED = 3401  # SteamUGCQueryCompleted_t の callback ID

    def search(self, text: str, sort: str, page: int) -> dict:
        """ワークショップをキーワード/並び順で検索し、ID の一覧を返す（詳細は Web API で取る）"""
        if not (self.utils and self.f_query and self.f_send and self.f_result):
            raise RuntimeError("このSteam APIでは検索に未対応です")
        qtype = 11 if text else self.QUERY_TYPES.get(sort, 3)  # 11 = テキスト検索順
        h = self.f_query(self.ugc, qtype, 0, self.appid, self.appid, max(1, int(page)))
        if h in (0, 0xFFFFFFFFFFFFFFFF):
            raise RuntimeError("検索を開始できませんでした")
        try:
            if text:
                self.f_search_text(self.ugc, h, text.encode("utf-8"))
            if qtype == 3 and self.f_trend_days:
                self.f_trend_days(self.ugc, h, 7)
            if self.f_only_ids:
                self.f_only_ids(self.ugc, h, True)
            call = self.f_send(self.ugc, h)
            failed = C.c_bool()
            deadline = time.time() + 20
            while not self.f_done(self.utils, call, C.byref(failed)):
                if time.time() > deadline:
                    raise RuntimeError("検索がタイムアウトしました")
                self.dll.SteamAPI_RunCallbacks()
                time.sleep(0.05)
            # SteamUGCQueryCompleted_t: handle(u64) eResult(i32) returned(u32) total(u32) cached(bool) cursor[256]
            buf = C.create_string_buffer(512)
            for size in (280, 288, 277):
                if self.f_callres(self.utils, call, buf, size, self.QUERY_COMPLETED, C.byref(failed)):
                    break
            else:
                raise RuntimeError("検索結果を取得できませんでした")
            _h, result, returned, total = struct.unpack_from("<QiII", buf.raw, 0)
            if result != 1:
                raise RuntimeError(f"検索に失敗しました（EResult {result}）")
            ids = []
            details = C.create_string_buffer(16384)  # SteamUGCDetails_t（先頭が PublishedFileId）
            for i in range(returned):
                if self.f_result(self.ugc, h, i, details):
                    ids.append(str(struct.unpack_from("<Q", details.raw, 0)[0]))
            return {"ids": ids, "total": total, "page": page}
        finally:
            if self.f_release:
                self.f_release(self.ugc, h)

    def run(self, cmd: str, a: dict):
        ids = [str(x) for x in a.get("ids", [])]
        if cmd == "search":
            return self.search(str(a.get("text") or "").strip(), str(a.get("sort") or "trend"), int(a.get("page") or 1))
        if cmd == "info":
            subs = self.subscribed()
            return {"persona": self.persona, "subscribed": subs,
                    "items": [self.item(i) for i in sorted(set(subs) | set(ids))],
                    "supports": {"disable": bool(self.f_disable), "loadOrder": bool(self.f_order)}}
        if cmd == "status":
            return {"items": [self.item(i) for i in ids]}
        if cmd == "subscribe":
            return {"calls": [str(self.f_sub(self.ugc, int(i))) for i in ids]}
        if cmd == "unsubscribe":
            return {"calls": [str(self.f_unsub(self.ugc, int(i))) for i in ids]}
        if cmd == "download":
            return {"ok": [bool(self.f_download(self.ugc, int(i), True)) for i in ids]}
        if cmd == "set_disabled":
            if not self.f_disable:
                raise RuntimeError("このSteam APIでは未対応です")
            arr, n = self.arr(ids)
            return {"ok": bool(n == 0 or self.f_disable(self.ugc, arr, n, bool(a.get("disabled"))))}
        if cmd == "set_load_order":
            if not self.f_order:
                raise RuntimeError("このSteam APIでは未対応です")
            arr, n = self.arr(ids)
            return {"ok": bool(self.f_order(self.ugc, arr, n))}
        raise RuntimeError(f"unknown command {cmd}")

    def shutdown(self):
        try:
            self.dll.SteamAPI_Shutdown()
        except OSError:
            pass


def worker_main(appid: str, dll: str) -> None:
    # steam_api64.dll 自体が fd 1 にログを書くため、プロトコル用に元の stdout を複製し
    # fd 1 は stderr（親側で破棄）へ付け替える
    sys.stdout.flush()
    out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def send(obj):
        out.write(json.dumps(obj, ensure_ascii=False) + "\n")
        out.flush()

    try:
        ugc = UGC(dll, appid)
    except Exception as e:  # noqa: BLE001
        send({"ready": False, "error": str(e)})
        return
    send({"ready": True, "persona": ugc.persona})
    q: queue.Queue = queue.Queue()

    def reader():
        for line in sys.stdin:
            q.put(line)
        q.put(None)

    threading.Thread(target=reader, daemon=True).start()
    try:
        while True:
            ugc.dll.SteamAPI_RunCallbacks()
            try:
                line = q.get(timeout=0.1)
            except queue.Empty:
                continue
            if line is None:
                break
            msg: dict = {}
            try:
                msg = json.loads(line)
                send({"id": msg.get("id"), "ok": True, "result": ugc.run(msg.get("cmd"), msg.get("args") or {})})
            except Exception as e:  # noqa: BLE001
                send({"id": msg.get("id"), "ok": False, "error": str(e)})
    finally:
        ugc.shutdown()


# ------------------------------------------------------------ 親プロセス側 ----
class Worker:
    def __init__(self, appid: str, dll: str, argv: list[str]):
        self.appid = appid
        self.proc = subprocess.Popen(argv + ["--steam-worker", appid, dll], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                     encoding="utf-8", creationflags=NO_WINDOW, bufsize=1)
        self.seq = 0
        self.lock = threading.Lock()
        line = self._readline(timeout=40)
        hello = json.loads(line) if line else {"ready": False, "error": "Steamワーカーが応答しません"}
        if not hello.get("ready"):
            self.close()
            raise RuntimeError(hello.get("error"))
        self.persona = hello.get("persona", "")

    def _readline(self, timeout: float):
        """JSON の行だけを返す（DLL のログなど他の出力は読み飛ばす）"""
        box: list = []

        def read():
            while True:
                line = self.proc.stdout.readline()
                if not line or line.lstrip().startswith("{"):
                    box.append(line)
                    return

        t = threading.Thread(target=read, daemon=True)
        t.start()
        t.join(timeout)
        return box[0] if box else None

    def alive(self) -> bool:
        return self.proc.poll() is None

    def call(self, cmd: str, timeout: float = 30, **args):
        with self.lock:
            self.seq += 1
            self.proc.stdin.write(json.dumps({"id": self.seq, "cmd": cmd, "args": args}) + "\n")
            self.proc.stdin.flush()
            line = self._readline(timeout)
        if not line:
            self.close()
            raise RuntimeError("Steamワーカーとの通信が切れました")
        r = json.loads(line)
        if not r.get("ok"):
            raise RuntimeError(r.get("error"))
        return r["result"]

    def close(self):
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()


class SteamManager:
    """現在のゲーム用ワーカーを 1 つだけ保持し、一定時間使われなければ切断する。"""

    # 接続中は Steam 上で「実行中/プレイ中」になるため、操作が終わったらすぐ切断する
    IDLE = 15

    def __init__(self, argv: list[str], dll_finder):
        self.argv = argv
        self.dll_finder = dll_finder
        self.dll: str | None = None
        self.worker: Worker | None = None
        self.last = 0.0
        self.busy_until = 0.0
        self.lock = threading.RLock()
        threading.Thread(target=self._idle_loop, daemon=True).start()

    def _idle_loop(self):
        while True:
            time.sleep(5)
            with self.lock:
                now = time.time()
                if self.worker and now - self.last > self.IDLE and now > self.busy_until:
                    self.disconnect()

    def get(self, appid: str) -> Worker:
        with self.lock:
            self.last = time.time()
            if self.worker and self.worker.appid == appid and self.worker.alive():
                return self.worker
            self.disconnect()
            if not self.dll:
                self.dll = self.dll_finder()
            self.worker = Worker(appid, self.dll, self.argv)
            return self.worker

    def call(self, appid: str, cmd: str, **args):
        w = self.get(appid)
        res = w.call(cmd, **args)
        self.last = time.time()
        if cmd in ("subscribe", "download") or any(i.get("downloading") for i in res.get("items", []) if isinstance(i, dict)):
            self.busy_until = time.time() + 30
        return res

    def status(self) -> dict:
        w = self.worker
        return {"connected": bool(w and w.alive()), "appid": w.appid if w else None,
                "persona": w.persona if w else "", "dll": self.dll}

    def disconnect(self):
        with self.lock:
            if self.worker:
                self.worker.close()
                self.worker = None
