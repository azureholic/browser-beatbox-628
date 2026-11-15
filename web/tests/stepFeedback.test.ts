import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TOTAL_STEPS } from '../src/data/demoPattern.ts';
import { Sequencer, type SequencerTimer } from '../src/sequencer/sequencer.ts';
import {
  getAriaCurrentValue,
  getStepCellClassName,
  getStepIndicatorClassName,
  getStepProgressionState,
  isStepCurrent,
  resolveGridNavigation,
} from '../src/stepper/stepFeedback.ts';

class ManualStepTimer implements SequencerTimer {
  #callback: (() => void) | null = null;

  setInterval(callback: () => void): unknown {
    this.#callback = callback;
    return 1;
  }

  clearInterval(): void {
    this.#callback = null;
  }

  tick(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.#callback?.();
    }
  }
}

describe('REQ-005 step progression state and visual feedback helpers', () => {
  it('marks all 16 steps as upcoming and not current when stopped at step 0', () => {
    for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
      const state = getStepProgressionState(stepIndex, 0, false);
      assert.equal(state, 'upcoming');
      assert.equal(isStepCurrent(stepIndex, 0, false), false);
      assert.equal(getAriaCurrentValue(state), undefined);
      assert.equal(getStepIndicatorClassName(state), 'step-indicator upcoming');
    }
  });

  it('partitions steps into completed, current, and upcoming during active playback', () => {
    const currentStep = 5;
    for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
      const state = getStepProgressionState(stepIndex, currentStep, true);
      if (stepIndex < currentStep) {
        assert.equal(state, 'completed');
        assert.equal(isStepCurrent(stepIndex, currentStep, true), false);
        assert.equal(getAriaCurrentValue(state), undefined);
      } else if (stepIndex === currentStep) {
        assert.equal(state, 'current');
        assert.equal(isStepCurrent(stepIndex, currentStep, true), true);
        assert.equal(getAriaCurrentValue(state), 'step');
      } else {
        assert.equal(state, 'upcoming');
        assert.equal(isStepCurrent(stepIndex, currentStep, true), false);
        assert.equal(getAriaCurrentValue(state), undefined);
      }
    }
  });

  it('preserves completed prior steps while clearing current highlight when paused mid-bar', () => {
    const pausedStep = 6;
    for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
      const state = getStepProgressionState(stepIndex, pausedStep, false);
      assert.equal(isStepCurrent(stepIndex, pausedStep, false), false);
      assert.equal(getAriaCurrentValue(state), undefined);
      assert.equal(state, stepIndex < pausedStep ? 'completed' : 'upcoming');
    }
  });

  it('resets steps 1..15 from completed back to upcoming on 15 -> 0 loop wrap-around and on stop', () => {
    const timer = new ManualStepTimer();
    const sequencer = new Sequencer({ timer });

    sequencer.play();
    assert.equal(
      getStepProgressionState(0, sequencer.currentStep, sequencer.isPlaying),
      'current',
    );
    assert.equal(
      getStepProgressionState(1, sequencer.currentStep, sequencer.isPlaying),
      'upcoming',
    );

    timer.tick(15);
    assert.equal(sequencer.currentStep, 15);
    assert.equal(
      getStepProgressionState(14, sequencer.currentStep, sequencer.isPlaying),
      'completed',
    );
    assert.equal(
      getStepProgressionState(15, sequencer.currentStep, sequencer.isPlaying),
      'current',
    );

    // Wrap around 15 -> 0
    timer.tick(1);
    assert.equal(sequencer.currentStep, 0);
    assert.equal(
      getStepProgressionState(0, sequencer.currentStep, sequencer.isPlaying),
      'current',
    );
    for (let stepIndex = 1; stepIndex < TOTAL_STEPS; stepIndex++) {
      assert.equal(
        getStepProgressionState(stepIndex, sequencer.currentStep, sequencer.isPlaying),
        'upcoming',
      );
    }

    // Stop resets all steps to upcoming with zero current highlights
    sequencer.stop();
    for (let stepIndex = 0; stepIndex < TOTAL_STEPS; stepIndex++) {
      assert.equal(
        getStepProgressionState(stepIndex, sequencer.currentStep, sequencer.isPlaying),
        'upcoming',
      );
      assert.equal(isStepCurrent(stepIndex, sequencer.currentStep, sequencer.isPlaying), false);
    }
  });

  it('computes exact step-cell and step-indicator class tokens across active and progression states', () => {
    assert.equal(getStepIndicatorClassName('upcoming'), 'step-indicator upcoming');
    assert.equal(getStepIndicatorClassName('current'), 'step-indicator current');
    assert.equal(getStepIndicatorClassName('completed'), 'step-indicator completed');

    assert.equal(getStepCellClassName('upcoming', false), 'step-cell upcoming');
    assert.equal(getStepCellClassName('upcoming', true), 'step-cell upcoming active');
    assert.equal(getStepCellClassName('current', false), 'step-cell current');
    assert.equal(getStepCellClassName('current', true), 'step-cell current active');
    assert.equal(getStepCellClassName('completed', false), 'step-cell completed');
    assert.equal(getStepCellClassName('completed', true), 'step-cell completed active');
  });

  it('validates step index and step count bounds', () => {
    assert.throws(() => getStepProgressionState(-1, 0, false), RangeError);
    assert.throws(() => getStepProgressionState(16, 0, false), RangeError);
    assert.throws(() => getStepProgressionState(0, -1, false), RangeError);
    assert.throws(() => getStepProgressionState(0, 16, false), RangeError);
    assert.throws(() => getStepProgressionState(0, 0, false, 0), RangeError);
  });
});

