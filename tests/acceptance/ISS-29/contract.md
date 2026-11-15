# Interface Contract — ISS-29: Verify Beatbox API Build Passes

- **Acceptance Test Issue:** `#29` (`ISS-29` — *AT: Verify Beatbox API build passes*)
- **Target Feature Issue:** `#28` (`ISS-28` — *Fix Beatbox API build: resolve npm run build failure*)
- **Parent Epic:** `#27` (*Epic: Fix Beatbox API Build Failure*)
- **Related Reliability Epic:** `#22` / `#23` (*Improve Local NPM Installation Reliability*)

---

## 1. Scope & Build Integration Contract

`src/Beatbox.Api/Beatbox.Api.csproj` integrates the React + TypeScript + Vite Single Page Application (`web/`) into the ASP.NET Core build pipeline via MSBuild:

| MSBuild Element | Contract Requirement |
| --- | --- |
| `$(SpaRoot)` | Resolves via `dotnet msbuild src/Beatbox.Api/Beatbox.Api.csproj -getProperty:SpaRoot` to the repository `web/` directory containing `package.json`, `tsconfig.json`, and `vite.config.ts`. |
| `Target="BuildWebFrontend"` | Runs before `Build` (`Condition="'$(DesignTimeBuild)' != 'true' AND '$(SkipSpaBuild)' != 'true'"`), ensures frontend dependencies are available in `$(SpaRoot)`, executes `npm run build` with `WorkingDirectory="$(SpaRoot)"`, and copies `$(SpaRoot)/dist/**/*` into `src/Beatbox.Api/wwwroot/`. |
| `-p:SkipSpaBuild=true` | Skips `BuildWebFrontend` cleanly (`exit code 0`) for container stages that build the SPA separately (`Dockerfile`). |

---

## 2. Acceptance Criteria Verification Rules

### 2.1 AC-001: `npm run build` Succeeds in the MSBuild Context

1. Evaluating `$(SpaRoot)` from `src/Beatbox.Api/Beatbox.Api.csproj` resolves to an existing directory containing `package.json` with a `"build"` script.
2. Executing `npm run build` with working directory `$(SpaRoot)` and inherited MSBuild/process environment variables completes with **exit code `0`**.
3. The build outputs a non-empty `$(SpaRoot)/dist/index.html` and compiled JavaScript and CSS assets under `$(SpaRoot)/dist/assets/`, plus static bundled drum sample files under `$(SpaRoot)/dist/samples/`.

### 2.2 AC-002: `dotnet build src/Beatbox.Api/Beatbox.Api.csproj` Succeeds with Exit Code `0` and Zero `MSB3073` Errors

1. Executing `dotnet build src/Beatbox.Api/Beatbox.Api.csproj` on a clean `src/Beatbox.Api/wwwroot` state (`--no-incremental`) triggers `BuildWebFrontend`, completes with **exit code `0`**, and emits **zero `MSB3073` errors** (and zero MSBuild/compiler errors).
2. After `dotnet build src/Beatbox.Api/Beatbox.Api.csproj` completes:
   - Compiled backend assembly (`$(TargetPath)` / `Beatbox.Api.dll`) exists on disk.
   - `src/Beatbox.Api/wwwroot/index.html` exists and is non-empty.
   - Compiled frontend bundle assets exist under `src/Beatbox.Api/wwwroot/assets/` and static audio samples exist under `src/Beatbox.Api/wwwroot/samples/`.
3. Subsequent incremental builds (`dotnet build src/Beatbox.Api/Beatbox.Api.csproj`) and backend-only builds (`dotnet build src/Beatbox.Api/Beatbox.Api.csproj -p:SkipSpaBuild=true`) also complete with **exit code `0`** and **zero `MSB3073` errors**.
4. Running the compiled `Beatbox.Api` application serves `GET /healthz` (`200 OK`, `{ "status": "ok" }`) and `GET /` (`200 OK`, `text/html`), rendering `[data-testid="beatbox-app"]` in headless Chromium without uncaught runtime errors.
