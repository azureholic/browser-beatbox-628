# ADR-0001: Architecture Overview

## Context
The project requires a browser-based beatbox/drum machine with a 16-step sequencer, multiple distinct drum sounds, continuous looping playback, transport and tempo controls, and clear visual feedback for the current and active steps. This will be built utilizing the provided `dotnet-react` stack template.

## Services
- **ASP.NET Core Backend:** Used to host the React Single Page Application, as well as to expose a `/healthz` health probe to allow for CI and preview readiness checks. No database or external APIs will be required for this project.
- **React Frontend (TypeScript):** Responsible for rendering the 16-step grid, transport/tempo controls, and handling all user interaction.

## Audio
- **Web Audio API:** Will be utilized to play bundled drum samples within the browser. This satisfies the requirement of being playable with no additional plugins required.

## Data Model
- **Client Side State Only:** All application state (playing/paused, current step index, tempo (BPM), and the 16-step pattern per instrument) will be stored within the React component state/context. No persistence will be implemented based off of the clarification to not save or load patterns. 

## Synthetic Seed Strategy
- **Demo Pattern:** A default 4-track x 16-step demo pattern will be seeded on application load (e.g. Kick, Snare, Closed Hi-Hat, Clap). This will be hardcoded within the frontend to allow for immediate playback testing and to satisfy the walking skeleton's "demo seed data green" requirement.

## File Structure
- `ClientApp/` - React application. Audio samples will be bundled under `ClientApp/public/samples/` to be loaded statically.
- `Controllers/` - Minimal ASP.NET Core controllers (Health controller for `/healthz`).

## Preview Readiness
- The application will be buildable and runnable via the dotnet-react template with `dotnet build` and `dotnet run`. CI will be configured to build and validate the solution. The `/healthz` endpoint will return a 200 OK to ensure readiness.

## Reasoning
- Utilizing the Web Audio API paired with bundled assets allows for zero dependency on external services whilst still maintaining fast load times for audio samples.
- Keeping state client side completely removes the need for a database, matching the scope that was clarified.
- Hosting the SPA through ASP.NET Core allows for the walking skeleton to enforce a full stack build within CI from the beginning.