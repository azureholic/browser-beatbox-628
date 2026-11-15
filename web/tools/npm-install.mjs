import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org/';
export const FALLBACK_GUARD_ENV = 'BEATBOX_NPM_FALLBACK_ACTIVE';

const DEFAULT_PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_PROJECT_ARTIFACTS = new Set(['node_modules', '.npm', '.npm-cache']);
const ALLOWED_CACHE_SUBPATHS = ['_locks', path.join('_cacache', 'tmp')];
const WINDOWS_LOCK_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const DEFAULT_REQUIRED_BUILD_PACKAGES = [
  'vite',
  'typescript',
  '@vitejs/plugin-react',
  'react',
  'react-dom',
];

const NON_REGISTRY_ERROR_CODES = new Set([
  'EINTEGRITY',
  'ERESOLVE',
  'EJSONPARSE',
  'EBADENGINE',
  'EBADPLATFORM',
  'ENOSPC',
  'EISGIT',
]);

const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const CONNECTION_RESET_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
]);

const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL']);
const NETWORK_UNREACHABLE_CODES = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EPROTO',
]);

/**
 * Sanitizes a registry URL so credentials, tokens, path secrets, and query parameters
 * are never exposed in logs.
 */
export function sanitizeRegistryUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return '<configured-registry>';
  }

  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '<configured-registry>';
    }
    return `${parsed.origin}/`;
  } catch {
    return '<configured-registry>';
  }
}

/**
 * Redacts tokens, auth headers, credentials, and sensitive URL query strings from log text.
 */
