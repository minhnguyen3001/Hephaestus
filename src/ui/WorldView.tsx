import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchAreas, fetchStations, fetchWorld } from '../geo/osm';
import { fetchTerrain } from '../geo/terrain';
import { loadedRadius, mergeWorld, TileStream } from '../geo/tiles';
import { CONTEXT_RADIUS, contextTileKeys, fetchContextTile, type ContextTile } from '../geo/vectortiles';
import type { Place, WorldData } from '../geo/types';
import { applyEdits, pushEdit, redo, undo, type Edit, type History } from '../project/edits';
import { encodePlan } from '../project/share';
import { saveProject, withScenarios, type Project, type Scenario } from '../project/store';
import { Engine, type CameraMode, type Layers, type Perf, type Selection, type Tool, type WorldRenderer } from '../render/engine';
import type { ZoneOptions } from '../render/tools';
import { Plan2D } from '../render/plan2d';
import { PRESETS, resolveQuality, type QualitySetting } from '../render/quality';
import { profileFor } from '../sim/region';
import type { CityEvent, DayType, SimStats, Weather } from '../sim/simulation';
import type { Vec2 } from '../geo/types';
import { cityMetrics } from './metrics';
import { Dashboard, fmt, Inspector, SimBar } from './Panels';
import { SearchBox } from './SearchBox';
import { Tour, type TourSignals } from './Tour';
import { suggested } from './challenges';
import { advise, type Insight } from './advisor';

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'select', label: 'Select & inspect', key: '1', icon: '➚' },
  { id: 'build', label: 'Place building', key: '2', icon: '▦' },
  { id: 'road', label: 'Draw road', key: '3', icon: '⟋' },
  { id: 'bulldoze', label: 'Bulldoze', key: '4', icon: '✕' },
  { id: 'transit', label: 'Transit line', key: '5', icon: '⇆' },
  { id: 'zone', label: 'Zone area', key: '6', icon: '▣' },
  { id: 'note', label: 'Note pin', key: '7', icon: '✎' },
  { id: 'event', label: 'Event crowd', key: '8', icon: '★' },
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
  const [project, setProject] = useState(() => withScenarios(initial));
  const projectRef = useRef(project);
  projectRef.current = project;
  const [base, setBase] = useState<WorldData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<History>(() => {
    const p = withScenarios(initial);
    return { edits: p.scenarios.find((s) => s.id === p.active)!.edits, redo: [] };
  });
  const [view, setView] = useState<'proposed' | 'original'>('proposed');
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [following, setFollowing] = useState<number | null>(null);
  const [stats, setStats] = useState<SimStats | null>(null);
  const [perf, setPerf] = useState<Perf | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [quality, setQuality] = useState<QualitySetting>(readQuality);
  const [layers, setLayers] = useState<Layers>({ agents: true, transit: true, estimated: false, traffic: false, trees: true, underground: false });
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [lineMode, setLineMode] = useState<'bus' | 'metro'>('bus');
  const [day, setDay] = useState<DayType>('weekday');
  const [horizon, setHorizon] = useState(0);
  const [weather, setWeather] = useState<Weather>('clear');
  const [events, setEvents] = useState<CityEvent[]>([]);
  const statsRef = useRef<SimStats | null>(null);
  statsRef.current = stats;
  const hourlyRef = useRef<(number | null)[]>(Array(24).fill(null));
  if (stats) {
    // smoothed congestion per simulated hour, for the dashboard chart
    const h = Math.floor(stats.time / 3600) % 24;
    const prev = hourlyRef.current[h];
    hourlyRef.current[h] = prev === null ? stats.congestion : prev * 0.9 + stats.congestion * 0.1;
  }
  const [zoneOpts, setZoneOpts] = useState<ZoneOptions>({ use: 'mixed', density: 'medium', replace: false });
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
  const [tiles, setTiles] = useState<{ loaded: number; pending: number; budget: number } | null>(null);
  const [ctxTiles, setCtxTiles] = useState<ContextTile[]>([]);
  const [detailKeys, setDetailKeys] = useState<string[]>(['0,0']);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [tour, setTour] = useState<TourSignals>({ cameraMoved: false, inspected: false, orbited: false, edited: false, compared: false, fast: false });
  const mark = useCallback((k: keyof TourSignals) => setTour((t) => (t[k] ? t : { ...t, [k]: true })), []);

  const host = useRef<HTMLDivElement>(null);
  const pendingView = useRef(true);
  const streamRef = useRef<TileStream | null>(null);
  const restoreView = (r: WorldRenderer) => {
    if (!pendingView.current) return;
    pendingView.current = false;
    const v = mode === '3d' ? projectRef.current.view3d : projectRef.current.view2d;
    if (v) r.setView(v);
  };
  const engine = useRef<WorldRenderer | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const region = useMemo(() => profileFor(project.place.countryCode), [project.place.countryCode]);
  const proposed = useMemo(() => (base ? applyEdits(base, history.edits) : null), [base, history.edits]);
  const shown = view === 'original' ? base : proposed;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const originalMetrics = useMemo(() => (base ? cityMetrics(base) : null), [base]);
  const activeScenario = project.scenarios.find((s) => s.id === project.active)!;
  // Static indicators for every scenario, for side-by-side comparison (the active one uses live edits).
  const comparison = useMemo(
    () => (base && project.scenarios.length > 1
      ? project.scenarios.map((s) => ({ name: s.name, active: s.id === project.active, metrics: cityMetrics(applyEdits(base, s.id === project.active ? history.edits : s.edits)) }))
      : null),
    [base, project.scenarios, project.active, history.edits],
  );
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
      onContextLost: () => {
        setHint('The graphics device was reset, so the city was rebuilt at Low quality. You can raise it again in Graphics.');
        setQuality((q) => (q === 'low' ? 'medium' : 'low')); // forces a fresh renderer
      },
      onPlaceEvent: (p: Vec2) => {
        const now = statsRef.current?.time ?? 7.5 * 3600;
        const start = Math.ceil((now + 3600) / 900) * 900 % 86400;
        const attendance = 8000;
        setEvents((es) => [...es, { id: `ev-${Date.now().toString(36)}`, p, start, attendance, name: es.length % 2 ? 'Stadium game' : 'Concert' }]);
        setHint(`Event at ${String(Math.floor(start / 3600)).padStart(2, '0')}:${String(Math.floor((start % 3600) / 60)).padStart(2, '0')} — 8,000 people will start arriving now. Speed up time and watch the streets and transit.`);
      },
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
    pendingView.current = true;
    if (shownRef.current) {
      r.setWorld(shownRef.current, region);
      restoreView(r);
    }
    return () => {
      r.dispose();
      engine.current = null;
    };
  }, [quality, region, edit, mode]);

  useEffect(() => {
    if (!shown || !engine.current) return;
    engine.current.setWorld(shown, region);
    restoreView(engine.current);
  }, [shown, region]);

  // Remember the camera per project (and per 2D/3D view).
  useEffect(() => {
    const t = setInterval(() => {
      const r = engine.current;
      if (!r || pendingView.current) return;
      const v = r.getView();
      const key = mode === '3d' ? 'view3d' : 'view2d';
      const p = projectRef.current;
      if (JSON.stringify(p[key]) === JSON.stringify(v)) return;
      const next = { ...p, [key]: v };
      setProject(next);
      saveProject(next);
    }, 4000);
    return () => clearInterval(t);
  }, [mode]);

  useEffect(() => {
    engine.current?.setTool(view === 'original' ? 'select' : tool);
  }, [tool, view, quality, mode]);
  useEffect(() => engine.current?.setLayers(layers), [layers, quality, mode]);
  useEffect(() => engine.current?.setLineMode(lineMode), [lineMode, quality, mode]);
  useEffect(() => engine.current?.setZoneOptions(zoneOpts), [zoneOpts, quality, mode]);
  useEffect(
    () => engine.current?.setSimParams({ day, demandScale: (1 + region.growth) ** horizon, weather, events }),
    [day, horizon, weather, events, region, quality, mode],
  );
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
    // Terrain never blocks the city: it drapes in when the tiles arrive.
    const terrain = fetchTerrain(center, CONTEXT_RADIUS, ctrl.signal).catch(() => undefined);
    fetchWorld(center, project.radius, ctrl.signal)
      .then((w) => {
        if (!w.buildings.length && !w.roads.length) setError('No mapped streets or buildings were found here. Try a more central location.');
        setBase(w);
        terrain.then((t) => t && setBase((b) => (b ? { ...b, terrain: t } : b)));
        // Water and parks stream in afterwards; the city is usable without them.
        fetchAreas(center, project.radius, ctrl.signal)
          .then((extra) => setBase((b) => (b ? { ...b, ...extra } : b)))
          .catch(() => setHint('Water and parks could not be loaded right now (map servers busy).'));
        fetchStations(center, project.radius, ctrl.signal)
          .then((stations) => stations?.length && setBase((b) => (b ? { ...b, stations } : b)))
          .catch(() => undefined); // trains still run end-to-end without station data
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
      const p = projectRef.current;
      const next = { ...p, edits: history.edits, scenarios: p.scenarios.map((s) => (s.id === p.active ? { ...s, edits: history.edits } : s)) };
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

  // The advisor re-reads the plan and live simulation every few seconds.
  const adviseRef = useRef({ proposed, proposedMetrics, originalMetrics, stats });
  adviseRef.current = { proposed, proposedMetrics, originalMetrics, stats };
  useEffect(() => {
    if (!dashOpen) return;
    const run = () => {
      const a = adviseRef.current;
      if (a.proposed && a.proposedMetrics && a.originalMetrics) setInsights(advise(a.proposed, a.proposedMetrics, a.originalMetrics, a.stats, engine.current?.roadSpeeds() ?? new Map()));
    };
    run();
    const t = setInterval(run, 4000);
    return () => clearInterval(t);
  }, [dashOpen, base]);

  // The city streams in as 1 km tiles around wherever the user looks (nearest first, within a budget).
  const baseReady = !!base;
  useEffect(() => {
    if (!baseReady) return;
    const center = { lat: project.place.lat, lon: project.place.lon };
    const incoming: WorldData[] = [];
    const stream = (streamRef.current = new TileStream(
      center,
      PRESETS[resolveQuality(quality)].tiles,
      (w) => incoming.push(w),
      (loaded, pending, budget) => setTiles({ loaded, pending, budget }),
    ));
    stream.seed(['0,0']); // the initial load already covers the centre tile
    stream.want(0, 0, 1);
    // Batch tile arrivals so the scene and simulation update every few seconds, not per tile.
    const flush = setInterval(() => {
      if (!incoming.length) return;
      const batch = incoming.splice(0);
      setBase((b) => {
        if (!b) return b;
        let m = b;
        for (const w of batch) m = mergeWorld(m, w);
        return { ...m, radius: loadedRadius(stream.loaded, b.radius) };
      });
      setDetailKeys([...stream.loaded]);
    }, 2500);
    const look = setInterval(() => {
      const v = engine.current?.getView();
      const c: [number, number] | undefined = v?.target ? [v.target[0], -v.target[2]] : v?.center;
      if (c) stream.want(c[0], c[1], 1);
    }, 1500);
    return () => {
      streamRef.current = null;
      stream.dispose();
      clearInterval(flush);
      clearInterval(look);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseReady, project.place.lat, project.place.lon]);

  // City ring: lightweight buildings/roads out to 5 km (10 km across) from free vector tiles, nearest first.
  useEffect(() => {
    if (!baseReady) return;
    const center = { lat: project.place.lat, lon: project.place.lon };
    const ctrl = new AbortController();
    const queue = contextTileKeys(center, PRESETS[resolveQuality(quality)].ring);
    const done: ContextTile[] = [];
    let active = 0;
    const next = () => {
      while (active < 4 && queue.length) {
        const k = queue.shift()!;
        active++;
        fetchContextTile(center, k.x, k.y, ctrl.signal)
          .then((t) => done.push(t))
          .catch(() => undefined)
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
    const flush = setInterval(() => {
      if (done.length) setCtxTiles((cur) => (cur.length === done.length ? cur : [...done]));
    }, 1200);
    return () => {
      ctrl.abort();
      clearInterval(flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseReady, project.place.lat, project.place.lon, quality]);

  const terrainRef = base?.terrain;
  useEffect(() => {
    engine.current?.setContext(ctxTiles, { radius: project.radius, tiles: detailKeys });
  }, [ctxTiles, detailKeys, terrainRef, project.radius, quality, mode]);

  const loadDetail = (p: Vec2) => {
    const s = streamRef.current;
    if (!s) return;
    if (s.atBudget) return setHint('The detailed-map budget for this graphics setting is used up. Raise Graphics quality to load more.');
    s.want(p[0], p[1], 0);
    setHint('Loading the detailed map here. Buildings become editable when it arrives (usually a few seconds; longer outside featured cities).');
    engine.current?.select(null);
  };

  // Terrain follows the loaded area: re-fetch (cached tiles, finer grid) when the city grows.
  const radius = base?.radius;
  useEffect(() => {
    if (!radius || radius <= project.radius) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetchTerrain({ lat: project.place.lat, lon: project.place.lon }, radius, ctrl.signal)
        .then((tr) => tr && setBase((b) => (b ? { ...b, terrain: tr } : b)))
        .catch(() => undefined);
    }, 3000);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [radius, project.place.lat, project.place.lon, project.radius]);

  // Tour progress comes from what the user actually does.
  useEffect(() => {
    if (!onboard || !base) return;
    const start = JSON.stringify(engine.current?.getView());
    const t = setInterval(() => {
      if (JSON.stringify(engine.current?.getView()) !== start) mark('cameraMoved');
    }, 600);
    return () => clearInterval(t);
  }, [onboard, base, mark]);
  useEffect(() => {
    if (selection) mark('inspected');
  }, [selection, mark]);
  useEffect(() => {
    if (history.edits.length) mark('edited');
  }, [history.edits.length, mark]);
  useEffect(() => {
    if (view === 'original') mark('compared');
  }, [view, mark]);
  useEffect(() => {
    if (speed >= 20) mark('fast');
  }, [speed, mark]);

  const commit = (next: typeof project) => {
    projectRef.current = next;
    setProject(next);
    setSaveState(saveProject(next) ? 'saved' : 'error');
  };
  const withLiveEdits = () => {
    const p = projectRef.current;
    return { ...p, scenarios: p.scenarios.map((s) => (s.id === p.active ? { ...s, edits: history.edits } : s)) };
  };
  const switchScenario = (id: string, p = withLiveEdits()) => {
    const target = p.scenarios.find((s) => s.id === id);
    if (!target) return;
    commit({ ...p, active: id, edits: target.edits });
    setHistory({ edits: target.edits, redo: [] });
    setView('proposed');
    engine.current?.select(null);
  };
  const scenarioAction = (v: string) => {
    const p = withLiveEdits();
    if (v === '__new' || v === '__dup') {
      const used = new Set(p.scenarios.map((s) => s.name));
      let n = p.scenarios.length;
      while (used.has(`Proposal ${String.fromCharCode(65 + (n % 26))}`)) n++;
      const sc: Scenario = { id: `s${Date.now().toString(36)}`, name: `Proposal ${String.fromCharCode(65 + (n % 26))}`, edits: v === '__dup' ? history.edits : [] };
      switchScenario(sc.id, { ...p, scenarios: [...p.scenarios, sc] });
      setHint(v === '__dup' ? `${sc.name} starts as a copy — change it and compare in the dashboard.` : `${sc.name} starts from today’s city.`);
    } else if (v === '__ren') {
      const name = window.prompt('Rename scenario', activeScenario.name)?.trim();
      if (name) commit({ ...p, scenarios: p.scenarios.map((s) => (s.id === p.active ? { ...s, name } : s)) });
    } else if (v === '__del') {
      if (p.scenarios.length < 2 || !window.confirm(`Delete “${activeScenario.name}”? This cannot be undone.`)) return;
      const rest = p.scenarios.filter((s) => s.id !== p.active);
      switchScenario(rest[0].id, { ...p, scenarios: rest });
    } else switchScenario(v, p);
  };
  const share = async () => {
    const code = await encodePlan({
      v: 1, name: `${project.name} — ${activeScenario.name}`, place: project.place, radius: project.radius,
      edits: history.edits, view: engine.current?.getView(),
    });
    const url = `${location.origin}${location.pathname}#plan=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      setHint('Share link copied. Anyone can open this plan — no account needed.');
    } catch {
      window.prompt('Copy this link to share your plan:', url);
    }
  };
  const dismissOnboard = useCallback(() => {
    setOnboard(false);
    try {
      localStorage.setItem(ONBOARD_KEY, '1');
    } catch {
      /* ignore */
    }
  }, []);
  const editable = view === 'proposed';
  const loading = !base && !error;

  return (
    <div className="world">
      <div className="viewport" ref={host} />

      <header className="topbar">
        <button className="brand small" onClick={onExit} title="Back to start"><span className="logo" /><span className="hide-sm">Ptah</span></button>
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
          <div className="seg" role="group" aria-label="Original or proposed city">
            <button className={view === 'original' ? 'on' : ''} onClick={() => setView('original')}>Original</button>
            <button className={view === 'proposed' ? 'on' : ''} onClick={() => setView('proposed')}>Proposed{history.edits.length ? ` · ${history.edits.length}` : ''}</button>
          </div>
          <select className="scenario" value={project.active} onChange={(e) => scenarioAction(e.target.value)} aria-label="Scenario">
            {project.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__new">+ New scenario</option>
            <option value="__dup">+ Duplicate this one</option>
            <option value="__ren">Rename…</option>
            {project.scenarios.length > 1 && <option value="__del">Delete this scenario</option>}
          </select>
          <button className="share-btn" onClick={share} title="Copy a link to this plan">Share</button>
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
        <button onClick={() => setCam('city')} title="See the whole 10 km city">City</button>
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
        <label title="Mapped OSM trees plus illustrative planting in parks"><input type="checkbox" checked={layers.trees} onChange={(e) => setLayers({ ...layers, trees: e.target.checked })} /> Trees <small className="muted">(park trees illustrative)</small></label>
        <label><input type="checkbox" checked={layers.underground} onChange={(e) => setLayers({ ...layers, underground: e.target.checked })} /> Underground (x-ray)</label>
        <label><input type="checkbox" checked={layers.estimated} onChange={(e) => setLayers({ ...layers, estimated: e.target.checked })} /> Highlight estimated data</label>
      </div>

      {selection && (
        <Inspector
          sel={selection}
          editable={editable}
          onEdit={edit}
          onFocus={() => {
            mark('orbited');
            engine.current?.focusSelected();
          }}
          onLoadDetail={loadDetail}
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
        <Dashboard hourly={hourlyRef.current} stats={stats} proposed={proposedMetrics} original={originalMetrics} region={region} editCount={history.edits.length} comparison={comparison} horizon={horizon}
          challenge={project.challenge}
          suggestedChallenge={suggested(project.place.name, project.place.countryCode)?.id}
          onChallenge={(id) => commit({ ...projectRef.current, challenge: id })}
          insights={insights}
          notes={proposed?.notes ?? []}
          events={events}
          onRemoveEvent={(id) => setEvents((es) => es.filter((e) => e.id !== id))}
          onRemoveNote={editable ? (id) => edit({ kind: 'removeNote', id }) : undefined}
          onLook={(p) => engine.current?.lookAt(p)}
          onRemoveLine={editable ? (id) => edit({ kind: 'removeLine', id }) : undefined} />
      )}

      <SimBar
        stats={stats} running={running} speed={speed}
        onRun={setRunning} onSpeed={setSpeed}
        onTime={(t) => {
          engine.current?.setTime(t);
          if (stats) setStats({ ...stats, time: t });
        }}
        onReset={() => { hourlyRef.current = Array(24).fill(null); engine.current?.resetSim(); }}
        day={day} onDay={setDay} horizon={horizon} onHorizon={setHorizon} growth={region.growth} weather={weather} onWeather={setWeather}
        lon={project.place.lon} traffic={layers.traffic} onTraffic={(on) => setLayers({ ...layers, traffic: on })}
      />

      {tool === 'transit' && editable && (
        <div className="panel linebar" role="group" aria-label="New transit line">
          <div className="seg">
            <button className={lineMode === 'bus' ? 'on' : ''} onClick={() => setLineMode('bus')}>Bus</button>
            <button className={lineMode === 'metro' ? 'on' : ''} onClick={() => setLineMode('metro')}>Elevated metro</button>
          </div>
          <button className="primary" onClick={() => engine.current?.finishDraft()}>Finish line</button>
          <button className="ghost" onClick={() => setTool('select')}>Done</button>
        </div>
      )}

      {tool === 'zone' && editable && (
        <div className="panel linebar" role="group" aria-label="New zone">
          <select value={zoneOpts.use} onChange={(e) => setZoneOpts({ ...zoneOpts, use: e.target.value as ZoneOptions['use'] })} aria-label="Zone use">
            <option value="residential">Residential</option>
            <option value="commercial">Commercial</option>
            <option value="office">Office</option>
            <option value="mixed">Mixed-use</option>
            <option value="industrial">Industrial</option>
            <option value="park">Park</option>
          </select>
          {zoneOpts.use !== 'park' && (
            <div className="seg" role="group" aria-label="Density">
              {(['low', 'medium', 'high'] as const).map((d) => (
                <button key={d} className={zoneOpts.density === d ? 'on' : ''} onClick={() => setZoneOpts({ ...zoneOpts, density: d })}>{d[0].toUpperCase() + d.slice(1)}</button>
              ))}
            </div>
          )}
          {zoneOpts.use !== 'park' && (
            <label className="check"><input type="checkbox" checked={zoneOpts.replace} onChange={(e) => setZoneOpts({ ...zoneOpts, replace: e.target.checked })} /> Replace existing</label>
          )}
          <button className="primary" onClick={() => engine.current?.finishDraft()}>Finish zone</button>
          <button className="ghost" onClick={() => setTool('select')}>Done</button>
        </div>
      )}


      {hint && <div className="hint" role="status">{hint}<button className="icon-btn" onClick={() => setHint(null)} aria-label="Dismiss">✕</button></div>}

      <footer className="attribution">
        {base && <span className="hide-sm">{fmt(base.buildings.length)} buildings · {originalMetrics ? Math.round(originalMetrics.estimatedHeights * 100) : 0}% heights estimated · </span>}
        {tiles && <span className="hide-sm">map {tiles.loaded}/{tiles.budget} km²{tiles.pending ? ` · loading ${tiles.pending}…` : ''} · </span>}
        {perf && perf.pending > 0 && <span className="hide-sm">building scene… · </span>}
        {perf && <span className="hide-sm perf" title={`${perf.drawCalls} draw calls · ${(perf.triangles / 1e6).toFixed(2)}M triangles`}>{Math.round(perf.fps)} fps · {perf.frameMs.toFixed(1)} ms · {perf.quality} · </span>}
        Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors
        {ctxTiles.length > 0 && <> · <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a></>}
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

      {onboard && base && <Tour place={project.place.name} signals={tour} onClose={dismissOnboard} />}
    </div>
  );
}
