# Step 22b: the blueprint content the app did not have

Source: the approved Step 1 blueprint, and Step 22a's open item 3, which listed what 22a left out because it needed data or behaviour, not styling.

**PM instruction (18 October):** "start 22b". The two 22a decisions stay as they were: mastery is shown as labels (never percentages), and the app is dark only.

## Built
- **Home: "This week's ranking"** (the blueprint's Home board).
  - **What it shows:** the whole-cohort board of the week. Either your rank, out of how many, and your points; or what you still need to appear, in the same words as Compete (for example "0 CP so far. To appear, take 2 more tests with 20 more counted questions.").
  - **Freshness:** while a just-finished test is still being counted, the card says so.
  - **Where:** beside "Next for you" on desktop, as on the blueprint, and under it on phones.
  - **When:** shown only when the student's curriculum and grade are open. It uses the existing Compete data, so no API change.
- **The result: a ranking note** (the blueprint's Result board).
  - **What it says:** whether this test counts towards the ranking, and, once it has been counted, the student's rank or what they still need.
  - **Practice:** it says practice does not count.
  - **Tests that don't count:** a test that does not count (for example, questions seen before) says so.
- **The question screen:**
  - **"Save and leave"** at the top (the blueprint's Runner board), back to Home.
  - **A line under the buttons:** locked answers are kept, and the test can be finished from Home or Tests before it expires (the date and time are shown).
- **"Before you submit": a tile for each question** (the blueprint's Summary board): solid for answered, dashed for not answered, crossed out for removed.
  - Each tile also has a screen-reader name ("Question 1: not answered").
  - **API change:** the summary now carries one entry per question, in order, with only what the student already knows: answered, not answered or removed. It never says whether an answer is right; a real-database test checks that.
- **Choose a test: a grid of subjects** (the blueprint's Choose a test board).
  - Pick one subject, then Test or Practice, then that subject's tests.
  - **The mode line:** a line explains the chosen mode, including that practice does not count towards the ranking.
  - **From Home:** Home's "Tests in Chemistry" opens the page with Chemistry chosen.

## Assumptions and open decisions (please confirm)
1. **One subject at a time on Choose a test,** as on the blueprint.
   - **What changes:** before, every subject's tests were listed together; now the student picks a subject first.
   - **Browser tests:** two were changed to pick the subject first. Their checks are the same, just per subject:
     - Focus 10 only where chapters are chosen;
     - the Free plan's limits.
2. **"Save and leave" doesn't lock a chosen but unlocked answer.** That's deliberate, because locking can't be undone. The line under the buttons says only locked answers are kept.
3. **The ranking card shows the whole-cohort board only.** The per-subject boards stay on Compete.

## Not built
Nothing from the blueprint list is left. The two standing decisions from 22a remain yours: percentages (the spec forbids them, so labels stay) and a light theme (none).

## Migration
None. The API change is one new field in a response.

## Checks done here
- **API:** 80 suites, 1208 unit tests, and the typecheck (with tests) is clean.
  - **New:** the tiles domain test (order, answered or not, removed, nothing about correctness), and tile checks in the service test.
  - **One real-database integration test is extended:** ten answered tiles, and no "correct" anywhere in the summary. It's not run here.
- **Web:** the typecheck is clean, and 70 of 70 browser tests pass (35 × phone and desktop).
  - **One new test:** the Home ranking card; Save and leave (going Home, then continuing the test); the tiles; the result's ranking note; and Home's "Tests in Chemistry" opening with Chemistry chosen.
  - **Two tests changed** for the subject grid (item 1).
- **Screenshots:** at phone and desktop sizes I compared Home, Tests, a question, before you submit and the result against the blueprint boards.
