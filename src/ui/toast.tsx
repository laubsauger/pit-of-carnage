// Owned by: ui
// One-line confirmations ("Report copied.") and the clipboard helper they usually follow.
import { useEffect, useState } from 'react';

type Listener = (msg: string) => void;
const listeners = new Set<Listener>();

export function toast(message: string): void {
  listeners.forEach((fn) => fn(message));
}

export function Toaster() {
  const [msg, setMsg] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => {
    let n = 0;
    const fn: Listener = (text) => setMsg({ text, n: ++n });
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), 2400);
    return () => window.clearTimeout(t);
  }, [msg]);
  return msg ? (
    <div className="toast" role="status" key={msg.n}>
      {msg.text}
    </div>
  ) : null;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Copy and confirm. `what` names the thing copied: "Report", "LLM prompt", "Strategy code". */
export async function copyAndToast(text: string, what: string): Promise<void> {
  const ok = await copyText(text);
  toast(ok ? `${what} copied (${text.length.toLocaleString('en-US')} characters).` : 'The browser blocked the clipboard. Try again from a click.');
}
