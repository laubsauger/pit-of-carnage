// Owned by: render-fx
/**
 * Paints every flying part once into a canvas atlas: the 10 gibs, severed arm and leg, the six
 * class helmets and the six weapons. Top-down cartoon style with a dark ink outline (like the
 * fighters), light from the top-left and a little gore on anything that came out of a body.
 *
 * Each cell is drawn in world pixels centred on the part, +x pointing "forward" (the piece's
 * rotation axis). The lower half of the canvas holds a tint mask (white = take the owner's colour),
 * so sleeves, trousers and hoods match the fighter they came off.
 */

import * as THREE from 'three/webgpu';
import { ATLAS, PART_IDS, PARTS } from './parts';
import type { PartId } from './parts';

type Ctx = CanvasRenderingContext2D;
type Paint = (c: Ctx, m: Ctx) => void;

const INK = '#1a0f0e';
const LINE = 1.15;
const BONE = '#ece3cf';
const BONE_SHADE = '#b6a688';
const SKIN = '#e0a982';
const SKIN_SHADE = '#b97a58';
const MEAT = '#a3171d';
const MEAT_DARK = '#5e0a0e';
const STEEL = '#c9ced6';
const STEEL_SHADE = '#6e7682';
const LEATHER = '#6b4528';
const LEATHER_DARK = '#3f2716';
const WOOD = '#8a5a32';
const WOOD_DARK = '#5a3519';
/** Base grey of tinted cloth; the shader rescales it to the owner's colour. */
const CLOTH = '#c4c4c4';
const CLOTH_SHADE = '#8a8a8a';

function ink(c: Ctx, w = LINE): void {
  c.lineWidth = w;
  c.strokeStyle = INK;
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.stroke();
}

function radial(c: Ctx, x: number, y: number, r: number, light: string, dark: string): CanvasGradient {
  const g = c.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.1, x, y, r * 1.1);
  g.addColorStop(0, light);
  g.addColorStop(1, dark);
  return g;
}

function linear(c: Ctx, x0: number, y0: number, x1: number, y1: number, a: string, b: string): CanvasGradient {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  return g;
}

function ellipse(c: Ctx, x: number, y: number, rx: number, ry: number, rot = 0): void {
  c.beginPath();
  c.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}

