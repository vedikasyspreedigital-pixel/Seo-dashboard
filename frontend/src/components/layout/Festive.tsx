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

type Flake = { x: number; y: number; r: number; speed: number; drift: number; phase: number; alpha: number };

/** Gently falling snow over the whole app. */
export function FestiveSnow() {
  const on = useIsChristmas();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!on) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let width = 0;
    let height = 0;
    let flakes: Flake[] = [];
    const make = (y?: number): Flake => ({
      x: Math.random() * width,
      y: y ?? Math.random() * height,
      r: 0.8 + Math.random() * 2.2,
      speed: 0.25 + Math.random() * 0.7,
      drift: 0.2 + Math.random() * 0.6,
      phase: Math.random() * Math.PI * 2,
      alpha: 0.35 + Math.random() * 0.5,
    });
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(110, (width * height) / 16000));
      flakes = Array.from({ length: count }, () => make());
    };
    resize();
    window.addEventListener('resize', resize);

    const snow = getComputedStyle(document.documentElement).getPropertyValue('--festive-snow').trim() || 'rgba(255, 255, 255, 1)';
    const flakeColour = (alpha: number) => snow.replace(/rgba?\(([^,]+),([^,]+),([^,)]+)(?:,[^)]*)?\)/, `rgba($1,$2,$3, ${alpha})`);
    let raf = 0;
    let t = 0;
    const frame = () => {
      t += 1;
      ctx.clearRect(0, 0, width, height);
      for (const f of flakes) {
        f.y += f.speed;
        f.x += Math.sin(t / 90 + f.phase) * f.drift * 0.35;
        if (f.y - f.r > height) Object.assign(f, make(-5));
        if (f.x > width + 5) f.x = -5;
        if (f.x < -5) f.x = width + 5;
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = flakeColour(f.alpha);
        ctx.fill();
      }
      raf = window.requestAnimationFrame(frame);
    };
    const onVisibility = () => {
      window.cancelAnimationFrame(raf);
      if (!document.hidden) raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
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
    <span className="hidden items-center gap-1.5 rounded-full border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-medium text-[var(--festive-gold)] lg:inline-flex">
      <span aria-hidden>🎄</span>
      {christmasCountdown()}
    </span>
  );
}
