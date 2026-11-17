import { useEffect, useState } from 'react';
import type { Building, BuildingUse } from '../geo/types';
import { signedArea } from '../geo/util';
import type { Edit } from '../project/edits';
import type { AgentInfo, Selection } from '../render/engine';
import type { RegionProfile } from '../sim/region';
import { AGENT_KINDS, buildingCapacity, type DayType, type SimStats, type Weather } from '../sim/simulation';
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
  sel, editable, onEdit, onFocus, onFollow, following, onClose,
}: {
  sel: Selection;
  editable: boolean;
  onEdit: (e: Edit) => void;
  onFocus: () => void;
  onFollow: (id: number | null) => void;
  following: boolean;
  onClose: () => void;
}) {
  return (
    <aside className="panel inspector" aria-label="Inspector">
      <button className="icon-btn close" onClick={onClose} aria-label="Close inspector">✕</button>
      {sel.type === 'building' && <BuildingInspector b={sel.building} editable={editable} onEdit={onEdit} onFocus={onFocus} />}
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
  stats, running, speed, onRun, onSpeed, onTime, onReset, day, onDay, horizon, onHorizon, growth, weather, onWeather,
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
}) {
  const t = stats?.time ?? 0;
  const hh = String(Math.floor(t / 3600)).padStart(2, '0');
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  return (
    <div className="panel simbar" aria-label="Simulation controls">
      <button className="play" onClick={() => onRun(!running)} aria-label={running ? 'Pause' : 'Play'}>{running ? '❚❚' : '▶'}</button>
      <div className="clock">{hh}:{mm}</div>
      <input type="range" min={0} max={86399} step={300} value={t} onChange={(e) => onTime(+e.target.value)} aria-label="Time of day" className="time" />
      <div className="seg" role="group" aria-label="Simulation speed">
        {[1, 5, 20, 60].map((s) => (
          <button key={s} className={speed === s ? 'on' : ''} onClick={() => onSpeed(s)}>{s}×</button>
        ))}
      </div>
      <select value={day} onChange={(e) => onDay(e.target.value as DayType)} aria-label="Day type" className="hide-sm">
        <option value="weekday">Weekday</option>
        <option value="weekend">Weekend</option>
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

export function Dashboard({ stats, proposed, original, region, editCount, comparison, onRemoveLine, horizon = 0, challenge, onChallenge, suggestedChallenge, insights, onLook, notes, onRemoveNote }: { stats: SimStats | null; proposed: CityMetrics; original: CityMetrics; region: RegionProfile; editCount: number; comparison?: { name: string; active: boolean; metrics: CityMetrics }[] | null; onRemoveLine?: (id: string) => void; horizon?: number; challenge?: string; onChallenge: (id: string | undefined) => void; suggestedChallenge?: string; insights?: Insight[]; onLook?: (p: Vec2) => void; notes?: Note[]; onRemoveNote?: (id: string) => void }) {
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
          </div>
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
