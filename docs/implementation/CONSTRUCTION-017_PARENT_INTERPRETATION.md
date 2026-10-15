# Step 17: Parent claim gate and parent web

Spec sources:
- `CLAIM_GATING_PARENT.md`: the labels and gates; Parent Release 1 (activity, subject picture, demonstrated strengths, Focus Next, improvement, weekly summary); the parent sees claim-gated evidence, never raw model confidence or other learners' diagnostics; AI may only rephrase approved claims.
- `INVARIANTS_AND_POLICIES.md`: invariant 19 (parent claims require claim-gate approval), and the claim baseline.
- `MASTER_SPEC.md`, Claims: sparse evidence shows Building evidence, never a negative label.
- `CANONICAL_DATA_MODEL.md`, Claims/reports: `claim_policy_version`, `student_report`, `student_report_version`, `report_claim`, `suppressed_claim`.
- `PRIVACY_SECURITY.md`: account is not student; guardian relationship is not consent; purpose-specific consent; diagnostics stay private.

**PM decisions for this step (15 October):**
- **Who sees it:** guardians who approved a minor, **and** parents an adult student invites, under the student's own consent, which they can withdraw.
- **Weekly summary:** in the app only, with no email.
- **What it shows:** the spec's Release 1 list and nothing more: no points, ranks, friends or challenges.
- **Transparency:** the student is told who can see their summary, and can see exactly what they see.

## Built
- **Who may see a student's summary.**
  - **A guardian with a live, verified approval of a minor.** The approval is the access: no extra row is needed, and withdrawing the approval ends access at once.
  - **A parent an adult student invited.**
    - The student reads the sharing wording and ticks "I agree". This records a consent under the new purpose `PARENT_REPORT_SHARING` (capacity SELF, versioned).
    - A one-time link goes to the parent's email. Only the token's hash is stored, and the token travels in the URL fragment.
    - The parent signs in with that address and accepts.
    - The student can stop at any time: the access ends and the consent is withdrawn, in one transaction. The parent can also leave.
    - If the consent is withdrawn by any route, access ends even if the access row was left open.
    - Limits: 2 parents at a time, and the same rate limits as guardian invitations.
  - **Minors cannot invite anyone.** Their guardian already sees the summary.
  - **Anyone else gets a 404,** never a 403, so nothing reveals that the student exists.
  - **Every view by a parent is audited:** `parent.summary_viewed` and `parent.report_viewed`.
