import { useEffect, useRef, useState } from 'react';
import { festiveOn, useIsChristmas } from './Festive';

/**
 * Christmas theme (2026-11-23): when a report goes out, Santa's sleigh and reindeer fly across the screen with a
 * gold sparkle trail and a "Ho ho ho!". Only in the Christmas theme; skipped for anyone with "reduce motion" on.
 * Anything can trigger it with celebrateReportSent().
 */

const EVENT = 'festive:report-sent';
const DURATION_MS = 6500;

/** `label` reads "<label>. Santa's on his way with it"; pass `message` to show your own line instead. */
export function celebrateReportSent(label = 'Report delivered', message?: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { label, message } }));
}

/** "Send Santa" chip for the top bar, next to the Christmas countdown -- sends the sleigh across for fun. */
export function SendSantaButton() {
  const on = useIsChristmas();
  if (!on) return null;
  return (
    <button
      type="button"
      onClick={() => celebrateReportSent('', 'Merry Christmas from Santa and the whole team! 🎄')}
      title="Send Santa across the screen"
      className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-medium text-[var(--festive-gold)] transition-colors hover:border-[var(--festive-gold)] xl:inline-flex"
    >
      <span aria-hidden>🎅</span>
      Send Santa
    </button>
  );
}

type Spark = { id: number; x: number; y: number; born: number; size: number };

function Reindeer({ x, lead = false, phase }: { x: number; lead?: boolean; phase: number }) {
  // Legs swing a little as they "gallop".
  const swing = Math.sin(phase) * 5;
  return (
    <g transform={`translate(${x} ${Math.sin(phase * 0.5) * 2})`}>
      {/* antlers */}
      <path d="M44 6 l-3 -8 M44 6 l3 -7 M41 -2 l-4 -2 M47 -1 l4 -3" stroke="#c9a36a" strokeWidth="2" strokeLinecap="round" fill="none" />
      {/* body + neck + head */}
      <ellipse cx="22" cy="20" rx="18" ry="8" fill="#8a5a36" />
      <path d="M34 16 Q40 8 44 8 Q50 8 52 12 Q48 16 42 16 Z" fill="#8a5a36" />
      <ellipse cx="46" cy="11" rx="2" ry="1.4" fill="#2b1a10" />
      <circle cx="53" cy="12" r={lead ? 3 : 1.6} fill={lead ? '#ff3b3b' : '#2b1a10'} />
      {lead && <circle cx="53" cy="12" r="7" fill="#ff3b3b" opacity="0.3" />}
      <path d="M8 16 q-6 -2 -8 -6" stroke="#8a5a36" strokeWidth="3" strokeLinecap="round" fill="none" />
      {/* legs */}
      <g stroke="#6b4428" strokeWidth="3" strokeLinecap="round">
        <line x1="12" y1="25" x2={8 - swing} y2="37" />
        <line x1="18" y1="26" x2={20 + swing} y2="37" />
        <line x1="28" y1="26" x2={26 - swing} y2="37" />
        <line x1="34" y1="25" x2={38 + swing} y2="36" />
      </g>
      {/* collar bell */}
      <circle cx="38" cy="19" r="2.4" fill="#f4c95d" />
    </g>
  );
}

function Sleigh({ phase }: { phase: number }) {
  return (
    <svg width="360" height="90" viewBox="-6 -14 366 104" aria-hidden>
      {/* reins */}
      <path d="M118 46 Q170 34 214 30 Q262 26 300 28" stroke="#f4c95d" strokeWidth="1.5" fill="none" opacity="0.9" />
      <Reindeer x={196} phase={phase} />
      <Reindeer x={262} phase={phase + 1.4} lead />
      {/* sleigh */}
      <path d="M8 40 Q10 66 40 68 L112 68 Q128 66 130 48 L120 48 Q116 58 104 58 L44 58 Q28 58 24 40 Z" fill="#c92a3e" />
      <path d="M2 74 L120 74 Q138 74 140 60" stroke="#f4c95d" strokeWidth="4" fill="none" strokeLinecap="round" />
      <path d="M20 68 L18 74 M100 68 L102 74" stroke="#f4c95d" strokeWidth="3" />
      {/* gift sack */}
      <path d="M22 40 Q16 18 34 14 Q52 12 50 40 Z" fill="#8a5a36" />
      <rect x="30" y="20" width="10" height="10" rx="1.5" fill="#2fa864" />
      <rect x="34" y="20" width="2.5" height="10" fill="#f4c95d" />
      {/* Santa */}
      <path d="M58 58 Q56 34 74 30 Q92 30 92 58 Z" fill="#e23b4e" />
      <rect x="58" y="50" width="34" height="5" fill="#2b1a10" />
      <rect x="71" y="49.5" width="7" height="6" fill="#f4c95d" />
      <circle cx="76" cy="24" r="9" fill="#f6d2b8" />
      <path d="M67 26 Q76 42 85 26 Q80 30 76 30 Q72 30 67 26 Z" fill="#fff8f0" />
      <path d="M66 21 Q72 6 88 10 Q92 12 94 18 L86 17 Q80 14 76 17 Z" fill="#e23b4e" />
      <rect x="65" y="18" width="22" height="5" rx="2.5" fill="#fff8f0" />
      <circle cx="95" cy="19" r="3.2" fill="#fff8f0" />
      {/* waving arm */}
      <path d={`M90 38 Q100 ${30 + Math.sin(phase * 2) * 4} 104 ${24 + Math.sin(phase * 2) * 5}`} stroke="#e23b4e" strokeWidth="6" strokeLinecap="round" fill="none" />
      <circle cx="104" cy={24 + Math.sin(phase * 2) * 5} r="3.5" fill="#fff8f0" />
    </svg>
  );
}

