"""Build public/data/stats.json：面板推算用的主数据（hbr.quest 公开数据，只读）。

内容：
  characters: {charId: {level:[1,200], str:[lv1,lv200], ... , dp, hp}}
  styles:     {styleId: {tier, base:{str..luk,dp,hp}（风格加成%）, statUpPerLb, lbMax, basic（基本衣装：完凸给同角色其他卡 ParamAllOtherCard）,
               tree:[[{t,v}]...]（能力树各分区节点，按公开顺序）, lbBonus:[{step,t,v}]（完凸等的能力加成）}}
  latents:    {latentSourceId: {id, unique, stats:{str..}（固有：固定加值）, passive（普通：被动技能部件，供战斗用）}}
  extraSkills:{skillId: 技能}（编队里可装的非卡面技能：宝珠、大师技能等，部件格式同 skills.json）

用法：python scripts/build-stats.py [--research DIR] [--out PATH]
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESEARCH = ROOT / 'work' / 'catalog-research'
STAT_KEY = {'Power': 'str', 'Dexterity': 'dex', 'Toughness': 'con', 'Spirit': 'spr', 'Wisdom': 'wis', 'Luck': 'luk', 'Dp': 'dp', 'Hp': 'hp',
            'ParamAll': 'all', 'ParamAllOtherCard': 'allOther'}

spec = importlib.util.spec_from_file_location('build_skills', ROOT / 'scripts' / 'build-skills.py')
bs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bs)


def newest(name: str) -> Path | None:
    hits = sorted(RESEARCH.glob(f'*/{name}'), key=lambda p: p.stat().st_mtime, reverse=True)
    return hits[0] if hits else None


def stat_nodes(items: list) -> list:
    out = []
    for a in items or []:
        k = STAT_KEY.get(a.get('type'))
        if k:
            # value_type：Ratio=风格加成%，Addition=本卡专属固定值，RealNumber(非专属)=角色共享基础值
            kind = 'ratio' if a.get('value_type') == 'Ratio' else ('add' if a.get('is_exclusive') else 'shared')
            out.append({'t': k, 'v': (a.get('value') or [0])[0], 'k': kind})
        else:
            out.append({'t': a.get('type')})  # 技能/被动等非能力节点，占位以保持顺序
    return out


def compact_extra(k: dict) -> dict:
    """非卡面技能；被动型（大师技能等）的效果部件在技能本体上，合并成可直接触发的被动。"""
    out = bs.compact_skill({**k, 'passive': None}, {})
    if isinstance(k.get('passive'), dict):
        out['passive'] = bs.compact_passive({**k['passive'], 'id': k.get('id'), 'label': k.get('label'), 'name': k.get('name'),
                                             'desc': k.get('desc'), 'parts': k.get('parts')}, {})
        for part, raw in zip(out['passive']['parts'], k.get('parts') or []):
            if raw.get('dv'):
                part['dv'] = raw['dv']
    return out


def build(styles_path: Path, chars_path: Path, latents_path: Path, accessories_path: Path | None, skills_path: Path | None, catalog: dict,
          support_path: Path | None = None) -> dict:
    raw_styles = json.loads(styles_path.read_text(encoding='utf-8'))
    raw_chars = json.loads(chars_path.read_text(encoding='utf-8'))
    by_source = {s['sourceId']: s for s in catalog['styles']}
    char_by_label = {c['id']: c for c in catalog['characters']}
    characters = {}
    for c in raw_chars:
        if c.get('label') in char_by_label:
            bp = c.get('base_param') or {}
            characters[c['label']] = {k: bp.get(k) for k in ('level', 'str', 'dex', 'con', 'spr', 'wis', 'luk', 'dp', 'hp')}
    styles = {}
    for s in raw_styles:
        cat = by_source.get(s.get('id'))
        if not cat:
            continue
        lb = s.get('limit_break') or {}
        steps = lb.get('bonus_per_level') or []
        bonus = []
        for b in steps:
            for x in b.get('bonus') or []:
                k = STAT_KEY.get(x.get('type'))
                if x.get('category') == 'Ability' and k:
                    bonus.append({'step': b.get('step'), 't': k, 'v': (x.get('value') or [0])[0]})
        styles[cat['id']] = {
            'tier': s.get('tier'),
            'base': {k: (s.get('base_param') or {}).get(k, 0) for k in ('str', 'dex', 'con', 'spr', 'wis', 'luk', 'dp', 'hp')},
            'statUpPerLb': lb.get('stat_up_per_level', 0),
            'lbMax': max([b.get('step', 0) for b in steps] or [0]),
            'basic': any(x['t'] == 'allOther' for x in bonus),
            'tree': [stat_nodes(p.get('ability_list')) for p in (s.get('ability_tree') or [])],
            'treeLabels': [p.get('label') for p in (s.get('ability_tree') or [])],
            'lbBonus': bonus,
            # 作为支援卡时的共鸣特性组（support_skills.json 的 label；部队号或 SupportSkill_XXX）
            'resonance': s.get('resonance') or None,
        }
    latents = {}
    for la in json.loads(latents_path.read_text(encoding='utf-8')):
        stats = {}
        passive = []
        for e in la.get('effects') or []:
            k = STAT_KEY.get(e.get('type'))
            if k and k not in ('all', 'allOther'):
                stats[k] = stats.get(k, 0) + (e.get('value') or [0])[0]
            elif e.get('type') == 'PassiveSkill' and e.get('skill'):
                passive.append(bs.compact_passive(e['skill'], {}))
        latents[str(la['id'])] = {'label': la.get('label'), 'name': la.get('name'), 'unique': bool(la.get('unique')), 'stats': stats, 'passives': passive}
    extra = {}
    style_skill_ids = {k['id'] for s in raw_styles for k in s.get('skills') or []}
    if skills_path and skills_path.exists():
        for k in json.loads(skills_path.read_text(encoding='utf-8')):
            if k.get('id') not in style_skill_ids and k.get('parts'):
                extra[str(k['id'])] = compact_extra(k)
    if accessories_path and accessories_path.exists():
        for a in json.loads(accessories_path.read_text(encoding='utf-8')):
            for k in a.get('skill') or []:
                if isinstance(k, dict) and k.get('id') and str(k['id']) not in extra and k.get('parts'):
                    extra[str(k['id'])] = {**compact_extra(k), 'orb': a.get('label')}
    # 支援共鸣特性：{组 label: [{lb, passive}]}，按支援卡突破数取 lb ≤ 突破数 的最后一档
    support = {}
    if support_path and support_path.exists():
        for g in json.loads(support_path.read_text(encoding='utf-8')):
            support[g['label']] = [{'lb': e.get('lb_lv', 0), 'passive': bs.compact_passive(e['passive'], {})}
                                   for e in g.get('list') or [] if e.get('passive')]
    return {'schemaVersion': 1, 'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
            'characters': characters, 'styles': styles, 'latents': latents, 'extraSkills': extra, 'supportSkills': support}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--styles', type=Path, default=newest('styles.json'))
    ap.add_argument('--characters', type=Path, default=newest('characters.json'))
    ap.add_argument('--latents', type=Path, default=newest('latent_abilities.json'))
    ap.add_argument('--accessories', type=Path, default=newest('accessories.json'))
    ap.add_argument('--skills', type=Path, default=RESEARCH / '20261107-boss' / 'skills.json')
    ap.add_argument('--support-skills', type=Path, default=newest('support_skills.json'))
    ap.add_argument('--catalog', type=Path, default=ROOT / 'public' / 'data' / 'catalog.json')
    ap.add_argument('--out', type=Path, default=ROOT / 'public' / 'data' / 'stats.json')
    a = ap.parse_args(argv)
    for p in (a.styles, a.characters, a.latents):
        if not p or not p.exists():
            print(f'缺少主数据：{p}', file=sys.stderr)
            return 2
    data = build(a.styles, a.characters, a.latents, a.accessories, a.skills, json.loads(a.catalog.read_text(encoding='utf-8')), a.support_skills)
    tmp = a.out.with_suffix('.part')
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    tmp.replace(a.out)
    print(json.dumps({'characters': len(data['characters']), 'styles': len(data['styles']), 'latents': len(data['latents']),
                      'extraSkills': len(data['extraSkills']), 'supportSkills': len(data['supportSkills']), 'bytes': a.out.stat().st_size}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
