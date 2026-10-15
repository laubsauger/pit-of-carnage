// Owned by: render-world
// Placeholder stub from the architect: clears the canvas to the floor colour. Replace wholesale.
import type { FxModule, GameRenderer } from '../core';

export function createRenderer(canvas: HTMLCanvasElement, fx?: FxModule): GameRenderer {
  const ctx = canvas.getContext('2d');
  const clear = () => {
    if (!ctx) return;
    ctx.fillStyle = '#161412';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };
  return {
    setMap: clear,
    render: clear,
    onEvents: (events, state) => fx?.onEvents(events, state),
    setSelected() {},
    setHovered() {},
    setFollow() {},
    setOverlay() {},
    setDecisionProvider() {},
    pick: () => null,
    setTimeScale() {},
    resize(w, h) {
      canvas.width = Math.max(1, Math.floor(w * devicePixelRatio));
      canvas.height = Math.max(1, Math.floor(h * devicePixelRatio));
      clear();
    },
    captureStream: (fps) => canvas.captureStream(fps),
    reset: () => fx?.reset(),
    dispose: () => fx?.dispose(),
  };
}
