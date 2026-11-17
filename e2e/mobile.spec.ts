import { devices, expect, test } from '@playwright/test';

test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium', browserName: 'chromium', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

test('phone layout: landing, 3D city, inspector', async ({ page }) => {
  await page.goto('/');
  await page.screenshot({ path: 'test-results/m1-landing.png' });
  await page.getByRole('button', { name: /Shibuya/ }).click();
  await page.getByRole('button', { name: 'Start exploring' }).click({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/m2-city.png' });
  const box = (await page.locator('.viewport canvas').boundingBox())!;
  for (const [fx, fy] of [[0.5, 0.45], [0.4, 0.5], [0.6, 0.4]]) {
    await page.touchscreen.tap(box.x + box.width * fx, box.y + box.height * fy);
    if (await page.locator('.inspector').isVisible()) break;
  }
  await page.screenshot({ path: 'test-results/m3-inspect.png' });
  await expect(page.locator('.simbar')).toBeVisible();
});
