// "Terms shift with leg type and hours to departure" (plan, candidate invention #2).
// A rule matches when every condition it states holds; matching rules are additive (adds are summed, the lowest
// maxTermMonths wins). Conditions: legType, plan, minHours (hours to departure >=), maxHours (<). Effects: downBpsAdd,
// flatBpsAdd, maxTermMonths. Example (set via TERM_RULES env as JSON):
//   [{"maxHours":24,"downBpsAdd":1000},{"maxHours":72,"maxTermMonths":3},{"legType":"charter","flatBpsAdd":-200}]
export function applyTermRules({ rules = [], legType, hoursToDeparture, planId }) {
  const out = { downBpsAdd: 0, flatBpsAdd: 0, maxTermMonths: null, applied: [] };
  rules.forEach((r, i) => {
    if (r.legType && r.legType !== legType) return;
    if (r.plan && r.plan !== planId) return;
    if (r.minHours !== undefined && !(hoursToDeparture >= r.minHours)) return;
    if (r.maxHours !== undefined && !(hoursToDeparture < r.maxHours)) return;
    out.downBpsAdd += r.downBpsAdd ?? 0;
    out.flatBpsAdd += r.flatBpsAdd ?? 0;
    if (r.maxTermMonths !== undefined) out.maxTermMonths = Math.min(out.maxTermMonths ?? Infinity, r.maxTermMonths);
    out.applied.push(i);
  });
  return out;
}

// Terms a plan can offer after rules; never empty (falls back to the plan's shortest term).
export function allowedTerms(plan, adjust) {
  const t = plan.termsMonths.filter((m) => adjust?.maxTermMonths == null || m <= adjust.maxTermMonths);
  return t.length ? t : [Math.min(...plan.termsMonths)];
}
