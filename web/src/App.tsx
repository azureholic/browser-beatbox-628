import { useState } from 'react';
import { DEFAULT_DEMO_PATTERN, type BeatboxPattern } from './data/demoPattern';

function App() {
  const [pattern] = useState<BeatboxPattern>(DEFAULT_DEMO_PATTERN);
  return (
    <main className="beatbox-shell" data-testid="beatbox-app">
      <header className="beatbox-header">
        <h1>Browser Beatbox</h1>
        <span className="beatbox-meta">
          {pattern.name} &middot; {pattern.bpm} BPM &middot; {pattern.instruments.length} tracks &times; {pattern.stepCount} steps
        </span>
      </header>
      <section className="pattern-grid" aria-label="Demo step pattern">
        {pattern.instruments.map((instrument) => (
          <div key={instrument.id} className="track-row" data-testid={`track-${instrument.id}`}>
            <span className="track-label">{instrument.name}</span>
            {instrument.steps.map((isActive, i) => (
              <div key={`${instrument.id}-${i}`} className={`step-cell${isActive ? ' active' : ''}`} data-testid={`step-${instrument.id}-${i}`} data-active={isActive}>
                {i + 1}
              </div>
            ))}
          </div>
        ))}
      </section>
    </main>
  );
}

export default App;
