# Step 18: Entitlements and subscription foundation

Spec sources:
- `BUILD_SEQUENCE.md`: step 18, "Entitlements/Subscription foundation". Pricing comes at step 24, after the beta.
- `DECISION_09.md` and `MASTER_SPEC.md`, Business: the free tier keeps the complete core loop; paid plans expand depth, frequency and insight, **never** academic or competitive advantage; beta before pricing.
- `DOMAIN_MAP.md`: "Entitlements control access, never academic truth, fairness or privacy authority".
- `INVARIANTS_AND_POLICIES.md`: payment never creates privacy authority.
- `ANALYTICS_QA_RELEASE.md`: the regression test "paid entitlement does not alter CP".
- `CANONICAL_DATA_MODEL.md`: `plan`, `subscription`, `subscription_event`, `entitlement`, `entitlement_grant`.

**PM decisions for this step (15 October):**
- Foundation only: no payment provider, no prices.
- The three levers: frequency, depth and insight.
- An adult account holds a plan for one student.
- During the private beta, every student gets everything through a Beta plan.

## Built
- **The catalogue: three entitlements.**
  - `SELF_TESTS_PER_DAY` (frequency): how many tests or practice sets a student may **start themselves** each day, midnight to midnight India time.
  - `LONG_TESTS` (depth): tests of 20 or more questions (Subject 20 and 25).
  - `PARENT_REPORT_WEEKS` (insight): how many weeks of weekly reports a parent may open.
- **Plans.** No prices on any of them.
  - `FREE` is the default, which every student has: 3 starts a day, no long tests, and 4 weeks of reports.
  - `BETA`: everything included.
  - `PLUS`: everything included. It is the future paid plan; not on sale, but an administrator can grant it.
  - The database enforces exactly one default plan.
- **What a student may do** is the most generous of:
  - the FREE plan;
  - every active subscription;
  - any single-entitlement grant.

  Unlimited beats any number, and a grant only ever widens what the student has.
- **The core loop is never limited.** Only tests a student **starts themselves** count against the daily limit. Recommended practice, retests, challenges, and resuming a test already started are never limited and never counted. A free student can always choose a test, finish it, see the result, practise what they missed, and retest.
- **Enforcement points.**
  - The exam service checks the plan inside its transaction before building a NEW self-chosen test or practice set. The refusal is a plain sentence, for example "Longer tests are not included in your plan."
  - The parent page lists, and opens, only the plan's number of weeks of reports.
  - The test chooser shows "Your plan: …", how many starts are left today, and greys out long tests. The API enforces all of this either way.
- **Subscriptions.**
  - A subscription is one plan for one student, for a period.
  - **Sources:** BETA (the system), ADMIN_GRANT, or PROVIDER (reserved for a payment provider later).
  - **Who may hold one (an adult connected to the student):**
    - the student themselves, if an adult;
    - the guardian with a live approval;
    - a parent the adult student shares their summary with.
  - **Never a minor.** A BETA grant has no holder.
  - **Holding a plan gives the holder no access to anything.** Access still comes only from the guardian approval or the student's sharing consent.
  - **History:** each subscription has an append-only list of events (CREATED, EXTENDED, ENDED, EXPIRED).
  - **Outbox events:** `entitlement.subscription_created.v1` and `entitlement.subscription_ended.v1`.
- **The beta.** `BETA_GRANT_UNTIL=YYYY-MM-DD`, unset by default. While it is set and in the future, a sweeper runs every 5 minutes:
  - it gives every student a BETA plan until the end of that day (India time);
  - if the date moves later, it extends existing BETA plans;
  - the database keeps at most one active BETA plan per student.

  When the date passes, or the setting is unset, BETA plans run out on their own date and students fall back to FREE. The same sweeper ends any subscription whose period is over.
- **Administration (SUPER_ADMIN only; every action audited)** at `/admin/plans`:
  - find a student by their sign-in email;
  - see what they have;
  - grant PLUS, with an optional holder and end date and a required reason;
  - end a plan, with a reason.

  BETA and FREE cannot be granted by hand. The API also offers single-entitlement grants and revoking them. There is no page for those yet.
- **The fairness regression ("paid entitlement does not alter CP").** A unit test reads every source file of mastery, competition, recommendations, social, privacy and guardian, and of the parent claim rules. It fails if any of them mentions entitlements, subscriptions or plans. CP, mastery, labels, claims and access cannot depend on a plan.

