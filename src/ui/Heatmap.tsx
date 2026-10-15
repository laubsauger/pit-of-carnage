// Owned by: ui
// Where a fighter (or a strategy, summed over a batch) spent its time, drawn over the map's walls
// and pillars so "the dark corners" means something. One hue, darker = more time, against the
// busiest cell of this heatmap.
import type { Heatmap as HeatmapData } from '../core';
import { MAPS } from '../sim';
import { heatShades, heatSummary } from './reports';

type Props = {
  heatmap: HeatmapData;
  mapId: string;
  /** Drawn width in CSS px; the height follows the map's shape. */
  width?: number;
  /** Words under the map ("Spent 46% of its time in the centre."); off for tight spots. */
  caption?: boolean;
  title?: string;
};

export function Heatmap({ heatmap, mapId, width = 240, caption = true, title }: Props) {
  const map = MAPS[mapId];
  const w = map?.width ?? heatmap.cols * heatmap.cell;
  const h = map?.height ?? heatmap.rows * heatmap.cell;
  const shades = heatShades(heatmap);
  const summary = heatSummary(heatmap);
  const c = heatmap.cell;
  return (
    <figure className="heatmap">
      {title ? <figcaption className="hm-title">{title}</figcaption> : null}
      <svg viewBox={`0 0 ${w} ${h}`} width={width} height={Math.round((width * h) / w)} role="img" aria-label={summary}>
        <rect width={w} height={h} fill="var(--stone-2)" />
        {shades.map((v, i) =>
          v > 0 ? (
            <rect
              key={i}
              x={(i % heatmap.cols) * c}
              y={Math.floor(i / heatmap.cols) * c}
              width={c}
              height={c}
              fill="var(--heat)"
              // A gentle curve, so cells with a little time still show against the busiest one.
              fillOpacity={0.1 + 0.9 * Math.pow(v, 0.7)}
            />
          ) : null,
        )}
        {map
          ? [...map.walls, ...map.pillars].map((r, i) => <rect key={`w${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill="var(--stone-4)" />)
          : null}
        {map?.shrines.map((s) => <circle key={s.id} cx={s.pos.x} cy={s.pos.y} r={16} fill="none" stroke="#6fbf73" strokeWidth={6} opacity={0.8} />)}
        {map?.pickups.map((p) => <circle key={p.id} cx={p.pos.x} cy={p.pos.y} r={13} fill="none" stroke="#d9a441" strokeWidth={6} opacity={0.8} />)}
      </svg>
      {caption ? <figcaption className="hm-caption">{summary}</figcaption> : null}
    </figure>
  );
}
