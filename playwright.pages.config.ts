import { defineConfig } from '@playwright/test';
// Checks the GitHub Pages build under /Hephaestus/: npm run build:pages && npx playwright test -c playwright.pages.config.ts
export default defineConfig({
  testDir: 'e2e',
  testMatch: 'pages-check.spec.ts',
  use: { launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } },
  webServer: { command: 'npx vite preview --mode pages --port 4174 --strictPort', url: 'http://localhost:4174/Hephaestus/', reuseExistingServer: false },
});
