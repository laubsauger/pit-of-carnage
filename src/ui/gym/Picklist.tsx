// Owned by: ui
import type { WeaponId } from '../../core';
import { WeaponIcon } from '../icons';

export type PickItem = { ref: string; label: string; weapon?: WeaponId; note?: string; disabled?: boolean };

type Props = {
  title: string;
  items: PickItem[];
  selected: readonly string[];
  onChange: (refs: string[]) => void;
  empty?: string;
};

/** Checkbox list with All / None, used for candidates, opponents and maps. */
export function Picklist({ title, items, selected, onChange, empty = 'Nothing here yet.' }: Props) {
  const on = new Set(selected);
  const count = items.filter((i) => on.has(i.ref) && !i.disabled).length;
  const toggle = (ref: string, checked: boolean) => {
    const next = new Set(on);
    if (checked) next.add(ref);
    else next.delete(ref);
    // Keep list order so the request (and its seeds) does not depend on click order.
    onChange(items.map((i) => i.ref).filter((r) => next.has(r)));
  };
  return (
    <div className="picklist">
      <div className="picklist-head">
        <span>
          {title} <span className="faint num">{count}</span>
        </span>
        <span className="inline">
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => onChange(items.filter((i) => !i.disabled).map((i) => i.ref))}>
            All
          </button>
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => onChange([])}>
            None
          </button>
        </span>
      </div>
      <div className="picklist-body">
        {items.length === 0 ? <div className="lib-empty">{empty}</div> : null}
        {items.map((it) => (
          <label key={it.ref} className={`check${it.disabled ? ' disabled' : ''}`} title={it.note}>
            <input type="checkbox" checked={on.has(it.ref) && !it.disabled} disabled={it.disabled} onChange={(e) => toggle(it.ref, e.target.checked)} />
            {it.weapon ? (
              <span className="sb-weapon">
                <WeaponIcon weapon={it.weapon} />
              </span>
            ) : null}
            <span className="pick-label">{it.label}</span>
            {it.note ? <span className="faint pick-note">{it.note}</span> : null}
          </label>
        ))}
      </div>
    </div>
  );
}
