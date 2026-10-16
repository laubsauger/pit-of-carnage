// Owned by: ui
// "Name collisions ask" (SPEC "Versions and the library"): saving a strategy under a name the
// library already has, when the draft did not come from that strategy, offers "Add as new version
// of X" or "Save as new strategy" with a suggested free name.
import { useEffect, useRef, useState } from 'react';
import { LIMITS } from '../../strategy';
import { CloseIcon } from '../icons';
import type { SaveChoice, SavePlan } from './versions';

type Props = {
  plan: SavePlan;
  /** Every name in the library, so the new name cannot collide again. */
  taken: readonly string[];
  /** What the draft is ("an import", "an LLM's answer", "a new fighter"), for the explanation. */
  what: string;
  onChoose: (choice: SaveChoice) => void;
  onClose: () => void;
};

export function SaveDialog({ plan, taken, what, onChoose, onClose }: Props) {
  const [name, setName] = useState(plan.suggestedName);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  const problem = !trimmed ? 'Give it a name.' : trimmed.length > LIMITS.nameLength ? `At most ${LIMITS.nameLength} characters.` : taken.includes(trimmed) ? 'That name is taken too.' : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog save-dialog" role="dialog" aria-modal="true" aria-label={`${plan.name} is already in your library`}>
        <div className="dialog-head">
          <h2>“{plan.name}” is already in your library</h2>
          <button type="button" className="btn btn-sm btn-icon btn-quiet" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="dialog-body">
          <p className="dim save-why">
            This is {what}, not an edit of your saved {plan.name}. Add it to that strategy’s history, or keep the two apart so their reports and ratings stay separate.
          </p>
          <div className="save-options">
            <button type="button" className="save-option" onClick={() => onChoose({ kind: 'plan' })} autoFocus>
              <b>
                Add as v{plan.version} of {plan.name}
              </b>
              <span className="faint">It joins that strategy’s history as its newest version.</span>
            </button>
            <form
              className="save-option"
              onSubmit={(e) => {
                e.preventDefault();
                if (!problem) onChoose({ kind: 'rename', name: trimmed });
              }}
            >
              <b>Save as a new strategy</b>
              <span className="save-rename">
                <input ref={input} className="input" value={name} maxLength={LIMITS.nameLength + 10} aria-label="New name" spellCheck={false} onChange={(e) => setName(e.target.value)} />
                <button type="submit" className="btn btn-sm btn-primary" disabled={problem !== null}>
                  Save as v1
                </button>
              </span>
              <span className={problem ? 'error-line' : 'faint'}>{problem ?? 'Starts its own history.'}</span>
            </form>
          </div>
        </div>
        <div className="dialog-foot">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
