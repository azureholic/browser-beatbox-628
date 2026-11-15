import { useRef } from 'react';
import { useAudioEngine } from './audio/index.ts';
import { TransportControls } from './controls/TransportControls.tsx';
import { DEFAULT_DEMO_PATTERN } from './data/demoPattern.ts';
import { useSequencer } from './sequencer/useSequencer.ts';

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
      <section className="pattern-grid" aria-label="Demo step pattern">
        {pattern.instruments.map((instrument) => (
          <div key={instrument.id} className="track-row" data-testid={`track-${instrument.id}`}>
            <span className="track-label">{instrument.name}</span>
            {instrument.steps.map((isActive, i) => {
              const isCurrent = isPlaying && currentStep === i;
              const cellClasses = [
                'step-cell',
                isActive ? 'active' : '',
                isCurrent ? 'current' : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <button
                  key={`${instrument.id}-${i}`}
                  type="button"
                  className={cellClasses}
                  data-testid={`step-${instrument.id}-${i}`}
                  data-active={String(isActive)}
                  data-current={String(isCurrent)}
                  aria-pressed={isActive}
                  aria-label={`${instrument.name} step ${i + 1}`}
                  onClick={() => toggleStep(instrument.id, i)}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
        ))}
      </section>
    </main>
  );
}

export default App;
