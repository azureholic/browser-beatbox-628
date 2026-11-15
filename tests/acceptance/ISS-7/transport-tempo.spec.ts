import { expect, type Page, test } from '@playwright/test';

/**
 * ISS-7 Acceptance Test Suite — Transport and tempo controls functionality (REQ-004)
 *
 * Contract references:
 *   - ./contract.md (REQ-004 Play, Pause, Stop transport controls & real-time BPM tempo controls)
 *   - ../ISS-3/contract.md (REQ-002 16-step sequencer DOM & deterministic 16th-note step timing)
 *   - ../ISS-5/contract.md (REQ-003 Web Audio API sample readiness & step-synchronized triggers)
 *
 * Determinism & Isolation guarantees:
 *   1. Uses synthetic 4-instrument x 16-step seed data at 120 BPM from ADR-0001 with zero external network I/O.
 *   2. Replaces `window.AudioContext` / `window.webkitAudioContext` and `HTMLMediaElement.prototype.play`
 *      via `page.addInitScript` so no OS audio hardware is accessed and voice triggers are deterministically observable.
 *   3. Virtualizes time via `page.clock.install` + `page.clock.pauseAt` + explicit `page.clock.runFor`
 *      with zero wall-clock sleeps.
 *   4. Each test executes in an isolated Playwright browser context and stops any active transport on teardown.
 */
const TOTAL_STEPS = 16;
const DEFAULT_BPM = 120;
const MIN_BPM = 40;
const MAX_BPM = 250;
const SEEDED_INSTRUMENT_IDS = ['kick', 'snare', 'hihat-closed', 'clap'] as const;

function stepIntervalMsForBpm(bpm: number): number {
  return 60_000 / (bpm * 4);
}

interface TriggeredSoundRecord {
  seq: number;
  soundId: string;
  audioContextTimeSec: number;
}

interface AudioMockSnapshot {
  triggers: TriggeredSoundRecord[];
}

declare global {
  interface Window {
    __beatboxTransportAudioMock?: {
      getSnapshot: () => AudioMockSnapshot;
      clearTriggers: () => void;
    };
  }
}