function roundRect(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

/** Glossy blood blob. */
function gore(c: Ctx, x: number, y: number, r: number): void {
  c.beginPath();
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const rr = r * (0.75 + 0.3 * Math.sin(i * 2.7 + x));
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.fillStyle = radial(c, x, y, r, MEAT, MEAT_DARK);
  c.fill();
  ellipse(c, x - r * 0.3, y - r * 0.3, r * 0.22, r * 0.14, -0.6);
  c.fillStyle = 'rgba(255,220,215,0.75)';
  c.fill();
}

/** Severed end: red flesh ring around a bone. `dir` = which way the cut faces. */
function stump(c: Ctx, x: number, y: number, r: number, dir: number): void {
  ellipse(c, x, y, r * 0.55, r, dir);
  c.fillStyle = radial(c, x, y, r, '#c42027', MEAT_DARK);
  c.fill();
  ink(c, LINE * 0.8);
  ellipse(c, x + Math.cos(dir) * r * 0.1, y + Math.sin(dir) * r * 0.1, r * 0.25, r * 0.35, dir);
  c.fillStyle = BONE;
  c.fill();
}

/** Fill a path in both canvases: shaded grey cloth in colour, white in the tint mask. */
function cloth(c: Ctx, m: Ctx, path: (k: Ctx) => void, x0: number, y0: number, x1: number, y1: number): void {
  path(c);
  c.fillStyle = linear(c, x0, y0, x1, y1, CLOTH, CLOTH_SHADE);
  c.fill();
  ink(c);
  path(m);
  m.fillStyle = '#fff';
  m.fill();
}

// ---------------------------------------------------------------------------------------------
// Gibs
// ---------------------------------------------------------------------------------------------

const skull: Paint = (c) => {
  ellipse(c, -1, 0, 8.6, 7.6);
  c.fillStyle = radial(c, -1, 0, 8.6, '#fbf6ea', BONE_SHADE);
  c.fill();
  ink(c);
  // Eye sockets and nose, facing +x.
  for (const s of [-1, 1]) {
    ellipse(c, 3.2, s * 3.1, 2.1, 1.8);
    c.fillStyle = '#2a1714';
    c.fill();
  }
  c.beginPath();
  c.moveTo(5.6, -0.9);
  c.lineTo(5.6, 0.9);
  c.lineTo(3.9, 0);
  c.closePath();
  c.fillStyle = '#2a1714';
  c.fill();
  // Teeth along the front edge.
  c.fillStyle = '#fffaf0';
  for (let i = -2; i <= 2; i++) {
    roundRect(c, 6.6, i * 1.25 - 0.55, 1.6, 1.1, 0.3);
    c.fill();
  }
  // A crack and some gore at the back.
  c.beginPath();
  c.moveTo(-6, -4);
  c.lineTo(-3.5, -2.2);
  c.lineTo(-4.2, 0.4);
  c.lineWidth = 0.6;
  c.strokeStyle = '#6f5a44';
  c.stroke();
  gore(c, -7.6, 2.8, 2.4);
};

const jaw: Paint = (c) => {
  c.beginPath();
  c.moveTo(-6, -6.2);
  c.quadraticCurveTo(7, -7.2, 7, 0);
  c.quadraticCurveTo(7, 7.2, -6, 6.2);
  c.lineTo(-6, 3.6);
  c.quadraticCurveTo(3.8, 4.2, 3.8, 0);
  c.quadraticCurveTo(3.8, -4.2, -6, -3.6);
  c.closePath();
  c.fillStyle = linear(c, -6, -6, 6, 6, '#f7f0e0', BONE_SHADE);
  c.fill();
  ink(c);
  c.fillStyle = '#fffaf0';
  for (let i = 0; i < 7; i++) {
    const a = -1.25 + (i / 6) * 2.5;
    ellipse(c, Math.cos(a) * 4.4 + 0.2, Math.sin(a) * 4.6, 0.8, 0.65, a);
    c.fill();
  }
  gore(c, -6, -5, 1.7);
  gore(c, -6, 5, 1.5);
};

const ribcage: Paint = (c) => {
  // Meat between the ribs first.
  ellipse(c, 0, 0, 10, 7.6);
  c.fillStyle = radial(c, 0, 0, 10, '#9c1d22', '#4a080b');
  c.fill();
  // Ribs: curved bones from the spine (along x) around both sides.
  c.lineCap = 'round';
  for (let i = 0; i < 5; i++) {
    const x = -7 + i * 3.4;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(x, s * 1.2);
      c.quadraticCurveTo(x + 2.5, s * 8.6, x + 6, s * 5.8);
      c.lineWidth = 3.1;
      c.strokeStyle = INK;
      c.stroke();
      c.lineWidth = 1.7;
      c.strokeStyle = BONE;
      c.stroke();
    }
  }
  // Spine.
  roundRect(c, -10, -1.6, 20, 3.2, 1.4);
  c.fillStyle = linear(c, 0, -1.6, 0, 1.6, '#fbf6ea', BONE_SHADE);
  c.fill();
  ink(c, LINE * 0.9);
  for (let i = -3; i <= 3; i++) {
    c.beginPath();
    c.moveTo(i * 2.7, -1.6);
    c.lineTo(i * 2.7, 1.6);
    c.lineWidth = 0.5;
    c.strokeStyle = '#8f7e63';
    c.stroke();
  }
  gore(c, 9.5, 2.5, 2);
};

