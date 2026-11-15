# browser-beatbox-628

Browser-based 16-step beatbox/drum machine built on ASP.NET Core (.NET 11) and React + TypeScript + Vite.

## Prerequisites

- .NET SDK 11.0+ and Node.js 22+ with npm

## Running Locally

### Full-stack via ASP.NET Core

Building the backend automatically builds `web/` and serves the SPA alongside `/healthz` and `/health`:

```bash
dotnet run --project src/Beatbox.Api
```

- UI: `http://localhost:5143` | Health probes: `http://localhost:5143/healthz`, `http://localhost:5143/health`

### Separate Backend + Vite Dev Server (HMR)

```bash
# Terminal 1: ASP.NET Core API (Development environment loads synthetic 4x16 demo seed data)
dotnet run --project src/Beatbox.Api

# Terminal 2: Vite HMR server on http://localhost:5173 (proxies /healthz and /health)
# (`npm run install:deps` safely cleans stale Windows artifacts and falls back to https://registry.npmjs.org/ on transient registry errors)
cd web && npm run install:deps && npm run dev
```

## Quality Gate

```bash
./scripts/quality
cd web && npm test
```
