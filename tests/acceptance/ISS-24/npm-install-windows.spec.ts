import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  cleanupStaleArtifacts,
  PUBLIC_NPM_REGISTRY,
  runNpmInstallWithFallback,
  verifyBuildDependencies,
  type FsDirentLike,
  type FsPromisesLike,
} from '../../../web/tools/npm-install.mjs';

/**
 * ISS-24 Acceptance Test Suite — Verify npm install reliability on Windows
 *
 * Contract reference: ./contract.md
 * Validates that:
 * 1. `npm install` and `npm run install:deps` succeed cleanly from a fresh checkout on Windows 10/11
 *    (and resolve Windows win32 x64/arm64 native optional dependencies with deterministic lockfile integrity).
 * 2. Standard installation/clean flows emit zero `EPERM` errors, and locked/read-only Windows artifacts
 *    (`EPERM`/`EBUSY`/`EACCES`) are retried and swept without hard failing (`REQ-001`).
 * 3. `npm run build` succeeds after a clean install and outputs complete SPA bundles and audio samples.
 * 4. Consecutive clean `npm ci` / `npm run install:ci` installs are deterministic and idempotent,
 *    single-retry registry fallback and actionable `E404` guidance work as specified (`REQ-002`, `REQ-003`),
 *    and CI / MSBuild / runtime flows exhibit zero regressions.
 */

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '..', '..', '..');
const WEB_DIR = path.join(REPO_ROOT, 'web');
const API_DIR = path.join(REPO_ROOT, 'src', 'Beatbox.Api');
const API_CSPROJ_REL = path.join('src', 'Beatbox.Api', 'Beatbox.Api.csproj');
const DOCKERFILE_PATH = path.join(REPO_ROOT, 'Dockerfile');
const PREVIEW_URL = process.env.PREVIEW_URL?.trim();

const DEFAULT_COMMAND_TIMEOUT_MS = 90_000;

const CLEAN_WEB_ENTRIES = [
  '.npmrc',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'index.html',
  'public',
  'src',
  'tools',
] as const;

const REQUIRED_BUILD_PACKAGES = [
  'react',
  'react-dom',
  'vite',
  'typescript',
  '@vitejs/plugin-react',
  '@types/react',
  '@types/react-dom',
] as const;

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

interface CleanCheckoutWorkspace {
  rootDir: string;
  projectDir: string;
  cacheDir: string;
}

const activeProcesses = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const activeServers = new Set<http.Server>();

function sha256File(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function removeDirBestEffort(targetDir: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fsPromises.rm(targetDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
}

function createCleanWebCheckout(): CleanCheckoutWorkspace {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatbox-iss24-'));
  tempDirs.add(rootDir);

  const projectDir = path.join(rootDir, 'web');
  const cacheDir = path.join(rootDir, 'npm-cache');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  for (const entry of CLEAN_WEB_ENTRIES) {
    const srcPath = path.join(WEB_DIR, entry);
    const destPath = path.join(projectDir, entry);
    fs.cpSync(srcPath, destPath, { recursive: true });
  }

  expect(fs.existsSync(path.join(projectDir, 'node_modules'))).toBe(false);
  expect(fs.existsSync(path.join(projectDir, 'dist'))).toBe(false);

  return { rootDir, projectDir, cacheDir };
}

function buildIsolatedNpmEnv(
  cacheDir: string,
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_cache: cacheDir,
    ...overrides,
  };
  for (const [key, val] of Object.entries(merged)) {
    if (val === undefined) {
      delete merged[key];
    }
  }
  return merged;
}

function spawnCommandProcess(
  tool: 'dotnet' | 'npm' | 'node',
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

  let child: ChildProcess;
  if (tool === 'node') {
    child = spawn(process.execPath, [...args], spawnOptions);
  } else if (tool === 'npm' && process.platform === 'win32') {
    const adjacentNpmCli = path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    );
    if (fs.existsSync(adjacentNpmCli)) {
      child = spawn(process.execPath, [adjacentNpmCli, ...args], spawnOptions);
    } else {
      child = spawn('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], spawnOptions);
    }
  } else {
    child = spawn(tool, [...args], spawnOptions);
  }

  activeProcesses.add(child);
  child.once('close', () => {
    activeProcesses.delete(child);
  });
  return child;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    activeProcesses.delete(child);
    return;
  }

  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore if process already exited
      }
      resolve();
    }, 5_000);

    child.once('close', () => {
      clearTimeout(killTimer);
      activeProcesses.delete(child);
      resolve();
    });

    if (process.platform === 'win32' && typeof child.pid === 'number' && child.pid > 0) {
      const killer = spawn('taskkill', ['/PID', String(Math.trunc(child.pid)), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        try {
          child.kill();
        } catch {
          clearTimeout(killTimer);
          resolve();
        }
      });
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
}