const heart: Paint = (c) => {
  c.beginPath();
  c.moveTo(6.2, 0);
  c.bezierCurveTo(2, 7.5, -6.5, 6.8, -5, 1.2);
  c.bezierCurveTo(-6.6, -4.6, -1, -6.4, 1, -2.4);
  c.bezierCurveTo(3, -5, 7.6, -3.4, 6.2, 0);
  c.closePath();
  c.fillStyle = radial(c, -1, -1, 7, '#d6343a', '#5a080d');
  c.fill();
  ink(c);
  // Aorta stubs.
  for (const [x, y, r] of [[-4.4, -3.6, 1.5], [-2.2, -5, 1.2]] as const) {
    ellipse(c, x, y, r, r);
    c.fillStyle = '#e8a3a0';
    c.fill();
    ink(c, LINE * 0.7);
  }
  // Coronary vessel and gloss.
  c.beginPath();
  c.moveTo(-1, -1.5);
  c.quadraticCurveTo(1.5, 1, 0.5, 4);
  c.lineWidth = 0.6;
  c.strokeStyle = '#4c0a12';
  c.stroke();
  ellipse(c, -2.6, -0.4, 1.6, 0.9, -0.7);
  c.fillStyle = 'rgba(255,225,220,0.8)';
  c.fill();
};

const eyeball: Paint = (c) => {
  // Optic nerve trailing behind.
  c.beginPath();
  c.moveTo(-1, 0);
  c.quadraticCurveTo(-4, 1.8, -5.6, 0.6);
  c.lineWidth = 2.2;
  c.strokeStyle = INK;
  c.stroke();
  c.lineWidth = 1.3;
  c.strokeStyle = '#d97a7a';
  c.stroke();
  ellipse(c, 0.6, 0, 3.6, 3.6);
  c.fillStyle = radial(c, 0.6, 0, 3.6, '#ffffff', '#d9cfc8');
  c.fill();
  ink(c, LINE * 0.8);
  // Veins.
  c.lineWidth = 0.3;
  c.strokeStyle = '#c4343a';
  for (const a of [2.2, 3.0, 3.8]) {
    c.beginPath();
    c.moveTo(0.6 + Math.cos(a) * 3.4, Math.sin(a) * 3.4);
    c.lineTo(0.6 + Math.cos(a) * 1.8, Math.sin(a + 0.4) * 1.6);
    c.stroke();
  }
  ellipse(c, 2.1, 0, 1.6, 1.6);
  c.fillStyle = '#4a8a5c';
  c.fill();
  ellipse(c, 2.4, 0, 0.8, 0.8);
  c.fillStyle = '#0d0909';
  c.fill();
  ellipse(c, 1.4, -1.2, 0.6, 0.45);
  c.fillStyle = '#fff';
  c.fill();
};

const intestine: Paint = (c) => {
  const path = (k: Ctx) => {
    k.beginPath();
    k.moveTo(-16, 3);
    k.bezierCurveTo(-12, -6, -6, -6, -5, 0);
    k.bezierCurveTo(-4, 6, 3, 7, 4, 0);
    k.bezierCurveTo(5, -6, 12, -7, 13, -1);
    k.bezierCurveTo(14, 4, 9, 6, 8, 3);
  };
  path(c);
  c.lineWidth = 5.6;
  c.strokeStyle = INK;
  c.stroke();
  path(c);
  c.lineWidth = 4;
  c.strokeStyle = '#d98585';
  c.stroke();
  path(c);
  c.lineWidth = 1.4;
  c.strokeStyle = '#f5c1bd';
  c.setLineDash([1.6, 2.4]);
  c.stroke();
  c.setLineDash([]);
  gore(c, -16, 3, 2.2);
  gore(c, 8, 3, 1.6);
};

const leg: Paint = (c, m) => {
  // Bare shin and foot, then the trouser-tinted thigh, then the stump.
  roundRect(c, 0, -2.6, 12, 5.2, 2.6);
  c.fillStyle = linear(c, 0, -2.6, 0, 2.6, SKIN, SKIN_SHADE);
  c.fill();
  ink(c);
  ellipse(c, 14, 0, 4.2, 3);
  c.fillStyle = radial(c, 14, 0, 4.2, SKIN, SKIN_SHADE);
  c.fill();
  ink(c);
  cloth(c, m, (k) => roundRect(k, -15, -3.6, 17, 7.2, 3.2), 0, -3.6, 0, 3.6);
  stump(c, -15, 0, 3.6, 0);
  gore(c, -12, 3, 1.6);
};

