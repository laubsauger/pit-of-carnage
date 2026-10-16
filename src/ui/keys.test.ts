import { describe, expect, it } from 'vitest';
import { THINK_EVERY_TICKS, TICK_HZ } from '../core';
import { SPEED_PRESETS, WATCH_KEYS, exitsCinematic, keyHelp, keyToAction, modalOpen } from './keys';

const key = (k: string, extra: Partial<Parameters<typeof keyToAction>[0]> = {}) =>
  keyToAction({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, editable: false, ...extra });

describe('keyToAction', () => {
  it('binds the documented watch keys', () => {
    expect(key('Tab')).toEqual({ type: 'cycle', dir: 1 });
    expect(key('Tab', { shiftKey: true })).toEqual({ type: 'cycle', dir: -1 });
    expect(key('f')).toEqual({ type: 'follow' });
    expect(key('F')).toEqual({ type: 'follow' });
    expect(key(' ')).toEqual({ type: 'pause' });
    expect(key('Escape')).toEqual({ type: 'deselect' });
  });

  it('steps one brain think per arrow press, because the inspector only changes on thinks', () => {
    expect(key('ArrowRight')).toEqual({ type: 'step', ticks: THINK_EVERY_TICKS });
    expect(key('ArrowLeft')).toEqual({ type: 'step', ticks: -THINK_EVERY_TICKS });
    expect(key('ArrowRight', { shiftKey: true })).toEqual({ type: 'step', ticks: TICK_HZ });
  });

  it('maps 1-5 to the speed presets in order, slowest first', () => {
    expect(['1', '2', '3', '4', '5'].map((k) => key(k))).toEqual(SPEED_PRESETS.map((speed) => ({ type: 'speed', speed })));
    expect(key('3')).toEqual({ type: 'speed', speed: 1 });
    expect(key('6')).toBeNull();
    expect(key('0')).toBeNull();
  });

  it('never fires while typing, so editing a strategy name cannot pause or reseat the match', () => {
    for (const k of ['Tab', ' ', 'f', '1', 'ArrowLeft', 'Escape']) expect(key(k, { editable: true })).toBeNull();
  });

  it('leaves browser shortcuts alone (cmd+F finds, ctrl+Tab switches tabs, alt+arrow goes back)', () => {
    expect(key('f', { metaKey: true })).toBeNull();
    expect(key('Tab', { ctrlKey: true })).toBeNull();
    expect(key('ArrowLeft', { altKey: true })).toBeNull();
    expect(key('m', { metaKey: true })).toBeNull();
  });

  // The spec promises "Reset camera" on a button and on C; without the key a zoomed viewer is stuck.
  it('binds C to giving the camera back to the director', () => {
    expect(key('c')).toEqual({ type: 'camera' });
    expect(key('C')).toEqual({ type: 'camera' });
    expect(key('c', { editable: true })).toBeNull();
  });

  it('binds End to the live edge, so there is always a key back from a replay', () => {
    expect(key('End')).toEqual({ type: 'live' });
    expect(key('End', { editable: true })).toBeNull();
  });

  it('never lets a View shortcut fire while typing a strategy name', () => {
    expect(key('o', { editable: true })).toBeNull();
  });

  // The spec's key for the full-screen fighter overview; it must not collide with a View shortcut.
  it('binds I to the full-screen fighter overview', () => {
    expect(key('i')).toEqual({ type: 'overview' });
    expect(key('I')).toEqual({ type: 'overview' });
    expect(key('i', { editable: true })).toBeNull();
  });

  // The View popover promises these keys; a listed key that does nothing would be a lie on screen.
  it('binds every key the shortcut list shows', () => {
    for (const k of WATCH_KEYS) expect(key(k.sample), k.keys).not.toBeNull();
  });
});

describe('the shortcut scheme', () => {
  // The user asked for letters that match the word; V is the cinematic view, so cones moved off it.
  it('binds H hearing, B HP bars, O fog, T name tags, A barks, C camera, V cinematic, I overview', () => {
    expect(key('h')).toEqual({ type: 'view', key: 'hearing' });
    expect(key('b')).toEqual({ type: 'view', key: 'hpBars' });
    expect(key('o')).toEqual({ type: 'view', key: 'fog' });
    expect(key('t')).toEqual({ type: 'view', key: 'nameTags' });
    expect(key('a')).toEqual({ type: 'view', key: 'barks' });
    expect(key('v')).toEqual({ type: 'view', key: 'cinematic' });
    expect(key('c')).toEqual({ type: 'camera' });
    expect(key('i')).toEqual({ type: 'overview' });
  });

  it('gives every letter at most one meaning (a View key never shadows follow, camera or overview)', () => {
    const owners = new Map<string, string>();
    for (const group of keyHelp()) {
      for (const row of group.rows) {
        if (!/^[A-Z]$/.test(row.keys)) continue;
        expect(owners.get(row.keys), `${row.keys}: ${owners.get(row.keys)} and ${row.label}`).toBeUndefined();
        owners.set(row.keys, row.label);
      }
    }
    expect(owners.size).toBeGreaterThan(10);
  });

  // The help card is the list players trust; a key on it that does nothing would be a lie on screen.
  it('lists only keys that do something on the Watch screen (? is the Codex, handled on every screen)', () => {
    for (const group of keyHelp()) {
      for (const row of group.rows) {
        if (row.keys === '?') continue;
        const sample = WATCH_KEYS.find((k) => k.keys === row.keys)?.sample ?? row.keys.toLowerCase();
        expect(key(sample), `${group.title}: ${row.keys}`).not.toBeNull();
      }
    }
  });

  it('never fires a letter while typing, in the editor or anywhere else', () => {
    for (const k of 'abcdefghijklmnopqrstuvwxyz') expect(key(k, { editable: true })).toBeNull();
  });

  it('brings the HUD back for keys that need a panel, and leaves it folded for playback keys', () => {
    expect(exitsCinematic({ type: 'cycle', dir: 1 })).toBe(true);
    expect(exitsCinematic({ type: 'overview' })).toBe(true);
    expect(exitsCinematic({ type: 'pause' })).toBe(false);
    expect(exitsCinematic({ type: 'view', key: 'cinematic' })).toBe(false);
  });
});

describe('modalOpen', () => {
  const el = (hiddenAncestor: boolean) => ({ closest: (sel: string) => (sel === '[hidden]' && hiddenAncestor ? {} : null) });
  const root = (...els: ReturnType<typeof el>[]) => ({ querySelectorAll: () => els });

  // Reviewer bug: the Gym's import dialog, open on the hidden Gym screen, swallowed every Watch key.
  it('ignores a dialog inside a hidden screen', () => {
    expect(modalOpen(root(el(true)))).toBe(false);
  });

  it('counts a dialog that is showing', () => {
    expect(modalOpen(root(el(true), el(false)))).toBe(true);
    expect(modalOpen(root())).toBe(false);
  });
});
