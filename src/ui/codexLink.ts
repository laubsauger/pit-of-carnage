// Owned by: ui (integrator: Codex mount)
// Codex deep links: `#codex` opens the Codex at the top, `#codex/<kind>/<word>` at one entry
// (`#codex/sensor/target.visible` is the entry `sensor:target.visible`), over whatever screen is open.
import { SENSORS, SENSOR_INDEX } from '../brain';
import type { MapDef, MapObjectKind } from '../core';

/** The Codex entry a URL hash asks for: '' for the top, an entry id, or null when the hash is not a Codex link. */
export function codexIdFromHash(hash: string): string | null {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'codex') return '';
  if (!h.startsWith('codex/')) return null;
  const [kind, ...rest] = h.slice('codex/'.length).split('/').map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (!kind) return '';
  return rest.length > 0 ? `${kind}:${rest.join('/')}` : kind;
}

/** The shareable hash for a Codex entry id ('' = the top). */
export function codexHash(id: string): string {
  if (!id) return '#codex';
  const at = id.indexOf(':');
  const parts = at < 0 ? [id] : [id.slice(0, at), id.slice(at + 1)];
  return `#codex/${parts.map(encodeURIComponent).join('/')}`;
}

/**
 * The Codex entry for a map object under the pointer: its rule (`hazard:acid`, `prop:keg`,
 * `pickup:shrine`, `pickup:haste`), read from the map it stands on. Null for an object the map does
 * not list (nothing to link to).
 */
export function objectCodexId(map: MapDef | null, kind: MapObjectKind, id: string): string | null {
  if (!map) return null;
  switch (kind) {
    case 'shrine':
      return map.shrines.some((s) => s.id === id) ? 'pickup:shrine' : null;
    case 'pickup': {
      const p = map.pickups.find((x) => x.id === id);
      return p ? `pickup:${p.kind}` : null;
    }
    case 'hazard': {
      const h = map.hazards.find((x) => x.id === id);
      return h ? `hazard:${h.kind}` : null;
    }
    case 'prop': {
      const p = map.props.find((x) => x.id === id);
      return p ? `prop:${p.kind}` : null;
    }
  }
}

/**
 * The Codex entry for a sensor the inspector lists: a self sensor (`sensor:self.hp`) or a target
 * sensor (`fighter-sensor:target.distance`; `it.*` reads the same card). Null for a memory slot,
 * which is the strategy's own word.
 */
export function sensorCodexId(name: string): string | null {
  const i = SENSOR_INDEX.get(name);
  const s = i === undefined ? undefined : SENSORS[i];
  if (!s) return null;
  if (s.scope === 'self') return `sensor:${s.name}`;
  return `fighter-sensor:target.${s.name.slice(s.name.indexOf('.') + 1)}`;
}