## Assumptions and open decisions (please confirm)
1. **The free limits are provisional:** 3 self-chosen starts a day, no long tests, 4 weeks of reports. They exist now but nobody hits them while the beta runs.
2. **Frequency and depth against fair competition. This needs your decision before any paid plan goes on sale.**
   - The weekly leaderboard adds up CP across tests. A paid student with no daily limit, and with Subject 20/25 tests, can take more qualifying tests and so **earn more CP per week** than a free student.
   - The CP for any one test is identical, but the spec says paid plans give "never … competitive advantage", and today they would give some.
   - **My recommendation:** before pricing, add a CP rule that counts at most the same number of qualifying tests per day for everyone (a CP_V3), so volume beyond the free allowance earns XP but not CP. That is a change to scoring, so I have not made it.
   - During the beta everyone has the same plan, so there is no unfairness yet.
3. **Practice counts against the daily limit** when the student starts it themselves from the test chooser. Recommended practice does not count.
4. **Who may hold a plan** (above) is my rule, so that strangers cannot attach plans to children. Counsel should confirm the rules on minors and payments, and on who may pay for a child, for each jurisdiction, before a provider is added. I am not certain of the current rules in India or the UAE, and they may have changed since my training data.
5. **No prices, currency or tax** are modelled. `billing_customer_reference` and `billing_provider_reference` are not built. They come with a provider.
6. **The beta date is an environment setting,** not a database row. Changing it needs a restart.
7. **"Long" means 20 questions or more,** whatever the test design is called.

## Not built
- A payment provider, checkout, webhooks, invoices, refunds, prices, currency and tax (PM decision: later).
- Pricing pages and upgrade prompts. No "upgrade" button is shown anywhere: the refusal says only what the plan includes.
- Household plans (several students).
- Admin pages for single-entitlement grants (API only).
- The CP fairness rule in decision 2.

## Migration
One migration, `entitlements`: Prisma's DDL plus `CONSTRUCTION-018_ENTITLEMENT_MIGRATION_EXTRA.sql`. That file adds:
- **Plans:** exactly one default plan, which must be ACTIVE.
- **Fixed lists:** entitlement kinds, and subscription sources, statuses and end reasons. An ended subscription has a time and a reason.
- **The beta:** a BETA subscription has no holder, and at most one is active per student.
- **Periods:** a period ends after it starts.
- **History:** subscription events are append-only (a trigger), from a fixed list of types.
- **Grants:** a single-entitlement grant must name a real entitlement, and a revoked grant records who revoked it.
- **Seeds:** the three entitlements, and the FREE, BETA and PLUS plans. A unit test checks the seeds match the code.

## Checks done here
- **Unit tests: 66 suites, 1045 tests** (Step 17 had 1028). They cover:
  - combining plans, grants only widening, strict parsing, the start rules, India-time days, the report-history window, and the beta date;
  - the seeded SQL matching the code;
  - the fairness regression;
  - the service against an in-memory database fake:
    - FREE by default, plus active plans and grants; expired or ended ones ignored;
    - only self-chosen starts counted (recommended, challenge and yesterday's starts excluded);
    - the daily and long-test refusals;
    - admin-only, reasons, no hand-granted BETA or FREE, future end dates;
    - the holder rules: guardian and adult self allowed, minor and stranger refused;
    - ending a plan, single-entitlement grants and revoking them;
    - the beta grant, extension and expiry;
    - a malformed `BETA_GRANT_UNTIL` failing at startup;
    - the parent page listing and opening only the plan's weeks of reports.
- **Browser tests: 38 of 38 pass** (19 × phone and desktop). The new ones:
  - on Free, a long test is greyed out and three self-chosen starts use up the day, but started tests can still be finished;
  - on Beta, everything is offered with no daily limit.
- **The schema validates.** The SQL extras ran on a throwaway Postgres 16: every CHECK, index, trigger and seed.
- **Not run here:** the migration and the 2 new real-database integration tests:
  - the seeded plans → FREE limits self-chosen starts → the long-test refusal → the beta grant lifts the limits → one active beta per student → the history refuses edits;
  - an administrator grants PLUS held by the adult student → others are refused → a minor cannot hold a plan → a guardian can, and gains no access from it → ending the plan restores FREE → events and audit rows recorded.
