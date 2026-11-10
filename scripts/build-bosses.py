"""Build the public boss catalog from hbr.quest master data.

Sources (public, read-only):
  https://master.hbr.quest/v1/score_attack.json
  https://master.hbr.quest/v1/dimension_battle.json
  https://master.hbr.quest/v1/enemies/<label>.json   (skills + action pattern)

Raw downloads are cached under --raw-dir so the catalog can be rebuilt offline.
Output: public/data/bosses/index.json + one file per event.

Usage:
  python scripts/build-bosses.py [--raw-dir DIR] [--zh zhTW.json] [--out DIR] [--offline]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASTER = 'https://master.hbr.quest/v1/'
TABLES = {'scoreAttack': 'score_attack', 'dimension': 'dimension_battle', 'wave': 'wave_battle'}
UA = 'HBR-Planner-local/1.0 (personal research; low rate)'


# ---------------------------------------------------------------- download

def fetch(url: str, dest: Path, offline: bool, tries: int = 3) -> Path | None:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    if offline:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            json.loads(data)  # never cache a broken body
            tmp = dest.with_suffix('.part')
            tmp.write_bytes(data)
            tmp.replace(dest)
            return dest
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last = e
        except Exception as e:  # network hiccup or invalid JSON
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f'download failed: {url}: {last}')


def read_json(path: Path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------- localisation

class Zh:
    def __init__(self, path: Path | None):
        self.z = read_json(path) if path and path.exists() else {}

    def get(self, table: str, field: str, key) -> str:
        v = self.z.get(table, {}).get(field, {}).get(str(key))
        return v.strip() if isinstance(v, str) and v.strip() else ''


# ---------------------------------------------------------------- normalisers

def nonzero(d: dict | None) -> dict:
    return {k: v for k, v in (d or {}).items() if v}


def norm_part(p: dict) -> dict:
    eff = p.get('effect') or {}
    out = {
        'skillType': p.get('skill_type'),
        'targetType': p.get('target_type'),
        'attackType': p.get('type'),
        'elements': p.get('elements') or [],
        'power': p.get('power'),
        'value': p.get('value'),
        'parameters': nonzero(p.get('parameters')),
        'multipliers': nonzero(p.get('multipliers')),
        'diffForMax': p.get('diff_for_max') or 0,
        'hitRatios': [h.get('power_ratio') for h in p.get('hits') or []],
        'cond': p.get('cond') or '',
        'targetCondition': p.get('target_condition') or '',
        'hitCondition': p.get('hit_condition') or '',
        'exit': {'cond': eff.get('exitCond'), 'value': eff.get('exitVal')},
    }
    if p.get('label'):
        out['label'] = p['label']
    return {k: v for k, v in out.items() if v not in (None, '', [], {})}


def norm_rule(r: dict, zh: Zh) -> dict:
    lab = r.get('label', '')
    return {
        'id': r.get('id'),
        'label': lab,
        # zh "battledescription" is the short title; "rulename" is the full sentence.
        'name': zh.get('scoreattackrule', 'battledescription', lab) or r.get('name', ''),
        'desc': zh.get('scoreattackrule', 'rulename', lab) or r.get('desc', ''),
        'nameJa': r.get('name', ''),
        'type': r.get('type'),
        'target': r.get('target'),
        'timing': r.get('timing') or [],
        'interval': r.get('interval'),
        'term': r.get('term'),
        'arg': r.get('arg'),
        'arg2': r.get('arg2'),
        'grade': r.get('grade') or 0,
        'parts': [norm_part(p) for p in r.get('parts') or []],
        'extraSkills': r.get('skills') or [],
        'inDate': r.get('in_date'),
        'outDate': r.get('out_date'),
    }


def at(lst, i, default=None):
    return lst[i] if isinstance(lst, list) and i < len(lst) else default


def norm_stage(b: dict, group: str, zh: Zh) -> dict:
    labels = b.get('b') or []
    names = b.get('bn') or []
    enemies = []
    for i, lab in enumerate(labels):
        enemies.append({
            'label': lab,
            'name': zh.get('enemy', 'name', lab) or (at(names, i) or {}).get('n', ''),
            'dp': at(b.get('dl'), i),
            'hp': at(b.get('hl'), i),
            'attackRate': at(b.get('al'), i),
            'paramBorder': at(b.get('rbl'), i),
            'destruction': (at(names, i) or {}).get('d'),
        })
    stage = {
        'group': group,
        'id': b.get('id'),
        'label': b.get('label'),
        'difficulty': b.get('d'),
        'difficultyName': zh.get('scoreattackbattle', 'difficultyname', b.get('label')) or b.get('dn', ''),
        'baseScore': b.get('ds'),
        'recommendedPower': b.get('rs'),
        'battleLabel': b.get('btl'),
        'enemies': enemies,
        'extraGauge': b.get('eg') or [],
        'damageCap': b.get('db'),
        'damageCapCoef': b.get('dbnc'),
        'noBreakBonus': b.get('nbb'),
        'maxDamageBonus': b.get('mdb'),
        'maxTurnBonus': b.get('mtb'),
        'turnLimit': b.get('tl'),
        'challenge': bool(b.get('is_c')),
        'condition': b.get('c') or '',
    }
    if b.get('rules'):
        stage['rules'] = [norm_rule(r, zh) for r in b['rules']]
    if b.get('enchant'):
        stage['enchant'] = norm_rule(b['enchant'], zh)
    return stage


def norm_skill(s: dict, zh: Zh) -> dict:
    lab = s.get('label', '')
    return {
        'id': s.get('id'),
        'label': lab,
        'name': zh.get('skill', 'name', lab) or s.get('name') or '',
        'desc': s.get('desc') or '',
        'hitCount': s.get('hit_count'),
        'targetType': s.get('target_type'),
        'useCount': s.get('use_count'),
        'intervalTurn': s.get('interval_turn'),
        'cond': s.get('cond') or '',
        'hitRatios': [h.get('power_ratio') for h in s.get('hits') or []],
        'parts': [norm_part(p) for p in s.get('parts') or []],
        'passive': s.get('passive'),
    }


def norm_pattern(pattern: dict | None) -> dict:
    out = {}
    for phase, block in (pattern or {}).items():
        if not isinstance(block, dict):
            continue
        out[phase] = {
            'label': block.get('l'),
            'entries': [{
                'order': e.get('order'),
                'preemptive': bool(e.get('is_preemptive')),
                'once': bool(e.get('once')),
                'weight': e.get('weight'),
                'condition': e.get('condition') or '',
                'targetWeight': e.get('target_weight'),
                'skills': e.get('skill_list') or [],
            } for e in sorted(block.get('p') or [], key=lambda e: (e.get('order') or 0, e.get('id') or 0))],
        }
    return out


def norm_enemy(d: dict, zh: Zh) -> dict:
    lab = d.get('label', '')
    return {
        'id': d.get('id'),
        'label': lab,
        'name': zh.get('enemy', 'name', lab) or d.get('name', ''),
        'nameJa': d.get('name', ''),
        'image': d.get('image'),
        'flags': {k: v for k, v in (d.get('flags') or {}).items() if v},
        'base': d.get('base_param') or {},
        'resist': d.get('resistances') or {},
        'extraGauge': d.get('extra_gauge'),
        'bars': d.get('bars'),
        'skills': [norm_skill(s, zh) for s in d.get('skills') or []],
        'pattern': norm_pattern(d.get('pattern')),
        'detail': True,
    }


def fallback_enemy(e: dict, zh: Zh) -> dict:
    """Enemy present in enemies.json but without a detail file: stats only."""
    out = norm_enemy(e, zh)
    out['detail'] = False
    return out


# ---------------------------------------------------------------- events

def dates(ev: dict) -> tuple[str | None, str | None]:
    pool = [x for x in (ev.get('bonus') or []) + (ev.get('rules') or []) if isinstance(x, dict)]
    ins = [x['in_date'] for x in pool if x.get('in_date')]
    outs = [x['out_date'] for x in pool if x.get('out_date')]
    return ev.get('in_date') or (min(ins) if ins else None), ev.get('out_date') or (max(outs) if outs else None)


def parse_wave_battle_label(label: str):
    """Battle names may include a difficulty suffix: HARD_05_40 is phase 5."""
    match = re.fullmatch(r'(?:Battle\.)?WaveBattle\d+_(HARD|EASY)_(\d+)(?:_(\d+))?', str(label))
    if not match:
        return None
    mode, phase, difficulty = match.groups()
    phase, difficulty = int(phase), int(difficulty) if difficulty is not None else None
    if not 1 <= phase <= 5 or (difficulty is not None and difficulty < 1):
        return None
    return mode, phase, difficulty


def select_wave_groups(details: list[dict], preferred_difficulty: int = 40) -> list[dict]:
    """Select one public enemy template per phase; never combine level variants.

    The template's raw base stats remain uncalibrated. Per-level values belong in
    the separately sourced parameter layer, not in these public enemy details.
    """
    groups = {}
    for detail in details:
        for battle in detail.get('battles') or []:
            key = parse_wave_battle_label(battle.get('label', ''))
            if key is None:
                continue
            group = groups.setdefault(key, {'battleLabel': battle['label'], 'enemies': {}})
            group['enemies'][detail['label']] = detail
    mode = 'HARD' if any(k[0] == 'HARD' for k in groups) else 'EASY'
    selected = []
    for phase in range(1, 6):
        candidates = {k[2]: v for k, v in groups.items() if k[:2] == (mode, phase)}
        selected_mode = mode
        if not candidates and mode != 'EASY':
            candidates = {k[2]: v for k, v in groups.items() if k[:2] == ('EASY', phase)}
            selected_mode = 'EASY'
        if not candidates:
            continue
        difficulty = preferred_difficulty if preferred_difficulty in candidates else None if None in candidates else max(candidates)
        chosen = candidates[difficulty]
        selected.append({'mode': selected_mode, 'phase': phase, 'sourceDifficulty': difficulty,
                         'battleLabel': chosen['battleLabel'], 'enemies': list(chosen['enemies'].values())})
    return selected


def build_event(kind: str, ev: dict, zh: Zh) -> dict:
    label = ev.get('label', '')
    in_date, out_date = dates(ev)
    base = {'kind': kind, 'id': ev.get('id'), 'label': label, 'noticeId': ev.get('notice_id'),
            'inDate': in_date, 'outDate': out_date}
    if kind == 'scoreAttack':
        base.update({
            'name': ev.get('name', ''),
            'hint': ev.get('hint') or '',
            'recommend': zh.get('scoreattack', 'recommendmessage', label),
            'scoreCalc': ev.get('score_calc') or {},
            'maxRules': ev.get('max_rules', 1),
            'styleBonus': [{k: b.get(k) for k in ('type', 'style', 'dp', 'status', 'priority', 'in_date', 'out_date')}
                           for b in ev.get('bonus') or []],
            'rules': [norm_rule(r, zh) for r in ev.get('rules') or []],
            'stages': [norm_stage(b, 'main', zh) for b in ev.get('battles') or []],
        })
    elif kind == 'wave':
        # 遭遇战（セラフ遭遇戦演習）：阶段敌人不在本表，main() 里按敌人详情的 battles 字段补
        base.update({'name': ev.get('name', ''), 'isWave': True, 'stages': [], 'maxRules': ev.get('max_rules', 1),
                     'elements': ev.get('elements') or [], 'rules': [norm_rule(r, zh) for r in ev.get('rules') or []],
                     'totalScoreSteps': [x.get('score') for x in ev.get('totalscore') or []]})
    else:
        stages = []
        for group in ('central', 'satellites', 'ex_mode'):
            for b in ev.get(group) or []:
                stages.append(norm_stage(b, {'satellites': 'satellite', 'ex_mode': 'ex'}.get(group, group), zh))
        base.update({'name': ev.get('label', ''), 'isDimension': True, 'stages': stages,
                     'scoreCalc': ev.get('score_calc') or {}, 'rules': []})
    return base


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    today = dt.date.today().strftime('%Y%m%d')
    ap.add_argument('--raw-dir', default=str(ROOT / 'work' / 'catalog-research' / f'{today}-boss'))
    ap.add_argument('--zh', default=str(ROOT / 'work' / 'catalog-research' / '20261107' / 'zhTW.json'))
    ap.add_argument('--out', default=str(ROOT / 'public' / 'data' / 'bosses'))
    ap.add_argument('--offline', action='store_true')
    ap.add_argument('--delay', type=float, default=0.15)
    args = ap.parse_args(argv)
    raw, out = Path(args.raw_dir), Path(args.out)
    zh = Zh(Path(args.zh))

    sources, events = [], []
    for kind, table in TABLES.items():
        path = fetch(MASTER + table + '.json', raw / f'{table}.json', args.offline)
        if not path:
            if kind == 'wave':  # 遭遇战表可选：旧缓存或离线时没有就跳过
                print(f'skip optional table {table}', file=sys.stderr)
                continue
            print(f'missing table {table}', file=sys.stderr)
            return 2
        sources.append({'table': table, 'url': MASTER + table + '.json', 'sha256': sha256(path)})
        events += [build_event(kind, ev, zh) for ev in read_json(path)]

    stats_only = {}
    enemies_path = raw / 'enemies.json'
    if fetch(MASTER + 'enemies.json', enemies_path, args.offline):
        stats_only = {e['label']: e for e in read_json(enemies_path)}
        sources.append({'table': 'enemies', 'url': MASTER + 'enemies.json', 'sha256': sha256(enemies_path)})

    # 遭遇战：敌人标签 waveBattle_NN_*；详情的 battles 标签 WaveBattleNN_HARD_05 给出难度与阶段
    for ev in events:
        if ev['kind'] != 'wave':
            continue
        nn = ev['label'][-2:]
        wave_details = []
        for lab in sorted(l for l in stats_only if l.startswith(f'waveBattle_{nn}_')):
            path = fetch(MASTER + f'enemies/{lab}.json', raw / 'enemies' / f'{lab}.json', args.offline)
            if not path:
                continue
            det = read_json(path)
            wave_details.append(det)
        for selected in select_wave_groups(wave_details):
            mode, phase, dets = selected['mode'], selected['phase'], selected['enemies']
            bp = lambda d: d.get('base_param') or {}
            ev['stages'].append({
                'group': 'wave', 'id': phase, 'label': f'{ev["label"]}_{mode}_{phase:02d}', 'phase': phase,
                'battleLabel': selected['battleLabel'], 'sourceDifficulty': selected['sourceDifficulty'],
                'difficultyName': f'第 {phase} 阶段', 'enemies': [{
                    'label': d['label'], 'name': zh.get('enemy', 'name', d['label']) or d.get('name', ''),
                    'dp': bp(d).get('dp'), 'hp': bp(d).get('hp'), 'attackRate': bp(d).get('atk_rate'),
                    'paramBorder': bp(d).get('param_border'),
                    'destruction': [bp(d).get('d_rate'), bp(d).get('max_d_rate')],
                } for d in dets],
                'rules': [],
            })
    labels = sorted({e['label'] for ev in events for st in ev['stages'] for e in st['enemies'] if e['label']})
    details, missing = {}, []
    for i, lab in enumerate(labels):
        dest = raw / 'enemies' / f'{lab}.json'
        had = dest.exists()
        path = fetch(MASTER + f'enemies/{lab}.json', dest, args.offline)
        if path:
            details[lab] = norm_enemy(read_json(path), zh)
        elif lab in stats_only:
            details[lab] = fallback_enemy(stats_only[lab], zh)
            missing.append(lab)
        else:
            missing.append(lab)
        if not had and path and args.delay:
            time.sleep(args.delay)
        if (i + 1) % 100 == 0:
            print(f'enemies {i + 1}/{len(labels)}', file=sys.stderr)

    out.mkdir(parents=True, exist_ok=True)
    index = []
    for ev in events:
        sub = {'scoreAttack': 'sa', 'wave': 'wave'}.get(ev['kind'], 'dimension')
        file = f'{sub}/{ev["label"]}.json'
        used = sorted({e['label'] for st in ev['stages'] for e in st['enemies'] if e['label']})
        ev['enemies'] = {lab: details[lab] for lab in used if lab in details}
        dest = out / file
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(ev, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        bosses = []
        for lab in used:
            n = details.get(lab, {}).get('name') or lab
            if n not in bosses:
                bosses.append(n)
        index.append({
            'kind': ev['kind'], 'label': ev['label'], 'id': ev['id'], 'name': ev['name'],
            'inDate': ev['inDate'], 'outDate': ev['outDate'], 'bosses': bosses,
            'stages': len(ev['stages']), 'rules': len(ev['rules']), 'file': file,
            'withActions': sum(1 for lab in used if details.get(lab, {}).get('pattern')),
            'enemyCount': len(used),
        })
    index.sort(key=lambda x: (x['kind'], -(x['id'] or 0)))
    manifest = {
        'schemaVersion': 1,
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'sources': sources,
        'enemyDetailUrl': MASTER + 'enemies/<label>.json',
        'notes': [
            '数据来自 hbr.quest 公开主数据，名称优先繁中，缺失时用日文原名。',
            '行动表按 order 排列；weight／condition 的实际选择规则未经实战验证。',
            '计分公式参照 hbr.quest 计算器（第三方实现），未经游戏内结算核对。',
        ],
        'missingDetail': missing,
        'events': index,
    }
    (out / 'index.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps({'events': len(index), 'enemies': len(labels), 'withDetail': len(labels) - len(missing),
                      'missing': len(missing)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
