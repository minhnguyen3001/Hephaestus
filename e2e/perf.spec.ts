import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/**
 * Low-end benchmark: software rendering (no GPU) + 4× CPU throttling, Manhattan pack.
 * Run explicitly: npx playwright test e2e/perf.spec.ts — writes test-results/perf.json.
 */
const results: Record<string, unknown> = {};

for (const [view, q] of [['2d', 'low'], ['3d', 'low'], ['3d', 'medium'], ['3d', 'high']] as const) {
  test(`perf ${view} ${q} quality, 4x CPU throttle`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.addInitScript(([v, qq]) => {
      localStorage.setItem('gcs.onboarded.v1', '1');
      localStorage.setItem('gcs.view', v);
      localStorage.setItem('gcs.quality', qq);
    }, [view, q]);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/');
    const t0 = Date.now();
    await page.getByRole('button', { name: new RegExp(process.env.PERF_CITY ?? 'Midtown Manhattan') }).click(); // PERF_CITY=Shibuya etc.
    await page.locator('.attribution').filter({ hasText: 'buildings' }).waitFor({ timeout: 120_000 });
    const ready = Date.now() - t0;
    // let tiles and the city ring finish streaming: we measure steady-state interaction cost
    await expect(page.locator('.attribution')).not.toContainText('loading', { timeout: 120_000 });
    await expect(page.locator('.attribution')).not.toContainText('building scene', { timeout: 120_000 });
    await page.waitForTimeout(6000);
    const samples: number[] = [];
    const ms: number[] = [];
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1500);
      const m = /(\d+) fps · ([\d.]+) ms/.exec(await page.locator('.attribution').innerText());
      if (m) {
        samples.push(+m[1]);
        ms.push(+m[2]);
      }
    }
    const agents = await page.locator('.dashboard .metric').filter({ hasText: 'Agents moving' }).locator('strong').innerText().catch(() => '?');
    const gpu = await page.locator('.attribution .perf').getAttribute('title').catch(() => null);
    // worst case: the whole city ring on screen
    let gpuCity: string | null = null;
    if (view === '3d') {
      await page.getByRole('button', { name: 'City', exact: true }).click();
      await page.waitForTimeout(5000);
      gpuCity = await page.locator('.attribution .perf').getAttribute('title').catch(() => null);
    }
    results[`${view}-${q}`] = { gpu, gpuCity, readyMs: ready, fps: samples, medianFps: samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)], medianFrameMs: ms.sort((a, b) => a - b)[Math.floor(ms.length / 2)], agents };
    writeFileSync('test-results/perf.json', JSON.stringify(results, null, 2));
  });
}
