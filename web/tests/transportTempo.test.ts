import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AudioEngine,
  DEFAULT_DRUM_SAMPLES,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextLike,
  type AudioParamLike,
  type FetchLike,
  type GainNodeLike,
} from '../src/audio/index.ts';
import {
  clampBpm,
  DEFAULT_BPM,
  evaluateTempoInputChange,
  formatTempoDisplay,
  MAX_BPM,
  MIN_BPM,
  resolveCommittedTempoInput,
  TransportTempoController,
} from '../src/controls/transportTempo.ts';
import {
  calculateStepIntervalMs,
  Sequencer,
  TOTAL_STEPS,
  type SequencerTimer,
} from '../src/sequencer/sequencer.ts';

class ManualFakeTimer implements SequencerTimer {
  #nextId = 1;
  readonly #tasks = new Map<
    number,
    { callback: () => void; intervalMs: number; nextFireAtMs: number }
  >();
  #nowMs = 0;

  get activeTimerCount(): number {
    return this.#tasks.size;
  }

  setInterval(callback: () => void, delayMs: number): unknown {
    const id = this.#nextId++;
    this.#tasks.set(id, {
      callback,
      intervalMs: delayMs,
      nextFireAtMs: this.#nowMs + delayMs,
    });
    return id;
  }

  clearInterval(handle: unknown): void {
    if (typeof handle === 'number') {
      this.#tasks.delete(handle);
    }
  }

  advanceBy(deltaMs: number): void {
    const targetMs = this.#nowMs + deltaMs;
    while (true) {
      let earliestId: number | null = null;
      let earliestFireMs = Number.POSITIVE_INFINITY;

      for (const [id, task] of this.#tasks) {
        if (task.nextFireAtMs <= targetMs && task.nextFireAtMs < earliestFireMs) {
          earliestId = id;
          earliestFireMs = task.nextFireAtMs;
        }
      }

      if (earliestId === null) {
        break;
      }

      const task = this.#tasks.get(earliestId);
      if (!task) {
        continue;
      }

      this.#nowMs = earliestFireMs;
      task.nextFireAtMs += task.intervalMs;
      task.callback();
    }

    this.#nowMs = targetMs;
  }
}

interface MockBuffer extends AudioBufferLike {
  readonly soundId: string;
}

class MockNode {
  connect(destination: MockNode): MockNode {
    return destination;
  }
  disconnect(): void {}
}

class MockGain extends MockNode implements GainNodeLike<MockNode> {
  readonly gain: AudioParamLike = {
    value: 1,
    setValueAtTime(next: number) {
      this.value = next;
    },
  };
}

function createDeterministicTestAudioHarness() {
  const triggeredSounds: string[] = [];
  let resumeCalls = 0;
  let state: AudioContextState = 'suspended';
  const soundIdByBuffer = new WeakMap<ArrayBuffer, string>();

  const fetchImpl: FetchLike = async (url: string) => {
    const soundId = url.split('/').pop()?.replace(/\.[^/.]+$/, '') ?? 'unknown';
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    soundIdByBuffer.set(bytes, soundId);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes,
    } as Response;
  };

  const context: AudioContextLike<MockNode, MockBuffer> = {
    get state() {
      return state;
    },
    currentTime: 0,
    destination: new MockNode(),
    createGain: () => new MockGain(),
    createBufferSource: (): AudioBufferSourceNodeLike<MockNode, MockBuffer> => {
      let assignedBuffer: MockBuffer | null = null;
      return {
        get buffer() {
          return assignedBuffer;
        },
        set buffer(value: MockBuffer | null) {
          assignedBuffer = value;
        },
        connect: (dest) => dest,
        disconnect: () => {},
        start: () => {
          triggeredSounds.push(assignedBuffer?.soundId ?? 'unknown');
        },
        stop: () => {},
      };
    },
    decodeAudioData: async (audioData: ArrayBuffer): Promise<MockBuffer> => ({
      soundId: soundIdByBuffer.get(audioData) ?? 'unknown',
      duration: 0.1,
      length: 4410,
      sampleRate: 44100,
      numberOfChannels: 1,
    }),
    resume: async () => {
      resumeCalls++;
      state = 'running';
    },
    suspend: async () => {
      state = 'suspended';
    },
  };

  const engine = new AudioEngine<MockNode, MockBuffer>({
    createAudioContext: () => context,
    fetchImpl,
  });

  return {
    engine,
    triggeredSounds,
    get resumeCalls() {
      return resumeCalls;
    },
    clearTriggers() {
      triggeredSounds.length = 0;
    },
  };
}

