# Step 19: Analytics and an experiments foundation

Spec sources:
- `ANALYTICS_QA_RELEASE.md`:
  - **North Star:** weekly active learners completing a qualified assessment.
  - **Intensity:** qualified assessments per active learner.
  - **Also track:** activation, completion, weekly frequency, D7/D30 return, review → practice → retest, improvement, parent engagement, and competition.
  - **Do not optimise for screen time.**
- `DOMAIN_MAP.md` 19: downstream, pseudonymous analytics and experiments.
- `DECISION_10.md` 10M.
- `INVARIANTS_AND_POLICIES.md`:
  - no sale of identifiable learner data, and no targeted child ads;
  - consent is purpose- and version-specific;
  - no real child data in development, test or staging;
  - privileged access is audited.
- `CANONICAL_DATA_MODEL.md`: `analytics_event`, `experiment`, `experiment_variant`, `experiment_assignment`.

**PM decisions for this step (15 October):**
- **Sources:** server events plus a few client events.
- **Audience:** an internal admin page only.
- **Consent:** a **separate analytics consent**. A minor's approving guardian decides; adults decide for themselves.
- **Experiments:** a foundation now.

## Built
- **Consent first.**
  - A new consent purpose, `PRODUCT_ANALYTICS`, is off unless agreed, with DRAFT wording (refused in production until counsel-reviewed wording is published).
  - **Who decides:**
    - an adult student decides on Progress ("Help improve Exam App"), after reading what is collected;
    - for a minor, the approving guardian decides on the guardian page, under their guardian authority, and the minor is told which way it is set.
  - **When it applies:** an event is recorded only if the consent is valid at that moment. Nothing from before consent is backfilled.
  - **Withdrawing deletes everything held about the student:** their analytics events and experiment assignments. This happens at once from the page, and again by the projector, which sees every withdrawal of this purpose from any route.
- **Pseudonymous rows.** `analytics_event` holds:
  - a 32-character HMAC of the student id under a secret key (`ANALYTICS_PSEUDONYM_KEY`, required in production);
  - an event name from a fixed list;
  - a time;
  - a coarse cohort code ("ICSE/GRADE_8");
  - allow-listed properties: booleans, small numbers, codes.

  No ids, names, scores, answers or free text. The database itself refuses an unknown event name, a raw id as the subject, non-object properties, and a cohort that isn't codes.
- **Server events,** projected every 30 seconds from the existing outbox by a cursor. The projector waits 10 seconds so a transaction still committing isn't missed, and records each outbox event at most once.
  - SIGNED_UP: dated when the student was created, recorded when they consent.
  - ASSESSMENT_STARTED: mode, design, and whether it came from a recommendation.
  - ASSESSMENT_COMPLETED: mode and how it ended, with no score.
  - QUALIFIED_TEST: the first CP award of a test.
  - RECOMMENDATION_STARTED and RECOMMENDATION_COMPLETED: the kind.
  - MASTERY_UPDATED: how many objectives' gated labels rose.
  - PARENT_SHARING_STARTED.
  - PARENT_VIEWED: recorded directly by the parent page, for the student's consent, not the parent's.
  - A bad event is logged and skipped, so analytics never holds anything up.
- **Client events** (5): RESULTS_OPENED, PRACTISE_MISSED_CLICKED, PROGRESS_OPENED, PARENT_PREVIEW_OPENED, COMPETE_OPENED.
  - The web app fires them and forgets them. The API answers 204 whether or not the event was kept.
  - At most 200 per student per day.
  - **No page views, durations, scrolls or timings: no screen-time measure exists.**
- **Metrics page** at `/admin/metrics` (SUPER_ADMIN; every view audited). By week, for the last 8 weeks (Monday, India time):
  - the North Star and intensity;
  - learners completing anything; started, completed, and the completion rate;
  - new learners, and how many finished a test within 7 days (activation);
  - the practice loop: results opened, "practise what you missed" clicked, recommended practice started, retests completed;
  - objectives improved, on gated labels only;
  - parent views, and the students whose parent looked.

  It also shows D7 and D30 return, counting only learners old enough to know. **Every count under 5 shows as "<5",** and rates and intensity are hidden below 5. The page says how many students consent, so the bias is visible.
- **Experiments foundation.**
  - Experiments go DRAFT → RUNNING → STOPPED, with 2–6 weighted variants and exactly one control. The database enforces one control, and that an assignment names a real variant.
  - **Assignment** is a stable weighted hash of the pseudonym, recorded once. Students without analytics consent, or experiments that are not running, always get the control and are never recorded.
  - **Admin API:** create, start, stop and list, with variant counts under 5 hidden. There is no admin page yet, and **nothing assigns anyone yet**.
