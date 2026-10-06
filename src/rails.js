import { randomBytes } from 'node:crypto';
// Payment-rails adapter. The mock "sends" an operator payout instantly.
// Replace with ACH/wire (Modern Treasury, Increase, Stripe Treasury, bank API) in production;
// keep the same interface: disburse({loanId, operator, amountCents}) -> {status, reference}.
export const mockRails = {
  disburse({ loanId, operator, amountCents }) {
    return { status: 'sent', reference: `mock_${randomBytes(6).toString('hex')}`, loanId, operator: operator.id, amountCents };
  }
};
