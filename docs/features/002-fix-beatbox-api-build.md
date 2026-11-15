# Feature Specification: Fix Beatbox API Build Failure

## Problem Statement

The Beatbox API project is failing to build due to the MSBuild task invoking `npm run build` returning exit code 1 (error MSB3073). This prevents the project from building successfully using the provided launch settings. 

## Requirements

- **REQ-001:** Investigate the root cause of the `npm run build` failure that is being triggered by `Beatbox.Api.csproj`.
- **REQ-002:** Correct any frontend configuration, dependencies, or code issues required for `npm run build` to complete successfully.
- **REQ-003:** Ensure the full .NET build for the Beatbox API completes without MSB3073 errors.

## Acceptance Criteria

- [ ] **AC-001 (REQ-001):** The root cause of the failure is identified and documented within the associated pull request.
- [ ] **AC-002 (REQ-002):** `npm run build` executes successfully within the context that MSBuild invokes it.
- [ ] **AC-003 (REQ-003):** `dotnet build src/Beatbox.Api/Beatbox.Api.csproj` completes with exit code 0.

## Scope Boundaries

- **In scope:** The frontend build script, Node.js dependencies, and the MSBuild target within `Beatbox.Api.csproj` that calls `npm run build`.
- **Out of scope:** API contract changes, UI redesign, or modifications to unrelated build pipelines.

## Dependencies

- **blockedBy:** None identified at this time.