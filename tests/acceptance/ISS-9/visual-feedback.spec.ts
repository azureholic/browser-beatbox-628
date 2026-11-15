import { expect, type Locator, type Page, test } from '@playwright/test';

/**
 * ISS-9 Acceptance Test Suite — Visual feedback for current and active steps (REQ-005)
 *
 * Contract references:
 *   - ./contract.md (REQ-005 current/completed/upcoming step visual states, active toggles,
 *     aria-current, ARIA roles, state classes, icons, and keyboard focus navigation)
 *   - ../ISS-3/contract.md (REQ-002 16-step sequencer DOM & deterministic 125ms timing at 120 BPM)
 *   - ../ISS-5/contract.md (REQ-003 Web Audio API sample readiness & in-memory mock contract)
 *   - ../ISS-7/contract.md (REQ-004 transport controls compatibility)
 *
 * Determinism & Isolation guarantees:
 *   1. Uses synthetic 4-instrument x 16-step seed data at 120 BPM from ADR-0001 with zero external I/O.
 *   2. Replaces `window.AudioContext` / `window.webkitAudioContext` and `HTMLMediaElement.prototype.play`
 *      via `page.addInitScript` so zero OS audio hardware is accessed.
 *   3. Disables CSS transition/animation durations in-test so `getComputedStyle(...)` reflects target
 *      visual states deterministically on the exact virtual-clock tick with zero interpolation lag.
 *   4. Virtualizes time via `page.clock.install` + `page.clock.pauseAt` + explicit `page.clock.runFor`
 *      with zero wall-clock sleeps or arbitrary timeouts.
 */
const TOTAL_STEPS = 16;
const DEFAULT_BPM = 120;
const STEP_INTERVAL_MS = 60_000 / (DEFAULT_BPM * 4); // 125 ms per 16th-note step
const SEEDED_INSTRUMENT_IDS = ['kick', 'snare', 'hihat-closed', 'clap'] as const;

type SeededInstrumentId = (typeof SEEDED_INSTRUMENT_IDS)[number];
type StepProgressionState = 'current' | 'completed' | 'upcoming';

const SEEDED_ACTIVE_STEPS: Readonly<Record<SeededInstrumentId, readonly number[]>> = {
  kick: [0, 4, 8, 12],
  snare: [4, 12],
  'hihat-closed': [0, 2, 4, 6, 8, 10, 12, 14],
  clap: [12, 15],
};

interface StepVisualSignature {
  backgroundColor: string;
  backgroundImage: string;
  borderTopColor: string;
  color: string;
  boxShadow: string;
  opacity: string;
  fontWeight: string;
}

interface FocusVisualSignature {
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
  borderTopColor: string;
}

function classTokenRegex(token: string): RegExp {
  return new RegExp(`(^|\\s)${token}(\\s|$)`);
}

async function installDeterministicWebAudioMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
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
      private readonly channels: Float32Array[];

      constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
        this.numberOfChannels = options.numberOfChannels;
        this.length = options.length;
        this.sampleRate = options.sampleRate;
        this.duration = options.length / options.sampleRate;
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
        return new MockAudioBuffer({ numberOfChannels, length, sampleRate });
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

        const decoded = new MockAudioBuffer({
          numberOfChannels: 1,
          length: Math.max(256, Math.floor(this.sampleRate * 0.1)),
          sampleRate: this.sampleRate,
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
  });
}

