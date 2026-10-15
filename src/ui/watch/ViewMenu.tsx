// Owned by: ui
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_VIEW_SETTINGS } from '../../core';
import type { GameController, ViewSettings } from '../../core';
import { GearIcon } from '../icons';
import { VIEW_GROUPS } from '../view';
import type { ViewItem } from '../view';

type Set = (patch: Partial<ViewSettings>) => void;

/**
 * The View popover behind a small gear in the top bar, clear of the arena. Every display setting
 * with its shortcut; the controller merges, persists and applies each change.
 */
export function ViewMenu({ controller, view }: { controller: GameController; view: ViewSettings }) {
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

  const set: Set = (patch) => controller.setView(patch);
  const isDefault = (Object.keys(DEFAULT_VIEW_SETTINGS) as (keyof ViewSettings)[]).every((k) => view[k] === DEFAULT_VIEW_SETTINGS[k]);

  return (
    <div ref={root} className="view-menu">
      <button
        type="button"
        className="btn btn-sm btn-quiet"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        title="Display settings: tags, cones, fog, gore, sound"
      >
        <GearIcon /> View
      </button>
      {open ? (
        <div className="hud-panel menu view-pop" role="dialog" aria-label="View settings">
          {VIEW_GROUPS.map((g) => (
            <section key={g.title} className="vs-group">
              <h3>{g.title}</h3>
              {g.items.map((item) => (
                <Row key={item.key} item={item} view={view} set={set} />
              ))}
            </section>
          ))}
          <div className="vs-foot">
            <span className="faint">Letters toggle while you watch.</span>
            <button type="button" className="linkish" disabled={isDefault} onClick={() => set({ ...DEFAULT_VIEW_SETTINGS })}>
              Reset to defaults
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Key({ k, title }: { k?: string; title?: string }) {
  return k ? <kbd title={title ?? `Shortcut: ${k}`}>{k}</kbd> : <span />;
}

function Row({ item, view, set }: { item: ViewItem; view: ViewSettings; set: Set }) {
  switch (item.kind) {
    case 'toggle':
      return (
        <label className="vs-row">
          <span className="vs-label">
            {item.label}
            {item.hint ? <small>{item.hint}</small> : null}
          </span>
          <input type="checkbox" className="switch" checked={view[item.key]} onChange={(e) => set({ [item.key]: e.target.checked })} />
          <Key k={item.shortcut} />
        </label>
      );
    case 'choice':
      return (
        <div className="vs-row">
          <span className="vs-label">{item.label}</span>
          <div className="seg" role="group" aria-label={item.label}>
            {item.options.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={view[item.key] === o.value}
                onClick={() => set({ [item.key]: o.value } as Partial<ViewSettings>)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <Key k={item.shortcut} title={item.shortcut ? `${item.shortcut} steps through these` : undefined} />
        </div>
      );
    case 'volume':
      // Not a <label>: the Watch screen keeps focus off labelled HUD controls, and a slider needs it to drag.
      return (
        <div className="vs-row">
          <span className="vs-label">
            {item.label} <span className="num faint">{view.volume > 0 ? `${Math.round(view.volume * 100)}%` : 'muted'}</span>
          </span>
          <input
            type="range"
            className="range vs-range"
            min={0}
            max={1}
            step={0.05}
            value={view.volume}
            aria-label="Volume"
            onChange={(e) => set({ volume: Number(e.target.value) })}
          />
          <Key k={item.shortcut} title={item.shortcut ? `${item.shortcut} mutes and unmutes` : undefined} />
        </div>
      );
  }
}
