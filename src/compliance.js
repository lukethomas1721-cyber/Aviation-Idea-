import { CONFIG } from './config.js';
import { bad } from './errors.js';

// Reference-value checks from the business plan's legal section. Not legal advice; the plan itself says pricing
// must be reworked with a Texas consumer-finance attorney. Flags are surfaced on quotes and to the lender;
// set ENFORCE_APR_CAP=1 to refuse loans above the reference cap on the consumer track.
export function checkCompliance({ apr, entityType, config = CONFIG }) {
  const track = entityType === 'individual' ? 'consumer' : 'business';
  const cap = track === 'consumer' ? config.compliance.consumerAprCap : null;
  return {
    track,
    referenceAprCap: cap,
    exceedsReferenceCap: cap !== null && apr > cap,
    requiresLenderLicense: apr > config.compliance.licenseAprThreshold,
    enforced: config.compliance.enforce
  };
}

export function assertCompliant(c) {
  if (c.enforced && c.exceedsReferenceCap) {
    throw bad('pricing_not_permitted', 'This pricing exceeds the configured APR cap for consumer loans');
  }
}
