# Interface Contract — ISS-3: 16-Step Continuous Looping Sequencer (`REQ-002`)

- **Acceptance Test Issue:** `#3` (`ISS-3` — *Acceptance Test: 16-step continuous looping sequencer*)
- **Target Feature Issue:** `#2` (`ISS-2` — *Sequencer: 16-step grid with continuous looping and current step tracking*)
- **Requirement Mapping:** `REQ-002` (*Sequencer: A 16-step sequencer that loops continuously while playing, tracks the current step index, and allows per-step activation across multiple instruments*)

---

## 1. Routes

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Serves the Browser Beatbox React Single Page Application (`200 OK`). |
| `GET` | `/healthz` | Readiness probe returning `200 OK` JSON (`{ "status": "ok", "timestamp": "<ISO-8601>" }`). |

No new backend HTTP endpoints are required; per `ADR-0001`, sequencer state lives client-side in React.

---

## 2. DOM Selectors (`data-testid`) & Observable State Attributes

All sequencer state transitions MUST be deterministically observable through the following DOM elements and `data-*` attributes:

### 2.1 Application Root (`[data-testid="beatbox-app"]`)

| Attribute | Values | Semantics |
| --- | --- | --- |
| `data-testid` | `"beatbox-app"` | Root beatbox shell mounted on `/`. |
| `data-playing` | `"true"` \| `"false"` | `"false"` on initial load and when paused/stopped; `"true"` while sequencer playback is running. |
| `data-current-step` | `"0"` .. `"15"` | Current 0-based step index (`"0"` = Step 1, `"15"` = Step 16). Upon starting playback from the initial/stopped state (`t = 0ms`), `data-current-step` MUST immediately be `"0"`. |

### 2.2 Transport Play Trigger (`[data-testid="transport-play"]`)

- Must render as a visible, interactive `<button>` element with `data-testid="transport-play"`.
- Clicking `[data-testid="transport-play"]` while `data-playing="false"` starts playback immediately:
  - `data-playing` on `[data-testid="beatbox-app"]` becomes `"true"`.
  - When starting from initial load or stopped state, `data-current-step` is `"0"` (Step 1) at `t = 0ms` before the first step timer interval elapses.
- *Forward-compatibility note:* Additional transport controls (`[data-testid="transport-pause"]`, `[data-testid="transport-stop"]`, tempo controls) introduced in downstream issues MUST preserve `[data-testid="transport-play"]` starting playback when clicked from a non-playing state.

### 2.3 Multi-Instrument 16-Step Grid

- **Instrument Track Rows (`[data-testid="track-<instrumentId>"]`):**
  - Renders instrument rows including the 4 synthetic default tracks (`kick`, `snare`, `hihat-closed`, `clap`).
  - Every rendered track row MUST contain **exactly 16** step elements in ascending DOM order (`step-<instrumentId>-0` through `step-<instrumentId>-15`, representing Steps 1 through 16).
- **Step Cells (`[data-testid="step-<instrumentId>-<stepIndex>"]`):**
  - `stepIndex` is 0-based (`0` .. `15`), where `0` represents Step 1 and `15` represents Step 16.
  - `data-active="true" | "false"`: Reflects whether `<instrumentId>` is active on `<stepIndex>`.
    - Clicking `[data-testid="step-<instrumentId>-<stepIndex>"]` toggles `data-active` (`"true"` ↔ `"false"`) exclusively for that `(instrumentId, stepIndex)` cell without mutating any other step index or any other instrument track.
    - Step toggling MUST work both while stopped (`data-playing="false"`) and while playing (`data-playing="true"`), and toggled states MUST persist across loop wrap-arounds.
  - `data-current="true" | "false"`:
    - When `data-playing="true"`, `data-current` MUST be `"true"` on every instrument's cell at `stepIndex === Number(data-current-step)` and `"false"` on all other 15 columns (`0..15`).
    - When `data-playing="false"`, `data-current` MUST be `"false"` on all step cells.

---

## 3. Deterministic Timing & Continuous Looping Semantics

1. **Fixed 16-Step Sequence:** Steps execute strictly in ascending 0-based index order:
   `0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15`.
2. **Sixteenth-Note Step Interval Formula (4/4 Time):**
   ```text
   stepIntervalMs = 60000 / (bpm * 4)
   ```
   At the default seeded tempo of `120 BPM`, `stepIntervalMs = 125` ms per step (`2000` ms per 16-step bar).
3. **Virtual-Clock Compatibility:**
   - Playwright acceptance tests drive time deterministically via `page.clock.install()` and `page.clock.runFor()`, which virtualize `window.setInterval`, `window.setTimeout`, `window.requestAnimationFrame`, `Date.now()`, and `performance.now()` without wall-clock `sleep()` delays (note: hardware `AudioContext.currentTime` does not advance under `page.clock.runFor()`).
   - Step-index progression (`data-current-step` and `data-current`) MUST therefore be driven by standard browser timers (`setInterval`, `setTimeout`, or `requestAnimationFrame` + `performance.now()`), including when Web Audio API voice playback is attached in downstream features.
   - Sub-interval elapsed times (`< stepIntervalMs`) MUST NOT prematurely advance `data-current-step`.
4. **Continuous Loop Wrap-Around:**
   - While `data-playing="true"`, advancing one `stepIntervalMs` (`125` ms at `120` BPM) after Step 16 (`data-current-step="15"`) MUST automatically transition back to Step 1 (`data-current-step="0"`) via `(currentStep + 1) % 16` with zero manual intervention, zero skipped steps, zero duplicate ticks, and zero stalls across repeated loop cycles.
