#!/usr/bin/env node
/**
 * One GPU-heavy browser session at a time, across every agent and terminal on this machine.
 * Other projects share the GPU, so builders queue for it instead of opening pages in parallel.
 *
 *   node scripts/gpu-lock.mjs acquire <who>   waits until the lock is free (up to 30 min), then takes it
 *   node scripts/gpu-lock.mjs release <who>   gives it back (only the holder can, unless --force)
 *   node scripts/gpu-lock.mjs status          prints who holds it and for how long
 *
 * A holder that has not touched the lock for 15 minutes is considered gone and the lock is taken over.
 * Hold it only while a page that runs the renderer is open; close the tab before releasing.
 * Always open the app with `?mute` (for example http://localhost:5321/?mute): it never creates an
 * AudioContext, so automated checks play no sound on the user's machine.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

const LOCK_DIR = '/tmp/pit-of-carnage-gpu.lock';
const OWNER = `${LOCK_DIR}/owner`;
const STALE_MS = 15 * 60 * 1000;
const WAIT_MS = 30 * 60 * 1000;
const POLL_MS = 2000;

const [cmd, who = 'unknown', flag] = process.argv.slice(2);

function holder() {
  try {
    return { who: readFileSync(OWNER, 'utf8').trim(), ageMs: Date.now() - statSync(LOCK_DIR).mtimeMs };
  } catch {
    return null;
  }
}

function tryTake() {
  try {
    mkdirSync(LOCK_DIR);
    writeFileSync(OWNER, who);
    return true;
  } catch {
    const h = holder();
    if (h && h.ageMs > STALE_MS) {
      console.error(`gpu-lock: taking over a stale lock from "${h.who}" (idle ${Math.round(h.ageMs / 60000)} min)`);
      rmSync(LOCK_DIR, { recursive: true, force: true });
      return tryTake();
    }
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (cmd === 'acquire') {
  const start = Date.now();
  let told = false;
  while (!tryTake()) {
    if (Date.now() - start > WAIT_MS) {
      console.error(`gpu-lock: gave up after 30 min waiting for "${holder()?.who ?? 'unknown'}"`);
      process.exit(1);
    }
    if (!told) {
      console.error(`gpu-lock: waiting for "${holder()?.who ?? 'unknown'}" to finish its browser session...`);
      told = true;
    }
    await sleep(POLL_MS);
  }
  console.log(`gpu-lock: acquired by "${who}"`);
  console.log('gpu-lock: open the app with ?mute (e.g. http://localhost:<port>/?mute) so it plays no sound; close the tab before release.');
} else if (cmd === 'release') {
  const h = holder();
  if (!h) {
    console.log('gpu-lock: not held');
  } else if (h.who !== who && flag !== '--force') {
    console.error(`gpu-lock: held by "${h.who}", not "${who}"; pass --force to release anyway`);
    process.exit(1);
  } else {
    rmSync(LOCK_DIR, { recursive: true, force: true });
    console.log(`gpu-lock: released by "${who}"`);
  }
} else if (cmd === 'status') {
  const h = holder();
  console.log(h ? `gpu-lock: held by "${h.who}" for ${Math.round(h.ageMs / 1000)} s` : 'gpu-lock: free');
} else {
  console.error('usage: node scripts/gpu-lock.mjs acquire|release|status <who> [--force]');
  process.exit(2);
}
