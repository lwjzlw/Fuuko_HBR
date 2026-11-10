"""hbr_cache 测试：用自造的编码样例，不读取真实游戏缓存。"""
import json
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import hbr_app  # noqa: E402
import hbr_cache  # noqa: E402

CATALOG = {
    "styles": [
        {"id": "RKayamori01", "sourceId": 1001101, "tier": "A", "name": "A卡"},
        {"id": "RKayamori05", "sourceId": 1001105, "tier": "SS", "name": "SS卡"},
        {"id": "YIzumi05", "sourceId": 1001205, "tier": "SS", "name": "未拥有卡"},
    ],
    "characters": [{"id": "RKayamori", "sourceId": 11, "name": "茅森月歌"}],
}
CARDS = [
    {"_masterCardId": 1001101, "_limitBreakLevel": 20, "_level": 0, "_daphneUsedNum": 0, "_isResonanceShift": False},
    {"_masterCardId": 1001105, "_limitBreakLevel": 3, "_level": 15, "_daphneUsedNum": 1, "_isResonanceShift": False},
    {"_masterCardId": 9999999, "_limitBreakLevel": 0, "_level": 1, "_daphneUsedNum": 0, "_isResonanceShift": False},
]
CHARS = [{"_masterCharacterId": 4000011, "_level": 180, "_reincarnationCount": 5, "_tieLevel": 4, "_latentLevel": 1}]


def write_cache(folder: Path):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "AA01").write_bytes(hbr_cache.encode(json.dumps(CARDS).encode()))
    (folder / "AA02").write_bytes(hbr_cache.encode(json.dumps(CHARS).encode()))
    (folder / "AA03").write_bytes(hbr_cache.encode(b"[]"))
    (folder / "AA04").write_bytes(b"\xd7garbage-not-json")
    (folder / "AA05").write_bytes(b"")


class DecodeTests(unittest.TestCase):
    def test_roundtrip_longer_than_key(self):
        plain = json.dumps([{"_k": i} for i in range(200)]).encode()
        self.assertGreater(len(plain), 512)
        self.assertEqual(hbr_cache.decode(hbr_cache.encode(plain)), plain)

    def test_known_prefix(self):
        # 真实缓存中所有 JSON 数组文件的密文首字节均为 0xd7，空数组为 d7 77
        self.assertEqual(hbr_cache.encode(b"[]"), bytes.fromhex("d777"))


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / "_bcdb0_"
        write_cache(self.cache)

    def tearDown(self):
        self.tmp.cleanup()

    def test_tables_found_and_garbage_skipped(self):
        data = hbr_cache.read_tables(self.cache)
        self.assertEqual(set(data["tables"]), {"cards", "characters"})
        self.assertEqual(data["source"]["tables"]["cards"]["rows"], 3)

    def test_preview_directions(self):
        archive = {"styles": {"RKayamori01": {"owned": True, "limitBreak": 20},
                              "RKayamori05": {"owned": True, "limitBreak": 4, "bloomed": False, "cardLevel": 20},
                              "YIzumi05": {"owned": True, "limitBreak": 1}},
                   "characters": {"RKayamori": {"level": 170, "reincarnation": 5}}}
        res = hbr_cache.build_preview(hbr_cache.read_tables(self.cache)["tables"], CATALOG, archive)
        by_id = {c["id"]: c for c in res["changes"]}
        self.assertEqual(by_id["styles.RKayamori05.limitBreak"]["direction"], "down")
        self.assertEqual(by_id["styles.RKayamori05.bloomed"]["direction"], "up")
        self.assertNotIn("unverified", by_id["styles.RKayamori05.cardLevel"])
        self.assertEqual(by_id["characters.RKayamori.level"]["to"], 180)
        self.assertNotIn("characters.RKayamori.reincarnation", by_id)
        # A 卡没有卡面等级；缓存里没出现的已拥有卡不改成未拥有
        self.assertNotIn("styles.RKayamori01.cardLevel", by_id)
        self.assertFalse(any(c["target"] == "YIzumi05" for c in res["changes"]))
        self.assertEqual(res["unmapped"]["cards"], [9999999])

    def test_new_card_marked_owned(self):
        res = hbr_cache.build_preview(hbr_cache.read_tables(self.cache)["tables"], CATALOG, {})
        owned = [c for c in res["changes"] if c["field"] == "owned"]
        self.assertEqual({c["target"] for c in owned}, {"RKayamori01", "RKayamori05"})
        self.assertTrue(all(c["direction"] == "new" for c in owned))

    def test_missing_dir(self):
        with self.assertRaises(FileNotFoundError):
            hbr_cache.read_tables(Path(self.tmp.name) / "nope")


