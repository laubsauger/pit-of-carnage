// Owned by: integrator

/**
 * Copy plain data (objects, arrays, numbers, strings, booleans, null) from `src` into `dst` in place
 * and return the copy. Nested objects and arrays already in `dst` are reused, so once `dst` has the
 * shape of `src`, copying again allocates nothing. The app keeps the previous tick's WorldState this
 * way for interpolation: the sim mutates its state in place, so `prev` must be a real copy.
 */
export function copyInto<T>(dst: T | null | undefined, src: T): T {
  return copyValue(dst, src) as T;
}

function copyValue(dst: unknown, src: unknown): unknown {
  if (src === null || typeof src !== 'object') return src;
  if (Array.isArray(src)) {
    const out: unknown[] = Array.isArray(dst) ? dst : [];
    for (let i = 0; i < src.length; i++) out[i] = copyValue(out[i], src[i]);
    out.length = src.length;
    return out;
  }
  const from = src as Record<string, unknown>;
  const out = (dst !== null && typeof dst === 'object' && !Array.isArray(dst) ? dst : {}) as Record<string, unknown>;
  for (const k in from) out[k] = copyValue(out[k], from[k]);
  // A reused slot can hold a different item now (hazards and floor items come and go).
  for (const k in out) if (!(k in from)) delete out[k];
  return out;
}
