import { expect, test } from '@playwright/test';

test.describe('Atelier — smoke', () => {
  test('landing page renders heading + meta', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/Atelier/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Atelier');
  });

  test('no accidental robots indexing', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    const robots = await page.locator('meta[name="robots"]').first();
    await expect(robots).toHaveAttribute('content', /noindex/);
  });
});
