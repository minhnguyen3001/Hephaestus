import { expect, test } from '@playwright/test';

// End-to-end: real OSM data (network required), real WebGL (SwiftShader in headless CI).
test('load a real city, inspect, edit, undo, simulate', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Any real city/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/01-landing.png' });

  await page.getByRole('button', { name: /Chicago Loop/ }).click();
  await expect(page.getByText(/Building Chicago Loop/)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Quick tour' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Start exploring' }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/02-city.png' });

  // Live simulation is running with several agent types.
  const agents = page.locator('.kinds');
  await expect(agents).toContainText('Cars');
  const total = async () => (await agents.locator('b').allInnerTexts()).reduce((s, x) => s + Number(x), 0);
  expect(await total()).toBeGreaterThan(20);

  // Click near the center to select something and confirm the inspector opens.
  const box = (await page.locator('.viewport canvas').boundingBox())!;
  let opened = false;
  for (const [dx, dy] of [[0, 0], [40, 30], [-60, 20], [80, -40], [-30, -60], [120, 60]]) {
    await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    if (await page.locator('.inspector').isVisible()) { opened = true; break; }
  }
  expect(opened).toBe(true);
  await page.screenshot({ path: 'test-results/03-inspect.png' });

  // Place a building with the build tool, then undo it.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Hide dashboard' }).click();
  await page.getByRole('button', { name: 'Aerial' }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Place building' }).click();
  // Dense downtowns have few empty spots, so try a few until one is open ground.
  const proposedOne = page.getByRole('button', { name: /Proposed · 1/ });
  for (const [fx, fy] of [[0.88, 0.2], [0.9, 0.5], [0.15, 0.2], [0.85, 0.75], [0.5, 0.15]]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(300);
    if (await proposedOne.isVisible()) break;
  }
  await expect(proposedOne).toBeVisible();
  await page.getByRole('button', { name: 'Show dashboard' }).click();
  await expect(page.locator('.dashboard .metric').filter({ hasText: 'Buildings' })).toContainText('+1');
  await page.screenshot({ path: 'test-results/04-built.png' });
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Proposed$/ })).toBeVisible();

  // Camera modes and time of day.
  await page.getByRole('button', { name: 'Street' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/05-street.png' });
  await page.getByRole('button', { name: 'Aerial' }).click();
  await page.waitForTimeout(1200);
  await page.locator('.time').fill('79200');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/06-night.png' });

  expect(errors.filter((e) => !/favicon/.test(e))).toEqual([]);
});

test('hilly city loads real terrain', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gcs.onboarded.v1', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: /Nob Hill/ }).click();
  await expect(page.locator('.attribution')).toContainText('AWS Terrain Tiles', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Hide dashboard' }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/07-terrain.png' });
  await page.getByRole('button', { name: 'Street' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/08-terrain-street.png' });
});

test('coastal city renders sea from coastlines', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gcs.onboarded.v1', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: /^Central/ }).click();
  await expect(page.locator('.attribution')).toContainText('buildings', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Hide dashboard' }).click();
  await page.getByRole('button', { name: 'Aerial' }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/09-coast.png' });
});

test('2D plan view: pack data, select, build, undo, simulate', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem('gcs.onboarded.v1', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: /Shibuya/ }).click();
  await expect(page.locator('.attribution')).toContainText('buildings', { timeout: 30_000 }); // from the static pack
  await page.getByRole('button', { name: '2D plan' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/10-plan2d.png' });
  await expect(page.locator('.kinds')).toContainText('Cars');

  const box = (await page.locator('.viewport canvas').boundingBox())!;
  let opened = false;
  for (const [fx, fy] of [[0.5, 0.5], [0.55, 0.45], [0.45, 0.55], [0.6, 0.6], [0.4, 0.4]]) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    if (await page.locator('.inspector').isVisible()) { opened = true; break; }
  }
  expect(opened).toBe(true);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Aerial' }).click();
  await page.getByRole('button', { name: 'Place building' }).click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.08 + 70); // outside the loaded circle = open ground
  await expect(page.getByRole('button', { name: /Proposed · 1/ })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: /^Proposed$/ })).toBeVisible();
  await page.getByRole('button', { name: '3D view' }).click();
  await page.waitForTimeout(1000);
  expect(errors).toEqual([]);
});

test('traffic layer and signals (Manhattan pack)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gcs.onboarded.v1', '1'));
  await page.goto('/');
  await page.getByRole('button', { name: /Midtown Manhattan/ }).click();
  await expect(page.locator('.attribution')).toContainText('buildings', { timeout: 30_000 });
  await page.getByLabel('Traffic flow').check();
  await page.getByRole('button', { name: 'Hide dashboard' }).click();
  await page.getByRole('button', { name: '20×' }).click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'test-results/11-traffic-3d.png' });
  await page.getByRole('button', { name: '2D plan' }).click();
  await page.getByRole('button', { name: 'District' }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/12-traffic-2d.png' });
  await page.getByRole('button', { name: '3D view' }).click();
});
