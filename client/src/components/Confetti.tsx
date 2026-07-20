import { useMemo, type CSSProperties } from 'react';

const COLORS = ['var(--team-a)', 'var(--team-b)', '#facc15', '#34d399', '#f472b6'];

interface Particle {
  id: number;
  left: number;
  color: string;
  delay: number;
  duration: number;
  drift: number;
  rotate: number;
  width: number;
  height: number;
}

/** Pure CSS falling-confetti burst — no canvas/deps, just @keyframes per piece. */
export default function Confetti({ count = 70 }: { count?: number }) {
  const particles = useMemo<Particle[]>(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        delay: Math.random() * 0.7,
        duration: 2.2 + Math.random() * 1.6,
        drift: (Math.random() - 0.5) * 140,
        rotate: 180 + Math.random() * 540,
        width: 5 + Math.random() * 6,
        height: 9 + Math.random() * 8,
      })),
    [count],
  );

  return (
    <div className="confetti-stage" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          className="confetti-piece"
          style={
            {
              left: `${p.left}%`,
              backgroundColor: p.color,
              width: `${p.width}px`,
              height: `${p.height}px`,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
              '--drift': `${p.drift}px`,
              '--rotate': `${p.rotate}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
