"""hbr_app 服务端测试：只用临时数据目录，不读取正式档案。"""
import json
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import hbr_app  # noqa: E402
import wbkit  # noqa: E402  (hbr_app 已把 Shared 加入路径)


def archive(n=1):
    return {"schemaVersion": 2, "characters": {}, "styles": {f"s{n}": {"owned": True}}, "items": [], "loadouts": []}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = hbr_app.ArchiveStore(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_empty_read(self):
        self.assertEqual(self.store.read(), {"revision": 0, "archive": None, "saved": None})

    def test_write_increments_revision_and_backs_up(self):
        self.assertEqual(self.store.write(archive(1), 0)["revision"], 1)
        self.assertEqual(self.store.write(archive(2), 1)["revision"], 2)
        current = self.store.read()
        self.assertEqual(current["revision"], 2)
        self.assertIn("s2", current["archive"]["styles"])
        backups = list((self.root / "backups").glob("*.json"))
        self.assertEqual(len(backups), 1)
        self.assertIn("s1", json.loads(backups[0].read_text(encoding="utf-8"))["archive"]["styles"])

    def test_conflict_rejected_without_change(self):
        self.store.write(archive(1), 0)
        with self.assertRaises(wbkit.HttpError) as ctx:
            self.store.write(archive(9), 0)
        self.assertEqual(ctx.exception.status, 409)
        self.assertIn("s1", self.store.read()["archive"]["styles"])

    def test_schema_checked(self):
        with self.assertRaises(ValueError):
            self.store.write({"schemaVersion": 1}, 0)
        self.assertFalse((self.root / "archive.json").exists())

    def test_corrupt_file_not_overwritten(self):
        (self.root / "archive.json").write_text("[]", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.store.read()
        with self.assertRaises(ValueError):
            self.store.write(archive(1), 0)
        self.assertEqual((self.root / "archive.json").read_text(encoding="utf-8"), "[]")

    def test_snapshot_name_sanitized(self):
        name = self.store.snapshot(archive(1), "../../导入 前?")
        self.assertNotIn("/", name)
        self.assertNotIn("..", name)
        self.assertTrue((self.root / "snapshots" / name).is_file())
        kinds = {x["kind"] for x in self.store.list_backups()}
        self.assertEqual(kinds, {"snapshot"})

    def test_seed_refuses_existing(self):
        source = self.root / "export.json"
        source.write_text(json.dumps(archive(3)), encoding="utf-8")
        self.assertEqual(hbr_app.seed(source, self.root)["revision"], 1)
        with self.assertRaises(SystemExit):
            hbr_app.seed(source, self.root)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.app = hbr_app.build_app(Path(cls.tmp.name), port=0)
        cls.url = cls.app.start()

    @classmethod
    def tearDownClass(cls):
        cls.app.stop()
        cls.tmp.cleanup()

    def request(self, path, body=None, token=True):
        headers = {"X-WB-Token": self.app.token} if token else {}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers.update({"Content-Type": "application/json", "Origin": self.url.rstrip("/")})
        req = urllib.request.Request(self.url.rstrip("/") + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            with exc:
                return exc.code, exc.read().decode("utf-8")

    def test_index_has_token(self):
        status, text = self.request("/", token=False)
        self.assertEqual(status, 200)
        self.assertIn(self.app.token, text)
        self.assertNotIn("{{WB_TOKEN}}", text)

    def test_api_requires_token(self):
        self.assertEqual(self.request("/api/archive", token=False)[0], 403)
        self.assertEqual(self.request("/api/enemy-parameters", token=False)[0], 403)

    def test_local_enemy_parameters_empty_valid_and_invalid(self):
        from test_wave_parameters import synthetic_parameters
        path = Path(self.tmp.name) / "enemy-parameters.json"
        try:
            status, text = self.request("/api/enemy-parameters")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(text), {"ok": True, "version": 1, "source": None, "events": {}})
            value = synthetic_parameters(); value["source"]["path"] = "PRIVATE/PATH"
            path.write_text(json.dumps(value), encoding="utf-8")
            status, text = self.request("/api/enemy-parameters")
            self.assertEqual(status, 200); self.assertTrue(json.loads(text)["events"])
            self.assertNotIn("PRIVATE", text)
            path.write_text('{"version":1,"events":{"bad":{}}}', encoding="utf-8")
            status, text = self.request("/api/enemy-parameters")
            self.assertEqual(status, 422); self.assertFalse(json.loads(text)["ok"])
            self.assertNotIn("events", json.loads(text))
        finally:
            path.unlink(missing_ok=True)

    def test_roundtrip(self):
        status, text = self.request("/api/archive")
        self.assertEqual(status, 200)
        rev = json.loads(text)["revision"]
        status, text = self.request("/api/archive", {"archive": archive(5), "revision": rev})
        self.assertEqual(status, 200, text)
        self.assertEqual(json.loads(text)["revision"], rev + 1)
        status, _ = self.request("/api/archive", {"archive": archive(6), "revision": rev})
        self.assertEqual(status, 409)

    def test_shared_css_served(self):
        self.assertEqual(self.request("/_shared/fuuko.css", token=False)[0], 200)

    def test_shutdown_protocol_runtime_has_control_key(self):
        runtime = json.loads((Path(self.tmp.name) / "runtime.json").read_text(encoding="utf-8"))
        self.assertEqual(runtime["app"], "hbr")
        self.assertTrue(runtime.get("control"))


class ProtocolTests(unittest.TestCase):
    """风子工作台接入协议：内置 shared、说明文件格式 1、--data-dir 优先。"""

    def test_bundled_shared_is_used(self):
        self.assertEqual(Path(wbkit.__file__).resolve().parent, ROOT / "shared")

    def test_manifest_follows_protocol(self):
        manifest = json.loads((ROOT / "workbench.json").read_text(encoding="utf-8"))
        self.assertEqual((manifest["schema_version"], manifest["requires"]["host_api"], manifest["id"]), (1, 1, "hbr"))
        self.assertEqual(manifest["version"], hbr_app.VERSION)
        self.assertIn("{data_dir}", manifest["launch"]["command"])
        self.assertEqual(manifest["url"]["runtime"], "{data_dir}/runtime.json")
        self.assertEqual(manifest["stop"]["type"], "wbkit")

    def test_data_dir_priority(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(hbr_app.data_dir(Path(tmp)), Path(tmp).resolve())


if __name__ == "__main__":
    unittest.main()
