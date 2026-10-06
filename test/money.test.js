import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitEven, feeFor, apr, addDays, shareFor } from '../src/money.js';

test('split conserves cents', () => {
  assert.deepEqual(splitEven(4_400_000, 3), [1_466_666, 1_466_666, 1_466_668]);
  assert.equal(splitEven(910_800, 13).reduce((a, b) => a + b), 910_800);
});
test('flat fee', () => { assert.equal(feeFor(4_000_000, 1000), 400_000); assert.equal(feeFor(828_000, 1000), 82_800); });
test('APR: 10% flat over 3 monthly payments is ~58%', () => {
  const a = apr(4_000_000, splitEven(4_400_000, 3));
  assert.ok(a > 0.55 && a < 0.62, `got ${a}`);
});
test('zero-fee loan has 0 APR', () => assert.equal(apr(300, [100, 100, 100]), 0));
test('payment due at funding raises APR vs arrears', () => {
  const pay = splitEven(1_130_000, 13);
  assert.ok(apr(1_000_000, pay, 52, 0) > apr(1_000_000, pay, 52, 1));
});
test('addDays crosses month boundary', () => assert.equal(addDays('2026-10-06', 30), '2026-11-05'));
test('group shares always sum to the total; main absorbs remainder and covered shares', () => {
  const total = 910_000, n = 9;
  assert.equal(shareFor(total, n, true) + 8 * shareFor(total, n, false), total);
  assert.equal(shareFor(total, 9, true, 2) + 6 * shareFor(total, 9, false), total); // main covers 2 absent friends
});