describe('REQ-005 2D keyboard grid focus navigation', () => {
  const trackCount = 4;

  it('navigates horizontally with ArrowRight, ArrowLeft, Home, and End including wrap-around', () => {
    assert.deepEqual(resolveGridNavigation({ trackIndex: 0, stepIndex: 0 }, 'ArrowRight', trackCount), {
      trackIndex: 0,
      stepIndex: 1,
    });
    assert.deepEqual(resolveGridNavigation({ trackIndex: 0, stepIndex: 15 }, 'ArrowRight', trackCount), {
      trackIndex: 0,
      stepIndex: 0,
    });
    assert.deepEqual(resolveGridNavigation({ trackIndex: 0, stepIndex: 0 }, 'ArrowLeft', trackCount), {
      trackIndex: 0,
      stepIndex: 15,
    });
    assert.deepEqual(resolveGridNavigation({ trackIndex: 2, stepIndex: 7 }, 'Home', trackCount), {
      trackIndex: 2,
      stepIndex: 0,
    });
    assert.deepEqual(resolveGridNavigation({ trackIndex: 2, stepIndex: 7 }, 'End', trackCount), {
      trackIndex: 2,
      stepIndex: 15,
    });
  });

  it('navigates vertically across instrument tracks with ArrowDown and ArrowUp including wrap-around', () => {
    assert.deepEqual(resolveGridNavigation({ trackIndex: 0, stepIndex: 2 }, 'ArrowDown', trackCount), {
      trackIndex: 1,
      stepIndex: 2,
    });
    assert.deepEqual(resolveGridNavigation({ trackIndex: 3, stepIndex: 2 }, 'ArrowDown', trackCount), {
      trackIndex: 0,
      stepIndex: 2,
    });
    assert.deepEqual(resolveGridNavigation({ trackIndex: 0, stepIndex: 2 }, 'ArrowUp', trackCount), {
      trackIndex: 3,
      stepIndex: 2,
    });
    assert.deepEqual(resolveGridNavigation({ trackIndex: 2, stepIndex: 2 }, 'ArrowUp', trackCount), {
      trackIndex: 1,
      stepIndex: 2,
    });
  });

  it('returns null for non-navigation keys so Space, Enter, and Tab preserve native button behavior', () => {
    assert.equal(resolveGridNavigation({ trackIndex: 1, stepIndex: 3 }, ' ', trackCount), null);
    assert.equal(resolveGridNavigation({ trackIndex: 1, stepIndex: 3 }, 'Enter', trackCount), null);
    assert.equal(resolveGridNavigation({ trackIndex: 1, stepIndex: 3 }, 'Tab', trackCount), null);
  });
});