export function FestiveSleigh() {
  const christmas = useIsChristmas();
  const [flight, setFlight] = useState<{ start: number; text: string } | null>(null);
  const [now, setNow] = useState(0);
  const [sparks, setSparks] = useState<Spark[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    const onSent = (e: Event) => {
      if (!festiveOn()) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      setSparks([]);
      const detail = (e as CustomEvent<{ label?: string; message?: string }>).detail;
      const text = detail?.message ?? `${detail?.label || 'Report delivered'}. Santa's on his way with it 🎁`;
      setFlight({ start: performance.now(), text });
    };
    window.addEventListener(EVENT, onSent);
    return () => window.removeEventListener(EVENT, onSent);
  }, []);

  useEffect(() => {
    if (!flight) return;
    let raf = 0;
    let lastSpark = 0;
    const tick = (t: number) => {
      const elapsed = t - flight.start;
      if (elapsed > DURATION_MS + 1200) {
        setFlight(null);
        setSparks([]);
        return;
      }
      setNow(t);
      if (elapsed < DURATION_MS && t - lastSpark > 45) {
        lastSpark = t;
        const p = path(elapsed / DURATION_MS);
        setSparks((s) => [
          ...s.filter((sp) => t - sp.born < 1100),
          { id: nextId.current++, x: p.x + 8 + Math.random() * 14, y: p.y + 58 + (Math.random() - 0.5) * 18, born: t, size: 2 + Math.random() * 3.5 },
        ]);
      } else {
        setSparks((s) => s.filter((sp) => t - sp.born < 1100));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [flight]);

  if (!christmas || !flight) return null;
  const elapsed = now - flight.start;
  const progress = Math.min(1, Math.max(0, elapsed / DURATION_MS));
  const pos = path(progress);
  const banner = elapsed > 700 && elapsed < DURATION_MS - 600;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden" aria-hidden>
      {sparks.map((s) => {
        const age = (now - s.born) / 1100;
        return (
          <span
            key={s.id}
            className="absolute rounded-full"
            style={{
              left: s.x,
              top: s.y + age * 18,
              width: s.size,
              height: s.size,
              background: '#f4c95d',
              boxShadow: '0 0 8px 2px rgba(244, 201, 93, 0.7)',
              opacity: Math.max(0, 1 - age),
            }}
          />
        );
      })}
      {progress < 1 && (
        <div className="absolute" style={{ left: pos.x, top: pos.y, transform: `rotate(${pos.tilt}deg)` }}>
          <Sleigh phase={elapsed / 90} />
        </div>
      )}
      <div
        className="absolute left-1/2 top-[18%] -translate-x-1/2 rounded-full border border-[rgba(244,201,93,0.35)] bg-[rgba(15,31,25,0.9)] px-6 py-3 text-center shadow-2xl transition-all duration-500"
        style={{ opacity: banner ? 1 : 0, transform: `translate(-50%, ${banner ? 0 : -10}px)` }}
      >
        <p className="text-lg font-bold text-[#f4c95d]">Ho ho ho! 🎅</p>
        <p className="text-sm text-[#f6f3ea]">{flight.text}</p>
      </div>
    </div>
  );
}

/** Left-to-right across the screen on a gentle rising wave. */
function path(p: number) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = -380 + p * (w + 420);
  const y = h * 0.62 - p * h * 0.38 + Math.sin(p * Math.PI * 3) * 26;
  const tilt = -8 + Math.cos(p * Math.PI * 3) * 4;
  return { x, y, tilt };
}
