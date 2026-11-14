import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_DEMO_PATTERN } from '../src/data/demoPattern.ts';
import {
  calculateStepIntervalMs,
  getNextStepIndex,
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

describe('16-step Sequencer (REQ-002)', () => {
  it('initializes a 16-step grid (indices 0..15) in stopped state with currentStep = 0', () => {
    const timer = new ManualFakeTimer();
    const sequencer = new Sequencer({ timer });

    assert.equal(TOTAL_STEPS, 16);
    assert.equal(sequencer.stepCount, TOTAL_STEPS);
    assert.equal(sequencer.isPlaying, false);
    assert.equal(sequencer.currentStep, 0);
    assert.equal(sequencer.bpm, 120);
    assert.equal(sequencer.stepIntervalMs, 125);
    assert.equal(sequencer.instruments.length, 4);

    for (const track of sequencer.instruments) {
      assert.equal(track.steps.length, TOTAL_STEPS);
    }
  });

  it('computes 16th-note step interval from BPM and rejects invalid BPM inputs', () => {
    assert.equal(calculateStepIntervalMs(120), 125);
    assert.equal(calculateStepIntervalMs(60), 250);
    assert.throws(() => calculateStepIntervalMs(0), RangeError);
    assert.throws(() => calculateStepIntervalMs(-90), RangeError);
    assert.throws(() => calculateStepIntervalMs(Number.NaN), RangeError);
  });

  it('progresses sequentially through all 16 steps (0 -> 15) and updates currentStep getter', () => {
    const timer = new ManualFakeTimer();
    const sequencer = new Sequencer({ timer });

    sequencer.play();
    assert.equal(sequencer.isPlaying, true);
    assert.equal(sequencer.currentStep, 0);

    const observedSteps: number[] = [sequencer.currentStep];
    for (let tick = 1; tick < TOTAL_STEPS; tick++) {
      timer.advanceBy(sequencer.stepIntervalMs);
      observedSteps.push(sequencer.currentStep);
    }

    assert.deepEqual(
      observedSteps,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
  });

  it('wraps automatically from final step (15) back to first step (0) with no manual intervention', () => {
    assert.equal(getNextStepIndex(15, TOTAL_STEPS), 0);

    const timer = new ManualFakeTimer();
    const sequencer = new Sequencer({ timer });
    sequencer.play();

    // Advance 15 intervals to reach the final step (index 15 = Step 16)
    timer.advanceBy(sequencer.stepIntervalMs * (TOTAL_STEPS - 1));
    assert.equal(sequencer.isPlaying, true);
    assert.equal(sequencer.currentStep, 15);

    // Next interval wraps seamlessly back to step index 0
    timer.advanceBy(sequencer.stepIntervalMs);
    assert.equal(sequencer.isPlaying, true);
    assert.equal(sequencer.currentStep, 0);
  });

  it('loops continuously across multiple full cycles without skips, duplicates, or sub-interval drift', () => {
    const timer = new ManualFakeTimer();
    const observedCallbacks: number[] = [];
    const sequencer = new Sequencer({
      timer,
      onStep: (stepIndex) => {
        observedCallbacks.push(stepIndex);
      },
    });

    sequencer.play();
    assert.equal(sequencer.currentStep, 0);

    // Sub-interval elapsed time (< 125ms) must not advance early
    timer.advanceBy(60);
    assert.equal(sequencer.currentStep, 0);

    // Completing remaining 65ms advances deterministically to step 1
    timer.advanceBy(65);
    assert.equal(sequencer.currentStep, 1);

    const cycles = 4;
    const totalTransitions = TOTAL_STEPS * cycles;
    const observedGetterSteps: number[] = [0, 1];

    for (let tick = 2; tick <= totalTransitions; tick++) {
      timer.advanceBy(sequencer.stepIntervalMs);
      observedGetterSteps.push(sequencer.currentStep);
    }

    assert.equal(observedGetterSteps.length, totalTransitions + 1);
    assert.deepEqual(observedCallbacks, observedGetterSteps);

    for (let i = 0; i <= totalTransitions; i++) {
      assert.equal(observedGetterSteps[i], i % TOTAL_STEPS);
    }

    // Verify every cycle boundary wrapped cleanly from 15 -> 0
    for (let cycle = 1; cycle <= cycles; cycle++) {
      assert.equal(observedGetterSteps[cycle * TOTAL_STEPS - 1], 15);
      assert.equal(observedGetterSteps[cycle * TOTAL_STEPS], 0);
    }
  });

  it('notifies subscribers on state updates and stops cleanly without further step progression', () => {
    const timer = new ManualFakeTimer();
    const sequencer = new Sequencer({ timer });
    let notificationCount = 0;
    const unsubscribe = sequencer.subscribe(() => {
      notificationCount++;
    });

    const initialSnapshot = sequencer.getSnapshot();
    sequencer.play();
    assert.notEqual(sequencer.getSnapshot(), initialSnapshot);
    assert.equal(timer.activeTimerCount, 1);

    // Calling play() while already playing is an idempotent no-op
    const countAfterPlay = notificationCount;
    sequencer.play();
    assert.equal(notificationCount, countAfterPlay);
    assert.equal(timer.activeTimerCount, 1);

    timer.advanceBy(sequencer.stepIntervalMs * 3);
    assert.equal(sequencer.currentStep, 3);

    sequencer.stop();
    assert.equal(sequencer.isPlaying, false);
    assert.equal(sequencer.currentStep, 0);
    assert.equal(timer.activeTimerCount, 0);

    // Advancing time while stopped does not change currentStep or fire notifications
    const countAfterStop = notificationCount;
    timer.advanceBy(sequencer.stepIntervalMs * 8);
    assert.equal(sequencer.currentStep, 0);
    assert.equal(notificationCount, countAfterStop);

    unsubscribe();
  });

  it('toggles steps independently per instrument while stopped and playing without mutating seed data', () => {
    const timer = new ManualFakeTimer();
    const sequencer = new Sequencer({ timer });

    assert.equal(sequencer.isStepActive('kick', 0), true);
    assert.equal(sequencer.isStepActive('kick', 1), false);
    assert.equal(sequencer.isStepActive('snare', 1), false);

    // Toggle kick step 1 ON while stopped
    assert.equal(sequencer.toggleStep('kick', 1), true);
    assert.equal(sequencer.isStepActive('kick', 1), true);
    assert.equal(sequencer.isStepActive('snare', 1), false);
    assert.equal(DEFAULT_DEMO_PATTERN.instruments[0].steps[1], false);

    // Toggle kick step 0 OFF while playing and verify persistence across a full 16-step loop
    sequencer.play();
    assert.equal(sequencer.toggleStep('kick', 0), false);
    assert.equal(sequencer.toggleStep('clap', 0), true);

    timer.advanceBy(sequencer.stepIntervalMs * TOTAL_STEPS);
    assert.equal(sequencer.currentStep, 0);
    assert.equal(sequencer.isStepActive('kick', 0), false);
    assert.equal(sequencer.isStepActive('kick', 1), true);
    assert.equal(sequencer.isStepActive('clap', 0), true);
    assert.deepEqual(sequencer.getActiveInstrumentIds(0), ['hihat-closed', 'clap']);

    // Out-of-bounds indices and unknown instruments throw RangeError
    assert.throws(() => sequencer.toggleStep('kick', -1), RangeError);
    assert.throws(() => sequencer.toggleStep('kick', TOTAL_STEPS), RangeError);
    assert.throws(() => sequencer.toggleStep('unknown-drum', 0), RangeError);
  });
});
