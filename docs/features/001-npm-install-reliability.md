# Feature Specification: Improve Local NPM Installation Reliability

## Problem Statement

Developers may encounter failures when running `npm install` for the web project. The observed issues include filesystem permission (EPERM) errors during `node_modules` cleanup on Windows, as well as 404 errors when attempting to resolve required packages from the configured npm feed.

## Scope

- Improve the robustness of the `npm install` process for the `web` project.
- Address registry resolution for build dependencies to prevent feed-related 404 errors.
- Ensure compatibility with standard Windows development environments.

## Requirements

- **REQ-001:** The installation process must gracefully handle locked files and directories during cleanup on Windows without causing a hard failure.
- **REQ-002:** Required build dependencies (including Vite) must be resolvable through the project's configured registry or a verified fallback source.
- **REQ-003:** If a registry-related error occurs, the install output must provide a clear, actionable error message to the developer.

## Acceptance Criteria

- [ ] `npm install` completes successfully on a clean checkout of the repository on Windows 10/11.
- [ ] No EPERM-related failures are encountered during standard installation flows.
- [ ] `npm run build` succeeds after a successful install.
- [ ] The fix does not introduce regressions for CI-based installations.

## Out of Scope

- Changes to application logic unrelated to dependency installation.
- Modifications to repository governance or CI approval policies.

## Notes

This specification is derived solely from reported install behavior. No sensitive or internal data has been included.