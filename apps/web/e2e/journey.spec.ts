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

test('Progress shows gated labels by chapter and objective, never a percentage; Compete is Coming soon', async ({ page }) => {
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
  await expect(page.getByRole('heading', { name: 'Coming soon' })).toBeVisible();
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
