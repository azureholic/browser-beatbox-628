import fs from 'node:fs';
import path from 'node:path';
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

const windowsChromeCandidates =
  process.platform === 'win32'
    ? [
        process.env.PROGRAMFILES
          ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
          : '',
        process.env['PROGRAMFILES(X86)']
          ? path.join(
              process.env['PROGRAMFILES(X86)'],
              'Google',
              'Chrome',
              'Application',
              'chrome.exe',
            )
          : '',
        process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
          : '',
      ].filter(Boolean)
    : [];

const windowsEdgeCandidates =
  process.platform === 'win32'
    ? [
        process.env['PROGRAMFILES(X86)']
          ? path.join(
              process.env['PROGRAMFILES(X86)'],
              'Microsoft',
              'Edge',
              'Application',
              'msedge.exe',
            )
          : '',
        process.env.PROGRAMFILES
          ? path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
          : '',
      ].filter(Boolean)
    : [];

const useSystemChromeChannel =
  !hasExplicitExecutable &&
  !hasBundledChromium &&
  (fs.existsSync('/usr/bin/google-chrome') ||
    fs.existsSync('/opt/google/chrome/chrome') ||
    windowsChromeCandidates.some((candidate) => fs.existsSync(candidate)));

const useSystemEdgeChannel =
  !hasExplicitExecutable &&
  !hasBundledChromium &&
  !useSystemChromeChannel &&
  windowsEdgeCandidates.some((candidate) => fs.existsSync(candidate));

const fallbackChromiumExecutable =
  hasExplicitExecutable
    ? explicitChromiumExecutable
    : !hasBundledChromium && !useSystemChromeChannel && !useSystemEdgeChannel
      ? ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find((candidate) =>
          fs.existsSync(candidate),
        )
      : undefined;

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  // Serialize install and build verification steps so temporary registries,
  // clean-checkout installs, and Beatbox.Api builds never contend for resources.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  expect: {
    timeout: 5_000,
  },
  outputDir: '../../../TestResults/ISS-24-artifacts',
  reporter: [
    ['list'],
    ['junit', { outputFile: '../../../TestResults/ISS-24-junit.xml' }],
  ],
  use: {
    baseURL,
    browserName: 'chromium',
    ...(useSystemChromeChannel ? { channel: 'chrome' } : {}),
    ...(useSystemEdgeChannel ? { channel: 'msedge' } : {}),
    ...(fallbackChromiumExecutable
      ? { launchOptions: { executablePath: fallbackChromiumExecutable } }
      : {}),
    headless: true,
    trace: 'off',
  },
});
