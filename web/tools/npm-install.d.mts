export const PUBLIC_NPM_REGISTRY: string;
export const FALLBACK_GUARD_ENV: string;

export interface NpmInstallLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface FsDirentLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink?(): boolean;
}

export interface FsPromisesLike {
  lstat(targetPath: string): Promise<unknown>;
  rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  chmod?(targetPath: string, mode: number): Promise<void>;
  readdir?(dirPath: string, options: { withFileTypes: true }): Promise<FsDirentLike[]>;
}

export interface CleanupOptions {
  projectDir?: string;
  npmCacheDir?: string;
  includeNodeModules?: boolean;
  includeNpmCache?: boolean;
  platform?: string;
  fsImpl?: FsPromisesLike;
  maxRetries?: number;
  retryDelayMs?: number;
  logger?: NpmInstallLogger;
}

export interface CleanupResult {
  cleaned: string[];
  skippedLocked: string[];
  warnings: string[];
}

export interface RegistryErrorInput {
  stdout?: string;
  stderr?: string;
  debugLog?: string;
  error?: { code?: string; message?: string } | null;
  exitCode?: number | null;
}

export interface RegistryErrorClassification {
  isRegistryError: boolean;
  shouldFallback: boolean;
  code: string | null;
  reason: string | null;
  actionableMessage: string | null;
}

export interface CommandInvocation {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  platform: string;
  attempt: number;
  isFallback: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  debugLog?: string;
  error: ({ code?: string; message?: string } & Error) | { code?: string; message?: string } | null;
}

export interface VerifyBuildDependenciesOptions {
  fsImpl?: FsPromisesLike;
  requiredPackages?: string[];
}

export interface VerifyBuildDependenciesResult {
  valid: boolean;
  missing: string[];
}

export interface RunNpmInstallOptions {
  projectDir?: string;
  ci?: boolean;
  cleanBeforeInstall?: boolean;
  cleanOnly?: boolean;
  verifyDeps?: boolean;
  extraArgs?: string[];
  platform?: string;
  env?: Record<string, string | undefined>;
  fsImpl?: FsPromisesLike;
  npmCacheDir?: string;
  maxCleanupRetries?: number;
  cleanupRetryDelayMs?: number;
  runCommand?: (invocation: CommandInvocation) => Promise<CommandResult>;
  logger?: NpmInstallLogger;
}

export interface RunNpmInstallResult {
  success: boolean;
  cleanOnly: boolean;
  usedFallback: boolean;
  attempts: number;
  exitCode: number;
  cleanup: CleanupResult;
  classification: RegistryErrorClassification | null;
  fallbackClassification: RegistryErrorClassification | null;
}

export interface ParsedCliArgs {
  ci: boolean;
  cleanOnly: boolean;
  cleanBeforeInstall: boolean;
  verifyDeps: boolean;
}

export function sanitizeRegistryUrl(rawUrl: string | null | undefined): string;
export function sanitizeLogMessage(input: string | null | undefined): string;
export function cleanupStaleArtifacts(options?: CleanupOptions): Promise<CleanupResult>;
export function classifyRegistryError(
  input: RegistryErrorInput | string | null | undefined,
): RegistryErrorClassification;
export function formatRegistryErrorGuidance(
  classification: RegistryErrorClassification | null,
  options?: { usedFallback?: boolean; fallbackClassification?: RegistryErrorClassification | null },
): string;
export function verifyBuildDependencies(
  projectDir?: string,
  options?: VerifyBuildDependenciesOptions,
): Promise<VerifyBuildDependenciesResult>;
export function runNpmInstallWithFallback(
  options?: RunNpmInstallOptions,
): Promise<RunNpmInstallResult>;
export function parseCliArgs(argv?: string[]): ParsedCliArgs;
