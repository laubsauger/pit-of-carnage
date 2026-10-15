// Owned by: net
/**
 * Room codes: five letters read out loud or typed from a chat ("KRZBW"). No I or O, which look
 * like 1 and 0. Codes are the only way into a room: there is no session browser.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;
/** Codes typed by people may be 4 to 6 letters (older or hand-made ones). */
export const CODE_MIN = 4;
export const CODE_MAX = 6;

/** A fresh code. `randomInt(n)` returns an integer in [0, n); defaults to the browser's crypto. */
export function newRoomCode(randomInt: (n: number) => number = cryptoInt): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function cryptoInt(n: number): number {
  // Rejection sampling keeps every letter equally likely.
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const a = new Uint32Array(1);
  for (let i = 0; i < 64; i++) {
    crypto.getRandomValues(a);
    if (a[0]! < limit) return a[0]! % n;
  }
  return a[0]! % n;
}

/**
 * A code as typed ("krz-bw ", "K R Z B W") in canonical form, or an explanation of what is wrong.
 */
export function parseRoomCode(input: string): { code: string } | { problem: string } {
  const s = input.replace(/[\s-]+/g, '').toUpperCase();
  if (s.length === 0) return { problem: 'Type the room code you were given.' };
  if (/[IO]/.test(s)) return { problem: 'Room codes have no I or O. Check the code with the host.' };
  if (!/^[A-Z]+$/.test(s)) return { problem: 'Room codes are letters only.' };
  if (s.length < CODE_MIN || s.length > CODE_MAX) return { problem: `Room codes are ${CODE_MIN} to ${CODE_MAX} letters; this one has ${s.length}.` };
  return { code: s };
}

/** Share link: the page with `?room=CODE`, opening on the Room screen. */
export function roomLink(pageUrl: string, code: string): string {
  const u = new URL(pageUrl);
  u.searchParams.set('room', code);
  u.hash = 'room';
  return u.toString();
}

/** The code in a share link's query string, if it is a valid one. */
export function codeFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get('room');
  if (!raw) return null;
  const r = parseRoomCode(raw);
  return 'code' in r ? r.code : null;
}

/** A random secret that identifies this tab to hosts across leave and rejoin (never shown to other peers). */
export function newClientId(): string {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63];
  return s;
}
