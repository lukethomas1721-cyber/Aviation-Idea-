import { randomBytes } from 'node:crypto';
// Partner BNPL lender adapter (the plan names Affirm via Stripe, Uplift, ChargeAfter). Borderline clients are referred
// out so the partner carries the default risk. The mock returns a fake hand-off link; implement the real partner API here.
// Interface: refer({ borrower, amountCents, loanId }) -> { partner, status, offerUrl, reference }.
export const mockPartnerLender = {
  refer({ amountCents, loanId }) {
    const ref = randomBytes(5).toString('hex');
    return { partner: 'Partner BNPL (demo)', status: 'invited', offerUrl: `https://partner-bnpl.example/apply/${ref}`, reference: ref, amountCents, loanId };
  }
};
