import { useRef } from 'react';
import { useAudioEngine } from './audio/index.ts';
import { TransportControls } from './controls/TransportControls.tsx';
import { DEFAULT_DEMO_PATTERN } from './data/demoPattern.ts';
import { useSequencer } from './sequencer/useSequencer.ts';
import { PatternGrid } from './stepper/PatternGrid.tsx';

function App() {
  const playSoundRef = useRef<(soundName: string) => void>(() => {});
  const {
    pattern,
    transportState,
    isPlaying,
    currentStep,
    bpm,
    play,
    pause,
    stop,
    setBpm,
    toggleStep,
  } = useSequencer(
    DEFAULT_DEMO_PATTERN,
    (_stepIndex, activeInstrumentIds) => {
      for (const instrumentId of activeInstrumentIds) {
        playSoundRef.current(instrumentId);
      }
    },
  );
  const { isReady, play: playSound, resume: resumeAudio } = useAudioEngine(
    pattern.instruments.map((instrument) => instrument.id),
  );
  playSoundRef.current = playSound;

  return (
    <main
      className="beatbox-shell"
      data-testid="beatbox-app"
      data-playing={String(isPlaying)}
      data-transport-state={transportState}
      data-current-step={String(currentStep)}
      data-bpm={String(bpm)}
      data-audio-ready={String(isReady)}
    >
      <header className="beatbox-header">
        <div>
          <h1>Browser Beatbox</h1>
          <span className="beatbox-meta">
            {pattern.name} &middot; {bpm} BPM &middot; {pattern.instruments.length} tracks &times; {pattern.stepCount} steps
          </span>
        </div>
        <TransportControls
          transportState={transportState}
          bpm={bpm}
          onPlay={() => {
            if (transportState !== 'playing') {
              void resumeAudio();
            }
            play();
          }}
          onPause={pause}
          onStop={stop}
          onBpmChange={setBpm}
        />
      </header>
      <PatternGrid
        instruments={pattern.instruments}
        stepCount={pattern.stepCount}
        currentStep={currentStep}
        isPlaying={isPlaying}
        onToggleStep={toggleStep}
      />
    </main>
  );
}

export default App;
