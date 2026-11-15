# Interface Contract — ISS-9: Visual Feedback for Current and Active Steps (`REQ-005`)

- **Acceptance Test Issue:** `#9` (`ISS-9` — *Acceptance Test: Visual feedback for current and active steps*)
- **Target Feature Issue:** `#8` (`ISS-8` — *Visual Feedback: Current step and active steps indicators*)
- **Upstream Dependencies:**
  - `#2` / `ISS-3` (`REQ-002` — *16-step continuous looping sequencer*)
  - `#4` / `ISS-5` (`REQ-003` — *Distinct sounds triggered by sequencer*)
  - `#6` / `ISS-7` (`REQ-004` — *Transport and tempo controls functionality*)
- **Requirement Mapping:** `REQ-005` (*Visual Feedback: Clear visual and accessible indication of the currently playing step, completed vs. upcoming steps within the 16-step bar, per-instrument active toggled steps, state icons, ARIA roles/attributes, and maintained keyboard focus*)

---

## 1. Routes

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Serves the Browser Beatbox React Single Page Application (`200 OK`). |
| `GET` | `/healthz` | Readiness probe returning `200 OK` JSON (`{ "status": "ok", "timestamp": "<ISO-8601>" }`). |
| `GET` | `/samples/<instrumentId>.<ext>` | Serves static bundled synthetic drum audio assets (`ISS-5`). |

Per `ADR-0001`, all sequencer, pattern, and visual feedback state lives client-side in React with zero new backend HTTP endpoints.

---

## 2. DOM Selectors (`data-testid`), ARIA Roles/Attributes, State Classes & Icons

`ISS-9` preserves 100% backward compatibility with all DOM selectors and invariants in `tests/acceptance/ISS-3/contract.md`, `tests/acceptance/ISS-5/contract.md`, and `tests/acceptance/ISS-7/contract.md`, and defines the complete visual and accessible step feedback contract:

### 2.1 Step Progression State Formula (`current` | `completed` | `upcoming`)

For every 0-based `stepIndex` in `0..15` (`0` = Step 1, `15` = Step 16), let `isPlaying = (data-playing === "true")` and `currentStep = Number(data-current-step)`:

- **While `data-playing="true"`:**
  - `stepIndex < currentStep` → `stepState = "completed"` (already played in the active 16-step bar cycle)
  - `stepIndex === currentStep` → `stepState = "current"` (the currently playing step)
  - `stepIndex > currentStep` → `stepState = "upcoming"` (not yet reached in the active 16-step bar cycle)
- **While `data-playing="false"`:**
  - `stepIndex < currentStep` → `stepState = "completed"` (steps prior to a paused playhead when `currentStep > 0`)
  - `stepIndex >= currentStep` → `stepState = "upcoming"` (all 16 steps `0..15` are `"upcoming"` on initial mount and after Stop when `currentStep === 0`; `data-current` MUST remain `"false"` on all steps whenever `data-playing="false"` per `ISS-3` & `ISS-7`)
- **Loop Wrap-Around (`15 → 0`):**
  - When playback wraps from Step 16 (`currentStep = 15`) back to Step 1 (`currentStep = 0`), step `0` becomes `"current"` and steps `1..15` immediately reset from `"completed"` to `"upcoming"`.

### 2.2 16-Step Playhead Indicator Row (`[data-testid="step-indicators"]`)

| Selector | Element / ARIA Role | Required Attributes, Classes & Children |
| --- | --- | --- |
| `[data-testid="step-indicators"]` | `<ol>` or element with `role="list"` | Visible playhead header aligned with the 16 step columns, exposing ARIA role `list` and a non-empty accessible name (`aria-label` or `aria-labelledby`). Contains **16** items in ascending order (`0..15`). |
| `[data-testid="step-indicator-<stepIndex>"]` | `<li>` or element with `role="listitem"` | Rendered for `stepIndex` `0..15` (displaying 1-based step number `1..16` or accessible label):<br>- `class` includes `"step-indicator"` and exact `stepState` class (`"current"`, `"completed"`, or `"upcoming"`).<br>- `data-current="true"` exclusively when `stepState === "current"`; `"false"` otherwise.<br>- `data-step-state="current" \| "completed" \| "upcoming"` matching `stepState`.<br>- `aria-current="step"` when `data-current="true"`; omitted (or `"false"`) when `data-current="false"`. |
| `[data-testid="step-indicator-icon-<stepIndex>"]` | `<svg aria-hidden="true">` | Decorative inline SVG state icon rendered inside `[data-testid="step-indicator-<stepIndex>"]`:<br>- `aria-hidden="true"` so screen readers announce clean step labels.<br>- `data-icon-state="current" \| "completed" \| "upcoming"` matching `stepState`.<br>- Renders distinct inner SVG markup (`innerHTML`) for `"current"`, `"completed"`, and `"upcoming"` states (e.g., playhead chevron/triangle for `"current"`, check/filled mark for `"completed"`, dot/dash for `"upcoming"`). |

