// All money is integer cents.
export const usd = (c) =>
  (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function splitEven(total, n) {
  const base = Math.floor(total / n);
  const out = Array(n).fill(base);
  out[n - 1] += total - base * n;
  return out;
}

export const feeFor = (principalCents, feeBps) => Math.round((principalCents * feeBps) / 10000);

export function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const dateOnly = (d) => d.toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// Nominal APR (periodic rate x periods/yr) from equal-interval payments, solved by bisection.
// firstOffset=1: first payment one period after funding (arrears). firstOffset=0: first payment at funding.
export function apr(principalCents, paymentsCents, periodsPerYear = 12, firstOffset = 1) {
  const pv = (r) => paymentsCents.reduce((s, p, i) => s + p / Math.pow(1 + r, i + firstOffset), 0);
  if (pv(0) <= principalCents) return 0;
  let lo = 0, hi = 10;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > principalCents) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) * periodsPerYear;
}

// Equal split of `total` among n people; the main person absorbs the rounding remainder
// plus the shares of any `covered` people they are paying for.
export function shareFor(total, n, isMain, covered = 0) {
  const base = Math.floor(total / n);
  return isMain ? base * (1 + covered) + (total - base * n) : base;
}
