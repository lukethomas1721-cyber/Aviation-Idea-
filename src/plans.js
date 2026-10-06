// Pricing plans from the JetReserve business plan. Tier names are placeholders there; change freely.
// Flat charge = % of the amount financed (same dollars whichever term is chosen). Weekly autopay.
export const WEEKS = { 3: 13, 5: 22, 12: 52 };

export const PLANS = {
  // Plan B: JetReserve's own marketplace (15% markup on the operator rate) finances at a flat 10% over 3 months.
  marketplace: { id: 'marketplace', name: 'Marketplace', downBps: 1000, flatBps: 1000, termsMonths: [3] },
  non_member: { id: 'non_member', name: 'Non-member', downBps: 1000, flatBps: 2500, termsMonths: [3] },
  access: {
    id: 'access', name: 'Access', downBps: 1000, flatBps: 1500, termsMonths: [3, 5],
    dues: { monthlyCents: 100_000, billingMonths: 6 }, creditPerPaymentCents: 250_000
  },
  elite: {
    id: 'elite', name: 'Elite', downBps: 1000, flatBps: 1000, termsMonths: [3, 5],
    dues: { monthlyCents: 300_000, billingMonths: 3 }, creditPerPaymentCents: 500_000
  },
  deposit: {
    id: 'deposit', name: 'Deposit holder', downBps: 0, flatBps: 500, termsMonths: [12],
    depositOptionsCents: [5_000_000, 10_000_000, 15_000_000, 20_000_000, 50_000_000]
  }
};

export const duesPerPaymentCents = (plan) => plan.dues.monthlyCents * plan.dues.billingMonths;