describe('Transport and Tempo Controls — Unit Tests (REQ-004)', () => {
  it('validates and clamps BPM values within [40, 250]', () => {
    assert.equal(DEFAULT_BPM, 120);
    assert.equal(MIN_BPM, 40);
    assert.equal(MAX_BPM, 250);

    assert.equal(clampBpm(40), 40);
    assert.equal(clampBpm(120), 120);
    assert.equal(clampBpm(250), 250);
    assert.equal(clampBpm(0), 40);
    assert.equal(clampBpm(-25), 40);
    assert.equal(clampBpm(39.4), 40);
    assert.equal(clampBpm(250.6), 250);
    assert.equal(clampBpm(999), 250);
    assert.equal(formatTempoDisplay(120), '120 BPM');
  });

  it('evaluates live tempo input changes immediately when in-range and defers clamping until commit', () => {
    // In-range integer and float inputs update BPM immediately
    assert.deepEqual(evaluateTempoInputChange('40'), { draftValue: '40', immediateBpm: 40 });
    assert.deepEqual(evaluateTempoInputChange('200'), { draftValue: '200', immediateBpm: 200 });
    assert.deepEqual(evaluateTempoInputChange('250'), { draftValue: '250', immediateBpm: 250 });
    assert.deepEqual(evaluateTempoInputChange('128.6'), {
      draftValue: '128.6',
      immediateBpm: 129,
    });

    // Partial/out-of-range/empty inputs preserve user draft during typing without premature clamping
    assert.deepEqual(evaluateTempoInputChange('2'), { draftValue: '2', immediateBpm: null });
    assert.deepEqual(evaluateTempoInputChange('20'), { draftValue: '20', immediateBpm: null });
    assert.deepEqual(evaluateTempoInputChange('-15'), { draftValue: '-15', immediateBpm: null });
    assert.deepEqual(evaluateTempoInputChange('360'), { draftValue: '360', immediateBpm: null });
    assert.deepEqual(evaluateTempoInputChange(''), { draftValue: '', immediateBpm: null });
    assert.deepEqual(evaluateTempoInputChange('abc'), { draftValue: 'abc', immediateBpm: null });

    // Committing (blur / Enter) clamps out-of-range inputs and restores fallback BPM on empty/invalid input
    assert.deepEqual(resolveCommittedTempoInput('20', 120), { bpm: 40, normalizedValue: '40' });
    assert.deepEqual(resolveCommittedTempoInput('-15', 120), { bpm: 40, normalizedValue: '40' });
    assert.deepEqual(resolveCommittedTempoInput('360', 120), { bpm: 250, normalizedValue: '250' });
    assert.deepEqual(resolveCommittedTempoInput('', 250), { bpm: 250, normalizedValue: '250' });
    assert.deepEqual(resolveCommittedTempoInput('   ', 185), { bpm: 185, normalizedValue: '185' });
    assert.deepEqual(resolveCommittedTempoInput('not-a-number', 95), {
      bpm: 95,
      normalizedValue: '95',
    });
  });

  it('handles controller keyboard Enter commits, slider updates, and idempotent transport actions', () => {
    const timer = new ManualFakeTimer();
    const sequencer = new Sequencer({ timer });
    let resumeCount = 0;
    const controller = new TransportTempoController(sequencer, {
      onResumeAudio: () => {
        resumeCount++;
      },
    });

    assert.equal(controller.transportState, 'stopped');
    assert.equal(controller.tempoInputValue, '120');
    assert.equal(controller.tempoDisplayText, '120 BPM');

    // Play calls onResumeAudio once; clicking Play while already playing is an idempotent no-op
    controller.play();
    assert.equal(resumeCount, 1);
    assert.equal(controller.transportState, 'playing');

    controller.play();
    assert.equal(resumeCount, 1);
    assert.equal(timer.activeTimerCount, 1);

    // Non-Enter keys do not force-commit partial draft
    controller.handleTempoInputChange('20');
    assert.equal(controller.tempoInputValue, '20');
    assert.equal(controller.bpm, 120);
    assert.equal(controller.handleTempoKeyDown('ArrowUp'), false);
    assert.equal(controller.tempoInputValue, '20');

    // Enter key commits and clamps "20" -> "40"
    assert.equal(controller.handleTempoKeyDown('Enter'), true);
    assert.equal(controller.bpm, 40);
    assert.equal(controller.tempoInputValue, '40');
    assert.equal(controller.tempoDisplayText, '40 BPM');

    // Slider change updates both active BPM and normalized input value immediately
    controller.handleTempoSliderChange('175');
    assert.equal(controller.bpm, 175);
    assert.equal(controller.tempoInputValue, '175');
    assert.equal(controller.tempoDisplayText, '175 BPM');
  });
});

