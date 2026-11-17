import { useRef, useState } from 'react';
import { searchPlaces } from '../geo/geocode';
import type { Place } from '../geo/types';

export function SearchBox({ onPick, compact = false, autoFocus = false }: { onPick: (p: Place) => void; compact?: boolean; autoFocus?: boolean }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    setBusy(true);
    setError(null);
    try {
      const r = await searchPlaces(q.trim(), ctrl.current.signal);
      setResults(r);
      if (!r.length) setError('No places found. Try a city, street, landmark or "lat, lon".');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError('Search is unavailable right now. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`search ${compact ? 'compact' : ''}`}>
      <form onSubmit={submit} role="search">
        <svg viewBox="0 0 24 24" className="search-icon" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          value={q}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQ(e.target.value);
            setResults(null);
          }}
          placeholder={compact ? 'Search a place…' : 'Search any city, street, landmark or coordinates'}
          aria-label="Search for a location"
        />
        <button type="submit" disabled={busy}>{busy ? '…' : 'Go'}</button>
      </form>
      {(results?.length || error) && (
        <ul className="results" role="listbox">
          {error && <li className="muted">{error}</li>}
          {results?.map((r, i) => (
            <li key={i}>
              <button
                onClick={() => {
                  setResults(null);
                  onPick(r);
                }}
              >
                <strong>{r.name}</strong>
                <span>{r.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