const boot: Paint = (c) => {
  roundRect(c, -6, -3.8, 14, 7.6, 3.6);
  c.fillStyle = linear(c, 0, -3.8, 0, 3.8, LEATHER, LEATHER_DARK);
  c.fill();
  ink(c);
  // Laces and the cuff with the ankle poking out.
  c.lineWidth = 0.5;
  c.strokeStyle = '#d9c9a8';
  for (let i = 0; i < 3; i++) {
    c.beginPath();
    c.moveTo(-1 + i * 2.2, -1.6);
    c.lineTo(0.2 + i * 2.2, 1.6);
    c.stroke();
  }
  roundRect(c, -8.4, -3.4, 4, 6.8, 1.6);
  c.fillStyle = LEATHER_DARK;
  c.fill();
  ink(c, LINE * 0.8);
  stump(c, -7.6, 0, 2.6, 0);
};

const weaponArm: Paint = (c, m) => {
  // Forearm skin, fist at +x, sleeve toward -x, torn shoulder.
  roundRect(c, -2, -2.6, 12, 5.2, 2.6);
  c.fillStyle = linear(c, 0, -2.6, 0, 2.6, SKIN, SKIN_SHADE);
  c.fill();
  ink(c);
  ellipse(c, 11.5, 0, 3.8, 3.4);
  c.fillStyle = radial(c, 11.5, 0, 3.8, SKIN, SKIN_SHADE);
  c.fill();
  ink(c);
  c.lineWidth = 0.5;
  c.strokeStyle = '#8c5338';
  for (const y of [-1.6, 0, 1.6]) {
    c.beginPath();
    c.moveTo(12.6, y - 0.5);
    c.lineTo(14.4, y);
    c.stroke();
  }
  cloth(c, m, (k) => roundRect(k, -13, -3.4, 12, 6.8, 2.8), 0, -3.4, 0, 3.4);
  roundRect(c, 3, -2.8, 3.4, 5.6, 1);
  c.fillStyle = LEATHER;
  c.fill();
  ink(c, LINE * 0.8);
  stump(c, -13, 0, 3.4, 0);
};

const brain: Paint = (c) => {
  ellipse(c, 0, 0, 8.2, 6.4);
  c.fillStyle = radial(c, 0, 0, 8.2, '#f6b8bf', '#b8606e');
  c.fill();
  ink(c);
  // Central fissure and gyri.
  c.beginPath();
  c.moveTo(-7.6, 0);
  c.lineTo(7.6, 0);
  c.lineWidth = 0.8;
  c.strokeStyle = '#8d3a47';
  c.stroke();
  c.lineWidth = 0.55;
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      c.beginPath();
      const x = -6 + i * 3.6;
      c.moveTo(x, s * 1.2);
      c.bezierCurveTo(x + 1.8, s * 2.5, x - 0.8, s * 3.8, x + 1.2, s * 5.2);
      c.stroke();
    }
  }
  ellipse(c, -3, -3, 1.8, 0.9, -0.4);
  c.fillStyle = 'rgba(255,240,240,0.7)';
  c.fill();
  gore(c, 6.5, 4, 1.6);
};

// ---------------------------------------------------------------------------------------------
// Severed limbs
// ---------------------------------------------------------------------------------------------

