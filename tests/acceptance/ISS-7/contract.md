# Interface Contract — ISS-7: Transport and Tempo Controls Functionality (`REQ-004`)

- **Acceptance Test Issue:** `#7` (`ISS-7` — *Acceptance Test: Transport and tempo controls functionality*)
- **Target Feature Issue:** `#6` (`ISS-6` — *Controls: Transport and tempo controls*)
- **Upstream Dependencies:**
  - `#2` / `ISS-3` (`REQ-002` — *16-step continuous looping sequencer*)
  - `#4` / `ISS-5` (`REQ-003` — *Distinct sounds triggered by sequencer*)
- **Requirement Mapping:** `REQ-004` (*Controls: Transport controls for Play, Pause, and Stop with step reset on Stop, plus real-time BPM tempo adjustment within enforced bounds*)

---

## 1. Routes

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Serves the Browser Beatbox React Single Page Application (`200 OK`). |
| `GET` | `/healthz` | Readiness probe returning `200 OK` JSON (`{ "status": "ok", "timestamp": "<ISO-8601>" }`). |
| `GET` | `/samples/<instrumentId>.<ext>` | Serves static bundled synthetic drum audio assets (`ISS-5`). |

Per `ADR-0001`, all transport and tempo state lives client-side in React with zero new backend HTTP endpoints and zero persistence across page reloads.

---

## 2. DOM Selectors (`data-testid`) & Observable State Attributes

`ISS-7` preserves 100% backward compatibility with all DOM selectors and semantics in `tests/acceptance/ISS-3/contract.md` and `tests/acceptance/ISS-5/contract.md`, and adds explicit transport and tempo controls:

### 2.1 Application Root (`[data-testid="beatbox-app"]`)

| Attribute | Values | Semantics |
| --- | --- | --- |
| `data-testid` | `"beatbox-app"` | Root beatbox shell mounted on `/` (`ISS-3`). |
| `data-playing` | `"true"` \| `"false"` | `"true"` exclusively while in `"playing"` state; `"false"` while `"stopped"` or `"paused"` (`ISS-3`). |
| `data-transport-state` | `"stopped"` \| `"playing"` \| `"paused"` | Explicit transport state: `"stopped"` on initial mount and after Stop; `"playing"` during active sequencer playback; `"paused"` when paused. |
| `data-current-step` | `"0"` .. `"15"` | Current 0-based step index (`"0"` = Step 1, `"15"` = Step 16). `"0"` on initial mount and after Stop; preserved at paused step `"k"` while `"paused"`. |
| `data-bpm` | `"40"` .. `"250"` | Active integer BPM of the sequencer (`"120"` on initial mount per `ADR-0001` synthetic seed). |
| `data-audio-ready` | `"true"` \| `"false"` | `"true"` once all rendered track sample `AudioBuffer`s are decoded (`ISS-5`). |

### 2.2 Transport Controls

All three transport controls MUST render simultaneously as visible, enabled (`disabled === false`) `<button type="button">` elements in every transport state so boundary clicks behave as deterministic idempotent operations:

