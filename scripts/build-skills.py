"""Build the battle-skill table used by the timeline planner (排轴器).

Source: hbr.quest master data `styles.json` (public, read-only), already cached by
the catalog refresh under work/catalog-research/<date>/, plus `special_status_types.json`.
Chinese names come from public/data/catalog.json (same sourceId).

Output: public/data/skills.json
  {schemaVersion, generatedAt, source, statusTypes:{id:name},
   styles:{<catalog style id>:{skills:[...], passives:[...]}}}

Every skill keeps its structured parts (skillType, power, value, parameters, diffForMax,
growth, multipliers, conditions, exit) so the simulator interprets data instead of text.

Usage:
  python scripts/build-skills.py [--styles PATH] [--status-types PATH] [--out PATH]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESEARCH = ROOT / 'work' / 'catalog-research'


def newest(name: str) -> Path | None:
    hits = sorted(RESEARCH.glob(f'*/{name}'), key=lambda p: p.stat().st_mtime, reverse=True)
    return hits[0] if hits else None


def branch_condition(label: str, caption: str, siblings: list[dict]) -> str | None:
    """hbr.quest flattens nested conditions; each leaf carries its original Japanese rank caption."""
    m = re.fullmatch(r'使用回数(\d+)回目(以降)?', caption)
    if m:
        return f'PlayedSkillCount({label}) {">=" if m[2] else "=="} {int(m[1]) - 1}'
    m = re.fullmatch(r'士気(\d+)(?:[〜～](\d+))?', caption)
    if m:
        return f'MoraleLevel() >= {m[1]} && MoraleLevel() <= {m[2] or m[1]}'
    ranks = ['絶不調', '不調', '普通', '好調', '絶好調']
    if label == 'RKayamoriSkill57' and caption in ranks:
        return f'MotivationLevel() == {ranks.index(caption) + 1}'
    m = re.fullmatch(r'好調以上の味方：(\d+)人', caption)
    if m:
        return f'CountBC(IsPlayer() && MotivationLevel() >= 4) {">=" if m[1] == "3" else "=="} {m[1]}'
    for pattern, expr in [(r'敵(\d+)体', 'CountBC(IsPlayer()==0 && IsDead()==0)'),
                          (r'下僕(\d+)人', 'CountBC(IsPlayer() && SpecialStatusCountByType(155)>0)'),
                          (r'トークン(\d+)', 'Token()')]:
        m = re.fullmatch(pattern, caption)
        if m:
            return f'{expr} == {m[1]}'
    elements = {'火属性': 'Fire', '氷属性': 'Ice', '雷属性': 'Thunder', '光属性': 'Light', '闇属性': 'Dark'}
    if label.startswith('IIshiiSkill'):
        if caption in elements:
            return f'IsZone({elements[caption]})'
        if caption == '元素属性フィールド無し':
            return 'IsZone(None)'
        if caption == '無属性':
            has_separate_none = any(b.get('desc') == '元素属性フィールド無し' for b in siblings)
            return 'IsZone(Nonelemental)' if has_separate_none else 'IsZone(Nonelemental) || IsZone(None)'
    if caption.endswith('_リベンジレベル10'):
        return 'RevengeLevel() >= 10'
    if caption.endswith('_リベンジレベル9以下'):
        return 'RevengeLevel() < 10'
    if caption in ('追加ターン中', '非追加ターン中'):
        return f'IsAdditionalTurn() == {int(caption == "追加ターン中")}'
    return None


def compact_part(p: dict) -> dict:
    eff = p.get('effect') or {}
    out = {
        'skillType': p.get('skill_type'),
        'targetType': p.get('target_type'),
        'power': p.get('power') or [0, 0],
        'value': p.get('value') or [0, 0],
    }
    if p.get('type'):
        out['attackType'] = p['type']
    if p.get('elements'):
        out['elements'] = p['elements']
    if p.get('diff_for_max'):
        out['diffForMax'] = p['diff_for_max']
    params = {k: v for k, v in (p.get('parameters') or {}).items() if v}
    if params:
        out['parameters'] = params
    if p.get('growth') and any(p['growth']):
        out['growth'] = p['growth']
    mult = p.get('multipliers') or {}
    if any(mult.values()):
        out['multipliers'] = mult
    for src, dst in (('cond', 'cond'), ('target_condition', 'targetCondition'), ('hit_condition', 'hitCondition')):
        if p.get(src):
            out[dst] = p[src]
    if p.get('hits'):
        out['hits'] = [{'type': h.get('type'), 'ratio': h.get('power_ratio')} for h in p['hits']]
    if p.get('dv'):
        out['dv'] = p['dv']
    if p.get('sstl'):
        out['sstl'] = p['sstl']
    if eff.get('exitCond') and eff['exitCond'] != 'None':
        out['exit'] = {'cond': eff['exitCond'], 'value': eff.get('exitVal') or [0, 0]}
    if eff.get('limitType') and eff['limitType'] != 'None':
        out['limitType'] = eff['limitType']
    if eff.get('ir'):
        out['irremovable'] = True
    if p.get('skill_type') == 'ExecuteSkillOnPreTurn' and p.get('sv'):
        # The public style points to a skill outside the equippable skills list.
        # Its complete revive effect is specified by the public skill_templates
        # entry for Tama Session and the corresponding zhTW skill description.
        triggered = {'label': p['sv']}
        if p['sv'] == 'MAikawaSkill07':
            triggered.update(name='炸裂！貝斯獨奏', parts=[
                {'skillType': 'ReviveDpRate', 'targetType': 'AllyAll', 'power': [0.5, 0]}
            ])
        out['triggeredSkill'] = triggered
    # SkillCondition / SkillSwitch / SkillRandom keep their branch skills in strval
    sv = p.get('strval')
    if isinstance(sv, list) and any(isinstance(x, dict) for x in sv):
        leaves = [s for s in sv if isinstance(s, dict)]
        out['branches'] = [compact_skill(s, {}) for s in leaves]
        if len(leaves) > 2 and out['skillType'] in ('SkillCondition', 'SkillSwitch'):
            conditions = [branch_condition(p['label'], s.get('desc') or '', leaves) for s in leaves]
            if any(conditions):
                out['branchConditions'] = conditions
        if out['skillType'] == 'SkillSwitch':
            modes = {}
            for i, leaf in enumerate(leaves):
                for side in ('a', 'b'):
                    if leaf['label'].startswith(p['label'] + side):
                        modes.setdefault(side, []).append(i)
            if len(modes) == 2 and sum(map(len, modes.values())) == len(leaves):
                out['switchModes'] = modes
        if p.get('label') == 'RMurohushiSkill06' and [b['label'] for b in leaves] == [
                'RMurohushiSkill06aa', 'RMurohushiSkill06ab', 'RMurohushiSkill06ba', 'RMurohushiSkill06bb']:
            # MasterSkillPart defines 50/50 at the root and at both children.
            out['branchWeights'] = [0.25, 0.25, 0.25, 0.25]
        rest = [x for x in sv if not isinstance(x, dict) and x not in (-1, None)]
        if rest:
            out['strval'] = rest
    elif isinstance(sv, list) and any(x not in (-1, None) for x in sv):
        out['strval'] = sv
    return out


def compact_skill(s: dict, zh: dict) -> dict:
    out = {
        'id': s.get('id'),
        'label': s.get('label'),
        'name': zh.get(s.get('id'), {}).get('name') or s.get('name'),
        'nameJa': s.get('name'),
        'desc': zh.get(s.get('id'), {}).get('description') or s.get('desc') or '',
        'sp': s.get('sp_cost', 0),
        'consume': s.get('consume_type'),
        'uses': s.get('use_count', -1),
        'hitCount': s.get('hit_count', 0),
        'targetType': s.get('target_type'),
        'maxLevel': s.get('max_level', 1),
        'restricted': bool(s.get('is_restricted')),
        'parts': [compact_part(p) for p in s.get('parts') or []],
    }
    # Master is_adv: this skill may spend more SP than it has if the starting balance is nonnegative.
    if s.get('consume_type') == 'Sp' and s.get('is_adv'):
        out['allowSpOverdraft'] = True
    if s.get('cond'):
        out['cond'] = s['cond']
    if s.get('iuc_cond'):
        out['useCond'] = s['iuc_cond']
    if s.get('interval_turn'):
        out['interval'] = s['interval_turn']
    if s.get('overwrite') or (s.get('overwrite') == 0 and s.get('overwrite_cond')):
        out['overwrite'] = s['overwrite']
        if s.get('overwrite_cond'):
            out['overwriteCond'] = s['overwrite_cond']
    growth = re.search(r'使用するたびにこのスキルの消費SPが(\d+)増加し\(最大(\d+)\)', s.get('desc') or '')
    if growth:
        out['spPerUse'] = int(growth[1])
        out['spUseCap'] = int(growth[2])
    if s.get('hits'):
        out['hits'] = [{'type': h.get('type'), 'ratio': h.get('power_ratio')} for h in s['hits']]
    if s.get('passive'):
        out['passive'] = compact_passive(s['passive'], {}) if isinstance(s['passive'], dict) else s['passive']
    return out


def compact_passive(p: dict, zh: dict) -> dict:
    meta = zh.get(p.get('id'), {})
    out = {
        'id': p.get('id'),
        'label': p.get('label'),
        'name': meta.get('name') or p.get('name'),
        'desc': meta.get('description') or p.get('desc') or '',
        'timing': p.get('timing'),
        'parts': [compact_part(x) for x in p.get('parts') or []],
    }
    for src, dst in (('condition', 'condition'), ('activ_rate', 'rate'), ('limit', 'limit')):
        if p.get(src):
            out[dst] = p[src]
    if meta.get('step') is not None:
        out['step'] = meta['step']
    if meta.get('source'):
        out['source'] = meta['source']
    return out


_FU = ROOT / 'scripts' / 'followup-hits.json'
FOLLOWUP = json.loads(_FU.read_text(encoding='utf-8')).get('followUpHits', {}) if _FU.exists() else {}
# 社区卡面表的多数值（按武器）：用于表里没有的新卡面
FOLLOWUP_BY_WEAPON = {'Sword': 4, 'Scythe': 4, 'Gun': 1, 'Cannon': 3, 'DoubleSword': 2, 'LargeSword': 2, 'Shield': 3, 'Claw': 3, 'Bike': 1}


TRANSCEND_ELEMENTS = {'火': 'fire', '氷': 'ice', '雷': 'thunder', '光': 'light', '闇': 'dark'}


def transcend_element(roleabi) -> str | None:
    """角色能力描述里的「超越ゲージ(氷)を得る」→ 'ice'；没有则 None。"""
    if not isinstance(roleabi, dict):
        return None
    m = re.search(r'超越ゲージ\((.)\)', roleabi.get('desc') or '')
    return TRANSCEND_ELEMENTS.get(m.group(1)) if m else None


def build(styles_path: Path, status_path: Path | None, catalog_path: Path,
          passives_path: Path | None = None) -> dict:
    raw = json.loads(styles_path.read_text(encoding='utf-8'))
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    by_source = {s['sourceId']: s for s in catalog['styles']}
    # 突破被动不在 styles.json 里，按 label 从 passives.json 补（两边 id 编号体系不同）
    pas_by_label = {}
    if passives_path and passives_path.exists():
        pas_by_label = {p.get('label'): p for p in json.loads(passives_path.read_text(encoding='utf-8'))}
    out_styles: dict[str, dict] = {}
    missing = 0
    unresolved_passives = 0
    for st in raw:
        cat = by_source.get(st.get('id'))
        if not cat:
            missing += 1
            continue
        zh_sk = {k['sourceId']: k for k in cat.get('skills') or []}
        passives = []
        raw_by_label = {p.get('label'): p for p in st.get('passives') or []}
        for meta in cat.get('passives') or []:
            src = raw_by_label.get(meta['id']) or pas_by_label.get(meta['id'])
            if not src:
                unresolved_passives += 1
                continue
            passives.append(compact_passive(src, {src.get('id'): meta}))
        ga = st.get('growth_abi') or {}
        out_styles[cat['id']] = {
            'sourceId': st.get('id'),
            # 泪强化类型（社区计算器 tearEnhancementType）：AttackUp/BuffUp/DebuffUp/CriticalRateUp/HealUp…
            'tearType': ga.get('l') if isinstance(ga, dict) else None,
            # ADMIRAL 角色能力「X の律動：バトル開始時 超越ゲージ(X)を得る」→ 超越量表属性
            'transcend': transcend_element(st.get('roleabi')),
            # 成瀨〈泰然自若的獵人〉「無念無想」：行动选择时可选【没入/沉浸】（用户 2026-11-09 截图提供规则）
            'immersion': '没入' in ((st.get('roleabi') or {}).get('desc') or ''),
            # 武器类型（普攻段数、追击段数按它决定）；追击段数优先用社区卡面表
            'weapon': (st.get('weapon') or {}).get('type'),
            'followUpHits': FOLLOWUP.get(st.get('label')) or FOLLOWUP_BY_WEAPON.get((st.get('weapon') or {}).get('type')),
            'skills': [compact_skill(s, zh_sk) for s in st.get('skills') or []],
            'passives': passives,
        }
    status = {}
    if status_path and status_path.exists():
        status = {str(x['id']): x.get('name') for x in json.loads(status_path.read_text(encoding='utf-8'))}
    digest = hashlib.sha256(styles_path.read_bytes()).hexdigest()
    return {
        'schemaVersion': 1,
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'source': {'styles': 'https://master.hbr.quest/v1/styles.json',
                   'sha256': digest, 'unmatchedStyles': missing, 'unresolvedPassives': unresolved_passives},
        'statusTypes': status,
        'styles': out_styles,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--styles', type=Path, default=newest('styles.json'))
    ap.add_argument('--status-types', type=Path, default=newest('special_status_types.json'))
    ap.add_argument('--passives', type=Path, default=newest('passives.json'))
    ap.add_argument('--catalog', type=Path, default=ROOT / 'public' / 'data' / 'catalog.json')
    ap.add_argument('--out', type=Path, default=ROOT / 'public' / 'data' / 'skills.json')
    a = ap.parse_args(argv)
    if not a.styles or not a.styles.exists():
        print('找不到 styles.json；先刷新公共目录（work/catalog-research/<日期>/styles.json）', file=sys.stderr)
        return 2
    data = build(a.styles, a.status_types, a.catalog, a.passives)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = a.out.with_suffix('.part')
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    tmp.replace(a.out)
    n_sk = sum(len(s['skills']) for s in data['styles'].values())
    print(json.dumps({'styles': len(data['styles']), 'skills': n_sk, 'unmatched': data['source']['unmatchedStyles'],
                      'unresolvedPassives': data['source']['unresolvedPassives'],
                      'bytes': a.out.stat().st_size}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