### 2.3 Pattern Grid, Instrument Track Rows & Interactive Step Cells

| Selector | Element / ARIA Role | Required Attributes & State Classes |
| --- | --- | --- |
| `section.pattern-grid` | `<section>` (`role="region"`) | Named `<section>` container (`aria-label` or `aria-labelledby`) containing `[data-testid="step-indicators"]` and all instrument track rows. |
| `[data-testid="track-<instrumentId>"]` | Element with `role="group"` | Track row for each seeded instrument (`kick`, `snare`, `hihat-closed`, `clap`), exposing `role="group"` and a non-empty accessible name (`aria-label` or `aria-labelledby` referencing `.track-label`), containing **16** step `<button>` elements (`0..15`). |
| `[data-testid="step-<instrumentId>-<stepIndex>"]` | `<button type="button">` (`role="button"`) | Interactive toggle button for `(instrumentId, stepIndex)`:<br>- Non-empty `aria-label` identifying instrument name and 1-based step (`1..16`, e.g. `"Kick step 1"`).<br>- `data-active="true" \| "false"` and synchronized `aria-pressed="true" \| "false"`.<br>- `data-current="true" \| "false"` (`"true"` exclusively when `data-playing="true"` and `stepIndex === currentStep`).<br>- `data-step-state="current" \| "completed" \| "upcoming"` per §2.1.<br>- `aria-current="step"` when `data-current="true"`; omitted (or `"false"`) when `data-current="false"`.<br>- `class` always includes `"step-cell"` and exact `stepState` class (`"current"`, `"completed"`, or `"upcoming"`), plus `"active"` if and only if `data-active="true"`. |

---

## 3. Computed Visual Distinction & Keyboard Accessibility Rules

### 3.1 Computed Visual Style Distinction (`getComputedStyle`)

Let a step element's computed visual signature comprise `(backgroundColor, backgroundImage, borderTopColor, color, boxShadow, opacity, fontWeight)`:

1. **Active vs. Inactive Step Cells:** On any given step state (`upcoming`, `current`, or `completed`), an active cell (`data-active="true"`) MUST have a distinct computed `backgroundColor`, `backgroundImage`, or `borderTopColor` from an inactive cell (`data-active="false"`).
2. **Current vs. Completed vs. Upcoming Progression States:**
   - Among `[data-testid="step-indicator-<stepIndex>"]` elements during playback (`0 < currentStep < 15`), `"completed"`, `"current"`, and `"upcoming"` indicators MUST have pairwise-distinct computed visual signatures.
   - Among inactive step cells (`data-active="false"`) on the same track during playback (`0 < currentStep < 15`), `"completed"`, `"current"`, and `"upcoming"` cells MUST have pairwise-distinct computed visual signatures.
3. **Simultaneously Active + Current Step Cells:** When the playhead lands on an active step (`data-active="true"` and `data-current="true"`, `.step-cell.active.current`), its computed visual signature MUST be pairwise distinct from **active + upcoming**, **inactive + current**, and **inactive + upcoming** step cells so both the active toggle state and current playhead highlight remain simultaneously visible.
4. **Visible Keyboard Focus Ring:** When a step cell receives keyboard focus (`:focus-visible` / `:focus`), its computed focus styling (`outlineStyle`/`outlineWidth`/`outlineColor`, `boxShadow`, or `borderTopColor`) MUST differ visibly from its unfocused state.

### 3.2 Keyboard Navigation & Focus Stability

1. **Tab Order & Toggle Activation:** Step `<button>` cells participate in sequential `Tab` / `Shift+Tab` navigation in ascending track-and-step order. Pressing `Space` or `Enter` on a focused step cell toggles `data-active` and `aria-pressed` exclusively for that cell while keeping keyboard focus (`document.activeElement`) on that exact cell.
2. **2D Grid Arrow-Key Navigation:** While a step cell `[data-testid="step-<instrumentId>-<stepIndex>"]` on track index `t` (`0..trackCount-1`) is focused:
   - `ArrowRight` moves focus to `step-<instrumentId>-<(stepIndex + 1) % 16>`; `ArrowLeft` moves focus to `step-<instrumentId>-<(stepIndex + 15) % 16>`.
   - `ArrowDown` moves focus to step `stepIndex` on track `(t + 1) % trackCount`; `ArrowUp` moves focus to step `stepIndex` on track `(t + trackCount - 1) % trackCount`.
   - `Home` moves focus to `step-<instrumentId>-0`; `End` moves focus to `step-<instrumentId>-15`.
3. **Focus Retention During Live Playback:** Advancing `data-current-step` via sequencer timer ticks (`0..15` and across `15 → 0` loop wrap-arounds) MUST NOT blur or steal focus from any focused step `<button>`, including as the playhead enters (`"current"`), triggers, and passes (`"completed"`) the focused cell.
