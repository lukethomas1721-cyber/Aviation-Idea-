import { randomBytes } from 'node:crypto';
// Payment-rails adapter. The mock "sends" an operator payout instantly.
// Replace with ACH/wire (Modern Treasury, Increase, Stripe Treasury, bank API) in production;
// keep the same interface: disburse / charge / refund -> {status, reference}.
export const mockRails = {
  // Charge a customer's autopay method (used to backstop a missed group-pay share). Mock always succeeds.
  charge({ loanId, memberId, amountCents }) {
    return { status: 'succeeded', reference: `mockchg_${randomBytes(6).toString('hex')}`, loanId, memberId, amountCents };
  },
  refund({ loanId, amountCents }) {
    return { status: 'refunded', reference: `mockref_${randomBytes(6).toString('hex')}`, loanId, amountCents };
  },
  disburse({ loanId, operator, amountCents }) {
    return { status: 'sent', reference: `mock_${randomBytes(6).toString('hex')}`, loanId, operator: operator.id, amountCents };
  }
};
