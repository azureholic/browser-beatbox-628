import {
  DEFAULT_DEMO_PATTERN,
  TOTAL_STEPS,
  type BeatboxPattern,
  type InstrumentTrack,
} from '../data/demoPattern.ts';

export { TOTAL_STEPS };

export const STEPS_PER_BEAT = 4;
export const MS_PER_MINUTE = 60_000;
export const DEFAULT_BPM = 120;
export const MIN_BPM = 40;
export const MAX_BPM = 250;

export type TransportState = 'stopped' | 'playing' | 'paused';

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
  readonly transportState: TransportState;
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

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) {
    throw new RangeError('BPM must be a finite number.');
  }
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
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
  const normalizedBpm = clampBpm(pattern.bpm);
  return {
    ...pattern,
    bpm: normalizedBpm,
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
  #timerGeneration = 0;
  #snapshot: SequencerSnapshot;

  constructor(options: SequencerOptions = {}) {
    const basePattern = options.initialPattern ?? DEFAULT_DEMO_PATTERN;
    const stepCount = options.stepCount ?? TOTAL_STEPS;
    const normalizedPattern = normalizePattern(basePattern, stepCount);
    const stepIntervalMs = calculateStepIntervalMs(normalizedPattern.bpm);

    this.#timer = options.timer ?? defaultTimer;
    this.#onStep = options.onStep;
    this.#snapshot = {
      transportState: 'stopped',
      isPlaying: false,
      currentStep: 0,
      bpm: normalizedPattern.bpm,
      stepCount,
      stepIntervalMs,
      pattern: normalizedPattern,
    };
  }

  get transportState(): TransportState {
    return this.#snapshot.transportState;
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
    if (this.#snapshot.transportState === 'playing') {
      return;
    }

    const wasPaused = this.#snapshot.transportState === 'paused';
    const startStep = wasPaused ? this.#snapshot.currentStep : 0;

    this.#clearTimer();
    this.#snapshot = {
      ...this.#snapshot,
      transportState: 'playing',
      isPlaying: true,
      currentStep: startStep,
    };
    this.#startTimer();
    this.#notifyListeners();

    if (!wasPaused && this.#snapshot.transportState === 'playing') {
      this.#onStep?.(0, this.getActiveInstrumentIds(0));
    }
  }

  pause(): void {
    if (this.#snapshot.transportState !== 'playing') {
      return;
    }

    this.#clearTimer();
    this.#snapshot = {
      ...this.#snapshot,
      transportState: 'paused',
      isPlaying: false,
    };
    this.#notifyListeners();
  }

  stop(): void {
    this.#clearTimer();
    if (this.#snapshot.transportState === 'stopped' && this.#snapshot.currentStep === 0) {
      return;
    }

    this.#snapshot = {
      ...this.#snapshot,
      transportState: 'stopped',
      isPlaying: false,
      currentStep: 0,
    };
    this.#notifyListeners();
  }

  seek(stepIndex: number): number {
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= this.#snapshot.stepCount) {
      throw new RangeError(
        `Step index must be an integer in [0, ${this.#snapshot.stepCount - 1}].`,
      );
    }

    if (this.#snapshot.transportState === 'playing') {
      this.#clearTimer();
      this.#snapshot = {
        ...this.#snapshot,
        currentStep: stepIndex,
      };
      this.#startTimer();
      this.#notifyListeners();
      if (this.#snapshot.transportState === 'playing') {
        this.#onStep?.(stepIndex, this.getActiveInstrumentIds(stepIndex));
      }
      return stepIndex;
    }

    const nextTransportState: TransportState =
      this.#snapshot.transportState === 'stopped' && stepIndex === 0 ? 'stopped' : 'paused';

    if (
      this.#snapshot.currentStep === stepIndex &&
      this.#snapshot.transportState === nextTransportState
    ) {
      return stepIndex;
    }

    this.#snapshot = {
      ...this.#snapshot,
      transportState: nextTransportState,
      isPlaying: false,
      currentStep: stepIndex,
    };
    this.#notifyListeners();
    return stepIndex;
  }

  setBpm(bpm: number): number {
    const clampedBpm = clampBpm(bpm);
    if (clampedBpm === this.#snapshot.bpm) {
      return clampedBpm;
    }

    const nextStepIntervalMs = calculateStepIntervalMs(clampedBpm);
    this.#snapshot = {
      ...this.#snapshot,
      bpm: clampedBpm,
      stepIntervalMs: nextStepIntervalMs,
      pattern: {
        ...this.#snapshot.pattern,
        bpm: clampedBpm,
      },
    };

    if (this.#snapshot.transportState === 'playing') {
      this.#clearTimer();
      this.#startTimer();
    }

    this.#notifyListeners();
    return clampedBpm;
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

  #startTimer(): void {
    const generation = ++this.#timerGeneration;
    this.#intervalHandle = this.#timer.setInterval(() => {
      if (this.#snapshot.transportState !== 'playing' || this.#timerGeneration !== generation) {
        return;
      }
      this.advanceStep();
    }, this.#snapshot.stepIntervalMs);
  }

  #clearTimer(): void {
    this.#timerGeneration++;
    if (this.#intervalHandle !== null) {
      const handle = this.#intervalHandle;
      this.#intervalHandle = null;
      this.#timer.clearInterval(handle);
    }
  }

  #notifyListeners(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
