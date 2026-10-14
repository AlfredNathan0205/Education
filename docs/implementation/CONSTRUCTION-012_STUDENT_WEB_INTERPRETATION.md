# Step 12: Student web vertical slice

Spec: `STUDENT_WEB.md`.
- Journey: Welcome → Account → Student Profile → Curriculum/Grade → School → Ready → Home → Choose/Recommended Test → Runner → Results → Review → Practice → Retest → Progress → Compete.
- Home: the Next Best Action comes first.
- Navigation: Home / Test / Progress / Compete / Profile.
- First experience: subject plus studied chapters, then a diagnostic-balanced test, with the message "Building your mastery profile".
- Unsupported cohorts are Coming Soon or hidden, never silently substituted.

Earlier blocks already built Welcome, Account and Profile (CONSTRUCTION-004), Curriculum/Grade, School and chapters (Step 5), and the Runner, Results and Review (exam block). This step joins them into one journey. Decisions taken with the PM on 14 Oct 2026:
- Progress and Compete get honest placeholders.
- FOCUS10 is seeded, published and switched on.
- A Playwright suite runs in CI.

## Built
- **Only the student's own curriculum and grade.**
  - `GET /exam/units` now lists only subjects of the student's curriculum and grade (Step 5 academic context), and nothing until they have chosen one.
  - Creating a test for another cohort is refused, so a student is never given another grade's questions.
  - Before this, every served subject was offered to everyone.
- **`GET /home`** returns, in one call:
  - the display name and cohort;
  - whether the cohort is supported;
  - the **next best action**;
  - the subjects, each with its tests, chosen chapters, last result and number finished;
  - open tests.

  It uses the same gate as tests: profile, age and consent.
- **Next best action.** A fixed, explainable order (`home-domain.ts`):
  1. resume an open test;
  2. finish the profile;
  3. Coming soon;
  4. not ready (questions still being prepared);
  5. **first test**: "Building your mastery profile", a TEST, on a subject with chosen chapters first, using Focus 10 when chapters are chosen, otherwise Quick 10;
  6. a subject never tested;
  7. the subject tested longest ago.

  Practice does not count as having tested a subject. Step 14 replaces rules 6 and 7 with evidence from mastery.
- **FOCUS10 seed** (`CONSTRUCTION-012_STUDENT_WEB_MIGRATION_EXTRA.sql`, the whole of an otherwise empty migration).
  - 10 questions, 5/3/2, from the student's chosen chapters, opening with an easy one.
  - Loose scope: it widens to the whole subject only when the chapters hold too few questions, and the assembly run records the widening.
  - Published and switched on.
- **Web.**
  - Main navigation for signed-in students: a bottom bar on phones, a row on wider screens, with `aria-current`.
  - **Home**: next best action card, "Also in progress", subject cards with last result, chosen chapters and a link to the subject's tests.
  - **Test**: Test/Practice switch, and per subject the tests it offers. Focus 10 is offered only once chapters are chosen; otherwise there is a "Choose your chapters" link. Coming soon for an unsupported grade, with "we will not give you questions from a different curriculum or grade". The Recent list stays.
  - **Progress**: results per subject, with "Building your mastery profile". **No percentage is shown anywhere** (Score ≠ Mastery).
  - **Compete**: Coming soon. The copy says points come from tests and never change mastery.
  - Sign-in sends returning students Home and new accounts to their profile. The profile's Ready step leads Home. A signed-in visit to Welcome goes Home. The runner's result and ended screens link Home.
  - Links now use the accent colour instead of browser blue.
- **Browser tests** (`apps/web/e2e`, Playwright, phone and desktop sizes, against `e2e/stub-api.mjs`, an in-memory stand-in that follows the API's shapes).
  - The full first-test journey: sign in → Home → Quick 10 → skip and revisit → submit → result and review → back Home to the next action.
  - Progress shows no percentage; Compete is Coming soon.
  - Focus 10 is offered only where chapters were chosen.
  - An unsupported grade gets Coming soon with no test buttons.
  - A new account goes to its profile.
  - Redirects when signed in or out.
  - New CI job `web-e2e`.

## Assumptions and open decisions (please confirm)
1. **The cohort is what the student said** (Step 5's academic context, not verified). A student can change their grade in Profile and then sees that grade's subjects. Their earlier results stay.
2. **The first test is a TEST, not Practice.** It measures; Practice teaches.
3. **Rule order for the next best action** (above). It is a placeholder until mastery and recommendations exist (Steps 13–14), and it says so in its reasons.
4. **Home and history read the last 20 attempts** (the existing `listMine` limit). Enough for "first test" and "tested longest ago" at beta scale. Progress will read mastery, not this list.
5. **Leaderboard and Challenges are absent from Home**, not placeholders. They appear when Steps 15 and 16 exist (Home priority order in the spec).
6. **FOCUS10 has the same 5/3/2 mix as Quick 10.** "Diagnostic-balanced" is read as spread across chapters, objectives and cognitive levels (the Step 10 engine already does this), not as a different difficulty mix.

## Not built
- Practice/Retest flows beyond the existing Practice mode (Step 14).
- Mastery on Progress (Step 13).
- Leaderboards and challenges (Steps 15–16).
- An automated accessibility audit (axe) and a throttled-network test. Labels, focus, 48 px targets and reduced motion follow the earlier pages, but there is still no screen-reader pass.

## Checks done here
- **API unit tests**: 51 suites, 891 tests (Step 11 had 49 / 876). New tests cover cohort gating, the next-best-action rules, the Home service and controller, and the history fields.
- **Typecheck** is clean (API, apart from the known Prisma-untyped codes; and web). `next build` passes.
- **Browser tests: 12 of 12 pass here**, run twice, in Chromium at phone and desktop sizes. The sandbox used an npm-packaged Chromium through `PW_CHROMIUM_PATH`; CI installs Playwright's own.
- **Screenshots** of Home, Test, the runner and Progress were checked at both sizes.
- **FOCUS10 seed SQL** was run on a throwaway Postgres after the Step 10 seeds.
- **Not run here:** the migration, the 2 new real-database integration tests (cohort gating and Home through a first Focus 10 test), and the web against the real API.
