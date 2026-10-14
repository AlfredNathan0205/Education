import { bff } from './client-api';

/** Starts (or resumes) a test and goes to it. Errors are thrown for the caller to show. */
export async function startTest(subjectVersionId: string, mode: 'TEST' | 'PRACTICE', blueprint?: string): Promise<void> {
  const r = await bff<{ assessmentId: string }>('POST', 'exam/assessments', { subjectVersionId, mode, ...(blueprint ? { blueprint } : {}) });
  window.location.assign(`/tests/${r.assessmentId}`);
}
