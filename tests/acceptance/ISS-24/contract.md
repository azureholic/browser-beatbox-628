# Interface Contract — ISS-24: Verify NPM Install Reliability on Windows

- **Acceptance Test Issue:** `#24` (`ISS-24` — *AT: Verify npm install reliability on Windows*)
- **Target Feature Issue:** `#23` (`ISS-23` — *NPM install robustness: Windows cleanup and registry fallback*)
- **Parent Epic:** `#22` (*Epic: Improve Local NPM Installation Reliability*)
- **Related Build Reliability Issues:** `#28` / `#29` (*Beatbox API & SPA MSBuild Integration*)

---

## 1. Scope & Frontend Dependency Installation Contract

`web/` configures npm and provides a cross-platform installation helper (`web/tools/npm-install.mjs`) so local Windows 10/11 developer workflows and CI pipelines resolve frontend dependencies deterministically without `EPERM` lock failures or quarantined-feed `404` rollbacks:

| Artifact / Command | Contract Requirement |
| --- | --- |
| `web/.npmrc` | Configures bounded network retry and timeout parameters (`fetch-retries`, `fetch-retry-factor`, `fetch-retry-mintimeout`, `fetch-retry-maxtimeout`, `fetch-timeout`) while omitting hardcoded `registry=` overrides so user `.npmrc`, `NPM_CONFIG_REGISTRY`, and CI settings remain authoritative. |
| `web/package-lock.json` | Lockfile v3 pinning deterministic, feed-available package versions (`https://registry.npmjs.org/` tarballs with `sha512-` integrity hashes), including Windows `win32` (`x64` and `arm64`) native optional bindings for `rolldown` and `lightningcss`, with zero Windows postinstall scripts (`fsevents` restricted to `os: ["darwin"]`). |
| `web/package.json` | Exposes `clean` (`node ./tools/npm-install.mjs --clean-only`), `install:deps` (`node ./tools/npm-install.mjs`), `install:ci` (`node ./tools/npm-install.mjs --ci`), and `build` (`node ./node_modules/typescript/bin/tsc --noEmit && node ./node_modules/vite/bin/vite.js build`) invoking workspace Node entrypoints directly without relying on OS-specific `.bin` shims. |
| `web/tools/npm-install.mjs` | Exports `cleanupStaleArtifacts`, `classifyRegistryError`, `formatRegistryErrorGuidance`, `verifyBuildDependencies`, `runNpmInstallWithFallback`, `sanitizeRegistryUrl`, and `sanitizeLogMessage`. Enforces `--include=dev` and neutralizes `NODE_ENV=production` / `npm_config_production` / `npm_config_omit` during install so TypeScript and Vite `devDependencies` are always installed. |

---

## 2. Acceptance Criteria Verification Rules

### 2.1 AC-001: `npm install` Completes Successfully on a Clean Checkout on Windows 10/11

1. Starting from a clean checkout of `web/` (no `node_modules/` or `dist/`) with an isolated cache, executing `npm install --no-audit --no-fund` and `npm run install:deps` completes with **exit code `0`**.
2. `web/package-lock.json` remains byte-for-byte unchanged after `npm install` (deterministic resolution with zero lockfile drift).
3. All required runtime and build dependencies (`react`, `react-dom`, `vite`, `typescript`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`) resolve under `web/node_modules/`, and Windows `win32` (`x64` and `arm64`) optional native packages (`@rolldown/binding-win32-x64-msvc`, `@rolldown/binding-win32-arm64-msvc`, `lightningcss-win32-x64-msvc`, `lightningcss-win32-arm64-msvc`) resolve cleanly with verified tarball integrity and zero Windows install scripts.

### 2.2 AC-002: No `EPERM`-Related Failures During Standard and Locked-File Installation Flows (`REQ-001`)

1. Standard installation, re-installation over an existing `node_modules/`, and `npm run clean` complete with **exit code `0`** and emit **zero `EPERM` errors or warnings**.
2. On Windows (`win32`), `cleanupStaleArtifacts` clears read-only file attributes (`chmod`), retries transient `EPERM` / `EBUSY` / `EACCES` / `ENOTEMPTY` errors with bounded backoff, sweeps unlocked sibling packages when handles remain locked, never traverses directory symlinks/junctions outside the project, and logs a warning instead of hard-failing so `runNpmInstallWithFallback` can proceed.

### 2.3 AC-003: `npm run build` Succeeds After a Clean Install

1. Immediately following a clean `npm install` (or `npm ci`), executing `npm run build` in `web/` completes with **exit code `0`**.
2. The build outputs non-empty `dist/index.html` (containing `<div id="root"></div>`), compiled JavaScript and CSS bundles under `dist/assets/`, and all five bundled synthetic WAV audio samples (`kick.wav`, `snare.wav`, `hihat-closed.wav`, `hihat-open.wav`, `clap.wav`) under `dist/samples/`.
3. The compiled `Beatbox.Api` host serves `GET /healthz` (`200 OK`, `{ "status": "ok" }`) and `GET /` (`200 OK`, `text/html`), rendering `[data-testid="beatbox-app"]` in headless Chromium without uncaught page errors.

### 2.4 AC-004: Idempotent Consecutive `npm ci` Installs and Zero Regressions for CI Installations (`REQ-002`, `REQ-003`)

1. Executing **at least two consecutive clean `npm ci` installs** (and consecutive `npm run install:ci` runs under `CI=true`, including when `NODE_ENV=production` / `npm_config_production=true` are present in the caller environment) completes with **exit code `0`**, zero `EPERM` errors, unchanged `package-lock.json`, and identical installed `node_modules` package manifests across runs (idempotency).
2. When a configured primary registry fails with a connectivity/availability error (e.g., `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, TLS verification error, or HTTP `5xx`), `runNpmInstallWithFallback` retries **at most once** against `https://registry.npmjs.org/` (`BEATBOX_NPM_FALLBACK_ACTIVE=1`) while redacting sensitive URL credentials/query parameters (`REQ-002`).
3. When a configured registry returns a non-fallback error such as `HTTP 404 Not Found` (`E404`), installation fails promptly without fallback loops and outputs a clear, actionable remediation message (`[npm-install] Error:` and `Actionable steps:`) (`REQ-003`).
4. Full-stack `dotnet build src/Beatbox.Api/Beatbox.Api.csproj` (`BuildWebFrontend`) and `Dockerfile` CI command invariants remain intact with **exit code `0`** and zero `MSB3073` errors.