const limbArm: Paint = (c, m) => {
  // Open hand at +x with fingers, bracer, forearm, sleeve, stump at -x.
  for (const [y, len] of [[-2.4, 4.6], [-0.8, 5.4], [0.8, 5.2], [2.4, 4.2]] as const) {
    roundRect(c, 13, y - 0.7, len, 1.4, 0.7);
    c.fillStyle = SKIN;
    c.fill();
    ink(c, LINE * 0.6);
  }
  roundRect(c, 13.4, -4.6, 3.2, 1.4, 0.7);
  c.fillStyle = SKIN;
  c.fill();
  ink(c, LINE * 0.6);
  ellipse(c, 12.6, 0, 3.4, 3.4);
  c.fillStyle = radial(c, 12.6, 0, 3.4, SKIN, SKIN_SHADE);
  c.fill();
  ink(c);
  roundRect(c, -1, -2.6, 12, 5.2, 2.4);
  c.fillStyle = linear(c, 0, -2.6, 0, 2.6, SKIN, SKIN_SHADE);
  c.fill();
  ink(c);
  roundRect(c, 4, -2.9, 4.6, 5.8, 1.2);
  c.fillStyle = linear(c, 4, -2.9, 4, 2.9, LEATHER, LEATHER_DARK);
  c.fill();
  ink(c, LINE * 0.8);
  cloth(c, m, (k) => roundRect(k, -15, -3.6, 15, 7.2, 3), 0, -3.6, 0, 3.6);
  stump(c, -15, 0, 3.6, 0);
  gore(c, -12.5, -3, 1.8);
};

const limbLeg: Paint = (c, m) => {
  // Boot at +x, shin guard, trouser-tinted thigh, stump at -x.
  roundRect(c, 8, -4.2, 13, 8.4, 4);
  c.fillStyle = linear(c, 8, -4.2, 8, 4.2, LEATHER, LEATHER_DARK);
  c.fill();
  ink(c);
  roundRect(c, 17.4, -3.8, 3, 7.6, 1.4);
  c.fillStyle = '#2b1a10';
  c.fill();
  cloth(c, m, (k) => roundRect(k, -17, -4, 26, 8, 3.6), 0, -4, 0, 4);
  roundRect(c, -1, -3.4, 5, 6.8, 2.2);
  c.fillStyle = linear(c, -1, -3.4, -1, 3.4, STEEL, STEEL_SHADE);
  c.fill();
  ink(c, LINE * 0.8);
  stump(c, -17, 0, 4, 0);
  gore(c, -14, 3.4, 2);
};

// ---------------------------------------------------------------------------------------------
// Helmets (top view, facing +x)
// ---------------------------------------------------------------------------------------------

function steelDome(c: Ctx, r: number): void {
  ellipse(c, 0, 0, r, r * 0.92);
  c.fillStyle = radial(c, 0, 0, r, '#f2f4f7', STEEL_SHADE);
  c.fill();
  ink(c);
}

const helmGreat: Paint = (c) => {
  roundRect(c, -10, -9.4, 20, 18.8, 6);
  c.fillStyle = radial(c, 0, 0, 11, '#eef1f5', STEEL_SHADE);
  c.fill();
  ink(c);
  // Cross ridge and rivets; visor slit at the front edge.
  c.fillStyle = '#9aa2ad';
  roundRect(c, -9.5, -1.3, 19, 2.6, 1);
  c.fill();
  roundRect(c, -1.3, -9, 2.6, 18, 1);
  c.fill();
  c.fillStyle = '#4b525c';
  for (const [x, y] of [[-6, -6], [6, -6], [-6, 6], [6, 6]] as const) {
    ellipse(c, x, y, 0.8, 0.8);
    c.fill();
  }
  roundRect(c, 8.6, -6, 1.6, 12, 0.6);
  c.fillStyle = '#1b1d22';
  c.fill();
};

const helmHorned: Paint = (c) => {
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(-2, s * 7);
    c.quadraticCurveTo(-2, s * 15.5, 7, s * 15);
    c.quadraticCurveTo(1.5, s * 12, 2.5, s * 7);
    c.closePath();
    c.fillStyle = linear(c, 0, s * 7, 6, s * 15, '#f4ead2', '#a8946e');
    c.fill();
    ink(c);
  }
  steelDome(c, 9);
  roundRect(c, -9, -1.2, 18, 2.4, 1);
  c.fillStyle = '#8c949f';
  c.fill();
};

