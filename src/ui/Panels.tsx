import { useEffect, useState } from 'react';
import type { Building, BuildingUse } from '../geo/types';
import { centroid, signedArea } from '../geo/util';
import type { Edit } from '../project/edits';
import type { AgentInfo, Selection } from '../render/engine';
import type { RegionProfile } from '../sim/region';
import { AGENT_KINDS, buildingCapacity, type CityEvent, type DayType, type SimStats, type Weather } from '../sim/simulation';
import type { Note, Vec2 } from '../geo/types';
import type { Insight } from './advisor';
import { CHALLENGES, evaluate } from './challenges';
import type { CityMetrics } from './metrics';

const USES: BuildingUse[] = ['residential', 'commercial', 'office', 'industrial', 'education', 'health', 'civic', 'religious', 'parking', 'unknown'];
const HEIGHT_SOURCE: Record<string, [string, string]> = {
  'osm-height': ['Measured', 'Height tag in OpenStreetMap'],
  'osm-levels': ['From floors', 'Computed from the floor count in OpenStreetMap'],
  estimated: ['Estimated', 'No height data — procedurally estimated from building type'],
  user: ['Your change', 'Set in this proposal'],
};
const KIND_LABEL: Record<string, string> = {
  pedestrian: 'Pedestrians', bicycle: 'Cyclists', motorcycle: 'Motorbikes', car: 'Cars', taxi: 'Taxis', truck: 'Trucks', bus: 'Buses', emergency: 'Emergency',
};
export const fmt = (n: number) => (Math.abs(n) >= 10000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString());

