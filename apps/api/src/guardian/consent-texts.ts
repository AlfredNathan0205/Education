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
];

export function findConsentWording(reference: string, env: Record<string, string | undefined> = process.env): ConsentWording | null {
  const found = REGISTRY.find((w) => w.reference === reference) ?? null;
  if (!found) return null;
  if (!found.counselReviewed && env.NODE_ENV === 'production') return null;
  return found;
}

export const DEV_DRAFT_WORDING_REFERENCE = 'consent-text:CORE_SERVICE:v1-draft';