const helmHood: Paint = (c, m) => {
  cloth(c, m, (k) => {
    k.beginPath();
    k.moveTo(9, 0);
    k.bezierCurveTo(9, -10, -6, -11, -10, -3);
    k.quadraticCurveTo(-15, 0, -10, 3);
    k.bezierCurveTo(-6, 11, 9, 10, 9, 0);
    k.closePath();
  }, -10, -10, 8, 10);
  // Folds and the dark face opening.
  c.lineWidth = 0.6;
  c.strokeStyle = 'rgba(0,0,0,0.35)';
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(-8, s * 2);
    c.quadraticCurveTo(-1, s * 6, 6, s * 4);
    c.stroke();
  }
  ellipse(c, 7.4, 0, 1.8, 5);
  c.fillStyle = '#140c0b';
  c.fill();
};

const helmNasal: Paint = (c) => {
  ellipse(c, 0, 0, 10.4, 9.8);
  c.fillStyle = '#6f4b2c';
  c.fill();
  ink(c);
  steelDome(c, 8);
  c.strokeStyle = '#7c8591';
  c.lineWidth = 0.6;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(Math.cos(a) * 7.6, Math.sin(a) * 7.2);
    c.stroke();
  }
  roundRect(c, 7, -1.1, 6, 2.2, 0.8);
  c.fillStyle = linear(c, 7, -1.1, 7, 1.1, '#e7eaee', STEEL_SHADE);
  c.fill();
  ink(c, LINE * 0.8);
};

const helmCap: Paint = (c, m) => {
  // Feather first (it sits behind the cap), then the brimmed cap.
  c.beginPath();
  c.moveTo(-2, -3);
  c.quadraticCurveTo(-12, -10, -15.5, -4.6);
  c.quadraticCurveTo(-9, -4, -2, -1);
  c.closePath();
  c.fillStyle = linear(c, -15, -8, -2, -2, '#f5efe2', '#c9b88f');
  c.fill();
  ink(c, LINE * 0.8);
  c.beginPath();
  c.moveTo(-2, -2);
  c.quadraticCurveTo(-9, -6.5, -14.5, -5);
  c.lineWidth = 0.4;
  c.strokeStyle = '#7d6c4a';
  c.stroke();
  cloth(c, m, (k) => ellipse(k, 1, 0, 11, 8.6), -8, -8, 8, 8);
  cloth(c, m, (k) => ellipse(k, 0, 0, 7, 6.2), -6, -6, 6, 6);
};

const helmWizard: Paint = (c, m) => {
  cloth(c, m, (k) => ellipse(k, 0, 0, 13, 12.4), -12, -12, 12, 12);
  cloth(c, m, (k) => {
    k.beginPath();
    k.moveTo(-6.4, -5);
    k.quadraticCurveTo(2, -4, 9, 3.2);
    k.quadraticCurveTo(1, 5, -6.4, 5);
    k.quadraticCurveTo(-9, 0, -6.4, -5);
    k.closePath();
  }, -6, -6, 8, 6);
  // A little star on the cone.
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 2 : 0.85;
    const x = -2 + Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.closePath();
  c.fillStyle = '#ffe28a';
  c.fill();
};

// ---------------------------------------------------------------------------------------------
// Weapons (lying along +x)
// ---------------------------------------------------------------------------------------------

function grip(c: Ctx, x0: number, x1: number, w: number): void {
  roundRect(c, x0, -w / 2, x1 - x0, w, w / 2);
  c.fillStyle = linear(c, 0, -w / 2, 0, w / 2, LEATHER, LEATHER_DARK);
  c.fill();
  ink(c);
  c.lineWidth = 0.45;
  c.strokeStyle = '#2a190e';
  for (let x = x0 + 1.2; x < x1 - 0.6; x += 1.6) {
    c.beginPath();
    c.moveTo(x, -w / 2);
    c.lineTo(x + 0.9, w / 2);
    c.stroke();
  }
}

