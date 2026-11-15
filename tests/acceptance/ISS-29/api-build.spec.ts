import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * ISS-29 Acceptance Test Suite — Verify Beatbox API build passes
 *
 * Contract reference: ./contract.md
 * Validates that:
 * 1. `npm run build` executes successfully within the `$(SpaRoot)` context that MSBuild invokes.
 * 2. `dotnet build src/Beatbox.Api/Beatbox.Api.csproj` completes with exit code 0 and zero MSB3073 errors.
 * 3. The built Beatbox.Api artifact serves `/healthz` and compiled SPA static assets cleanly.
 */

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '..', '..', '..');
const API_DIR = path.join(REPO_ROOT, 'src', 'Beatbox.Api');
const API_CSPROJ_REL = path.join('src', 'Beatbox.Api', 'Beatbox.Api.csproj');
const API_CSPROJ_ABS = path.join(REPO_ROOT, API_CSPROJ_REL);
const EXPECTED_WEB_DIR = path.join(REPO_ROOT, 'web');
const PREVIEW_URL = process.env.PREVIEW_URL?.trim();

const BUNDLED_SAMPLES = [
  'kick.wav',
  'snare.wav',
  'hihat-closed.wav',
  'hihat-open.wav',
  'clap.wav',
] as const;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combinedOutput: string;
}

function spawnCommandProcess(
  tool: 'dotnet' | 'npm',
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ChildProcess {
  const spawnOptions = {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
  };

  if (tool === 'npm' && process.platform === 'win32') {
    const adjacentNpmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    if (fs.existsSync(adjacentNpmCli)) {
      return spawn(process.execPath, [adjacentNpmCli, ...args], spawnOptions);
    }
    return spawn('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], spawnOptions);
  }

  return spawn(tool, [...args], spawnOptions);
}

function runCommand(
  tool: 'dotnet' | 'npm',
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCommandProcess(tool, args, cwd, env);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        combinedOutput: `${stdout}\n${stderr}`,
      });
    });
  });
}

async function queryMsBuildProperty(propertyName: 'SpaRoot' | 'TargetPath'): Promise<string> {
  const result = await runCommand(
    'dotnet',
    ['msbuild', API_CSPROJ_REL, `-getProperty:${propertyName}`],
    REPO_ROOT,
  );
  expect(
    result.exitCode,
    `Failed evaluating MSBuild property ${propertyName}:\n${result.combinedOutput}`,
  ).toBe(0);

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  expect(lines.length).toBeGreaterThan(0);
  return lines[lines.length - 1];
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate loopback port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHealthReady(url: string, child: ChildProcess, getLogs: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = 'no response';

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Beatbox.Api exited prematurely with code ${child.exitCode} before /healthz became ready:\n${getLogs()}`,
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === 'ok') {
          return;
        }
      }
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  throw new Error(`Timed out waiting for ${url} (${lastError}):\n${getLogs()}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore if already exited
      }
      resolve();
    }, 5_000);

    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

