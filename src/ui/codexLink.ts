// Owned by: ui (integrator: Codex mount)
// Codex deep links: `#codex` opens the Codex at the top, `#codex/<kind>/<word>` at one entry
// (`#codex/sensor/target.visible` is the entry `sensor:target.visible`), over whatever screen is open.

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
