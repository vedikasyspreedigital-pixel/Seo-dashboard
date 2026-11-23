import { useEffect, useRef, useState } from 'react';

/**
 * Christmas theme extras (2026-11-23). Only shown while Settings → Theme is "Christmas" (data-theme="christmas").
 * Snow stops for anyone with "reduce motion" on, pauses in a background tab, and never catches clicks.
 */

function readTheme() {
  return document.documentElement.dataset.theme ?? 'dark';
}

const FESTIVE_KEY = 'serp-console-festive';

/** Decorations are on with the Christmas theme, or switched on separately for any other theme. */
export function festiveOn() {
  return document.documentElement.dataset.theme === 'christmas' || document.documentElement.dataset.festive === 'on';
}

export function setFestive(on: boolean) {
  if (on) document.documentElement.dataset.festive = 'on';
  else delete document.documentElement.dataset.festive;
  try {
    window.localStorage.setItem(FESTIVE_KEY, on ? 'on' : 'off');
  } catch {
    // storage blocked -- still applies for this visit
  }
}

/** The live theme, following changes made anywhere (Settings, header button). */
export function useActiveTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-festive'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** True while the Christmas theme or the decorations switch is on (re-checks when either changes). */
export function useIsChristmas() {
  useActiveTheme();
  const [on, setOn] = useState(festiveOn);
  useEffect(() => {
    const observer = new MutationObserver(() => setOn(festiveOn()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-festive'] });
    return () => observer.disconnect();
  }, []);
  return on;
}

/** z = depth: 0 is far away (tiny, slow, faint), 1 is right in front of the screen (big, soft, fast). */
type Flake = { x: number; y: number; z: number; r: number; vy: number; vx: number; sway: number; phase: number; freq: number; alpha: number; bokeh: boolean };

/** A soft round flake drawn once and stamped many times (much cheaper than a gradient per flake). */
function flakeSprite(rgb: string, softness: number) {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return c;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${rgb}, 1)`);
  grad.addColorStop(softness, `rgba(${rgb}, 0.85)`);
  grad.addColorStop(Math.min(0.95, softness + 0.25), `rgba(${rgb}, 0.25)`);
  grad.addColorStop(1, `rgba(${rgb}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/**
 * Snow over the whole app (2026-11-23, made "real" on request): three depths of flakes with parallax, soft
 * out-of-focus flakes up close, a slow wind with gusts, and scrolling moves the snow with the page --
 * near flakes swing past faster than far ones and get swirled by fast scrolls, like walking through it.
 */
export function FestiveSnow() {
  const on = useIsChristmas();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!on) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const snow = getComputedStyle(document.documentElement).getPropertyValue('--festive-snow').trim() || 'rgba(255, 255, 255, 1)';
    const rgbMatch = snow.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    const rgb = rgbMatch ? `${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}` : '255, 255, 255';
    const crisp = flakeSprite(rgb, 0.45);
    const soft = flakeSprite(rgb, 0.12);

    let width = 0;
    let height = 0;
    let flakes: Flake[] = [];
    const make = (y?: number): Flake => {
      // Most flakes far away, fewer close up -- the way a real snowfall looks.
      const z = Math.pow(Math.random(), 1.6);
      const bokeh = z > 0.85 && Math.random() < 0.35;
      return {
        x: Math.random() * width,
        y: y ?? Math.random() * height,
        z,
        r: bokeh ? 5 + Math.random() * 4 : 0.6 + z * z * 3.2 + Math.random() * 0.5,
        vy: 0.22 + z * 1.05 + Math.random() * 0.2,
        vx: 0,
        sway: 0.15 + z * 0.75,
        phase: Math.random() * Math.PI * 2,
        freq: 0.6 + Math.random() * 0.9,
        alpha: bokeh ? 0.18 + Math.random() * 0.12 : 0.3 + z * 0.55,
        bokeh,
      };
    };
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(190, (width * height) / 8500));
      flakes = Array.from({ length: count }, () => make());
    };
    resize();
    window.addEventListener('resize', resize);

    // ---- Snow piles on the boxes (cards), 2026-11-23 ----
    // Each card carries a soft, lumpy pile of snow on its top edge (one height per few pixels): bright on top,
    // shaded inside, a soft shadow on the card and the odd sparkle. Flakes that land add to the pile; scrolling
    // shakes whole chunks off, which tumble down and puff into powder; piles slowly build back up. Now and then
    // a flake sticks to a card's glass and melts. Piles and stuck flakes move with their card when scrolling.
    const CORNER = 22; // cards are rounded-[22px]
    const CELL = 4; // px of card width per pile height
    const MAX_PILE = 12;
    const REST_PILE = 6.5; // piles regrow to about this height on their own
    type Pile = { h: Float32Array; glint: Float32Array; cover: Float32Array; w: number };
    type Stuck = { el: Element; ox: number; oy: number; r: number; alpha: number; born: number; melt: number };
    type Lobe = { dx: number; dy: number; r: number };
    type Clump = { x: number; y: number; vx: number; vy: number; rot: number; vr: number; lobes: Lobe[]; born: number };
    type Powder = { x: number; y: number; vx: number; vy: number; r: number; born: number };
    const piles = new Map<Element, Pile>();
    let stuck: Stuck[] = [];
    let clumps: Clump[] = [];
    let powder: Powder[] = [];
    let boxes: Element[] = [];
    const rects = new Map<Element, DOMRect>();
    let lastScan = -Infinity;
    const main = document.querySelector('main');
    /** How far the card's top edge drops at x because of its rounded corner. */
    const cornerDrop = (x: number, w: number) => {
      const fromEdge = Math.min(x, w - x);
      return fromEdge < CORNER ? CORNER - Math.sqrt(Math.max(0, CORNER * CORNER - (CORNER - fromEdge) ** 2)) : 0;
    };
    /** Piles thin out towards the corners, with a soft rounded end. */
    const taper = (x: number, w: number) => {
      const t = Math.min(1, Math.max(0, (Math.min(x, w - x) - 7) / CORNER));
      return Math.sqrt(t);
    };
    const smooth = (p: Pile, k = 0.25) => {
      const h = p.h;
      const copy = Float32Array.from(h);
      for (let i = 1; i < h.length - 1; i += 1) h[i] = copy[i] * (1 - 2 * k) + (copy[i - 1] + copy[i + 1]) * k;
    };
    /**
     * Where on this card the snow lies (0..1 along its width): real snow never covers every box evenly, so
     * each card gets its own layout -- just the left, just the right, a patch in the middle, two patches, or
     * now and then most of the top -- with drifts that fade out softly at their ends.
     */
    const newCoverage = (n: number) => {
      const r = Math.random();
      const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
      let patches: [number, number][];
      if (r < 0.25) patches = [[rand(0.05, 0.2), rand(0.2, 0.36)]]; // left
      else if (r < 0.5) patches = [[rand(0.8, 0.95), rand(0.2, 0.36)]]; // right
      else if (r < 0.65) patches = [[rand(0.38, 0.62), rand(0.14, 0.26)]]; // middle
      else if (r < 0.88) patches = [[rand(0.05, 0.2), rand(0.12, 0.24)], [rand(0.65, 0.92), rand(0.1, 0.22)]]; // two
      else patches = [[rand(0.42, 0.58), rand(0.36, 0.46)]]; // most of it
      const cover = new Float32Array(n + 1);
      for (let i = 0; i <= n; i += 1) {
        const u = i / n;
        let c = 0;
        for (const [centre, half] of patches) {
          const t = Math.min(1, Math.max(0, (half - Math.abs(u - centre)) / (half * 0.45)));
          c = Math.max(c, t * t * (3 - 2 * t));
        }
        cover[i] = c;
      }
      return cover;
    };
    const newPile = (w: number): Pile => {
      const n = Math.max(4, Math.round(w / CELL));
      const h = new Float32Array(n + 1);
      const glint = new Float32Array(n + 1);
      const cover = newCoverage(n);
      const p1 = Math.random() * 6;
      const p2 = Math.random() * 6;
      const p3 = Math.random() * 6;
      for (let i = 0; i <= n; i += 1) {
        // Long soft drifts with smaller lumps on top -- the way snow settles.
        const lump = 6.5 + 2.4 * Math.sin(i * 0.11 + p1) + 1.4 * Math.sin(i * 0.37 + p2) + 0.7 * Math.sin(i * 0.9 + p3);
        h[i] = Math.max(1.5, Math.min(MAX_PILE, lump)) * cover[i];
        glint[i] = Math.random() < 0.09 ? Math.random() * 100 : -1;
      }
      const pile = { h, glint, cover, w };
      smooth(pile);
      return pile;
    };
    const pileFor = (el: Element, w: number) => {
      let p = piles.get(el);
      if (!p || Math.abs(p.w - w) > 2) {
        p = newPile(w);
        piles.set(el, p);
      }
      return p;
    };
    const scan = (now: number) => {
      lastScan = now;
      boxes = Array.from(document.querySelectorAll('main .glass-surface, main div.accent-fill'));
      const live = new Set(boxes);
      for (const el of piles.keys()) if (!live.has(el)) piles.delete(el);
      stuck = stuck.filter((p) => live.has(p.el));
    };
    /** True when a card's top edge is inside the scrolling page area (not hidden under the header). */
    const topVisible = (b: DOMRect, clip?: DOMRect) =>
      b.width >= 60 && b.top > -20 && b.top < height && (!clip || (b.top >= clip.top - 4 && b.top <= clip.bottom));

    const makeClump = (x: number, y: number, size: number, now: number): Clump => {
      const lobes = Array.from({ length: 2 + Math.floor(Math.random() * 3) }, () => ({
        dx: (Math.random() - 0.5) * size * 1.1,
        dy: (Math.random() - 0.5) * size * 0.7,
        r: size * (0.45 + Math.random() * 0.45),
      }));
      return { x, y, vx: (Math.random() - 0.5) * 1.6, vy: -0.3 - Math.random() * 1.2, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.12, lobes, born: now };
    };
    const puff = (x: number, y: number, count: number, now: number) => {
      for (let k = 0; k < count && powder.length < 900; k += 1) {
        powder.push({ x: x + (Math.random() - 0.5) * 10, y: y + (Math.random() - 0.5) * 4, vx: (Math.random() - 0.5) * 1.6, vy: -Math.random() * 0.9, r: 0.6 + Math.random() * 1.4, born: now });
      }
    };

    /** A shake knocks whole stretches of the pile off at once, like a slab of snow sliding off a ledge. */
    const shed = (p: Pile, b: DOMRect, shake: number, now: number) => {
      const n = p.h.length - 1;
      const step = b.width / n;
      let i = Math.floor(Math.random() * 3);
      while (i <= n) {
        const len = 3 + Math.floor(Math.random() * 9);
        if (Math.random() < shake * 0.75) {
          const frac = Math.min(0.92, shake * (0.4 + Math.random() * 0.5));
          let removed = 0;
          for (let j = i; j <= Math.min(n, i + len - 1); j += 1) {
            // Breaks off most in the middle of the slab, a little less at its ends.
            const loss = p.h[j] * frac * (0.75 + 0.25 * Math.sin(((j - i + 0.5) / len) * Math.PI));
            p.h[j] -= loss;
            removed += loss * taper(j * step, b.width);
          }
          const chunks = Math.min(7, Math.round(removed / 3));
          for (let k = 0; k < chunks && clumps.length < 350; k += 1) {
            const j = Math.min(n, i + Math.floor(Math.random() * len));
            const x = j * step;
            clumps.push(makeClump(b.left + x, b.top + cornerDrop(x, b.width) - p.h[j] - 2, 1.6 + Math.random() * Math.min(3.4, removed / 6), now));
          }
          const mid = Math.min(n, i + Math.floor(len / 2)) * step;
          if (removed > 1) puff(b.left + mid, b.top + cornerDrop(mid, b.width) - 3, Math.min(14, 2 + Math.round(removed / 2)), now);
        }
        i += len;
      }
      smooth(p, 0.2);
      smooth(p, 0.2);
    };

    // Scrolling: the page scrolls inside the app's main area, not the window, so listen to every scroll
    // (capture phase) and remember each scroller's last position.
    const lastTop = new WeakMap<EventTarget, number>();
    const onScroll = (e: Event) => {
      const target = e.target === document ? document.scrollingElement : (e.target as Element | null);
      if (!target) return;
      const top = (target as Element).scrollTop ?? 0;
      const prev = lastTop.get(target);
      lastTop.set(target, top);
      if (prev === undefined) return;
      const delta = Math.max(-140, Math.min(140, top - prev));
      if (!delta) return;
      for (const f of flakes) {
        // Parallax: close flakes slide with the page more than distant ones.
        f.y -= delta * (0.12 + f.z * 0.7);
        // A quick scroll stirs the air -- close flakes get pushed sideways a little.
        f.vx += (Math.random() - 0.5) * Math.abs(delta) * 0.03 * f.z;
      }
      // The scroll shakes the boxes and snow slides off the piles.
      const shake = Math.min(1, Math.abs(delta) / 70);
      if (shake < 0.04) return;
      const clip = main?.getBoundingClientRect();
      const now = performance.now();
      for (const el of boxes) {
        const p = piles.get(el);
        if (!p) continue;
        const b = el.getBoundingClientRect();
        if (topVisible(b, clip)) shed(p, b, shake, now);
      }
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });

    let raf = 0;
    let last = 0;
    let wind = 0;
    let gust = 0;
    let gustTarget = 0;
    const frame = (now: number) => {
      const dt = last ? Math.min(3, (now - last) / 16.67) : 1;
      last = now;
      const s = now / 1000;
      // Slow, wandering breeze plus an occasional gust that eases in and out.
      if (Math.random() < 0.002 * dt) gustTarget = (Math.random() - 0.4) * 1.6;
      gustTarget *= Math.pow(0.995, dt);
      gust += (gustTarget - gust) * 0.01 * dt;
      wind = Math.sin(s * 0.13) * 0.25 + Math.sin(s * 0.047 + 1.3) * 0.2 + gust;

      ctx.clearRect(0, 0, width, height);

      if (now - lastScan > 800) scan(now);
      rects.clear();
      for (const el of boxes) rects.set(el, el.getBoundingClientRect());
      const clip = main?.getBoundingClientRect();

      // Snow colours: white crust, cool blue-grey in the shade, a shadow that suits the theme.
      const lightTheme = document.documentElement.dataset.theme === 'light';
      const shade = lightTheme ? '205, 217, 233' : '172, 190, 216';
      const deepShade = lightTheme ? '178, 194, 216' : '138, 158, 190';
      const castShadow = lightTheme ? 'rgba(40, 60, 95, 0.3)' : 'rgba(0, 0, 0, 0.55)';

      // Piles, stuck flakes, chunks and powder stay inside the page area; free snow falls over everything.
      ctx.save();
      if (clip) {
        ctx.beginPath();
        ctx.rect(clip.left, clip.top - MAX_PILE - 6, clip.width, clip.height + MAX_PILE + 6);
        ctx.clip();
      }
      for (const el of boxes) {
        const b = rects.get(el);
        if (!b || !topVisible(b, clip)) continue;
        const p = pileFor(el, b.width);
        const n = p.h.length - 1;
        const step = b.width / n;
        // Slowly snow back up to a resting pile.
        for (let i = 0; i <= n; i += 1) {
          const rest = REST_PILE * p.cover[i];
          if (p.h[i] < rest) p.h[i] = Math.min(rest, p.h[i] + 0.006 * dt);
        }
        const base = (i: number) => b.top + cornerDrop(i * step, b.width) + 1;
        const surface = (i: number) => b.top + cornerDrop(i * step, b.width) - p.h[i] * taper(i * step, b.width);
        /** Fill the area between a top line and the card edge, with a smooth curve along the top. */
        // The pile stops a few px into the rounded corners instead of running down them.
        const i0 = Math.min(n, Math.ceil(7 / step));
        const i1 = n - i0;
        // Only draw where there is snow: split the top into separate patches.
        const runs: [number, number][] = [];
        let runStart = -1;
        for (let i = i0; i <= i1; i += 1) {
          const has = p.h[i] * taper(i * step, b.width) > 0.35;
          if (has && runStart < 0) runStart = i;
          if ((!has || i === i1) && runStart >= 0) {
            const end = has ? i : i - 1;
            if (end - runStart >= 1) runs.push([Math.max(i0, runStart - 1), Math.min(i1, end + 1)]);
            runStart = -1;
          }
        }
        if (!runs.length) continue;
        const fillProfile = (topAt: (i: number) => number) => {
          ctx.beginPath();
          for (const [a, z] of runs) {
            ctx.moveTo(b.left + a * step, base(a));
            ctx.lineTo(b.left + a * step, topAt(a));
            for (let i = a + 1; i < z; i += 1) {
              ctx.quadraticCurveTo(b.left + i * step, topAt(i), b.left + (i + 0.5) * step, (topAt(i) + topAt(i + 1)) / 2);
            }
            ctx.lineTo(b.left + z * step, topAt(z));
            for (let i = z; i >= a; i -= 1) ctx.lineTo(b.left + i * step, base(i));
            ctx.closePath();
          }
          ctx.fill();
        };
        // 1. The bright snow body, casting a soft shadow down onto the card.
        ctx.shadowColor = castShadow;
        ctx.shadowBlur = 7;
        ctx.shadowOffsetY = 2.5;
        ctx.fillStyle = 'rgb(250, 252, 255)';
        fillProfile(surface);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        // 2. Inside the pile is in shade: a few px under the surface it turns blue-grey, deeper still darker.
        ctx.fillStyle = `rgba(${shade}, 0.55)`;
        fillProfile((i) => Math.min(base(i), surface(i) + 2.2));
        ctx.fillStyle = `rgba(${deepShade}, 0.45)`;
        fillProfile((i) => Math.min(base(i), surface(i) + 5));
        // 3. A crisp, slightly glowing crust along the top.
        ctx.beginPath();
        for (const [a, z] of runs) {
          ctx.moveTo(b.left + a * step, surface(a));
          for (let i = a + 1; i < z; i += 1) ctx.quadraticCurveTo(b.left + i * step, surface(i), b.left + (i + 0.5) * step, (surface(i) + surface(i + 1)) / 2);
        }
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = 1.1;
        if (!lightTheme) {
          ctx.shadowColor = 'rgba(255, 255, 255, 0.5)';
          ctx.shadowBlur = 4;
        }
        ctx.stroke();
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        // 4. Ice crystals catching the light: tiny glints that twinkle on the surface.
        for (let i = 0; i <= n; i += 1) {
          if (p.glint[i] < 0 || p.h[i] < 2) continue;
          const tw = Math.pow(Math.max(0, Math.sin(s * 1.7 + p.glint[i])), 12);
          if (tw < 0.05) continue;
          const gx = b.left + i * step;
          const gy = surface(i) + 1.2;
          ctx.globalAlpha = tw;
          ctx.fillStyle = lightTheme ? '#9fc3ff' : '#ffffff';
          ctx.fillRect(gx - 0.6, gy - 2.2, 1.2, 4.4);
          ctx.fillRect(gx - 2.2, gy - 0.6, 4.4, 1.2);
          ctx.globalAlpha = 1;
        }
      }

      stuck = stuck.filter((p) => {
        if (now > p.melt) return false;
        const b = rects.get(p.el);
        if (!b || p.ox > b.width) return true;
        const fadeIn = Math.min(1, (now - p.born) / 400);
        const fadeOut = Math.min(1, (p.melt - now) / 1800);
        const d = p.r * 2.3 * (0.7 + 0.3 * fadeOut);
        ctx.globalAlpha = p.alpha * fadeIn * fadeOut;
        ctx.drawImage(crisp, b.left + p.ox - d / 2, b.top + p.oy - d / 2, d, d);
        return true;
      });

      // Chunks of snow tumbling off the cards: lumpy, lit from above, trailing a little powder.
      clumps = clumps.filter((c) => {
        const age = now - c.born;
        c.vy += 0.14 * dt;
        c.vx *= Math.pow(0.99, dt);
        c.x += (c.vx + wind * 0.4) * dt;
        c.y += c.vy * dt;
        c.rot += c.vr * dt;
        if (c.y > height + 30 || age > 5000) return false;
        if (Math.random() < 0.06 * dt) puff(c.x, c.y, 1, now);
        ctx.globalAlpha = Math.min(1, (5000 - age) / 1200);
        const cos = Math.cos(c.rot);
        const sin = Math.sin(c.rot);
        ctx.fillStyle = `rgb(${shade})`;
        ctx.beginPath();
        for (const l of c.lobes) {
          const lx = c.x + l.dx * cos - l.dy * sin;
          const ly = c.y + l.dx * sin + l.dy * cos;
          ctx.moveTo(lx + l.r, ly);
          ctx.arc(lx, ly, l.r, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.fillStyle = 'rgb(250, 252, 255)';
        ctx.beginPath();
        for (const l of c.lobes) {
          const lx = c.x + l.dx * cos - l.dy * sin - l.r * 0.2;
          const ly = c.y + l.dx * sin + l.dy * cos - l.r * 0.28;
          ctx.moveTo(lx + l.r * 0.72, ly);
          ctx.arc(lx, ly, l.r * 0.72, 0, Math.PI * 2);
        }
        ctx.fill();
        return true;
      });

      powder = powder.filter((d) => {
        const age = now - d.born;
        if (age > 1700) return false;
        d.vy += 0.025 * dt;
        d.vx *= Math.pow(0.97, dt);
        d.x += (d.vx + wind * 0.7) * dt;
        d.y += d.vy * dt;
        ctx.globalAlpha = 0.55 * (1 - age / 1700);
        const size = d.r * (3 + age / 400);
        ctx.drawImage(soft, d.x - size / 2, d.y - size / 2, size, size);
        return true;
      });
      ctx.globalAlpha = 1;
      ctx.restore();

      for (const f of flakes) {
        const prevY = f.y;
        f.vx *= Math.pow(0.94, dt);
        f.y += f.vy * dt;
        f.x += (wind * (0.3 + f.z) + Math.sin(s * f.freq + f.phase) * f.sway * 0.5 + f.vx) * dt;

        // Flakes at about the cards' depth land on a card's pile, or now and then stick to its glass.
        if (!f.bokeh && f.z > 0.18 && f.z < 0.8) {
          for (const el of boxes) {
            const b = rects.get(el);
            if (!b || !topVisible(b, clip)) continue;
            if (f.x > b.left + 4 && f.x < b.right - 4) {
              const p = pileFor(el, b.width);
              const n = p.h.length - 1;
              const i = Math.max(0, Math.min(n, Math.round(((f.x - b.left) / b.width) * n)));
              const x = i * (b.width / n);
              const top = b.top + cornerDrop(x, b.width) - p.h[i] * taper(x, b.width);
              if (prevY < top && f.y >= top) {
                const add = (j: number, amount: number) => {
                  if (j >= 0 && j <= n) p.h[j] = Math.min(MAX_PILE * (0.06 + 0.94 * p.cover[j]), p.h[j] + amount);
                };
                add(i, 0.5);
                add(i - 1, 0.35);
                add(i + 1, 0.35);
                add(i - 2, 0.15);
                add(i + 2, 0.15);
                Object.assign(f, make(-f.r * 2));
                break;
              }
            }
            if (
              stuck.length < 90 &&
              f.y > b.top + 14 &&
              f.y < b.bottom - 6 &&
              f.x > b.left + 6 &&
              f.x < b.right - 6 &&
              (!clip || f.y > clip.top) &&
              Math.random() < 0.0015 * dt
            ) {
              stuck.push({ el, ox: f.x - b.left, oy: f.y - b.top, r: f.r * 0.9, alpha: f.alpha * 0.9, born: now, melt: now + 4500 + Math.random() * 6000 });
              Object.assign(f, make(-f.r * 2));
              break;
            }
          }
        }

        // Keep the snowfall even: wrap off-screen flakes round to the other side.
        if (f.y - f.r * 2 > height) Object.assign(f, make(-f.r * 2));
        else if (f.y + f.r * 2 < -40) {
          Object.assign(f, make(height + f.r * 2));
        }
        if (f.x > width + 10) f.x = -10;
        if (f.x < -10) f.x = width + 10;

        const sprite = f.bokeh || f.z > 0.7 ? soft : crisp;
        const d = f.r * (f.bokeh || f.z > 0.7 ? 3 : 2.3);
        ctx.globalAlpha = f.alpha;
        ctx.drawImage(sprite, f.x - d / 2, f.y - d / 2, d, d);
      }
      ctx.globalAlpha = 1;
      raf = window.requestAnimationFrame(frame);
    };
    const onVisibility = () => {
      window.cancelAnimationFrame(raf);
      last = 0;
      if (!document.hidden) raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('scroll', onScroll, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      ctx.clearRect(0, 0, width, height);
    };
  }, [on]);

  if (!on) return null;
  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0 z-40" />;
}

