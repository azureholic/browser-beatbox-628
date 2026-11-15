import fs from 'node:fs';
import { chromium, defineConfig } from '@playwright/test';

const previewUrl = process.env.PREVIEW_URL?.trim();
const baseURL = previewUrl || process.env.BASE_URL?.trim() || 'http://localhost:5143';
const healthUrl = new URL('/healthz', baseURL).toString();

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
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 15_000,
  expect: {
    timeout: 2_000,
  },
  outputDir: '../../../TestResults/ISS-7-artifacts',
  reporter: [
    ['list'],
    ['junit', { outputFile: '../../../TestResults/ISS-7-junit.xml' }],
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
  webServer: previewUrl
    ? undefined
    : {
        command: 'dotnet run --project ../../../src/Beatbox.Api --no-launch-profile',
        url: healthUrl,
        env: {
          ASPNETCORE_ENVIRONMENT: process.env.ASPNETCORE_ENVIRONMENT || 'Development',
          ASPNETCORE_URLS: new URL(baseURL).origin,
        },
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
