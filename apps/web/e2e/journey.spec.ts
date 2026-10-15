import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  await request.post(`http://127.0.0.1:${process.env.STUB_API_PORT ?? 4010}/__reset`);
});

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: /code/i }).click();
  await page.getByLabel('6-digit code').fill('123456');
  await page.getByRole('button', { name: /sign in|verify|continue/i }).click();
}

test('a returning student lands Home, takes a first test, sees the result and the review', async ({ page }) => {
  await signIn(page, 'student@example.com');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Hi, Asha' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

  // First experience: no chapters chosen, so Quick 10 on the first subject alphabetically.
  await expect(page.getByRole('heading', { name: 'Building your mastery profile' })).toBeVisible();
  await page.getByRole('button', { name: 'Start Quick 10' }).click();
  await expect(page).toHaveURL(/\/tests\/[0-9a-f-]{36}$/);

  // Skip question 1, answer 2..10, then come back to 1 once.
  await expect(page.getByText('Question 1 of 10')).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();
  for (let q = 2; q <= 10; q++) {
    await expect(page.getByText(`Question ${q} of 10`)).toBeVisible();
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Lock answer' }).click();
  }
  await expect(page.getByRole('heading', { name: 'You have reached the end' })).toBeVisible();
  await page.getByRole('button', { name: 'Review skipped questions' }).click();
  await expect(page.getByText('a question you skipped')).toBeVisible();
  await page.getByRole('radio').nth(0).check();
  await page.getByRole('button', { name: 'Lock answer' }).click();
  await page.getByRole('button', { name: 'Submit' }).click();

  // The stub's key is option (position-1) % 4, so "first option" is right for questions 1, 5 and 9.
  await expect(page.getByRole('heading', { level: 1, name: '3 of 10' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Question 1', exact: true })).toContainText('Correct');
  await expect(page.getByRole('region', { name: 'Question 2', exact: true })).toContainText('Incorrect');

  await page.getByRole('link', { name: 'Back to Home' }).first().click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { name: 'Take a Physics test' })).toBeVisible();
  await expect(page.getByText('3/10')).toBeVisible();
});

test('Progress shows gated labels by chapter and objective, never a percentage; Compete has this week\'s boards', async ({ page }) => {
  await signIn(page, 'student@example.com');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Progress' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();
  const chem = page.getByRole('region', { name: 'Chemistry' });
  await expect(chem).toContainText('0 of 4 objectives with enough evidence');
  await chem.getByText('Chemistry chapter 1').click();
  await expect(chem.getByText('Objective 1.1')).toBeVisible();
  await expect(chem.getByText('Not started').first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText('%');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Compete' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Compete' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All subjects · ICSE Grade 8' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Compete' })).toHaveAttribute('aria-current', 'page');
});

test('after a test, its chapter shows Building evidence, not a low label', async ({ page }) => {
  await signIn(page, 'student@example.com');
  await page.getByRole('button', { name: 'Start Quick 10' }).click();
  for (let q = 1; q <= 10; q++) {
    await expect(page.getByText(`Question ${q} of 10`)).toBeVisible();
    await page.getByRole('radio').nth(1).check();
    await page.getByRole('button', { name: 'Lock answer' }).click();
  }
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /of 10/ })).toBeVisible();
  await page.goto('/progress');
  const chem = page.getByRole('region', { name: 'Chemistry' });
  await expect(chem.getByText('Building evidence').first()).toBeVisible();
  await expect(chem).not.toContainText('Needs attention');
  await expect(chem.getByRole('link', { name: /of 10 · test/ })).toBeVisible();
});

