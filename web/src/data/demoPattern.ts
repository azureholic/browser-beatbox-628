export const TOTAL_STEPS = 16;

export interface InstrumentTrack {
  id: string;
  name: string;
  steps: boolean[];
}

export interface BeatboxPattern {
  id: string;
  name: string;
  bpm: number;
  stepCount: number;
  instruments: InstrumentTrack[];
}

export const DEFAULT_DEMO_PATTERN: BeatboxPattern = {
  id: 'demo-four-on-the-floor',
  name: 'Synthetic Groove 01',
  bpm: 120,
  stepCount: TOTAL_STEPS,
  instruments: [
    { id: 'kick', name: 'Kick', steps: [true, false, false, false, true, false, false, false, true, false, false, false, true, false, false, false] },
    { id: 'snare', name: 'Snare', steps: [false, false, false, false, true, false, false, false, false, false, false, false, true, false, false, false] },
    { id: 'hihat-closed', name: 'Closed Hi-Hat', steps: [true, false, true, false, true, false, true, false, true, false, true, false, true, false, true, false] },
    { id: 'clap', name: 'Clap', steps: [false, false, false, false, false, false, false, false, false, false, false, false, true, false, false, true] },
  ],
};
