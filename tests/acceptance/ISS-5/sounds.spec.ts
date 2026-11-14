import { expect, type Page, test } from '@playwright/test';

/**
 * ISS-5 Acceptance Test Suite — Distinct sounds triggered by sequencer (REQ-003)
 *
 * Contract references:
 *   - ./contract.md (REQ-003 Web Audio API playback & distinct bundled drum sound triggers)
 *   - ../ISS-3/contract.md (REQ-002 16-step sequencer DOM & deterministic 125ms timing at 120 BPM)
 *
 * Determinism guarantees:
 *   1. All audio playback is mocked in-page via `page.addInitScript` replacing `AudioContext` /
 *      `webkitAudioContext` and `HTMLMediaElement.prototype.play` before any application code runs.
 *      Zero hardware audio devices are accessed.
 *   2. All sequencer timing uses Playwright's deterministic virtual clock (`page.clock.install` +
 *      `page.clock.pauseAt` + explicit `page.clock.runFor`) so time never advances implicitly
 *      between assertions or clicks.
 */
const TOTAL_STEPS = 16;
const DEFAULT_BPM = 120;
const STEP_INTERVAL_MS = 60_000 / (DEFAULT_BPM * 4); // 125 ms per 16th-note step at 120 BPM
const REQUIRED_SEEDED_INSTRUMENTS = ['kick', 'snare', 'hihat-closed', 'clap'] as const;

interface DecodedSampleRecord {
  bufferId: string;
  soundId: string;
  sampleUrl: string;
  httpStatus: number;
  byteLength: number;
  byteHash: string;
}

interface TriggeredSoundRecord {
  seq: number;
  soundId: string;
  sampleUrl: string;
  bufferId: string;
  byteLength: number;
  byteHash: string;
  connectedToDestination: boolean;
  when: number;
  audioContextTimeSec: number;
}

interface AudioMockSnapshot {
  contextCreatedCount: number;
  hardwareAudioBlocked: boolean;
  decodedSamples: DecodedSampleRecord[];
  triggers: TriggeredSoundRecord[];
}

declare global {
  interface Window {
    __beatboxAudioMock?: {
      getSnapshot: () => AudioMockSnapshot;
      clearTriggers: () => void;
    };
  }
}