function steelBlade(c: Ctx, path: () => void, y0: number, y1: number): void {
  path();
  c.fillStyle = linear(c, 0, y0, 0, y1, '#f4f6f9', STEEL_SHADE);
  c.fill();
  ink(c);
}

const wGreatsword: Paint = (c) => {
  steelBlade(c, () => {
    c.beginPath();
    c.moveTo(-10, -3.2);
    c.lineTo(36, -2.6);
    c.lineTo(44, 0);
    c.lineTo(36, 2.6);
    c.lineTo(-10, 3.2);
    c.closePath();
  }, -3.2, 3.2);
  c.beginPath();
  c.moveTo(-8, 0);
  c.lineTo(34, 0);
  c.lineWidth = 0.8;
  c.strokeStyle = '#8b939e';
  c.stroke();
  roundRect(c, -13, -11, 3.6, 22, 1.6);
  c.fillStyle = linear(c, -13, -11, -10, 11, '#d8b24a', '#7a5a16');
  c.fill();
  ink(c);
  grip(c, -32, -13, 4);
  ellipse(c, -34, 0, 3, 3);
  c.fillStyle = radial(c, -34, 0, 3, '#f0cf62', '#7a5a16');
  c.fill();
  ink(c);
};

const wWarhammer: Paint = (c) => {
  roundRect(c, -34, -2, 56, 4, 2);
  c.fillStyle = linear(c, 0, -2, 0, 2, WOOD, WOOD_DARK);
  c.fill();
  ink(c);
  grip(c, -34, -20, 4.6);
  // Head: flat face on one side, spike on the other.
  c.beginPath();
  c.moveTo(18, -12);
  c.lineTo(28, -12);
  c.lineTo(28, 12);
  c.lineTo(18, 12);
  c.closePath();
  c.fillStyle = linear(c, 18, -12, 28, 12, '#e9ecf0', STEEL_SHADE);
  c.fill();
  ink(c);
  c.beginPath();
  c.moveTo(20, -12);
  c.lineTo(23, -21);
  c.lineTo(26, -12);
  c.closePath();
  c.fillStyle = STEEL;
  c.fill();
  ink(c);
  roundRect(c, 17, 9, 12, 4.4, 1);
  c.fillStyle = '#a1a9b4';
  c.fill();
  ink(c, LINE * 0.8);
};

const wDagger: Paint = (c) => {
  steelBlade(c, () => {
    c.beginPath();
    c.moveTo(-2, -2.4);
    c.lineTo(14, -1.4);
    c.lineTo(18.5, 0);
    c.lineTo(14, 1.4);
    c.lineTo(-2, 2.4);
    c.closePath();
  }, -2.4, 2.4);
  roundRect(c, -4, -6, 2.4, 12, 1);
  c.fillStyle = linear(c, -4, -6, -2, 6, '#b8bec7', '#555c66');
  c.fill();
  ink(c);
  grip(c, -14, -4, 3.4);
  ellipse(c, -15, 0, 1.8, 1.8);
  c.fillStyle = '#9aa2ad';
  c.fill();
  ink(c, LINE * 0.8);
};

const wAxe: Paint = (c) => {
  roundRect(c, -14, -1.6, 24, 3.2, 1.6);
  c.fillStyle = linear(c, 0, -1.6, 0, 1.6, WOOD, WOOD_DARK);
  c.fill();
  ink(c);
  c.beginPath();
  c.moveTo(4, -1.8);
  c.quadraticCurveTo(8, -6, 6, -12);
  c.quadraticCurveTo(13.5, -9, 14.5, -1);
  c.lineTo(14.5, 2);
  c.quadraticCurveTo(13.5, 9, 6, 11);
  c.quadraticCurveTo(8, 5.5, 4, 1.8);
  c.closePath();
  c.fillStyle = linear(c, 4, -12, 14, 12, '#eef1f4', STEEL_SHADE);
  c.fill();
  ink(c);
  c.beginPath();
  c.moveTo(13.4, -6);
  c.quadraticCurveTo(14.6, 0, 13.4, 6);
  c.lineWidth = 0.7;
  c.strokeStyle = '#ffffff';
  c.stroke();
};