function runCommand(
  tool: 'dotnet' | 'npm' | 'node',
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnCommandProcess(tool, args, cwd, env);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      void stopProcess(child).finally(() => {
        reject(
          new Error(
            `Command "${tool} ${args.join(' ')}" timed out after ${timeoutMs}ms:\n${stdout}\n${stderr}`,
          ),
        );
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(deadlineTimer);
      if (!timedOut) {
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(deadlineTimer);
      if (timedOut) {
        return;
      }
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        combinedOutput: `${stdout}\n${stderr}`,
      });
    });
  });
}

function snapshotInstalledPackages(projectDir: string): string[] {
  const nodeModulesDir = path.join(projectDir, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    return [];
  }

  const results: string[] = [];
  const topEntries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });

  for (const entry of topEntries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    if (entry.name.startsWith('@') && entry.isDirectory()) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      for (const scopedEntry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!scopedEntry.isDirectory()) {
          continue;
        }
        const pkgJsonPath = path.join(scopeDir, scopedEntry.name, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
            name?: string;
            version?: string;
          };
          results.push(`${entry.name}/${scopedEntry.name}@${pkg.version ?? 'unknown'}`);
        }
      }
      continue;
    }

    if (entry.isDirectory()) {
      const pkgJsonPath = path.join(nodeModulesDir, entry.name, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
          name?: string;
          version?: string;
        };
        results.push(`${entry.name}@${pkg.version ?? 'unknown'}`);
      }
    }
  }

  return results.sort();
}

