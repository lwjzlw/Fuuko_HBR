// Persistent, bounded result snapshots. Only the latest search batch is retained;
// adopted teams and axes remain in the archive's existing per-event records.
export const TEAM_ELEMENTS = ['', 'ice', 'fire', 'thunder', 'light', 'dark', 'nonelemental'];

export function normalizeResultSettings(settings = {}) {
  const count = Number(settings.top);
  return {
    teamElement: TEAM_ELEMENTS.includes(settings.teamElement) ? settings.teamElement : '',
    top: [5, 10, 20].includes(count) ? count : 10,
  };
}

export function packOptimizationResult(targetKey, result, settings, selected = 0) {
  const normalized = normalizeResultSettings(settings);
  // Explicit fields keep worker diagnostics and internal search states out of
  // persistent archives. Member raw data is required for further local searches.
  const top = (result.top || []).slice(0, normalized.top).map(t => {
    const out = {};
    for (const key of ['label', 'newTeam', 'team', 'ruleIds', 'ruleNames', 'turns',
      'mc', 'design', 'cards', 'loadout', 'members', 'teamElement', 'elementShare', 'elementDamage']) {
      if (t[key] !== undefined) out[key] = t[key];
    }
    return out;
  });
  return structuredClone({
    targetKey, at: Date.now(), selected: Math.max(0, Math.min(selected, top.length - 1)),
    teamElement: normalized.teamElement, requested: normalized.top,
    goal: result.goal || settings.goal || 'score', elapsed: result.elapsed,
    evaluated: result.evaluated, screened: result.screened, threads: result.threads,
    errorCount: result.errors?.length || 0, top,
  });
}

export function scoreGap(best, candidate) {
  if (!Number.isFinite(best) || !Number.isFinite(candidate)) return null;
  return Math.max(0, best - candidate);
}

// A score bonus does not guarantee a better final score: a difficult rule may
// cost more turns or cause failures. Include every legal subset, including none.
export function ruleCombinations(rules = [], maximum = 1) {
  const limit = Math.max(0, Math.min(rules.length, Math.trunc(Number(maximum) || 0)));
  const out = [];
  function visit(start, chosen) {
    out.push(chosen.slice());
    if (chosen.length === limit) return;
    for (let i = start; i < rules.length; i++) {
      chosen.push(rules[i]); visit(i + 1, chosen); chosen.pop();
    }
  }
  visit(0, []);
  return out;
}