class ExtraTableTests(unittest.TestCase):
    CAT = {**CATALOG, "latentAbilities": [{"id": "latent.A", "sourceId": 331000012}, {"id": "latent.B", "sourceId": 331000016}]}
    EQUIP = {"entries": [
        {"id": "Acc.Soul.RKayamori05", "sourceId": 5010111, "slot": "soul", "styleId": "RKayamori05"},
        {"id": "Acc.Ring001a", "sourceId": 5000001, "slot": "ring", "styleId": None},
        {"id": "Booster.1", "sourceId": 86000101, "slot": "booster", "styleId": None},
    ]}
    TABLES = {
        "cards": CARDS, "characters": CHARS,
        "accessories": [
            {"_masterAccessoryId": 5010111, "_plusCount": 5, "_mainAbilityEffectList": [], "_expansionAbilityEffectList": [1, 2, 3], "_isLocked": True},
            {"_masterAccessoryId": 5000001, "_plusCount": 0, "_mainAbilityEffectList": [], "_expansionAbilityEffectList": [], "_isLocked": False},
            {"_masterAccessoryId": 5000001, "_plusCount": 0, "_mainAbilityEffectList": [], "_expansionAbilityEffectList": [], "_isLocked": False},
            {"_masterAccessoryId": 5999999, "_plusCount": 0, "_mainAbilityEffectList": [], "_expansionAbilityEffectList": [], "_isLocked": False},
        ],
        "skills": [{"_masterSkillId": 1, "_masterCharacterId": 4000011, "_levelByBattle": 0, "_levelByItem": 0, "_isLearnedMasterlySkill": True}],
        "latents": [{"_masterCharacterId": 4000011, "_masterLatentAbilityId": 331000016},
                    {"_masterCharacterId": 4000011, "_masterLatentAbilityId": 331000012}],
        "boosters": [{"_masterSeraphBoosterId": 86000101, "_isAlreadyPossessed": True}],
    }

    def preview(self, archive):
        res = hbr_cache.build_preview(self.TABLES, self.CAT, archive, self.EQUIP, "2026-11-06 23:00:00")
        return res, {c["id"]: c for c in res["changes"]}

    def test_soul_latent_masterly(self):
        _, by_id = self.preview({"characters": {"RKayamori": {"level": 180, "reincarnation": 5, "latentPoolMode": "unknown"}}})
        lv = by_id["styles.RKayamori05.soulBookLevel"]
        self.assertEqual((lv["to"], lv["also"], lv.get("unverified")), (5, {"soulBookLevelMode": "recorded"}, None))
        self.assertTrue(by_id["styles.RKayamori05.soulBook"]["to"])
        pool = by_id["characters.RKayamori.availableLatentIds"]
        self.assertEqual((pool["to"], pool["direction"], pool["also"]), (["latent.A", "latent.B"], "new", {"latentPoolMode": "selected"}))
        self.assertTrue(by_id["characters.RKayamori.masterSkillUnlocked"]["to"])

    def test_latent_pool_shrink_is_down(self):
        _, by_id = self.preview({"characters": {"RKayamori": {"latentPoolMode": "selected", "availableLatentIds": ["latent.A", "latent.C"]}}})
        self.assertEqual(by_id["characters.RKayamori.availableLatentIds"]["direction"], "down")

    def test_inventory_snapshot(self):
        res, by_id = self.preview({})
        snap = by_id["archive.gameInventory"]["value"]
        self.assertEqual(snap["entries"]["Acc.Ring001a"]["count"], 2)
        self.assertEqual(snap["entries"]["Acc.Soul.RKayamori05"], {"count": 1, "maxPlus": 5, "locked": 1, "rolls": [[1, 2, 3]]})
        self.assertEqual(snap["entries"]["Booster.1"]["count"], 1)
        self.assertEqual((snap["total"], snap["unmapped"], res["unmapped"]["equipment"]), (4, 1, 1))

    def test_optional_tables_missing_ok(self):
        res = hbr_cache.build_preview({"cards": CARDS, "characters": CHARS}, self.CAT, {}, self.EQUIP)
        self.assertEqual(res["missing_tables"], [])
        self.assertIn("accessories", res["optional_missing"])
        self.assertFalse(any(c["field"] in ("gameInventory", "masterSkillUnlocked") for c in res["changes"]))


