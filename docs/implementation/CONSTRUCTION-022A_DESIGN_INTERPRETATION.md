# Step 22a: the whole web app on the approved Step 1 blueprint

Source: the "Exam App Student Web Blueprint" design canvas (Step 1). It has 14 student screens, and Alfred approved it on 13 October 2026.

**PM instruction (17 October):** "check if the entire app follows this design principle, if not apply to all".

## What the audit found
The app and the blueprint already shared their colours, but much of the rest had drifted:
- **Navigation:** a row of text tabs, and no icons.
- **Desktop:** no sidebar; every page was a 560px column.
- **Sizes:** 48px controls and 14px cards, where the blueprint has 52px and 16px.
- **Cards:** the Next card had no feature style, and "coming soon" cards weren't dashed.
- **Onboarding:** sign-in showed no step bar, and the forms sat inside cards.
- **Tests:** a plain radio list for answers and a single progress bar, with no score card or outcome pills.
- **Colours:** Progress labels used other colours, and the app switched to a light theme automatically, which the blueprint doesn't have.

## Built
- **Design tokens** in `globals.css`, taken from the boards:
  - background `#0b1020`, surface `#131b33` / `#1a2442`, navigation `#0f1730`, border `#2a3558`;
  - text `#e9edf9`, muted `#a3aed0`;
  - accent `#3dd9b0` (text on it `#052019`), blue `#5b8cff`;
  - selection `#16314a` with `#2f7f74`, amber `#e0a85a`, incorrect `#c0566f` / `#ffb3c2`;
  - corners: 16px cards, 20px feature cards, 12px controls, 14px rows; 52px control height.
- **Dark only,** as on the blueprint. The automatic light theme is removed (decision 2 below).
- **Navigation:**
  - phones: a bottom tab bar with the blueprint's icons (Home, Test, Progress, Compete, Profile), the current tab in teal;
  - from 1024px: a 240px sidebar with the brand, and the page beside it.
- **Controls:** 52px buttons and inputs.
  - Primary buttons are filled teal, secondary ones are outlined, and disabled ones are grey (as with the blueprint's Lock answer button).
  - The code field uses large spaced digits.
- **Cards:**
  - surface cards;
  - the gradient feature card for "Next for you" on Home and for the score;
  - dashed cards for "Coming soon";
  - 13px uppercase labels above titles.
- **Onboarding:** the 4-step bar starts on sign-in, the forms sit on the page (no card), and the date-of-birth screen has the privacy note.
- **Taking a test:**
  - one bar segment per question;
  - the stem in 22px bold;
  - answers in 60px rows with lettered circles A to D. The circle is the radio button itself, so keyboard use and screen readers are unchanged.
  - the chosen answer in teal; after a practice answer, the right one teal and a wrong choice red.
- **Before you submit:** two number tiles, answered and not answered yet.
- **Result:** the score card ("Your score"), then a "By difficulty" card with bars.
- **Review:** pills for Correct and Incorrect; options lettered, the right one teal and a wrong choice red; the explanation under "Why".
- **Progress:** label colours as on the blueprint: Strong teal, Developing blue, Needs attention amber. The words still carry the meaning.
- **Compete:** leaderboard rows as on the blueprint, with your own row highlighted.
- **Staff pages:** the same tokens on a wider page (1040px), and a grid of cards on the admin home. These pages aren't on the blueprint, so this is my extension of it.
- **Parent and guardian pages:** the same tokens and components. These aren't on the blueprint either.
- **Behaviour is unchanged:** every label, role and accessible name the browser tests rely on is kept, and all 68 browser tests pass unchanged.

## Assumptions and open decisions (please confirm)
1. **Percentages: the spec wins over the blueprint.**
   - **What the blueprint shows:** "Mastery [NN]%" and percentage bars on Progress and on the desktop Home.
   - **Why the app doesn't:** Step 13 and the spec forbid it (mastery is a gated label, "Unknown never renders 0%"), so the app keeps the labels and shows no percentage or mastery bar.
   - **What does have bars:** only the score by difficulty on a result, which is a count of answers, not mastery.
2. **No light theme.** The blueprint is dark only, so I removed the automatic switch to light when a device prefers it.
   - **For the light theme:** some families and schools may want it; it would need a light board added to the blueprint first.
   - **Please decide.**
3. **Content on the blueprint that the app doesn't have.** These need data or features, not styling, so I didn't invent them:
   - Home's "This week's ranking" card (rank and points), and the ranking note on a result;
   - the tile for each question on "Before you submit" (solid locked, dashed skipped): the API gives only counts;
   - the runner's "Save and leave" link. Leaving works through the navigation and "Continue" on Home, but there's no button for it;
   - Choose a test as a grid of subjects with a mode switch. The app lists each subject's tests with the Test or Practice switch above.

   Tell me which you want, and I'll build them as a small step.
4. **Places the blueprint is superseded:**
   - **Compete:** the board shows "Friends: Coming soon", but Step 16 built Friends (switched off by default), so the real section stays.
   - **Guardian screen:** the board marked the verification method "pending legal advice". The app shows the email-link wording built in Step 10, which is still pending counsel.
5. **I compared screenshots, not pixels:** I took screenshots at phone (Pixel 7) and desktop (1280px) widths and compared them with the boards by eye. Placeholder text on the boards (`[N]`, `[Name]`) is not a specification.

## Not built
- The blueprint content listed in item 3.
- A light theme (item 2).

## Migration
None.

## Checks done here
- Web typecheck: clean.
- **Browser tests:** 68 of 68 pass (34 × phone and desktop), with no test changed.
- **Screenshots:** on phone and desktop I compared these screens against the boards:
  - welcome, sign-in, Home, Tests, a question, before you submit, result and review, Progress, Compete, Your data;
  - the admin home, a curriculum subject, the Questions page and readiness;
  - the guardian and parent pages.
- No API change, so the API tests are unaffected.
