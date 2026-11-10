import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('build_bosses', ROOT / 'scripts' / 'build-bosses.py')
bb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bb)

PART = {'label': 'P', 'skill_type': 'AttackUp', 'target_type': 'Self', 'type': None, 'elements': [], 'power': [0.3, 0.0],
        'value': [0, 0], 'parameters': {'str': 0, 'con': 2}, 'multipliers': {'dp': 1.0, 'hp': 0.0}, 'hits': [],
        'target_condition': '', 'effect': {'exitCond': 'Eternal', 'exitVal': [0, 0]}}
RULE = {'id': 7, 'label': 'scoreAttackRule_1', 'type': 'SkillPart', 'target': 'Enemy', 'timing': ['OnEveryTurn'],
        'parts': [PART], 'interval': 3, 'term': 10, 'name': '攻撃力アップ', 'desc': 'JA', 'grade': 35,
        'in_date': '2026-10-16 02:00:00+00:00', 'out_date': '2026-10-23 01:59:59+00:00'}
BATTLE = {'id': 1, 'label': 'scoreAttackBattle_40_1', 'd': 40, 'dn': 'アビス', 'ds': 700000, 'rs': 1, 'b': ['Boss_a'],
          'bn': [{'n': 'ボス', 'd': [6, 700]}], 'btl': 'B', 'dl': [1730000, 0, 0], 'hl': [155000000, 0, 0], 'al': [3.5, 0, 0],
          'rbl': [790, 0, 0], 'db': 18568569, 'nbb': 150000, 'mtb': 0, 'tl': 30}
SA = [{'id': 145000001, 'label': 'scoreAttack1', 'name': '#1', 'score_calc': {'tmdc': 0.013, 'calc_ver': 2},
       'max_rules': 1, 'bonus': [], 'rules': [RULE], 'battles': [BATTLE]}]
ENEMY = {'id': 9, 'label': 'Boss_a', 'name': 'ボス', 'base_param': {'dp': 1, 'hp': 2, 'd_rate': 6, 'max_d_rate': 700},
         'flags': {'is_boss': True, 'is_rare': False}, 'resistances': {'element': {'fire': -150}},
         'skills': [{'id': 100, 'label': 'Boss_Attack', 'name': '', 'hit_count': 2, 'target_type': 'All',
                     'parts': [dict(PART, skill_type='AttackSkill', type='Strike')],
                     'hits': [{'power_ratio': 0.4}, {'power_ratio': 0.6}]}],
         'pattern': {'dp': {'l': 'L', 'p': [{'id': 2, 'order': 2, 'weight': 100, 'skill_list': [100]},
                                            {'id': 1, 'order': 1, 'weight': 100, 'is_preemptive': True, 'skill_list': [100]}]}}}
ZH = {'enemy': {'name': {'Boss_a': '頭目'}}, 'skill': {'name': {'Boss_Attack': '重擊'}},
      'scoreattackrule': {'battledescription': {'scoreAttackRule_1': '攻擊力上升'}, 'rulename': {'scoreAttackRule_1': '每3回合敵人攻擊力上升'}},
      'scoreattackbattle': {'difficultyname': {'scoreAttackBattle_40_1': '深淵級'}}}


class BuildBossesTest(unittest.TestCase):
    def test_normalisers(self):
        with tempfile.TemporaryDirectory() as d:
            zp = Path(d) / 'zh.json'
            zp.write_text(json.dumps(ZH, ensure_ascii=False), encoding='utf-8')
            zh = bb.Zh(zp)
        stage = bb.norm_stage(BATTLE, 'main', zh)
        self.assertEqual(stage['difficultyName'], '深淵級')
        self.assertEqual(stage['enemies'], [{'label': 'Boss_a', 'name': '頭目', 'dp': 1730000, 'hp': 155000000,
                                             'attackRate': 3.5, 'paramBorder': 790, 'destruction': [6, 700]}])
        rule = bb.norm_rule(RULE, zh)
        self.assertEqual((rule['name'], rule['desc'], rule['nameJa']), ('攻擊力上升', '每3回合敵人攻擊力上升', '攻撃力アップ'))
        self.assertEqual(rule['parts'][0]['parameters'], {'con': 2})
        self.assertEqual(rule['parts'][0]['exit'], {'cond': 'Eternal', 'value': [0, 0]})
        enemy = bb.norm_enemy(ENEMY, zh)
        self.assertEqual(enemy['name'], '頭目')
        self.assertEqual(enemy['flags'], {'is_boss': True})
        self.assertEqual(enemy['skills'][0]['name'], '重擊')
        self.assertEqual(enemy['skills'][0]['hitRatios'], [0.4, 0.6])
        entries = enemy['pattern']['dp']['entries']
        self.assertEqual([e['order'] for e in entries], [1, 2])
        self.assertTrue(entries[0]['preemptive'])

    def test_offline_build_writes_index_and_event(self):
        with tempfile.TemporaryDirectory() as d:
            raw, out = Path(d) / 'raw', Path(d) / 'out'
            (raw / 'enemies').mkdir(parents=True)
            (raw / 'score_attack.json').write_text(json.dumps(SA), encoding='utf-8')
            (raw / 'dimension_battle.json').write_text('[]', encoding='utf-8')
            (raw / 'enemies' / 'Boss_a.json').write_text(json.dumps(ENEMY), encoding='utf-8')
            zp = Path(d) / 'zh.json'
            zp.write_text(json.dumps(ZH, ensure_ascii=False), encoding='utf-8')
            code = bb.main(['--raw-dir', str(raw), '--out', str(out), '--zh', str(zp), '--offline', '--delay', '0'])
            self.assertEqual(code, 0)
            index = json.loads((out / 'index.json').read_text(encoding='utf-8'))
            self.assertEqual(len(index['events']), 1)
            ev_meta = index['events'][0]
            self.assertEqual((ev_meta['kind'], ev_meta['bosses'], ev_meta['withActions']), ('scoreAttack', ['頭目'], 1))
            self.assertEqual(ev_meta['inDate'], '2026-10-16 02:00:00+00:00')
            ev = json.loads((out / ev_meta['file']).read_text(encoding='utf-8'))
            self.assertIn('Boss_a', ev['enemies'])
            self.assertEqual(ev['stages'][0]['damageCap'], 18568569)
            self.assertEqual(index['missingDetail'], [])

    def test_offline_build_fails_without_tables(self):
        with tempfile.TemporaryDirectory() as d:
            code = bb.main(['--raw-dir', str(Path(d) / 'none'), '--out', str(Path(d) / 'o'), '--offline', '--zh', str(Path(d) / 'z.json')])
            self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()
