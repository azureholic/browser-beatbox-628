import { TOTAL_STEPS } from '../data/demoPattern.ts';

export type StepProgressionState = 'current' | 'completed' | 'upcoming';

export type GridNavigationKey =
  | 'ArrowRight'
  | 'ArrowLeft'
  | 'ArrowDown'
  | 'ArrowUp'
  | 'Home'
  | 'End';

export interface GridCoordinates {
  readonly trackIndex: number;
  readonly stepIndex: number;
}

function assertValidStepBounds(
  stepIndex: number,
  currentStep: number,
  stepCount: number,
): void {
  if (!Number.isInteger(stepCount) || stepCount <= 0) {
    throw new RangeError('Step count must be a positive integer.');
  }
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= stepCount) {
    throw new RangeError(`Step index must be an integer in [0, ${stepCount - 1}].`);
  }
  if (!Number.isInteger(currentStep) || currentStep < 0 || currentStep >= stepCount) {
    throw new RangeError(`Current step must be an integer in [0, ${stepCount - 1}].`);
  }
}

export function isStepCurrent(
  stepIndex: number,
  currentStep: number,
  isPlaying: boolean,
  stepCount: number = TOTAL_STEPS,
): boolean {
  assertValidStepBounds(stepIndex, currentStep, stepCount);
  return isPlaying && stepIndex === currentStep;
}

export function getStepProgressionState(
  stepIndex: number,
  currentStep: number,
  isPlaying: boolean,
  stepCount: number = TOTAL_STEPS,
): StepProgressionState {
  assertValidStepBounds(stepIndex, currentStep, stepCount);

  if (stepIndex < currentStep) {
    return 'completed';
  }
  if (isPlaying && stepIndex === currentStep) {
    return 'current';
  }
  return 'upcoming';
}

export function getAriaCurrentValue(stepState: StepProgressionState): 'step' | undefined {
  return stepState === 'current' ? 'step' : undefined;
}

export function getStepIndicatorClassName(stepState: StepProgressionState): string {
  return `step-indicator ${stepState}`;
}

export function getStepCellClassName(
  stepState: StepProgressionState,
  isActive: boolean,
): string {
  return isActive ? `step-cell ${stepState} active` : `step-cell ${stepState}`;
}

export function resolveGridNavigation(
  coords: GridCoordinates,
  key: string,
  trackCount: number,
  stepCount: number = TOTAL_STEPS,
): GridCoordinates | null {
  if (!Number.isInteger(trackCount) || trackCount <= 0) {
    throw new RangeError('Track count must be a positive integer.');
  }
  if (!Number.isInteger(stepCount) || stepCount <= 0) {
    throw new RangeError('Step count must be a positive integer.');
  }
  if (
    !Number.isInteger(coords.trackIndex) ||
    coords.trackIndex < 0 ||
    coords.trackIndex >= trackCount
  ) {
    throw new RangeError(`Track index must be an integer in [0, ${trackCount - 1}].`);
  }
  if (
    !Number.isInteger(coords.stepIndex) ||
    coords.stepIndex < 0 ||
    coords.stepIndex >= stepCount
  ) {
    throw new RangeError(`Step index must be an integer in [0, ${stepCount - 1}].`);
  }

  switch (key) {
    case 'ArrowRight':
      return {
        trackIndex: coords.trackIndex,
        stepIndex: (coords.stepIndex + 1) % stepCount,
      };
    case 'ArrowLeft':
      return {
        trackIndex: coords.trackIndex,
        stepIndex: (coords.stepIndex + stepCount - 1) % stepCount,
      };
    case 'ArrowDown':
      return {
        trackIndex: (coords.trackIndex + 1) % trackCount,
        stepIndex: coords.stepIndex,
      };
    case 'ArrowUp':
      return {
        trackIndex: (coords.trackIndex + trackCount - 1) % trackCount,
        stepIndex: coords.stepIndex,
      };
    case 'Home':
      return {
        trackIndex: coords.trackIndex,
        stepIndex: 0,
      };
    case 'End':
      return {
        trackIndex: coords.trackIndex,
        stepIndex: stepCount - 1,
      };
    default:
      return null;
  }
}
