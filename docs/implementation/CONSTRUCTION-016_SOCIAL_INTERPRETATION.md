# Step 16: Friends and ranked challenges (controlled activation)

Spec sources:
- `COMPETITION_CHALLENGES.md`:
  - A Ranked Challenge requires the same grade and a compatible curriculum, scope and equivalence. Exact or equivalent challenge sets respect exposure and bank readiness.
  - The opponent's answers and progress are hidden until completion. No CP loss, wagering, paid entry or purchasable advantage.
  - Minor defaults: Friends Only, no free chat or custom taunts, a safe public profile ID, rate limits, block and report.
  - Friends and Ranked Challenge start CONTROLLED (feature-flagged).
- `MASTER_SPEC.md`: no unrestricted child chat, and no public academic weakness.
- `CANONICAL_DATA_MODEL.md`: the Friends and Challenges tables.

**PM decisions for this step (15 October):**
- Minors add friends only with an in-person code, and each new friendship also waits for the guardian's approval.
- Block and report go to an admin queue, and a report ends the friendship at once.
- The feature is off by default.

## Built
- **The switch:** `SOCIAL_FEATURES_ENABLED`, off by default. While it is off, every social route (student, guardian and admin) answers 404, `GET /social` returns `{ enabled: false }`, and the web app shows no Friends section.
- **Friends by an in-person code.**
  - A student shows a one-time 6-character code from an alphabet without look-alike characters. It works once and expires in 15 minutes.
  - The other student types it in. There is no search, no directory and no friend request from strangers.
  - Rate limits: 5 codes an hour, and 10 wrong codes an hour. A wrong code is recorded outside the request's transaction, so the limit holds even though the request fails.
  - A blocked or restricted pair gets the same answer as a wrong code, so nothing is revealed.
- **Guardian approval.**
  - When either student is a minor (no age classification counts as a minor), the friendship is PENDING_GUARDIAN until the guardian of each minor approves it. One decline ends it.
  - Guardians see the requests on the guardian page ("Friend requests to approve"): their child's name, and the other student's handle only.
  - Only a guardian with a live guardian approval for that child may decide.
  - Every decision is audited.
- **No free text anywhere.** Handles are generated (the Step 15 handles), reports are a choice from a fixed list, and there is no chat. The database itself refuses a report reason outside the list.
- **Block:** takes effect at once and works both ways. It ends the friendship and cancels any open challenge between the two.
- **Report:** one of 5 reasons. It ends the friendship at once (PM decision), cancels open challenges, and opens a report in the admin queue.
- **Admin queue** (`/admin/safety`, SUPER_ADMIN only for now; every view is audited):
  - shows the reason, both handles and student ids, how many open reports the reported student has, and whether they're already restricted;
  - can close a report with no action, or restrict the student from all friends and challenges, which also cancels their open challenges.
- **Ranked challenges:**
  - **Who:** only between ACTIVE friends of the same curriculum and grade, in a subject of their cohort.
  - **Limits:** one open challenge per pair and subject (enforced by a database index, whichever way round), and at most 10 sent a day.
  - **Exposure (spec):** the question set uses only questions neither player has been shown. With fewer than 10 such questions it refuses ("not yet 10 questions … that neither of you has seen") rather than reuse any.
  - **Same test for both:** both players get exactly the same 10 questions (a 5/3/2 mix) in the same order with the same option order, so a challenge is a fair comparison.
  - **Starting:** the challenger may start at once. The opponent accepts, which also starts their test, or declines. Challenges expire after 48 hours.
  - **Hidden progress:** the other player's progress and answers stay hidden until both have finished. Then both scores and a win, loss or draw are shown. More correct answers wins; speed plays no part.
  - **CP:** a challenge test earns CP like a Quick 10, through a new **CP_V2** policy (CP_V1 plus `CHALLENGE10` up to 100). CP_V1 is retired by the migration. There is no win bonus and no CP loss. Mastery treats it as an ordinary 10-question test (context 0.9).
- **Web.**
  - **Compete:** a Friends section (show my code; add a friend; per friend: Challenge, Remove, Block, Report) and a Challenges section (Accept and start, Decline, Start or Continue, results once both have finished). It shows nothing when switched off, and says plainly when the account is restricted.
  - **Guardian page:** a "Friend requests to approve" section.
  - **Admin page:** `/admin/safety`.
