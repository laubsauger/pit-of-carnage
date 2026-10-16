import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_KEYS, SKILLS, WEAPONS } from '../core';
import type { MapObjectKind } from '../core';
import { MAPS } from '../sim';
import { SENSORS } from '../brain';
import { codexHash, codexIdFromHash, objectCodexId, sensorCodexId } from './codexLink';
import { entryById } from './editor/lexicon';

// SPEC "Codex everywhere": entries have stable URL anchors, so a shared link opens the right page.
describe('Codex deep links', () => {
  it('reads #codex and #codex/<kind>/<word> as entry ids, and ignores other hashes', () => {
    expect(codexIdFromHash('#codex')).toBe('');
    expect(codexIdFromHash('#codex/sensor/target.visible')).toBe('sensor:target.visible');
    expect(codexIdFromHash('#codex/weapon/LONGBOW')).toBe('weapon:LONGBOW');
    expect(codexIdFromHash('#watch')).toBeNull();
    expect(codexIdFromHash('#codexy')).toBeNull();
    expect(codexIdFromHash('')).toBeNull();
  });

  it('round-trips every entry id through its hash, odd characters included', () => {
    for (const id of ['', 'sensor:self.hp', 'starter:lurk', 'place:behind(X, d)', 'rule:match/wallCrushDamage']) {
      expect(codexIdFromHash(codexHash(id))).toBe(id);
    }
  });
});

// A "Codex" link that opens nothing would teach players to stop clicking them.
describe('Codex links from the Watch screen', () => {
  it('links every shrine, power-up, hazard and prop on every map to an entry that exists', () => {
    for (const map of Object.values(MAPS)) {
      const objects: [MapObjectKind, string][] = [
        ...map.shrines.map((s): [MapObjectKind, string] => ['shrine', s.id]),
        ...map.pickups.map((p): [MapObjectKind, string] => ['pickup', p.id]),
        ...map.hazards.map((h): [MapObjectKind, string] => ['hazard', h.id]),
        ...map.props.map((p): [MapObjectKind, string] => ['prop', p.id]),
      ];
      for (const [kind, id] of objects) {
        const entry = objectCodexId(map, kind, id);
        expect(entry, `${map.id} ${kind} ${id}`).not.toBeNull();
        expect(entryById(entry!), `${map.id} ${kind} ${id} -> ${entry}`).not.toBeNull();
      }
    }
  });

  it('links nothing for an object the map does not list', () => {
    expect(objectCodexId(MAPS.pit!, 'hazard', 'no-such-hazard')).toBeNull();
    expect(objectCodexId(null, 'shrine', 'x')).toBeNull();
  });

  it('links every sensor the inspector lists to its card, and leaves memory slots alone', () => {
    for (const s of SENSORS) {
      const id = sensorCodexId(s.name);
      expect(id, s.name).not.toBeNull();
      expect(entryById(id!), `${s.name} -> ${id}`).not.toBeNull();
    }
    expect(sensorCodexId('my_memory_slot')).toBeNull();
  });

  it('has an entry behind every attribute bar, weapon and skill the inspector links', () => {
    for (const k of ATTRIBUTE_KEYS) expect(entryById(`attribute:${k}`), k).not.toBeNull();
    for (const w of Object.keys(WEAPONS)) expect(entryById(`weapon:${w}`), w).not.toBeNull();
    for (const s of Object.keys(SKILLS)) expect(entryById(`skill:${s}`), s).not.toBeNull();
  });
});
