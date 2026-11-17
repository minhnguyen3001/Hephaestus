import { lazy, Suspense, useState } from 'react';
import type { Place } from './geo/types';
import { newProject, saveProject, type Project } from './project/store';
import { PRESETS, resolveQuality } from './render/quality';
import { Landing } from './ui/Landing';

// The 3D workspace (three.js + simulation) is code-split so the landing page loads fast on slow networks.
const WorldView = lazy(() => import('./ui/WorldView'));

export function App() {
  const [project, setProject] = useState<Project | null>(null);

  const open = (place: Place) => {
    const p = newProject(place, PRESETS[resolveQuality('auto')].radius);
    saveProject(p);
    setProject(p);
  };

  if (!project) return <Landing onOpenPlace={open} onOpenProject={setProject} />;
  return (
    <Suspense fallback={<div className="boot">Loading 3D engine…</div>}>
      <WorldView key={project.id} project={project} onExit={() => setProject(null)} onOpenPlace={open} />
    </Suspense>
  );
}
