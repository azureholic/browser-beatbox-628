import { useRef, type KeyboardEvent } from 'react';
import type { InstrumentTrack } from '../data/demoPattern.ts';
import {
  getAriaCurrentValue,
  getStepCellClassName,
  getStepIndicatorClassName,
  getStepProgressionState,
  isStepCurrent,
  resolveGridNavigation,
  type StepProgressionState,
} from './stepFeedback.ts';

export interface PatternGridProps {
  readonly instruments: readonly InstrumentTrack[];
  readonly stepCount: number;
  readonly currentStep: number;
  readonly isPlaying: boolean;
  readonly onToggleStep: (instrumentId: string, stepIndex: number) => void;
}

function getCellRefKey(instrumentId: string, stepIndex: number): string {
  return `${instrumentId}:${stepIndex}`;
}

function StepIndicatorIcon({
  stepIndex,
  stepState,
}: {
  readonly stepIndex: number;
  readonly stepState: StepProgressionState;
}) {
  return (
    <svg
      className="step-indicator-icon"
      data-testid={`step-indicator-icon-${stepIndex}`}
      data-icon-state={stepState}
      aria-hidden="true"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      focusable="false"
    >
      {stepState === 'current' ? (
        <polygon points="2,2.5 10,2.5 6,9.5" fill="currentColor" />
      ) : stepState === 'completed' ? (
        <path
          d="M2,6.5 L4.8,9.2 L10,3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <circle cx="6" cy="6" r="2" fill="currentColor" />
      )}
    </svg>
  );
}

export function PatternGrid({
  instruments,
  stepCount,
  currentStep,
  isPlaying,
  onToggleStep,
}: PatternGridProps) {
  const cellRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const setCellRef = (
    instrumentId: string,
    stepIndex: number,
    element: HTMLButtonElement | null,
  ) => {
    const key = getCellRefKey(instrumentId, stepIndex);
    if (element !== null) {
      cellRefs.current.set(key, element);
    } else {
      cellRefs.current.delete(key);
    }
  };

  const handleCellKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    trackIndex: number,
    stepIndex: number,
  ) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const nextCoords = resolveGridNavigation(
      { trackIndex, stepIndex },
      event.key,
      instruments.length,
      stepCount,
    );
    if (nextCoords === null) {
      return;
    }

    event.preventDefault();
    const targetInstrument = instruments[nextCoords.trackIndex];
    if (!targetInstrument) {
      return;
    }

    const targetCell = cellRefs.current.get(
      getCellRefKey(targetInstrument.id, nextCoords.stepIndex),
    );
    targetCell?.focus();
  };

  return (
    <section className="pattern-grid" aria-label="Demo step pattern">
      <div className="step-indicators-header">
        <span id="step-indicators-label" className="step-indicators-label">
          Steps
        </span>
        <ol
          className="step-indicators"
          data-testid="step-indicators"
          role="list"
          aria-labelledby="step-indicators-label"
        >
          {Array.from({ length: stepCount }, (_, stepIndex) => {
            const stepState = getStepProgressionState(
              stepIndex,
              currentStep,
              isPlaying,
              stepCount,
            );
            const current = isStepCurrent(stepIndex, currentStep, isPlaying, stepCount);

            return (
              <li
                key={stepIndex}
                className={getStepIndicatorClassName(stepState)}
                data-testid={`step-indicator-${stepIndex}`}
                data-current={String(current)}
                data-step-state={stepState}
                aria-current={getAriaCurrentValue(stepState)}
              >
                <StepIndicatorIcon stepIndex={stepIndex} stepState={stepState} />
                <span className="step-indicator-number">{stepIndex + 1}</span>
              </li>
            );
          })}
        </ol>
      </div>

      {instruments.map((instrument, trackIndex) => {
        const trackLabelId = `track-label-${instrument.id}`;

        return (
          <div
            key={instrument.id}
            className="track-row"
            data-testid={`track-${instrument.id}`}
            role="group"
            aria-labelledby={trackLabelId}
          >
            <span id={trackLabelId} className="track-label">
              {instrument.name}
            </span>
            {instrument.steps.map((isActive, stepIndex) => {
              const stepState = getStepProgressionState(
                stepIndex,
                currentStep,
                isPlaying,
                stepCount,
              );
              const current = isStepCurrent(stepIndex, currentStep, isPlaying, stepCount);

              return (
                <button
                  key={`${instrument.id}-${stepIndex}`}
                  ref={(el) => setCellRef(instrument.id, stepIndex, el)}
                  type="button"
                  className={getStepCellClassName(stepState, isActive)}
                  data-testid={`step-${instrument.id}-${stepIndex}`}
                  data-active={String(isActive)}
                  data-current={String(current)}
                  data-step-state={stepState}
                  aria-pressed={isActive}
                  aria-current={getAriaCurrentValue(stepState)}
                  aria-label={`${instrument.name} step ${stepIndex + 1}`}
                  onClick={() => onToggleStep(instrument.id, stepIndex)}
                  onKeyDown={(event) => handleCellKeyDown(event, trackIndex, stepIndex)}
                >
                  {stepIndex + 1}
                </button>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}
