import { useEffect, useState } from 'react';

export interface TourSignals {
  cameraMoved: boolean;
  inspected: boolean;
  orbited: boolean;
  edited: boolean;
  compared: boolean;
  fast: boolean;
}

const STEPS: { key: keyof TourSignals; title: string; body: string }[] = [
  { key: 'cameraMoved', title: 'Look around', body: 'Drag to orbit 360°, right-drag (or WASD) to pan, scroll or pinch to zoom.' },
  { key: 'inspected', title: 'Inspect something', body: 'Click a building, street, person or vehicle. The inspector shows real data and where it came from.' },
  { key: 'orbited', title: 'Circle it', body: 'Press “Orbit 360°” in the inspector (or double-click) to fly around the selected building.' },
  { key: 'edited', title: 'Change the city', body: 'Pick a tool on the left: place a building, draw a road or transit line, zone an area — or change a building’s height.' },
  { key: 'compared', title: 'Compare', body: 'Toggle Original and Proposed at the top to see before and after. The dashboard shows the impact.' },
  { key: 'fast', title: 'Run the city', body: 'Speed time up to 20× or 60× at the bottom and watch traffic and transit respond.' },
];

/** Interactive tour: each step completes when the user actually does it. Skippable at any point. */
export function Tour({ place, signals, onClose }: { place: string; signals: TourSignals; onClose: () => void }) {
  const [started, setStarted] = useState(false);
  const step = STEPS.findIndex((s) => !signals[s.key]);
  useEffect(() => {
    if (started && step === -1) {
      const t = setTimeout(onClose, 2500);
      return () => clearTimeout(t);
    }
  }, [started, step, onClose]);

  if (!started) {
    return (
      <div className="panel coach" role="dialog" aria-label="Quick tour">
        <h3>Welcome to {place}</h3>
        <p className="muted">Real streets and buildings from OpenStreetMap, real terrain, and a living simulated city. Everything you change is a proposal — the real data is never altered.</p>
        <div className="row">
          <button className="primary" onClick={() => setStarted(true)}>Take the 1-minute tour</button>
          <button onClick={onClose}>Start exploring</button>
        </div>
      </div>
    );
  }
  return (
    <div className="panel tour" role="dialog" aria-label="Tour step">
      <div className="tour-head">
        <span>{step === -1 ? 'All done' : `Step ${step + 1} of ${STEPS.length}`}</span>
        <button className="icon-btn" onClick={onClose} aria-label="Skip tour">Skip</button>
      </div>
      {step === -1 ? (
        <p><b>You’re set.</b> Your work autosaves; use Share to send a link to your plan.</p>
      ) : (
        <>
          <h3>{STEPS[step].title}</h3>
          <p>{STEPS[step].body}</p>
        </>
      )}
      <div className="dots">{STEPS.map((s, i) => <i key={s.key} className={signals[s.key] ? 'done' : i === step ? 'now' : ''} />)}</div>
    </div>
  );
}
