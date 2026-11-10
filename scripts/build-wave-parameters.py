"""Normalize four explicitly supplied installed-game static tables for local use.

No game installation discovery, account access, inheritance guesses, or public/data writes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hbr_enemy_parameters import KIND, TABLES, load_json_unique, validate_parameters  # noqa: E402


def rows(value, name):
    items = value.get("items") if isinstance(value, dict) else value
    if not isinstance(items, list) or any(not isinstance(row, dict) for row in items):
        raise ValueError(f"{name}: 需要记录数组或 {{items: [...]}}")
    return items


def by_label(items, name):
    result = {}
    for row in items:
        label = row.get("label")
        if not isinstance(label, str) or not label or label in result:
            raise ValueError(f"{name}: 缺少或重复标签")
        result[label] = row
    return result


def valid_number(value, positive=False):
    return type(value) in (int, float) and (value > 0 if positive else value >= 0) and value <= 10**15 and math.isfinite(value)


def normalize(tables: dict, hashes: dict) -> tuple[dict, dict]:
    indexed = {name: by_label(rows(tables[name], name), name) for name in TABLES}
    stage_groups, phase_groups = defaultdict(list), defaultdict(list)
    for stage in indexed["MasterWaveBattleStage"].values():
        stage_groups[stage.get("groupLabel")].append(stage)
    for phase in indexed["MasterWaveBattlePhase"].values():
        phase_groups[phase.get("groupLabel")].append(phase)
    output = {"version": 1, "source": {"kind": KIND, "sha256": hashes}, "events": {}}
    report = {"acceptedDifficulties": 0, "acceptedPhases": 0, "skipped": []}

    def skip(event, difficulty, reason):
        report["skipped"].append({"event": event, "difficulty": difficulty, "reason": reason})

    for event_label, event in sorted(indexed["MasterWaveBattle"].items()):
        levels = defaultdict(list)
        stages = stage_groups.get(event.get("waveBattleStageGroupLabel"), [])
        if not stages:
            skip(event_label, None, "missing-stage-group")
        for stage in stages:
            difficulty = stage.get("difficulty")
            if type(difficulty) is not int or not 1 <= difficulty <= 10000:
                skip(event_label, None, "invalid-difficulty")
                continue
            levels[difficulty].append(stage)
        accepted = {}
        for difficulty, matching in sorted(levels.items()):
            if len(matching) != 1:
                skip(event_label, difficulty, "duplicate-difficulty")
                continue
            stage = matching[0]
            phases = phase_groups.get(stage.get("waveBattlePhaseGroupLabel"), [])
            indices = [p.get("phaseIndex") for p in phases]
            if not phases or any(type(i) is not int for i in indices) or sorted(indices) != list(range(1, len(phases) + 1)):
                skip(event_label, difficulty, "missing-or-duplicate-phase-index")
                continue
            normalized, reason = [], None
            for phase in sorted(phases, key=lambda p: p["phaseIndex"]):
                battle_label = phase.get("battleLabel")
                battle = indexed["MasterBattle"].get(battle_label)
                labels = battle.get("masterEnemyLabelList") if battle else None
                if not isinstance(labels, list) or not labels or any(label is not None and not isinstance(label, str) for label in labels):
                    reason = "missing-battle-or-enemy-slots"
                    break
                values = [phase.get(k) for k in ("dpList", "hpList", "refParamBorderList")]
                if any(not isinstance(v, list) for v in values):
                    reason = "incomplete-slot-parameters"
                    break
                enemies = []
                for slot, label in enumerate(labels):
                    if not label:
                        continue
                    if any(slot >= len(v) for v in values):
                        reason = "incomplete-slot-parameters"
                        break
                    dp, hp, border = [v[slot] for v in values]
                    if not valid_number(dp) or not valid_number(hp, True) or not valid_number(border, True):
                        reason = "uncalibrated-enemy-parameters"
                        break
                    enemies.append({"label": label, "slot": slot, "dp": dp, "hp": hp, "paramBorder": border})
                if reason or not enemies:
                    reason = reason or "empty-enemy-slots"
                    break
                normalized.append({"label": battle_label, "battleLabel": battle_label, "phase": phase["phaseIndex"], "difficulty": difficulty,
                                   "enemies": enemies, "parameterSource": {"kind": KIND, "stageLabel": stage["label"], "phaseLabel": phase["label"], "battleLabel": battle_label}})
            if reason:
                skip(event_label, difficulty, reason)
                continue
            accepted[str(difficulty)] = normalized
            report["acceptedDifficulties"] += 1
            report["acceptedPhases"] += len(normalized)
        if accepted:
            output["events"][event_label] = {"difficultyStages": accepted}
    return validate_parameters(output), report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tables-dir", type=Path, required=True, help="Directory containing the four decoded static JSON tables")
    parser.add_argument("--out", type=Path, required=True, help="Local enemy-parameters.json destination, outside public/")
    parser.add_argument("--report", type=Path, help="Separate skipped-difficulty report")
    parser.add_argument("--overwrite", action="store_true", help="Explicitly permit replacing existing output/report files")
    args = parser.parse_args(argv)
    inputs = {(args.tables_dir / f"{name}.json").resolve() for name in TABLES}
    for destination in (args.out, args.report):
        if destination is not None and destination.resolve() in inputs:
            parser.error("Output must not overwrite a source table")
        if destination is not None and destination.resolve().is_relative_to((ROOT / "public").resolve()):
            parser.error("Installed-game static parameters must not be written under public/")
        if destination is not None and destination.exists() and (not args.overwrite or not destination.is_file()):
            parser.error("Output/report already exists; use --overwrite to replace a file")
    if args.report and args.out.resolve() == args.report.resolve():
        parser.error("--out and --report must be different files")
    tables, hashes = {}, {}
    for name in TABLES:
        raw = (args.tables_dir / f"{name}.json").read_bytes()
        hashes[name] = hashlib.sha256(raw).hexdigest()
        tables[name] = load_json_unique(raw)
    output, report = normalize(tables, hashes)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
