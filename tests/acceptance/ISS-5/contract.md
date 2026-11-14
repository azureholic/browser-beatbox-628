# Interface Contract — ISS-5: Distinct Sounds Triggered by Sequencer (`REQ-003`)

- **Acceptance Test Issue:** `#5` (`ISS-5` — *Acceptance Test: Distinct sounds triggered by sequencer*)
- **Target Feature Issue:** `#4` (`ISS-4` — *Audio Engine: Web Audio API playback with bundled drum sounds*)
- **Sequencer Dependency:** `#2` / `ISS-3` (`REQ-002` — *16-step continuous looping sequencer*)
- **Requirement Mapping:** `REQ-003` (*Sounds & Web Audio Playback: Multiple distinct bundled drum sounds played via the Web Audio API based on active steps for their respective instruments, in time with the 16-step sequencer*)

---

## 1. Routes & Static Bundled Drum Assets

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Serves the Browser Beatbox React Single Page Application (`200 OK`). |
| `GET` | `/healthz` | Readiness probe returning `200 OK` JSON (`{ "status": "ok", "timestamp": "<ISO-8601>" }`). |
| `GET` | `/samples/<instrumentId>.<ext>` | Serves static bundled synthetic drum audio assets from `web/public/samples/` (`200 OK`, non-empty audio binary). |

Per `ADR-0001`, all audio assets MUST be bundled locally under `web/public/samples/` (copied into static output at `/samples/`) with zero external network dependencies.

### 1.1 Instrument-to-Sample Mapping

1. Every rendered instrument track row `[data-testid="track-<instrumentId>"]` (including at minimum the 4 synthetic seeded instruments `kick`, `snare`, `hihat-closed`, and `clap`, plus any optional additional tracks such as `hihat-open`) MUST map 1-to-1 to its own bundled sample URL following `/samples/<instrumentId>.<ext>` (recommended default `.wav`: `/samples/kick.wav`, `/samples/snare.wav`, `/samples/hihat-closed.wav`, `/samples/clap.wav`).
2. Supported static audio file extensions: `.wav`, `.ogg`, `.mp3`, `.flac`, or `.m4a`.
3. **Distinct Audio Assets:** Each instrument's bundled sample MUST have:
   - A unique URL pathname (`/samples/<instrumentId>.<ext>`).
   - Non-zero byte length (`byteLength > 0`).
   - Distinct binary audio content (distinct byte payload per instrument — never byte-identical copies of the same sample file).

---

## 2. DOM Selectors (`data-testid`) & Readiness State

`ISS-5` preserves all DOM selectors and attributes defined in `tests/acceptance/ISS-3/contract.md` and adds audio-readiness observability on the root shell:

| Selector | Attribute | Values | Semantics |
| --- | --- | --- | --- |
| `[data-testid="beatbox-app"]` | `data-playing` | `"true"` \| `"false"` | `"true"` while sequencer playback is running; `"false"` otherwise (`ISS-3`). |
| `[data-testid="beatbox-app"]` | `data-current-step` | `"0"` .. `"15"` | Current 0-based step index (`"0"` = Step 1, `"15"` = Step 16) (`ISS-3`). |
| `[data-testid="beatbox-app"]` | `data-audio-ready` | `"true"` \| `"false"` | `"false"` while bundled sample buffers are still being fetched/decoded; `"true"` once all rendered instruments' `AudioBuffer`s are decoded and ready for immediate playback. |
| `[data-testid="transport-play"]` | — | `<button>` | Starts playback from a non-playing state (`ISS-3`). |
| `[data-testid="track-<instrumentId>"]` | — | Element | Track row for `<instrumentId>` containing 16 step cells (`0..15`) (`ISS-3`). |
| `[data-testid="step-<instrumentId>-<stepIndex>"]` | `data-active` | `"true"` \| `"false"` | Whether `<instrumentId>` is active on 0-based `<stepIndex>` (`0..15`); clicking toggles exclusively that cell (`ISS-3`). |
| `[data-testid="step-<instrumentId>-<stepIndex>"]` | `data-current` | `"true"` \| `"false"` | `"true"` exclusively on `stepIndex === Number(data-current-step)` while `data-playing="true"` (`ISS-3`). |