test.describe('ISS-29: Verify Beatbox API build passes', () => {
  test('AC-001_executes_npm_run_build_successfully_within_msbuild_spa_root_context', async () => {
    test.skip(
      Boolean(PREVIEW_URL),
      'Local MSBuild/npm CLI build checks run in local/CI build mode; PREVIEW_URL verifies the deployed build artifact.',
    );

    expect(fs.existsSync(API_CSPROJ_ABS)).toBe(true);
    const csprojXml = fs.readFileSync(API_CSPROJ_ABS, 'utf8');
    expect(csprojXml).toContain('Name="BuildWebFrontend"');
    expect(csprojXml).toContain('npm run build');

    const resolvedSpaRoot = path.resolve(await queryMsBuildProperty('SpaRoot'));
    expect(resolvedSpaRoot).toBe(path.resolve(EXPECTED_WEB_DIR));
    expect(fs.existsSync(path.join(resolvedSpaRoot, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(resolvedSpaRoot, 'tsconfig.json'))).toBe(true);
    expect(fs.existsSync(path.join(resolvedSpaRoot, 'vite.config.ts'))).toBe(true);

    // Ensure dependencies exist if running from a completely clean checkout prior to dotnet build
    if (!fs.existsSync(path.join(resolvedSpaRoot, 'node_modules', 'vite', 'package.json'))) {
      const installResult = await runCommand(
        'npm',
        ['run', 'install:ci'],
        resolvedSpaRoot,
      );
      expect(
        installResult.exitCode,
        `Frontend dependency bootstrap failed:\n${installResult.combinedOutput}`,
      ).toBe(0);
    }

    const distDir = path.join(resolvedSpaRoot, 'dist');
    fs.rmSync(distDir, { recursive: true, force: true });

    // Execute `npm run build` in the exact WorkingDirectory (`$(SpaRoot)`) used by MSBuild
    const npmBuildResult = await runCommand('npm', ['run', 'build'], resolvedSpaRoot);

    expect(
      npmBuildResult.exitCode,
      `npm run build failed in $(SpaRoot) (${resolvedSpaRoot}):\n${npmBuildResult.combinedOutput}`,
    ).toBe(0);

    const distIndexPath = path.join(distDir, 'index.html');
    expect(fs.existsSync(distIndexPath)).toBe(true);
    const distIndexHtml = fs.readFileSync(distIndexPath, 'utf8');
    expect(distIndexHtml).toContain('<div id="root"></div>');

    const distAssetsDir = path.join(distDir, 'assets');
    expect(fs.existsSync(distAssetsDir)).toBe(true);
    const assetFiles = fs.readdirSync(distAssetsDir);
    expect(assetFiles.some((file) => file.endsWith('.js'))).toBe(true);
    expect(assetFiles.some((file) => file.endsWith('.css'))).toBe(true);

    const distSamplesDir = path.join(distDir, 'samples');
    expect(fs.existsSync(distSamplesDir)).toBe(true);
    for (const sample of BUNDLED_SAMPLES) {
      const samplePath = path.join(distSamplesDir, sample);
      expect(fs.existsSync(samplePath)).toBe(true);
      expect(fs.statSync(samplePath).size).toBeGreaterThan(0);
    }
  });

  test('AC-002_completes_dotnet_build_beatbox_api_csproj_with_exit_code_0_and_zero_msb3073_errors', async () => {
    test.skip(
      Boolean(PREVIEW_URL),
      'Local MSBuild/npm CLI build checks run in local/CI build mode; PREVIEW_URL verifies the deployed build artifact.',
    );

    const wwwrootDir = path.join(API_DIR, 'wwwroot');
    // Remove wwwroot so MSBuild cannot skip BuildWebFrontend as already up-to-date
    fs.rmSync(wwwrootDir, { recursive: true, force: true });

    const buildResult = await runCommand(
      'dotnet',
      ['build', API_CSPROJ_REL, '--no-incremental', '--nologo'],
      REPO_ROOT,
    );

    expect(
      buildResult.exitCode,
      `dotnet build ${API_CSPROJ_REL} exited with non-zero status:\n${buildResult.combinedOutput}`,
    ).toBe(0);
    expect(buildResult.combinedOutput).not.toMatch(/MSB3073/i);
    expect(buildResult.combinedOutput).not.toMatch(/\berror\s+[A-Z]+\d+\s*:/i);

    const targetPath = await queryMsBuildProperty('TargetPath');
    expect(fs.existsSync(targetPath)).toBe(true);

    const wwwrootIndexPath = path.join(wwwrootDir, 'index.html');
    expect(fs.existsSync(wwwrootIndexPath)).toBe(true);
    expect(fs.statSync(wwwrootIndexPath).size).toBeGreaterThan(0);

    const wwwrootAssetsDir = path.join(wwwrootDir, 'assets');
    expect(fs.existsSync(wwwrootAssetsDir)).toBe(true);
    const copiedAssets = fs.readdirSync(wwwrootAssetsDir);
    expect(copiedAssets.some((file) => file.endsWith('.js'))).toBe(true);
    expect(copiedAssets.some((file) => file.endsWith('.css'))).toBe(true);

    for (const sample of BUNDLED_SAMPLES) {
      expect(fs.existsSync(path.join(wwwrootDir, 'samples', sample))).toBe(true);
    }
  });

  test('AC-002_supports_incremental_and_skip_spa_build_modes_without_msb3073_errors', async () => {
    test.skip(
      Boolean(PREVIEW_URL),
      'Local MSBuild/npm CLI build checks run in local/CI build mode; PREVIEW_URL verifies the deployed build artifact.',
    );

    const incrementalResult = await runCommand(
      'dotnet',
      ['build', API_CSPROJ_REL, '--nologo'],
      REPO_ROOT,
    );
    expect(
      incrementalResult.exitCode,
      `Incremental dotnet build failed:\n${incrementalResult.combinedOutput}`,
    ).toBe(0);
    expect(incrementalResult.combinedOutput).not.toMatch(/MSB3073/i);

    const skipSpaResult = await runCommand(
      'dotnet',
      ['build', API_CSPROJ_REL, '-p:SkipSpaBuild=true', '--nologo'],
      REPO_ROOT,
    );
    expect(
      skipSpaResult.exitCode,
      `SkipSpaBuild dotnet build failed:\n${skipSpaResult.combinedOutput}`,
    ).toBe(0);
    expect(skipSpaResult.combinedOutput).not.toMatch(/MSB3073/i);
  });

  test('AC-002_serves_built_spa_and_health_probe_from_compiled_beatbox_api', async ({ page }) => {
    let targetOrigin = PREVIEW_URL;
    let apiProcess: ChildProcess | null = null;
    let serverLogs = '';

    try {
      if (!targetOrigin) {
        const targetDll = await queryMsBuildProperty('TargetPath');
        expect(fs.existsSync(targetDll)).toBe(true);

        const port = await allocateLoopbackPort();
        targetOrigin = `http://127.0.0.1:${port}`;

        apiProcess = spawnCommandProcess('dotnet', [targetDll], API_DIR, {
          ...process.env,
          ASPNETCORE_ENVIRONMENT: 'Development',
          ASPNETCORE_URLS: targetOrigin,
        });

        apiProcess.stdout?.on('data', (chunk: Buffer) => {
          serverLogs += chunk.toString();
        });
        apiProcess.stderr?.on('data', (chunk: Buffer) => {
          serverLogs += chunk.toString();
        });

        await waitForHealthReady(`${targetOrigin}/healthz`, apiProcess, () => serverLogs);
      }

      const healthResponse = await fetch(`${targetOrigin}/healthz`);
      expect(healthResponse.status).toBe(200);
      const healthJson = (await healthResponse.json()) as { status?: string };
      expect(healthJson.status).toBe('ok');

      const rootResponse = await fetch(`${targetOrigin}/`);
      expect(rootResponse.status).toBe(200);
      expect(rootResponse.headers.get('content-type') ?? '').toContain('text/html');

      const pageErrors: string[] = [];
      page.on('pageerror', (err) => {
        pageErrors.push(err.message);
      });

      await page.goto(targetOrigin);
      await expect(page.getByTestId('beatbox-app')).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally {
      if (apiProcess) {
        await stopProcess(apiProcess);
      }
    }
  });
});
