// Owned by: ui
import { useEffect, useRef, useState } from 'react';
import type { GameController, OverlayState } from '../../core';
import { EyeIcon } from '../icons';

const CONES: { value: OverlayState['cones']; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'selected', label: 'Selected' },
  { value: 'all', label: 'All' },
];

/** Overlay toggles: vision cones, steering ring, names, fog of war. */
export function ViewMenu({ controller, overlay }: { controller: GameController; overlay: OverlayState }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={root} style={{ position: 'relative' }}>
      <button type="button" className="btn btn-sm btn-quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
        <EyeIcon /> View
      </button>
      {open ? (
        <div className="hud-panel menu" role="dialog" aria-label="View options">
          <div className="field">
            <span>Vision cones</span>
            <div className="seg" role="group">
              {CONES.map((c) => (
                <button key={c.value} type="button" aria-pressed={overlay.cones === c.value} onClick={() => controller.setOverlay({ cones: c.value })}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={overlay.rings} onChange={(e) => controller.setOverlay({ rings: e.target.checked })} />
            Steering ring and target line
          </label>
          <label className="check">
            <input type="checkbox" checked={overlay.names} onChange={(e) => controller.setOverlay({ names: e.target.checked })} />
            Name tags
          </label>
          <label className="check">
            <input type="checkbox" checked={overlay.fog} onChange={(e) => controller.setOverlay({ fog: e.target.checked })} />
            Fog of war from the selected fighter
          </label>
        </div>
      ) : null}
    </div>
  );
}