- **Outbox:** `social.friendship_created`, `social.friendship_ended`, `social.report_created`, `social.challenge_created`, `social.challenge_accepted` and `social.challenge_declined` (all v1).

## Assumptions and open decisions (please confirm)
1. **The guardian-approval rule and the in-person code** are your decision. **Counsel should confirm them** for each jurisdiction, along with whether the guardian also needs to approve challenges, or see their child's friends and challenges later. Guardians have no view of challenges today.
2. **The safety reviewer is SUPER_ADMIN** until a dedicated role exists. Who reviews reports, and the response time, are **operating decisions to make before beta**. Nothing alerts anyone to a new report yet; the admin page has to be checked.
3. **Report reasons** (5 fixed codes) and the two outcomes (no action, or restrict from all social features) are mine. Restriction has no end date; lifting it is a database change for now.
4. **The numbers** are provisional: code length and lifetime, rate limits, 48-hour expiry, 10 a day, and the 5/3/2 mix.
5. **Friendships between cohorts are allowed,** but challenges are not. Social (cross-grade, zero-CP) challenges are not built: there is only one cohort today.
6. **A report ends the friendship** but does not block. The reporter can block separately.
7. **Strict exposure.** Challenges refuse rather than reuse seen questions. In a small bank, two active students will soon be unable to challenge in a subject. This is correct by the spec, but it makes bank size a launch dependency for challenges.

## Not built
- Social (cross-grade) challenges; challenge leaderboards; a challenge win bonus.
- A guardian's view of their child's friends and challenges; parental controls to switch friends off.
- Notifications (email or push) for codes, challenges or reports.
- Lifting a restriction from the admin page; an appeal path.
- Rate limits at the HTTP layer (these are per-student counts in the database).

## Migration
One migration, `social`: Prisma's DDL plus `CONSTRUCTION-016_SOCIAL_MIGRATION_EXTRA.sql`. That file adds:
- **Indexes:** at most one open friendship per pair, and at most one open challenge per pair and subject (either way round).
- **Pairs:** the pair is stored in order, never a pair with oneself.
- **Status consistency:** an ended friendship has an end time; approval and report statuses are consistent.
- **Fixed vocabularies:** report reasons, resolutions and participant roles.
- **Policies:** CP_V1 is retired and CP_V2 seeded.

## Checks done here
- **Unit tests: 62 suites, 1002 tests** (Step 15 had 982). They cover:
  - the codes, guardian decisions, block and restriction logic, challenge rules and outcomes, and CP_V2 matching the seeded SQL;
  - the service against an in-memory database fake:
    - the switch;
    - friends by code, with a code working once;
    - a minor waiting for the guardian, approval and decline, and a stranger refused;
    - wrong codes counted and limited;
    - the code limit, and a blocked pair answered like a wrong code;
    - report ending the friendship, cancelling challenges and queueing; admin-only queue; restriction stopping social use;
    - block;
    - the same ten unseen questions for both, hidden progress, the result only when both finish;
    - refusing when too few unseen questions exist (including ones only the opponent has seen);
    - a pending friendship not challengeable, and decline.
- **Browser tests: 28 of 28 pass** (14 × phone and desktop). The new ones:
  - add a friend by code (and a wrong code), challenge, and start the challenge test;
  - a minor waiting for a guardian with no Challenge button, and reporting from a list;
  - switched off, there is no Friends section.
- **The schema validates.** The SQL extras were run on a throwaway Postgres 16: every index and CHECK, the CP_V1 to CP_V2 swap, and the hole where a NULL resolution slipped past a CHECK, found and closed.
- The friends section was checked by eye at phone width. That check fixed an unstyled code box, the "under 18" wording (the age threshold comes from policy), and Remove, Block and Report getting as much visual weight as Challenge.
- **Not run here:** the migration and the 2 new real-database integration tests:
  - friends by code → a challenge on the same ten unseen questions → hidden until both finish → result → CP_V2 earned by both, none lost;
  - a minor waiting for the guardian → approval (audited) → report ends it and queues it → admin restricts → social use refused → the database refuses free-text reasons and self-friendship.
- The Step 15 integration tests are updated: CP_V2 is now the active policy.
