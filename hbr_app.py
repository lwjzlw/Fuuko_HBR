"""HBR 养成与排轴研究室：本机网页服务入口（风子工作台接入协议 1，内置 shared/wbkit.py）。

    pythonw hbr_app.py                       # 启动服务并打开窗口（已在运行则只打开窗口）
    python  hbr_app.py --serve               # 只启动服务（风子工作台标签页或调试用）
    python  hbr_app.py --serve --data-dir D  # 风子工作台按说明文件传入数据目录

个人档案存在数据目录的 archive.json。数据目录优先级：--data-dir > HBR_DATA_DIR > 原有的
同盘原有 AppData/HBRPlanner（仅维护目录）> %LOCALAPPDATA%/FuukoWorkbenches/hbr。
每次覆盖前把旧档案复制到 backups/（保留最近 BACKUP_KEEP 份）；导入/批量等重要操作另存 snapshots/。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import threading
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "shared"))
import wbkit  # noqa: E402

import hbr_cache  # noqa: E402
import hbr_enemy_parameters  # noqa: E402

APP_ID = "hbr"
APP_NAME = "HBR 研究室"
VERSION = "0.12.2"
PORT = 8787
BACKUP_KEEP = 40
SNAPSHOT_KEEP = 60
LEGACY_DATA_DIR = Path(HERE.anchor) / "AppData" / "HBRPlanner"
ICON = HERE / "public" / "hbr.ico"
_REASON = re.compile(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+")


def data_dir(explicit: Path | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    if os.environ.get("HBR_DATA_DIR"):
        return Path(os.environ["HBR_DATA_DIR"])
    # Maintenance installs retain their original archive. Clean source exports
    # deliberately do not discover an unrelated user's archive on the same drive.
    if not (HERE / "SOURCE-MANIFEST.json").is_file() and LEGACY_DATA_DIR.is_dir():
        return LEGACY_DATA_DIR
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share") / "FuukoWorkbenches" / APP_ID


def find_host() -> Path | None:
    """窗口程序不随本项目分发：依次找环境变量、同级风子框架、旧 Shared。"""
    candidates = [os.environ.get("FUUKO_HOST"), wbkit.HOST_EXE,
                  HERE.parent / "Fuuko" / "shared" / "host" / "bin" / "FuukoHost.exe",
                  HERE.parent / "Shared" / "host" / "bin" / "FuukoHost.exe"]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    return None


def _stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S-%f")


def _prune(folder: Path, keep: int) -> None:
    files = sorted(folder.glob("*.json"), key=lambda p: p.name)
    for old in files[:-keep]:
        old.unlink(missing_ok=True)


class ArchiveStore:
    """archive.json 的读写：带修订号，覆盖前留备份，写入原子化。"""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.file = self.root / "archive.json"
        self.backups = self.root / "backups"
        self.snapshots = self.root / "snapshots"
        self._lock = threading.RLock()

    def read(self) -> dict:
        with self._lock:
            if not self.file.is_file():
                return {"revision": 0, "archive": None, "saved": None}
            value = json.loads(self.file.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("archive"), dict):
            raise ValueError("archive.json 格式不对，已停止读取；请检查数据目录")
        return {"revision": int(value.get("revision") or 0), "archive": value["archive"], "saved": value.get("saved")}

    def write(self, archive: dict, base_revision: int, source: str = "ui") -> dict:
        if not isinstance(archive, dict) or archive.get("schemaVersion") != 2:
            raise ValueError("只接受 schemaVersion=2 的档案")
        with self._lock:
            current = self.read()
            if int(base_revision) != current["revision"]:
                raise wbkit.HttpError(409, f"档案已在别处更新（当前修订 {current['revision']}），请刷新后再改")
            if self.file.is_file():
                self.backups.mkdir(parents=True, exist_ok=True)
                shutil.copy2(self.file, self.backups / f"archive-r{current['revision']}-{_stamp()}.json")
                _prune(self.backups, BACKUP_KEEP)
            saved = datetime.now().isoformat(timespec="seconds")
            revision = current["revision"] + 1
            wbkit.write_json_atomic(self.file, {"revision": revision, "saved": saved, "source": source,
                                                "archive": archive})
            return {"revision": revision, "saved": saved}

    def snapshot(self, archive: dict, reason: str) -> str:
        if not isinstance(archive, dict):
            raise ValueError("快照须为档案对象")
        label = _REASON.sub("-", str(reason or "snapshot"))[:40].strip("-") or "snapshot"
        self.snapshots.mkdir(parents=True, exist_ok=True)
        target = self.snapshots / f"{_stamp()}-{label}.json"
        wbkit.write_json_atomic(target, archive)
        _prune(self.snapshots, SNAPSHOT_KEEP)
        return target.name

    def list_backups(self) -> list[dict]:
        items = []
        for folder, kind in ((self.backups, "auto"), (self.snapshots, "snapshot")):
            for path in folder.glob("*.json") if folder.is_dir() else []:
                stat = path.stat()
                items.append({"kind": kind, "name": path.name, "bytes": stat.st_size,
                              "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")})
        return sorted(items, key=lambda x: x["modified"], reverse=True)


def build_app(root: Path | None = None, port: int = PORT) -> wbkit.WorkbenchApp:
    root = Path(root or data_dir())
    store = ArchiveStore(root)
    app = wbkit.WorkbenchApp(APP_ID, APP_NAME, HERE / "public", root / "runtime.json", VERSION, port)
    app.store = store  # 测试用

    @app.get("/api/enemy-parameters")
    def get_enemy_parameters(_query):
        try:
            return {"ok": True, **hbr_enemy_parameters.read_parameters(root)}
        except (OSError, ValueError) as error:
            raise wbkit.HttpError(422, "本机敌参数未应用：" + (str(error) if isinstance(error, ValueError) else "文件无法读取")) from error

    @app.get("/api/archive")
    def get_archive(_query):
        return {"ok": True, **store.read(), "data_dir": str(root)}

    @app.post("/api/archive")
    def put_archive(body):
        result = store.write(body.get("archive"), int(body.get("revision", -1)), str(body.get("source") or "ui")[:40])
        return {"ok": True, **result}

    @app.post("/api/snapshot")
    def post_snapshot(body):
        return {"ok": True, "name": store.snapshot(body.get("archive"), body.get("reason", "snapshot"))}

    @app.get("/api/backups")
    def get_backups(_query):
        return {"ok": True, "items": store.list_backups()[:100], "data_dir": str(root)}

    catalog_cache: dict = {}

    def catalog() -> dict:
        return _cached("catalog")

    def _cached(name: str) -> dict:
        path = HERE / "public" / "data" / f"{name}.json"
        mtime = path.stat().st_mtime
        slot = catalog_cache.setdefault(name, {})
        if slot.get("mtime") != mtime:
            slot.update(mtime=mtime, value=json.loads(path.read_text(encoding="utf-8")))
        return slot["value"]

    @app.post("/api/cache-import/preview")
    def cache_preview(body):
        """只读游戏本机缓存，与页面传来的当前档案比较；不写档案。"""
        try:
            result = hbr_cache.preview_from_cache(catalog(), body.get("archive"), app.cache_dir, _cached("equipment"))
        except FileNotFoundError as error:
            raise wbkit.HttpError(404, str(error)) from error
        if result["missing_tables"]:
            raise wbkit.HttpError(422, "缓存里没找到卡面或角色表（游戏可能正在写入，或版本变了）："
                                  + "、".join(result["missing_tables"]))
        return {"ok": True, **result}

    @app.get("/api/cache-decks")
    def cache_decks(_query):
        """只读游戏本机缓存里的编队（成员、编队技能、饰品主词条、突破、泪）；不写档案。"""
        try:
            result = hbr_cache.decks_from_cache(catalog(), app.cache_dir)
        except FileNotFoundError as error:
            raise wbkit.HttpError(404, str(error)) from error
        if result["missing_tables"]:
            raise wbkit.HttpError(422, "缓存里没找到编队表：" + "、".join(result["missing_tables"]))
        return {"ok": True, **result}

    app.cache_dir = None  # 测试可指定；默认 %USERPROFILE%/AppData/LocalLow/wfs/HeavenBurnsRed/_bcdb0_

    @app.post("/api/open-data-dir")
    def open_data_dir(_body):
        root.mkdir(parents=True, exist_ok=True)
        os.startfile(root)  # noqa: S606 - 只打开本工作台的数据目录
        return {"ok": True}

    return app


def seed(path: Path, root: Path) -> dict:
    """把一份导出的档案 JSON 写成初始服务端档案（只在还没有档案时）。"""
    store = ArchiveStore(root)
    if store.read()["archive"] is not None:
        raise SystemExit("数据目录已有 archive.json，不覆盖；如需替换请在界面里导入")
    archive = json.loads(Path(path).read_text(encoding="utf-8"))
    store.snapshot(archive, "seed-source")
    return store.write(archive, 0, source=f"seed:{Path(path).name}")


def open_window(url: str, root: Path) -> None:
    host = find_host()
    if host:
        wbkit.HOST_EXE = host  # open_app_window 读取模块里的 HOST_EXE；找不到时它退回默认浏览器
    wbkit.open_app_window(url, root / "window", app_id=APP_ID, title=APP_NAME,
                          icon=ICON if ICON.is_file() else None, width=1360, height=900)


def main() -> int:
    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument("--serve", action="store_true", help="只启动服务，不开窗口")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--data-dir", type=Path, help="数据目录（风子工作台按说明文件传入）")
    parser.add_argument("--seed", type=Path, help="用一份导出档案初始化服务端档案（已有档案时拒绝）")
    args = parser.parse_args()
    root = data_dir(args.data_dir)
    if args.seed:
        print(json.dumps(seed(args.seed, root), ensure_ascii=False))
        return 0
    running = wbkit.read_runtime(root / "runtime.json")
    if running:
        if not args.serve:
            open_window(running["url"], root)
        return 0
    app = build_app(root, args.port)
    url = app.start()
    if not args.serve:
        open_window(url, root)
    print(json.dumps({"app": APP_ID, "url": url}), flush=True)
    try:
        app.wait(idle_minutes=10)  # 页面每分钟心跳；关窗 10 分钟后退出
    except KeyboardInterrupt:
        pass
    finally:
        app.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