async function mountBeatboxWithPausedClock(page: Page): Promise<void> {
  await installDeterministicWebAudioMock(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00.000Z') });
  await page.goto('/');

  // Freeze CSS transitions/animations so getComputedStyle observations are 100% deterministic
  await page.addStyleTag({
    content: `*, *::before, *::after { transition-property: none !important; transition-duration: 0s !important; animation-duration: 0s !important; }`,
  });

  const app = page.getByTestId('beatbox-app');
  await expect(app).toBeVisible();
  await expect(app).toHaveAttribute('data-audio-ready', 'true');

  await page.clock.pauseAt(new Date('2026-01-01T00:00:01.000Z'));
}

async function stopPlaybackIfRunning(page: Page): Promise<void> {
  const app = page.getByTestId('beatbox-app');
  if ((await app.count()) === 0) {
    return;
  }
  const isPlaying = (await app.getAttribute('data-playing')) === 'true';
  const transportState = await app.getAttribute('data-transport-state');
  if (!isPlaying && transportState !== 'paused') {
    return;
  }

  const stopButton = page.getByTestId('transport-stop');
  if ((await stopButton.count()) > 0 && (await stopButton.isEnabled())) {
    await stopButton.click();
  } else if (isPlaying) {
    await page.getByTestId('transport-play').click();
  }
}

async function getVisualSignature(locator: Locator): Promise<StepVisualSignature> {
  return locator.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      borderTopColor: cs.borderTopColor,
      color: cs.color,
      boxShadow: cs.boxShadow,
      opacity: cs.opacity,
      fontWeight: cs.fontWeight,
    };
  });
}

async function getFocusSignature(locator: Locator): Promise<FocusVisualSignature> {
  return locator.evaluate((el) => {
    const cs = window.getComputedStyle(el);
    return {
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      boxShadow: cs.boxShadow,
      borderTopColor: cs.borderTopColor,
    };
  });
}

async function assertAriaCurrentState(locator: Locator, isCurrent: boolean): Promise<void> {
  if (isCurrent) {
    await expect(locator).toHaveAttribute('aria-current', 'step');
  } else {
    const attrValue = await locator.getAttribute('aria-current');
    expect(attrValue === null || attrValue === 'false').toBe(true);
  }
}

async function assertStepProgressionClasses(
  locator: Locator,
  baseClass: 'step-cell' | 'step-indicator',
  expectedState: StepProgressionState,
): Promise<void> {
  await expect(locator).toHaveClass(classTokenRegex(baseClass));
  await expect(locator).toHaveClass(classTokenRegex(expectedState));

  const otherStates = (['current', 'completed', 'upcoming'] as const).filter(
    (state) => state !== expectedState,
  );
  for (const state of otherStates) {
    await expect(locator).not.toHaveClass(classTokenRegex(state));
  }
}

function assertPairwiseDistinctSignatures(
  entries: readonly { label: string; signature: StepVisualSignature }[],
): void {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      expect(
        entries[i]!.signature,
        `Expected visual style of "${entries[i]!.label}" to differ from "${entries[j]!.label}"`,
      ).not.toEqual(entries[j]!.signature);
    }
  }
}

