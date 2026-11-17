import { useState } from 'react';
import { FEATURED } from '../geo/geocode';
import type { Place } from '../geo/types';
import { deleteProject, listProjects, type Project } from '../project/store';
import { SearchBox } from './SearchBox';

export function Landing({ onOpenPlace, onOpenProject, notice }: { onOpenPlace: (p: Place) => void; onOpenProject: (p: Project) => void; notice?: string | null }) {
  const [projects, setProjects] = useState(listProjects);

  return (
    <div className="landing">
      <div className="landing-bg" aria-hidden />
      <header className="landing-top">
        <div className="brand"><span className="logo" />Hephaestus</div>
        <span className="pill">Early preview</span>
      </header>
      <main className="hero">
        <h1>
          Any real city.<br />
          <em>Yours to reshape.</em>
        </h1>
        <p className="lede">
          Search anywhere on Earth. Walk its real streets in 3D, redraw its roads and skyline, and watch a living city of people,
          cars, motorbikes, buses and trains respond.
        </p>
        {notice && <p className="notice" role="alert">{notice}</p>}
        <SearchBox onPick={onOpenPlace} autoFocus />
        <section className="featured">
          <h2>Start somewhere iconic</h2>
          <div className="cards">
            {FEATURED.map((f) => (
              <button key={f.name} className="card" onClick={() => onOpenPlace(f)}>
                <span className="card-title">{f.name}</span>
                <span className="card-sub">{f.displayName}</span>
                <span className="card-tag">{f.tagline}</span>
              </button>
            ))}
          </div>
        </section>
        {projects.length > 0 && (
          <section className="recent">
            <h2>Your projects</h2>
            <ul>
              {projects.slice(0, 8).map((p) => (
                <li key={p.id}>
                  <button className="recent-open" onClick={() => onOpenProject(p)}>
                    <strong>{p.name}</strong>
                    <span>{p.edits.length} change{p.edits.length === 1 ? '' : 's'} · {new Date(p.updatedAt).toLocaleDateString()}</span>
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Delete ${p.name}`}
                    onClick={() => {
                      if (!confirm(`Delete project “${p.name}”? This cannot be undone.`)) return;
                      deleteProject(p.id);
                      setProjects(listProjects());
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <footer className="landing-foot">
        Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>.
        People and vehicles are synthetic simulations, not real individuals.
      </footer>
    </div>
  );
}
