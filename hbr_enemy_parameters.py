"""Validate local static enemy parameters without publishing source tables or paths."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

MAX_BYTES = 8 * 1024 * 1024
TABLES = ("MasterWaveBattle", "MasterWaveBattleStage", "MasterWaveBattlePhase", "MasterBattle")
KIND = "installed-game-static"
_LABEL = re.compile(r"[A-Za-z0-9_.:-]{1,200}\Z")
_SHA = re.compile(r"[0-9a-f]{64}\Z")


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON 含重复字段")
        result[key] = value
    return result


def load_json_unique(raw: str | bytes):
    """Decode JSON while rejecting ambiguous duplicate object keys."""
    return json.loads(raw, object_pairs_hook=_unique_object)


def _label(value, context):
    if not isinstance(value, str) or not _LABEL.fullmatch(value):
        raise ValueError(f"{context}: 标签无效")
    return value


def _int(value, low, high, context):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{context}: 整数超出范围 {low}–{high}")
    return value


def _number(value, minimum, positive, context):
    if type(value) not in (int, float) or value > 10**15 or value < minimum or not math.isfinite(value) or (positive and value == 0):
        raise ValueError(f"{context}: 数值无效")
    return value


def validate_parameters(value: object) -> dict:
    """Return an allowlisted copy; unknown source fields and any paths never escape."""
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("敌参数需要 version=1")
    events = value.get("events")
    if not isinstance(events, dict) or len(events) > 500:
        raise ValueError("敌参数 events 格式或数量无效")
    source = value.get("source")
    if source is None and not events:
        return {"version": 1, "source": None, "events": {}}
    if not isinstance(source, dict) or source.get("kind") != KIND:
        raise ValueError("敌参数来源类型无效")
    hashes = source.get("sha256")
    if not isinstance(hashes, dict) or set(hashes) != set(TABLES) or any(not isinstance(hashes[t], str) or not _SHA.fullmatch(hashes[t]) for t in TABLES):
        raise ValueError("敌参数需要四张来源表的 SHA256")
    clean = {"version": 1, "source": {"kind": KIND, "sha256": {t: hashes[t] for t in TABLES}}, "events": {}}
    total = 0
    for event_label, event in events.items():
        _label(event_label, "活动")
        difficulties = event.get("difficultyStages") if isinstance(event, dict) else None
        if not isinstance(difficulties, dict) or not 1 <= len(difficulties) <= 1000:
            raise ValueError("difficultyStages 格式或数量无效")
        clean_levels = {}
        for key, stages in difficulties.items():
            if not isinstance(key, str) or not key.isascii() or not key.isdigit() or str(int(key)) != key or not 1 <= int(key) <= 10000:
                raise ValueError("难度键必须为正整数文本")
            difficulty = int(key)
            if not isinstance(stages, list) or not 1 <= len(stages) <= 100:
                raise ValueError("难度阶段列表无效")
            clean_stages = []
            for phase, stage in enumerate(stages, 1):
                total += 1
                if total > 20000 or not isinstance(stage, dict):
                    raise ValueError("敌参数阶段数量或格式无效")
                battle = _label(stage.get("battleLabel"), "战斗")
                if stage.get("label") != battle or stage.get("difficulty") != difficulty or type(stage.get("difficulty")) is not int or stage.get("phase") != phase or type(stage.get("phase")) is not int:
                    raise ValueError("阶段的标签、难度或顺序不一致")
                provenance = stage.get("parameterSource")
                if not isinstance(provenance, dict) or provenance.get("kind") != KIND or provenance.get("battleLabel") != battle:
                    raise ValueError("阶段来源无效")
                clean_provenance = {"kind": KIND, "stageLabel": _label(provenance.get("stageLabel"), "难度阶段来源"),
                                    "phaseLabel": _label(provenance.get("phaseLabel"), "阶段来源"), "battleLabel": battle}
                enemies = stage.get("enemies")
                if not isinstance(enemies, list) or not 1 <= len(enemies) <= 100:
                    raise ValueError("敌人列表无效")
                clean_enemies, last_slot = [], -1
                for enemy in enemies:
                    if not isinstance(enemy, dict):
                        raise ValueError("敌人格式无效")
                    slot = _int(enemy.get("slot"), 0, 99, "敌人槽位")
                    if slot <= last_slot:
                        raise ValueError("敌人槽位必须递增且不重复")
                    last_slot = slot
                    clean_enemies.append({"label": _label(enemy.get("label"), "敌人"), "slot": slot,
                                          "dp": _number(enemy.get("dp"), 0, False, "DP"),
                                          "hp": _number(enemy.get("hp"), 0, True, "HP"),
                                          "paramBorder": _number(enemy.get("paramBorder"), 0, True, "能力值")})
                clean_stages.append({"label": battle, "battleLabel": battle, "phase": phase, "difficulty": difficulty,
                                     "enemies": clean_enemies, "parameterSource": clean_provenance})
            clean_levels[key] = clean_stages
        clean["events"][event_label] = {"difficultyStages": clean_levels}
    return clean


def read_parameters(root: Path) -> dict:
    path = Path(root) / "enemy-parameters.json"
    if not path.exists():
        return {"version": 1, "source": None, "events": {}}
    with path.open("rb") as source:
        raw = source.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("enemy-parameters.json 超过 8 MiB 上限")
    try:
        value = load_json_unique(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("enemy-parameters.json 不是有效 JSON") from exc
    return validate_parameters(value)
