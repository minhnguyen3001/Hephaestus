import { expect, test } from '@playwright/test';
test('runs under /Hephaestus/', async ({ page }) => {
  page.on('response', (r) => r.status() >= 400 && console.log('BAD', r.status(), r.url()));
  await page.addInitScript(() => localStorage.setItem('gcs.onboarded.v1', '1'));
  await page.goto('http://localhost:4174/Hephaestus/');
  await expect(page.getByText('Hephaestus').first()).toBeVisible();
  await page.getByRole('button', { name: /Shibuya/ }).click();
  await expect(page.locator('.kinds')).toContainText('Cars', { timeout: 30_000 });
  await expect(page.locator('.attribution')).toContainText('buildings');
});
