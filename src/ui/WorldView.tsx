import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchAreas, fetchWorld } from '../geo/osm';
import { fetchTerrain } from '../geo/terrain';
import type { Place, WorldData } from '../geo/types';
import { applyEdits, pushEdit, redo, undo, type Edit, type History } from '../project/edits';
import { saveProject, type Project } from '../project/store';
import { Engine, type CameraMode, type Layers, type Perf, type Selection, type Tool, type WorldRenderer } from '../render/engine';
import { Plan2D } from '../render/plan2d';
import type { QualitySetting } from '../render/quality';
import { profileFor } from '../sim/region';
import type { SimStats } from '../sim/simulation';
import { cityMetrics } from './metrics';
import { Dashboard, fmt, Inspector, SimBar } from './Panels';
import { SearchBox } from './SearchBox';

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'select', label: 'Select & inspect', key: '1', icon: '➚' },
  { id: 'build', label: 'Place building', key: '2', icon: '▦' },
  { id: 'road', label: 'Draw road', key: '3', icon: '⟋' },
  { id: 'bulldoze', label: 'Bulldoze', key: '4', icon: '✕' },
  { id: 'transit', label: 'Transit line', key: '5', icon: '⇆' },
];
const ONBOARD_KEY = 'gcs.onboarded.v1';
const QUALITY_KEY = 'gcs.quality';
const VIEW_KEY = 'gcs.view';

function readView(): '3d' | '2d' {
  try {
    return localStorage.getItem(VIEW_KEY) === '2d' ? '2d' : '3d';
  } catch {
    return '3d';
  }
}

function readQuality(): QualitySetting {
  try {
    return (localStorage.getItem(QUALITY_KEY) as QualitySetting) || 'auto';
  } catch {
    return 'auto';
  }
}

