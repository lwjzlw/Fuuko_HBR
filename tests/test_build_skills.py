import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('build_skills', ROOT / 'scripts' / 'build-skills.py')
bs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bs)


def part(**kw):
    base = {'label': 'P', 'skill_type': 'AttackSkill', 'target_type': 'Single', 'type': 'Slash', 'elements': ['Fire'],
            'power': [100.0, 200.0], 'value': [0, 0], 'strval': [-1, -1], 'cond': '', 'multipliers': {'dp': 1.0, 'hp': 1.3, 'dr': 1.5},
            'diff_for_max': 120, 'parameters': {'str': 2, 'wis': 0, 'dex': 1}, 'growth': [0.05, 0.02], 'hits': [],
            'hit_condition': '', 'target_condition': '', 'effect': {'ir': False, 'limitType': 'None', 'exitCond': 'None', 'exitVal': [0, 0]}}
    base.update(kw)
    return base


SUB = {'id': 2, 'label': 'Sub', 'name': '分岐', 'desc': '', 'hit_count': 1, 'target_type': 'Single', 'consume_type': 'Sp',
       'is_restricted': 1, 'use_count': -1, 'sp_cost': 5, 'max_level': 10, 'parts': [part()], 'hits': []}
SKILL = {'id': 1, 'label': 'X01', 'name': 'クロス', 'desc': 'JA', 'hit_count': 2, 'target_type': 'Single', 'consume_type': 'Sp',
         'is_restricted': 0, 'use_count': [4, 5], 'sp_cost': 6, 'max_level': 10, 'cond': '', 'interval_turn': 0,
         'parts': [part(), part(skill_type='SkillCondition', strval=[SUB, -1, 3], cond='IsFront()')],
         'hits': [{'id': 1, 'type': 'Main', 'power_ratio': 0.3}, {'id': 2, 'type': 'Main', 'power_ratio': 0.7}]}
BASE_PASSIVE = {'id': 10, 'label': 'Passive.Base', 'name': 'base', 'desc': '', 'timing': 'OnOverdriveStart', 'condition': '',
                'activ_rate': 0, 'limit': 0, 'parts': [part(skill_type='DamageUpByOverDrive', effect={'exitCond': 'OverDriveEnd', 'exitVal': [1, 0]})]}
LB_PASSIVE = {'id': 999, 'label': 'Passive.LB', 'name': '疾風', 'desc': '', 'timing': 'OnBattleStart', 'condition': 'IsFront()',
              'activ_rate': 0, 'limit': 0, 'parts': [part(skill_type='AttackUp', effect={'exitCond': 'PlayerTurnEnd', 'exitVal': [3, 0]})]}
STYLES = [{'id': 1001, 'skills': [SKILL], 'passives': [BASE_PASSIVE]}, {'id': 4040, 'skills': [], 'passives': []}]
CATALOG = {'styles': [{'id': 'X01', 'sourceId': 1001, 'skills': [{'sourceId': 1, 'name': '十字斬', 'description': '中文'}],
                       'passives': [{'id': 'Passive.Base', 'name': '[OD]'}, {'id': 'Passive.LB', 'name': '疾風', 'description': '開場', 'step': 5, 'source': 'limitBreak'}]}],
           'characters': []}


class BuildSkillsTest(unittest.TestCase):
    def build(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / 'styles.json').write_text(json.dumps(STYLES, ensure_ascii=False), encoding='utf-8')
            (d / 'catalog.json').write_text(json.dumps(CATALOG, ensure_ascii=False), encoding='utf-8')
            (d / 'passives.json').write_text(json.dumps([LB_PASSIVE], ensure_ascii=False), encoding='utf-8')
            (d / 'sst.json').write_text(json.dumps([{'id': 20, 'name': 'AdditionalTurn'}]), encoding='utf-8')
            return bs.build(d / 'styles.json', d / 'sst.json', d / 'catalog.json', d / 'passives.json')

    def test_structured_parts_and_names(self):
        out = self.build()
        self.assertEqual(out['source']['unmatchedStyles'], 1)
        self.assertEqual(out['statusTypes'], {'20': 'AdditionalTurn'})
        sk = out['styles']['X01']['skills'][0]
        self.assertEqual(sk['name'], '十字斬')
        self.assertEqual(sk['nameJa'], 'クロス')
        self.assertEqual(sk['uses'], [4, 5])
        self.assertEqual([h['ratio'] for h in sk['hits']], [0.3, 0.7])
        p = sk['parts'][0]
        self.assertEqual(p['parameters'], {'str': 2, 'dex': 1})  # zero weights dropped
        self.assertEqual(p['diffForMax'], 120)
        self.assertEqual(p['multipliers']['dr'], 1.5)
        self.assertNotIn('exit', p)  # None exit omitted

    def test_branches_keep_sub_skills_and_extra_strval(self):
        sk = self.build()['styles']['X01']['skills'][0]
        cond = sk['parts'][1]
        self.assertEqual(cond['skillType'], 'SkillCondition')
        self.assertEqual(cond['cond'], 'IsFront()')
        self.assertEqual(cond['branches'][0]['label'], 'Sub')
        self.assertTrue(cond['branches'][0]['restricted'])
        self.assertEqual(cond['strval'], [3])

    def test_limit_break_passives_resolved_by_label(self):
        pas = self.build()['styles']['X01']['passives']
        self.assertEqual([p['label'] for p in pas], ['Passive.Base', 'Passive.LB'])
        lb = pas[1]
        self.assertEqual(lb['step'], 5)
        self.assertEqual(lb['condition'], 'IsFront()')
        self.assertEqual(lb['parts'][0]['exit'], {'cond': 'PlayerTurnEnd', 'value': [3, 0]})

    def test_transcend_element_from_role_ability(self):
        self.assertEqual(bs.transcend_element({'name': '氷の律動', 'desc': 'バトル開始時 超越ゲージ(氷)を得る'}), 'ice')
        self.assertEqual(bs.transcend_element({'name': '雷の律動', 'desc': 'バトル開始時 超越ゲージ(雷)を得る'}), 'thunder')
        self.assertIsNone(bs.transcend_element({'name': 'x', 'desc': '攻撃力アップ'}))
        self.assertIsNone(bs.transcend_element(None))


if __name__ == '__main__':
    unittest.main()