- **The claim gate (`CLAIM_V1`, a versioned policy row).** The mastery gate (Step 13) decides labels. This layer decides which claims may be made:
  - **Strength:** only an objective labelled Strong (the spec's strong gate).
  - **Focus next:** only an objective labelled Needs attention (the stricter weak gate). One bad test never becomes a focus area.
  - **Improvement:** a trend claim, stricter still. The label at the start **and** at the end of the period both passed the gate, the band rose, and there was evidence on that objective during the period. An objective that only just became sayable is not an "improvement".
  - **Limits:** 5 strengths, 3 focus areas and 5 improvements. A strength is ordered by mastery, highest first; a focus area lowest first.
  - **Fixed wording, no AI:**
    - "Shows strong understanding: …"
    - "Worth more practice: …"
    - "Moved from developing to secure: …"
  - **Refusals are kept:** every candidate the gate refused is recorded with its reason (`STRONG_GATE_NOT_MET`, `WEAK_GATE_NOT_MET`, `NO_EARLIER_CLAIM`, `TREND_GATE_NOT_MET` or `OVER_LIMIT`), so what was not said, and why, is auditable.
- **Activity** is reported as facts, not claims: tests, practice sets, questions answered, and days active. **Scores and answers are not shown to parents.**
- **The subject picture:** objectives counted by label, and chapter labels from the Step 13 rollup.
- **Replay, not the current state.** The summary for a period is recomputed from the valid evidence answered before each moment, through the same mastery functions. So a report is the same whenever it is built, and "improvement" compares the start and end of the period.
- **Weekly reports.** Weeks run Monday to Monday, India time, as the leaderboards do.
  - **The reconciler** (every 30 seconds, `REPORTS_ENABLED`, on by default) freezes last week's report for every student active in it. It waits until mastery has counted all of that student's tests up to the end of the week.
  - **Reports are frozen.** A database trigger refuses any edit to a version or its claims.
  - **Corrections.** A later rescore or invalidation of a test from before that week's end adds a new version (`EVIDENCE_CHANGED`). Earlier versions stay as they were. The parent sees the latest version, with "corrected" shown.
  - **Events:** `parent.report_generated.v1`, `parent.sharing_started.v1` and `parent.sharing_ended.v1`.
- **Web.**
  - **`/parent`:**
    - a child picker when the parent can see more than one student;
    - this week so far: activity, strengths, focus next, improved, and each subject;
    - weekly reports, each opening as it was frozen;
    - "Stop seeing this summary" for a shared summary.
    - A guardian is pointed to their approvals page instead.
  - **`/parent/accept`:** a parent answering an invitation. If they are not signed in, sign-in brings them straight back.
  - **Progress (student):**
    - A minor sees "Your parent or guardian … can see a summary".
    - An adult sees "Share with a parent": the wording, an email box, "I agree", the list of viewers with Stop sharing, and the pending invitation with Cancel.
    - Both get "See what they see" (`/progress/parent-view`), which shows exactly the parent's summary.
  - **Guardian page:** each approved child now shows a name and a "See their progress summary" link.
- **The Step 16 gap is fixed.** Guardians now see which child is asking. A new `PrivacyService.studentLabels` uses the child's display name, else their own sign-in address, masked (for example "m\*\*\*@example.com"). It is shown only to that child's guardian or sharing parent. It is used on the guardian approvals page, the friend-request approvals and the parent page.
- **A real-data guardian in the integration tests.** A new helper approves a minor through the real guardian flow (invitation, signed-in guardian, consent wording, verification, authority, consent record). The Step 16 social test now uses it instead of a faked guardian lookup, and so does the new Step 17 test.

## Assumptions and open decisions (please confirm)
1. **Sharing is a privacy decision; counsel should confirm it.** That covers:
   - the sharing wording, which is **draft** and refused in production until counsel-reviewed wording is published;
   - that an adult's consent is enough;
   - how long past weekly reports are kept;
   - whether a parent should keep reports from weeks before the student stopped sharing (today they lose all access at once).
2. **No scores for parents.** Activity is counts only. This is my reading of "claim-gated evidence" and "no public academic weakness". Showing scores would be a change.
3. **The `CLAIM_V1` numbers and wording are mine:** the limits 5/3/5, at least 1 session in the period for an improvement, and the three sentences.
4. **One guardian per minor in Release 1.** The guardian flow allows one approval per child, so there is no second guardian. A minor also cannot add other viewers.
5. **The name a parent sees** is the display name, else the masked sign-in address. A guardian knows the child, so this is for telling siblings apart, not identity.
6. **A minor who turns 18.** A shared summary stops if the student is ever classified as needing a guardian. The reverse, a guardian's access when the child turns 18, is not handled. It needs the spec's age-transition review.
7. **Reports for every active student.** A weekly report is frozen for every student active that week, whether or not anyone views it. That way past weeks exist when a parent is added later. The alternative is to freeze reports only for students who have a viewer.
8. **The parent sees the same subjects as the student:** the subjects of the student's cohort that are open for tests.
9. **A parent who leaves** ends their access, but the student's consent record stays unwithdrawn, because only the student or an account with access may withdraw it. It is never used again, because a new invitation records a new consent.

## Not built
- Email or push for the weekly summary (PM decision: in the app only).
- AI rephrasing of claims (the spec allows rephrasing of approved claims only; none is used).
- Cognitive, misconception, chapter-level or subject-level claims beyond chapter labels. The spec's stricter gates for these need numbers it does not give.
- School or teacher views.
- An erasure path for reports. DELETE is still possible, for the future deletion saga.
- A second guardian for a minor; guardians' visibility of friends and challenges (PM: not on the parent page).
- An admin view of suppressed claims. They are in the database for audit.

## Migration
One migration, `parent`: Prisma's DDL plus `CONSTRUCTION-017_PARENT_MIGRATION_EXTRA.sql`. That file adds:
- **One ACTIVE claim policy,** and `CLAIM_V1` seeded. A unit test checks the seed matches the code.
- **Report rules:** a week is exactly 7 days, versions count from 1, and the reason is one of two.
- **Frozen reports:** triggers refuse UPDATE on report versions, claims and suppressed claims.
- **Claim vocabulary:**
  - a strength is Strong only;
  - a focus area is Needs attention only;
  - an improvement has a starting label;
  - suppression reasons come from the list.
  - (`IS NOT NULL` is spelled out, so a NULL cannot slip past a CHECK.)
- **Sharing:** invitation statuses and their timestamps; an ended grant has a time, a reason and who ended it.
- **Uniqueness:** at most one open grant per student and viewer, and one pending invitation per student.
- **The consent purpose `PARENT_REPORT_SHARING`,** with draft wording v1 (served outside production only).

## Checks done here
- **Unit tests: 64 suites, 1028 tests** (Step 16 had 1002). They cover:
  - the claim gate: strengths, focus, improvement and its trend gate, limits, refusals, and no claim without evidence;
  - fixed wording, activity in India time, weeks, the policy parser, and the seeded SQL matching `CLAIM_V1`;
  - sharing rules;
  - the service against an in-memory database fake:
    - guardian access, 404 for others, auditing, and a guardian cannot "leave";
    - the summary's labels and claims, with no numbers;
    - the student's preview equals the parent's view;
    - a weekly report frozen once, its claims and refusals, and a correction adding version 2 without touching version 1;
    - sharing: wording, agreement, a stale version, own address, the token hash, the wrong account, accepting twice, stopping, leaving, a withdrawn consent alone ending access, declining, cancelling, minors refused, no wording, and a failed email leaving nothing open.
- **Browser tests: 34 of 34 pass** (17 × phone and desktop). The new ones:
  - a guardian's summary: fixed sentences, labels, no "%", the weekly report, and no "stop" for a guardian;
  - an adult agrees and invites; the parent opens the link signed out, signs in, comes back and accepts, then sees the summary; the student stops sharing and the parent loses it;
  - a minor's Progress explains who sees it, and "See what they see".
- **The schema validates.** The SQL extras ran on a throwaway Postgres 16: every index, CHECK and trigger, plus the seed. That run found and closed a hole where an improvement with a NULL starting label passed the CHECK.
- **Checked by eye at phone width:** the parent page and the sharing form. That added a "Not now" to the sharing form.
- **Not run here:** the migration and the 2 new real-database integration tests:
  - a guardian approved through the real flow sees the gated summary → audited → 404 for a stranger → the weekly report freezes once → a frozen version refuses edits → an invalidation adds version 2 → withdrawing the approval ends access;
  - an adult shares under their own consent → the parent accepts → the database refuses a second open grant → stopping withdraws the consent and ends access.
- **Also changed:** the Step 16 social integration test now uses a really approved guardian.