class LatentLevelTests(unittest.TestCase):
    def test_direct_display_value_directions_and_missing(self):
        for old, direction in ((None, "new"), (3, "up"), (5, "down")):
            table = {"characters": [{**CHARS[0], "_latentLevel": 4}]}
            arc = {"characters": {"RKayamori": {"latentLevel": old}}}
            result = hbr_cache.build_preview(table, CATALOG, arc)
            change = next(c for c in result["changes"] if c["field"] == "latentLevel")
            self.assertEqual((change["to"], change["direction"]), (4, direction))
        row = {k: v for k, v in CHARS[0].items() if k != "_latentLevel"}
        result = hbr_cache.build_preview({"characters": [row]}, CATALOG, {})
        self.assertFalse(any(c["field"] == "latentLevel" for c in result["changes"]))


class LatentPanelTests(unittest.TestCase):
    def preview(self, panels, archive=None):
        row = {**CARDS[1], "_latentPanelAcquiredCountList": panels}
        result = hbr_cache.build_preview({"cards": [row]}, CATALOG, archive or {})
        return [c for c in result["changes"] if c["field"] == "latentPanels"]

    def test_six_axes_and_zero_are_preserved(self):
        changes = self.preview([15, 8, 0, 0, 7, 5])
        self.assertEqual({c["key"]: c["to"] for c in changes},
                         dict(str=15, dex=8, con=0, spr=0, wis=7, luk=5))
        self.assertEqual(len({c["id"] for c in changes}), 6)
        self.assertTrue(all(c["direction"] == "new" for c in changes))

    def test_directions_per_axis_and_input_untouched(self):
        archive = {"styles": {"RKayamori05": {"owned": True,
                   "latentPanels": dict(str=15, dex=9, con=0, spr=0, wis=5, luk=5),
                   "latentStats": {"wis": 123}}}}
        before = json.dumps(archive)
        changes = {c["key"]: c for c in self.preview([15, 8, 0, 0, 7, 5], archive)}
        self.assertEqual(set(changes), {"dex", "wis"})
        self.assertEqual(changes["dex"]["direction"], "down")
        self.assertEqual(changes["wis"]["direction"], "up")
        self.assertEqual(json.dumps(archive), before)

    def test_empty_missing_or_malformed_remain_unknown(self):
        for value in (None, [], [0] * 5, [0] * 7, [True] * 6, [-1] * 6,
                      [1.5] * 6, ["5"] * 6, [1000000] * 6):
            with self.subTest(value=value):
                self.assertEqual(self.preview(value), [])

    def test_missing_card_does_not_reset_panels(self):
        result = hbr_cache.build_preview({"cards": []}, CATALOG,
                 {"styles": {"RKayamori05": {"owned": True, "latentPanels": {"wis": 7}}}})
        self.assertEqual(result["changes"], [])