export function Inspector({
  sel, editable, onEdit, onFocus, onFollow, following, onClose, onLoadDetail,
}: {
  sel: Selection;
  editable: boolean;
  onEdit: (e: Edit) => void;
  onFocus: () => void;
  onFollow: (id: number | null) => void;
  following: boolean;
  onClose: () => void;
  onLoadDetail?: (p: Vec2) => void;
}) {
  return (
    <aside className="panel inspector" aria-label="Inspector">
      <button className="icon-btn close" onClick={onClose} aria-label="Close inspector">✕</button>
      {sel.type === 'building' && sel.overview && (
        <>
          <p className="eyebrow">Building · overview data</p>
          <h3>Building</h3>
          <div className="badges"><span className="badge estimated" title="From OpenFreeMap vector tiles (OpenMapTiles schema)">City-ring data</span></div>
          <dl>
            <dt>Height</dt><dd>{Math.round(sel.building.height)} m · ~{Math.max(1, Math.round(sel.building.height / 3.2))} floors</dd>
            <dt>Footprint</dt><dd>{fmt(Math.abs(signedArea(sel.building.footprint)))} m²</dd>
            <dt>Source</dt><dd>OpenFreeMap © OpenMapTiles © OpenStreetMap</dd>
          </dl>
          <p className="note">This area is shown as lightweight overview data. Load the detailed map here to see its use, simulate it and edit it.</p>
          <div className="row">
            <button onClick={onFocus}>Orbit 360°</button>
            {onLoadDetail && <button className="primary" onClick={() => onLoadDetail(centroid(sel.building.footprint))}>Load detail here</button>}
          </div>
        </>
      )}
      {sel.type === 'building' && !sel.overview && <BuildingInspector b={sel.building} editable={editable} onEdit={onEdit} onFocus={onFocus} />}
      {sel.type === 'road' && (
        <>
          <p className="eyebrow">{sel.road.origin === 'proposed' ? 'Proposed road' : 'Road · OpenStreetMap'}</p>
          <h3>{sel.road.name ?? `Unnamed ${sel.road.kind} road`}</h3>
          <dl>
            <dt>Type</dt><dd>{sel.road.kind === 'footway' ? 'pedestrian' : sel.road.kind}</dd>
          </dl>
          {sel.road.kind !== 'footway' && sel.road.kind !== 'cycleway' ? (
            <>
              <label className="field">
                <span>Lanes <strong>{sel.road.lanes}</strong></span>
                <input type="range" min={1} max={8} step={1} value={sel.road.lanes} disabled={!editable} onChange={(e) => onEdit({ kind: 'setRoad', id: sel.road.id, patch: { lanes: +e.target.value } })} />
              </label>
              <label className="field">
                <span>Speed limit</span>
                <select value={Math.round(sel.road.maxspeedKmh / 10) * 10} disabled={!editable} onChange={(e) => onEdit({ kind: 'setRoad', id: sel.road.id, patch: { maxspeedKmh: +e.target.value } })}>
                  {[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((v) => <option key={v} value={v}>{v} km/h</option>)}
                </select>
              </label>
              <label className="field row-check">
                <input type="checkbox" checked={sel.road.oneway} disabled={!editable} onChange={(e) => onEdit({ kind: 'setRoad', id: sel.road.id, patch: { oneway: e.target.checked } })} /> One-way
              </label>
              <label className="field row-check">
                <input type="checkbox" checked={!!sel.road.bikeLane} disabled={!editable} onChange={(e) => onEdit({ kind: 'setRoad', id: sel.road.id, patch: { bikeLane: e.target.checked } })} /> Bike lanes
              </label>
              {editable && <button onClick={() => onEdit({ kind: 'setRoad', id: sel.road.id, patch: { kind: 'footway', oneway: false } })}>Make pedestrian street</button>}
            </>
          ) : <p className="note">Pedestrian/cycle path — cars can’t use it.</p>}
          <div className="row">
            <button onClick={onFocus}>Orbit view</button>
            {editable && <button className="danger" onClick={() => onEdit({ kind: 'removeRoad', id: sel.road.id })}>Remove road</button>}
          </div>
        </>
      )}
      {sel.type === 'agent' && <AgentInspector a={sel.agent} following={following} onFollow={onFollow} />}
    </aside>
  );
}

function BuildingInspector({ b, editable, onEdit, onFocus }: { b: Building; editable: boolean; onEdit: (e: Edit) => void; onFocus: () => void }) {
  const [h, setH] = useState(b.height);
  useEffect(() => setH(b.height), [b.id, b.height]);
  const area = Math.abs(signedArea(b.footprint));
  const cap = buildingCapacity({ ...b, height: h });
  const [label, tip] = HEIGHT_SOURCE[b.heightSource];
  const commit = () => {
    if (Math.abs(h - b.height) > 0.4) onEdit({ kind: 'setHeight', id: b.id, height: h });
  };
  return (
    <>
      <p className="eyebrow">{b.origin === 'proposed' ? 'Proposed building' : 'Building · OpenStreetMap'}</p>
      <h3>{b.name ?? `${b.use[0].toUpperCase()}${b.use.slice(1)} building`}</h3>
      <div className="badges">
        <span className={`badge ${b.heightSource}`} title={tip}>Height: {label}</span>
        <span className={`badge ${b.useSource === 'estimated' ? 'estimated' : ''}`}>Use: {b.useSource === 'osm' ? 'mapped' : b.useSource}</span>
      </div>
      <label className="field">
        <span>Height <strong>{Math.round(h)} m</strong> · ~{Math.max(1, Math.round(h / 3.2))} floors</span>
        <input
          type="range" min={3} max={400} step={1} value={h} disabled={!editable}
          onChange={(e) => setH(+e.target.value)} onPointerUp={commit} onKeyUp={commit} onBlur={commit}
        />
      </label>
      <label className="field">
        <span>Use</span>
        <select value={b.use} disabled={!editable} onChange={(e) => onEdit({ kind: 'setUse', id: b.id, use: e.target.value as BuildingUse })}>
          {USES.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </label>
      <dl>
        <dt>Footprint</dt><dd>{fmt(area)} m²</dd>
        <dt>Est. residents</dt><dd>{fmt(cap.residents)}</dd>
        <dt>Est. jobs</dt><dd>{fmt(cap.jobs)}</dd>
      </dl>
      <div className="row">
        <button onClick={onFocus}>Orbit 360°</button>
        {editable && (
          <button
            onClick={() => {
              const xs = b.footprint.map((p) => p[0]);
              const dx = Math.max(...xs) - Math.min(...xs) + 8;
              onEdit({
                kind: 'addBuilding',
                building: {
                  ...b, id: `u-b-${Date.now().toString(36)}`, footprint: b.footprint.map(([x, y]) => [x + dx, y] as [number, number]),
                  origin: 'proposed', heightSource: 'user', useSource: 'user', name: `${b.name ?? 'Building'} (copy)`,
                },
              });
            }}
            title="Place a copy next to this building"
          >
            Duplicate
          </button>
        )}
        {editable && <button className="danger" onClick={() => onEdit({ kind: 'demolish', id: b.id })}>Demolish</button>}
      </div>
      {!editable && <p className="note">Switch to <strong>Proposed</strong> to edit.</p>}
    </>
  );
}

function AgentInspector({ a, following, onFollow }: { a: AgentInfo; following: boolean; onFollow: (id: number | null) => void }) {
  return (
    <>
      <p className="eyebrow">Synthetic agent #{a.id}</p>
      <h3>{KIND_LABEL[a.kind]?.replace(/s$/, '') ?? a.kind}</h3>
      <dl>
        <dt>Trip</dt><dd>{a.purpose}</dd>
        {a.from && <><dt>From</dt><dd>{a.from}</dd></>}
        {a.to && <><dt>To</dt><dd>{a.to}</dd></>}
        <dt>Speed</dt><dd>{Math.round(a.speedKmh)} km/h</dd>
        {a.load !== undefined && <><dt>Passengers</dt><dd>{a.load} / {a.cap}</dd></>}
      </dl>
      <button onClick={() => onFollow(following ? null : a.id)}>{following ? 'Stop following' : 'Follow'}</button>
      <p className="note">Simulated person or vehicle — not a real individual.</p>
    </>
  );
}

export function SimBar({
  stats, running, speed, onRun, onSpeed, onTime, onReset, day, onDay, horizon, onHorizon, growth, weather, onWeather, lon, traffic, onTraffic,
}: {
  stats: SimStats | null;
  running: boolean;
  speed: number;
  onRun: (r: boolean) => void;
  onSpeed: (s: number) => void;
  onTime: (t: number) => void;
  onReset: () => void;
  day: DayType;
  onDay: (d: DayType) => void;
  horizon: number;
  onHorizon: (y: number) => void;
  growth: number;
  weather: Weather;
  onWeather: (w: Weather) => void;
  lon: number;
  traffic: boolean;
  onTraffic: (on: boolean) => void;
}) {
  // local clock from longitude (solar time): close to the real time zone, not exact
  const localNow = () => {
    const d = new Date();
    return ((((d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + lon * 240) % 86400) + 86400) % 86400);
  };
  const t = stats?.time ?? 0;
  const hh = String(Math.floor(t / 3600)).padStart(2, '0');
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  return (
    <div className="panel simbar" aria-label="Simulation controls">
      <button className="play" onClick={() => onRun(!running)} aria-label={running ? 'Pause' : 'Play'}>{running ? '❚❚' : '▶'}</button>
      <div className="clock">{hh}:{mm}</div>
      <input type="range" min={0} max={86399} step={300} value={t} onChange={(e) => onTime(+e.target.value)} aria-label="Time of day" className="time" />
      <select value="" onChange={(e) => e.target.value && onTime(e.target.value === 'now' ? localNow() : +e.target.value)} aria-label="Jump to time"
        title="Jump the simulation to a time of day. Traffic is re-seeded for that hour.">
        <option value="">Jump to…</option>
        <option value="now">Now (approx. local)</option>
        <option value={8 * 3600}>08:00 morning rush</option>
        <option value={12 * 3600}>12:00 midday</option>
        <option value={17.5 * 3600}>17:30 evening rush</option>
        <option value={22 * 3600}>22:00 night</option>
        <option value={3 * 3600}>03:00 overnight</option>
      </select>
      <button className={traffic ? 'on traffic' : 'ghost traffic'} aria-pressed={traffic} onClick={() => onTraffic(!traffic)}
        title="Colour streets by live vehicle speed: green flowing, red jammed">Traffic</button>
      <div className="seg" role="group" aria-label="Simulation speed">
        {[1, 5, 20, 60].map((s) => (
          <button key={s} className={speed === s ? 'on' : ''} onClick={() => onSpeed(s)}>{s}×</button>
        ))}
      </div>
      <select value={day} onChange={(e) => onDay(e.target.value as DayType)} aria-label="Day type" className="hide-sm">
        <option value="weekday">Weekday</option>
        <option value="weekend">Weekend</option>
        <option value="holiday">Public holiday</option>
      </select>
      <select value={weather} onChange={(e) => onWeather(e.target.value as Weather)} aria-label="Weather" className="hide-sm">
        <option value="clear">☀ Clear</option>
        <option value="rain">🌧 Rain</option>
        <option value="snow">❄ Snow</option>
        <option value="fog">🌫 Fog</option>
      </select>
      <select value={horizon} onChange={(e) => onHorizon(+e.target.value)} aria-label="Timeline" className="hide-sm"
        title={`Projection assumes travel demand grows ${(growth * 100).toFixed(1)}% per year. Illustrative, not a forecast.`}>
        <option value={0}>Today</option>
        <option value={5}>+5 years</option>
        <option value={10}>+10 years</option>
        <option value={20}>+20 years</option>
      </select>
      <button className="ghost" onClick={onReset} title="Restart the simulation with new synthetic trips">Reset</button>
    </div>
  );
}

/** Congestion by simulated hour, filled in as the clock passes each hour (or you jump to it). */
type Hourly = { original: (number | null)[]; proposed: (number | null)[] };

/** Congestion by simulated hour for the real city and the proposal, filled in as the clock passes each hour. */
function HourlyCongestion({ hourly, view, now }: { hourly: Hourly; view: 'original' | 'proposed'; now: number }) {
  const has = (s: (number | null)[]) => s.some((v) => v !== null);
  if (!has(hourly.original) && !has(hourly.proposed)) return null;
  const both = has(hourly.original) && has(hourly.proposed);
  const pct = (v: number | null) => (v === null ? 'not simulated yet' : `${Math.round(v * 100)}% congested`);
  const bar = (v: number | null, cls: string) => (
    <i className={cls} style={{ height: v === null ? '2px' : `${Math.max(4, v * 100)}%`, background: v === null ? undefined : cls === 'o' ? undefined : `hsl(${120 - Math.min(1, v * 2) * 120} 65% 45%)` }} />
  );
  // hours simulated in both: the honest comparison
  const shared = hourly.original.map((o, h) => (o !== null && hourly.proposed[h] !== null ? [o, hourly.proposed[h]!] : null)).filter((x): x is number[] => !!x);
  const avg = (i: number) => shared.reduce((s, x) => s + x[i], 0) / shared.length;
  return (
    <div className="hourly" role="img" aria-label="Congested vehicles by hour of day, real city and proposal">
      <div className="hourly-bars">
        {hourly.proposed.map((v, h) => (
          <span key={h} className={h === Math.floor(now / 3600) ? 'now' : ''} title={`${String(h).padStart(2, '0')}:00 · real city: ${pct(hourly.original[h])} · proposal: ${pct(v)}`}>
            {both || view === 'original' ? bar(hourly.original[h], 'o') : null}
            {both || view === 'proposed' ? bar(v, 'p') : null}
          </span>
        ))}
      </div>
      <div className="hourly-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
      {both ? (
        <p className="note">
          <span className="key o" /> Real city <span className="key p" /> Proposal
          {shared.length > 0 && <> · same hours: {Math.round(avg(0) * 100)}% → {Math.round(avg(1) * 100)}% congested</>}
        </p>
      ) : (
        <p className="note">Switch between Original and Proposed and run the same hours to compare traffic.</p>
      )}
    </div>
  );
}

export function Dashboard({ headways, onHeadway, hourly, hourlyView = 'proposed', stats, proposed, original, region, editCount, comparison, onRemoveLine, horizon = 0, challenge, onChallenge, suggestedChallenge, insights, onLook, notes, onRemoveNote, events, onRemoveEvent }: { headways?: Record<string, number | undefined>; onHeadway?: (id: string, min: number | undefined) => void; hourly?: Hourly; hourlyView?: 'original' | 'proposed'; stats: SimStats | null; proposed: CityMetrics; original: CityMetrics; region: RegionProfile; editCount: number; comparison?: { name: string; active: boolean; metrics: CityMetrics }[] | null; onRemoveLine?: (id: string) => void; horizon?: number; challenge?: string; onChallenge: (id: string | undefined) => void; suggestedChallenge?: string; insights?: Insight[]; onLook?: (p: Vec2) => void; notes?: Note[]; onRemoveNote?: (id: string) => void; events?: CityEvent[]; onRemoveEvent?: (id: string) => void }) {
  const ch = CHALLENGES.find((c) => c.id === challenge);
  const result = ch && evaluate(ch, proposed, original, stats);
  const delta = (a: number, b: number, digits = 0) => {
    const d = a - b;
    if (Math.abs(d) < 10 ** -digits / 2) return null;
    return <span className={d > 0 ? 'up' : 'down'}>{d > 0 ? '+' : ''}{digits ? d.toFixed(digits) : fmt(d)}</span>;
  };
  const active = stats ? AGENT_KINDS.reduce((s, k) => s + stats.active[k], 0) : 0;
  const shares = Object.entries(region.modeShare).sort((a, b) => b[1] - a[1]);
  return (
    <aside className="panel dashboard" aria-label="Urban impact dashboard">
      {ch && result ? (
        <div className={`challenge ${result.done ? 'done' : ''}`}>
          <div className="ch-head">
            <span>Challenge</span>
            <button className="icon-btn" onClick={() => onChallenge(undefined)} aria-label="Leave challenge">Leave</button>
          </div>
          <strong>{ch.title}</strong>
          <p className="note">{ch.brief}</p>
          <ul>
            {result.results.map((r) => (
              <li key={r.label} className={r.met ? 'met' : ''}><i>{r.met ? '✓' : '○'}</i>{r.label}<b>{r.value}</b></li>
            ))}
          </ul>
          {result.done && <p className="ch-done">Challenge complete — share your plan!</p>}
        </div>
      ) : (
        <select className="ch-pick" value="" onChange={(e) => onChallenge(e.target.value)} aria-label="Take a challenge">
          <option value="">🎯 Take a planning challenge…</option>
          {[...CHALLENGES].sort((a, b) => +(b.id === suggestedChallenge) - +(a.id === suggestedChallenge)).map((c) => (
            <option key={c.id} value={c.id}>{c.title}{c.id === suggestedChallenge ? ' (suggested here)' : ''}</option>
          ))}
        </select>
      )}
      {insights && insights.length > 0 && (
        <div className="advisor">
          <h4>Planning advisor</h4>
          <ul>
            {insights.map((i) => (
              <li key={i.id} className={i.severity}>
                <strong>{i.title}</strong>
                <span>{i.detail}</span>
                {i.at && onLook && <button className="link" onClick={() => onLook(i.at!)}>Show me →</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {events && events.length > 0 && (
        <div className="notes events">
          <h4>Events</h4>
          <ul>
            {events.map((e) => {
              const t = stats?.time ?? 0;
              const phase = t >= e.start - 5400 && t < e.start ? 'crowd arriving' : t >= e.start && t < e.start + 7200 ? 'in progress' : t >= e.start + 7200 && t < e.start + 10800 ? 'crowd leaving' : 'scheduled';
              const hh = String(Math.floor(e.start / 3600)).padStart(2, '0');
              const mm = String(Math.floor((e.start % 3600) / 60)).padStart(2, '0');
              return (
                <li key={e.id}>
                  <span>★ {e.name} {hh}:{mm} · {e.attendance.toLocaleString()} · <b>{phase}</b></span>
                  {onLook && <button className="link" onClick={() => onLook(e.p)}>Show</button>}
                  {onRemoveEvent && <button className="icon-btn" aria-label="Remove event" onClick={() => onRemoveEvent(e.id)}>✕</button>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {notes && notes.length > 0 && (
        <div className="notes">
          <h4>Notes ({notes.length})</h4>
          <ul>
            {notes.map((n) => (
              <li key={n.id}>
                <span>{n.text}</span>
                {onLook && <button className="link" onClick={() => onLook(n.p)}>Show</button>}
                {onRemoveNote && <button className="icon-btn" aria-label="Remove note" onClick={() => onRemoveNote(n.id)}>✕</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <h3>Urban impact</h3>
      <p className="note">{editCount ? `Proposal vs. today (${editCount} change${editCount === 1 ? '' : 's'})` : 'Today’s city — make a change to compare.'}</p>
      <div className="metrics">
        <Metric label="Housing capacity" value={`${fmt(proposed.residents)} people`} d={delta(proposed.residents, original.residents)} />
        <Metric label="Job capacity" value={fmt(proposed.jobs)} d={delta(proposed.jobs, original.jobs)} />
        <Metric label="Floor area" value={`${proposed.floorAreaKm2.toFixed(2)} km²`} d={delta(proposed.floorAreaKm2, original.floorAreaKm2, 2)} />
        <Metric label="Road network" value={`${proposed.roadKm.toFixed(1)} km`} d={delta(proposed.roadKm, original.roadKm, 1)} />
        <Metric label="Bike network" value={`${proposed.bikeKm.toFixed(1)} km`} d={delta(proposed.bikeKm, original.bikeKm, 1)} />
        <Metric label="Green space" value={`${proposed.greenHa.toFixed(1)} ha`} d={delta(proposed.greenHa, original.greenHa, 1)} />
        <Metric label="Near transit (400 m)" value={`${Math.round(proposed.transitAccess * 100)}% of residents`} d={delta(proposed.transitAccess * 100, original.transitAccess * 100)} />
        <Metric label="Near a park (300 m)" value={`${Math.round(proposed.parkAccess * 100)}% of residents`} d={delta(proposed.parkAccess * 100, original.parkAccess * 100)} />
        <Metric label="Buildings" value={fmt(proposed.buildings)} d={delta(proposed.buildings, original.buildings)} />
      </div>
      {comparison && (
        <>
          <h4>Compare scenarios</h4>
          <div className="compare-wrap">
            <table className="compare">
              <thead>
                <tr><th /><th>Today</th>{comparison.map((c) => <th key={c.name} className={c.active ? 'on' : ''}>{c.name}</th>)}</tr>
              </thead>
              <tbody>
                {([['Near transit', (m: CityMetrics) => `${Math.round(m.transitAccess * 100)}%`], ['Near park', (m: CityMetrics) => `${Math.round(m.parkAccess * 100)}%`], ['Housing', (m: CityMetrics) => fmt(m.residents)], ['Jobs', (m: CityMetrics) => fmt(m.jobs)], ['Floor km²', (m: CityMetrics) => m.floorAreaKm2.toFixed(2)], ['Road km', (m: CityMetrics) => m.roadKm.toFixed(1)], ['Buildings', (m: CityMetrics) => fmt(m.buildings)]] as const).map(([label, f]) => (
                  <tr key={label}><th>{label}</th><td>{f(original)}</td>{comparison.map((c) => <td key={c.name} className={c.active ? 'on' : ''}>{f(c.metrics)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h4>Live simulation{horizon ? ` · projected +${horizon} years` : ''}</h4>
      {horizon > 0 && (
        <p className="note projection">
          Projection: travel demand ×{((1 + region.growth) ** horizon).toFixed(2)} (assumes {(region.growth * 100).toFixed(1)}%/yr growth for {region.label}).
          {(() => {
            const need = original.residents * (1 + region.growth) ** horizon;
            return need > proposed.residents ? ` Housing shortfall: ~${fmt(need - proposed.residents)} people.` : ` Housing capacity covers the projected population.`;
          })()} Illustrative, not a forecast.
        </p>
      )}
      {stats ? (
        <>
          <div className="metrics">
            <Metric label="Agents moving" value={fmt(active)} />
            <Metric label="Avg. vehicle speed" value={`${stats.avgVehicleSpeedKmh.toFixed(0)} km/h`} />
            <Metric label="Congested vehicles" value={`${Math.round(stats.congestion * 100)}%`} warn={stats.congestion > 0.4} />
            <Metric label="Trips completed" value={fmt(stats.tripsCompleted)} />
            <Metric label="Transit boardings" value={fmt(stats.busRiders)} />
            <Metric label="Waiting at stops" value={fmt(stats.waitingAtStops)} />
            <Metric label="Transfers" value={fmt(stats.transfers)} />
            <Metric label="Cruising for parking" value={fmt(stats.cruising)} warn={stats.cruising > 20} />
          </div>
          {hourly && <HourlyCongestion hourly={hourly} view={hourlyView} now={stats.time} />}
          <div className="kinds">
            {AGENT_KINDS.map((k) => (
              <span key={k}>{KIND_LABEL[k]} <b>{stats.active[k]}</b></span>
            ))}
            <span>Train cars <b>{stats.trains}</b></span>
          </div>
          <p className="note">{stats.signals} traffic signals · {stats.busRoutes} transit lines</p>
          <h4>Transit ridership</h4>
          <ul className="lines">
            {stats.lines.map((l) => (
              <li key={l.id}>
                <i style={{ background: `#${l.color.toString(16).padStart(6, '0')}` }} />
                <span className="lname">{l.name}<small>{l.mode === 'metro' ? 'metro' : 'bus'} · {l.vehicles} vehicle{l.vehicles === 1 ? '' : 's'}</small></span>
                <span title="Boardings so far / riding now / waiting">{fmt(l.boardings)} <small>boarded</small><br />{l.onboard} <small>on board</small> · {l.waiting} <small>waiting</small></span>
                {!l.generated && onHeadway && (
                  <select className="headway" value={headways?.[l.id] ?? ''} aria-label={`How often ${l.name} runs`} title="How often a vehicle leaves each end. More frequent service attracts more riders and needs more vehicles."
                    onChange={(e) => onHeadway(l.id, e.target.value ? +e.target.value : undefined)}>
                    <option value="">Auto</option>
                    {[2, 3, 5, 10, 15, 20, 30].map((m) => <option key={m} value={m}>every {m} min</option>)}
                  </select>
                )}
                {!l.generated && onRemoveLine && <button className="icon-btn" aria-label={`Remove ${l.name}`} onClick={() => onRemoveLine(l.id)}>✕</button>}
              </li>
            ))}
          </ul>
          {!stats.lines.some((l) => !l.generated) && <p className="note">Draw your own bus or metro line with the Transit tool (5).</p>}
        </>
      ) : <p className="note">Starting…</p>}
      <h4>Travel assumptions · {region.label}</h4>
      <div className="shares">
        {shares.map(([m, v]) => (
          <div key={m} className="share"><span>{m}</span><i style={{ width: `${v * 100}%` }} /><b>{Math.round(v * 100)}%</b></div>
        ))}
      </div>
      <p className="note">Mode shares and capacities are illustrative assumptions. People and vehicles are synthetic; results are not forecasts.</p>
    </aside>
  );
}

function Metric({ label, value, d, warn }: { label: string; value: string; d?: React.ReactNode; warn?: boolean }) {
  return (
    <div className={`metric ${warn ? 'warn' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {d}
    </div>
  );
}