async function installDeterministicWebAudioMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface SampleFetchMetadata {
      soundId: string;
      sampleUrl: string;
      httpStatus: number;
      byteLength: number;
      byteHash: string;
    }

    const bufferMetadataByObject = new WeakMap<ArrayBuffer, SampleFetchMetadata>();
    const bufferMetadataBySignature = new Map<string, SampleFetchMetadata>();
    const decodedSamples: DecodedSampleRecord[] = [];
    const triggers: TriggeredSoundRecord[] = [];
    let contextCreatedCount = 0;
    let nextBufferNumber = 1;
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

    // Intercept fetch to associate real bundled `/samples/<instrumentId>.<ext>` ArrayBuffers
    // with their static asset URL, HTTP status, and content hash while keeping network I/O intact.
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
        const instrumentResponse = (res: Response): Response => {
          const originalArrayBuffer = res.arrayBuffer.bind(res);
          res.arrayBuffer = async (): Promise<ArrayBuffer> => {
            const ab = await originalArrayBuffer();
            const byteHash = computeFnv1aHex(ab);
            const meta: SampleFetchMetadata = {
              soundId: extractSoundIdFromPathname(normalizedUrl.pathname),
              sampleUrl: normalizedUrl.pathname,
              httpStatus: res.status,
              byteLength: ab.byteLength,
              byteHash,
            };
            bufferMetadataByObject.set(ab, meta);
            bufferMetadataBySignature.set(byteHash, meta);
            return ab;
          };

          const originalClone = res.clone.bind(res);
          res.clone = (): Response => instrumentResponse(originalClone());
          return res;
        };

        return instrumentResponse(response);
      }

      return response;
    };

    // Prevent any fallback <audio> element from accessing OS audio hardware.
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
      public readonly connectedTargets = new Set<MockAudioNode>();

      constructor(context: MockBaseAudioContext) {
        super();
        this.context = context;
      }

      connect(destination: MockAudioNode | MockAudioParam): MockAudioNode | void {
        if (destination instanceof MockAudioNode) {
          this.connectedTargets.add(destination);
          return destination;
        }
        return undefined;
      }

      disconnect(destination?: MockAudioNode | MockAudioParam): void {
        if (destination instanceof MockAudioNode) {
          this.connectedTargets.delete(destination);
          return;
        }
        if (!destination) {
          this.connectedTargets.clear();
        }
      }

      isConnectedTo(target: MockAudioNode): boolean {
        const visited = new Set<MockAudioNode>();
        const queue: MockAudioNode[] = [this];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current === target) {
            return true;
          }
          if (visited.has(current)) {
            continue;
          }
          visited.add(current);
          for (const next of current.connectedTargets) {
            queue.push(next);
          }
        }
        return false;
      }
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
      public readonly __mockMeta: DecodedSampleRecord;
      private readonly channels: Float32Array[];

      constructor(options: {
        numberOfChannels: number;
        length: number;
        sampleRate: number;
        meta: DecodedSampleRecord;
      }) {
        this.numberOfChannels = options.numberOfChannels;
        this.length = options.length;
        this.sampleRate = options.sampleRate;
        this.duration = options.length / options.sampleRate;
        this.__mockMeta = options.meta;
        this.channels = Array.from(
          { length: options.numberOfChannels },
          () => new Float32Array(options.length),
        );
      }

      getChannelData(channel: number): Float32Array {
        if (channel < 0 || channel >= this.channels.length) {
          throw new DOMException('Channel index out of bounds', 'IndexSizeError');
        }
        return this.channels[channel]!;
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

      start(when = 0): void {
        if (this.started) {
          throw new DOMException('Cannot call start more than once', 'InvalidStateError');
        }
        this.started = true;

        const meta = this.buffer?.__mockMeta;

        triggers.push({
          seq: nextTriggerSeq++,
          soundId: meta?.soundId ?? 'unmapped-buffer',
          sampleUrl: meta?.sampleUrl ?? '',
          bufferId: meta?.bufferId ?? 'null-buffer',
          byteLength: meta?.byteLength ?? 0,
          byteHash: meta?.byteHash ?? '',
          connectedToDestination: this.isConnectedTo(this.context.destination),
          when,
          audioContextTimeSec: this.context.currentTime,
        });
      }

      stop(): void {
        const endedEvent = new Event('ended');
        this.dispatchEvent(endedEvent);
        if (typeof this.onended === 'function') {
          this.onended.call(this as unknown as AudioBufferSourceNode, endedEvent);
        }
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
        contextCreatedCount += 1;
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
          const ev = new Event('statechange');
          this.dispatchEvent(ev);
          this.onstatechange?.call(this as unknown as BaseAudioContext, ev);
        }
        return Promise.resolve();
      }

      suspend(): Promise<void> {
        if (this.state !== 'closed') {
          this.state = 'suspended';
          const ev = new Event('statechange');
          this.dispatchEvent(ev);
          this.onstatechange?.call(this as unknown as BaseAudioContext, ev);
        }
        return Promise.resolve();
      }

      close(): Promise<void> {
        this.state = 'closed';
        const ev = new Event('statechange');
        this.dispatchEvent(ev);
        this.onstatechange?.call(this as unknown as BaseAudioContext, ev);
        return Promise.resolve();
      }

      createBuffer(numberOfChannels: number, length: number, sampleRate: number): MockAudioBuffer {
        const bufferId = `generated-buffer-${nextBufferNumber++}`;
        return new MockAudioBuffer({
          numberOfChannels,
          length,
          sampleRate,
          meta: {
            bufferId,
            soundId: bufferId,
            sampleUrl: '',
            httpStatus: 0,
            byteLength: length * numberOfChannels * 4,
            byteHash: `generated:${bufferId}`,
          },
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

        const byteHash = computeFnv1aHex(audioData);
        const fetchMeta =
          bufferMetadataByObject.get(audioData) ?? bufferMetadataBySignature.get(byteHash);
        const bufferId = `decoded-buffer-${nextBufferNumber++}`;

        const record: DecodedSampleRecord = {
          bufferId,
          soundId: fetchMeta?.soundId ?? bufferId,
          sampleUrl: fetchMeta?.sampleUrl ?? '',
          httpStatus: fetchMeta?.httpStatus ?? 200,
          byteLength: audioData.byteLength,
          byteHash,
        };
        decodedSamples.push(record);

        const decoded = new MockAudioBuffer({
          numberOfChannels: 1,
          length: Math.max(256, Math.floor(this.sampleRate * 0.1)),
          sampleRate: this.sampleRate,
          meta: record,
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

    window.__beatboxAudioMock = {
      getSnapshot: (): AudioMockSnapshot => ({
        contextCreatedCount,
        hardwareAudioBlocked: true,
        decodedSamples: decodedSamples.map((sample) => ({ ...sample })),
        triggers: triggers.map((trigger) => ({ ...trigger })),
      }),
      clearTriggers: (): void => {
        triggers.length = 0;
      },
    };
  });
}

async function mountBeatboxWithMockAudioAndPausedClock(page: Page): Promise<string[]> {
  await installDeterministicWebAudioMock(page);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00.000Z') });
  await page.goto('/');

  const app = page.getByTestId('beatbox-app');
  await expect(app).toBeVisible();
  await expect(app).toHaveAttribute('data-audio-ready', 'true');

  // Pause virtual clock before any transport interaction so playback time advances
  // exclusively on explicit `page.clock.runFor(...)` calls with zero wall-clock drift.
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01.000Z'));

  const trackElements = page.locator('[data-testid^="track-"]');
  const trackCount = await trackElements.count();
  const renderedInstrumentIds: string[] = [];
  for (let i = 0; i < trackCount; i++) {
    const testId = await trackElements.nth(i).getAttribute('data-testid');
    if (testId?.startsWith('track-')) {
      renderedInstrumentIds.push(testId.slice('track-'.length));
    }
  }

  for (const requiredId of REQUIRED_SEEDED_INSTRUMENTS) {
    expect(renderedInstrumentIds).toContain(requiredId);
  }

  return renderedInstrumentIds;
}

async function getAudioSnapshot(page: Page): Promise<AudioMockSnapshot> {
  return page.evaluate(() => {
    if (!window.__beatboxAudioMock) {
      throw new Error('Deterministic Web Audio mock was not installed on window');
    }
    return window.__beatboxAudioMock.getSnapshot();
  });
}

async function clearRecordedTriggers(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__beatboxAudioMock?.clearTriggers();
  });
}