class AbilityTreeTests(unittest.TestCase):
    """能力树分区 ID 末位 = 公开树分区序号；技能等级 = 单卡节点数最大值 + 战斗 + 道具。"""
    CAT = {
        "characters": [{"id": "RKayamori", "sourceId": 11, "name": "茅森月歌"}],
        "styles": [
            {"id": "RKayamori01", "sourceId": 1001101, "tier": "A", "name": "甲", "characterId": "RKayamori",
             "skills": [{"id": "SkBase", "sourceId": 900, "name": "基础", "maxLevel": 10},
                        {"id": "SkOwn", "sourceId": 901, "name": "专属", "maxLevel": 10}],
             "trainingGroups": [
                 {"id": "Part0", "name": "初期開放", "nodes": [{"id": "a0", "type": "Skill", "skillId": 900}]},
                 {"id": "SS0", "name": "初期開放", "nodes": [{"id": "a1", "type": "Dp", "skillId": None}]},
                 {"id": "Skill", "name": "スキル習得/強化", "nodes": [
                     {"id": "s1", "type": "Skill", "skillId": 901}, {"id": "s2", "type": "Skill", "skillId": 901},
                     {"id": "s3", "type": "Skill", "skillId": 901}]},
                 {"id": "Part1", "name": "能力強化I", "nodes": [{"id": "p1", "type": "Power"}, {"id": "p2", "type": "Wisdom"}]},
             ]},
            {"id": "RKayamori02", "sourceId": 1001102, "tier": "S", "name": "乙", "characterId": "RKayamori",
             "skills": [{"id": "SkBase", "sourceId": 900, "name": "基础", "maxLevel": 10}],
             "trainingGroups": [
                 {"id": "Part0b", "name": "初期開放", "nodes": [{"id": "b0", "type": "Skill", "skillId": 900}]},
                 {"id": "SS0b", "name": "初期開放", "nodes": []},
                 {"id": "Skillb", "name": "スキル習得/強化", "nodes": [
                     {"id": "t1", "type": "Skill", "skillId": 900}, {"id": "t2", "type": "Skill", "skillId": 900}]},
             ]},
        ],
    }

    def preview(self, parts1, parts2=None, skills=None, archive=None):
        cards = [{"_masterCardId": 1001101, "_limitBreakLevel": 0, "_abilityTreeParts": parts1}]
        if parts2 is not None:
            cards.append({"_masterCardId": 1001102, "_limitBreakLevel": 0, "_abilityTreeParts": parts2})
        tables = {"cards": cards}
        if skills is not None:
            tables["skills"] = [{"_masterSkillId": s, "_masterCharacterId": 4000011, "_levelByBattle": b,
                                 "_levelByItem": i, "_isLearnedMasterlySkill": False} for s, b, i in skills]
        res = hbr_cache.build_preview(tables, self.CAT, archive or {})
        return {c["id"]: c for c in res["changes"] if c["field"] in ("skillLevels", "training")}

    def test_full_parts_give_training_and_levels(self):
        by_id = self.preview([{"_masterAbilityTreeId": 38110102, "_count": 3},
                              {"_masterAbilityTreeId": 38110103, "_count": 2}],
                             skills=[(901, 0, 1), (900, 4, 2)])
        self.assertEqual(by_id["styles.RKayamori01.training.Skill"]["to"], ["s1", "s2", "s3"])
        self.assertEqual(by_id["styles.RKayamori01.training.Part1"]["keyLabel"], "能力強化I")
        self.assertIn("styles.RKayamori01.training.Part0", by_id)  # 初期分区自动取得
        self.assertEqual(by_id["styles.RKayamori01.skillLevels.SkOwn"]["to"], 4)  # 3 节点 + 1 道具
        self.assertEqual(by_id["styles.RKayamori01.skillLevels.SkBase"]["to"], 7)  # 1 节点 + 4 + 2

    def test_cross_card_uses_max_not_sum(self):
        by_id = self.preview([{"_masterAbilityTreeId": 38110102, "_count": 3},
                              {"_masterAbilityTreeId": 38110103, "_count": 2}],
                             [{"_masterAbilityTreeId": 38110202, "_count": 2}],
                             skills=[(900, 5, 2)])
        # 乙卡 3 个节点（初期 1 + 强化 2）是最大值：3 + 7 = 10，不是 1+3+7
        self.assertEqual(by_id["styles.RKayamori01.skillLevels.SkBase"]["to"], 10)
        self.assertEqual(by_id["styles.RKayamori02.skillLevels.SkBase"]["to"], 10)

    def test_partial_or_missing_parts_stay_unknown(self):
        by_id = self.preview([{"_masterAbilityTreeId": 38110102, "_count": 2}], skills=[(901, 0, 0), (900, 0, 0)])
        self.assertNotIn("styles.RKayamori01.training.Skill", by_id)
        self.assertNotIn("styles.RKayamori01.training.Part1", by_id)  # 缺分区
        self.assertNotIn("styles.RKayamori01.skillLevels.SkOwn", by_id)
        self.assertEqual(by_id["styles.RKayamori01.skillLevels.SkBase"]["to"], 1)

    def test_skill_row_missing_or_over_cap_skipped(self):
        parts = [{"_masterAbilityTreeId": 38110102, "_count": 3}, {"_masterAbilityTreeId": 38110103, "_count": 2}]
        self.assertFalse(any("skillLevels" in k for k in self.preview(parts)))
        by_id = self.preview(parts, skills=[(901, 7, 1)])
        self.assertNotIn("styles.RKayamori01.skillLevels.SkOwn", by_id)

    def test_existing_values_and_direction(self):
        parts = [{"_masterAbilityTreeId": 38110102, "_count": 3}, {"_masterAbilityTreeId": 38110103, "_count": 2}]
        archive = {"styles": {"RKayamori01": {"owned": True, "skillLevels": {"SkOwn": 9, "SkBase": 7},
                                              "training": {"Skill": ["s3", "s1", "s2"]}}}}
        by_id = self.preview(parts, skills=[(901, 2, 2), (900, 4, 2)], archive=archive)
        self.assertEqual(by_id["styles.RKayamori01.skillLevels.SkOwn"]["direction"], "down")
        self.assertNotIn("styles.RKayamori01.skillLevels.SkBase", by_id)
        self.assertNotIn("styles.RKayamori01.training.Skill", by_id)  # 顺序不同但集合相同


