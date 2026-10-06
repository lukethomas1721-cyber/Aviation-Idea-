import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitEven, feeFor, apr, addDays } from '../src/money.js';

test('3-way split conserves cents (matches the $40k example)', () => {
  assert.deepEqual(splitEven(4_400_000, 3), [1_466_666, 1_466_666, 1_466_668]);
  assert.equal(splitEven(4_400_000, 3).reduce((a, b) => a + b), 4_400_000);
});
test('flat 10% fee', () => {
  assert.equal(feeFor(4_000_000, 1000), 400_000);
  assert.equal(feeFor(2_500_000, 1000), 250_000);
});
test('APR of a 10% flat / 3 monthly payment loan is ~58%', () => {
  const a = apr(4_000_000, splitEven(4_400_000, 3));
  assert.ok(a > 0.55 && a < 0.62, `got ${a}`);
});
test('zero-fee loan has 0 APR', () => assert.equal(apr(300, [100, 100, 100]), 0));
test('addDays crosses month boundary', () => assert.equal(addDays('2026-10-06', 30), '2026-11-05'));
