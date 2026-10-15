// Owned by: ui
// Placeholder stub from the architect: mounts the arena canvas full-bleed. Replace wholesale.
import { useEffect, useRef } from 'react';
import type { GameController } from '../core';

export function App({ controller }: { controller: GameController }) {
  const arena = useRef<HTMLDivElement>(null);
  useEffect(() => (arena.current ? controller.mountCanvas(arena.current) : undefined), [controller]);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div ref={arena} style={{ position: 'absolute', inset: 0 }} />
      <div style={{ position: 'absolute', top: 16, left: 16, fontFamily: 'Bangers, sans-serif', fontSize: 28, letterSpacing: 1 }}>
        Pit of Carnage
      </div>
    </div>
  );
}