test.describe('ISS-9: Visual feedback for current and active steps (REQ-005)', () => {
  test.afterEach(async ({ page }) => {
    if (!page.isClosed()) {
      await stopPlaybackIfRunning(page);
    }
  });

  test('REQ-005_renders_seeded_active_and_inactive_steps_with_distinct_visual_styles_classes_and_aria_states', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    const app = page.getByTestId('beatbox-app');
    await expect(app).toHaveAttribute('data-playing', 'false');
    await expect(app).toHaveAttribute('data-current-step', '0');

    // Verify ARIA region, playhead list, and 16 upcoming step indicators in initial stopped state
    const patternGrid = page.locator('section.pattern-grid');
    await expect(patternGrid).toBeVisible();
    await expect(patternGrid).toHaveRole('region');
    await expect(patternGrid).toHaveAccessibleName(/.+/);

    const stepIndicators = page.getByTestId('step-indicators');
    await expect(stepIndicators).toBeVisible();
    await expect(stepIndicators).toHaveRole('list');
    await expect(stepIndicators).toHaveAccessibleName(/.+/);
    await expect(stepIndicators.locator('[data-testid^="step-indicator-icon-"]')).toHaveCount(
      TOTAL_STEPS,
    );

    for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
      const indicator = page.getByTestId(`step-indicator-${stepIndex}`);
      const icon = page.getByTestId(`step-indicator-icon-${stepIndex}`);

      await expect(indicator).toBeVisible();
      await expect(indicator).toHaveRole('listitem');
      await expect(indicator).toHaveAttribute('data-current', 'false');
      await expect(indicator).toHaveAttribute('data-step-state', 'upcoming');
      await assertAriaCurrentState(indicator, false);
      await assertStepProgressionClasses(indicator, 'step-indicator', 'upcoming');

      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      await expect(icon).toHaveAttribute('data-icon-state', 'upcoming');
    }

    // Verify all 4 seeded instrument tracks expose group ARIA semantics and distinct active vs inactive styles
    for (const instrumentId of SEEDED_INSTRUMENT_IDS) {
      const track = page.getByTestId(`track-${instrumentId}`);
      await expect(track).toBeVisible();
      await expect(track).toHaveRole('group');
      await expect(track).toHaveAccessibleName(/.+/);

      const expectedActiveSet = new Set(SEEDED_ACTIVE_STEPS[instrumentId]);
      let sampleActiveCell: Locator | null = null;
      let sampleInactiveCell: Locator | null = null;

      for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
        const cell = page.getByTestId(`step-${instrumentId}-${stepIndex}`);
        const shouldBeActive = expectedActiveSet.has(stepIndex);

        await expect(cell).toBeVisible();
        await expect(cell).toHaveRole('button');
        await expect(cell).toHaveAccessibleName(new RegExp(`\\b${stepIndex + 1}\\b`));
        await expect(cell).toHaveAttribute('data-active', String(shouldBeActive));
        await expect(cell).toHaveAttribute('aria-pressed', String(shouldBeActive));
        await expect(cell).toHaveAttribute('data-current', 'false');
        await expect(cell).toHaveAttribute('data-step-state', 'upcoming');
        await assertAriaCurrentState(cell, false);
        await assertStepProgressionClasses(cell, 'step-cell', 'upcoming');

        if (shouldBeActive) {
          await expect(cell).toHaveClass(classTokenRegex('active'));
          sampleActiveCell ??= cell;
        } else {
          await expect(cell).not.toHaveClass(classTokenRegex('active'));
          sampleInactiveCell ??= cell;
        }
      }

      const activeSig = await getVisualSignature(sampleActiveCell!);
      const inactiveSig = await getVisualSignature(sampleInactiveCell!);
      expect(activeSig).not.toEqual(inactiveSig);
      expect(
        activeSig.backgroundColor !== inactiveSig.backgroundColor ||
          activeSig.backgroundImage !== inactiveSig.backgroundImage ||
          activeSig.borderTopColor !== inactiveSig.borderTopColor,
      ).toBe(true);
    }

    // Toggling an inactive cell ON and an active cell OFF immediately updates classes, ARIA state, and computed styles
    const snareStep1 = page.getByTestId('step-snare-1');
    const snareStep2 = page.getByTestId('step-snare-2');
    const kickStep0 = page.getByTestId('step-kick-0');

    const inactiveBaselineSig = await getVisualSignature(snareStep2);
    const activeBaselineSig = await getVisualSignature(kickStep0);

    await snareStep1.click();
    await expect(snareStep1).toHaveAttribute('data-active', 'true');
    await expect(snareStep1).toHaveAttribute('aria-pressed', 'true');
    await expect(snareStep1).toHaveClass(classTokenRegex('active'));
    expect(await getVisualSignature(snareStep1)).toEqual(activeBaselineSig);
    await expect(snareStep2).toHaveAttribute('data-active', 'false');

    await kickStep0.click();
    await expect(kickStep0).toHaveAttribute('data-active', 'false');
    await expect(kickStep0).toHaveAttribute('aria-pressed', 'false');
    await expect(kickStep0).not.toHaveClass(classTokenRegex('active'));
    expect(await getVisualSignature(kickStep0)).toEqual(inactiveBaselineSig);
  });

  test('REQ-005_highlights_current_completed_and_upcoming_steps_with_distinct_styles_aria_current_and_icons_across_playback_and_looping', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    const app = page.getByTestId('beatbox-app');
    const playButton = page.getByTestId('transport-play');

    await playButton.click();
    await expect(app).toHaveAttribute('data-playing', 'true');
    await expect(app).toHaveAttribute('data-current-step', '0');

    // At downbeat t = 0ms (step 0): step 0 is "current", steps 1..15 are "upcoming", 0 steps are "completed"
    await expect(page.getByTestId('step-indicator-0')).toHaveAttribute('data-current', 'true');
    await expect(page.getByTestId('step-indicator-0')).toHaveAttribute('data-step-state', 'current');
    await assertAriaCurrentState(page.getByTestId('step-indicator-0'), true);
    await assertStepProgressionClasses(
      page.getByTestId('step-indicator-0'),
      'step-indicator',
      'current',
    );
    await expect(page.getByTestId('step-indicator-icon-0')).toHaveAttribute(
      'data-icon-state',
      'current',
    );

    for (let stepIndex = 1; stepIndex < TOTAL_STEPS; stepIndex++) {
      const indicator = page.getByTestId(`step-indicator-${stepIndex}`);
      await expect(indicator).toHaveAttribute('data-current', 'false');
      await expect(indicator).toHaveAttribute('data-step-state', 'upcoming');
      await assertAriaCurrentState(indicator, false);
    }

    // Advance 5 ticks (625ms) to mid-bar step 5 -> 0..4 completed, 5 current, 6..15 upcoming
    await page.clock.runFor(STEP_INTERVAL_MS * 5);
    await expect(app).toHaveAttribute('data-current-step', '5');

    for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
      const expectedState: StepProgressionState =
        stepIndex < 5 ? 'completed' : stepIndex === 5 ? 'current' : 'upcoming';
      const isCurrent = stepIndex === 5;

      const indicator = page.getByTestId(`step-indicator-${stepIndex}`);
      const icon = page.getByTestId(`step-indicator-icon-${stepIndex}`);
      await expect(indicator).toHaveAttribute('data-current', String(isCurrent));
      await expect(indicator).toHaveAttribute('data-step-state', expectedState);
      await assertAriaCurrentState(indicator, isCurrent);
      await assertStepProgressionClasses(indicator, 'step-indicator', expectedState);
      await expect(icon).toHaveAttribute('aria-hidden', 'true');
      await expect(icon).toHaveAttribute('data-icon-state', expectedState);

      for (const instrumentId of SEEDED_INSTRUMENT_IDS) {
        const cell = page.getByTestId(`step-${instrumentId}-${stepIndex}`);
        await expect(cell).toHaveAttribute('data-current', String(isCurrent));
        await expect(cell).toHaveAttribute('data-step-state', expectedState);
        await assertAriaCurrentState(cell, isCurrent);
        await assertStepProgressionClasses(cell, 'step-cell', expectedState);
      }
    }

    // Verify completed, current, and upcoming icons render distinct SVG shapes
    const completedIconMarkup = await page
      .getByTestId('step-indicator-icon-2')
      .evaluate((el) => el.innerHTML.trim());
    const currentIconMarkup = await page
      .getByTestId('step-indicator-icon-5')
      .evaluate((el) => el.innerHTML.trim());
    const upcomingIconMarkup = await page
      .getByTestId('step-indicator-icon-9')
      .evaluate((el) => el.innerHTML.trim());

    expect(completedIconMarkup.length).toBeGreaterThan(0);
    expect(currentIconMarkup.length).toBeGreaterThan(0);
    expect(upcomingIconMarkup.length).toBeGreaterThan(0);
    expect(new Set([completedIconMarkup, currentIconMarkup, upcomingIconMarkup]).size).toBe(3);

    // Verify completed, current, and upcoming indicators have pairwise-distinct computed styles
    assertPairwiseDistinctSignatures([
      {
        label: 'completed indicator (step 2)',
        signature: await getVisualSignature(page.getByTestId('step-indicator-2')),
      },
      {
        label: 'current indicator (step 5)',
        signature: await getVisualSignature(page.getByTestId('step-indicator-5')),
      },
      {
        label: 'upcoming indicator (step 9)',
        signature: await getVisualSignature(page.getByTestId('step-indicator-9')),
      },
    ]);

    // Verify completed, current, and upcoming inactive step cells on the same track have pairwise-distinct computed styles
    assertPairwiseDistinctSignatures([
      {
        label: 'completed inactive cell (snare step 2)',
        signature: await getVisualSignature(page.getByTestId('step-snare-2')),
      },
      {
        label: 'current inactive cell (snare step 5)',
        signature: await getVisualSignature(page.getByTestId('step-snare-5')),
      },
      {
        label: 'upcoming inactive cell (snare step 9)',
        signature: await getVisualSignature(page.getByTestId('step-snare-9')),
      },
    ]);

    // Advance to final step 15 -> steps 0..14 completed, step 15 current
    await page.clock.runFor(STEP_INTERVAL_MS * 10);
    await expect(app).toHaveAttribute('data-current-step', '15');
    await expect(page.getByTestId('step-indicator-14')).toHaveAttribute(
      'data-step-state',
      'completed',
    );
    await expect(page.getByTestId('step-indicator-15')).toHaveAttribute(
      'data-step-state',
      'current',
    );
    await assertAriaCurrentState(page.getByTestId('step-indicator-15'), true);

    // Wrap around 15 -> 0: step 0 becomes current and steps 1..15 reset from completed back to upcoming
    await page.clock.runFor(STEP_INTERVAL_MS);
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect(page.getByTestId('step-indicator-0')).toHaveAttribute('data-step-state', 'current');
    await assertAriaCurrentState(page.getByTestId('step-indicator-0'), true);

    for (let stepIndex = 1; stepIndex < TOTAL_STEPS; stepIndex++) {
      await expect(page.getByTestId(`step-indicator-${stepIndex}`)).toHaveAttribute(
        'data-step-state',
        'upcoming',
      );
      await expect(page.getByTestId(`step-kick-${stepIndex}`)).toHaveAttribute(
        'data-step-state',
        'upcoming',
      );
      await assertAriaCurrentState(page.getByTestId(`step-kick-${stepIndex}`), false);
    }

    // Stopping playback clears all current highlights and aria-current attributes across indicators and cells
    await stopPlaybackIfRunning(page);
    await expect(app).toHaveAttribute('data-playing', 'false');

    for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
      const indicator = page.getByTestId(`step-indicator-${stepIndex}`);
      await expect(indicator).toHaveAttribute('data-current', 'false');
      await expect(indicator).toHaveAttribute('data-step-state', 'upcoming');
      await assertAriaCurrentState(indicator, false);

      const kickCell = page.getByTestId(`step-kick-${stepIndex}`);
      await expect(kickCell).toHaveAttribute('data-current', 'false');
      await expect(kickCell).toHaveAttribute('data-step-state', 'upcoming');
      await assertAriaCurrentState(kickCell, false);
    }
  });

  test('REQ-005_distinguishes_simultaneously_active_and_current_steps_and_updates_visual_feedback_when_toggled_live', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    await page.getByTestId('transport-play').click();
    await expect(page.getByTestId('beatbox-app')).toHaveAttribute('data-current-step', '0');

    const kickStep0ActiveCurrent = page.getByTestId('step-kick-0'); // active + current
    const snareStep0InactiveCurrent = page.getByTestId('step-snare-0'); // inactive + current
    const kickStep4ActiveUpcoming = page.getByTestId('step-kick-4'); // active + upcoming
    const snareStep1InactiveUpcoming = page.getByTestId('step-snare-1'); // inactive + upcoming

    await expect(kickStep0ActiveCurrent).toHaveClass(classTokenRegex('active'));
    await expect(kickStep0ActiveCurrent).toHaveClass(classTokenRegex('current'));
    await expect(kickStep0ActiveCurrent).toHaveAttribute('aria-pressed', 'true');
    await assertAriaCurrentState(kickStep0ActiveCurrent, true);

    assertPairwiseDistinctSignatures([
      {
        label: 'active + current (kick step 0)',
        signature: await getVisualSignature(kickStep0ActiveCurrent),
      },
      {
        label: 'inactive + current (snare step 0)',
        signature: await getVisualSignature(snareStep0InactiveCurrent),
      },
      {
        label: 'active + upcoming (kick step 4)',
        signature: await getVisualSignature(kickStep4ActiveUpcoming),
      },
      {
        label: 'inactive + upcoming (snare step 1)',
        signature: await getVisualSignature(snareStep1InactiveUpcoming),
      },
    ]);

    // Advance to step 4 -> kickStep0 is now active + completed, while step 4 has active (kick/snare/hihat) and inactive (clap)
    await page.clock.runFor(STEP_INTERVAL_MS * 4);
    await expect(page.getByTestId('beatbox-app')).toHaveAttribute('data-current-step', '4');

    await expect(kickStep0ActiveCurrent).toHaveAttribute('data-active', 'true');
    await expect(kickStep0ActiveCurrent).toHaveAttribute('data-current', 'false');
    await expect(kickStep0ActiveCurrent).toHaveAttribute('data-step-state', 'completed');
    await expect(kickStep0ActiveCurrent).toHaveClass(classTokenRegex('active'));
    await expect(kickStep0ActiveCurrent).toHaveClass(classTokenRegex('completed'));

    const clapStep4 = page.getByTestId('step-clap-4');
    const snareStep4 = page.getByTestId('step-snare-4');
    const activeCurrentBaselineSig = await getVisualSignature(snareStep4);
    const inactiveCurrentBaselineSig = await getVisualSignature(clapStep4);

    // Live-toggle clap step 4 ON while the playhead is actively highlighting step 4
    await clapStep4.click();
    await expect(clapStep4).toHaveAttribute('data-active', 'true');
    await expect(clapStep4).toHaveAttribute('aria-pressed', 'true');
    await expect(clapStep4).toHaveAttribute('data-current', 'true');
    await assertAriaCurrentState(clapStep4, true);
    await expect(clapStep4).toHaveClass(classTokenRegex('active'));
    await expect(clapStep4).toHaveClass(classTokenRegex('current'));
    expect(await getVisualSignature(clapStep4)).toEqual(activeCurrentBaselineSig);

    // Live-toggle snare step 4 OFF while the playhead is still on step 4 -> retains current highlight, drops active
    await snareStep4.click();
    await expect(snareStep4).toHaveAttribute('data-active', 'false');
    await expect(snareStep4).toHaveAttribute('aria-pressed', 'false');
    await expect(snareStep4).toHaveAttribute('data-current', 'true');
    await assertAriaCurrentState(snareStep4, true);
    await expect(snareStep4).not.toHaveClass(classTokenRegex('active'));
    await expect(snareStep4).toHaveClass(classTokenRegex('current'));
    expect(await getVisualSignature(snareStep4)).toEqual(inactiveCurrentBaselineSig);
  });

  test('REQ-005_maintains_keyboard_focus_and_applies_distinct_focus_styles_across_step_navigation_and_keyboard_toggling', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    const kickStep0 = page.getByTestId('step-kick-0');
    const kickStep1 = page.getByTestId('step-kick-1');
    const kickStep3 = page.getByTestId('step-kick-3');
    const kickStep15 = page.getByTestId('step-kick-15');

    const unfocusedKickStep1Sig = await getFocusSignature(kickStep1);

    // Enter keyboard modality on kick step 0, then Tab to kick step 1 and verify focus ring visibility
    await kickStep0.focus();
    await expect(kickStep0).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(kickStep1).toBeFocused();

    const focusedKickStep1Sig = await getFocusSignature(kickStep1);
    expect(focusedKickStep1Sig).not.toEqual(unfocusedKickStep1Sig);
    const hasVisibleFocusRing =
      (focusedKickStep1Sig.outlineStyle !== 'none' &&
        focusedKickStep1Sig.outlineWidth !== '0px') ||
      focusedKickStep1Sig.boxShadow !== unfocusedKickStep1Sig.boxShadow ||
      focusedKickStep1Sig.borderTopColor !== unfocusedKickStep1Sig.borderTopColor;
    expect(hasVisibleFocusRing).toBe(true);

    // Shift+Tab returns focus to kick step 0
    await page.keyboard.press('Shift+Tab');
    await expect(kickStep0).toBeFocused();

    // Horizontal arrow, End, wrap-around, and Home navigation within the Kick row
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(kickStep3).toBeFocused();

    await page.keyboard.press('End');
    await expect(kickStep15).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(kickStep0).toBeFocused();

    await page.keyboard.press('ArrowLeft');
    await expect(kickStep15).toBeFocused();

    await page.keyboard.press('Home');
    await expect(kickStep0).toBeFocused();

    // Move to column 2 and navigate vertically across instrument tracks with ArrowDown / ArrowUp
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('step-kick-2')).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('step-snare-2')).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('step-hihat-closed-2')).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('step-clap-2')).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('step-kick-2')).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('step-clap-2')).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    const snareStep2 = page.getByTestId('step-snare-2');
    await expect(snareStep2).toBeFocused();

    // Space and Enter toggle active state while keeping keyboard focus anchored on the step button
    await expect(snareStep2).toHaveAttribute('data-active', 'false');
    await page.keyboard.press('Space');
    await expect(snareStep2).toHaveAttribute('data-active', 'true');
    await expect(snareStep2).toHaveAttribute('aria-pressed', 'true');
    await expect(snareStep2).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(snareStep2).toHaveAttribute('data-active', 'false');
    await expect(snareStep2).toHaveAttribute('aria-pressed', 'false');
    await expect(snareStep2).toBeFocused();
  });

  test('REQ-005_preserves_keyboard_focus_on_step_cells_while_sequencer_playhead_advances_and_loops', async ({
    page,
  }) => {
    await mountBeatboxWithPausedClock(page);

    const app = page.getByTestId('beatbox-app');
    const snareStep3 = page.getByTestId('step-snare-3');
    const snareStep4 = page.getByTestId('step-snare-4');

    await page.getByTestId('transport-play').click();
    await expect(app).toHaveAttribute('data-playing', 'true');
    await expect(app).toHaveAttribute('data-current-step', '0');

    // Focus upcoming snare step 3 while playback is running at step 0
    await snareStep3.focus();
    await expect(snareStep3).toBeFocused();
    await expect(snareStep3).toHaveAttribute('data-step-state', 'upcoming');

    // Advance to step 2 (still upcoming) -> focus stays on snare step 3
    await page.clock.runFor(STEP_INTERVAL_MS * 2);
    await expect(app).toHaveAttribute('data-current-step', '2');
    await expect(snareStep3).toHaveAttribute('data-step-state', 'upcoming');
    await expect(snareStep3).toBeFocused();

    // Advance onto step 3 -> snare step 3 becomes current (aria-current="step") and retains focus
    await page.clock.runFor(STEP_INTERVAL_MS);
    await expect(app).toHaveAttribute('data-current-step', '3');
    await expect(snareStep3).toHaveAttribute('data-current', 'true');
    await expect(snareStep3).toHaveAttribute('data-step-state', 'current');
    await assertAriaCurrentState(snareStep3, true);
    await expect(snareStep3).toBeFocused();

    // Toggle snare step 3 via Space while it is the active current step -> retains focus
    await page.keyboard.press('Space');
    await expect(snareStep3).toHaveAttribute('data-active', 'true');
    await expect(snareStep3).toBeFocused();

    // Advance past step 3 -> snare step 3 transitions to completed and still retains focus
    await page.clock.runFor(STEP_INTERVAL_MS);
    await expect(app).toHaveAttribute('data-current-step', '4');
    await expect(snareStep3).toHaveAttribute('data-current', 'false');
    await expect(snareStep3).toHaveAttribute('data-step-state', 'completed');
    await assertAriaCurrentState(snareStep3, false);
    await expect(snareStep3).toBeFocused();

    // Navigate via ArrowRight while playing and sweep across the 15 -> 0 loop boundary
    await page.keyboard.press('ArrowRight');
    await expect(snareStep4).toBeFocused();

    await page.clock.runFor(STEP_INTERVAL_MS * 12); // step 4 + 12 ticks = step 0 of next bar
    await expect(app).toHaveAttribute('data-current-step', '0');
    await expect(snareStep4).toHaveAttribute('data-step-state', 'upcoming');
    await expect(snareStep4).toBeFocused();
  });
});