| Selector | Element | Behavior by Current `data-transport-state` |
| --- | --- | --- |
| `[data-testid="transport-play"]` | `<button>` | **From `"stopped"`:** Transitions `data-transport-state` to `"playing"` and `data-playing` to `"true"` with `data-current-step="0"`, immediately triggers active instruments on step `0` (`t = 0ms`, `ISS-5`), and schedules step ticks every `stepIntervalMs`.<br>**From `"paused"` (at step `k`):** Resumes playback from step `k` (`data-transport-state="playing"`, `data-playing="true"`, `data-current-step` stays `String(k)` without resetting to `"0"` and without re-triggering step `k`'s already-played sounds), sets `data-current="true"` on column `k`, and schedules the next transition to `(k + 1) % 16` after one `stepIntervalMs`.<br>**From `"playing"`:** Idempotent no-op (does not reset `data-current-step`, restart/duplicate timers, or re-trigger sounds). |
| `[data-testid="transport-pause"]` | `<button>` | **From `"playing"` (at step `k`):** Immediately clears the running step timer, transitions `data-transport-state` to `"paused"` and `data-playing` to `"false"`, sets `data-current="false"` across all step cells (`ISS-3` §2.3), and **preserves** `data-current-step` at `String(k)`. While paused, advancing virtual time MUST NOT advance steps or trigger sounds.<br>**From `"paused"` or `"stopped"`:** Idempotent no-op (`"paused"` remains `"paused"` at step `k`; `"stopped"` remains `"stopped"` at step `0`). |
| `[data-testid="transport-stop"]` | `<button>` | **From `"playing"` or `"paused"` (at any step `0..15`):** Immediately clears any running step timer, transitions `data-transport-state` to `"stopped"` and `data-playing` to `"false"`, **resets** `data-current-step` to `"0"` (Step 1), sets `data-current="false"` across all step cells, and preserves both pattern step toggles (`data-active`) and active tempo (`data-bpm`). While stopped, advancing virtual time MUST NOT advance steps or trigger sounds.<br>**From `"stopped"`:** Idempotent no-op. |

### 2.3 Tempo (BPM) Controls

| Selector | Element & Attributes | Semantics |
| --- | --- | --- |
| `[data-testid="tempo-input"]` | `<input type="number" min="40" max="250" step="1">` | Visible, enabled (`disabled === false`) numeric tempo input initialized to `"120"` on mount. Editable while `"stopped"`, `"paused"`, or `"playing"`. |
| `[data-testid="tempo-display"]` | Element (e.g. `<span>` / `<output>`) | Visible tempo readout whose text content reflects the active `data-bpm` integer (e.g. `"120"` or `"120 BPM"`). |

---

## 3. Tempo Range, Validation, and Real-Time Timing Semantics

### 3.1 Allowed BPM Range & Clamping Rules

1. **Constants:**
   - `DEFAULT_BPM = 120` (`stepIntervalMs = 125` ms, per `ADR-0001` synthetic seed)
   - `MIN_BPM = 40` (`stepIntervalMs = 375` ms)
   - `MAX_BPM = 250` (`stepIntervalMs = 60` ms)
2. **Active BPM Invariant:** `[data-testid="beatbox-app"][data-bpm]` MUST always be an integer in `[40, 250]` (never `NaN`, `<= 0`, `< 40`, or `> 250`).
3. **Immediate In-Range Updates:** Entering any finite numeric value within `[40, 250]` into `[data-testid="tempo-input"]` (`input` / `change` event) MUST immediately update the active BPM (`Math.round(value)`), `[data-testid="beatbox-app"][data-bpm]`, `[data-testid="tempo-display"]`, and the sequencer's `stepIntervalMs` in real time without requiring `blur`, `Enter`, Stop, or Play.
4. **Out-of-Range Clamping & Empty Input Handling:** Upon committing an input (`blur` or `Enter` keydown, or immediately during `input`/`change` if clamped eagerly):
   - Numeric values `< 40` (including `0` and negative numbers) MUST clamp `data-bpm`, `[data-testid="tempo-display"]`, and `[data-testid="tempo-input"].value` to `"40"`.
   - Numeric values `> 250` MUST clamp `data-bpm`, `[data-testid="tempo-display"]`, and `[data-testid="tempo-input"].value` to `"250"`.
   - Empty or non-numeric values (`""`) on commit (`blur` / `Enter`) MUST preserve the previous active valid BPM in `[40, 250]` and restore `[data-testid="tempo-input"].value` to match `data-bpm`.

### 3.2 Real-Time Interval Rescheduling Formula

1. **Step Interval Formula (`ISS-3` & `ISS-5`):**
   ```text
   stepIntervalMs = 60000 / (bpm * 4)
   ```
2. **Live Tempo Change While Playing (`data-playing="true"`):**
   - Updating BPM while playing MUST keep `data-playing="true"` and `data-transport-state="playing"` and MUST NOT reset `data-current-step` back to `"0"`.
   - When the new clamped BPM differs from the current active BPM, the active browser timer (`setInterval` / `setTimeout`) MUST be immediately replaced using the new `stepIntervalMs` so the very next step transition (`(currentStep + 1) % 16`) and its Web Audio voice triggers occur at the updated tempo interval without stopping or restarting playback.
   - Setting BPM to the already-active BPM value MUST be a no-op that does not disturb in-flight step timing.
3. **Persistence Across Transport Actions:**
   - Pause (`transport-pause`), Resume (`transport-play`), Stop (`transport-stop`), and `15 → 0` loop wrap-arounds MUST preserve the user-configured `data-bpm` value and its corresponding `stepIntervalMs`.
