"""从本机 HBR 客户端缓存（DeltaComm `_bcdb0_`）读取养成状态，生成导入预览。

缓存编码（2026-11-06 在副本上逆向并全量验证）：
    明文[i] = 密文[i] XOR 密文[i-1] XOR KEY[i % 256]      （i=0 时不异或前一字节）
明文是 JSON；文件名另有编码，这里按表字段识别，不依赖文件名。

只读：逐个文件以 'rb' 读入内存，不复制、不写、不锁定游戏目录；不接触游戏进程或网络。
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime
from pathlib import Path

KEY = bytes.fromhex(
    "8cfd624b88297e17c495da234041766ffc2d52fbf8596ec734c5cad3b071661f"
    "6c5d42ab68895e77a4f5ba8320a156cfdc8d325bd8b94e271425aa3390d1467f"
    "4cbd220b48e93ed784559ae30001362fbced12bbb8192e87f4858a93703126df"
    "2c1d026b28491e3764b57a43e061168f9c4df21b98790ee7d4e56af35091063f"
    "0c7de2cb08a9fe9744155aa3c0c1f6ef7cadd27b78d9ee47b4454a5330f1e69f"
    "ecddc22be809def724753a03a021d64f5c0db2db5839cea794a52ab31051c6ff"
    "cc3da28bc869be5704d51a638081b6af3c6d923b3899ae0774050a13f0b1a65f"
    "ac9d82eba8c99eb7e435fac360e1960f1ccd729b18f98e675465ea73d01186bf")
assert len(KEY) == 256

CHARACTER_ID_BASE = 4000000
MAX_FILE_BYTES = 64 * 1024 * 1024
# 按字段签名识别表（缓存文件名是编码过的）
TABLES = {
    "cards": {"_masterCardId", "_limitBreakLevel", "_daphneUsedNum", "_isResonanceShift"},
    "characters": {"_masterCharacterId", "_reincarnationCount", "_tieLevel", "_latentLevel"},
    "accessories": {"_masterAccessoryId", "_plusCount", "_expansionAbilityEffectList", "_mainAbilityEffectList"},
    "skills": {"_masterSkillId", "_levelByBattle", "_levelByItem", "_isLearnedMasterlySkill"},
    "latents": {"_masterCharacterId", "_masterLatentAbilityId"},
    "boosters": {"_masterSeraphBoosterId", "_isAlreadyPossessed"},
    "spheres": {"_masterSeraphSphereId", "_isAlreadyPossessed"},
    # 编队：成员（卡面、编队技能、各饰品实例）、槽位顺序、编队名（对象文件）
    "deck_members": {"_deckIndex", "_masterCardId", "_earringAccessoryId", "_masterSkillIds"},
    "deck_slots": {"_deckIndex", "_slotIndex", "_characterId", "_characterSlotType"},
    "deck_meta": {"_partyNameList", "_currentDeckIndex"},
}
REQUIRED = ("cards", "characters")


def default_cache_dir() -> Path:
    override = os.environ.get("HBR_CACHE_DIR")
    if override:
        return Path(override)
    return Path(os.path.expanduser("~")) / "AppData" / "LocalLow" / "wfs" / "HeavenBurnsRed" / "_bcdb0_"


def decode(data: bytes) -> bytes:
    out = bytearray(len(data))
    prev = 0
    for i, c in enumerate(data):
        out[i] = c ^ prev ^ KEY[i & 255]
        prev = c
    return bytes(out)


def encode(plain: bytes) -> bytes:
    """decode 的逆运算，只供测试构造样例。"""
    out = bytearray(len(plain))
    prev = 0
    for i, p in enumerate(plain):
        prev = out[i] = p ^ prev ^ KEY[i & 255]
    return bytes(out)


def read_tables(cache_dir: Path | None = None) -> dict:
    """读取并识别需要的表。返回 {'tables': {...}, 'source': {...}}；缺表时 tables 里没有对应键。"""
    folder = Path(cache_dir or default_cache_dir())
    if not folder.is_dir():
        raise FileNotFoundError(f"没找到游戏缓存目录：{folder}（需要先在本机启动过一次游戏）")
    tables: dict[str, list] = {}
    found_at: dict[str, float] = {}
    scanned = parsed = 0
    newest = 0.0
    for path in folder.iterdir():
        if not path.is_file():
            continue
        stat = path.stat()
        if stat.st_size <= 2 or stat.st_size > MAX_FILE_BYTES:
            continue
        scanned += 1
        newest = max(newest, stat.st_mtime)
        with open(path, "rb") as fh:
            raw = fh.read()
        if not raw.startswith((b"\xd7", b"\xf7")):  # 明文 '[' / '{' 的密文首字节；哈希等跳过
            continue
        try:
            rows = json.loads(decode(raw).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            continue  # 游戏正在写入或非 JSON 文件
        if isinstance(rows, dict):
            rows = [rows]  # 编队名等对象文件
        parsed += 1
        if not (isinstance(rows, list) and rows and isinstance(rows[0], dict)):
            continue
        fields = set(rows[0])
        for name, sig in TABLES.items():
            if sig <= fields and (name not in tables or stat.st_mtime > found_at[name]):
                tables[name] = rows
                found_at[name] = stat.st_mtime
    iso = lambda t: datetime.fromtimestamp(t).isoformat(sep=" ", timespec="seconds") if t else None
    return {"tables": tables, "source": {
        "dir": str(folder), "scanned": scanned, "parsed": parsed, "newest": iso(newest),
        "tables": {k: {"rows": len(v), "modified": iso(found_at[k])} for k, v in tables.items()},
        "read_at": datetime.now().isoformat(sep=" ", timespec="seconds")}}


def _direction(old, new, field):
    if field == "owned" or old is None or old == []:
        return "new"
    if isinstance(new, bool):
        return "up" if new else "down"
    if isinstance(new, list):
        return "up" if set(new) >= set(old) else "down"
    return "up" if new > old else "down"


def _change(kind, target, field, label, old, new, **extra):
    if old == new:
        return None
    change = {"id": f"{kind}s.{target}.{field}", "kind": kind, "target": target, "field": field,
              "label": label, "from": old, "to": new, "direction": _direction(old, new, field)}
    change.update({k: v for k, v in extra.items() if v is not None})
    return change


def inventory_snapshot(tables: dict, equipment: dict | None, read_at: str | None) -> dict | None:
    """游戏内持有的饰品／灵魂书／宝玉／护符、强化器、芯片，按目录 ID 汇总。行存在即持有。"""
    if not equipment or not any(k in tables for k in ("accessories", "boosters", "spheres")):
        return None
    by_src = {e["sourceId"]: e for e in equipment.get("entries", [])}
    held: dict[str, dict] = {}
    unmapped = 0

    def add(source_id, plus=None, effects=None, locked=False):
        nonlocal unmapped
        entry = by_src.get(source_id)
        if not entry:
            unmapped += 1
            return
        h = held.setdefault(entry["id"], {"count": 0, "maxPlus": None, "locked": 0, "rolls": []})
        h["count"] += 1
        h["locked"] += 1 if locked else 0
        if plus is not None:
            h["maxPlus"] = max(h["maxPlus"] or 0, int(plus))
        if effects:
            h["rolls"].append(effects)  # 原始效果 ID，随机词条映射待接入

    for r in tables.get("accessories", []):
        add(r.get("_masterAccessoryId"), r.get("_plusCount"),
            (r.get("_mainAbilityEffectList") or []) + (r.get("_expansionAbilityEffectList") or []),
            bool(r.get("_isLocked")))
    for r in tables.get("boosters", []):
        add(r.get("_masterSeraphBoosterId"))
    for r in tables.get("spheres", []):
        add(r.get("_masterSeraphSphereId"))
    return {"source": "game-cache", "readAt": read_at, "entries": held, "unmapped": unmapped,
            "total": sum(h["count"] for h in held.values())}


def build_preview(tables: dict, catalog: dict, archive: dict | None, equipment: dict | None = None,
                  read_at: str | None = None) -> dict:
    """把缓存表与当前档案逐字段比较。不修改 archive。

    已验证含义的字段：拥有、突破、开花（_daphneUsedNum≥1）、角色等级、转生、精通技能、潜在词条池、
    SS/SSR 卡面等级（_level，0–20，2026-11-06 用户在游戏内升级一千子卡面后确认）、
    灵魂书强化（_plusCount，0–5，用户确认通常直接强化到 5）。
    潜在面板 _latentPanelAcquiredCountList 按力量/灵巧/体力/精神/智慧/幸运保存节点数，
    与 latentStats 属性加成分开；不据节点数推导加成。空列表保持未知。
    角色潜在力等级 _latentLevel 直接对应游戏显示（2026-11-07 用户确认成濑光 Lv.4）。
    能力树：分区全部取得时写 training 节点；技能显示等级按能力树节点 + 战斗/道具升级推算（见下方注释）。
    缓存里没出现的卡面不判为未拥有；Rank 暂不导入。
    """
    archive = archive or {}
    styles_now = archive.get("styles") or {}
    chars_now = archive.get("characters") or {}
    by_card = {s["sourceId"]: s for s in catalog.get("styles", [])}
    by_char = {c["sourceId"]: c for c in catalog.get("characters", [])}
    by_latent = {x["sourceId"]: x for x in catalog.get("latentAbilities", [])}
    style_by_id = {s["id"]: s for s in catalog.get("styles", [])}
    char_names = {c["id"]: c.get("name") for c in catalog.get("characters", [])}
    style_label = lambda s: f"{char_names.get(s.get('characterId')) + ' · ' if char_names.get(s.get('characterId')) else ''}{s.get('name') or s['id']}（{s.get('tier', '')}）"
    changes, unmapped_cards, unmapped_chars = [], [], []
    skill_nodes: dict = {}
    unknown_skills: set = set()
    owned_styles: list = []
    seen_styles = 0
    for row in tables.get("cards", []):
        style = by_card.get(row.get("_masterCardId"))
        if not style:
            unmapped_cards.append(row.get("_masterCardId"))
            continue
        seen_styles += 1
        sid, now = style["id"], styles_now.get(style["id"]) or {}
        label = style_label(style)
        cand = [
            _change("style", sid, "owned", label, bool(now.get("owned")), True),
            _change("style", sid, "limitBreak", label, now.get("limitBreak"), int(row["_limitBreakLevel"])),
            _change("style", sid, "bloomed", label, now.get("bloomed"), int(row.get("_daphneUsedNum") or 0) >= 1),
        ]
        if style.get("tier") in ("SS", "SSR") and int(row.get("_level") or 0) > 0:
            cand.append(_change("style", sid, "cardLevel", label, now.get("cardLevel"), int(row["_level"])))
        changes += [c for c in cand if c]
        # 六项是已取得面板节点数，不是属性加成；空列表表示未知，不填零。
        panels = row.get("_latentPanelAcquiredCountList")
        if (isinstance(panels, list) and len(panels) == 6
                and all(type(v) is int and 0 <= v <= 999999 for v in panels)):
            old_panels = now.get("latentPanels") or {}
            for key, value in zip(("str", "dex", "con", "spr", "wis", "luk"), panels):
                c = _change("style", sid, "latentPanels", label, old_panels.get(key), value, key=key)
                if c:
                    c["id"] += "." + key
                    changes.append(c)
        # 能力树：分区 ID 末位 k = 公开能力树第 k 个分区，_count = 已取得节点数；0、1 号初期开放分区
        # 缓存不记，视为已取得。只在分区全部取得时写节点（部分取得时取得顺序未知）。
        got = {int(p["_masterAbilityTreeId"]) % 10: int(p["_count"])
               for p in row.get("_abilityTreeParts") or [] if "_masterAbilityTreeId" in p and "_count" in p}
        old_training = now.get("training") or {}
        card_skill_nodes: dict = defaultdict(int)
        for k, group in enumerate(style.get("trainingGroups") or []):
            nodes = group.get("nodes") or []
            have = len(nodes) if k < 2 else got.get(k)
            full = have == len(nodes)
            for node in nodes:
                if node.get("type") == "Skill" and node.get("skillId"):
                    if full:
                        card_skill_nodes[node["skillId"]] += 1
                    else:
                        unknown_skills.add((style.get("characterId"), node["skillId"]))
            if full and nodes:
                ids = [n["id"] for n in nodes]
                old = old_training.get(group["id"])
                if not (isinstance(old, list) and set(old) == set(ids)):
                    c = _change("style", sid, "training", label, old, ids, key=group["id"],
                                keyLabel=group.get("name"))
                    c["id"] += "." + group["id"]
                    changes.append(c)
        for skill_src, n in card_skill_nodes.items():
            key = (style.get("characterId"), skill_src)
            skill_nodes[key] = max(skill_nodes.get(key, 0), n)
        owned_styles.append((style, label, now))

    # 技能显示等级 = 该角色已持有卡面中此技能能力树节点数（取单卡最大值，跨卡不累加）
    #               + _levelByBattle + _levelByItem。2026-11-07 用 370 条技能核对：无一超过上限、158 条恰为 10；
    # 一千子样例 3 节点 + 1 次道具升级 = 4 与用户游戏内所见一致。分区未全取得、缺技能行或超上限时不写。
    char_src = {c["id"]: c["sourceId"] for c in catalog.get("characters", [])}
    if "skills" in tables:
        skill_rows = {(r.get("_masterCharacterId"), r.get("_masterSkillId")): r for r in tables["skills"]}
        for style, label, now in owned_styles:
            raw_char = CHARACTER_ID_BASE + char_src.get(style.get("characterId"), -CHARACTER_ID_BASE)
            old_levels = now.get("skillLevels") or {}
            for sk in style.get("skills") or []:
                key = (style.get("characterId"), sk.get("sourceId"))
                srow = skill_rows.get((raw_char, sk.get("sourceId")))
                if key in unknown_skills or not srow or not skill_nodes.get(key):
                    continue
                level = skill_nodes[key] + int(srow.get("_levelByBattle") or 0) + int(srow.get("_levelByItem") or 0)
                if not 1 <= level <= int(sk.get("maxLevel") or 10):
                    continue
                c = _change("style", style["id"], "skillLevels", label, old_levels.get(sk["id"]), level,
                            key=sk["id"], keyLabel=sk.get("name"))
                if c:
                    c["id"] += "." + sk["id"]
                    changes.append(c)

    # 灵魂书：饰品表里 slot=soul 的条目，按专用卡面汇总
    if equipment and "accessories" in tables:
        by_eq = {e["sourceId"]: e for e in equipment.get("entries", [])}
        souls: dict[str, int] = {}
        for r in tables["accessories"]:
            e = by_eq.get(r.get("_masterAccessoryId"))
            if e and e.get("slot") == "soul" and e.get("styleId") in style_by_id:
                souls[e["styleId"]] = max(souls.get(e["styleId"], 0), int(r.get("_plusCount") or 0))
        for sid, plus in souls.items():
            now = styles_now.get(sid) or {}
            label = style_label(style_by_id[sid])
            for c in (_change("style", sid, "soulBook", label, now.get("soulBook"), True),
                      _change("style", sid, "soulBookLevel", label, now.get("soulBookLevel"), plus,
                              also={"soulBookLevelMode": "recorded"})):
                if c:
                    changes.append(c)

    masterly = {r.get("_masterCharacterId") for r in tables.get("skills", []) if r.get("_isLearnedMasterlySkill")}
    latents: dict[int, list] = defaultdict(list)
    for r in tables.get("latents", []):
        x = by_latent.get(r.get("_masterLatentAbilityId"))
        if x:
            latents[r.get("_masterCharacterId")].append(x["id"])
    for row in tables.get("characters", []):
        raw_id = int(row.get("_masterCharacterId", 0))
        ch = by_char.get(raw_id - CHARACTER_ID_BASE)
        if not ch:
            unmapped_chars.append(raw_id)
            continue
        cid, now = ch["id"], chars_now.get(ch["id"]) or {}
        label = ch.get("name") or cid
        for field, key in (("level", "_level"), ("reincarnation", "_reincarnationCount"), ("latentLevel", "_latentLevel")):
            if row.get(key) is not None and (field != "level" or int(row[key]) >= 1):
                c = _change("character", cid, field, label, now.get(field), int(row[key]))
                if c:
                    changes.append(c)
        if "skills" in tables:
            c = _change("character", cid, "masterSkillUnlocked", label, now.get("masterSkillUnlocked"), raw_id in masterly)
            if c:
                changes.append(c)
        if latents.get(raw_id):
            pool = sorted(set(latents[raw_id]))
            old = now.get("availableLatentIds") if now.get("latentPoolMode") == "selected" else None
            c = _change("character", cid, "availableLatentIds", label, sorted(old) if old else old, pool,
                        also={"latentPoolMode": "selected"})
            if c:
                changes.append(c)

    snap = inventory_snapshot(tables, equipment, read_at)
    if snap:
        old = archive.get("gameInventory")
        changes.append({"id": "archive.gameInventory", "kind": "archive", "target": "archive", "field": "gameInventory",
                        "label": "游戏内持有装备（整体替换）", "from": old.get("total") if isinstance(old, dict) else None,
                        "to": snap["total"], "value": snap, "direction": "new" if not old else "up"})

    counts = {d: sum(1 for c in changes if c["direction"] == d) for d in ("new", "up", "down")}
    return {"changes": changes, "counts": counts, "cards_in_cache": len(tables.get("cards", [])),
            "characters_in_cache": len(tables.get("characters", [])), "styles_mapped": seen_styles,
            "unmapped": {"cards": unmapped_cards, "characters": unmapped_chars,
                         "equipment": snap["unmapped"] if snap else 0},
            "missing_tables": [k for k in REQUIRED if k not in tables],
            "optional_missing": [k for k in TABLES if k not in tables and k not in REQUIRED]}


def preview_from_cache(catalog: dict, archive: dict | None, cache_dir: Path | None = None,
                       equipment: dict | None = None) -> dict:
    data = read_tables(cache_dir)
    result = build_preview(data["tables"], catalog, archive, equipment, data["source"]["read_at"])
    result["source"] = data["source"]
    return result


if __name__ == "__main__":  # 调试：python hbr_cache.py <catalog.json> <equipment.json> [archive.json]
    import sys
    cat = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    eqp = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    arc = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8")) if len(sys.argv) > 3 else None
    res = preview_from_cache(cat, arc, equipment=eqp)
    print(json.dumps({k: v for k, v in res.items() if k != "changes"}, ensure_ascii=False, indent=1))
    by_field = defaultdict(lambda: defaultdict(int))
    for c in res["changes"]:
        by_field[c["field"]][c["direction"]] += 1
    print({k: dict(v) for k, v in by_field.items()})


# ---------------------------------------------------------------- 编队

ACCESSORY_SLOTS = ("earring", "necklace", "ring", "bracelet", "soul", "jewel",
                   "powerCharm", "dexterityCharm", "toughnessCharm", "spiritCharm", "wisdomCharm", "luckCharm")


def _accessory_instance(a: dict) -> dict:
    item = {"masterId": a.get("_masterAccessoryId"), "main": list(a.get("_mainAbilityEffectList") or []),
            "expansion": list(a.get("_expansionAbilityEffectList") or []), "plus": a.get("_plusCount") or 0}
    if a.get("_id") is not None:
        item["instanceId"] = str(a["_id"])
    return item


def _tree_parts(card: dict) -> list:
    return [{"id": x.get("_masterAbilityTreeId"), "count": x.get("_count")} for x in card.get("_abilityTreeParts") or []]


def _character_cards(tables: dict, by_source: dict, character_id) -> list:
    return [{"styleId": by_source[c["_masterCardId"]]["id"], "limitBreak": c.get("_limitBreakLevel"), "daphne": c.get("_daphneUsedNum"),
             "treeParts": _tree_parts(c)}
            for c in tables.get("cards", []) if c.get("_masterCardId") in by_source
            and by_source[c["_masterCardId"]].get("characterId") == character_id]


def _support_raw(tables: dict, by_source: dict, cards: dict, card_id) -> dict | None:
    """支援卡面的面板原始数据（支援加成 = 支援卡面状态值的 10%）。"""
    style = by_source.get(card_id)
    card = cards.get(card_id)
    if not style or not card:
        return None
    char = next((c for c in tables.get("characters", []) if c.get("_masterCharacterId") == _char_id_of(card_id)), {})
    return {"styleId": style["id"], "limitBreak": card.get("_limitBreakLevel"),
            "card": {"level": card.get("_level"), "daphne": card.get("_daphneUsedNum"), "latentPanels": list(card.get("_latentPanelAcquiredCountList") or []),
                     "treeParts": _tree_parts(card)},
            "character": {"level": char.get("_level"), "reincarnation": char.get("_reincarnationCount"), "titleExp": char.get("_titleBadgeExp")},
            "characterCards": _character_cards(tables, by_source, style.get("characterId"))}


def _char_id_of(card_id: int) -> int:
    """卡面 ID 1005504 → 角色 4000055（第 2–5 位为角色编号）。"""
    return CHARACTER_ID_BASE + (card_id // 100) % 1000


def decks_from_tables(tables: dict, catalog: dict) -> list[dict]:
    """把缓存编队表整理成 [{index, name, current, members:[...]}]。
    成员含卡面、编队技能、各饰品主数据 ID 与主词条选择（_mainAbilityEffectList，由前端按 equipment.json 解释）、
    支援卡、突破、泪（_daphneUsedNum）。随机副词条（属性）不解释。"""
    meta = (tables.get("deck_meta") or [{}])[0]
    names = meta.get("_partyNameList") or []
    by_source = {s.get("sourceId"): s for s in catalog.get("styles", [])}
    cards = {c.get("_masterCardId"): c for c in tables.get("cards", [])}
    acc = {a.get("_id"): a for a in tables.get("accessories", [])}
    members = {(m.get("_deckIndex"), m.get("_masterCharacterId")): m for m in tables.get("deck_members", [])}
    chars = {c.get("_masterCharacterId"): c for c in tables.get("characters", [])}
    out = []
    for index, name in enumerate(names):
        slots = sorted((s for s in tables.get("deck_slots", []) if s.get("_deckIndex") == index), key=lambda s: s.get("_slotIndex", 0))
        if not any(s.get("_characterId") for s in slots):
            continue
        row = []
        for s in slots:
            m = members.get((index, s.get("_characterId")))
            if not m:
                row.append(None)
                continue
            style = by_source.get(m.get("_masterCardId"))
            card = cards.get(m.get("_masterCardId"), {})
            accessories, unresolved = {}, []
            for slot in ACCESSORY_SLOTS:
                ref = m.get(f"_{slot}AccessoryId")
                if not ref:
                    continue
                a = acc.get(ref)
                if a:
                    accessories[slot] = _accessory_instance(a)
                else:
                    unresolved.append(slot)
            support = by_source.get(m.get("_supportCardId"))
            char = chars.get(m.get("_masterCharacterId"), {})
            row.append({
                "slot": s.get("_slotIndex"), "styleId": style["id"] if style else None, "cardSourceId": m.get("_masterCardId"),
                "characterId": style.get("characterId") if style else None, "skillIds": [x for x in m.get("_masterSkillIds") or [] if x],
                "accessories": accessories, "unresolvedAccessories": unresolved, "supportStyleId": support["id"] if support else None,
                "limitBreak": card.get("_limitBreakLevel"), "tearLevel": card.get("_daphneUsedNum"),
                # 面板推算用的原始数据
                "card": {"level": card.get("_level"), "daphne": card.get("_daphneUsedNum"), "resonanceShift": bool(card.get("_isResonanceShift")), "latentPanels": list(card.get("_latentPanelAcquiredCountList") or []),
                         "treeParts": [{"id": x.get("_masterAbilityTreeId"), "count": x.get("_count")} for x in card.get("_abilityTreeParts") or []]},
                "character": {"level": char.get("_level"), "reincarnation": char.get("_reincarnationCount"), "tieLevel": char.get("_tieLevel"),
                              "titleExp": char.get("_titleBadgeExp"), "latentLevel": char.get("_latentLevel")},
                "boosterId": m.get("_seraphBoosterMasterId") or None, "sphereIds": [x for x in m.get("_seraphSphereMasterIdList") or [] if x],
                "latentIds": [x for x in m.get("_masterLatentAbilityIds") or [] if x],
                "supportLimitBreak": cards.get(m.get("_supportCardId"), {}).get("_limitBreakLevel"),
                "characterCards": _character_cards(tables, by_source, (style or {}).get("characterId")),
                "support": _support_raw(tables, by_source, cards, m.get("_supportCardId")),
            })
        out.append({"index": index, "name": name, "current": index == meta.get("_currentDeckIndex"), "members": row})
    return out


def owned_cards(tables: dict, catalog: dict) -> list[dict]:
    """全部已持有卡面的面板原始数据（不含饰品；换卡面时沿用该位置的饰品）。供排轴配置优化用。"""
    by_source = {s.get("sourceId"): s for s in catalog.get("styles", [])}
    chars = {c.get("_masterCharacterId"): c for c in tables.get("characters", [])}
    out = []
    for card in tables.get("cards", []):
        style = by_source.get(card.get("_masterCardId"))
        if not style:
            continue
        char = chars.get(_char_id_of(card.get("_masterCardId")), {})
        out.append({
            "styleId": style["id"], "cardSourceId": card.get("_masterCardId"), "characterId": style.get("characterId"),
            "limitBreak": card.get("_limitBreakLevel"), "tearLevel": card.get("_daphneUsedNum"),
            "card": {"level": card.get("_level"), "daphne": card.get("_daphneUsedNum"), "resonanceShift": bool(card.get("_isResonanceShift")), "latentPanels": list(card.get("_latentPanelAcquiredCountList") or []),
                     "treeParts": _tree_parts(card)},
            "character": {"level": char.get("_level"), "reincarnation": char.get("_reincarnationCount"), "tieLevel": char.get("_tieLevel"),
                          "titleExp": char.get("_titleBadgeExp"), "latentLevel": char.get("_latentLevel")},
            "characterCards": _character_cards(tables, by_source, style.get("characterId")),
        })
    return out


def accessory_inventory(tables: dict) -> list[dict]:
    """饰品库存（实例：主数据 ID、主词条、+枠、强化）。"""
    return [_accessory_instance(a) for a in tables.get("accessories", []) if a.get("_masterAccessoryId")]


def decks_from_cache(catalog: dict, cache_dir: Path | None = None) -> dict:
    data = read_tables(cache_dir)
    t = data["tables"]
    missing = [k for k in ("deck_members", "deck_slots", "deck_meta") if k not in t]
    result = {"decks": decks_from_tables(t, catalog) if not missing else [], "missing_tables": missing, "read_at": data["source"]["read_at"],
              "cards": owned_cards(t, catalog), "accessories": accessory_inventory(t)}
    if "boosters" in t and "spheres" in t:
        counts = defaultdict(int)
        for table, key in (("boosters", "_masterSeraphBoosterId"), ("spheres", "_masterSeraphSphereId")):
            for row in t[table]:
                if row.get(key):
                    counts[str(row[key])] += 1
        result["moduleCounts"] = dict(counts)
    return result
