import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('build_stats', ROOT / 'scripts' / 'build-stats.py')
bst = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bst)

STYLES = [{'id': 1001, 'tier': 'SS', 'skills': [{'id': 1}], 'resonance': 'SupportSkill_X01',
           'base_param': {'str': 40, 'dex': 30, 'con': 0, 'spr': 0, 'wis': 0, 'luk': 0, 'dp': 70, 'hp': 0},
           'limit_break': {'stat_up_per_level': 10, 'bonus_per_level': [
               {'step': 0, 'bonus': []}, {'step': 4, 'bonus': [{'category': 'Ability', 'type': 'ParamAllOtherCard', 'value': [10, 0]}]}]},
           'ability_tree': [{'label': 'P0', 'ability_list': [{'type': 'Skill', 'value': [0, 0]}]},
                            {'label': 'P1', 'ability_list': [{'type': 'ParamAll', 'value': [15, 0], 'value_type': 'Addition', 'is_exclusive': True},
                                                              {'type': 'Power', 'value': [10, 0], 'value_type': 'Ratio', 'is_exclusive': True},
                                                              {'type': 'Wisdom', 'value': [1, 0], 'value_type': 'RealNumber', 'is_exclusive': False}]}]}]
CHARS = [{'label': 'C1', 'base_param': {'level': [1, 200], 'str': [8, 212]}}]
LATENTS = [{'id': 9, 'label': 'L.U', 'name': '固有', 'unique': True, 'effects': [{'type': 'Power', 'value': [20, 0]}, {'type': 'Dexterity', 'value': [20, 0]}]},
           {'id': 10, 'label': 'L.P', 'name': '心得', 'unique': False, 'effects': [{'type': 'PassiveSkill', 'skill': {
               'label': 'Passive.L', 'name': '心得', 'timing': 'OnFirstBattleStart', 'parts': [{'skill_type': 'AttackUp', 'target_type': 'Self', 'power': [0.1, 0],
                                                                                          'effect': {'exitCond': 'Eternal', 'exitVal': [0, 0]}}]}}]}]
SKILLS = [{'id': 1, 'label': 'S1', 'parts': [{'skill_type': 'AttackSkill'}]},
          {'id': 46511101, 'label': 'Masterly', 'name': '記憶', 'desc': '全能力', 'parts': [{'skill_type': 'MemorySpirit', 'target_type': 'Self', 'dv': 20,
                                                                                           'power': [0, 0], 'effect': {'exitCond': 'Eternal'}}],
           'passive': {'timing': 'OnFirstBattleStart', 'condition': ''}}]
ACCESSORIES = [{'label': 'Acc.Orb', 'skill': [{'id': 46300007, 'label': 'Orb', 'name': 'ポイントケア', 'parts': [{'skill_type': 'HealSp', 'power': [3, 0]}]}]}]
CATALOG = {'styles': [{'id': 'X01', 'sourceId': 1001, 'skills': [], 'passives': []}], 'characters': [{'id': 'C1'}]}


class BuildStatsTest(unittest.TestCase):
    def test_build(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            paths = {}
            for name, data in (('styles', STYLES), ('chars', CHARS), ('latents', LATENTS), ('acc', ACCESSORIES), ('skills', SKILLS)):
                paths[name] = d / f'{name}.json'
                paths[name].write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
            sup = d / 'support.json'
            sup.write_text(json.dumps([{'label': 'SupportSkill_X01', 'list': [{'lb_lv': 4, 'passive': {'label': 'Passive.Sup', 'name': '共鳴', 'timing': 'OnEveryTurn',
                'condition': 'IsFront()', 'parts': [{'skill_type': 'OverDrivePointUp', 'target_type': 'Self', 'power': [0.1, 0]}]}}]}], ensure_ascii=False), encoding='utf-8')
            out = bst.build(paths['styles'], paths['chars'], paths['latents'], paths['acc'], paths['skills'], CATALOG, sup)
        s = out['styles']['X01']
        self.assertEqual(s['base']['str'], 40)
        self.assertEqual(s['statUpPerLb'], 10)
        self.assertEqual(s['lbMax'], 4)
        self.assertEqual(s['resonance'], 'SupportSkill_X01')
        self.assertEqual(out['supportSkills']['SupportSkill_X01'][0]['lb'], 4)
        self.assertEqual(out['supportSkills']['SupportSkill_X01'][0]['passive']['parts'][0]['skillType'], 'OverDrivePointUp')
        self.assertTrue(s['basic'])
        self.assertEqual(s['tree'][1], [{'t': 'all', 'v': 15, 'k': 'add'}, {'t': 'str', 'v': 10, 'k': 'ratio'}, {'t': 'wis', 'v': 1, 'k': 'shared'}])
        self.assertEqual(s['tree'][0], [{'t': 'Skill'}])
        self.assertEqual(out['characters']['C1']['str'], [8, 212])
        self.assertEqual(out['latents']['9']['stats'], {'str': 20, 'dex': 20})
        self.assertEqual(out['latents']['10']['passives'][0]['parts'][0]['skillType'], 'AttackUp')
        self.assertIn('46300007', out['extraSkills'])
        self.assertNotIn('1', out['extraSkills'])  # 卡面技能不重复收录
        m = out['extraSkills']['46511101']['passive']
        self.assertEqual(m['parts'][0]['skillType'], 'MemorySpirit')
        self.assertEqual(m['parts'][0]['dv'], 20)


if __name__ == '__main__':
    unittest.main()