test('a student who chose chapters is offered Focus 10 first', async ({ page }) => {
  await signIn(page, 'focus@example.com');
  await expect(page.getByRole('button', { name: 'Start Focus 10' })).toBeVisible();
  await expect(page.getByText(/Start with Focus 10 in Physics/)).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Test' }).click();
  await expect(page.getByRole('button', { name: 'Focus 10 test' })).toHaveCount(1); // only Physics has chapters chosen
  await page.getByRole('button', { name: 'Practice', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Quick 10 practice' })).toHaveCount(2);
});

test('an unsupported grade is Coming soon, with nothing substituted', async ({ page }) => {
  await signIn(page, 'soon@example.com');
  await expect(page.getByRole('heading', { name: 'Coming soon' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Test' }).click();
  await expect(page.getByRole('heading', { name: 'Coming soon' })).toBeVisible();
  await expect(page.getByText(/not give you questions from a different curriculum or grade/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Quick 10/ })).toHaveCount(0);
});

test('a new account goes to its profile, not Home', async ({ page }) => {
  await signIn(page, 'new@example.com');
  await expect(page).toHaveURL(/\/profile$/);
});

test('signed out, Home sends you to sign in; signed in, the welcome page sends you Home', async ({ page }) => {
  await page.goto('/home');
  await expect(page).toHaveURL(/\/sign-in$/);
  await signIn(page, 'student@example.com');
  await expect(page).toHaveURL(/\/home$/); // the session cookie is set once sign-in finishes
  await page.goto('/');
  await expect(page).toHaveURL(/\/home$/);
});

// ── Step 14: practise what you missed, then retest ─────────────────────────

async function finishTest(page: Page, answerSlot = 1) {
  for (let q = 1; q <= 10; q++) {
    await expect(page.getByText(`Question ${q} of 10`)).toBeVisible();
    await page.getByRole('radio').nth(answerSlot).check();
    await page.getByRole('button', { name: 'Lock answer' }).click();
  }
  await page.getByRole('button', { name: 'Submit' }).click();
}

test('after a test: practise what you missed, then Home offers a retest', async ({ page }) => {
  await signIn(page, 'student@example.com');
  await page.getByRole('button', { name: 'Start Quick 10' }).click();
  await finishTest(page);
  await expect(page.getByRole('heading', { level: 1, name: /of 10/ })).toBeVisible();

  await page.getByRole('button', { name: 'Practise what you missed' }).click();
  await expect(page).toHaveURL(/\/tests\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Practice · Question 1 of 10')).toBeVisible();
  // Practice shows the answer after each question.
  for (let q = 1; q <= 10; q++) {
    await expect(page.getByText(`Question ${q} of 10`)).toBeVisible();
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Lock answer' }).click();
    await expect(page.getByText(/^(Correct\.|Not quite\.)/)).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText('Home will offer a short retest')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Practise what you missed' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Back to Home' }).click();
  await expect(page.getByRole('heading', { name: 'Retest in Chemistry' })).toBeVisible();
  await expect(page.getByText('A short retest shows what has stuck')).toBeVisible();
  // Shown once, as the next best action: not repeated under Focus next.
  await expect(page.getByRole('button', { name: 'Start retest' })).toHaveCount(1);
  await expect(page.getByRole('listitem', { name: 'Retest in Chemistry' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start retest' }).click();
  await expect(page.getByText('Test · Question 1 of 10')).toBeVisible();
});

test('Focus next: an open practice cannot be put off; a reopened one can, with "Not now"', async ({ page }) => {
  await signIn(page, 'student@example.com');
  await page.getByRole('button', { name: 'Start Quick 10' }).click();
  await finishTest(page);
  await page.getByRole('button', { name: 'Practise what you missed' }).click();
  await expect(page.getByText('Practice · Question 1 of 10')).toBeVisible();

  // Left open: Home resumes it first, and it cannot be put off while it is open.
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'Continue your Chemistry practice' })).toBeVisible();
  const item = page.getByRole('listitem', { name: 'Practice in Chemistry' });
  await expect(item).toContainText('You missed these in a test');
  await expect(item.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Not now' })).toHaveCount(0);

  // Skipping everything is not practice: no retest, and the recommendation is open again.
  await item.getByRole('button', { name: 'Continue' }).click();
  for (let q = 1; q <= 10; q++) {
    await expect(page.getByText(`Question ${q} of 10`)).toBeVisible();
    await page.getByRole('button', { name: 'Skip' }).click();
  }
  await page.getByRole('button', { name: 'Submit anyway' }).click();
  await page.getByRole('link', { name: 'Back to Home' }).click();
  await expect(page.getByRole('heading', { name: 'Practise in Chemistry' })).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByRole('heading', { name: 'Take a Physics test' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Practise in Chemistry' })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('%');
});

// ── Step 15: competitive points and weekly leaderboards ────────────────────

test('Compete: two tests to be ranked; the board shows handles and CP only; an adult can hide', async ({ page }) => {
  await signIn(page, 'student@example.com');
  await expect(page).toHaveURL(/\/home$/);
  await page.goto('/compete');
  await expect(page.getByRole('heading', { name: 'You are Learner-AB3XYZ' })).toBeVisible();
  const all = page.getByRole('region', { name: 'All subjects · ICSE Grade 8' });
  await expect(all).toContainText('To be ranked this week, take 2 more tests with 20 more counted questions.');

  for (let t = 0; t < 2; t++) {
    await page.goto('/home');
    await page.getByRole('button', { name: /^Start Quick 10$/ }).click();
    await finishTest(page);
    await expect(page.getByRole('heading', { level: 1, name: /of 10/ })).toBeVisible();
  }
  await page.goto('/compete');
  await expect(all).toContainText(/You are ranked 2 of 2 with \d+ CP\./);
  const list = all.getByRole('list', { name: 'All subjects · ICSE Grade 8 leaderboard' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').nth(1)).toContainText('Learner-AB3XYZ (you)');
  await expect(page.getByText('XP this week')).toBeVisible();
  // Nothing on the page names anyone or shows accuracy.
  await expect(page.locator('main')).not.toContainText('Asha');
  await expect(page.locator('main')).not.toContainText('%');

  await page.getByRole('button', { name: 'Hide me from other students' }).click();
  await expect(page.getByText('You are hidden: other students do not see you on the boards.')).toBeVisible();
  await page.getByRole('button', { name: 'Show me on the boards' }).click();
  await expect(page.getByText('Other students see your handle and CP')).toBeVisible();
});

test('Compete: a minor is never shown to others and has no switch to change that', async ({ page }) => {
  await signIn(page, 'kid@example.com');
  await expect(page).toHaveURL(/\/home$/);
  await page.goto('/compete');
  await expect(page.getByText('Other students do not see you on the boards. You still see the boards and your own rank.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Hide me|Show me/ })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('Kiran');
});

// ── Step 16: friends and challenges (stub: on for these students, off for solo@) ──

test('Friends: add a friend with their code, challenge them, and start the challenge test', async ({ page }) => {
  await signIn(page, 'student@example.com');
  await expect(page).toHaveURL(/\/home$/);
  await page.goto('/compete');
  const friends = page.getByRole('region', { name: 'Friends' });
  await friends.getByRole('button', { name: 'Show my code' }).click();
  await expect(friends.getByText('XYZ789')).toBeVisible();

  await friends.getByLabel('Friend’s code').fill('zzz-999');
  await friends.getByRole('button', { name: 'Add friend' }).click();
  await expect(page.getByText('That code is not valid')).toBeVisible();
  await friends.getByLabel('Friend’s code').fill('abc-234');
  await friends.getByRole('button', { name: 'Add friend' }).click();
  const friend = friends.getByRole('listitem', { name: 'Friend Learner-R1V4LS' });
  await expect(friend).toContainText('friends');

  await friend.getByLabel('Subject').selectOption({ label: 'Physics' });
  await friend.getByRole('button', { name: 'Challenge' }).click();
  const challenge = page.getByRole('listitem', { name: 'Challenge in Physics with Learner-R1V4LS' });
  await expect(challenge).toContainText('Waiting for Learner-R1V4LS to accept');
  await challenge.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByText('Test · Question 1 of 10')).toBeVisible();
  await expect(page.getByText('Physics question 1?')).toBeVisible();
});

test('Friends: a minor waits for a parent or guardian, cannot challenge yet, and can report (from a list, no free text)', async ({ page }) => {
  await signIn(page, 'kid@example.com');
  await expect(page).toHaveURL(/\/home$/);
  await page.goto('/compete');
  const friends = page.getByRole('region', { name: 'Friends' });
  await friends.getByLabel('Friend’s code').fill('ABC234');
  await friends.getByRole('button', { name: 'Add friend' }).click();
  const friend = friends.getByRole('listitem', { name: 'Friend Learner-R1V4LS' });
  await expect(friend).toContainText('waiting for your parent or guardian to approve');
  await expect(friend.getByRole('button', { name: /Challenge/ })).toHaveCount(0);
  await expect(page.locator('main textarea')).toHaveCount(0);
  await friend.getByLabel('Report Learner-R1V4LS').selectOption('MADE_ME_UNCOMFORTABLE');
  await friend.getByRole('button', { name: 'Send report' }).click();
  await expect(friends.getByRole('listitem', { name: 'Friend Learner-R1V4LS' })).toHaveCount(0);
});

test('Friends: switched off, there is no Friends section at all', async ({ page }) => {
  await signIn(page, 'solo@example.com');
  await expect(page).toHaveURL(/\/home$/);
  await page.goto('/compete');
  await expect(page.getByRole('heading', { name: 'You are Learner-AB3XYZ' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Friends' })).toHaveCount(0);
});

// ── Step 17: the parent view (stub: mum@ is Kiran's approving guardian; Asha, student@, is an adult who can share) ──

async function signedIn(page: Page, email: string) {
  await signIn(page, email);
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
}

test('Parent: a guardian sees gated labels and fixed sentences (no scores), and a frozen weekly report', async ({ page }) => {
  await signedIn(page, 'mum@example.com');
  await page.goto('/parent');
  await expect(page.getByRole('heading', { name: 'Progress summary' })).toBeVisible();
  await expect(page.getByText('Kiran', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Strengths shown' })).toContainText('Shows strong understanding: Balance a chemical equation');
  await expect(page.getByRole('region', { name: 'Focus next' })).toContainText('Worth more practice: Name the products of a reaction');
  await expect(page.getByRole('region', { name: 'Improved' })).toContainText('Moved from needs attention to developing: Use word equations');
  await expect(page.getByRole('region', { name: 'Chemistry' })).toContainText('Building evidence');
  await expect(page.locator('main')).not.toContainText('%');
  // A guardian sees it through their approval: there is no "stop seeing" here (they withdraw the approval instead).
  await expect(page.getByRole('button', { name: 'Stop seeing this summary' })).toHaveCount(0);
  await expect(page.getByText('You see this because you approved this student')).toBeVisible();

  await page.getByRole('region', { name: 'Weekly reports' }).getByRole('button').first().click();
  await expect(page.getByRole('heading', { name: 'Weekly report' })).toBeVisible();
  await expect(page.getByText('Frozen at the end of that week')).toBeVisible();
  await page.getByRole('button', { name: 'Back to this week' }).click();
  await expect(page.getByRole('heading', { name: 'Progress summary' })).toBeVisible();
});

test('Sharing: an adult agrees and invites a parent, the parent accepts from the link, and the student stops sharing', async ({ page, browser, request }) => {
  await signedIn(page, 'student@example.com');
  await page.goto('/progress');
  const share = page.getByRole('region', { name: 'Share with a parent' });
  await share.getByRole('button', { name: 'Invite a parent' }).click();
  await expect(share.getByText('Draft wording for testing')).toBeVisible();
  await share.getByLabel('Their email address').fill('parent@example.com');
  const send = share.getByRole('button', { name: 'Send invitation' });
  await expect(send).toBeDisabled();
  await share.getByLabel(/I agree to share my progress summary/).check();
  await send.click();
  await expect(share.getByText('Invitation sent to p***@example.com')).toBeVisible();

  // The parent opens the link from the email in their own browser, signs in, and comes straight back to accept.
  const { token } = await (await request.get(`http://127.0.0.1:${process.env.STUB_API_PORT ?? 4010}/__share-token`)).json();
  const parent = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const pp = await parent.newPage();
  await pp.goto(`/parent/accept#t=${token}`);
  await pp.waitForURL(/\/sign-in/);
  await signIn(pp, 'parent@example.com');
  await pp.waitForURL(/\/parent\/accept/);
  await expect(pp.getByText('You will not see their answers, scores, points')).toBeVisible();
  await pp.getByRole('button', { name: 'Accept' }).click();
  await pp.getByRole('link', { name: 'See the summary' }).click();
  await expect(pp.getByText('Asha', { exact: true })).toBeVisible();
  await expect(pp.getByRole('region', { name: 'Strengths shown' })).toContainText('Shows strong understanding');
  await expect(pp.getByRole('button', { name: 'Stop seeing this summary' })).toBeVisible();

  // The student sees who can see their summary, and stops sharing.
  await page.reload();
  const viewer = page.getByRole('region', { name: 'Share with a parent' }).getByRole('listitem');
  await expect(viewer).toContainText('p***@example.com');
  page.once('dialog', (d) => void d.accept());
  await viewer.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(page.getByText('Stopped. They can no longer see your summary.')).toBeVisible();
  await pp.reload();
  await expect(pp.getByText("You cannot see any student's progress yet.")).toBeVisible();
  await parent.close();
});

test('Progress tells a minor their guardian sees a summary, and shows exactly what they see', async ({ page }) => {
  await signedIn(page, 'kid@example.com');
  await page.goto('/progress');
  const box = page.getByRole('region', { name: 'Your parent or guardian' });
  await expect(box).toContainText('can see a summary of your progress');
  await expect(box.getByRole('button', { name: 'Invite a parent' })).toHaveCount(0);
  await box.getByRole('link', { name: 'See what they see' }).click();
  await expect(page.getByRole('heading', { name: 'What your parent sees' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('exactly the summary');
  await expect(page.getByRole('region', { name: 'Strengths shown' })).toBeVisible();
});

// ── Step 18: plans (stub: free@ is on the Free plan; everyone else has the beta plan) ──

test('Plans: on Free, a long test is not offered and three self-chosen starts use up the day', async ({ page }) => {
  await signedIn(page, 'free@example.com');
  await page.goto('/tests');
  await expect(page.getByText('Your plan: Free · 3 tests or practice sets left to start today')).toBeVisible();
  const chemistry = page.locator('#CHEMISTRY');
  await expect(chemistry.getByRole('button', { name: 'Subject 20 test' })).toBeDisabled();
  await expect(chemistry.getByText('Longer tests are not included in your plan.')).toBeVisible();

  for (const [subject, kind] of [['#CHEMISTRY', 'Test'], ['#PHYSICS', 'Test'], ['#CHEMISTRY', 'Practice']] as const) {
    await page.goto('/tests');
    await page.getByRole('button', { name: kind, exact: true }).click();
    await page.locator(subject).getByRole('button', { name: `Quick 10 ${kind.toLowerCase()}` }).click();
    await page.waitForURL(/\/tests\/[0-9a-f-]{36}$/);
  }
  await page.goto('/tests');
  await expect(page.getByText("You've started all the tests your plan includes today")).toBeVisible();
  await expect(page.locator('#PHYSICS').getByRole('button', { name: 'Quick 10 test' })).toBeDisabled();
  // What was started can still be finished.
  await expect(page.getByRole('link', { name: /Continue Chemistry test/ })).toBeVisible();
});

test('Plans: during the beta, everything is offered and there is no daily limit', async ({ page }) => {
  await signedIn(page, 'beta@example.com');
  await page.goto('/tests');
  await expect(page.getByText(/Your plan: Beta \(until /)).toBeVisible();
  await expect(page.getByText(/left to start today/)).toHaveCount(0);
  await expect(page.locator('#CHEMISTRY').getByRole('button', { name: 'Subject 20 test' })).toBeEnabled();
});

// ── Step 19: analytics (stub: off for everyone until agreed; mum@ decides for Kiran) ──

const keptEvents = async (request: import('@playwright/test').APIRequestContext) =>
  (await (await request.get(`http://127.0.0.1:${process.env.STUB_API_PORT ?? 4010}/__analytics`)).json()).events as Array<{ email: string; name: string }>;

test('Analytics: off until an adult agrees after reading what is collected; nothing is kept before; turning it off deletes', async ({ page, request }) => {
  await signedIn(page, 'student@example.com');
  await page.goto('/progress');
  const box = page.getByRole('region', { name: 'Help improve Exam App' });
  await expect(box).toContainText('Anonymous usage statistics are off');
  expect(await keptEvents(request)).toEqual([]);

  await box.getByRole('button', { name: 'Read more' }).click();
  await expect(box.getByText('Draft wording for testing')).toBeVisible();
  await box.getByRole('button', { name: 'Allow anonymous statistics' }).click();
  await expect(box).toContainText('You allow anonymous usage statistics');

  await page.goto('/compete');
  await expect.poll(async () => (await keptEvents(request)).map((e) => e.name)).toContain('COMPETE_OPENED');

  await page.goto('/progress');
  await page.getByRole('region', { name: 'Help improve Exam App' }).getByRole('button', { name: 'Turn off and delete' }).click();
  await expect(page.getByRole('region', { name: 'Help improve Exam App' })).toContainText('are off');
  expect(await keptEvents(request)).toEqual([]);
});

test("Analytics: a minor's guardian decides on the guardian page; the minor is told which way it is set", async ({ page }) => {
  await signedIn(page, 'kid@example.com');
  await page.goto('/progress');
  await expect(page.getByRole('region', { name: 'Help improve Exam App' })).toContainText('Your parent or guardian decides');
  await expect(page.getByRole('button', { name: /Allow anonymous/ })).toHaveCount(0);

  const ctx = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
  const mum = await ctx.newPage();
  await signedIn(mum, 'mum@example.com');
  await mum.goto('/guardian');
  const stats = mum.getByRole('region', { name: 'Anonymous usage statistics' });
  await expect(stats).toContainText('Kiran: off');
  await expect(stats.getByRole('button', { name: 'Allow' })).toBeDisabled();
  await stats.getByRole('button', { name: 'What is collected' }).click();
  await stats.getByRole('button', { name: 'Allow' }).click();
  await expect(stats).toContainText('Kiran: allowed');
  await ctx.close();

  await page.reload();
  await expect(page.getByRole('region', { name: 'Help improve Exam App' })).toContainText('Right now they do.');
});
