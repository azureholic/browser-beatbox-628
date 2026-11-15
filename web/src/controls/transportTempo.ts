import {
  clampBpm,
  DEFAULT_BPM,
  MAX_BPM,
  MIN_BPM,
  type TransportState,
} from '../sequencer/sequencer.ts';

export { clampBpm, DEFAULT_BPM, MAX_BPM, MIN_BPM, type TransportState };

export interface TempoChangeEvaluation {
  readonly draftValue: string;
  readonly immediateBpm: number | null;
}

export interface TempoCommitResult {
  readonly bpm: number;
  readonly normalizedValue: string;
}

export interface TransportControlTarget {
  readonly transportState: TransportState;
  readonly isPlaying: boolean;
  readonly currentStep: number;
  readonly bpm: number;
  play(): void;
  pause(): void;
  stop(): void;
  seek(stepIndex: number): number;
  setBpm(bpm: number): number;
}

export interface TransportControllerOptions {
  readonly onResumeAudio?: () => void | Promise<void>;
}

export function evaluateTempoInputChange(rawValue: string): TempoChangeEvaluation {
  const trimmed = rawValue.trim();
  if (trimmed === '') {
    return { draftValue: rawValue, immediateBpm: null };
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return { draftValue: rawValue, immediateBpm: null };
  }

  const rounded = Math.round(parsed);
  if (rounded >= MIN_BPM && rounded <= MAX_BPM) {
    return { draftValue: rawValue, immediateBpm: rounded };
  }

  return { draftValue: rawValue, immediateBpm: null };
}

export function resolveCommittedTempoInput(
  rawValue: string,
  activeBpm: number,
): TempoCommitResult {
  const fallbackBpm = clampBpm(activeBpm);
  const trimmed = rawValue.trim();
  if (trimmed === '') {
    return {
      bpm: fallbackBpm,
      normalizedValue: String(fallbackBpm),
    };
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return {
      bpm: fallbackBpm,
      normalizedValue: String(fallbackBpm),
    };
  }

  const clamped = clampBpm(parsed);
  return {
    bpm: clamped,
    normalizedValue: String(clamped),
  };
}

export function formatTempoDisplay(bpm: number): string {
  return `${clampBpm(bpm)} BPM`;
}

export class TransportTempoController {
  readonly #target: TransportControlTarget;
  readonly #onResumeAudio?: () => void | Promise<void>;
  #tempoInputValue: string;

  constructor(target: TransportControlTarget, options: TransportControllerOptions = {}) {
    this.#target = target;
    this.#onResumeAudio = options.onResumeAudio;
    this.#tempoInputValue = String(target.bpm);
  }

  get transportState(): TransportState {
    return this.#target.transportState;
  }

  get isPlaying(): boolean {
    return this.#target.isPlaying;
  }

  get currentStep(): number {
    return this.#target.currentStep;
  }

  get bpm(): number {
    return this.#target.bpm;
  }

  get tempoInputValue(): string {
    return this.#tempoInputValue;
  }

  get tempoDisplayText(): string {
    return formatTempoDisplay(this.#target.bpm);
  }

  play(): void {
    if (this.#target.transportState !== 'playing') {
      void this.#onResumeAudio?.();
    }
    this.#target.play();
  }

  pause(): void {
    this.#target.pause();
  }

  stop(): void {
    this.#target.stop();
  }

  seek(stepIndex: number): number {
    return this.#target.seek(stepIndex);
  }

  handleTempoInputChange(rawValue: string): TempoChangeEvaluation {
    const evaluation = evaluateTempoInputChange(rawValue);
    this.#tempoInputValue = evaluation.draftValue;
    if (evaluation.immediateBpm !== null) {
      this.#target.setBpm(evaluation.immediateBpm);
    }
    return evaluation;
  }

  handleTempoCommit(rawValue: string = this.#tempoInputValue): TempoCommitResult {
    const committed = resolveCommittedTempoInput(rawValue, this.#target.bpm);
    this.#target.setBpm(committed.bpm);
    this.#tempoInputValue = committed.normalizedValue;
    return committed;
  }

  handleTempoKeyDown(key: string, rawValue?: string): boolean {
    if (key !== 'Enter') {
      return false;
    }
    this.handleTempoCommit(rawValue ?? this.#tempoInputValue);
    return true;
  }

  handleTempoSliderChange(rawValue: string): TempoCommitResult {
    return this.handleTempoCommit(rawValue);
  }
}