const BULB_COLOURS = ['var(--festive-red)', 'var(--festive-gold)', 'var(--festive-green)', '#5aa9ff'];

/** A string of twinkling lights hanging along the top bar. */
export function FestiveLights() {
  const count = 34;
  const w = 1000;
  // A gently sagging wire between hooks.
  const sag = (x: number) => 3 + 5 * Math.abs(Math.sin((x / w) * Math.PI * 6));
  const wire = Array.from({ length: 121 }, (_, i) => {
    const x = (i / 120) * w;
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${sag(x).toFixed(1)}`;
  }).join('');
  return (
    <div className="festive-only festive-lights" aria-hidden>
      <svg viewBox={`0 0 ${w} 22`} preserveAspectRatio="none">
        <path d={wire} fill="none" stroke="rgba(30, 60, 40, 0.9)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        {Array.from({ length: count }, (_, i) => {
          const x = ((i + 0.5) / count) * w;
          const y = sag(x);
          const colour = BULB_COLOURS[i % BULB_COLOURS.length];
          return (
            <g key={i} className="festive-bulb" style={{ animationDelay: `${(i * 0.37) % 2.6}s` }}>
              <ellipse cx={x} cy={y + 6} rx={2.6} ry={4} fill={colour} />
              <ellipse cx={x} cy={y + 6} rx={7} ry={7} fill={colour} opacity={0.18} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Santa hat perched on the sidebar logo. */
export function SantaHat() {
  return (
    <svg className="festive-only festive-hat" viewBox="0 0 30 26" aria-hidden>
      <path d="M4 19 C6 9, 14 2, 22 4 C25 5, 27 9, 26 14 L23 12 C22 9, 19 8, 16 10 C12 13, 9 17, 8 20 Z" fill="#e23b4e" />
      <rect x="2" y="18" width="16" height="5.5" rx="2.75" fill="#fff8f0" transform="rotate(-8 10 21)" />
      <circle cx="26" cy="15.5" r="3" fill="#fff8f0" />
    </svg>
  );
}

/**
 * A little Christmas tree standing on top of a card (Overview, 2026-11-23): snow on its branches, a gold
 * garland, twinkling baubles, a glowing star and a present at its foot. Put it inside a `relative` box.
 */
export function ChristmasTree({ className = '' }: { className?: string }) {
  const baubles: [number, number, string][] = [
    [24, 25, '#e23b4e'],
    [36, 27, '#5aa9ff'],
    [19, 40, '#f4c95d'],
    [31, 42, '#e23b4e'],
    [42, 40, '#fff8f0'],
    [14, 56, '#5aa9ff'],
    [26, 57, '#f4c95d'],
    [38, 56, '#e23b4e'],
    [47, 54, '#f4c95d'],
  ];
  return (
    <svg className={`festive-only festive-tree ${className}`} viewBox="0 0 60 76" aria-hidden>
      <defs>
        <linearGradient id="festive-tree-green" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#1d6b3d" />
          <stop offset="0.55" stopColor="#2a9554" />
          <stop offset="1" stopColor="#1a5c35" />
        </linearGradient>
      </defs>
      {/* trunk */}
      <rect x="27" y="61" width="6" height="9" rx="1" fill="#7a4a2a" />
      {/* three tiers, bottom first, each with snow along its lower edge */}
      <path d="M30 30 L5 63 Q30 67 55 63 Z" fill="url(#festive-tree-green)" />
      <path d="M7 62.5 Q13 60 18 63 Q24 61 30 64 Q36 61 42 63 Q48 60 53 62.5" stroke="#fbfdff" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="M30 17 L9 46 Q30 50 51 46 Z" fill="url(#festive-tree-green)" />
      <path d="M11 45.5 Q17 43 22 46 Q30 44 38 46 Q44 43 49 45.5" stroke="#fbfdff" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <path d="M30 6 L14 31 Q30 34 46 31 Z" fill="url(#festive-tree-green)" />
      <path d="M16 30.5 Q22 28.5 27 31 Q33 29 38 31 Q42 28.5 44 30.5" stroke="#fbfdff" strokeWidth="2" strokeLinecap="round" fill="none" />
      {/* garland */}
      <path d="M18 24 Q30 31 41 23 M14 38 Q30 47 46 37 M10 53 Q30 63 50 52" stroke="#f4c95d" strokeWidth="1" fill="none" opacity="0.85" />
      {/* baubles */}
      {baubles.map(([cx, cy, c], i) => (
        <g key={i} className="festive-bulb" style={{ animationDelay: `${(i * 0.53) % 2.6}s` }}>
          <circle cx={cx} cy={cy} r="2.1" fill={c} />
          <circle cx={cx - 0.6} cy={cy - 0.7} r="0.6" fill="#fff" opacity="0.8" />
        </g>
      ))}
      {/* star */}
      <g className="festive-tree-star">
        <circle cx="30" cy="5.5" r="5" fill="#f4c95d" opacity="0.25" />
        <path d="M30 0.5 L31.5 4 L35.2 4.2 L32.3 6.5 L33.3 10 L30 8 L26.7 10 L27.7 6.5 L24.8 4.2 L28.5 4 Z" fill="#f4c95d" />
      </g>
      {/* present */}
      <rect x="37" y="64" width="11" height="8" rx="1" fill="#e23b4e" />
      <rect x="41.6" y="64" width="1.8" height="8" fill="#f4c95d" />
      <rect x="37" y="67.1" width="11" height="1.6" fill="#f4c95d" />
      <path d="M42.5 64 Q39 60.5 40 63.5 M42.5 64 Q46 60.5 45 63.5" stroke="#f4c95d" strokeWidth="1.2" fill="none" />
    </svg>
  );
}

function christmasCountdown(now = new Date()) {
  const year = now.getMonth() === 0 && now.getDate() <= 6 ? now.getFullYear() - 1 : now.getFullYear();
  const christmas = new Date(year, 11, 25);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((christmas.getTime() - today.getTime()) / 86_400_000);
  if (days > 1) return `${days} days to Christmas`;
  if (days === 1) return 'Christmas Eve tomorrow';
  if (days === 0) return 'Merry Christmas!';
  if (now.getMonth() === 11 && now.getDate() === 31) return 'Happy New Year’s Eve';
  if (now.getMonth() === 11) return 'Happy holidays';
  return 'Happy New Year!';
}

/** "32 days to Christmas" chip for the top bar. */
export function ChristmasCountdown() {
  const on = useIsChristmas();
  if (!on) return null;
  return (
    <span className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-medium text-[var(--festive-gold)] xl:inline-flex">
      <span aria-hidden>🎄</span>
      {christmasCountdown()}
    </span>
  );
}
