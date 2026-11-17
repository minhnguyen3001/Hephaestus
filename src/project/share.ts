import type { Place } from '../geo/types';
import type { Edit } from './edits';
import type { SavedView } from './store';

/** Everything needed to reopen a plan elsewhere — no server: it lives in the URL fragment. */
export interface SharedPlan {
  v: 1;
  name: string;
  place: Place;
  radius: number;
  edits: Edit[];
  view?: SavedView;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Round coordinates to 10 cm so links stay short. */
function compact(plan: SharedPlan): SharedPlan {
  return JSON.parse(JSON.stringify(plan, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v)));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodePlan(plan: SharedPlan): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ ...compact(plan), place: plan.place }));
  if (typeof CompressionStream !== 'undefined') return `z${b64url(await pipe(json, new CompressionStream('deflate-raw')))}`;
  return `j${b64url(json)}`;
}

export async function decodePlan(code: string): Promise<SharedPlan | null> {
  try {
    const kind = code[0];
    let bytes = unb64url(code.slice(1));
    if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    else if (kind !== 'j') return null;
    const plan = JSON.parse(new TextDecoder().decode(bytes)) as SharedPlan;
    if (plan.v !== 1 || !plan.place || typeof plan.place.lat !== 'number' || !Array.isArray(plan.edits)) return null;
    return plan;
  } catch {
    return null;
  }
}
