import { useEffect, useRef, useSyncExternalStore } from 'react';
import { DEFAULT_DEMO_PATTERN, type BeatboxPattern } from '../data/demoPattern.ts';
import { Sequencer, type SequencerSnapshot } from './sequencer.ts';

export interface UseSequencerResult extends SequencerSnapshot {
  play: () => void;
  stop: () => void;
  toggleStep: (instrumentId: string, stepIndex: number) => boolean;
}

export function useSequencer(
  initialPattern: BeatboxPattern = DEFAULT_DEMO_PATTERN,
  onStep?: (stepIndex: number, activeInstrumentIds: string[]) => void,
): UseSequencerResult {
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;

  const sequencerRef = useRef<Sequencer | null>(null);
  if (sequencerRef.current === null) {
    sequencerRef.current = new Sequencer({
      initialPattern,
      onStep: (stepIndex, activeInstrumentIds) => {
        onStepRef.current?.(stepIndex, activeInstrumentIds);
      },
    });
  }
  const sequencer = sequencerRef.current;

  const snapshot = useSyncExternalStore(
    (listener) => sequencer.subscribe(listener),
    () => sequencer.getSnapshot(),
  );

  useEffect(() => {
    return () => {
      sequencer.stop();
    };
  }, [sequencer]);

  return {
    ...snapshot,
    play: () => sequencer.play(),
    stop: () => sequencer.stop(),
    toggleStep: (instrumentId, stepIndex) => sequencer.toggleStep(instrumentId, stepIndex),
  };
}