async function installDeterministicWebAudioMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const soundIdByByteSignature = new Map<string, string>();
    const soundIdByBufferObject = new WeakMap<ArrayBuffer, string>();
    const triggers: TriggeredSoundRecord[] = [];
    let nextTriggerSeq = 1;

    const computeFnv1aHex = (buffer: ArrayBuffer): string => {
      const bytes = new Uint8Array(buffer);
      let hash = 0x811c9dc5;
      for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i]!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return `${bytes.byteLength}:${hash.toString(16).padStart(8, '0')}`;
    };

    const extractSoundIdFromPathname = (pathname: string): string => {
      const fileName = pathname.split('/').filter(Boolean).pop() ?? '';
      return fileName.replace(/\.[^/.]+$/, '');
    };

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const rawUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const normalizedUrl = new URL(rawUrl, window.location.href);
      const response = await nativeFetch(input, init);

      if (normalizedUrl.pathname.startsWith('/samples/')) {
        const soundId = extractSoundIdFromPathname(normalizedUrl.pathname);
        const wrapResponse = (res: Response): Response => {
          const originalArrayBuffer = res.arrayBuffer.bind(res);
          res.arrayBuffer = async (): Promise<ArrayBuffer> => {
            const ab = await originalArrayBuffer();
            soundIdByBufferObject.set(ab, soundId);
            soundIdByByteSignature.set(computeFnv1aHex(ab), soundId);
            return ab;
          };
          const originalClone = res.clone.bind(res);
          res.clone = (): Response => wrapResponse(originalClone());
          return res;
        };
        return wrapResponse(response);
      }

      return response;
    };

    window.HTMLMediaElement.prototype.play = function mockMediaPlay(): Promise<void> {
      return Promise.resolve();
    };
    window.HTMLMediaElement.prototype.pause = function mockMediaPause(): void {};

    class MockAudioParam {
      public value: number;
      public readonly defaultValue: number;

      constructor(initialValue: number) {
        this.value = initialValue;
        this.defaultValue = initialValue;
      }

      setValueAtTime(value: number): this {
        this.value = value;
        return this;
      }

      linearRampToValueAtTime(value: number): this {
        this.value = value;
        return this;
      }

      exponentialRampToValueAtTime(value: number): this {
        this.value = value;
        return this;
      }

      setTargetAtTime(target: number): this {
        this.value = target;
        return this;
      }

      setValueCurveAtTime(values: Iterable<number>): this {
        const arr = Array.from(values);
        if (arr.length > 0) {
          this.value = arr[arr.length - 1]!;
        }
        return this;
      }

      cancelScheduledValues(): this {
        return this;
      }

      cancelAndHoldAtTime(): this {
        return this;
      }
    }

    class MockAudioNode extends EventTarget {
      public readonly context: MockBaseAudioContext;
      public numberOfInputs = 1;
      public numberOfOutputs = 1;
      public channelCount = 2;
      public channelCountMode: ChannelCountMode = 'max';
      public channelInterpretation: ChannelInterpretation = 'speakers';

      constructor(context: MockBaseAudioContext) {
        super();
        this.context = context;
      }

      connect(destination: MockAudioNode | MockAudioParam): MockAudioNode | void {
        if (destination instanceof MockAudioNode) {
          return destination;
        }
        return undefined;
      }

      disconnect(): void {}
    }

    class MockAudioDestinationNode extends MockAudioNode {
      public readonly maxChannelCount = 2;

      constructor(context: MockBaseAudioContext) {
        super(context);
        this.numberOfOutputs = 0;
      }
    }

    class MockGainNode extends MockAudioNode {
      public readonly gain = new MockAudioParam(1);
    }

    class MockStereoPannerNode extends MockAudioNode {
      public readonly pan = new MockAudioParam(0);
    }

    class MockBiquadFilterNode extends MockAudioNode {
      public type: BiquadFilterType = 'lowpass';
      public readonly frequency = new MockAudioParam(350);
      public readonly detune = new MockAudioParam(0);
      public readonly Q = new MockAudioParam(1);
      public readonly gain = new MockAudioParam(0);
    }

    class MockDynamicsCompressorNode extends MockAudioNode {
      public readonly threshold = new MockAudioParam(-24);
      public readonly knee = new MockAudioParam(30);
      public readonly ratio = new MockAudioParam(12);
      public readonly reduction = 0;
      public readonly attack = new MockAudioParam(0.003);
      public readonly release = new MockAudioParam(0.25);
    }

    class MockAnalyserNode extends MockAudioNode {
      public fftSize = 2048;
      public get frequencyBinCount(): number {
        return this.fftSize >> 1;
      }
      getByteFrequencyData(array: Uint8Array): void {
        array.fill(0);
      }
      getByteTimeDomainData(array: Uint8Array): void {
        array.fill(128);
      }
    }

    class MockAudioBuffer {
      public readonly sampleRate: number;
      public readonly length: number;
      public readonly duration: number;
      public readonly numberOfChannels: number;
      public readonly __soundId: string;
      private readonly channels: Float32Array[];

      constructor(options: {
        numberOfChannels: number;
        length: number;
        sampleRate: number;
        soundId: string;
      }) {
        this.numberOfChannels = options.numberOfChannels;
        this.length = options.length;
        this.sampleRate = options.sampleRate;
        this.duration = options.length / options.sampleRate;
        this.__soundId = options.soundId;
        this.channels = Array.from(
          { length: options.numberOfChannels },
          () => new Float32Array(options.length),
        );
      }

      getChannelData(channel: number): Float32Array {
        return this.channels[channel] ?? new Float32Array(this.length);
      }

      copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset = 0): void {
        const src = this.getChannelData(channelNumber);
        destination.set(src.subarray(bufferOffset, bufferOffset + destination.length));
      }

      copyToChannel(source: Float32Array, channelNumber: number, bufferOffset = 0): void {
        const dst = this.getChannelData(channelNumber);
        dst.set(source.subarray(0, Math.max(0, dst.length - bufferOffset)), bufferOffset);
      }
    }

    class MockAudioBufferSourceNode extends MockAudioNode {
      public buffer: MockAudioBuffer | null = null;
      public loop = false;
      public loopStart = 0;
      public loopEnd = 0;
      public readonly playbackRate = new MockAudioParam(1);
      public readonly detune = new MockAudioParam(0);
      public onended: ((this: AudioBufferSourceNode, ev: Event) => unknown) | null = null;
      private started = false;

      constructor(context: MockBaseAudioContext) {
        super(context);
        this.numberOfInputs = 0;
      }

      start(): void {
        if (this.started) {
          throw new DOMException('Cannot call start more than once', 'InvalidStateError');
        }
        this.started = true;
        triggers.push({
          seq: nextTriggerSeq++,
          soundId: this.buffer?.__soundId ?? 'unmapped-buffer',
          audioContextTimeSec: this.context.currentTime,
        });
      }

      stop(): void {
        const endedEvent = new Event('ended');
        this.dispatchEvent(endedEvent);
        this.onended?.call(this as unknown as AudioBufferSourceNode, endedEvent);
      }
    }

    class MockBaseAudioContext extends EventTarget {
      public readonly sampleRate: number;
      public readonly destination: MockAudioDestinationNode;
      public state: AudioContextState = 'running';
      public onstatechange: ((this: BaseAudioContext, ev: Event) => unknown) | null = null;
      public readonly baseLatency = 0;
      public readonly outputLatency = 0;
      private readonly createdAtPerfMs: number;

      constructor(options?: AudioContextOptions) {
        super();
        this.sampleRate = options?.sampleRate ?? 44_100;
        this.createdAtPerfMs = performance.now();
        this.destination = new MockAudioDestinationNode(this);
      }

      get currentTime(): number {
        return Math.max(0, (performance.now() - this.createdAtPerfMs) / 1000);
      }

      resume(): Promise<void> {
        if (this.state !== 'closed') {
          this.state = 'running';
        }
        return Promise.resolve();
      }

      suspend(): Promise<void> {
        if (this.state !== 'closed') {
          this.state = 'suspended';
        }
        return Promise.resolve();
      }

      close(): Promise<void> {
        this.state = 'closed';
        return Promise.resolve();
      }

      createBuffer(numberOfChannels: number, length: number, sampleRate: number): MockAudioBuffer {
        return new MockAudioBuffer({
          numberOfChannels,
          length,
          sampleRate,
          soundId: 'generated-buffer',
        });
      }

      createBufferSource(): MockAudioBufferSourceNode {
        return new MockAudioBufferSourceNode(this);
      }

      createGain(): MockGainNode {
        return new MockGainNode(this);
      }

      createStereoPanner(): MockStereoPannerNode {
        return new MockStereoPannerNode(this);
      }

      createBiquadFilter(): MockBiquadFilterNode {
        return new MockBiquadFilterNode(this);
      }

      createDynamicsCompressor(): MockDynamicsCompressorNode {
        return new MockDynamicsCompressorNode(this);
      }

      createAnalyser(): MockAnalyserNode {
        return new MockAnalyserNode(this);
      }

      decodeAudioData(
        audioData: ArrayBuffer,
        successCallback?: DecodeSuccessCallback | null,
        errorCallback?: DecodeErrorCallback | null,
      ): Promise<AudioBuffer> {
        if (!(audioData instanceof ArrayBuffer) || audioData.byteLength === 0) {
          const err = new DOMException('Unable to decode empty audio data', 'EncodingError');
          errorCallback?.(err);
          return Promise.reject(err);
        }

        const soundId =
          soundIdByBufferObject.get(audioData) ??
          soundIdByByteSignature.get(computeFnv1aHex(audioData)) ??
          'unknown';

        const decoded = new MockAudioBuffer({
          numberOfChannels: 1,
          length: Math.max(256, Math.floor(this.sampleRate * 0.1)),
          sampleRate: this.sampleRate,
          soundId,
        }) as unknown as AudioBuffer;

        successCallback?.(decoded);
        return Promise.resolve(decoded);
      }
    }

    const MockAudioContextConstructor = MockBaseAudioContext as unknown as typeof AudioContext;
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: MockAudioContextConstructor,
    });
    Object.defineProperty(window, 'webkitAudioContext', {
      configurable: true,
      writable: true,
      value: MockAudioContextConstructor,
    });

    window.__beatboxTransportAudioMock = {
      getSnapshot: (): AudioMockSnapshot => ({
        triggers: triggers.map((trigger) => ({ ...trigger })),
      }),
      clearTriggers: (): void => {
        triggers.length = 0;
      },
    };
  });
}