class EndpointTests(unittest.TestCase):
    def test_preview_endpoint_reads_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "_bcdb0_"
            write_cache(cache)
            before = {p.name: p.read_bytes() for p in cache.iterdir()}
            app = hbr_app.build_app(Path(tmp) / "data", port=0)
            app.cache_dir = cache
            url = app.start()
            try:
                req = urllib.request.Request(url.rstrip("/") + "/api/cache-import/preview",
                                             data=json.dumps({"archive": {}}).encode(),
                                             headers={"X-WB-Token": app.token, "Content-Type": "application/json",
                                                      "Origin": url.rstrip("/")})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
            finally:
                app.stop()
            self.assertTrue(body["ok"])
            self.assertEqual(body["cards_in_cache"], 3)
            self.assertEqual({p.name: p.read_bytes() for p in cache.iterdir()}, before)
            self.assertFalse((Path(tmp) / "data" / "archive.json").exists())


DECK_MEMBERS = [
    {"_deckIndex": 1, "_masterCharacterId": 4000011, "_masterCardId": 1001105, "_masterSkillIds": [46001102, 0, 0],
     "_earringAccessoryId": 7, "_necklaceAccessoryId": 8, "_ringAccessoryId": 0, "_supportCardId": 1001101},
    {"_deckIndex": 0, "_masterCharacterId": 4000011, "_masterCardId": 1001101, "_masterSkillIds": [],
     "_earringAccessoryId": 0, "_necklaceAccessoryId": 0, "_ringAccessoryId": 0, "_supportCardId": 0},
]
DECK_SLOTS = [{"_deckIndex": 1, "_slotIndex": i, "_characterId": 4000011 if i == 0 else 0, "_characterSlotType": 0} for i in range(6)]
DECK_META = {"_partyNameList": ["空", "测试队"], "_currentDeckIndex": 1, "_latestBattleDeckIndex": -1}
ACCESSORIES = [
    {"_id": 7, "_masterAccessoryId": 5021003, "_plusCount": 0, "_mainAbilityEffectList": [42600203], "_expansionAbilityEffectList": [42400011]},
    {"_id": 8, "_masterAccessoryId": 5030001, "_plusCount": 0, "_mainAbilityEffectList": [], "_expansionAbilityEffectList": []},
]


