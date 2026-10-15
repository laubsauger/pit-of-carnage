// Owned by: ui
import { STEER_DIRS } from '../../core';
import { ringPoint } from '../hud';

type Props = {
  ratings: readonly number[];
  size: number;
  /** Chosen heading (radians), drawn as an arrow. */
  heading?: number | null;
  /** Current body facing (radians), drawn as a short tick. */
  facing?: number | null;
  color?: string;
  /** Another rating set drawn on top as an outline (a single term being inspected). */
  overlay?: readonly number[] | null;
  label?: string;
};

/**
 * Context-steering ring: one spoke per direction, outward for positive ratings (wanted), inward
 * in red for negative ones (danger). Oriented like the arena: east right, south down.
 */
export function SteeringRing({ ratings, size, heading = null, facing = null, color = '#e8e2d9', overlay = null, label }: Props) {
  const c = size / 2;
  const base = size * 0.27;
  const reach = size * 0.19;
  const small = size < 80;
  const n = ratings.length || STEER_DIRS;

  const spokes = [];
  const outline: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, ratings[i] ?? 0));
    const a = ringPoint(i, base);
    const b = ringPoint(i, base + v * reach);
    outline.push(`${(c + b.x).toFixed(1)},${(c + b.y).toFixed(1)}`);
    if (Math.abs(v) < 0.02) continue;
    spokes.push(
      <line
        key={i}
        x1={c + a.x}
        y1={c + a.y}
        x2={c + b.x}
        y2={c + b.y}
        stroke={v > 0 ? color : 'var(--blood)'}
        strokeOpacity={v > 0 ? 0.35 + 0.65 * v : 0.5 + 0.5 * -v}
        strokeWidth={small ? 2.2 : 3.6}
        strokeLinecap="round"
      />,
    );
  }

  let overlayPath: string | null = null;
  if (overlay && overlay.length) {
    overlayPath = overlay
      .map((raw, i) => {
        const v = Math.max(-1, Math.min(1, raw));
        const p = ringPoint(i, base + v * reach);
        return `${(c + p.x).toFixed(1)},${(c + p.y).toFixed(1)}`;
      })
      .join(' ');
  }

  const arrow = (angle: number, len: number) => ({ x: c + Math.cos(angle) * len, y: c + Math.sin(angle) * len });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label ?? 'Steering ring'}>
      <circle cx={c} cy={c} r={base} fill="none" stroke="var(--stone-4)" strokeWidth={1} />
      {!small ? (
        <circle cx={c} cy={c} r={base + reach} fill="none" stroke="var(--stone-3)" strokeWidth={1} strokeDasharray="2 4" />
      ) : null}
      <polygon points={outline.join(' ')} fill={color} fillOpacity={0.06} stroke="none" />
      {spokes}
      {overlayPath ? (
        <polygon points={overlayPath} fill="none" stroke="var(--text)" strokeWidth={1.2} strokeDasharray="3 2" />
      ) : null}
      {facing !== null && !small ? (
        <line
          x1={arrow(facing, base * 0.35).x}
          y1={arrow(facing, base * 0.35).y}
          x2={arrow(facing, base * 0.8).x}
          y2={arrow(facing, base * 0.8).y}
          stroke="var(--text-faint)"
          strokeWidth={2}
          strokeLinecap="round"
        />
      ) : null}
      {heading !== null ? <HeadingArrow c={c} angle={heading} len={base + reach + (small ? 2 : 6)} color={color} small={small} /> : null}
      <circle cx={c} cy={c} r={small ? 2 : 3} fill="var(--text-dim)" />
    </svg>
  );
}

function HeadingArrow({ c, angle, len, color, small }: { c: number; angle: number; len: number; color: string; small: boolean }) {
  const tip = { x: c + Math.cos(angle) * len, y: c + Math.sin(angle) * len };
  const back = len - (small ? 5 : 9);
  const w = small ? 3 : 5;
  const bx = c + Math.cos(angle) * back;
  const by = c + Math.sin(angle) * back;
  const nx = -Math.sin(angle) * w;
  const ny = Math.cos(angle) * w;
  return (
    <g>
      <line x1={c} y1={c} x2={bx} y2={by} stroke={color} strokeWidth={small ? 1 : 1.5} strokeOpacity={0.7} />
      <polygon points={`${tip.x},${tip.y} ${bx + nx},${by + ny} ${bx - nx},${by - ny}`} fill={color} />
    </g>
  );
}
