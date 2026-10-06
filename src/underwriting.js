// Pure decision function so it can be unit tested and swapped for a bureau/model-backed provider.
// Credit score here stands in for a business-bureau / guarantor pull; replace `creditScore` input
// with a provider call (Experian Business, D&B, Plaid, etc.) before real lending.
export const REASONS = {
  kyc_failed: 'We could not verify the identity or business information provided.',
  ofac_hit: 'We are unable to extend credit based on a compliance screening result.',
  prior_default: 'A prior obligation with us is in default.',
  exposure_limit: 'The requested amount exceeds the maximum total exposure allowed for your account.',
  low_credit: 'Credit profile does not meet minimum requirements.',
  thin_credit: 'Credit profile requires manual review.',
  revenue_ratio_high: 'The financed amount is too large relative to reported annual revenue.',
  revenue_ratio_review: 'Financed amount relative to revenue requires manual review.',
  new_business: 'Limited time in business requires manual review.'
};

export function underwrite({ borrower, principalCents, existingExposureCents, priorDefaults, maxExposureCents }) {
  const declines = [];
  const reviews = [];

  if (!borrower.kyc_passed) declines.push('kyc_failed');
  if (!borrower.ofac_clear) declines.push('ofac_hit');
  if (priorDefaults > 0) declines.push('prior_default');
  if (existingExposureCents + principalCents > maxExposureCents) declines.push('exposure_limit');

  if (borrower.credit_score < 600) declines.push('low_credit');
  else if (borrower.credit_score < 660) reviews.push('thin_credit');

  const ratio = borrower.annual_revenue_cents > 0 ? principalCents / borrower.annual_revenue_cents : Infinity;
  if (ratio > 0.25) declines.push('revenue_ratio_high');
  else if (ratio > 0.1) reviews.push('revenue_ratio_review');

  if (borrower.years_in_business < 1) reviews.push('new_business');

  let decision = 'approved';
  let reasons = [];
  if (declines.length) { decision = 'declined'; reasons = declines; }
  else if (reviews.length) { decision = 'review'; reasons = reviews; }

  let riskTier = 'A';
  if (borrower.credit_score < 740 || ratio > 0.05) riskTier = 'B';
  if (borrower.credit_score < 680 || ratio > 0.1) riskTier = 'C';
  if (decision === 'declined') riskTier = 'D';

  return { decision, riskTier, reasons: reasons.map((code) => ({ code, message: REASONS[code] })) };
}
