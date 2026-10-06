import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitEconomics, marketModel } from '../src/economics.js';

const $ = (c) => Math.round(c / 100);
const row = (planId, termMonths) => unitEconomics({ priceCents: 4_000_000, planId, termMonths });

test("plan's unit-economics table for a $40,000 trip", () => {
  const nm = row('non_member', 3);
  assert.deepEqual([$(nm.downCents), $(nm.financedCents), $(nm.flatChargeCents), $(nm.weeklyPaymentCents), $(nm.clientPaysCents), $(nm.jetreserveEarnsCents)],
    [4000, 36000, 9000, 3462, 49000, 13000]);
  const a3 = row('access', 3), a5 = row('access', 5);
  assert.deepEqual([$(a3.flatChargeCents), $(a3.weeklyPaymentCents), $(a5.weeklyPaymentCents), $(a3.clientPaysCents), $(a3.jetreserveEarnsCents)], [5400, 3185, 1882, 45400, 9400]);
  const e3 = row('elite', 3), e5 = row('elite', 5);
  assert.deepEqual([$(e3.flatChargeCents), $(e3.weeklyPaymentCents), $(e5.weeklyPaymentCents), $(e3.clientPaysCents), $(e3.jetreserveEarnsCents)], [3600, 3046, 1800, 43600, 7600]);
  const d = row('deposit', 12);
  assert.deepEqual([$(d.downCents), $(d.financedCents), $(d.flatChargeCents), $(d.weeklyPaymentCents), $(d.clientPaysCents), $(d.jetreserveEarnsCents)], [0, 40000, 2000, 808, 42000, 6000]);
});

test('typical $6,926 empty leg over 3 months: $2,251 / $1,628 / $1,316 earned', () => {
  const e = (p) => $(unitEconomics({ priceCents: 692_600, planId: p, termMonths: 3 }).jetreserveEarnsCents);
  assert.deepEqual([e('non_member'), e('access'), e('elite')], [2251, 1628, 1316]);
});

test("plan's market-size table: avg $1,732 earned and ~$839 capital per flight per year", () => {
  const m = marketModel();
  assert.equal($(m.example.avgEarnCents), 1732);
  assert.ok(Math.abs($(m.example.capitalPerFlightYearCents) - 839) <= 1);
  const one = m.rows.find((r) => r.sharePct === 1);
  assert.deepEqual(one.flightsPerYear, [4200, 5400]);
  assert.deepEqual(one.flightsPerWeek, [81, 104]);
  assert.deepEqual(one.grossPerYearCents.map((c) => +(c / 1e8).toFixed(1)), [7.3, 9.4]);
  assert.deepEqual(one.capitalAtOnceCents.map((c) => +(c / 1e8).toFixed(1)), [3.5, 4.5]);
  const tenth = m.rows.find((r) => r.sharePct === 0.1);
  assert.deepEqual(tenth.flightsPerYear, [420, 540]);
  assert.deepEqual(tenth.grossPerYearCents.map((c) => Math.round(c / 1e5)), [7, 9].map((x, i) => [727, 935][i]));
});
