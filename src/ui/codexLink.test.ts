import { describe, expect, it } from 'vitest';
import { codexHash, codexIdFromHash } from './codexLink';

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