describe('Transport and Tempo Controls — Integration Tests (UI Events + Sequencer + Web Audio)', () => {
  it('coordinates play, pause, resume, seek, stop, and real-time tempo updates with synchronized Web Audio triggers', async () => {
    const timer = new ManualFakeTimer();
    const audio = createDeterministicTestAudioHarness();
    await audio.engine.load(Object.keys(DEFAULT_DRUM_SAMPLES));

    const sequencer = new Sequencer({
      timer,
      onStep: (_stepIndex, activeInstrumentIds) => {
        for (const id of activeInstrumentIds) {
          audio.engine.play(id);
        }
      },
    });

    const controller = new TransportTempoController(sequencer, {
      onResumeAudio: () => audio.engine.resume(),
    });

    // 1. Play from stopped -> step 0 triggers seeded kick + hihat-closed immediately
    controller.play();
    assert.equal(controller.transportState, 'playing');
    assert.equal(controller.isPlaying, true);
    assert.equal(controller.currentStep, 0);
    assert.deepEqual([...audio.triggeredSounds].sort(), ['hihat-closed', 'kick']);

    // 2. Advance 2 steps at 120 BPM (125ms/step) to step 2, then speed up live to 200 BPM (75ms/step)
    timer.advanceBy(calculateStepIntervalMs(120) * 2);
    assert.equal(controller.currentStep, 2);

    controller.handleTempoInputChange('200');
    assert.equal(controller.bpm, 200);
    assert.equal(sequencer.stepIntervalMs, 75);
    assert.equal(controller.transportState, 'playing');
    assert.equal(controller.currentStep, 2);

    audio.clearTriggers();
    timer.advanceBy(50); // < 75ms: no step transition yet
    assert.equal(controller.currentStep, 2);
    assert.deepEqual(audio.triggeredSounds, []);

    timer.advanceBy(25); // 75ms total -> step 3 (silent in default pattern)
    assert.equal(controller.currentStep, 3);
    assert.deepEqual(audio.triggeredSounds, []);

    timer.advanceBy(75); // 75ms -> step 4 (kick + snare + hihat-closed)
    assert.equal(controller.currentStep, 4);
    assert.deepEqual([...audio.triggeredSounds].sort(), ['hihat-closed', 'kick', 'snare']);

    // 3. Slow down live to 60 BPM (250ms/step) and verify old 75ms/125ms intervals do not fire early
    controller.handleTempoInputChange('60');
    assert.equal(controller.bpm, 60);
    assert.equal(sequencer.stepIntervalMs, 250);

    audio.clearTriggers();
    timer.advanceBy(125);
    assert.equal(controller.currentStep, 4);
    assert.deepEqual(audio.triggeredSounds, []);

    timer.advanceBy(125);
    assert.equal(controller.currentStep, 5);

    // 4. Pause at step 5 -> preserves step 5, halts timer, and resumes cleanly across 15 -> 0 wrap-around
    controller.pause();
    assert.equal(controller.transportState, 'paused');
    assert.equal(controller.isPlaying, false);
    assert.equal(controller.currentStep, 5);

    audio.clearTriggers();
    timer.advanceBy(250 * 6);
    assert.equal(controller.currentStep, 5);
    assert.deepEqual(audio.triggeredSounds, []);

    controller.play();
    assert.equal(controller.transportState, 'playing');
    assert.equal(controller.currentStep, 5);
    assert.deepEqual(audio.triggeredSounds, []); // Resuming does not re-trigger step 5

    // Seek directly to boundary step 15 while playing -> triggers step 15 (clap) and wraps to 0 after 250ms
    audio.clearTriggers();
    controller.seek(TOTAL_STEPS - 1);
    assert.equal(controller.currentStep, 15);
    assert.deepEqual(audio.triggeredSounds, ['clap']);

    audio.clearTriggers();
    timer.advanceBy(250);
    assert.equal(controller.currentStep, 0);
    assert.deepEqual([...audio.triggeredSounds].sort(), ['hihat-closed', 'kick']);

    // 5. Stop resets step to 0 while preserving toggled pattern steps and configured 60 BPM
    sequencer.toggleStep('clap', 2);
    controller.seek(8);
    controller.stop();
    assert.equal(controller.transportState, 'stopped');
    assert.equal(controller.isPlaying, false);
    assert.equal(controller.currentStep, 0);
    assert.equal(controller.bpm, 60);
    assert.equal(sequencer.isStepActive('clap', 2), true);

    // Empty input commit preserves active 60 BPM
    controller.handleTempoInputChange('');
    controller.handleTempoCommit();
    assert.equal(controller.bpm, 60);
    assert.equal(controller.tempoInputValue, '60');
  });
});
