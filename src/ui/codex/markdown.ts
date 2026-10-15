// Owned by: ui
// A small reader for the Markdown the rulebook generator writes (src/strategy/rulebook.ts):
// headings, paragraphs, lists, tables and fenced code, plus **bold**, *italic* and `code` inline.
// The Codex shows the rulebook through it and the editor takes its field docs from it, so the
// player reads exactly what the LLM prompt says.

export type MdBlock =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'code'; lang: string; text: string };

export type MdSection = { title: string; blocks: MdBlock[] };

export type MdSpan = { t: 'text' | 'b' | 'i' | 'code'; text: string };

/** Table cells split on unescaped pipes, with `\|` turned back into `|`. */
function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1]!.length, text: h[2]!.trim() });
      i++;
      continue;
    }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ t: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      out.push({ t: 'table', head, rows });
      continue;
    }
    const bullet = /^\s*(-|\d+\.)\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && bullet.test(lines[i]!)) items.push(lines[i++]!.replace(bullet, ''));
      out.push({ t: ordered ? 'ol' : 'ul', items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#|```|\s*\||\s*(-|\d+\.)\s)/.test(lines[i]!)) para.push(lines[i++]!);
    if (para.length === 0) para.push(lines[i++]!);
    out.push({ t: 'p', text: para.join(' ') });
  }
  return out;
}

/** The document cut at its `##` headings. Text before the first one is the section "". */
export function sections(md: string): MdSection[] {
  const out: MdSection[] = [{ title: '', blocks: [] }];
  for (const b of parseMarkdown(md)) {
    if (b.t === 'h' && b.level <= 2) out.push({ title: b.text, blocks: [] });
    else out[out.length - 1]!.blocks.push(b);
  }
  return out.filter((s) => s.title || s.blocks.length);
}

/** Inline spans: `code`, **bold**, *italic*; everything else is text. */
export function inline(text: string): MdSpan[] {
  const out: MdSpan[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ t: 'text', text: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ t: 'code', text: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'b', text: m[2] });
    else out.push({ t: 'i', text: m[3]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ t: 'text', text: text.slice(at) });
  return out;
}

/** Inline Markdown reduced to plain text (for search and tooltips). */
export function plain(text: string): string {
  return inline(text).map((s) => s.text).join('');
}

/** The rows of the first table under the heading `title` (any level), or [] when there is none. */
export function tableUnder(blocks: readonly MdBlock[], title: string): string[][] {
  let inside = false;
  for (const b of blocks) {
    if (b.t === 'h') inside = b.text === title;
    else if (inside && b.t === 'table') return b.rows;
  }
  return [];
}
