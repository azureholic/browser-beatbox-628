import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyRegistryError,
  cleanupStaleArtifacts,
  FALLBACK_GUARD_ENV,
  formatRegistryErrorGuidance,
  parseCliArgs,
  PUBLIC_NPM_REGISTRY,
  runNpmInstallWithFallback,
  sanitizeLogMessage,
  sanitizeRegistryUrl,
  verifyBuildDependencies,
  type CommandInvocation,
  type FsDirentLike,
  type FsPromisesLike,
  type NpmInstallLogger,
} from '../tools/npm-install.mjs';

interface CapturedLogs {
  info: string[];
  warn: string[];
  error: string[];
  logger: NpmInstallLogger;
}

function createMemoryLogger(): CapturedLogs {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  return {
    info,
    warn,
    error,
    logger: {
      info: (msg) => info.push(msg),
      warn: (msg) => warn.push(msg),
      error: (msg) => error.push(msg),
    },
  };
}

function createLockError(code: string, targetPath: string): Error & { code: string } {
  const err = new Error(`${code}: operation not permitted, '${targetPath}'`) as Error & {
    code: string;
  };
  err.code = code;
  return err;
}

describe('NPM Install Robustness — Windows Cleanup (Issue #23)', () => {
  it('removes stale node_modules and local .npm cache artifacts without touching unrelated files', async () => {
    const rootDir = await fsPromises.mkdtemp(path.join(tmpdir(), 'beatbox-npm-cleanup-'));
    const projectDir = path.join(rootDir, 'web');
    const cacheDir = path.join(rootDir, 'custom-cache');
    const siblingFile = path.join(rootDir, 'keep-outside.txt');

    try {
      await fsPromises.mkdir(path.join(projectDir, 'node_modules', 'vite'), { recursive: true });
      await fsPromises.mkdir(path.join(projectDir, '.npm', '_cacache'), { recursive: true });
      await fsPromises.mkdir(path.join(projectDir, '.npm-cache'), { recursive: true });
      await fsPromises.mkdir(path.join(projectDir, 'src'), { recursive: true });
      await fsPromises.mkdir(path.join(cacheDir, '_locks'), { recursive: true });
      await fsPromises.mkdir(path.join(cacheDir, '_cacache', 'tmp'), { recursive: true });
      await fsPromises.mkdir(path.join(cacheDir, '_cacache', 'content-v2'), { recursive: true });

      await fsPromises.writeFile(path.join(projectDir, 'node_modules', 'vite', 'index.js'), '');
      await fsPromises.writeFile(path.join(projectDir, '.npm', '_cacache', 'stale'), '');
      await fsPromises.writeFile(path.join(projectDir, 'package.json'), '{"name":"web"}');
      await fsPromises.writeFile(path.join(projectDir, '.npmrc'), 'fetch-retries=2\n');
      await fsPromises.writeFile(path.join(projectDir, 'src', 'App.tsx'), 'export {};\n');
      await fsPromises.writeFile(path.join(cacheDir, '_locks', 'stale.lock'), '');
      await fsPromises.writeFile(path.join(cacheDir, '_cacache', 'tmp', 'partial.tgz'), '');
      await fsPromises.writeFile(path.join(cacheDir, '_cacache', 'content-v2', 'cached.tgz'), '');
      await fsPromises.writeFile(siblingFile, 'keep');

      const { logger, warn } = createMemoryLogger();
      const result = await cleanupStaleArtifacts({
        projectDir,
        npmCacheDir: cacheDir,
        retryDelayMs: 1,
        logger,
      });

      assert.equal(warn.length, 0);
      assert.equal(result.skippedLocked.length, 0);
      assert.equal(existsSync(path.join(projectDir, 'node_modules')), false);
      assert.equal(existsSync(path.join(projectDir, '.npm')), false);
      assert.equal(existsSync(path.join(projectDir, '.npm-cache')), false);
      assert.equal(existsSync(path.join(cacheDir, '_locks')), false);
      assert.equal(existsSync(path.join(cacheDir, '_cacache', 'tmp')), false);

      // Unrelated project files, shared tarball cache, and sibling files remain untouched
      assert.equal(existsSync(path.join(projectDir, 'package.json')), true);
      assert.equal(existsSync(path.join(projectDir, '.npmrc')), true);
      assert.equal(existsSync(path.join(projectDir, 'src', 'App.tsx')), true);
      assert.equal(existsSync(path.join(cacheDir, '_cacache', 'content-v2', 'cached.tgz')), true);
      assert.equal(existsSync(siblingFile), true);
    } finally {
      await fsPromises.rm(rootDir, { recursive: true, force: true });
    }
  });

  it('retries transient EPERM errors on win32 and clears read-only attributes before succeeding', async () => {
    const projectDir = path.resolve('/tmp/synthetic-win32-transient');
    const nodeModulesPath = path.join(projectDir, 'node_modules');
    const chmodCalls: Array<{ targetPath: string; mode: number }> = [];
    let rmAttempts = 0;

    const fakeFs: FsPromisesLike = {
      lstat: async (targetPath) => {
        if (targetPath === nodeModulesPath) {
          return {};
        }
        throw createLockError('ENOENT', targetPath);
      },
      chmod: async (targetPath, mode) => {
        chmodCalls.push({ targetPath, mode });
      },
      rm: async (targetPath) => {
        rmAttempts++;
        if (rmAttempts < 3) {
          throw createLockError('EPERM', targetPath);
        }
      },
    };

    const { logger, warn } = createMemoryLogger();
    const result = await cleanupStaleArtifacts({
      projectDir,
      platform: 'win32',
      fsImpl: fakeFs,
      maxRetries: 3,
      retryDelayMs: 0,
      logger,
    });

    assert.equal(rmAttempts, 3);
    assert.equal(chmodCalls.length, 2);
    assert.deepEqual(result.cleaned, [nodeModulesPath]);
    assert.deepEqual(result.skippedLocked, []);
    assert.equal(warn.length, 0);
  });

  it('handles persistent EPERM/EBUSY locked files on win32 without hard failing while sweeping unlocked siblings', async () => {
    const projectDir = path.resolve('/tmp/synthetic-win32-locked');
    const nodeModulesPath = path.join(projectDir, 'node_modules');
    const unlockedPkgPath = path.join(nodeModulesPath, 'vite');
    const lockedTypesDir = path.join(nodeModulesPath, '@types');
    const lockedSubPath = path.join(lockedTypesDir, 'react-dom');
    const removedPaths: string[] = [];

    const fakeFs: FsPromisesLike = {
      lstat: async (targetPath) => {
        if (targetPath === nodeModulesPath) {
          return {};
        }
        throw createLockError('ENOENT', targetPath);
      },
      chmod: async () => {},
      readdir: async (dirPath): Promise<FsDirentLike[]> => {
        if (dirPath === nodeModulesPath) {
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
      rm: async (targetPath) => {
        if (targetPath === unlockedPkgPath) {
          removedPaths.push(targetPath);
          return;
        }
        throw createLockError(targetPath === lockedSubPath ? 'EBUSY' : 'EPERM', targetPath);
      },
    };

    const { logger, warn } = createMemoryLogger();
    const result = await cleanupStaleArtifacts({
      projectDir,
      platform: 'win32',
      fsImpl: fakeFs,
      maxRetries: 1,
      retryDelayMs: 0,
      logger,
    });

    assert.deepEqual(removedPaths, [unlockedPkgPath]);
    assert.equal(result.skippedLocked.length > 0, true);
    assert.equal(warn.length, 1);
    assert.match(warn[0], /Proceeding with installation without hard failing/);
  });

  it('does not swallow unexpected permission errors on non-Windows platforms', async () => {
    const projectDir = path.resolve('/tmp/synthetic-linux-perm');
    const nodeModulesPath = path.join(projectDir, 'node_modules');

    const fakeFs: FsPromisesLike = {
      lstat: async (targetPath) => {
        if (targetPath === nodeModulesPath) {
          return {};
        }
        throw createLockError('ENOENT', targetPath);
      },
      rm: async (targetPath) => {
        throw createLockError('EPERM', targetPath);
      },
    };

    await assert.rejects(
      () =>
        cleanupStaleArtifacts({
          projectDir,
          platform: 'linux',
          fsImpl: fakeFs,
          maxRetries: 1,
          retryDelayMs: 0,
        }),
      /EPERM/,
    );
  });
});

describe('NPM Install Robustness — Error Classification & Registry Fallback (Issue #23)', () => {
  it('classifies expected registry connectivity errors as fallback-eligible and rejects unrelated errors', () => {
    const timeoutClass = classifyRegistryError('npm error code ETIMEDOUT\nnpm error network timeout');
    assert.equal(timeoutClass.isRegistryError, true);
    assert.equal(timeoutClass.shouldFallback, true);
    assert.equal(timeoutClass.code, 'ETIMEDOUT');
    assert.equal(timeoutClass.reason, 'timeout');

    const refusedClass = classifyRegistryError('npm error code ECONNREFUSED');
    assert.equal(refusedClass.shouldFallback, true);
    assert.equal(refusedClass.reason, 'connection refused');

    const dnsClass = classifyRegistryError('npm error code ENOTFOUND\ngetaddrinfo ENOTFOUND');
    assert.equal(dnsClass.shouldFallback, true);
    assert.equal(dnsClass.reason, 'dns lookup failed');

    const tlsClass = classifyRegistryError('npm error code UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    assert.equal(tlsClass.shouldFallback, true);
    assert.equal(tlsClass.reason, 'tls verification failed');

    const http503Class = classifyRegistryError('npm error 503 Service Unavailable - GET');
    assert.equal(http503Class.shouldFallback, true);
    assert.equal(http503Class.code, 'E503');
    assert.equal(http503Class.reason, 'registry server error (HTTP 503)');

    // Detects ECONNREFUSED captured in npm's debug log when stderr only prints "Exit handler never called!"
    const debugLogClass = classifyRegistryError({
      exitCode: 1,
      stdout: '',
      stderr: 'npm error Exit handler never called!',
      debugLog: '308 http fetch GET http://127.0.0.1:59997/vite/-/vite-8.3.8.tgz attempt 3 failed with ECONNREFUSED\nsha512-abc+e503/xyz==',
      error: null,
    });
    assert.equal(debugLogClass.shouldFallback, true);
    assert.equal(debugLogClass.code, 'ECONNREFUSED');
    assert.equal(debugLogClass.reason, 'connection refused');

    // E404 and E401 are registry errors (with actionable guidance) but must NOT auto-fallback
    const e404Class = classifyRegistryError('npm error code E404\nnpm error 404 Not Found - GET');
    assert.equal(e404Class.isRegistryError, true);
    assert.equal(e404Class.shouldFallback, false);
    assert.ok(e404Class.actionableMessage);
    assert.match(e404Class.actionableMessage, /HTTP 404/);

    const e401Class = classifyRegistryError('npm error code E401\n401 Unauthorized');
    assert.equal(e401Class.isRegistryError, true);
    assert.equal(e401Class.shouldFallback, false);
    assert.ok(e401Class.actionableMessage);

    // Non-registry errors (peer conflict, checksum mismatch, syntax error) never fallback
    for (const nonRegistryStderr of [
      'npm error code ERESOLVE\nERESOLVE unable to resolve dependency tree',
      'npm error code EINTEGRITY\nsha512 integrity checksum failed',
      'npm error code EJSONPARSE\nInvalid package.json',
    ]) {
      const result = classifyRegistryError(nonRegistryStderr);
      assert.equal(result.isRegistryError, false);
      assert.equal(result.shouldFallback, false);
    }
  });

  it('respects configured registry on primary attempt and retries once against https://registry.npmjs.org/ on timeout', async () => {
    const invocations: CommandInvocation[] = [];
    const { logger, info, warn, error } = createMemoryLogger();

    const fakeFs: FsPromisesLike = {
      lstat: async (targetPath) => {
        if (targetPath.includes(`${path.sep}node_modules${path.sep}`)) {
          return {};
        }
        throw createLockError('ENOENT', targetPath);
      },
      rm: async () => {},
    };

    const customRegistry = 'https://registry.example.test/npm/feed?sig=synthetic-secret-value';
    const result = await runNpmInstallWithFallback({
      projectDir: '/tmp/synthetic-project',
      platform: 'win32',
      env: {
        NPM_CONFIG_REGISTRY: customRegistry,
        CI: 'true',
      },
      fsImpl: fakeFs,
      cleanupRetryDelayMs: 0,
      logger,
      runCommand: async (invocation) => {
        invocations.push(invocation);
        if (invocation.attempt === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'npm error code ETIMEDOUT\nnpm error network request failed',
            error: null,
          };
        }
        return {
          exitCode: 0,
          stdout: 'added 25 packages in 1s',
          stderr: '',
          error: null,
        };
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.usedFallback, true);
    assert.equal(result.attempts, 2);
    assert.equal(invocations.length, 2);

    // Primary attempt must NOT override --registry and must preserve caller env vars
    assert.equal(
      invocations[0].args.some((arg) => arg.startsWith('--registry')),
      false,
    );
    assert.equal(invocations[0].env.NPM_CONFIG_REGISTRY, customRegistry);
    assert.equal(invocations[0].env.CI, 'true');

    // Fallback attempt targets public npmjs.org registry and sets loop-prevention guard
    assert.equal(invocations[1].args.includes(`--registry=${PUBLIC_NPM_REGISTRY}`), true);
    assert.equal(invocations[1].env.NPM_CONFIG_REGISTRY, PUBLIC_NPM_REGISTRY);
    assert.equal(invocations[1].env[FALLBACK_GUARD_ENV], '1');

    // Logs state fallback reason ('timeout'), never leak query parameter secrets, and confirm recovery
    assert.equal(warn.length, 1);
    assert.match(warn[0], /timeout/);
    assert.match(warn[0], /https:\/\/registry\.npmjs\.org\//);
    assert.doesNotMatch(warn[0], /synthetic-secret-value/);
    assert.equal(info.length, 1);
    assert.equal(error.length, 0);
  });

  it('enforces a strict single-fallback cap and surfaces actionable guidance if fallback also fails', async () => {
    let callCount = 0;
    const { logger, error } = createMemoryLogger();

    const fakeFs: FsPromisesLike = {
      lstat: async () => {
        throw createLockError('ENOENT', '/tmp/none');
      },
      rm: async () => {},
    };

    const result = await runNpmInstallWithFallback({
      projectDir: '/tmp/synthetic-both-fail',
      verifyDeps: false,
      fsImpl: fakeFs,
      logger,
      runCommand: async () => {
        callCount++;
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'npm error code ECONNREFUSED',
          error: null,
        };
      },
    });

    assert.equal(result.success, false);
    assert.equal(result.usedFallback, true);
    assert.equal(result.attempts, 2);
    assert.equal(callCount, 2);
    assert.equal(error.length, 1);
    assert.match(error[0], /Actionable steps:/);
    assert.match(error[0], /connection refused/);

    // If FALLBACK_GUARD_ENV is already set, zero additional fallback retries occur
    let guardedCalls = 0;
    const guardedResult = await runNpmInstallWithFallback({
      projectDir: '/tmp/synthetic-guarded',
      env: { [FALLBACK_GUARD_ENV]: '1' },
      verifyDeps: false,
      fsImpl: fakeFs,
      logger,
      runCommand: async () => {
        guardedCalls++;
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'npm error code ETIMEDOUT',
          error: null,
        };
      },
    });

    assert.equal(guardedResult.success, false);
    assert.equal(guardedResult.usedFallback, false);
    assert.equal(guardedCalls, 1);
  });

  it('does not trigger fallback on non-connectivity errors (E404, ERESOLVE) and surfaces actionable 404 help', async () => {
    let attempts = 0;
    const { logger, error } = createMemoryLogger();

    const fakeFs: FsPromisesLike = {
      lstat: async () => {
        throw createLockError('ENOENT', '/tmp/none');
      },
      rm: async () => {},
    };

    const e404Result = await runNpmInstallWithFallback({
      projectDir: '/tmp/synthetic-404',
      verifyDeps: false,
      fsImpl: fakeFs,
      logger,
      runCommand: async () => {
        attempts++;
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.example.test/vite/-/vite-8.3.8.tgz',
          error: null,
        };
      },
    });

    assert.equal(e404Result.success, false);
    assert.equal(e404Result.usedFallback, false);
    assert.equal(attempts, 1);
    assert.equal(error.length, 1);
    assert.match(error[0], /HTTP 404/);
    assert.match(error[0], /NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org\//);
  });
});

describe('NPM Install Robustness — Sanitization, Config & Build Dependency Checks (Issue #23)', () => {
  it('redacts tokens, auth headers, credentials, and sensitive URL query strings from logs', () => {
    const schemeWord = 'Bear' + 'er';
    const fakeAuthValue = 'synthetic_secret_header_value_12345';
    const fakeNpmToken = 'npm_' + 'SyntheticTokenValue1234567890';
    const fakeQuerySecret = 'sv=2026-01-01&sig=SyntheticQuerySignature999';

    const urlWithCreds = ['https://', 'demo_user', ':', 'synthetic_pw', '@registry.example.test'].join('');
    const rawLog = [
      `Authorization: ${schemeWord} ${fakeAuthValue}`,
      `//registry.example.test/:_authToken=${fakeNpmToken}`,
      `GET ${urlWithCreds}/npm/vite/-/vite.tgz?${fakeQuerySecret}`,
    ].join('\n');

    const sanitized = sanitizeLogMessage(rawLog);
    assert.doesNotMatch(sanitized, new RegExp(fakeAuthValue));
    assert.doesNotMatch(sanitized, new RegExp(fakeNpmToken));
    assert.doesNotMatch(sanitized, /synthetic_pw/);
    assert.doesNotMatch(sanitized, /SyntheticQuerySignature999/);
    assert.match(sanitized, /\[REDACTED\]/);

    assert.equal(
      sanitizeRegistryUrl(`${urlWithCreds}/private/feed?token=xyz#frag`),
      'https://registry.example.test/',
    );
    assert.equal(sanitizeRegistryUrl('https://registry.npmjs.org/'), 'https://registry.npmjs.org/');
  });

  it('verifies Vite and required build dependencies and parses CLI flags accurately', async () => {
    const presentSet = new Set([
      path.resolve('/tmp/proj/node_modules/vite/package.json'),
      path.resolve('/tmp/proj/node_modules/typescript/package.json'),
      path.resolve('/tmp/proj/node_modules/@vitejs/plugin-react/package.json'),
      path.resolve('/tmp/proj/node_modules/react/package.json'),
    ]);

    const checkMissing = await verifyBuildDependencies('/tmp/proj', {
      fsImpl: {
        lstat: async (target) => {
          if (presentSet.has(target)) {
            return {};
          }
          throw createLockError('ENOENT', target);
        },
        rm: async () => {},
      },
    });

    assert.equal(checkMissing.valid, false);
    assert.deepEqual(checkMissing.missing, ['react-dom']);

    const flags = parseCliArgs(['--ci', '--no-clean']);
    assert.equal(flags.ci, true);
    assert.equal(flags.cleanBeforeInstall, false);
    assert.equal(flags.cleanOnly, false);
    assert.equal(flags.verifyDeps, true);

    const guidance = formatRegistryErrorGuidance(
      {
        isRegistryError: true,
        shouldFallback: true,
        code: 'ETIMEDOUT',
        reason: 'timeout',
        actionableMessage: null,
      },
      { usedFallback: true },
    );
    assert.match(guidance, /Actionable steps:/);

    // Verify web/.npmrc exists and does not hardcode or override `registry=`
    const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const npmrcPath = path.join(webRoot, '.npmrc');
    assert.equal(existsSync(npmrcPath), true);
    const npmrcContent = new TextDecoder().decode(readFileSync(npmrcPath));
    assert.match(npmrcContent, /fetch-timeout=/);
    assert.doesNotMatch(npmrcContent, /^\s*registry\s*=/m);
  });
});

describe('MSBuild BuildWebFrontend & DevDependencies Build Resilience (Issue #28)', () => {
  it('enforces --include=dev and neutralizes production omit env vars during primary and fallback installs', async () => {
    const invocations: CommandInvocation[] = [];
    const { logger } = createMemoryLogger();

    const result = await runNpmInstallWithFallback({
      projectDir: '/tmp/synthetic-web-prod',
      ci: true,
      cleanBeforeInstall: false,
      verifyDeps: false,
      env: {
        NODE_ENV: 'production',
        npm_config_production: 'true',
        NPM_CONFIG_PRODUCTION: 'true',
        npm_config_omit: 'dev',
        NPM_CONFIG_OMIT: 'dev',
        NPM_CONFIG_REGISTRY: 'https://registry.example.test/npm/',
      },
      logger,
      runCommand: async (inv) => {
        invocations.push(inv);
        if (inv.attempt === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'npm ERR! code ETIMEDOUT\nnpm ERR! network connect ETIMEDOUT',
            error: null,
          };
        }
        return {
          exitCode: 0,
          stdout: 'added 25 packages',
          stderr: '',
          error: null,
        };
      },
    });

    assert.equal(result.success, true);
    assert.equal(invocations.length, 2);

    for (const inv of invocations) {
      assert.equal(inv.args[0], 'ci');
      assert.equal(inv.args.includes('--include=dev'), true);
      assert.equal(inv.env.NODE_ENV, 'development');
      assert.equal('npm_config_production' in inv.env, false);
      assert.equal('NPM_CONFIG_PRODUCTION' in inv.env, false);
      assert.equal('npm_config_omit' in inv.env, false);
      assert.equal('NPM_CONFIG_OMIT' in inv.env, false);
    }
  });

  it('configures BuildWebFrontend and package.json build scripts to self-heal partial node_modules and execute workspace CLIs', async () => {
    const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const repoRoot = path.resolve(webRoot, '..');
    const csprojPath = path.join(repoRoot, 'src', 'Beatbox.Api', 'Beatbox.Api.csproj');
    const pkgJsonPath = path.join(webRoot, 'package.json');

    const decoder = new TextDecoder();
    const csprojContent = decoder.decode(readFileSync(csprojPath));
    assert.match(csprojContent, /Name="BuildWebFrontend"/);
    assert.match(csprojContent, /package-lock\.json/);
    assert.match(csprojContent, /node_modules\\typescript\\bin\\tsc/);
    assert.match(csprojContent, /node_modules\\vite\\bin\\vite\.js/);
    assert.match(csprojContent, /node_modules\\@types\\react\\package\.json/);
    assert.match(csprojContent, /node_modules\\@types\\react-dom\\package\.json/);
    assert.match(csprojContent, /Command="node \.\/tools\/npm-install\.mjs --ci"/);
    assert.match(csprojContent, /Command="npm run build"\s+StandardErrorImportance="High"/);

    const pkgJson = JSON.parse(decoder.decode(readFileSync(pkgJsonPath))) as {
      scripts: Record<string, string>;
    };
    assert.equal(
      pkgJson.scripts.build,
      'node ./node_modules/typescript/bin/tsc --noEmit && node ./node_modules/vite/bin/vite.js build',
    );
    assert.equal(pkgJson.scripts.typecheck, 'node ./node_modules/typescript/bin/tsc --noEmit');

    const verification = await verifyBuildDependencies(webRoot, {
      requiredPackages: [
        'vite',
        'typescript',
        '@vitejs/plugin-react',
        '@types/react',
        '@types/react-dom',
        'react',
        'react-dom',
      ],
    });
    assert.equal(verification.valid, true, `Missing build packages: ${verification.missing.join(', ')}`);
    assert.equal(existsSync(path.join(webRoot, 'node_modules', 'typescript', 'bin', 'tsc')), true);
    assert.equal(existsSync(path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js')), true);
  });
});