function assertNoEpermOrInstallErrors(output: string): void {
  expect(output).not.toMatch(/\bEPERM\b/i);
  expect(output).not.toMatch(/\bEBUSY\b/i);
  expect(output).not.toMatch(/npm\s+(?:error|ERR!)\s+code\s+E404\b/i);
  expect(output).not.toMatch(/npm\s+(?:error|ERR!)\s+code\s+ERESOLVE\b/i);
  expect(output).not.toMatch(/npm\s+(?:error|ERR!)\s+code\s+EINTEGRITY\b/i);
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

async function startMockRegistryServer(
  statusCode: number,
  bodyPayload: Record<string, string>,
  onRequest?: (url: string) => void,
): Promise<{ server: http.Server; originUrl: string }> {
  const server = http.createServer((req, res) => {
    onRequest?.(req.url ?? '/');
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bodyPayload));
  });
  activeServers.add(server);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind mock registry HTTP server');
  }

  return {
    server,
    originUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function closeHttpServer(server: http.Server): Promise<void> {
  activeServers.delete(server);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForHealthReady(
  url: string,
  child: ChildProcess,
  getLogs: () => string,
): Promise<void> {
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

test.afterEach(async () => {
  for (const server of [...activeServers]) {
    await closeHttpServer(server);
  }
  for (const proc of [...activeProcesses]) {
    await stopProcess(proc);
  }
  for (const dir of [...tempDirs]) {
    tempDirs.delete(dir);
    await removeDirBestEffort(dir);
  }
});

test.describe('ISS-24: Verify npm install reliability on Windows', () => {
  test('AC-001_clean_checkout_npm_install_and_windows_platform_packages_resolve_reliably', async () => {
    test.skip(
      Boolean(PREVIEW_URL),
      'Clean-checkout npm CLI installation checks run in local/CI mode; PREVIEW_URL verifies deployed build artifacts.',
    );

    // 1. Validate lockfile invariants for Windows 10/11 (win32 x64 & arm64 bindings, sha512 integrity, zero Windows install scripts)
    const lockJson = JSON.parse(
      fs.readFileSync(path.join(WEB_DIR, 'package-lock.json'), 'utf8'),
    ) as {
      lockfileVersion: number;
      packages: Record<
        string,
        {
          version?: string;
          resolved?: string;
          integrity?: string;
          hasInstallScript?: boolean;
          os?: string[];
          optional?: boolean;
        }
      >;
    };

    expect(lockJson.lockfileVersion).toBe(3);
    for (const [pkgKey, meta] of Object.entries(lockJson.packages)) {
      if (pkgKey === '') {
        continue;
      }
      expect(meta.resolved, `Missing resolved tarball URL for ${pkgKey}`).toMatch(
        /^https:\/\/registry\.npmjs\.org\//,
      );
      expect(meta.integrity, `Missing sha512 integrity hash for ${pkgKey}`).toMatch(/^sha512-/);
      if (meta.hasInstallScript) {
        // Only darwin-optional fsevents may carry an install script; zero postinstall scripts run on win32
        expect(meta.optional).toBe(true);
        expect(meta.os).toEqual(['darwin']);
      }
    }

    for (const winNativePkg of [
      'node_modules/@rolldown/binding-win32-x64-msvc',
      'node_modules/@rolldown/binding-win32-arm64-msvc',
      'node_modules/lightningcss-win32-x64-msvc',
      'node_modules/lightningcss-win32-arm64-msvc',
    ]) {
      expect(lockJson.packages[winNativePkg]).toBeDefined();
      expect(lockJson.packages[winNativePkg].os).toContain('win32');
    }

    // 2. Clean checkout `npm install` with an isolated empty cache
    const cleanInstallWs = createCleanWebCheckout();
    const lockPath = path.join(cleanInstallWs.projectDir, 'package-lock.json');
    const lockHashBefore = sha256File(lockPath);

    const npmInstallResult = await runCommand(
      'npm',
      ['install', '--no-audit', '--no-fund'],
      cleanInstallWs.projectDir,
      buildIsolatedNpmEnv(cleanInstallWs.cacheDir),
    );

    expect(
      npmInstallResult.exitCode,
      `Clean-checkout npm install failed:\n${npmInstallResult.combinedOutput}`,
    ).toBe(0);
    assertNoEpermOrInstallErrors(npmInstallResult.combinedOutput);
    expect(sha256File(lockPath)).toBe(lockHashBefore);

    const depCheck = await verifyBuildDependencies(cleanInstallWs.projectDir, {
      requiredPackages: [...REQUIRED_BUILD_PACKAGES],
    });
    expect(depCheck.valid, `Missing required packages: ${depCheck.missing.join(', ')}`).toBe(true);
    expect(
      fs.existsSync(path.join(cleanInstallWs.projectDir, 'node_modules', 'typescript', 'bin', 'tsc')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(cleanInstallWs.projectDir, 'node_modules', 'vite', 'bin', 'vite.js')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(cleanInstallWs.projectDir, 'node_modules', 'fsevents')),
    ).toBe(false);

    if (process.platform === 'win32') {
      const winArchSuffix = process.arch === 'arm64' ? 'win32-arm64-msvc' : 'win32-x64-msvc';
      expect(
        fs.existsSync(
          path.join(
            cleanInstallWs.projectDir,
            'node_modules',
            '@rolldown',
            `binding-${winArchSuffix}`,
            'package.json',
          ),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            cleanInstallWs.projectDir,
            'node_modules',
            `lightningcss-${winArchSuffix}`,
            'package.json',
          ),
        ),
      ).toBe(true);
    } else {
      // On non-Windows hosts, explicitly verify win32 x64 and arm64 tarball resolution and extraction
      for (const cpuArch of ['x64', 'arm64'] as const) {
        const winTargetWs = createCleanWebCheckout();
        const winCiResult = await runCommand(
          'npm',
          ['ci', '--os=win32', `--cpu=${cpuArch}`, '--no-audit', '--no-fund'],
          winTargetWs.projectDir,
          buildIsolatedNpmEnv(winTargetWs.cacheDir),
        );
        expect(
          winCiResult.exitCode,
          `Simulated Windows (${cpuArch}) npm ci failed:\n${winCiResult.combinedOutput}`,
        ).toBe(0);
        assertNoEpermOrInstallErrors(winCiResult.combinedOutput);
        expect(
          fs.existsSync(
            path.join(
              winTargetWs.projectDir,
              'node_modules',
              '@rolldown',
              `binding-win32-${cpuArch}-msvc`,
              'package.json',
            ),
          ),
        ).toBe(true);
        expect(
          fs.existsSync(
            path.join(
              winTargetWs.projectDir,
              'node_modules',
              `lightningcss-win32-${cpuArch}-msvc`,
              'package.json',
            ),
          ),
        ).toBe(true);
      }
    }

    // 3. Clean checkout `npm run install:deps` (`web/tools/npm-install.mjs`)
    const helperWs = createCleanWebCheckout();
    const installDepsResult = await runCommand(
      'npm',
      ['run', 'install:deps'],
      helperWs.projectDir,
      buildIsolatedNpmEnv(helperWs.cacheDir),
    );
    expect(
      installDepsResult.exitCode,
      `npm run install:deps failed:\n${installDepsResult.combinedOutput}`,
    ).toBe(0);
    assertNoEpermOrInstallErrors(installDepsResult.combinedOutput);
  });

  test('AC-002_standard_and_locked_file_flows_complete_without_eperm_failures', async () => {
    test.skip(
      Boolean(PREVIEW_URL),
      'Filesystem cleanup and EPERM resilience checks run in local/CI mode.',
    );

    // Part A: Standard install, in-place re-install, and `npm run clean` emit zero EPERM errors
    const ws = createCleanWebCheckout();
    const firstInstall = await runCommand(
      'npm',
      ['install', '--no-audit', '--no-fund'],
      ws.projectDir,
      buildIsolatedNpmEnv(ws.cacheDir),
    );
    expect(firstInstall.exitCode).toBe(0);
    assertNoEpermOrInstallErrors(firstInstall.combinedOutput);

    const repeatInstall = await runCommand(
      'npm',
      ['install', '--no-audit', '--no-fund'],
      ws.projectDir,
      buildIsolatedNpmEnv(ws.cacheDir),
    );
    expect(repeatInstall.exitCode).toBe(0);
    assertNoEpermOrInstallErrors(repeatInstall.combinedOutput);

    // Populate a read-only file inside node_modules (common Windows EPERM trigger during rmdir)
    const readOnlyDir = path.join(ws.projectDir, 'node_modules', '@types', 'react-dom');
    const readOnlyFile = path.join(readOnlyDir, 'readonly-probe.d.ts');
    fs.writeFileSync(readOnlyFile, '// synthetic read-only file\n');
    fs.chmodSync(readOnlyFile, 0o444);

    const cleanResult = await runCommand(
      'npm',
      ['run', 'clean'],
      ws.projectDir,
      buildIsolatedNpmEnv(ws.cacheDir),
    );
    expect(
      cleanResult.exitCode,
      `npm run clean failed on read-only node_modules entry:\n${cleanResult.combinedOutput}`,
    ).toBe(0);
    assertNoEpermOrInstallErrors(cleanResult.combinedOutput);
    expect(fs.existsSync(path.join(ws.projectDir, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(ws.projectDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(ws.projectDir, 'package-lock.json'))).toBe(true);

    // Part B: On Windows, test holding an active open file handle during cleanupStaleArtifacts
    if (process.platform === 'win32') {
      const winLockDir = path.join(
        ws.projectDir,
        'node_modules',
        '@types',
        'react-dom',
        'test-utils',
      );
      const winSiblingDir = path.join(ws.projectDir, 'node_modules', 'vite');
      fs.mkdirSync(winLockDir, { recursive: true });
      fs.mkdirSync(winSiblingDir, { recursive: true });
      const heldFilePath = path.join(winLockDir, 'index.d.ts');
      fs.writeFileSync(heldFilePath, 'export {};\n');
      fs.writeFileSync(path.join(winSiblingDir, 'index.js'), 'export {};\n');

      const openHandle = await fsPromises.open(heldFilePath, 'r+');
      try {
        const winCleanup = await cleanupStaleArtifacts({
          projectDir: ws.projectDir,
          platform: 'win32',
          maxRetries: 1,
          retryDelayMs: 25,
        });
        expect(fs.existsSync(winSiblingDir)).toBe(false);
        expect(Array.isArray(winCleanup.warnings)).toBe(true);
      } finally {
        await openHandle.close();
      }
      await removeDirBestEffort(path.join(ws.projectDir, 'node_modules'));
    }

    // Part C: Deterministic transient & persistent EPERM/EBUSY lock handling via cleanupStaleArtifacts + runNpmInstallWithFallback
    const syntheticProject = path.join(ws.rootDir, 'synthetic-win32-lock');
    const nodeModulesTarget = path.join(syntheticProject, 'node_modules');
    const unlockedViteDir = path.join(nodeModulesTarget, 'vite');
    const lockedTypesDir = path.join(nodeModulesTarget, '@types');
    const sweepRemoved: string[] = [];
    const warnMessages: string[] = [];

    const makeLockErr = (code: string, p: string): Error & { code: string } => {
      const err = new Error(`${code}: operation not permitted, rmdir '${p}'`) as Error & {
        code: string;
      };
      err.code = code;
      return err;
    };

    const lockedFs: FsPromisesLike = {
      lstat: async (targetPath: string) => {
        if (
          targetPath === nodeModulesTarget ||
          targetPath.includes(`${path.sep}node_modules${path.sep}`)
        ) {
          return {};
        }
        throw makeLockErr('ENOENT', targetPath);
      },
      chmod: async () => {},
      readdir: async (dirPath: string): Promise<FsDirentLike[]> => {
        if (dirPath === nodeModulesTarget) {
          return [
            { name: 'vite', isDirectory: () => true },
            { name: '@types', isDirectory: () => true },
          ];
        }
        if (dirPath === lockedTypesDir) {
          return [{ name: 'react-dom', isDirectory: () => false }];
        }
        return [];
      },
      rm: async (targetPath: string) => {
        if (targetPath === unlockedViteDir) {
          sweepRemoved.push(targetPath);
          return;
        }
        throw makeLockErr('EPERM', targetPath);
      },
    };

    const resilientInstall = await runNpmInstallWithFallback({
      projectDir: syntheticProject,
      platform: 'win32',
      fsImpl: lockedFs,
      maxCleanupRetries: 1,
      cleanupRetryDelayMs: 0,
      logger: {
        info: () => {},
        warn: (msg) => warnMessages.push(msg),
        error: () => {},
      },
      runCommand: async () => ({
        exitCode: 0,
        stdout: 'up to date in 500ms',
        stderr: '',
        error: null,
      }),
    });

    expect(resilientInstall.success).toBe(true);
    expect(resilientInstall.exitCode).toBe(0);
    expect(sweepRemoved).toEqual([unlockedViteDir]);
    expect(resilientInstall.cleanup.skippedLocked.length).toBeGreaterThan(0);
    expect(warnMessages.some((m) => m.includes('Proceeding with installation without hard failing'))).toBe(
      true,
    );
  });

  test('AC-003_npm_run_build_succeeds_after_clean_install_and_produces_complete_bundle', async () => {
    test.skip(
      Boolean(PREVIEW_URL),
      'Clean-checkout npm install + npm run build checks run in local/CI mode.',
    );

    const pkgJson = JSON.parse(fs.readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkgJson.scripts.build).toBe(
      'node ./node_modules/typescript/bin/tsc --noEmit && node ./node_modules/vite/bin/vite.js build',
    );

    const ws = createCleanWebCheckout();
    const env = buildIsolatedNpmEnv(ws.cacheDir);

    const installResult = await runCommand(
      'npm',
      ['install', '--no-audit', '--no-fund'],
      ws.projectDir,
      env,
    );
    expect(
      installResult.exitCode,
      `npm install before build failed:\n${installResult.combinedOutput}`,
    ).toBe(0);
    assertNoEpermOrInstallErrors(installResult.combinedOutput);

    const buildResult = await runCommand('npm', ['run', 'build'], ws.projectDir, env);
    expect(
      buildResult.exitCode,
      `npm run build after clean install failed:\n${buildResult.combinedOutput}`,
    ).toBe(0);
    assertNoEpermOrInstallErrors(buildResult.combinedOutput);

    const distDir = path.join(ws.projectDir, 'dist');
    const distIndexPath = path.join(distDir, 'index.html');
    expect(fs.existsSync(distIndexPath)).toBe(true);
    const indexHtml = fs.readFileSync(distIndexPath, 'utf8');
    expect(indexHtml).toContain('<div id="root"></div>');

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

  test('AC-004_consecutive_clean_npm_ci_installs_are_idempotent_and_ci_flows_have_no_regressions', async () => {
    test.skip(
      Boolean(PREVIEW_URL),
      'Consecutive CI install idempotency and registry fallback checks run in local/CI mode.',
    );

    // 1. Validate web/.npmrc and Dockerfile CI invariants
    const npmrcText = fs.readFileSync(path.join(WEB_DIR, '.npmrc'), 'utf8');
    expect(npmrcText).toMatch(/fetch-retries=/);
    expect(npmrcText).toMatch(/fetch-timeout=/);
    expect(npmrcText).not.toMatch(/^\s*registry\s*=/m);

    const dockerfileText = fs.readFileSync(DOCKERFILE_PATH, 'utf8');
    expect(dockerfileText).toContain('RUN npm ci --no-audit --no-fund');
    expect(dockerfileText).toContain('RUN npm run build');

    // 2. Execute two consecutive clean `npm ci` runs from a fresh checkout to confirm idempotency
    const ciWs = createCleanWebCheckout();
    const lockPath = path.join(ciWs.projectDir, 'package-lock.json');
    const initialLockHash = sha256File(lockPath);
    const ciEnv = buildIsolatedNpmEnv(ciWs.cacheDir, { CI: 'true' });

    const ciRun1 = await runCommand(
      'npm',
      ['ci', '--no-audit', '--no-fund'],
      ciWs.projectDir,
      ciEnv,
    );
    expect(ciRun1.exitCode, `Clean npm ci #1 failed:\n${ciRun1.combinedOutput}`).toBe(0);
    assertNoEpermOrInstallErrors(ciRun1.combinedOutput);
    expect(sha256File(lockPath)).toBe(initialLockHash);
    const snapshot1 = snapshotInstalledPackages(ciWs.projectDir);
    expect(snapshot1.length).toBeGreaterThanOrEqual(REQUIRED_BUILD_PACKAGES.length);

    const ciRun2 = await runCommand(
      'npm',
      ['ci', '--no-audit', '--no-fund'],
      ciWs.projectDir,
      ciEnv,
    );
    expect(ciRun2.exitCode, `Consecutive clean npm ci #2 failed:\n${ciRun2.combinedOutput}`).toBe(0);
    assertNoEpermOrInstallErrors(ciRun2.combinedOutput);
    expect(sha256File(lockPath)).toBe(initialLockHash);
    const snapshot2 = snapshotInstalledPackages(ciWs.projectDir);
    expect(snapshot2).toEqual(snapshot1);

    // 3. Verify `npm run install:ci` under CI + production-omit env vars preserves devDependencies and builds cleanly
    const prodCiEnv = buildIsolatedNpmEnv(ciWs.cacheDir, {
      CI: 'true',
      NODE_ENV: 'production',
      npm_config_production: 'true',
      npm_config_omit: 'dev',
    });
    const installCiRes = await runCommand('npm', ['run', 'install:ci'], ciWs.projectDir, prodCiEnv);
    expect(
      installCiRes.exitCode,
      `npm run install:ci under production env vars failed:\n${installCiRes.combinedOutput}`,
    ).toBe(0);
    assertNoEpermOrInstallErrors(installCiRes.combinedOutput);
    expect(snapshotInstalledPackages(ciWs.projectDir)).toEqual(snapshot1);

    const postCiBuild = await runCommand(
      'npm',
      ['run', 'build'],
      ciWs.projectDir,
      buildIsolatedNpmEnv(ciWs.cacheDir, { CI: 'true' }),
    );
    expect(
      postCiBuild.exitCode,
      `npm run build after consecutive npm ci failed:\n${postCiBuild.combinedOutput}`,
    ).toBe(0);

    // 4. REQ-002: Verify real loopback 503 primary registry triggers single fallback to https://registry.npmjs.org/
    const fallbackWs = createCleanWebCheckout();
    let primaryHits = 0;
    const { server: srv503, originUrl: origin503 } = await startMockRegistryServer(
      503,
      { error: 'Service Unavailable' },
      () => {
        primaryHits++;
      },
    );

    const fallbackWarns: string[] = [];
    const fallbackErrors: string[] = [];
    try {
      const fallbackResult = await runNpmInstallWithFallback({
        projectDir: fallbackWs.projectDir,
        ci: true,
        env: buildIsolatedNpmEnv(fallbackWs.cacheDir, {
          CI: 'true',
          NPM_CONFIG_REGISTRY: `${origin503}/npm/?probe=synthetic_query_value`,
        }) as Record<string, string | undefined>,
        logger: {
          info: () => {},
          warn: (msg) => fallbackWarns.push(msg),
          error: (msg) => fallbackErrors.push(msg),
        },
      });

      expect(primaryHits).toBeGreaterThan(0);
      expect(fallbackResult.success).toBe(true);
      expect(fallbackResult.usedFallback).toBe(true);
      expect(fallbackResult.attempts).toBe(2);
      expect(fallbackErrors).toEqual([]);
      expect(fallbackWarns.some((m) => m.includes(PUBLIC_NPM_REGISTRY))).toBe(true);
      expect(fallbackWarns.some((m) => m.includes('synthetic_query_value'))).toBe(false);
    } finally {
      await closeHttpServer(srv503);
    }

    // 5. REQ-003: Verify real loopback 404 registry error does NOT loop/fallback and surfaces actionable guidance
    const e404Ws = createCleanWebCheckout();
    const { server: srv404, originUrl: origin404 } = await startMockRegistryServer(404, {
      error: 'Not Found',
    });

    const e404Errors: string[] = [];
    try {
      const e404Result = await runNpmInstallWithFallback({
        projectDir: e404Ws.projectDir,
        ci: true,
        env: buildIsolatedNpmEnv(e404Ws.cacheDir, {
          CI: 'true',
          NPM_CONFIG_REGISTRY: `${origin404}/npm/`,
        }) as Record<string, string | undefined>,
        logger: {
          info: () => {},
          warn: () => {},
          error: (msg) => e404Errors.push(msg),
        },
      });

      expect(e404Result.success).toBe(false);
      expect(e404Result.usedFallback).toBe(false);
      expect(e404Result.attempts).toBe(1);
      expect(e404Result.classification?.code).toBe('E404');
      expect(e404Errors.length).toBe(1);
      expect(e404Errors[0]).toContain('[npm-install] Error:');
      expect(e404Errors[0]).toContain('HTTP 404');
      expect(e404Errors[0]).toContain('Actionable steps:');
      expect(e404Errors[0]).toContain(`NPM_CONFIG_REGISTRY=${PUBLIC_NPM_REGISTRY}`);
    } finally {
      await closeHttpServer(srv404);
    }

    // 6. Full-stack dotnet build regression check (BuildWebFrontend)
    const dotnetBuild = await runCommand(
      'dotnet',
      ['build', API_CSPROJ_REL, '--nologo'],
      REPO_ROOT,
    );
    expect(
      dotnetBuild.exitCode,
      `dotnet build ${API_CSPROJ_REL} failed:\n${dotnetBuild.combinedOutput}`,
    ).toBe(0);
    expect(dotnetBuild.combinedOutput).not.toMatch(/MSB3073/i);
  });

  test('AC-003_AC-004_built_application_serves_health_probe_and_renders_beatbox_spa', async ({
    page,
  }) => {
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