export function sanitizeLogMessage(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return '';
  }

  let sanitized = input;

  // Redact HTTP Authorization and Proxy-Authorization headers
  sanitized = sanitized.replace(
    /((?:proxy-)?authorization\s*[:=]\s*)(?:(?:bearer|basic|token|digest|negotiate)\s+)?[^\s"',;\r\n]+/gi,
    '$1[REDACTED]',
  );

  // Redact standalone scheme-prefixed auth values
  sanitized = sanitized.replace(
    /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    '$1 [REDACTED]',
  );

  // Redact .npmrc auth directives (e.g. //registry.example.test/:_authToken=...)
  sanitized = sanitized.replace(
    /(:(?:_authToken|_auth|_password|authToken|password|token)\s*=\s*)[^\s"'\r\n]+/gi,
    '$1[REDACTED]',
  );

  // Redact key=value or key: value credentials/tokens
  sanitized = sanitized.replace(
    /\b(_authToken|_auth|authToken|access_token|refresh_token|api_key|apikey|client_secret|password|secret|token|sig)(\s*[:=]\s*["']?)([^"'\s&,;\r\n]+)/gi,
    '$1$2[REDACTED]',
  );

  // Redact common token prefixes
  sanitized = sanitized.replace(
    /\b(?:npm_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
    '[REDACTED_TOKEN]',
  );

  // Sanitize URLs with userinfo or query parameters/fragments
  sanitized = sanitized.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (matchedUrl) => {
    try {
      const parsed = new URL(matchedUrl);
      const hasCredentials = parsed.username.length > 0 || parsed.password.length > 0;
      const hasQuery = parsed.search.length > 0;
      parsed.username = '';
      parsed.password = '';
      parsed.hash = '';
      if (hasQuery) {
        parsed.search = '';
      }
      let rebuilt = parsed.toString();
      if (hasCredentials) {
        rebuilt = rebuilt.replace(`${parsed.protocol}//`, `${parsed.protocol}//[REDACTED]@`);
      }
      if (hasQuery) {
        rebuilt = `${rebuilt}?[REDACTED]`;
      }
      return rebuilt;
    } catch {
      return matchedUrl
        .replace(/\/\/[^/\s@]+@/g, '//[REDACTED]@')
        .replace(/\?[^\s"'<>)\]#]+/g, '?[REDACTED]')
        .replace(/#[^\s"'<>)\]]+/g, '');
    }
  });

  return sanitized;
}

function createDefaultLogger() {
  return {
    info: (msg) => console.log(sanitizeLogMessage(String(msg))),
    warn: (msg) => console.warn(sanitizeLogMessage(String(msg))),
    error: (msg) => console.error(sanitizeLogMessage(String(msg))),
  };
}

function wrapLogger(logger) {
  const base = logger ?? createDefaultLogger();
  return {
    info: (msg) => base.info(sanitizeLogMessage(String(msg))),
    warn: (msg) => base.warn(sanitizeLogMessage(String(msg))),
    error: (msg) => base.error(sanitizeLogMessage(String(msg))),
  };
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStrictSubpath(baseDir, candidatePath) {
  const relative = path.relative(baseDir, candidatePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertNotFilesystemRoot(resolvedDir, label) {
  const parsed = path.parse(resolvedDir);
  if (resolvedDir === parsed.root) {
    throw new Error(`Refusing to run cleanup against filesystem root (${label}).`);
  }
}

async function pathExistsOrSymlink(targetPath, fsImpl) {
  try {
    await fsImpl.lstat(targetPath);
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

async function clearReadOnlyIfPossible(targetPath, fsImpl) {
  if (typeof fsImpl.chmod !== 'function') {
    return;
  }
  try {
    await fsImpl.chmod(targetPath, 0o666);
  } catch {
    // Best-effort attribute adjustment on Windows; ignore if unsupported or locked.
  }
}

async function removeEntryWithRetries(targetPath, { platform, fsImpl, maxRetries, retryDelayMs }) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fsImpl.rm(targetPath, { recursive: true, force: true });
      return { removed: true, lockError: null };
    } catch (err) {
      const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : '';
      if (code === 'ENOENT') {
        return { removed: true, lockError: null };
      }

      const isWinLock = platform === 'win32' && WINDOWS_LOCK_ERROR_CODES.has(code);
      if (!isWinLock) {
        throw err;
      }

      await clearReadOnlyIfPossible(targetPath, fsImpl);
      if (attempt < maxRetries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      return { removed: false, lockError: err };
    }
  }

  return { removed: false, lockError: null };
}

async function sweepChildrenBestEffort(
  dirPath,
  rootBaseDir,
  { platform, fsImpl, maxRetries, retryDelayMs },
  skippedLocked,
) {
  if (typeof fsImpl.readdir !== 'function') {
    skippedLocked.push(path.relative(rootBaseDir, dirPath) || path.basename(dirPath));
    return;
  }

  let entries;
  try {
    entries = await fsImpl.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    const code = err && typeof err === 'object' && typeof err.code === 'string' ? err.code : '';
    if (code === 'ENOENT') {
      return;
    }
    if (platform === 'win32' && WINDOWS_LOCK_ERROR_CODES.has(code)) {
      skippedLocked.push(path.relative(rootBaseDir, dirPath) || path.basename(dirPath));
      return;
    }
    throw err;
  }

  for (const entry of entries) {
    const childPath = path.join(dirPath, entry.name);
    if (!isStrictSubpath(rootBaseDir, childPath)) {
      continue;
    }

    const childOutcome = await removeEntryWithRetries(childPath, {
      platform,
      fsImpl,
      maxRetries: Math.min(1, maxRetries),
      retryDelayMs,
    });

    if (!childOutcome.removed) {
      const isDir =
        typeof entry.isDirectory === 'function' &&
        entry.isDirectory() &&
        !(typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink());

      if (isDir) {
        await sweepChildrenBestEffort(
          childPath,
          rootBaseDir,
          { platform, fsImpl, maxRetries, retryDelayMs },
          skippedLocked,
        );
        const retryDir = await removeEntryWithRetries(childPath, {
          platform,
          fsImpl,
          maxRetries: 0,
          retryDelayMs: 0,
        });
        if (!retryDir.removed) {
          skippedLocked.push(path.relative(rootBaseDir, childPath));
        }
      } else {
        skippedLocked.push(path.relative(rootBaseDir, childPath));
      }
    }
  }
}

/**
 * Safely removes stale `node_modules` and local `.npm` cache artifacts using Node.js fs APIs.
 * On Windows (`win32`), locked-file errors (`EPERM`, `EBUSY`, `EACCES`, `ENOTEMPTY`) are retried
 * and skipped with a clear warning instead of hard failing.
 */
export async function cleanupStaleArtifacts(options = {}) {
  const {
    projectDir = DEFAULT_PROJECT_DIR,
    npmCacheDir,
    includeNodeModules = true,
    includeNpmCache = true,
    platform = process.platform,
    fsImpl = fsPromises,
    maxRetries = 3,
    retryDelayMs = 100,
    logger: rawLogger,
  } = options;

  const logger = wrapLogger(rawLogger);
  const resolvedProjectDir = path.resolve(projectDir);
  assertNotFilesystemRoot(resolvedProjectDir, 'projectDir');

  const targets = [];

  if (includeNodeModules) {
    targets.push({ baseDir: resolvedProjectDir, targetPath: path.join(resolvedProjectDir, 'node_modules') });
  }
  if (includeNpmCache) {
    targets.push({ baseDir: resolvedProjectDir, targetPath: path.join(resolvedProjectDir, '.npm') });
    targets.push({ baseDir: resolvedProjectDir, targetPath: path.join(resolvedProjectDir, '.npm-cache') });
  }

  if (includeNpmCache && typeof npmCacheDir === 'string' && npmCacheDir.trim().length > 0) {
    const resolvedCacheDir = path.resolve(npmCacheDir);
    assertNotFilesystemRoot(resolvedCacheDir, 'npmCacheDir');
    for (const subPath of ALLOWED_CACHE_SUBPATHS) {
      targets.push({
        baseDir: resolvedCacheDir,
        targetPath: path.join(resolvedCacheDir, subPath),
        isCacheSubpath: true,
      });
    }
  }

  const cleaned = [];
  const skippedLocked = [];
  const warnings = [];

  for (const item of targets) {
    const { baseDir, targetPath, isCacheSubpath } = item;
    if (!isStrictSubpath(baseDir, targetPath)) {
      continue;
    }

    if (!isCacheSubpath) {
      const baseName = path.basename(targetPath);
      if (path.dirname(targetPath) !== resolvedProjectDir || !ALLOWED_PROJECT_ARTIFACTS.has(baseName)) {
        continue;
      }
    }

    const exists = await pathExistsOrSymlink(targetPath, fsImpl);
    if (!exists) {
      continue;
    }

    const outcome = await removeEntryWithRetries(targetPath, {
      platform,
      fsImpl,
      maxRetries,
      retryDelayMs,
    });

    if (outcome.removed) {
      cleaned.push(targetPath);
      continue;
    }

    const lockedEntries = [];
    await sweepChildrenBestEffort(
      targetPath,
      baseDir,
      { platform, fsImpl, maxRetries, retryDelayMs },
      lockedEntries,
    );

    const finalTry = await removeEntryWithRetries(targetPath, {
      platform,
      fsImpl,
      maxRetries: 0,
      retryDelayMs: 0,
    });

    if (finalTry.removed) {
      cleaned.push(targetPath);
      continue;
    }

    const reportedPaths =
      lockedEntries.length > 0
        ? lockedEntries
        : [path.relative(baseDir, targetPath) || path.basename(targetPath)];

    skippedLocked.push(...reportedPaths);

    const lockCode =
      outcome.lockError && typeof outcome.lockError.code === 'string'
        ? outcome.lockError.code
        : 'EPERM';
    const warningMessage =
      `[npm-install] Warning: Encountered locked file(s) during Windows cleanup (${lockCode}) in ` +
      `${reportedPaths.slice(0, 5).join(', ')}. Proceeding with installation without hard failing.`;
    warnings.push(warningMessage);
    logger.warn(warningMessage);
  }

  return { cleaned, skippedLocked, warnings };
}

/**
 * Formats an actionable, developer-friendly error message for registry failures.
 */
export function formatRegistryErrorGuidance(classification, { usedFallback = false, fallbackClassification = null } = {}) {
  const lines = [];

  if (usedFallback) {
    const primaryReason = classification?.reason ?? 'unreachable registry';
    const fallbackReason = fallbackClassification?.reason ?? 'connection or package resolution failure';
    lines.push(
      `[npm-install] Error: Unable to install dependencies from the configured npm registry (${primaryReason}) ` +
        `or the fallback public registry ${PUBLIC_NPM_REGISTRY} (${fallbackReason}).`,
    );
    lines.push('[npm-install] Actionable steps:');
    lines.push('  1. Verify internet/network connectivity and outbound HTTPS access to https://registry.npmjs.org/.');
    lines.push('  2. Check HTTP_PROXY / HTTPS_PROXY and corporate TLS certificate settings (NODE_EXTRA_CA_CERTS).');
    lines.push('  3. Inspect user .npmrc and NPM_CONFIG_REGISTRY for stale proxy or registry overrides.');
    return lines.join('\n');
  }

  if (classification?.code === 'E404') {
    lines.push(
      '[npm-install] Error: Registry returned HTTP 404 (Not Found) while resolving required packages (such as Vite or build dependencies).',
    );
    lines.push('[npm-install] Actionable steps:');
    lines.push('  1. Ensure your configured npm feed mirrors public npmjs.org packages (including recent Vite releases).');
    lines.push(
      `  2. To install directly from the public npm registry, run with NPM_CONFIG_REGISTRY=${PUBLIC_NPM_REGISTRY}`,
    );
    lines.push('  3. Check user .npmrc (`npm config list`) for outdated custom registry URLs.');
    return lines.join('\n');
  }

  if (classification?.code === 'E401' || classification?.code === 'E403' || classification?.code === 'ENEEDAUTH') {
    lines.push(
      `[npm-install] Error: Registry authentication/authorization failed (${classification.code}).`,
    );
    lines.push('[npm-install] Actionable steps:');
    lines.push('  1. Refresh credentials for your configured registry in your user .npmrc.');
    lines.push(
      `  2. For public dependencies only, override the registry with NPM_CONFIG_REGISTRY=${PUBLIC_NPM_REGISTRY}`,
    );
    return lines.join('\n');
  }

  if (classification?.code === 'E429') {
    lines.push('[npm-install] Error: Registry rate limit exceeded (HTTP 429 Too Many Requests).');
    lines.push('[npm-install] Actionable steps: Wait briefly before retrying, or verify shared proxy rate limits.');
    return lines.join('\n');
  }

  const reason = classification?.reason ?? 'registry error';
  lines.push(`[npm-install] Error: NPM registry failure (${reason}).`);
  lines.push(
    `[npm-install] Actionable steps: Check .npmrc, NPM_CONFIG_REGISTRY, proxy settings, or retry against ${PUBLIC_NPM_REGISTRY}`,
  );
  return lines.join('\n');
}

function detectCodeFromSet(directCode, npmCode, combinedText, codeSet) {
  if (directCode && codeSet.has(directCode)) {
    return directCode;
  }
  if (npmCode && codeSet.has(npmCode)) {
    return npmCode;
  }
  for (const candidate of codeSet) {
    const pattern = new RegExp(`\\b${candidate}\\b`, 'i');
    if (pattern.test(combinedText)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Classifies npm execution failures to distinguish fallback-eligible registry connectivity
 * issues (`ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, HTTP 5xx)
 * from non-fallback registry errors (`E404`, `E401`, `E403`) and unrelated local errors (`ERESOLVE`, `EJSONPARSE`).
 */
export function classifyRegistryError(input) {
  if (!input) {
    return {
      isRegistryError: false,
      shouldFallback: false,
      code: null,
      reason: null,
      actionableMessage: null,
    };
  }

  const normalized =
    typeof input === 'string'
      ? { stderr: input, stdout: '', error: null, exitCode: 1 }
      : input;

  if (normalized.exitCode === 0 && !normalized.error) {
    return {
      isRegistryError: false,
      shouldFallback: false,
      code: null,
      reason: null,
      actionableMessage: null,
    };
  }

  const directCode =
    normalized.error && typeof normalized.error.code === 'string'
      ? normalized.error.code.toUpperCase()
      : '';
  const combinedText = [
    directCode,
    normalized.error?.message ?? '',
    normalized.stderr ?? '',
    normalized.stdout ?? '',
    normalized.debugLog ?? '',
  ]
    .filter(Boolean)
    .join('\n');

  const npmCodeMatch =
    combinedText.match(/npm\s+(?:error|ERR!)\s+code\s+([A-Z0-9_]+)/i) ??
    combinedText.match(/\b\d+\s+error\s+code\s+([A-Z0-9_]+)/i);
  const npmCode = npmCodeMatch ? npmCodeMatch[1].toUpperCase() : '';

  // 1. Local / integrity / resolution errors must never trigger registry fallback.
  const nonRegistryCode = detectCodeFromSet(directCode, npmCode, combinedText, NON_REGISTRY_ERROR_CODES);
  if (nonRegistryCode) {
    return {
      isRegistryError: false,
      shouldFallback: false,
      code: nonRegistryCode,
      reason: null,
      actionableMessage: null,
    };
  }

  // 2. Non-fallback registry HTTP errors (auth, 404 missing package/tarball, 429 rate limit).
  if (
    directCode === 'E401' ||
    directCode === 'E403' ||
    directCode === 'ENEEDAUTH' ||
    directCode === 'EOTP' ||
    npmCode === 'E401' ||
    npmCode === 'E403' ||
    npmCode === 'ENEEDAUTH' ||
    npmCode === 'EOTP' ||
    /\b(?:401\s+Unauthorized|403\s+Forbidden|Unable to authenticate)\b/i.test(combinedText)
  ) {
    const authCode =
      directCode === 'E403' || npmCode === 'E403' || /\b403\s+Forbidden\b/i.test(combinedText)
        ? 'E403'
        : npmCode === 'ENEEDAUTH' || directCode === 'ENEEDAUTH'
          ? 'ENEEDAUTH'
          : 'E401';
    const partial = {
      isRegistryError: true,
      shouldFallback: false,
      code: authCode,
      reason: 'registry authentication failed',
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  if (
    directCode === 'E404' ||
    npmCode === 'E404' ||
    /\b404\s+Not\s+Found\b/i.test(combinedText)
  ) {
    const partial = {
      isRegistryError: true,
      shouldFallback: false,
      code: 'E404',
      reason: 'package or tarball not found on configured registry (HTTP 404)',
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  if (
    directCode === 'E429' ||
    npmCode === 'E429' ||
    /\b429\s+Too\s+Many\s+Requests\b/i.test(combinedText)
  ) {
    const partial = {
      isRegistryError: true,
      shouldFallback: false,
      code: 'E429',
      reason: 'registry rate limit exceeded (HTTP 429)',
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  // 3. Fallback-eligible connection, timeout, DNS, TLS, and HTTP 5xx errors.
  const timeoutCode = detectCodeFromSet(directCode, npmCode, combinedText, TIMEOUT_ERROR_CODES);
  if (timeoutCode || /\bnetwork timeout at\b/i.test(combinedText)) {
    const partial = {
      isRegistryError: true,
      shouldFallback: true,
      code: timeoutCode ?? 'ETIMEDOUT',
      reason: 'timeout',
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  if (directCode === 'ECONNREFUSED' || npmCode === 'ECONNREFUSED' || /\bECONNREFUSED\b/i.test(combinedText)) {
    const partial = {
      isRegistryError: true,
      shouldFallback: true,
      code: 'ECONNREFUSED',
      reason: 'connection refused',
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  const resetCode = detectCodeFromSet(directCode, npmCode, combinedText, CONNECTION_RESET_CODES);
  if (resetCode) {
    const partial = {
      isRegistryError: true,
      shouldFallback: true,
      code: resetCode,
      reason: 'connection reset',
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  const dnsCode = detectCodeFromSet(directCode, npmCode, combinedText, DNS_ERROR_CODES);
  if (dnsCode) {
    const partial = {
      isRegistryError: true,
      shouldFallback: true,
      code: dnsCode,
      reason: 'dns lookup failed',
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  const unreachableCode = detectCodeFromSet(directCode, npmCode, combinedText, NETWORK_UNREACHABLE_CODES);
  if (unreachableCode) {
    const partial = {
      isRegistryError: true,
      shouldFallback: true,
      code: unreachableCode,
      reason: 'network unreachable',
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  const tlsCode = detectCodeFromSet(directCode, npmCode, combinedText, TLS_ERROR_CODES);
  if (tlsCode) {
    const partial = {
      isRegistryError: true,
      shouldFallback: true,
      code: tlsCode,
      reason: 'tls verification failed',
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  const directOrNpm5xx =
    (directCode.match(/^E(50[0-9])$/) ?? npmCode.match(/^E(50[0-9])$/))?.[1] ?? null;

  const http5xxMatch =
    (directOrNpm5xx ? [directOrNpm5xx, directOrNpm5xx] : null) ??
    combinedText.match(/npm\s+(?:error|ERR!)\s+(?:code\s+)?E?(50[0-9])\b/i) ??
    combinedText.match(/(?:http\s+fetch|HttpErrorGeneral:)[^\r\n]*?\b(50[0-9])\b/i) ??
    combinedText.match(/\b(500\s+Internal\s+Server\s+Error|502\s+Bad\s+Gateway|503\s+Service\s+Unavailable|504\s+Gateway\s+Timeout)\b/i);

  if (http5xxMatch) {
    const digits = http5xxMatch[1].slice(0, 3);
    const partial = {
      isRegistryError: true,
      shouldFallback: true,
      code: `E${digits}`,
      reason: `registry server error (HTTP ${digits})`,
      actionableMessage: null,
    };
    partial.actionableMessage = formatRegistryErrorGuidance(partial);
    return partial;
  }

  return {
    isRegistryError: false,
    shouldFallback: false,
    code: directCode || npmCode || null,
    reason: null,
    actionableMessage: null,
  };
}

/**
 * Verifies that required build dependencies (including Vite) are present under `node_modules`.
 */
export async function verifyBuildDependencies(projectDir = DEFAULT_PROJECT_DIR, options = {}) {
  const {
    fsImpl = fsPromises,
    requiredPackages = DEFAULT_REQUIRED_BUILD_PACKAGES,
  } = options;

  const resolvedProjectDir = path.resolve(projectDir);
  const missing = [];

  for (const pkgName of requiredPackages) {
    const segments = pkgName.split('/');
    const pkgJsonPath = path.join(resolvedProjectDir, 'node_modules', ...segments, 'package.json');
    const exists = await pathExistsOrSymlink(pkgJsonPath, fsImpl);
    if (!exists) {
      missing.push(pkgName);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

const SAFE_NPM_ARG_PATTERN = /^[A-Za-z0-9._:/=@-]+$/;

function assertSafeNpmArgs(npmArgs) {
  for (const arg of npmArgs) {
    if (typeof arg !== 'string' || arg.length === 0 || !SAFE_NPM_ARG_PATTERN.test(arg)) {
      throw new Error(`Unsafe npm CLI argument rejected: ${sanitizeLogMessage(String(arg))}`);
    }
  }
}

function spawnNpmProcess(npmArgs, { cwd, env, platform }) {
  assertSafeNpmArgs(npmArgs);

  const spawnOptions = {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  if (platform === 'win32') {
    const adjacentNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fsSync.existsSync(adjacentNpmCli)) {
      return spawn(process.execPath, [adjacentNpmCli, ...npmArgs], spawnOptions);
    }

    return spawn('cmd.exe', ['/d', '/s', '/c', 'npm', ...npmArgs], spawnOptions);
  }

  return spawn('npm', npmArgs, spawnOptions);
}

function readNpmDebugLogExcerpt(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) {
    return '';
  }
  const match = stderr.match(/A complete log of this run can be found in:\s*([^\r\n]+)/i);
  if (!match) {
    return '';
  }
  const logPath = match[1].trim();
  try {
    if (!fsSync.existsSync(logPath)) {
      return '';
    }
    const content = fsSync.readFileSync(logPath, 'utf8');
    return content.length > 65536 ? content.slice(-65536) : content;
  } catch {
    return '';
  }
}

function defaultRunCommand({ args, cwd, env, platform }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnNpmProcess(args, { cwd, env, platform });
    } catch (err) {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        debugLog: '',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(sanitizeLogMessage(text));
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(sanitizeLogMessage(text));
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr,
        debugLog: readNpmDebugLogExcerpt(stderr),
        error,
      });
    });

    child.on('close', (code) => {
      const exitCode = code ?? 1;
      resolve({
        exitCode,
        stdout,
        stderr,
        debugLog: exitCode === 0 ? '' : readNpmDebugLogExcerpt(stderr),
        error: null,
      });
    });
  });
}

function buildInstallEnv(baseEnv = {}) {
  const installEnv = { ...baseEnv };
  for (const key of Object.keys(installEnv)) {
    const lower = key.toLowerCase();
    if (lower === 'npm_config_production' || lower === 'npm_config_omit') {
      delete installEnv[key];
    }
  }
  if (installEnv.NODE_ENV === 'production') {
    installEnv.NODE_ENV = 'development';
  }
  return installEnv;
}

/**
 * Runs a platform-safe cleanup followed by `npm install` (or `npm ci`), respecting existing
 * `.npmrc` and `NPM_CONFIG_REGISTRY` settings and retrying at most once against
 * `https://registry.npmjs.org/` if the primary registry fails with a connection/TLS/timeout/5xx error.
 */
export async function runNpmInstallWithFallback(options = {}) {
  const {
    projectDir = DEFAULT_PROJECT_DIR,
    ci = false,
    cleanBeforeInstall = true,
    cleanOnly = false,
    verifyDeps = true,
    extraArgs = ['--include=dev', '--no-audit', '--no-fund'],
    platform = process.platform,
    env = process.env,
    fsImpl = fsPromises,
    npmCacheDir,
    maxCleanupRetries = 3,
    cleanupRetryDelayMs = 100,
    runCommand = defaultRunCommand,
    logger: rawLogger,
  } = options;

  const logger = wrapLogger(rawLogger);
  const resolvedProjectDir = path.resolve(projectDir);

  let cleanup = { cleaned: [], skippedLocked: [], warnings: [] };
  if (cleanOnly || cleanBeforeInstall) {
    cleanup = await cleanupStaleArtifacts({
      projectDir: resolvedProjectDir,
      npmCacheDir,
      platform,
      fsImpl,
      maxRetries: maxCleanupRetries,
      retryDelayMs: cleanupRetryDelayMs,
      logger,
    });
  }

  if (cleanOnly) {
    return {
      success: true,
      cleanOnly: true,
      usedFallback: false,
      attempts: 0,
      exitCode: 0,
      cleanup,
      classification: null,
      fallbackClassification: null,
    };
  }

  const subcommand = ci ? 'ci' : 'install';
  const primaryArgs = [subcommand, ...extraArgs];
  const installEnv = buildInstallEnv(env);

  // Primary attempt respects .npmrc, NPM_CONFIG_REGISTRY, and CI environment variables as-is.
  const primaryResult = await runCommand({
    args: primaryArgs,
    cwd: resolvedProjectDir,
    env: installEnv,
    platform,
    attempt: 1,
    isFallback: false,
  });

  if (primaryResult.exitCode === 0 && !primaryResult.error) {
    if (verifyDeps) {
      const verification = await verifyBuildDependencies(resolvedProjectDir, { fsImpl });
      if (!verification.valid) {
        const missingList = verification.missing.join(', ');
        logger.error(
          `[npm-install] Error: Required build dependencies failed to resolve (${missingList}). ` +
            'Run `npm run install:deps` or check your registry configuration.',
        );
        return {
          success: false,
          cleanOnly: false,
          usedFallback: false,
          attempts: 1,
          exitCode: 1,
          cleanup,
          classification: null,
          fallbackClassification: null,
        };
      }
    }

    return {
      success: true,
      cleanOnly: false,
      usedFallback: false,
      attempts: 1,
      exitCode: 0,
      cleanup,
      classification: null,
      fallbackClassification: null,
    };
  }

  const classification = classifyRegistryError(primaryResult);
  const fallbackAlreadyActive = env?.[FALLBACK_GUARD_ENV] === '1';

  if (!classification.shouldFallback || fallbackAlreadyActive) {
    if (classification.isRegistryError && classification.actionableMessage) {
      logger.error(classification.actionableMessage);
    } else if (primaryResult.stderr || primaryResult.error?.message) {
      logger.error(
        `[npm-install] Installation failed: ${primaryResult.error?.message ?? 'npm exited with non-zero status.'}`,
      );
    }

    return {
      success: false,
      cleanOnly: false,
      usedFallback: false,
      attempts: 1,
      exitCode: primaryResult.exitCode || 1,
      cleanup,
      classification,
      fallbackClassification: null,
    };
  }

  // Trigger at most ONE fallback attempt against the public npm registry.
  const configuredHint = env?.NPM_CONFIG_REGISTRY || env?.npm_config_registry;
  const sanitizedOrigin = configuredHint ? ` (${sanitizeRegistryUrl(configuredHint)})` : '';
  logger.warn(
    `[npm-install] Configured npm registry${sanitizedOrigin} failed due to ${classification.reason}. ` +
      `Triggering single fallback attempt against ${PUBLIC_NPM_REGISTRY}`,
  );

  await cleanupStaleArtifacts({
    projectDir: resolvedProjectDir,
    npmCacheDir,
    platform,
    fsImpl,
    maxRetries: maxCleanupRetries,
    retryDelayMs: cleanupRetryDelayMs,
    logger,
  });

  const fallbackEnv = {
    ...installEnv,
    NPM_CONFIG_REGISTRY: PUBLIC_NPM_REGISTRY,
    npm_config_registry: PUBLIC_NPM_REGISTRY,
    [FALLBACK_GUARD_ENV]: '1',
  };
  const fallbackArgs = [subcommand, ...extraArgs, `--registry=${PUBLIC_NPM_REGISTRY}`];

  const fallbackResult = await runCommand({
    args: fallbackArgs,
    cwd: resolvedProjectDir,
    env: fallbackEnv,
    platform,
    attempt: 2,
    isFallback: true,
  });

  if (fallbackResult.exitCode === 0 && !fallbackResult.error) {
    if (verifyDeps) {
      const verification = await verifyBuildDependencies(resolvedProjectDir, { fsImpl });
      if (!verification.valid) {
        const missingList = verification.missing.join(', ');
        logger.error(
          `[npm-install] Error: Fallback install completed, but required build dependencies are missing (${missingList}).`,
        );
        return {
          success: false,
          cleanOnly: false,
          usedFallback: true,
          attempts: 2,
          exitCode: 1,
          cleanup,
          classification,
          fallbackClassification: null,
        };
      }
    }

    logger.info(`[npm-install] Fallback installation via ${PUBLIC_NPM_REGISTRY} succeeded.`);
    return {
      success: true,
      cleanOnly: false,
      usedFallback: true,
      attempts: 2,
      exitCode: 0,
      cleanup,
      classification,
      fallbackClassification: null,
    };
  }

  const fallbackClassification = classifyRegistryError(fallbackResult);
  logger.error(
    formatRegistryErrorGuidance(classification, {
      usedFallback: true,
      fallbackClassification,
    }),
  );

  return {
    success: false,
    cleanOnly: false,
    usedFallback: true,
    attempts: 2,
    exitCode: fallbackResult.exitCode || 1,
    cleanup,
    classification,
    fallbackClassification,
  };
}

export function parseCliArgs(argv = []) {
  let ci = false;
  let cleanOnly = false;
  let cleanBeforeInstall = true;
  let verifyDeps = true;

  for (const arg of argv) {
    if (arg === '--ci') {
      ci = true;
    } else if (arg === '--clean-only') {
      cleanOnly = true;
    } else if (arg === '--no-clean') {
      cleanBeforeInstall = false;
    } else if (arg === '--no-verify') {
      verifyDeps = false;
    }
  }

  return { ci, cleanOnly, cleanBeforeInstall, verifyDeps };
}

const isDirectExecution =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  runNpmInstallWithFallback(cliOptions)
    .then((result) => {
      process.exitCode = result.success ? 0 : result.exitCode || 1;
    })
    .catch((err) => {
      console.error(
        sanitizeLogMessage(
          `[npm-install] Unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      process.exitCode = 1;
    });
}
