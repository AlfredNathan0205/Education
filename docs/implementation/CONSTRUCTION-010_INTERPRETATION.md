# CONSTRUCTION-010 — Guardian approval and sign-in rate limiting

Build Sequence step 3 (identity and privacy), the parts that can be built before counsel decides.

## What it does

A student who needs a parent or guardian (decided by the age classification, which is decided by the active jurisdiction policy) can:

1. enter a parent or guardian's email address and say how they are related (mother, father, legal guardian);
2. the adult receives an email with a link; the link opens `/guardian/approve`, the adult signs in with that same email address, reads the consent wording and approves or declines;
3. on approval the student is unlocked. If the adult later withdraws (`/guardian`), the student is blocked again.

## Decisions

| Decision | Why |
|---|---|
| Verification method is a code, `EMAIL_LINK_ATTESTATION`, and the **active, counsel-reviewed policy decides** whether it is accepted (`acceptedGuardianVerificationMethods`). | The spec says the method is data. Counsel may reject it or require a stronger one. Nothing is written unless the policy lists it. |
| Approval is written by `PrivacyService.establishGuardianApproval` in the **same transaction** as the invitation turning ACCEPTED. | D11: privacy state is owned by privacy. No half-approved states. |
| Student is unlocked only when **valid consent exists** (`consentSatisfied`), not merely when the classification flag is off. | Before this block the gates looked at the raw "needs consent" flag, so a consented minor stayed blocked. Withdrawal now blocks again. |
| The link token is 256-bit random, stored only as a SHA-256 hash, carried in the URL **fragment** (`#t=`), sent to the API in a request body, kept in the tab's sessionStorage only. | Fragments are not sent to servers, so they stay out of server, proxy and referrer logs. |
| The guardian must be signed in with a **verified** email identity equal to the invited address. | Possession of the link alone is not enough. |
| The student's own email cannot be the guardian address; a student account cannot approve itself. | Cheapest obvious bypasses. |
| Limits: 1 request per minute, 3 per student per day, 3 per address per day (any status). Sign-in codes: 5 per address per hour. Both are silent or neutral so they reveal nothing about other people. | Stops email flooding and harassment. |
| One pending request per student; a resend cancels the earlier one. Enforced by a row lock, and by a partial unique index in the migration. | Only the newest link works. |
| The guardian accepts a specific **wording version**; if it changed since they read it, they must read again. | A grant must cite exactly what was shown. |
| Consent wording lives in `consent-texts.ts`, each entry marked `counselReviewed`. In production only reviewed wording is served. | Until counsel signs off, the production flow refuses. That is deliberate. |

## What is NOT solved, and why

- **Legal sufficiency.** An emailed link plus a tick-box attestation proves control of an inbox, not that the person is the child's parent. A child can type a friend's address. Whether this is acceptable for the UAE (or India) is a question for counsel. I do not know the answer. If counsel requires something stronger (document check, payment card, video call), a new method code and verification path are needed; the policy and data model already allow for it.
- **The consent wording** in `consent-texts.ts` is a draft with bracketed gaps (purposes, who sees what, retention, controller name). It must not be shown to real families.
- **Under-15 overlay and any "verifiable parental consent" rule** are not built; they wait for counsel.
- **SMS.** No SMS provider is chosen, so phone sign-in and phone-based guardian contact remain unavailable. Choosing a provider needs an account, sender registration and a cost decision.
- **Per-IP rate limiting.** Needs a decision on which proxy headers can be trusted in your hosting. Per-address limits are in.
- **Guardian linking to several children,** guardian-side dashboards, and the guardian viewing the child's results are later work.
- **`invited_by_account_id` / `accepted_by_account_id`** are plain UUID columns without foreign keys (to avoid more back-relations); `student_id` is a real foreign key.

## Operator steps

1. Generate the migration (`prisma migrate dev --name guardian_invitation`) and append:
   ```sql
   CREATE UNIQUE INDEX "guardian_invitation_one_pending_per_student"
     ON "guardian_invitation"("student_id") WHERE "status" = 'PENDING';
   ```
2. Locally: re-run `seed-dev-policy` (new policy version accepts the method and publishes the draft wording).
3. Production (later): counsel approves a policy listing the accepted method → `policy draft/review/activate`; counsel approves the wording → add it to `consent-texts.ts` as reviewed → `policy consent-wording CORE_SERVICE <reference> <description>`.

## Reconciliation with Block 005 (school registry)

Block 005 was never merged (its branch also carried no migration file). It is merged here on top of 009 and 010. Conflicts were all "both sides added to the same list" (module imports, BFF allow-list, client types, schema, docs) except two real ones:

- 005's new data-collection gate (`studentIdForDataCollection`) still used the raw "needs consent" flag, so an approved minor could not choose a grade or school. It now opens on valid consent, like the other gates (test added).
- The profile "ready" screen now shows grade and school, a link to tests, and the leave/add school buttons.

**One migration** (Block 009's `exam_engine` is already merged). Generate it with `prisma migrate dev --name guardian_school` and append three hand-written statements: 010's one-pending-request index, 005's one-open-association index and 005's school-xor-candidate CHECK. The integration tests for them are in `services.integration.spec.ts`.
