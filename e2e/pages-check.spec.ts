import { expect, test } from '@playwright/test';
test('runs under /Ptah/', async ({ page }) => {
  page.on('console', (m) => m.type() === 'error' && console.log('CERR', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('PERR', e.message.slice(0, 300)));
  page.on('response', (r) => r.status() >= 400 && console.log('BAD', r.status(), r.url()));
  await page.addInitScript(() => localStorage.setItem('gcs.onboarded.v1', '1'));
  await page.goto('http://localhost:4174/Ptah/');
  await expect(page.getByText('Ptah').first()).toBeVisible();
  await page.getByRole('button', { name: /Shibuya/ }).click();
  await expect(page.locator('.kinds')).toContainText('Cars', { timeout: 30_000 });
  await expect(page.locator('.attribution')).toContainText('buildings');
});
