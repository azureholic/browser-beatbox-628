import {
  DEFAULT_DEMO_PATTERN,
  TOTAL_STEPS,
  type BeatboxPattern,
  type InstrumentTrack,
} from '../data/demoPattern.ts';

export { TOTAL_STEPS };

export const STEPS_PER_BEAT = 4;
export const MS_PER_MINUTE = 60_000;

export interface SequencerTimer {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimer: SequencerTimer = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

export interface SequencerSnapshot {
  readonly isPlaying: boolean;
  readonly currentStep: number;
  readonly bpm: number;
  readonly stepCount: number;
  readonly stepIntervalMs: number;
  readonly pattern: BeatboxPattern;
}

export interface SequencerOptions {
  readonly initialPattern?: BeatboxPattern;
  readonly stepCount?: number;
  readonly timer?: SequencerTimer;
  readonly onStep?: (stepIndex: number, activeInstrumentIds: string[]) => void;
}

export function calculateStepIntervalMs(
  bpm: number,
  stepsPerBeat: number = STEPS_PER_BEAT,
): number {
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new RangeError('BPM must be a positive finite number.');
  }
  if (!Number.isFinite(stepsPerBeat) || stepsPerBeat <= 0) {
    throw new RangeError('Steps per beat must be a positive finite number.');
  }
  return MS_PER_MINUTE / (bpm * stepsPerBeat);
}

export function getNextStepIndex(
  currentStep: number,
  stepCount: number = TOTAL_STEPS,
): number {
  if (!Number.isInteger(stepCount) || stepCount <= 0) {
    throw new RangeError('Step count must be a positive integer.');
  }
  if (!Number.isInteger(currentStep) || currentStep < 0 || currentStep >= stepCount) {
    throw new RangeError(`Current step must be an integer in [0, ${stepCount - 1}].`);
  }
  return (currentStep + 1) % stepCount;
}

export function normalizePattern(
  pattern: BeatboxPattern,
  stepCount: number = TOTAL_STEPS,
): BeatboxPattern {
  if (!Number.isInteger(stepCount) || stepCount <= 0) {
    throw new RangeError('Step count must be a positive integer.');
  }
  return {
    ...pattern,
    stepCount,
    instruments: pattern.instruments.map((instrument) => ({
      ...instrument,
      steps: Array.from({ length: stepCount }, (_, index) => Boolean(instrument.steps[index])),
    })),
  };
}

export function toggleInstrumentStep(
  instruments: readonly InstrumentTrack[],
  instrumentId: string,
  stepIndex: number,
  stepCount: number = TOTAL_STEPS,
): InstrumentTrack[] {
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= stepCount) {
    throw new RangeError(`Step index must be an integer in [0, ${stepCount - 1}].`);
  }

  let found = false;
  const updated = instruments.map((instrument) => {
    if (instrument.id !== instrumentId) {
      return instrument;
    }
    found = true;
    const nextSteps = [...instrument.steps];
    nextSteps[stepIndex] = !nextSteps[stepIndex];
    return {
      ...instrument,
      steps: nextSteps,
    };
  });

  if (!found) {
    throw new RangeError(`Unknown instrument "${instrumentId}".`);
  }

  return updated;
}

export class Sequencer {
  readonly #timer: SequencerTimer;
  readonly #onStep?: (stepIndex: number, activeInstrumentIds: string[]) => void;
  readonly #listeners = new Set<() => void>();
  #intervalHandle: unknown = null;
  #snapshot: SequencerSnapshot;

  constructor(options: SequencerOptions = {}) {
    const basePattern = options.initialPattern ?? DEFAULT_DEMO_PATTERN;
    const stepCount = options.stepCount ?? TOTAL_STEPS;
    const normalizedPattern = normalizePattern(basePattern, stepCount);
    const stepIntervalMs = calculateStepIntervalMs(normalizedPattern.bpm);

    this.#timer = options.timer ?? defaultTimer;
    this.#onStep = options.onStep;
    this.#snapshot = {
      isPlaying: false,
      currentStep: 0,
      bpm: normalizedPattern.bpm,
      stepCount,
      stepIntervalMs,
      pattern: normalizedPattern,
    };
  }

  get currentStep(): number {
    return this.#snapshot.currentStep;
  }

  get isPlaying(): boolean {
    return this.#snapshot.isPlaying;
  }

  get bpm(): number {
    return this.#snapshot.bpm;
  }

  get stepCount(): number {
    return this.#snapshot.stepCount;
  }

  get stepIntervalMs(): number {
    return this.#snapshot.stepIntervalMs;
  }

  get pattern(): BeatboxPattern {
    return this.#snapshot.pattern;
  }

  get instruments(): readonly InstrumentTrack[] {
    return this.#snapshot.pattern.instruments;
  }

  getSnapshot(): SequencerSnapshot {
    return this.#snapshot;
  }

  isStepActive(instrumentId: string, stepIndex: number): boolean {
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= this.#snapshot.stepCount) {
      throw new RangeError(
        `Step index must be an integer in [0, ${this.#snapshot.stepCount - 1}].`,
      );
    }
    const track = this.#snapshot.pattern.instruments.find((item) => item.id === instrumentId);
    if (!track) {
      throw new RangeError(`Unknown instrument "${instrumentId}".`);
    }
    return Boolean(track.steps[stepIndex]);
  }

  getActiveInstrumentIds(stepIndex: number = this.#snapshot.currentStep): string[] {
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= this.#snapshot.stepCount) {
      throw new RangeError(
        `Step index must be an integer in [0, ${this.#snapshot.stepCount - 1}].`,
      );
    }
    return this.#snapshot.pattern.instruments
      .filter((instrument) => Boolean(instrument.steps[stepIndex]))
      .map((instrument) => instrument.id);
  }

  play(): void {
    if (this.#snapshot.isPlaying) {
      return;
    }

    this.#clearTimer();
    this.#snapshot = {
      ...this.#snapshot,
      isPlaying: true,
      currentStep: 0,
    };
    this.#intervalHandle = this.#timer.setInterval(() => {
      this.advanceStep();
    }, this.#snapshot.stepIntervalMs);

    this.#notifyListeners();
    this.#onStep?.(0, this.getActiveInstrumentIds(0));
  }

  stop(): void {
    this.#clearTimer();
    if (!this.#snapshot.isPlaying && this.#snapshot.currentStep === 0) {
      return;
    }

    this.#snapshot = {
      ...this.#snapshot,
      isPlaying: false,
      currentStep: 0,
    };
    this.#notifyListeners();
  }

  advanceStep(): number {
    const nextStep = getNextStepIndex(this.#snapshot.currentStep, this.#snapshot.stepCount);
    this.#snapshot = {
      ...this.#snapshot,
      currentStep: nextStep,
    };
    this.#notifyListeners();
    this.#onStep?.(nextStep, this.getActiveInstrumentIds(nextStep));
    return nextStep;
  }

  toggleStep(instrumentId: string, stepIndex: number): boolean {
    const updatedInstruments = toggleInstrumentStep(
      this.#snapshot.pattern.instruments,
      instrumentId,
      stepIndex,
      this.#snapshot.stepCount,
    );
    this.#snapshot = {
      ...this.#snapshot,
      pattern: {
        ...this.#snapshot.pattern,
        instruments: updatedInstruments,
      },
    };
    this.#notifyListeners();
    return this.isStepActive(instrumentId, stepIndex);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #clearTimer(): void {
    if (this.#intervalHandle !== null) {
      this.#timer.clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }
  }

  #notifyListeners(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
