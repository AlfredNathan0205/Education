/**
 * Consent wording the guardian reads before approving. A consent_policy_version row holds only a
 * `text_reference`; this registry turns that reference into the text, so a grant always cites exactly
 * what was shown.
 *
 * LEGAL STATUS. Wording is legal content. Every entry carries `counselReviewed`. Outside production a
 * draft may be shown (clearly labelled) so the flow can be exercised; in production only reviewed
 * wording is served, so until counsel signs off the approval flow refuses. To go live: counsel approves
 * the text, a developer adds it here with `counselReviewed: true` under a new reference, and an operator
 * publishes it with `policy consent-wording`.
 */
export interface ConsentWording {
  reference: string;
  title: string;
  counselReviewed: boolean;
  paragraphs: string[];
}

const REGISTRY: ConsentWording[] = [
  {
    reference: 'consent-text:CORE_SERVICE:v1-draft',
    title: 'Approval for a student to use Exam App',
    counselReviewed: false,
    paragraphs: [
      'DRAFT. This wording has not been reviewed by a lawyer and must not be used with real families.',
      'You are being asked to approve a student using Exam App to take practice tests.',
      'What we keep about the student: the sign-in email address or phone number, date of birth, a display name, and the answers, scores and progress from the tests they take.',
      'Why: to run the tests, mark them and show the student their progress. [Further purposes, if any, to be confirmed.]',
      'Who can see it: [to be confirmed: who sees the student\'s name, results and ranking].',
      'How long: [retention period to be confirmed].',
      'You can withdraw this approval at any time from your guardian page. Withdrawing stops the student using the service until an adult approves again.',
      '[Name of the organisation responsible for the data, and how to contact it, to be confirmed.]',
    ],
  },
  {
    // Step 17: an adult student agrees to let a parent see their progress summary.
    reference: 'consent-text:PARENT_REPORT_SHARING:v1-draft',
    title: 'Share your progress summary with a parent',
    counselReviewed: false,
    paragraphs: [
      'DRAFT. This wording has not been reviewed by a lawyer and must not be used with real families.',
      'The person you invite will be able to see a summary of your progress: how many tests and practice sets you did each week, your progress labels by subject and chapter, the objectives you have shown you are strong in, the ones worth more practice, and what has improved.',
      'They will not see your answers, your scores, your points or rank, your friends or challenges, or anything about other students.',
      'They see a summary only once the evidence is strong enough. Until then it says "Building evidence".',
      'You can stop sharing at any time from your Progress page. They will lose access straight away. [Retention of past weekly summaries to be confirmed.]',
      '[Name of the organisation responsible for the data, and how to contact it, to be confirmed.]',
    ],
  },
  {
    // Step 19: permission to include the student in pseudonymous product statistics.
    reference: 'consent-text:PRODUCT_ANALYTICS:v1-draft',
    title: 'Help improve Exam App',
    counselReviewed: false,
    paragraphs: [
      'DRAFT. This wording has not been reviewed by a lawyer and must not be used with real families.',
      'If you agree, we count how the app is used so we can make it better: for example how many tests are started and finished each week, how often students come back, and whether practice after a test is used.',
      'These statistics use a code instead of the student\'s name or account, are seen only by the Exam App team as totals, and are never sold, shared with advertisers or used to show ads. We do not track time spent on screens.',
      'Saying no changes nothing about how the app works. You can change your mind at any time; if you turn this off, what was collected is deleted.',
      '[Name of the organisation responsible for the data, and how to contact it, to be confirmed.]',
    ],
  },
];

export function findConsentWording(reference: string, env: Record<string, string | undefined> = process.env): ConsentWording | null {
  const found = REGISTRY.find((w) => w.reference === reference) ?? null;
  if (!found) return null;
  if (!found.counselReviewed && env.NODE_ENV === 'production') return null;
  return found;
}

export const DEV_DRAFT_WORDING_REFERENCE = 'consent-text:CORE_SERVICE:v1-draft';
export const SHARING_DRAFT_WORDING_REFERENCE = 'consent-text:PARENT_REPORT_SHARING:v1-draft';
export const ANALYTICS_DRAFT_WORDING_REFERENCE = 'consent-text:PRODUCT_ANALYTICS:v1-draft';
