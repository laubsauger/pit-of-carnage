// Owned by: net
// A small top-down picture of the room's match, drawn from the stream without taking its events
// (the arena, when it watches the same stream, still gets every one). Canvas 2D, only while the
// Room screen is visible.
import { useEffect, useRef } from 'react';
import type { MapDef, WorldState } from '../../core';
import type { StreamPlayer } from '../../net';

const COLORS = {
  floor: '#161412',
  wall: '#3a352f',
  pillar: '#4d463e',
  zone: 'rgba(196, 48, 43, 0.9)',
  zoneWash: 'rgba(196, 48, 43, 0.12)',
  hazard: 'rgba(232, 226, 217, 0.22)',
  acid: 'rgba(120, 200, 80, 0.45)',
  shrine: 'rgba(240, 220, 160, 0.55)',
  dead: 'rgba(232, 226, 217, 0.28)',
  shot: '#f3ead8',
};

type Props = { player: StreamPlayer; active: boolean };

export function Radar({ player, active }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = box.current;
    const cv = canvas.current;
    if (!active || !el || !cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let width = 0;
    const fit = () => {
      width = el.clientWidth;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const map = player.map;
      const s = player.sample(performance.now());
      if (!map || !s || width === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const height = Math.round((width * map.height) / map.width);
      if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(height * dpr)) {
        cv.width = Math.round(width * dpr);
        cv.height = Math.round(height * dpr);
        cv.style.height = `${height}px`;
      }
      const k = (width / map.width) * dpr;
      paint(ctx, map, s.prev, s.curr, s.alpha, k);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [player, active]);

  return (
    <div ref={box} className="rm-radar">
      <canvas ref={canvas} aria-label="Top-down view of the current match" />
    </div>
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function paint(ctx: CanvasRenderingContext2D, map: MapDef, prev: WorldState, curr: WorldState, alpha: number, k: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.floor;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);

  // The closing wall: everything outside the zone is washed red.
  const z = curr.suddenDeath;
  if (z.active) {
    ctx.fillStyle = COLORS.zoneWash;
    ctx.fillRect(0, 0, map.width, map.height);
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(z.bounds.x, z.bounds.y, z.bounds.w, z.bounds.h);
    ctx.strokeStyle = COLORS.zone;
    ctx.lineWidth = 3 / k;
    ctx.strokeRect(z.bounds.x, z.bounds.y, z.bounds.w, z.bounds.h);
  }

  for (const h of curr.hazards) {
    ctx.fillStyle = h.kind === 'acid' ? COLORS.acid : COLORS.hazard;
    ctx.beginPath();
    ctx.arc(h.pos.x, h.pos.y, h.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = COLORS.shrine;
  for (const s of curr.shrines) {
    ctx.beginPath();
    ctx.arc(s.pos.x, s.pos.y, 12, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = COLORS.wall;
  for (const w of map.walls) ctx.fillRect(w.x, w.y, w.w, w.h);
  ctx.fillStyle = COLORS.pillar;
  for (const p of map.pillars) ctx.fillRect(p.x, p.y, p.w, p.h);
  for (const p of curr.props) {
    if (!p.alive) continue;
    ctx.fillStyle = p.kind === 'keg' ? '#8a5a2b' : '#6b5f52';
    ctx.fillRect(p.pos.x - p.radius * 0.7, p.pos.y - p.radius * 0.7, p.radius * 1.4, p.radius * 1.4);
  }

  ctx.fillStyle = COLORS.shot;
  for (const p of curr.projectiles) {
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // The dead first, so the living are drawn over them.
  for (const pass of [false, true]) {
    for (let i = 0; i < curr.fighters.length; i++) {
      const f = curr.fighters[i]!;
      if (f.alive !== pass) continue;
      const a = prev.fighters[i]?.id === f.id ? prev.fighters[i]! : f;
      const x = lerp(a.pos.x, f.pos.x, alpha);
      const y = lerp(a.pos.y, f.pos.y, alpha);
      if (!f.alive) {
        const r = f.radius * 0.6;
        ctx.strokeStyle = COLORS.dead;
        ctx.lineWidth = 3 / k;
        ctx.beginPath();
        ctx.moveTo(x - r, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.moveTo(x + r, y - r);
        ctx.lineTo(x - r, y + r);
        ctx.stroke();
        continue;
      }
      const r = f.radius * 1.15;
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(14, 13, 12, 0.85)';
      ctx.lineWidth = 2.5 / k;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(f.facing) * r, y + Math.sin(f.facing) * r);
      ctx.stroke();
      // HP as a short bar under the dot.
      const frac = f.maxHp > 0 ? Math.max(0, Math.min(1, f.hp / f.maxHp)) : 0;
      ctx.fillStyle = 'rgba(14, 13, 12, 0.8)';
      ctx.fillRect(x - r, y + r + 4, r * 2, 5);
      ctx.fillStyle = frac < 0.3 ? '#da4a42' : '#e8e2d9';
      ctx.fillRect(x - r, y + r + 4, r * 2 * frac, 5);
    }
  }
}
