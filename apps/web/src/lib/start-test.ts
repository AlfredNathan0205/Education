import { bff } from './client-api';

/** Starts (or resumes) a test and goes to it. Errors are thrown for the caller to show. */
export async function startTest(subjectVersionId: string, mode: 'TEST' | 'PRACTICE', blueprint?: string): Promise<void> {
  const r = await bff<{ assessmentId: string }>('POST', 'exam/assessments', { subjectVersionId, mode, ...(blueprint ? { blueprint } : {}) });
  window.location.assign(`/tests/${r.assessmentId}`);
}

/** Starts (or resumes) the practice set or retest of a recommendation, and goes to it (Step 14). */
export async function startRecommendation(recommendationId: string): Promise<void> {
  const r = await bff<{ assessmentId: string }>('POST', `recommendations/${recommendationId}/start`);
  window.location.assign(`/tests/${r.assessmentId}`);
}

/** "Practise what you missed" from a finished test (Step 14). */
export async function practiseMissed(assessmentId: string): Promise<void> {
  const r = await bff<{ assessmentId: string }>('POST', `recommendations/from-result/${assessmentId}`);
  window.location.assign(`/tests/${r.assessmentId}`);
}
