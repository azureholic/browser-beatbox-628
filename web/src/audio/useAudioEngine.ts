import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  AudioEngine,
  DEFAULT_DRUM_SAMPLES,
  type AudioEngineSnapshot,
  type PlaySoundOptions,
} from './audioEngine.ts';

export interface UseAudioEngineResult extends AudioEngineSnapshot {
  play: (soundName: string, options?: PlaySoundOptions) => boolean;
  setMasterGain: (value: number) => void;
  mute: () => void;
  unmute: () => void;
  suspend: () => Promise<void>;
  resume: () => Promise<void>;
}

export function useAudioEngine(instrumentIds: readonly string[]): UseAudioEngineResult {
  const engineRef = useRef<AudioEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new AudioEngine();
  }
  const engine = engineRef.current;

  const snapshot = useSyncExternalStore(
    (listener) => engine.subscribe(listener),
    () => engine.getSnapshot(),
  );

  const soundsKey = instrumentIds.join('\0');
  const requiredSounds = useMemo(
    () => Array.from(new Set([...Object.keys(DEFAULT_DRUM_SAMPLES), ...instrumentIds])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [soundsKey],
  );

  useEffect(() => {
    engine.enableAutoResume();
    void engine.load(requiredSounds);
    return () => {
      engine.dispose();
    };
  }, [engine, requiredSounds]);

  return {
    ...snapshot,
    play: (soundName, options) => engine.play(soundName, options),
    setMasterGain: (value) => engine.setMasterGain(value),
    mute: () => engine.mute(),
    unmute: () => engine.unmute(),
    suspend: () => engine.suspend(),
    resume: () => engine.resume(),
  };
}