- **The kill switch:** `ANALYTICS_ENABLED=false` stops all recording.

## Assumptions and open decisions (please confirm)
1. **Counsel:**
   - the analytics wording (DRAFT);
   - that a guardian's analytics consent for a minor is valid in each jurisdiction;
   - that the pseudonymous store with deletion on withdrawal meets the requirements;
   - the retention period. No automatic expiry is built yet.
2. **Bias.** Only consenting students are counted. Minors count only if their guardian agrees. The metrics will under-count and may be skewed towards engaged families. The coverage line on the page shows how many students are included.
3. **Consent has no backfill.** Events before consent are never recorded, so activation and return rates for students who consent late are partial.
4. **Definitions are mine:**
   - **qualified:** the test earned CP;
   - **activation:** a test completed within 7 days of creation;
   - **D7:** another completed test 7–13 days after the first;
   - **D30:** another completed test 30–36 days after the first;
   - **improvement:** gated label rises.
5. **The pseudonym key.** Rotating `ANALYTICS_PSEUDONYM_KEY` starts everyone over, and old rows can no longer be deleted on withdrawal. Rotation needs a migration step, which doesn't exist yet.
6. **The parent-view event** is counted under the student's consent, never the parent's: the parent is not an analytics subject.

## Not built
- A third-party analytics tool or any export (PM decision: an internal page only).
- An admin page for experiments, and anything that uses an assignment.
- `experiment_result` (results come from the metrics, per experiment, when one runs).
- Automatic retention or expiry of analytics rows.
- Competition and content-quality dashboards beyond the qualified-test count. Content quality already lives in the question bank pages.

## Migration
One migration, `analytics`: Prisma's DDL plus `CONSTRUCTION-019_ANALYTICS_MIGRATION_EXTRA.sql`.

**A fix to Step 18 is included.** Step 18's extra SQL added a foreign key (`entitlement_grant_key_fkey`) that the Prisma schema did not declare, so this step's generated migration tried to drop it as unknown. The relation is now declared in the schema, with the same name and actions, so Prisma keeps it.
- **Rule from now on:** foreign keys go in the schema, never in the extra SQL. CHECKs, partial indexes, triggers and seeds stay in the extra SQL, because Prisma ignores them.
- **Applied here:** the analytics assignment → variant key is declared in the schema too.

The extra SQL adds:
- **Pseudonymous rows:** a 32-hex pseudonym, event names from the two fixed lists (a unit test checks they match the code), object-only properties, and code-only cohorts.
- **Experiments:** statuses with their times, keys and weights, one control per experiment (a partial unique index), and assignments that must name a variant of their own experiment.
- **A single projector cursor.**
- **The consent purpose `PRODUCT_ANALYTICS`,** with draft wording v1.

## Checks done here
- **Unit tests: 68 suites, 1064 tests** (Step 18 had 1045). They cover:
  - **the rules:**
    - pseudonyms;
    - the property allow-list;
    - the event mapping, including forget on withdrawal and sign-up on consent;
    - gated improvement counts;
    - no screen-time event, and the SQL lists matching the code;
    - the production key and the switch;
    - every weekly metric, D7 return and suppression;
    - variant validation, and stable, weighted assignment.
  - **the service, against an in-memory fake:**
    - recording only with consent, pseudonymously;
    - client events: the fixed list, the daily cap, and the silent drop;
    - the projector: in order, after the settling delay, once only, the sign-up date, no scores, the improvement count, and forget on withdrawal;
    - an adult's consent: wording version, grant, off-and-delete;
    - a minor's guardian deciding under their authority, the minor refused, a stranger refused;
    - metrics: admin-only, audited, suppressed;
    - experiments: draft, start, stop, control without consent, a stable variant.
- **Browser tests: 42 of 42 pass** (21 × phone and desktop). The new ones:
  - an adult: nothing kept before agreeing; reads, agrees, and an event is kept; turning it off deletes;
  - a minor is told the guardian decides; the guardian reads what is collected, allows it, and the minor sees it set.
- **The schema validates.** The SQL extras ran on a throwaway Postgres 16: every CHECK, index and key, plus the seed.
- **Not run here:** the migration and the 2 new real-database integration tests:
  - an adult: nothing before consent, pseudonymous events after, no ids or scores, once only, the database refusing bad rows, admin totals hidden under 5, and deletion on withdrawal;
  - a minor's guardian consenting under their authority, the minor refused, a stable experiment variant, and deletion of the assignment on withdrawal.