const wBow: Paint = (c) => {
  c.beginPath();
  c.moveTo(-6, -34);
  c.quadraticCurveTo(22, 0, -6, 34);
  c.lineWidth = 4.6;
  c.strokeStyle = INK;
  c.stroke();
  c.lineWidth = 3;
  c.strokeStyle = WOOD;
  c.stroke();
  c.lineWidth = 1;
  c.strokeStyle = '#b07a48';
  c.stroke();
  c.beginPath();
  c.moveTo(-6, -34);
  c.lineTo(-6, 34);
  c.lineWidth = 0.6;
  c.strokeStyle = '#efe6d2';
  c.stroke();
  roundRect(c, 5, -3.6, 4, 7.2, 1.4);
  c.fillStyle = LEATHER;
  c.fill();
  ink(c, LINE * 0.8);
};

const wStaff: Paint = (c) => {
  c.beginPath();
  c.moveTo(-38, 0.4);
  c.quadraticCurveTo(-10, -2.4, 26, 0);
  c.lineWidth = 4.4;
  c.strokeStyle = INK;
  c.stroke();
  c.lineWidth = 3;
  c.strokeStyle = WOOD;
  c.stroke();
  // Gnarled claw around the orb.
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(24, s * 1);
    c.quadraticCurveTo(28, s * 7, 35, s * 5);
    c.lineWidth = 2.6;
    c.strokeStyle = INK;
    c.stroke();
    c.lineWidth = 1.5;
    c.strokeStyle = WOOD_DARK;
    c.stroke();
  }
  ellipse(c, 33, 0, 5, 5);
  c.fillStyle = radial(c, 33, 0, 5, '#e9fbff', '#5a3cc4');
  c.fill();
  ink(c);
};

const PAINTERS: Readonly<Record<PartId, Paint>> = {
  skull, jaw, ribcage, heart, eyeball, intestine, leg, boot, weaponArm, brain,
  limbArm, limbLeg,
  helmet_GREATSWORD: helmGreat,
  helmet_WARHAMMER: helmHorned,
  helmet_TWIN_DAGGERS: helmHood,
  helmet_THROWING_AXES: helmNasal,
  helmet_LONGBOW: helmCap,
  helmet_ARCANE_STAFF: helmWizard,
  weapon_GREATSWORD: wGreatsword,
  weapon_WARHAMMER: wWarhammer,
  weapon_TWIN_DAGGERS: wDagger,
  weapon_THROWING_AXES: wAxe,
  weapon_LONGBOW: wBow,
  weapon_ARCANE_STAFF: wStaff,
};

/**
 * Paint the atlas. Colour cells fill the top `ATLAS.rows` rows; the tint mask uses the same layout
 * directly below. Returns a texture ready for node materials (sRGB, mipmapped for soft shadows).
 */
export function createPartAtlas(): THREE.CanvasTexture {
  const { cell, cols, rows } = ATLAS;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell;
  canvas.height = rows * cell * 2;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = cols * cell;
  maskCanvas.height = rows * cell;
  const c = canvas.getContext('2d');
  const m = maskCanvas.getContext('2d');
  if (!c || !m) throw new Error('2D canvas unavailable for the part atlas');
  PART_IDS.forEach((id, i) => {
    const cx = (i % cols) * cell + cell / 2;
    const cy = Math.floor(i / cols) * cell + cell / 2;
    const s = cell / PARTS[id].span;
    for (const k of [c, m]) {
      k.save();
      k.translate(cx, cy);
      k.scale(s, s);
    }
    PAINTERS[id](c, m);
    c.restore();
    m.restore();
  });
  c.drawImage(maskCanvas, 0, rows * cell);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
