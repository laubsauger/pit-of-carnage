// Owned by: net
/**
 * How a room reaches other browsers. The real one is WebRTC through Trystero (`./trystero`, loaded
 * only when someone opens a room); tests use `createMemoryHub`, which serialises every message
 * through JSON like the wire does and delivers it when the test says so.
 */

/** A peer-to-peer link to everyone else in one room. Messages are plain JSON values. */
export interface Transport {
  /** This browser's peer id in the room (random per page load). */
  readonly selfId: string;
  /** To one peer, or to everyone when `to` is omitted. */
  send(msg: unknown, to?: string): void;
  onMessage: ((msg: unknown, from: string) => void) | null;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
  /** A connection problem worth telling the player about (one plain sentence). */
  onError: ((line: string) => void) | null;
  /** Peers connected right now. */
  peers(): string[];
  leave(): void;
}

type Delivery = { to: string; from: string; kind: 'msg' | 'join' | 'leave'; data?: string };

export type MemoryHub = {
  /** A new browser in the room. */
  join(id?: string): Transport;
  /**
   * Deliver queued messages (and whatever they cause) until nothing is left. Throws when the
   * traffic does not settle within `maxDeliveries`, so a test with a message loop fails loudly.
   */
  flush(maxDeliveries?: number): number;
  /** Messages delivered so far, by sender. */
  sent: Map<string, number>;
};

/** In-process room for tests: every peer sees every other, messages go through JSON.stringify. */
export function createMemoryHub(): MemoryHub {
  const peers = new Map<string, Transport>();
  const queue: Delivery[] = [];
  const sent = new Map<string, number>();
  let n = 0;

  function join(id = `peer${++n}`): Transport {
    if (peers.has(id)) throw new Error(`Peer id ${id} is already in the room.`);
    let gone = false;
    const t: Transport = {
      selfId: id,
      onMessage: null,
      onPeerJoin: null,
      onPeerLeave: null,
      onError: null,
      send(msg, to) {
        if (gone) return;
        const data = JSON.stringify(msg);
        for (const other of peers.keys()) {
          if (other === id || (to !== undefined && other !== to)) continue;
          queue.push({ to: other, from: id, kind: 'msg', data });
        }
      },
      peers: () => [...peers.keys()].filter((p) => p !== id),
      leave() {
        if (gone) return;
        gone = true;
        peers.delete(id);
        for (const other of peers.keys()) queue.push({ to: other, from: id, kind: 'leave' });
      },
    };
    for (const other of peers.keys()) {
      queue.push({ to: other, from: id, kind: 'join' });
      queue.push({ to: id, from: other, kind: 'join' });
    }
    peers.set(id, t);
    return t;
  }

  function flush(maxDeliveries = 100_000): number {
    let count = 0;
    while (queue.length > 0) {
      if (++count > maxDeliveries) throw new Error(`Memory hub: traffic did not settle after ${maxDeliveries} deliveries (message loop?).`);
      const d = queue.shift()!;
      const t = peers.get(d.to);
      if (!t) continue;
      if (d.kind === 'join') t.onPeerJoin?.(d.from);
      else if (d.kind === 'leave') t.onPeerLeave?.(d.from);
      else {
        sent.set(d.from, (sent.get(d.from) ?? 0) + 1);
        t.onMessage?.(JSON.parse(d.data!), d.from);
      }
    }
    return count;
  }

  return { join, flush, sent };
}

/**
 * Call `fn` about every `ms` milliseconds, also while the tab is in the background. Browsers slow
 * page timers in hidden tabs to once a second; a dedicated worker's timer keeps its pace, so the
 * host's matches do not crawl when the host looks at another tab. Falls back to a page timer.
 * Returns a stop function.
 */
export function startTicker(fn: () => void, ms: number): () => void {
  if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
    try {
      const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${Math.max(4, Math.round(ms))});`], { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = () => fn();
      return () => worker.terminate();
    } catch {
      // Workers from blob URLs refused (strict CSP): a page timer still works in the foreground.
    }
  }
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
}