async function setStepActiveState(
  page: Page,
  instrumentId: string,
  stepIndex: number,
  desiredActive: boolean,
): Promise<void> {
  const cell = page.getByTestId(`step-${instrumentId}-${stepIndex}`);
  const currentAttr = await cell.getAttribute('data-active');
  const isCurrentlyActive = currentAttr === 'true';
  if (isCurrentlyActive !== desiredActive) {
    await cell.click();
  }
  await expect(cell).toHaveAttribute('data-active', String(desiredActive));
}

async function startPlaybackFromInitialState(page: Page): Promise<void> {
  const app = page.getByTestId('beatbox-app');
  const playButton = page.getByTestId('transport-play');

  await expect(app).toHaveAttribute('data-playing', 'false');
  await expect(playButton).toBeVisible();
  await expect(playButton).toBeEnabled();

  await clearRecordedTriggers(page);
  await playButton.click();

  await expect(app).toHaveAttribute('data-playing', 'true');
  await expect(app).toHaveAttribute('data-current-step', '0');
}

test.describe('ISS-5: Distinct sounds triggered by sequencer (REQ-003)', () => {
  test('REQ-003_loads_distinct_bundled_drum_samples_for_each_instrument_without_hardware_audio', async ({
    page,
  }) => {
    const instrumentIds = await mountBeatboxWithMockAudioAndPausedClock(page);
    const snapshot = await getAudioSnapshot(page);

    expect(snapshot.hardwareAudioBlocked).toBe(true);

    const decodedBySoundId = new Map<string, DecodedSampleRecord>();
    for (const sample of snapshot.decodedSamples) {
      decodedBySoundId.set(sample.soundId, sample);
    }

    // Verify every rendered instrument loaded a valid, distinct bundled sample via `/samples/<id>.<ext>`
    const sampleUrls: string[] = [];
    const bufferIds: string[] = [];
    const byteHashes: string[] = [];

    for (const instrumentId of instrumentIds) {
      const sample = decodedBySoundId.get(instrumentId);
      expect(
        sample,
        `Expected bundled audio sample to be fetched and decoded for instrument "${instrumentId}"`,
      ).toBeDefined();

      expect(sample!.httpStatus).toBe(200);
      expect(sample!.sampleUrl).toMatch(
        new RegExp(`^/samples/${instrumentId}\\.(wav|ogg|mp3|flac|m4a)$`),
      );
      expect(sample!.byteLength).toBeGreaterThan(0);

      sampleUrls.push(sample!.sampleUrl);
      bufferIds.push(sample!.bufferId);
      byteHashes.push(sample!.byteHash);
    }

    // Pairwise distinctness across URLs, decoded AudioBuffers, and binary audio payloads
    expect(new Set(sampleUrls).size).toBe(instrumentIds.length);
    expect(new Set(bufferIds).size).toBe(instrumentIds.length);
    expect(new Set(byteHashes).size).toBe(instrumentIds.length);
  });

  test('REQ-003_triggers_distinct_mapped_drum_sound_for_each_instrument_on_its_assigned_step', async ({
    page,
  }) => {
    const instrumentIds = await mountBeatboxWithMockAudioAndPausedClock(page);
    const app = page.getByTestId('beatbox-app');

    // Configure an isolated diagonal pattern across steps 0..(N-1) plus one completely silent step (step N),
    // ensuring every rendered instrument (including kick, snare, hihat-closed, clap) fires alone on its step.
    const silentStepIndex = instrumentIds.length;
    expect(silentStepIndex).toBeLessThan(TOTAL_STEPS);

    for (let stepIndex = 0; stepIndex <= silentStepIndex; stepIndex++) {
      for (let trackIdx = 0; trackIdx < instrumentIds.length; trackIdx++) {
        const shouldBeActive = stepIndex === trackIdx;
        await setStepActiveState(page, instrumentIds[trackIdx]!, stepIndex, shouldBeActive);
      }
    }

    await startPlaybackFromInitialState(page);

    const observedStepTriggers: TriggeredSoundRecord[] = [];

    for (let stepIndex = 0; stepIndex < instrumentIds.length; stepIndex++) {
      if (stepIndex > 0) {
        await clearRecordedTriggers(page);
        await page.clock.runFor(STEP_INTERVAL_MS);
      }

      const expectedInstrumentId = instrumentIds[stepIndex]!;
      await expect(app).toHaveAttribute('data-current-step', String(stepIndex));

      await expect
        .poll(async () => (await getAudioSnapshot(page)).triggers.length)
        .toBe(1);

      const stepTriggers = (await getAudioSnapshot(page)).triggers;
      expect(stepTriggers).toHaveLength(1);

      const triggered = stepTriggers[0]!;
      expect(triggered.soundId).toBe(expectedInstrumentId);
      expect(triggered.sampleUrl).toMatch(
        new RegExp(`^/samples/${expectedInstrumentId}\\.(wav|ogg|mp3|flac|m4a)$`),
      );
      expect(triggered.connectedToDestination).toBe(true);
      expect(triggered.byteLength).toBeGreaterThan(0);

      observedStepTriggers.push(triggered);
    }

    // Advance onto the completely empty step -> must produce zero sound triggers
    await clearRecordedTriggers(page);
    await page.clock.runFor(STEP_INTERVAL_MS);
    await expect(app).toHaveAttribute('data-current-step', String(silentStepIndex));
    expect((await getAudioSnapshot(page)).triggers).toEqual([]);

    // Assert every step triggered a distinct sound ID, sample URL, decoded AudioBuffer, and audio byte payload
    expect(observedStepTriggers.map((t) => t.soundId)).toEqual(instrumentIds);
    expect(new Set(observedStepTriggers.map((t) => t.soundId)).size).toBe(instrumentIds.length);
    expect(new Set(observedStepTriggers.map((t) => t.sampleUrl)).size).toBe(instrumentIds.length);
    expect(new Set(observedStepTriggers.map((t) => t.bufferId)).size).toBe(instrumentIds.length);
    expect(new Set(observedStepTriggers.map((t) => t.byteHash)).size).toBe(instrumentIds.length);
  });

  test('REQ-003_plays_seeded_multi_instrument_pattern_simultaneously_and_in_time_with_sequencer', async ({
    page,
  }) => {
    const instrumentIds = await mountBeatboxWithMockAudioAndPausedClock(page);
    const app = page.getByTestId('beatbox-app');

    // Read active steps across all rendered tracks for all 16 steps so polyphonic steps
    // (e.g. step 0: kick + hihat-closed; step 4: kick + snare + hihat-closed;
    // step 12: kick + snare + hihat-closed + clap) are verified against exact active DOM state.
    const expectedSoundsByStep: string[][] = [];
    for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
      const activeOnStep: string[] = [];
      for (const instrumentId of instrumentIds) {
        const activeAttr = await page
          .getByTestId(`step-${instrumentId}-${stepIndex}`)
          .getAttribute('data-active');
        if (activeAttr === 'true') {
          activeOnStep.push(instrumentId);
        }
      }
      expectedSoundsByStep.push(activeOnStep);
    }

    // Verify seeded groove contains simultaneous multi-instrument steps for the 4 core instruments
    expect(expectedSoundsByStep[0]).toEqual(expect.arrayContaining(['kick', 'hihat-closed']));
    expect(expectedSoundsByStep[4]).toEqual(
      expect.arrayContaining(['kick', 'snare', 'hihat-closed']),
    );
    expect(expectedSoundsByStep[12]).toEqual(
      expect.arrayContaining(['kick', 'snare', 'hihat-closed', 'clap']),
    );

    await startPlaybackFromInitialState(page);

    // Step 0 fires immediately at t = 0ms
    await expect
      .poll(async () => (await getAudioSnapshot(page)).triggers.length)
      .toBe(expectedSoundsByStep[0]!.length);
    expect(
      (await getAudioSnapshot(page)).triggers.map((t) => t.soundId).sort(),
    ).toEqual([...expectedSoundsByStep[0]!].sort());

    // Sub-interval timing check: advancing 60ms (< 125ms stepIntervalMs) must NOT prematurely trigger step 1
    await clearRecordedTriggers(page);
    await page.clock.runFor(60);
    await expect(app).toHaveAttribute('data-current-step', '0');
    expect((await getAudioSnapshot(page)).triggers).toEqual([]);

    // Completing remaining 65ms (60 + 65 = 125ms) reaches step 1 and triggers exclusively step 1's active sounds
    await page.clock.runFor(STEP_INTERVAL_MS - 60);
    await expect(app).toHaveAttribute('data-current-step', '1');
    await expect
      .poll(async () => (await getAudioSnapshot(page)).triggers.length)
      .toBe(expectedSoundsByStep[1]!.length);
    expect(
      (await getAudioSnapshot(page)).triggers.map((t) => t.soundId).sort(),
    ).toEqual([...expectedSoundsByStep[1]!].sort());

    // Verify remaining steps 2..15 plus automatic loop wrap-around back to step 0 (tick 16)
    for (let tick = 2; tick <= TOTAL_STEPS; tick++) {
      const expectedStep = tick % TOTAL_STEPS;
      const expectedSounds = expectedSoundsByStep[expectedStep]!;

      await clearRecordedTriggers(page);
      await page.clock.runFor(STEP_INTERVAL_MS);

      await expect(app).toHaveAttribute('data-current-step', String(expectedStep));
      await expect
        .poll(async () => (await getAudioSnapshot(page)).triggers.length)
        .toBe(expectedSounds.length);

      const stepTriggers = (await getAudioSnapshot(page)).triggers;
      expect(stepTriggers.map((t) => t.soundId).sort()).toEqual([...expectedSounds].sort());

      // On polyphonic steps (e.g. step 12 with 4 simultaneous instruments), all triggered buffers must be distinct
      expect(new Set(stepTriggers.map((t) => t.bufferId)).size).toBe(expectedSounds.length);
      expect(new Set(stepTriggers.map((t) => t.byteHash)).size).toBe(expectedSounds.length);
      for (const trigger of stepTriggers) {
        expect(trigger.connectedToDestination).toBe(true);
      }
    }
  });

  test('REQ-003_dynamically_toggling_steps_updates_triggered_sounds_and_silent_when_stopped', async ({
    page,
  }) => {
    const instrumentIds = await mountBeatboxWithMockAudioAndPausedClock(page);
    const app = page.getByTestId('beatbox-app');

    // Clear steps 0, 1, and 2 across all instruments before starting
    for (const stepIndex of [0, 1, 2]) {
      for (const instrumentId of instrumentIds) {
        await setStepActiveState(page, instrumentId, stepIndex, false);
      }
    }

    // Activate only `kick` on step 0 and `snare` on step 1; keep step 2 silent initially
    await setStepActiveState(page, 'kick', 0, true);
    await setStepActiveState(page, 'snare', 1, true);

    // While stopped (`data-playing="false"`), advancing virtual time must trigger zero sequencer sounds
    await clearRecordedTriggers(page);
    await page.clock.runFor(STEP_INTERVAL_MS * 4);
    await expect(app).toHaveAttribute('data-playing', 'false');
    expect((await getAudioSnapshot(page)).triggers).toEqual([]);

    // Start playback -> step 0 triggers `kick`
    await startPlaybackFromInitialState(page);
    await expect.poll(async () => (await getAudioSnapshot(page)).triggers.map((t) => t.soundId)).toEqual([
      'kick',
    ]);

    // Mid-playback edits before reaching steps 1 & 2, and edit step 0 for the next loop cycle:
    //   - Turn `snare` OFF on step 1 and turn `clap` ON on step 1
    //   - Turn `kick` + `hihat-closed` ON on step 2
    //   - Turn `kick` OFF and `snare` ON on step 0 (verified after 15 -> 0 wrap-around)
    await setStepActiveState(page, 'snare', 1, false);
    await setStepActiveState(page, 'clap', 1, true);
    await setStepActiveState(page, 'kick', 2, true);
    await setStepActiveState(page, 'hihat-closed', 2, true);
    await setStepActiveState(page, 'kick', 0, false);
    await setStepActiveState(page, 'snare', 0, true);

    // Tick to step 1 -> `clap` fires instead of deactivated `snare`
    await clearRecordedTriggers(page);
    await page.clock.runFor(STEP_INTERVAL_MS);
    await expect(app).toHaveAttribute('data-current-step', '1');
    await expect.poll(async () => (await getAudioSnapshot(page)).triggers.map((t) => t.soundId)).toEqual([
      'clap',
    ]);

    // Tick to step 2 -> newly activated `kick` + `hihat-closed` both fire
    await clearRecordedTriggers(page);
    await page.clock.runFor(STEP_INTERVAL_MS);
    await expect(app).toHaveAttribute('data-current-step', '2');
    await expect
      .poll(async () => (await getAudioSnapshot(page)).triggers.map((t) => t.soundId).sort())
      .toEqual(['hihat-closed', 'kick']);

    // Advance remaining 13 steps (steps 3..15) and wrap to step 0 (14 ticks total from step 2)
    for (let stepIndex = 3; stepIndex < TOTAL_STEPS; stepIndex++) {
      await page.clock.runFor(STEP_INTERVAL_MS);
      await expect(app).toHaveAttribute('data-current-step', String(stepIndex));
    }

    await clearRecordedTriggers(page);
    await page.clock.runFor(STEP_INTERVAL_MS);
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect.poll(async () => (await getAudioSnapshot(page)).triggers.map((t) => t.soundId)).toEqual([
      'snare',
    ]);
  });
});
