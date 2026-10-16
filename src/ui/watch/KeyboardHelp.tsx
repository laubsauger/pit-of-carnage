// Owned by: ui
import { useEffect, useRef } from 'react';
import { CloseIcon } from '../icons';
import { keyHelp } from '../keys';

const GROUPS = keyHelp();

/**
 * Every Watch shortcut on one card, grouped (Playback, Fighters and camera, the View groups,
 * Anywhere). Built from the key tables themselves, so it never lists a key that does nothing. Esc,
 * the close button or a click outside closes it.
 */
export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // The "Keys" button toggles the card itself.
      if (root.current && !root.current.contains(t) && !t.closest('.hud-actions')) onClose();
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [onClose]);
  return (
    <section ref={root} className="hud-panel kbd-help" role="dialog" aria-label="Keyboard shortcuts">
      <div className="kbd-head">
        <h3>Keyboard</h3>
        <span className="faint">Keys rest while you type.</span>
        <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="kbd-groups">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            <dl>
              {g.rows.map((r) => (
                <div key={r.keys}>
                  <dt>
                    <kbd>{r.keys}</kbd>
                  </dt>
                  <dd>{r.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </section>
  );
}
