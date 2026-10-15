import { describe, expect, it } from 'vitest';
import { THINK_EVERY_TICKS, TICK_HZ } from '../core';
import { SPEED_PRESETS, WATCH_KEYS, keyToAction } from './keys';

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
