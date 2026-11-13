import { expect, test } from '@playwright/test';

test('the built scaffold mounts its empty app', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('deerdiary');
  await expect(page.getByRole('main', { name: 'Deerdiary' })).toBeAttached();
});
