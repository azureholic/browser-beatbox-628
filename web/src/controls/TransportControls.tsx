import { useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent } from 'react';
import {
  evaluateTempoInputChange,
  formatTempoDisplay,
  MAX_BPM,
  MIN_BPM,
  resolveCommittedTempoInput,
  type TransportState,
} from './transportTempo.ts';

export interface TransportControlsProps {
  readonly transportState: TransportState;
  readonly bpm: number;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onStop: () => void;
  readonly onBpmChange: (bpm: number) => number;
}

export function TransportControls({
  transportState,
  bpm,
  onPlay,
  onPause,
  onStop,
  onBpmChange,
}: TransportControlsProps) {
  const [tempoDraft, setTempoDraft] = useState<string>(() => String(bpm));
  const prevBpmRef = useRef<number>(bpm);

  if (prevBpmRef.current !== bpm) {
    prevBpmRef.current = bpm;
    const trimmed = tempoDraft.trim();
    const parsed = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(parsed) || Math.round(parsed) !== bpm) {
      setTempoDraft(String(bpm));
    }
  }

  const commitInput = (inputElement: HTMLInputElement) => {
    const committed = resolveCommittedTempoInput(inputElement.value, bpm);
    prevBpmRef.current = committed.bpm;
    onBpmChange(committed.bpm);
    setTempoDraft(committed.normalizedValue);
    inputElement.value = committed.normalizedValue;
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const evaluation = evaluateTempoInputChange(event.currentTarget.value);
    setTempoDraft(evaluation.draftValue);
    if (evaluation.immediateBpm !== null) {
      prevBpmRef.current = evaluation.immediateBpm;
      onBpmChange(evaluation.immediateBpm);
    }
  };

  const handleInputBlur = (event: FocusEvent<HTMLInputElement>) => {
    commitInput(event.currentTarget);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitInput(event.currentTarget);
    }
  };

  const handleSliderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const committed = resolveCommittedTempoInput(event.currentTarget.value, bpm);
    prevBpmRef.current = committed.bpm;
    onBpmChange(committed.bpm);
    setTempoDraft(committed.normalizedValue);
  };

  return (
    <div className="controls-bar">
      <div className="transport-controls" role="group" aria-label="Transport controls">
        <button
          type="button"
          className={`transport-button transport-play${transportState === 'playing' ? ' active' : ''}`}
          data-testid="transport-play"
          aria-label="Play"
          aria-pressed={transportState === 'playing'}
          onClick={onPlay}
        >
          Play
        </button>
        <button
          type="button"
          className={`transport-button transport-pause${transportState === 'paused' ? ' active' : ''}`}
          data-testid="transport-pause"
          aria-label="Pause"
          aria-pressed={transportState === 'paused'}
          onClick={onPause}
        >
          Pause
        </button>
        <button
          type="button"
          className={`transport-button transport-stop${transportState === 'stopped' ? ' active' : ''}`}
          data-testid="transport-stop"
          aria-label="Stop"
          onClick={onStop}
        >
          Stop
        </button>
      </div>
      <div className="tempo-controls" role="group" aria-label="Tempo controls">
        <label htmlFor="tempo-input" className="tempo-label">
          Tempo
        </label>
        <input
          id="tempo-slider"
          type="range"
          className="tempo-slider"
          data-testid="tempo-slider"
          min={MIN_BPM}
          max={MAX_BPM}
          step={1}
          value={bpm}
          aria-label="Tempo slider (BPM)"
          aria-valuemin={MIN_BPM}
          aria-valuemax={MAX_BPM}
          aria-valuenow={bpm}
          onChange={handleSliderChange}
        />
        <input
          id="tempo-input"
          type="number"
          className="tempo-input"
          data-testid="tempo-input"
          min={MIN_BPM}
          max={MAX_BPM}
          step={1}
          value={tempoDraft}
          aria-label="Tempo (BPM)"
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onKeyDown={handleInputKeyDown}
        />
        <output
          htmlFor="tempo-input tempo-slider"
          className="tempo-display"
          data-testid="tempo-display"
          aria-label="Active tempo"
          aria-live="polite"
        >
          {formatTempoDisplay(bpm)}
        </output>
      </div>
    </div>
  );
}
