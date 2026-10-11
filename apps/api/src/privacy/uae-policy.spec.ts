import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPolicyActivatable, parsePolicyConfig } from './jurisdiction-policy';

const file = join(__dirname, '../../policy-templates/ae.v1.json');
const raw = JSON.parse(readFileSync(file, 'utf8'));

describe('UAE policy v1 (counsel-supplied, docs/decisions/UAE_POLICY_V1.md)', () => {
  it('parses under the strict config schema', () => {
    expect(() => parsePolicyConfig(raw)).not.toThrow();
  });
  it('uses 18 for both thresholds', () => {
    const c = parsePolicyConfig(raw);
    expect([c.minorAgeThreshold, c.guardianConsentAgeThreshold]).toEqual([18, 18]);
  });
  it('does not accept self-declared date of birth', () => {
    expect(parsePolicyConfig(raw).acceptedDobEvidenceMethods).not.toContain('SELF_DECLARED');
  });
  it('is activatable only once a human marks it counsel-reviewed with a reference', () => {
    const config = parsePolicyConfig(raw);
    expect(() =>
      assertPolicyActivatable({ legalReview: 'UNREVIEWED', legalReviewReference: null, config }),
    ).toThrow();
    expect(() =>
      assertPolicyActivatable({ legalReview: 'COUNSEL_REVIEWED', legalReviewReference: 'memo', config }),
    ).not.toThrow();
  });
});