async function mountBeatboxWithPausedClock(page: Page): Promise<void> {
  await installDeterministicWebAudioMock(page);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00.000Z') });
  await page.goto('/');

  const app = page.getByTestId('beatbox-app');
  await expect(app).toBeVisible();
  await expect(app).toHaveAttribute('data-audio-ready', 'true');

  // Freeze virtual clock before interacting with transport/tempo controls so time progresses
  // exclusively via explicit `page.clock.runFor(...)` calls with zero wall-clock drift.
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01.000Z'));
}

async function getTriggeredSounds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    if (!window.__beatboxTransportAudioMock) {
      throw new Error('Deterministic Web Audio mock was not installed on window');
    }
    return window.__beatboxTransportAudioMock.getSnapshot().triggers.map((t) => t.soundId);
  });
}

async function clearRecordedTriggers(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__beatboxTransportAudioMock?.clearTriggers();
  });
}

async function assertAllStepCurrentIndicatorsFalse(page: Page): Promise<void> {
  for (const instrumentId of SEEDED_INSTRUMENT_IDS) {
    const track = page.getByTestId(`track-${instrumentId}`);
    await expect(track.locator(`[data-testid^="step-${instrumentId}-"][data-current="true"]`)).toHaveCount(0);
  }
}

test.describe('ISS-7: Transport and tempo controls functionality (REQ-004)', () => {
  test.afterEach(async ({ page }) => {
    if (page.isClosed()) {
      return;
    }
    const stopButton = page.getByTestId('transport-stop');
    if ((await stopButton.count()) > 0 && (await stopButton.isEnabled())) {
      await stopButton.click();
    }
  });

  test('REQ-004_renders_initial_seeded_transport_and_tempo_state_and_handles_stopped_and_playing_boundary_clicks', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    const app = page.getByTestId('beatbox-app');
    const playButton = page.getByTestId('transport-play');
    const pauseButton = page.getByTestId('transport-pause');
    const stopButton = page.getByTestId('transport-stop');
    const tempoInput = page.getByTestId('tempo-input');
    const tempoDisplay = page.getByTestId('tempo-display');

    // Verify ADR-0001 initial synthetic seed state (4x16 grid, 120 BPM, stopped at step 0)
    await expect(app).toHaveAttribute('data-transport-state', 'stopped');
    await expect(app).toHaveAttribute('data-playing', 'false');
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect(app).toHaveAttribute('data-bpm', String(DEFAULT_BPM));

    await expect(playButton).toBeVisible();
    await expect(playButton).toBeEnabled();
    await expect(pauseButton).toBeVisible();
    await expect(pauseButton).toBeEnabled();
    await expect(stopButton).toBeVisible();
    await expect(stopButton).toBeEnabled();

    await expect(tempoInput).toBeVisible();
    await expect(tempoInput).toBeEnabled();
    await expect(tempoInput).toHaveValue(String(DEFAULT_BPM));
    await expect(tempoInput).toHaveAttribute('min', String(MIN_BPM));
    await expect(tempoInput).toHaveAttribute('max', String(MAX_BPM));
    await expect(tempoInput).toHaveAttribute('step', '1');

    await expect(tempoDisplay).toBeVisible();
    await expect(tempoDisplay).toContainText(String(DEFAULT_BPM));

    // Boundary case 1: Clicking Pause or Stop while already in initial "stopped" state is a safe no-op
    await clearRecordedTriggers(page);
    await pauseButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'stopped');
    await expect(app).toHaveAttribute('data-playing', 'false');
    await expect(app).toHaveAttribute('data-current-step', '0');

    await stopButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'stopped');
    await expect(app).toHaveAttribute('data-playing', 'false');
    await expect(app).toHaveAttribute('data-current-step', '0');

    await page.clock.runFor(stepIntervalMsForBpm(DEFAULT_BPM) * 4);
    await expect(app).toHaveAttribute('data-current-step', '0');
    expect(await getTriggeredSounds(page)).toEqual([]);

    // Start playback via Play button -> immediately enters "playing" at step 0 and triggers seeded step 0 sounds
    await playButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'playing');
    await expect(app).toHaveAttribute('data-playing', 'true');
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect.poll(async () => (await getTriggeredSounds(page)).sort()).toEqual([
      'hihat-closed',
      'kick',
    ]);

    // Boundary case 2: Clicking Play again while already playing (mid-bar and mid-interval) is an idempotent no-op
    await page.clock.runFor(stepIntervalMsForBpm(DEFAULT_BPM) * 3); // step 0 -> 1 -> 2 -> 3
    await expect(app).toHaveAttribute('data-current-step', '3');

    await page.clock.runFor(50); // 50ms into 125ms interval of step 3
    await clearRecordedTriggers(page);
    await playButton.click();

    await expect(app).toHaveAttribute('data-transport-state', 'playing');
    await expect(app).toHaveAttribute('data-playing', 'true');
    await expect(app).toHaveAttribute('data-current-step', '3');
    expect(await getTriggeredSounds(page)).toEqual([]);

    // Completing the remaining 75ms (50 + 75 = 125ms) reaches step 4 exactly once without duplicate timers
    await page.clock.runFor(stepIntervalMsForBpm(DEFAULT_BPM) - 50);
    await expect(app).toHaveAttribute('data-current-step', '4');
    await expect.poll(async () => (await getTriggeredSounds(page)).sort()).toEqual([
      'hihat-closed',
      'kick',
      'snare',
    ]);
  });

  test('REQ-004_pauses_playback_preserving_current_step_and_resumes_from_paused_step_including_loop_boundary', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    const app = page.getByTestId('beatbox-app');
    const playButton = page.getByTestId('transport-play');
    const pauseButton = page.getByTestId('transport-pause');
    const defaultIntervalMs = stepIntervalMsForBpm(DEFAULT_BPM); // 125ms

    await expect(pauseButton).toBeVisible();
    await expect(pauseButton).toBeEnabled();

    await playButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'playing');

    // Advance 5 steps to step index 5 (plus 40ms sub-interval offset) and pause
    await page.clock.runFor(defaultIntervalMs * 5 + 40);
    await expect(app).toHaveAttribute('data-current-step', '5');

    await clearRecordedTriggers(page);
    await pauseButton.click();

    await expect(app).toHaveAttribute('data-transport-state', 'paused');
    await expect(app).toHaveAttribute('data-playing', 'false');
    await expect(app).toHaveAttribute('data-current-step', '5');
    await assertAllStepCurrentIndicatorsFalse(page);

    // Advancing virtual clock across 8 step intervals while paused must neither advance steps nor trigger sounds
    await page.clock.runFor(defaultIntervalMs * 8);
    await expect(app).toHaveAttribute('data-transport-state', 'paused');
    await expect(app).toHaveAttribute('data-playing', 'false');
    await expect(app).toHaveAttribute('data-current-step', '5');
    expect(await getTriggeredSounds(page)).toEqual([]);

    // Boundary case: Clicking Pause again while already paused at step 5 is an idempotent no-op
    await pauseButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'paused');
    await expect(app).toHaveAttribute('data-current-step', '5');

    // Resume via Play -> stays at step 5 without resetting to 0 and without re-triggering step 5
    await clearRecordedTriggers(page);
    await playButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'playing');
    await expect(app).toHaveAttribute('data-playing', 'true');
    await expect(app).toHaveAttribute('data-current-step', '5');
    await expect(page.getByTestId('step-kick-5')).toHaveAttribute('data-current', 'true');
    expect(await getTriggeredSounds(page)).toEqual([]);

    // Sub-interval elapsed time (< 125ms) from resume must keep current step at 5
    await page.clock.runFor(60);
    await expect(app).toHaveAttribute('data-current-step', '5');
    expect(await getTriggeredSounds(page)).toEqual([]);

    // Completing the 125ms interval advances cleanly from paused step 5 -> step 6 and triggers step 6 sounds
    await page.clock.runFor(defaultIntervalMs - 60);
    await expect(app).toHaveAttribute('data-current-step', '6');
    await expect.poll(async () => await getTriggeredSounds(page)).toEqual(['hihat-closed']);

    // Boundary case: Pause at final step 15 (Step 16) and resume across 15 -> 0 loop boundary
    await page.clock.runFor(defaultIntervalMs * (15 - 6));
    await expect(app).toHaveAttribute('data-current-step', '15');

    await pauseButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'paused');
    await expect(app).toHaveAttribute('data-playing', 'false');
    await expect(app).toHaveAttribute('data-current-step', '15');

    await page.clock.runFor(defaultIntervalMs * 4);
    await expect(app).toHaveAttribute('data-current-step', '15');

    await clearRecordedTriggers(page);
    await playButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'playing');
    await expect(app).toHaveAttribute('data-current-step', '15');

    await page.clock.runFor(defaultIntervalMs);
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect.poll(async () => (await getTriggeredSounds(page)).sort()).toEqual([
      'hihat-closed',
      'kick',
    ]);
  });

  test('REQ-004_stops_playback_from_playing_and_paused_states_and_resets_step_to_beginning', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    const app = page.getByTestId('beatbox-app');
    const playButton = page.getByTestId('transport-play');
    const pauseButton = page.getByTestId('transport-pause');
    const stopButton = page.getByTestId('transport-stop');
    const clapStep2 = page.getByTestId('step-clap-2');
    const defaultIntervalMs = stepIntervalMsForBpm(DEFAULT_BPM); // 125ms

    await expect(pauseButton).toBeVisible();
    await expect(stopButton).toBeVisible();
    await expect(stopButton).toBeEnabled();

    // Toggle an extra step ON before playing so we verify Stop preserves user pattern edits
    await expect(clapStep2).toHaveAttribute('data-active', 'false');
    await clapStep2.click();
    await expect(clapStep2).toHaveAttribute('data-active', 'true');

    // Start playback and advance to mid-bar step 6
    await playButton.click();
    await page.clock.runFor(defaultIntervalMs * 6);
    await expect(app).toHaveAttribute('data-transport-state', 'playing');
    await expect(app).toHaveAttribute('data-current-step', '6');

    // Click Stop while playing -> resets current step immediately back to 0 and halts timer
    await clearRecordedTriggers(page);
    await stopButton.click();

    await expect(app).toHaveAttribute('data-transport-state', 'stopped');
    await expect(app).toHaveAttribute('data-playing', 'false');
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect(clapStep2).toHaveAttribute('data-active', 'true');
    await assertAllStepCurrentIndicatorsFalse(page);

    // Advancing virtual clock while stopped produces zero step transitions and zero sound triggers
    await page.clock.runFor(defaultIntervalMs * 8);
    await expect(app).toHaveAttribute('data-current-step', '0');
    expect(await getTriggeredSounds(page)).toEqual([]);

    // Clicking Play after Stop starts fresh from step 0 (triggering step 0 immediately at t = 0ms)
    await playButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'playing');
    await expect(app).toHaveAttribute('data-playing', 'true');
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect.poll(async () => (await getTriggeredSounds(page)).sort()).toEqual([
      'hihat-closed',
      'kick',
    ]);

    // Advance to boundary step 15, Pause, then Stop from "paused" state -> must reset step 15 -> 0
    await page.clock.runFor(defaultIntervalMs * 15);
    await expect(app).toHaveAttribute('data-current-step', '15');

    await pauseButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'paused');
    await expect(app).toHaveAttribute('data-current-step', '15');

    await clearRecordedTriggers(page);
    await stopButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'stopped');
    await expect(app).toHaveAttribute('data-playing', 'false');
    await expect(app).toHaveAttribute('data-current-step', '0');
    expect(await getTriggeredSounds(page)).toEqual([]);

    // Subsequent Play after Paused->Stopped starts cleanly at step 0 (not old paused step 15)
    await playButton.click();
    await expect(app).toHaveAttribute('data-transport-state', 'playing');
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect.poll(async () => (await getTriggeredSounds(page)).sort()).toEqual([
      'hihat-closed',
      'kick',
    ]);
  });

  test('REQ-004_adjusts_tempo_in_real_time_updating_sequencer_step_interval_and_sound_timing', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    const app = page.getByTestId('beatbox-app');
    const playButton = page.getByTestId('transport-play');
    const pauseButton = page.getByTestId('transport-pause');
    const stopButton = page.getByTestId('transport-stop');
    const tempoInput = page.getByTestId('tempo-input');
    const tempoDisplay = page.getByTestId('tempo-display');

    await expect(tempoInput).toBeVisible();
    await expect(tempoDisplay).toBeVisible();
    await expect(pauseButton).toBeVisible();
    await expect(stopButton).toBeVisible();

    // Start playback at default 120 BPM (125ms per step) and advance to step 2
    await playButton.click();
    await page.clock.runFor(stepIntervalMsForBpm(DEFAULT_BPM) * 2); // 250ms -> step 2
    await expect(app).toHaveAttribute('data-current-step', '2');

    // Speed up tempo in real time while playing: 120 BPM (125ms) -> 200 BPM (75ms per step)
    const fastBpm = 200;
    const fastIntervalMs = stepIntervalMsForBpm(fastBpm); // 75ms
    await tempoInput.fill(String(fastBpm));

    await expect(app).toHaveAttribute('data-bpm', String(fastBpm));
    await expect(tempoDisplay).toContainText(String(fastBpm));
    await expect(app).toHaveAttribute('data-transport-state', 'playing');
    await expect(app).toHaveAttribute('data-playing', 'true');
    await expect(app).toHaveAttribute('data-current-step', '2');

    // Sub-interval at 200 BPM: 50ms (< 75ms) must remain at step 2 with zero premature triggers
    await clearRecordedTriggers(page);
    await page.clock.runFor(50);
    await expect(app).toHaveAttribute('data-current-step', '2');
    expect(await getTriggeredSounds(page)).toEqual([]);

    // Remaining 25ms (75ms total < 125ms old interval) advances to step 3 at the new faster tempo
    await page.clock.runFor(fastIntervalMs - 50);
    await expect(app).toHaveAttribute('data-current-step', '3');

    // Next 75ms tick reaches step 4 and triggers seeded step 4 sounds in time with 200 BPM
    await clearRecordedTriggers(page);
    await page.clock.runFor(fastIntervalMs);
    await expect(app).toHaveAttribute('data-current-step', '4');
    await expect.poll(async () => (await getTriggeredSounds(page)).sort()).toEqual([
      'hihat-closed',
      'kick',
      'snare',
    ]);

    // Slow down tempo in real time while playing: 200 BPM (75ms) -> 60 BPM (250ms per step)
    const slowBpm = 60;
    const slowIntervalMs = stepIntervalMsForBpm(slowBpm); // 250ms
    await tempoInput.fill(String(slowBpm));

    await expect(app).toHaveAttribute('data-bpm', String(slowBpm));
    await expect(tempoDisplay).toContainText(String(slowBpm));
    await expect(app).toHaveAttribute('data-transport-state', 'playing');
    await expect(app).toHaveAttribute('data-current-step', '4');

    // Advancing 125ms (exceeds both previous 75ms and default 125ms, < 250ms new interval) must NOT advance early
    await clearRecordedTriggers(page);
    await page.clock.runFor(125);
    await expect(app).toHaveAttribute('data-current-step', '4');
    expect(await getTriggeredSounds(page)).toEqual([]);

    // Completing remaining 125ms (250ms total) advances to step 5
    await page.clock.runFor(slowIntervalMs - 125);
    await expect(app).toHaveAttribute('data-current-step', '5');

    // Verify selected tempo (60 BPM -> 250ms/step) persists across loop wrap-around, Pause/Resume, and Stop/Play
    for (let stepIndex = 6; stepIndex <= TOTAL_STEPS; stepIndex++) {
      await page.clock.runFor(slowIntervalMs);
      await expect(app).toHaveAttribute('data-current-step', String(stepIndex % TOTAL_STEPS));
    }

    await pauseButton.click();
    await expect(app).toHaveAttribute('data-bpm', String(slowBpm));
    await playButton.click();
    await page.clock.runFor(slowIntervalMs);
    await expect(app).toHaveAttribute('data-current-step', '1');

    await stopButton.click();
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect(app).toHaveAttribute('data-bpm', String(slowBpm));
    await expect(tempoInput).toHaveValue(String(slowBpm));

    await playButton.click();
    await page.clock.runFor(125);
    await expect(app).toHaveAttribute('data-current-step', '0');
    await page.clock.runFor(slowIntervalMs - 125);
    await expect(app).toHaveAttribute('data-current-step', '1');
  });

  test('REQ-004_enforces_allowed_bpm_bounds_and_handles_boundary_and_invalid_tempo_inputs', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    const app = page.getByTestId('beatbox-app');
    const playButton = page.getByTestId('transport-play');
    const tempoInput = page.getByTestId('tempo-input');
    const tempoDisplay = page.getByTestId('tempo-display');

    await expect(tempoInput).toBeVisible();
    await expect(tempoDisplay).toBeVisible();

    // 1. Exact minimum boundary: 40 BPM -> 375ms per 16th-note step
    const minIntervalMs = stepIntervalMsForBpm(MIN_BPM); // 375ms
    await tempoInput.fill(String(MIN_BPM));
    await tempoInput.blur();

    await expect(app).toHaveAttribute('data-bpm', String(MIN_BPM));
    await expect(tempoInput).toHaveValue(String(MIN_BPM));
    await expect(tempoDisplay).toContainText(String(MIN_BPM));

    await playButton.click();
    await page.clock.runFor(300); // < 375ms
    await expect(app).toHaveAttribute('data-current-step', '0');
    await page.clock.runFor(minIntervalMs - 300); // 375ms total -> step 1
    await expect(app).toHaveAttribute('data-current-step', '1');

    // 2. Exact maximum boundary while playing: 250 BPM -> 60ms per 16th-note step
    const maxIntervalMs = stepIntervalMsForBpm(MAX_BPM); // 60ms
    await tempoInput.fill(String(MAX_BPM));
    await tempoInput.blur();

    await expect(app).toHaveAttribute('data-bpm', String(MAX_BPM));
    await expect(tempoInput).toHaveValue(String(MAX_BPM));
    await expect(tempoDisplay).toContainText(String(MAX_BPM));

    await page.clock.runFor(40); // < 60ms
    await expect(app).toHaveAttribute('data-current-step', '1');
    await page.clock.runFor(maxIntervalMs - 40); // 60ms total -> step 2
    await expect(app).toHaveAttribute('data-current-step', '2');

    // 3. Below-minimum inputs ("20" and "-15") clamp to MIN_BPM (40 BPM -> 375ms/step)
    await tempoInput.fill('20');
    await tempoInput.blur();
    await expect(app).toHaveAttribute('data-bpm', String(MIN_BPM));
    await expect(tempoInput).toHaveValue(String(MIN_BPM));
    await expect(tempoDisplay).toContainText(String(MIN_BPM));

    await tempoInput.fill('-15');
    await tempoInput.press('Enter');
    await tempoInput.blur();
    await expect(app).toHaveAttribute('data-bpm', String(MIN_BPM));
    await expect(tempoInput).toHaveValue(String(MIN_BPM));

    await page.clock.runFor(300);
    await expect(app).toHaveAttribute('data-current-step', '2');
    await page.clock.runFor(minIntervalMs - 300);
    await expect(app).toHaveAttribute('data-current-step', '3');

    // 4. Above-maximum inputs ("360" and "999") clamp to MAX_BPM (250 BPM -> 60ms/step)
    await tempoInput.fill('360');
    await tempoInput.blur();
    await expect(app).toHaveAttribute('data-bpm', String(MAX_BPM));
    await expect(tempoInput).toHaveValue(String(MAX_BPM));
    await expect(tempoDisplay).toContainText(String(MAX_BPM));

    await tempoInput.fill('999');
    await tempoInput.press('Enter');
    await tempoInput.blur();
    await expect(app).toHaveAttribute('data-bpm', String(MAX_BPM));
    await expect(tempoInput).toHaveValue(String(MAX_BPM));

    await page.clock.runFor(40);
    await expect(app).toHaveAttribute('data-current-step', '3');
    await page.clock.runFor(maxIntervalMs - 40);
    await expect(app).toHaveAttribute('data-current-step', '4');

    // 5. Empty input ("") on blur preserves active valid BPM (250) and restores input value without NaN/crash
    await tempoInput.fill('');
    await tempoInput.blur();
    const activeBpmAfterEmpty = Number(await app.getAttribute('data-bpm'));
    expect(Number.isInteger(activeBpmAfterEmpty)).toBe(true);
    expect(activeBpmAfterEmpty).toBe(MAX_BPM);
    await expect(tempoInput).toHaveValue(String(MAX_BPM));
    await expect(tempoDisplay).toContainText(String(MAX_BPM));
  });
});