class DeckTests(unittest.TestCase):
    def write(self, folder: Path):
        write_cache(folder)
        (folder / "DK01").write_bytes(hbr_cache.encode(json.dumps(DECK_MEMBERS).encode()))
        (folder / "DK02").write_bytes(hbr_cache.encode(json.dumps(DECK_SLOTS).encode()))
        (folder / "DK03").write_bytes(hbr_cache.encode(json.dumps(DECK_META, ensure_ascii=False).encode()))  # 对象文件
        (folder / "DK04").write_bytes(hbr_cache.encode(json.dumps(ACCESSORIES).encode()))

    def test_object_files_are_read_and_decks_assembled(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "_bcdb0_"
            self.write(cache)
            self.assertEqual(hbr_cache.encode(b"{}")[:1], b"\xf7")
            result = hbr_cache.decks_from_cache(CATALOG, cache)
        self.assertEqual(result["missing_tables"], [])
        self.assertEqual([d["index"] for d in result["decks"]], [1])  # 第 0 套全空，跳过
        deck = result["decks"][0]
        self.assertEqual(deck["name"], "测试队")
        self.assertTrue(deck["current"])
        member = deck["members"][0]
        self.assertEqual(member["styleId"], "RKayamori05")
        self.assertEqual(member["skillIds"], [46001102])
        self.assertEqual(member["limitBreak"], 3)
        self.assertEqual(member["tearLevel"], 1)
        self.assertEqual(member["supportStyleId"], "RKayamori01")
        self.assertEqual(member["accessories"]["earring"], {"masterId": 5021003, "main": [42600203], "expansion": [42400011], "plus": 0})
        self.assertEqual(member["character"]["level"], 180)
        self.assertEqual(member["character"]["reincarnation"], 5)
        self.assertEqual(member["card"]["level"], 15)
        self.assertEqual(member["supportLimitBreak"], 20)
        self.assertEqual({c["styleId"] for c in member["characterCards"]}, {"RKayamori01", "RKayamori05"})
        self.assertNotIn("ring", member["accessories"])
        self.assertIsNone(deck["members"][1])

    def test_decks_endpoint_reads_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "_bcdb0_"
            self.write(cache)
            before = {p.name: p.read_bytes() for p in cache.iterdir()}
            app = hbr_app.build_app(Path(tmp) / "data", port=0)
            app.cache_dir = cache
            url = app.start()
            try:
                req = urllib.request.Request(url.rstrip("/") + "/api/cache-decks",
                                             headers={"X-WB-Token": app.token, "Origin": url.rstrip("/")})
                with urllib.request.urlopen(req, timeout=10) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
            finally:
                app.stop()
            self.assertTrue(body["ok"])
            self.assertEqual(len(body["decks"]), 1)
            self.assertEqual({p.name: p.read_bytes() for p in cache.iterdir()}, before)


if __name__ == "__main__":
    unittest.main()