---

## 3. Web Audio API Playback & Sequencer Synchronization Contract

### 3.1 Sample Preloading & Decoding (`fetch` + `AudioContext.decodeAudioData`)

1. On application mount, the audio engine MUST fetch every rendered instrument's bundled sample from `/samples/<instrumentId>.<ext>` using `window.fetch(...)`, read the response `ArrayBuffer`, and decode it via `AudioContext.prototype.decodeAudioData(...)` (using `window.AudioContext` or `window.webkitAudioContext`) into a dedicated `AudioBuffer` per `<instrumentId>`.
2. Once all track buffers are decoded, `[data-testid="beatbox-app"]` MUST set `data-audio-ready="true"`.
3. In automated Playwright tests, `window.AudioContext` is replaced via `page.addInitScript` with a deterministic in-memory mock before application scripts execute so no hardware audio device is accessed.

### 3.2 Voice Triggering via `AudioBufferSourceNode`

When the sequencer triggers `<instrumentId>` on an active step:

1. If `audioContext.state === "suspended"`, call `audioContext.resume()`.
2. Create a fresh `AudioBufferSourceNode` via `audioContext.createBufferSource()`.
3. Assign the decoded `AudioBuffer` corresponding to `<instrumentId>` to `sourceNode.buffer`.
4. Connect `sourceNode` to `audioContext.destination` either directly (`sourceNode.connect(audioContext.destination)`) or through intermediate Web Audio nodes (`GainNode`, `DynamicsCompressorNode`, `BiquadFilterNode`, `StereoPannerNode`, etc.) whose output graph connects to `audioContext.destination`.
5. Start playback immediately via `sourceNode.start(...)`.

### 3.3 Deterministic Step-Synchronized Timing

1. **Step Interval Formula (`ISS-3`):**
   ```text
   stepIntervalMs = 60000 / (bpm * 4)
   ```
   At the default synthetic tempo of `120 BPM`, `stepIntervalMs = 125` ms per 16th-note step.
2. **Immediate Downbeat Trigger (`t = 0ms`):**
   - Clicking `[data-testid="transport-play"]` while `data-playing="false"` transitions `data-playing` to `"true"` and `data-current-step` to `"0"` (`ISS-3`), immediately triggering one `AudioBufferSourceNode.start(...)` for **every** instrument with `data-active="true"` at `stepIndex = 0` before the first `stepIntervalMs` elapses.
3. **Tick-Aligned Step Advancement (`t = k * stepIntervalMs`):**
   - Driven by standard browser timers virtualized under Playwright `page.clock` (`setInterval`, `setTimeout`, or `requestAnimationFrame` + `performance.now()`).
   - Sub-interval elapsed times (`< stepIntervalMs`) MUST NOT advance `data-current-step` or pre-trigger future steps' `AudioBufferSourceNode.start(...)` calls.
   - Upon each `stepIntervalMs` transition to `nextStep = (currentStep + 1) % 16` (including the `15 → 0` loop wrap-around), the audio engine MUST trigger **exclusively** the distinct `AudioBuffer`s of instruments whose cell `[data-testid="step-<instrumentId>-<nextStep>"]` currently has `data-active="true"`:
     - Steps where all instruments have `data-active="false"` MUST trigger **zero** `AudioBufferSourceNode.start(...)` calls.
     - Steps where multiple instruments have `data-active="true"` simultaneously MUST trigger one distinct `AudioBufferSourceNode.start(...)` per active instrument on that step.
     - Toggling `[data-testid="step-<instrumentId>-<stepIndex>"]` before or during playback MUST immediately govern whether `<instrumentId>` triggers the next time the sequencer enters `<stepIndex>`.
     - While `data-playing="false"`, advancing virtual time MUST NOT trigger any sequencer step sounds.
