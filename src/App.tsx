import { lazy, Suspense, useEffect, useState } from 'react';
import type { Place } from './geo/types';
import { decodePlan } from './project/share';
import { newProject, saveProject, type Project } from './project/store';
import { PRESETS, resolveQuality } from './render/quality';
import { Landing } from './ui/Landing';

// The 3D workspace (three.js + simulation) is code-split so the landing page loads fast on slow networks.
const WorldView = lazy(() => import('./ui/WorldView'));

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Shared plans arrive as #plan=… links; open them as a new local project.
  useEffect(() => {
    const m = /^#plan=(.+)$/.exec(location.hash);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    decodePlan(m[1]).then((plan) => {
      if (!plan) return setNotice('That share link is incomplete or damaged.');
      const p = newProject(plan.place, plan.radius, plan.edits);
      p.name = plan.name;
      if (plan.view?.target) p.view3d = plan.view;
      if (plan.view?.center) p.view2d = plan.view;
      saveProject(p);
      setProject(p);
    });
  }, []);

  const open = (place: Place) => {
    const p = newProject(place, PRESETS[resolveQuality('auto')].radius);
    saveProject(p);
    setProject(p);
  };

  if (!project) return <Landing onOpenPlace={open} onOpenProject={setProject} notice={notice} />;
  return (
    <Suspense fallback={<div className="boot">Loading 3D engine…</div>}>
      <WorldView key={project.id} project={project} onExit={() => setProject(null)} onOpenPlace={open} />
    </Suspense>
  );
}