export default function WorldView({ project: initial, onExit, onOpenPlace }: { project: Project; onExit: () => void; onOpenPlace: (p: Place) => void }) {
  const [project, setProject] = useState(initial);
  const [base, setBase] = useState<WorldData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<History>({ edits: initial.edits, redo: [] });
  const [view, setView] = useState<'proposed' | 'original'>('proposed');
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [following, setFollowing] = useState<number | null>(null);
  const [stats, setStats] = useState<SimStats | null>(null);
  const [perf, setPerf] = useState<Perf | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualitySetting>(readQuality);
  const [layers, setLayers] = useState<Layers>({ agents: true, transit: true, estimated: false, traffic: false });
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [lineMode, setLineMode] = useState<'bus' | 'metro'>('bus');
  const [dashOpen, setDashOpen] = useState(() => window.innerWidth > 900);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [onboard, setOnboard] = useState(() => {
    try {
      return !localStorage.getItem(ONBOARD_KEY);
    } catch {
      return false;
    }
  });
  const [mode, setMode] = useState<'3d' | '2d'>(readView);

  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<WorldRenderer | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const region = useMemo(() => profileFor(project.place.countryCode), [project.place.countryCode]);
  const proposed = useMemo(() => (base ? applyEdits(base, history.edits) : null), [base, history.edits]);
  const shown = view === 'original' ? base : proposed;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const originalMetrics = useMemo(() => (base ? cityMetrics(base) : null), [base]);
  const proposedMetrics = useMemo(() => (proposed ? cityMetrics(proposed) : null), [proposed]);

  const edit = useCallback((e: Edit) => {
    if (viewRef.current === 'original') {
      setHint('You are viewing the original city. Switch to Proposed to make changes.');
      return;
    }
    setHistory((h) => pushEdit(h, e));
  }, []);

  // Renderer lifecycle. Recreated when quality or view mode changes (antialiasing is fixed at context creation).
  useEffect(() => {
    if (!host.current) return;
    const callbacks = {
      onSelect: (s: Selection | null) => {
        setSelection(s);
        if (s?.type !== 'agent') setFollowing(null);
      },
      onEdit: edit,
      onStats: setStats,
      onPerf: setPerf,
      onHint: setHint,
    };
    let r: WorldRenderer;
    if (mode === '3d') {
      try {
        r = new Engine(host.current, callbacks, quality);
      } catch {
        // No WebGL: the 2D plan view keeps every planning feature available.
        setHint('3D graphics are unavailable on this device, so the 2D plan view is shown.');
        setMode('2d');
        return;
      }
    } else r = new Plan2D(host.current, callbacks);
    engine.current = r;
    if (shownRef.current) r.setWorld(shownRef.current, region);
    return () => {
      r.dispose();
      engine.current = null;
    };
  }, [quality, region, edit, mode]);

  useEffect(() => {
    if (shown) engine.current?.setWorld(shown, region);
  }, [shown, region]);

  useEffect(() => {
    engine.current?.setTool(view === 'original' ? 'select' : tool);
  }, [tool, view, quality, mode]);
  useEffect(() => engine.current?.setLayers(layers), [layers, quality, mode]);
  useEffect(() => engine.current?.setLineMode(lineMode), [lineMode, quality, mode]);
  useEffect(() => {
    if (engine.current) {
      engine.current.running = running;
      engine.current.speed = speed;
    }
  }, [running, speed, quality, mode]);

  // Load real-world data for the project's location.
  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    const center = { lat: project.place.lat, lon: project.place.lon };
    const terrain = fetchTerrain(center, project.radius, ctrl.signal);
    Promise.all([fetchWorld(center, project.radius, ctrl.signal), terrain])
      .then(([w, t]) => {
        if (!w.buildings.length && !w.roads.length) setError('No mapped streets or buildings were found here. Try a more central location.');
        setBase({ ...w, terrain: t });
        // Water and parks stream in afterwards; the city is usable without them.
        fetchAreas(center, project.radius, ctrl.signal)
          .then((areas) => setBase((b) => (b ? { ...b, areas } : b)))
          .catch(() => setHint('Water and parks could not be loaded right now (map servers busy).'));
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message || 'Could not load map data.');
      });
    return () => ctrl.abort();
  }, [project.place.lat, project.place.lon, project.radius, attempt]);

  // Autosave edits.
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    setSaveState('saving');
    const t = setTimeout(() => {
      const next = { ...project, edits: history.edits };
      setProject(next);
      setSaveState(saveProject(next) ? 'saved' : 'error');
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.edits]);

  // Global shortcuts: undo/redo and tool switching.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        setHistory(redo);
      } else if (!e.metaKey && !e.ctrlKey) {
        const t = TOOLS.find((x) => x.key === e.key);
        if (t) setTool(t.id);
        if (e.key === ' ') {
          e.preventDefault();
          setRunning((r) => !r);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setCam = (m: CameraMode) => engine.current?.setCameraMode(m);
  const dismissOnboard = () => {
    setOnboard(false);
    try {
      localStorage.setItem(ONBOARD_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  const editable = view === 'proposed';
  const loading = !base && !error;

  return (
    <div className="world">
      <div className="viewport" ref={host} />

      <header className="topbar">
        <button className="brand small" onClick={onExit} title="Back to start"><span className="logo" /><span className="hide-sm">Global City Simulator</span></button>
        <div className="project">
          <input
            value={project.name}
            aria-label="Project name"
            onChange={(e) => setProject({ ...project, name: e.target.value })}
            onBlur={() => setSaveState(saveProject(project) ? 'saved' : 'error')}
          />
          <span className={`save ${saveState}`}>{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : 'Not saved'}</span>
        </div>
        <SearchBox compact onPick={onOpenPlace} />
        <div className="top-actions">
          <div className="seg" role="group" aria-label="Scenario">
            <button className={view === 'original' ? 'on' : ''} onClick={() => setView('original')}>Original</button>
            <button className={view === 'proposed' ? 'on' : ''} onClick={() => setView('proposed')}>Proposed{history.edits.length ? ` · ${history.edits.length}` : ''}</button>
          </div>
          <select value={quality} onChange={(e) => {
            const q = e.target.value as QualitySetting;
            setQuality(q);
            try { localStorage.setItem(QUALITY_KEY, q); } catch { /* ignore */ }
          }} aria-label="Graphics quality">
            <option value="auto">Graphics: Auto</option>
            <option value="low">Graphics: Low</option>
            <option value="medium">Graphics: Medium</option>
            <option value="high">Graphics: High</option>
          </select>
        </div>
      </header>

      <nav className="panel toolbar" aria-label="Planning tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id && editable ? 'on' : ''} disabled={!editable && t.id !== 'select'} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`} aria-label={t.label}>
            <span className="ico">{t.icon}</span>
            <span className="lbl">{t.label.split(' ')[0]}</span>
          </button>
        ))}
        <hr />
        <button onClick={() => setHistory(undo)} disabled={!history.edits.length} title="Undo (Ctrl/Cmd+Z)" aria-label="Undo"><span className="ico">↶</span><span className="lbl">Undo</span></button>
        <button onClick={() => setHistory(redo)} disabled={!history.redo.length} title="Redo (Shift+Ctrl/Cmd+Z)" aria-label="Redo"><span className="ico">↷</span><span className="lbl">Redo</span></button>
      </nav>

      <div className="panel cambar" role="group" aria-label="Camera">
        <button
          className="mode-btn"
          onClick={() => {
            const m = mode === '3d' ? '2d' : '3d';
            setMode(m);
            try { localStorage.setItem(VIEW_KEY, m); } catch { /* ignore */ }
          }}
          title="Switch between the 3D city and the 2D plan view"
        >
          {mode === '3d' ? '2D plan' : '3D view'}
        </button>
        <button onClick={() => setCam('aerial')}>Aerial</button>
        <button onClick={() => setCam('neighborhood')}>District</button>
        <button onClick={() => setCam('street')}>Street</button>
        {mode === '3d' && <>
          <button onClick={() => engine.current?.orbitStep(Math.PI / 4)} aria-label="Orbit left">⟲</button>
          <button onClick={() => engine.current?.orbitStep(-Math.PI / 4)} aria-label="Orbit right">⟳</button>
        </>}
      </div>

      <div className="panel layers" role="group" aria-label="Layers">
        <label><input type="checkbox" checked={layers.agents} onChange={(e) => setLayers({ ...layers, agents: e.target.checked })} /> People & vehicles</label>
        <label><input type="checkbox" checked={layers.traffic} onChange={(e) => setLayers({ ...layers, traffic: e.target.checked })} /> Traffic flow</label>
        <label><input type="checkbox" checked={layers.transit} onChange={(e) => setLayers({ ...layers, transit: e.target.checked })} /> Bus routes</label>
        <label><input type="checkbox" checked={layers.estimated} onChange={(e) => setLayers({ ...layers, estimated: e.target.checked })} /> Highlight estimated data</label>
      </div>

      {selection && (
        <Inspector
          sel={selection}
          editable={editable}
          onEdit={edit}
          onFocus={() => engine.current?.focusSelected()}
          following={selection.type === 'agent' && following === selection.agent.id}
          onFollow={(id) => {
            setFollowing(id);
            engine.current?.follow(id);
          }}
          onClose={() => engine.current?.select(null)}
        />
      )}

      <button className={`panel dash-toggle ${dashOpen ? 'on' : ''}`} onClick={() => setDashOpen(!dashOpen)} aria-expanded={dashOpen}>
        {dashOpen ? 'Hide' : 'Show'} dashboard
      </button>
      {dashOpen && proposedMetrics && originalMetrics && (
        <Dashboard stats={stats} proposed={proposedMetrics} original={originalMetrics} region={region} editCount={history.edits.length} onRemoveLine={editable ? (id) => edit({ kind: 'removeLine', id }) : undefined} />
      )}

      <SimBar
        stats={stats} running={running} speed={speed}
        onRun={setRunning} onSpeed={setSpeed}
        onTime={(t) => {
          engine.current?.setTime(t);
          if (stats) setStats({ ...stats, time: t });
        }}
        onReset={() => engine.current?.resetSim()}
      />

      {tool === 'transit' && editable && (
        <div className="panel linebar" role="group" aria-label="New transit line">
          <div className="seg">
            <button className={lineMode === 'bus' ? 'on' : ''} onClick={() => setLineMode('bus')}>Bus</button>
            <button className={lineMode === 'metro' ? 'on' : ''} onClick={() => setLineMode('metro')}>Elevated metro</button>
          </div>
          <button className="primary" onClick={() => engine.current?.finishLine()}>Finish line</button>
          <button className="ghost" onClick={() => setTool('select')}>Done</button>
        </div>
      )}

      {hint && <div className="hint" role="status">{hint}<button className="icon-btn" onClick={() => setHint(null)} aria-label="Dismiss">✕</button></div>}

      <footer className="attribution">
        {base && <span>{fmt(base.buildings.length)} buildings · {originalMetrics ? Math.round(originalMetrics.estimatedHeights * 100) : 0}% heights estimated · </span>}
        {perf && <span className="hide-sm">{Math.round(perf.fps)} fps · {perf.quality} · </span>}
        Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors
        {base?.terrain && <> · Terrain: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noreferrer">AWS Terrain Tiles</a></>}
      </footer>

      {(loading || error) && (
        <div className="overlay">
          <div className="overlay-card">
            {error ? (
              <><h2>Couldn’t load this place</h2><p>{error}</p><div className="row"><button onClick={() => setAttempt((a) => a + 1)}>Try again</button><button className="ghost" onClick={onExit}>Back</button></div></>
            ) : (
              <><div className="spinner" /><h2>Building {project.place.name}</h2><p>Loading real streets, buildings and rail lines within {project.radius} m from OpenStreetMap…</p></>
            )}
          </div>
        </div>
      )}

      {onboard && base && (
        <div className="panel coach" role="dialog" aria-label="Quick tour">
          <h3>Welcome to {project.place.name}</h3>
          <ol>
            <li><b>Drag</b> to orbit 360°, <b>right-drag</b> or WASD to pan, <b>scroll</b> or pinch to zoom.</li>
            <li><b>Click</b> a building, road, person or vehicle to inspect it. <b>Double-click</b> to orbit around it.</li>
            <li>Use the tools on the left to build, draw roads or bulldoze. Undo anytime.</li>
            <li>Watch the dashboard: housing, jobs and live traffic update with your plan.</li>
            <li>Toggle <b>Original / Proposed</b> to compare. Everything autosaves.</li>
          </ol>
          <button onClick={dismissOnboard}>Start exploring</button>
        </div>
      )}
    </div>
  );
}
