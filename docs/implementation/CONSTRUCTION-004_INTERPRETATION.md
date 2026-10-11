# CONSTRUCTION-004 — Student web vertical slice, first cut (Build Sequence step 12, partial)

**Status:** code complete on branch; not a completed block.

## What exists

Web (`apps/web`): Welcome, Sign in (email or phone, one-time code), Profile (date of birth, then either a guardian-needed state or a name step, then a Ready placeholder), Sign out. API (`apps/api/src/student`): `POST/GET /students/me`, `PUT /students/me/date-of-birth`, `PUT /students/me/display-name`, guarded by a bearer-session guard.

## Journey position

STUDENT_WEB.md: Welcome → Account → Student Profile → Curriculum/Grade → School → Ready → Home... This slice covers Welcome, Account, Student Profile. **Curriculum/Grade, School, Ready and everything after are not built**: they depend on Block 5 (school/academic plan) and on an ACTIVE curriculum, which needs the syllabus source and approver.

## Design decisions (builder choices to confirm)

1. **Browser never holds the session token.** A Next route handler proxies a fixed allow-list of API routes and keeps the token in an httpOnly, SameSite=Lax cookie (`Secure` in production). Proxy allow-list verified: other routes return 404.
2. **DOB first, name second.** Because there is no ACTIVE counsel-reviewed policy yet, every student is classified fail-closed and the web shows "a parent or guardian needs to approve first". Display name is refused server-side (403) until classification says guardian consent is not required. This is data minimization chosen by the builder, not a legal conclusion.
3. **DOB is write-only.** It goes to `PrivacyService` and is never returned by any endpoint; `getClassificationSummary` never selects it.
4. **DOB evidence method is recorded as `SELF_DECLARED`.** If counsel's policy lists accepted methods that exclude it, the API returns 422 and the web shows the error. A real verification flow waits for counsel.
5. **Launch jurisdiction defaults to `AE`** (`DEFAULT_JURISDICTION` in `student.service.ts`). Per-student jurisdiction selection is a follow-up.
6. **No guardian flow.** Guardian invitation/verification is not built; the guardian-needed screen says so honestly.
7. **Sign-out clears the cookie only.** Server-side session revocation endpoint is a follow-up (`IdentityService.revokeSession` exists).
8. **Accessibility/slow network:** labelled fields, `aria-live` errors, skip link, visible focus, 48px targets, reduced-motion respected, system fonts (no external requests), light and dark themes by system setting. Not yet audited with a screen reader or on a throttled network.

## Verification

- Unit tests for the guard, date parsing, service rules, controller error mapping, and that no response carries the DOB.
- Web `tsc` and `next build` pass. UI driven in headless Chromium (390px wide) against a **stand-in API** that mimics the contract: wrong code, valid code, DOB, guardian-needed, name, sign-out, redirect when signed out, proxy allow-list, cookie flags.
- **Not run:** the web against the real API and database; any test on a real phone or throttled network; CI has no web tests (the web `test` script is still a placeholder, and CI uses Node 20, so Node's built-in TypeScript test runner is unavailable).

## Follow-ups

Set `API_URL` for the web app in deployment. Add rate limiting at the proxy/API edge before public exposure. Wire a real OTP sender (the console sender throws in production).
