import fs from 'node:fs';
import { chromium, defineConfig } from '@playwright/test';

const previewUrl = process.env.PREVIEW_URL?.trim();
const baseURL = previewUrl || process.env.BASE_URL?.trim() || 'http://127.0.0.1:5143';

const explicitChromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const hasExplicitExecutable = Boolean(
  explicitChromiumExecutable && fs.existsSync(explicitChromiumExecutable),
);

const hasBundledChromium = (() => {
  if (hasExplicitExecutable) {
    return false;
  }
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const useSystemChromeChannel =
  !hasExplicitExecutable &&
  !hasBundledChromium &&
  (fs.existsSync('/usr/bin/google-chrome') || fs.existsSync('/opt/google/chrome/chrome'));

const fallbackChromiumExecutable =
  hasExplicitExecutable
    ? explicitChromiumExecutable
    : !hasBundledChromium && !useSystemChromeChannel
      ? ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find((candidate) =>
          fs.existsSync(candidate),
        )
      : undefined;

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  // Serialize build verification steps so `npm run build` and `dotnet build`
  // never contend over `web/dist`, `src/Beatbox.Api/wwwroot`, or `bin/` handles.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: {
    timeout: 5_000,
  },
  outputDir: '../../../TestResults/ISS-29-artifacts',
  reporter: [
    ['list'],
    ['junit', { outputFile: '../../../TestResults/ISS-29-junit.xml' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    ...(useSystemChromeChannel ? { channel: 'chrome' } : {}),
    ...(fallbackChromiumExecutable
      ? { launchOptions: { executablePath: fallbackChromiumExecutable } }
      : {}),
    headless: true,
    trace: 'off',
  },
});
