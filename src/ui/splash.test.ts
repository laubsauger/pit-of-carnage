import { describe, expect, it } from 'vitest';
import { LOADING_STAGES } from '../core';
import type { LoadingStageId, MatchPhase } from '../core';
import { splashView } from './splash';

const stages = (done: LoadingStageId[]) => LOADING_STAGES.map((s) => ({ id: s.id, label: s.label, done: done.includes(s.id) }));
const snap = (phase: MatchPhase, done: LoadingStageId[], arenaError: string | null = null) => ({ phase, loading: stages(done), arenaError });

describe('splashView', () => {
  it('shows real progress and names the stage still running', () => {
    const v = splashView(snap('loading', ['bundle', 'webgpu', 'renderer']), 'ok', false);
    expect(v.mode).toBe('loading');
    expect(v.progress).toBeCloseTo(3 / 6);
    expect(v.stage).toBe('Warming up shaders');
  });

  it('counts the UI\'s own adapter check as the WebGPU stage, before the renderer is up', () => {
    // The controller marks `webgpu` only with the renderer; the bar should not sit still meanwhile.
    expect(splashView(snap('loading', ['bundle']), 'ok', false).progress).toBeCloseTo(2 / 6);
    expect(splashView(snap('loading', ['bundle']), 'checking', false).progress).toBeCloseTo(1 / 6);
  });

  it('offers "Enter the pit" only once everything has loaded', () => {
    expect(splashView(snap('loading', ['bundle', 'webgpu', 'renderer', 'shaders', 'audio']), 'ok', false).mode).toBe('loading');
    expect(splashView(snap('splash', LOADING_STAGES.map((s) => s.id)), 'ok', false)).toMatchObject({ mode: 'ready', progress: 1 });
  });

  it('replaces the button with a message when there is no WebGPU, since loading can never finish', () => {
    expect(splashView(snap('loading', ['bundle']), 'missing', false).mode).toBe('nogpu');
    expect(splashView(snap('loading', ['bundle', 'webgpu']), 'ok', false).mode).toBe('loading');
    expect(splashView(snap('loading', ['bundle', 'webgpu'], 'Device lost'), 'ok', false).mode).toBe('failed');
  });

  it('goes away once entered, or when dismissed without WebGPU', () => {
    expect(splashView(snap('countdown', LOADING_STAGES.map((s) => s.id)), 'ok', false).mode).toBe('gone');
    expect(splashView(snap('live', LOADING_STAGES.map((s) => s.id)), 'ok', false).mode).toBe('gone');
    expect(splashView(snap('loading', ['bundle']), 'missing', true).mode).toBe('gone');
  });
});
