"""Synthetic static-table joins and local parameter validation; no account data."""
import contextlib
import copy
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import hbr_enemy_parameters as parameters  # noqa: E402

spec = importlib.util.spec_from_file_location("build_wave_parameters", ROOT / "scripts" / "build-wave-parameters.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def synthetic_tables():
    return {
        "MasterWaveBattle": {"items": [{"label": "WaveSynthetic", "waveBattleStageGroupLabel": "StageGroup"}]},
        "MasterWaveBattleStage": {"items": [{"label": "Stage40", "groupLabel": "StageGroup", "difficulty": 40, "waveBattlePhaseGroupLabel": "PhaseGroup"}]},
        "MasterWaveBattlePhase": {"items": [
            {"label": "Phase2", "groupLabel": "PhaseGroup", "phaseIndex": 2, "battleLabel": "Battle2", "dpList": [50, 0, 0], "hpList": [500, 0, 0], "refParamBorderList": [300, 0, 0]},
            {"label": "Phase1", "groupLabel": "PhaseGroup", "phaseIndex": 1, "battleLabel": "Battle1", "dpList": [0, 0, 200], "hpList": [0, 1000, 2000], "refParamBorderList": [0, 400, 500]},
        ]},
        "MasterBattle": {"items": [{"label": "Battle1", "masterEnemyLabelList": ["", "EnemyA", "EnemyB"]}, {"label": "Battle2", "masterEnemyLabelList": ["EnemyC"]}]},
    }


def synthetic_parameters():
    return builder.normalize(synthetic_tables(), {name: "a" * 64 for name in parameters.TABLES})[0]


class NormalizeTests(unittest.TestCase):
    def test_preserves_empty_slots_and_orders_phases_with_trailing_padding(self):
        result, report = builder.normalize(synthetic_tables(), {name: "a" * 64 for name in parameters.TABLES})
        phases = result["events"]["WaveSynthetic"]["difficultyStages"]["40"]
        self.assertEqual([p["label"] for p in phases], ["Battle1", "Battle2"])
        self.assertEqual(phases[0]["enemies"], [
            {"label": "EnemyA", "slot": 1, "dp": 0, "hp": 1000, "paramBorder": 400},
            {"label": "EnemyB", "slot": 2, "dp": 200, "hp": 2000, "paramBorder": 500},
        ])
        self.assertEqual(phases[1]["enemies"][0]["slot"], 0)
        self.assertEqual(phases[0]["parameterSource"]["phaseLabel"], "Phase1")
        self.assertEqual(report, {"acceptedDifficulties": 1, "acceptedPhases": 2, "skipped": []})

    def test_uncalibrated_or_incomplete_phase_rejects_entire_difficulty(self):
        for field, value in [("hpList", [0, 0, 0]), ("refParamBorderList", [0, 400, 0]),
                             ("dpList", [0, -1, 200]), ("hpList", [0, 1000]), ("hpList", [0, True, 2000])]:
            with self.subTest(field=field, value=value):
                tables = synthetic_tables()
                tables["MasterWaveBattlePhase"]["items"][1][field] = value
                result, report = builder.normalize(tables, {name: "a" * 64 for name in parameters.TABLES})
                self.assertEqual(result["events"], {})
                self.assertEqual(report["acceptedPhases"], 0)
                self.assertEqual(len(report["skipped"]), 1)

    def test_trailing_empty_enemy_slots_need_no_invented_parameters(self):
        tables = synthetic_tables()
        tables["MasterBattle"]["items"][1]["masterEnemyLabelList"] = ["EnemyC", "", ""]
        for field in ("dpList", "hpList", "refParamBorderList"):
            tables["MasterWaveBattlePhase"]["items"][0][field] = tables["MasterWaveBattlePhase"]["items"][0][field][:1]
        result, report = builder.normalize(tables, {name: "a" * 64 for name in parameters.TABLES})
        self.assertEqual(report["skipped"], [])
        self.assertEqual(len(result["events"]["WaveSynthetic"]["difficultyStages"]["40"][1]["enemies"]), 1)

    def test_duplicate_difficulty_and_missing_phase_indices_are_reported(self):
        tables = synthetic_tables()
        duplicate = copy.deepcopy(tables["MasterWaveBattleStage"]["items"][0]); duplicate["label"] = "OtherStage40"
        tables["MasterWaveBattleStage"]["items"].append(duplicate)
        result, report = builder.normalize(tables, {name: "a" * 64 for name in parameters.TABLES})
        self.assertEqual(result["events"], {}); self.assertEqual(report["skipped"][0]["reason"], "duplicate-difficulty")
        tables = synthetic_tables(); tables["MasterWaveBattlePhase"]["items"][0]["phaseIndex"] = 3
        result, report = builder.normalize(tables, {name: "a" * 64 for name in parameters.TABLES})
        self.assertEqual(result["events"], {}); self.assertEqual(report["skipped"][0]["reason"], "missing-or-duplicate-phase-index")

    def test_cli_uses_explicit_tables_and_cannot_overwrite_source_or_public_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, data in synthetic_tables().items():
                (root / f"{name}.json").write_text(json.dumps(data), encoding="utf-8")
            before = {name: (root / f"{name}.json").read_bytes() for name in parameters.TABLES}
            destination, report = root / "output.json", root / "report.json"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(builder.main(["--tables-dir", str(root), "--out", str(destination), "--report", str(report)]), 0)
            value = parameters.validate_parameters(json.loads(destination.read_text(encoding="utf-8")))
            self.assertTrue(value["events"]); self.assertNotIn(str(root), destination.read_text(encoding="utf-8"))
            original_output = destination.read_bytes()
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                builder.main(["--tables-dir", str(root), "--out", str(destination)])
            new_output = root / "another-output.json"
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                builder.main(["--tables-dir", str(root), "--out", str(new_output), "--report", str(report)])
            self.assertFalse(new_output.exists()); self.assertEqual(destination.read_bytes(), original_output)
            with contextlib.redirect_stdout(io.StringIO()):
                builder.main(["--tables-dir", str(root), "--out", str(destination), "--report", str(report), "--overwrite"])
            self.assertEqual(destination.read_bytes(), original_output)
            for invalid in [ROOT / "public" / "blocked-parameters.json", root / "MasterBattle.json"]:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    builder.main(["--tables-dir", str(root), "--out", str(invalid)])
            self.assertEqual(before, {name: (root / f"{name}.json").read_bytes() for name in parameters.TABLES})

    def test_cli_rejects_duplicate_keys_in_source_json_before_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, data in synthetic_tables().items():
                (root / f"{name}.json").write_text(json.dumps(data), encoding="utf-8")
            (root / "MasterWaveBattle.json").write_text('{"items":[],"items":[]}', encoding="utf-8")
            destination = root / "output.json"
            with self.assertRaisesRegex(ValueError, "重复字段"):
                builder.main(["--tables-dir", str(root), "--out", str(destination)])
            self.assertFalse(destination.exists())


class ValidationTests(unittest.TestCase):
    def test_allowlist_strips_paths_and_unrelated_fields(self):
        value = synthetic_parameters(); value["source"]["path"] = "PRIVATE/PATH"
        value["archive"] = {"player": "not-static"}
        stage = value["events"]["WaveSynthetic"]["difficultyStages"]["40"][0]
        stage["parameterSource"]["path"] = "PRIVATE/PATH"; stage["enemies"][0]["account"] = "not-static"
        encoded = json.dumps(parameters.validate_parameters(value))
        self.assertNotIn("PRIVATE", encoded); self.assertNotIn("not-static", encoded)

    def test_bad_versions_numbers_order_and_provenance_are_rejected(self):
        for key, invalid in [("hp", 0), ("hp", True), ("hp", float("nan")), ("hp", float("inf")),
                             ("hp", 10**400), ("dp", -1), ("paramBorder", 0), ("slot", -1)]:
            with self.subTest(key=key, invalid=invalid):
                value = synthetic_parameters()
                value["events"]["WaveSynthetic"]["difficultyStages"]["40"][0]["enemies"][0][key] = invalid
                with self.assertRaises(ValueError): parameters.validate_parameters(value)
        for key, invalid in [("version", True), ("source", {"kind": "unknown"})]:
            value = synthetic_parameters(); value[key] = invalid
            with self.assertRaises(ValueError): parameters.validate_parameters(value)
        value = synthetic_parameters(); value["events"]["WaveSynthetic"]["difficultyStages"]["40"].reverse()
        with self.assertRaises(ValueError): parameters.validate_parameters(value)

    def test_missing_file_is_empty_but_corrupt_or_oversize_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.assertEqual(parameters.read_parameters(root), {"version": 1, "source": None, "events": {}})
            path = root / "enemy-parameters.json"; path.write_text("not-json", encoding="utf-8")
            with self.assertRaises(ValueError): parameters.read_parameters(root)
            path.write_text('{"version":1,"source":null,"events":{},"events":{}}', encoding="utf-8")
            with self.assertRaises(ValueError): parameters.read_parameters(root)
            path.write_bytes(b" " * (parameters.MAX_BYTES + 1))
            with self.assertRaises(ValueError): parameters.read_parameters(root)


if __name__ == "__main__":
    unittest.main()
