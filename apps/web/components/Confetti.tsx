'use client';

import { motion, useReducedMotion } from 'motion/react';
import { useMemo } from 'react';

const COLORS = ['#d6336c', '#2456c9', '#17924d', '#f2b705', '#ff7a45', '#7c4dff'];

export function Confetti() {
  const reduced = useReducedMotion();
  const pieces = useMemo(
    () => Array.from({ length: 70 }, (_, i) => ({
      id: i, left: Math.random() * 100, delay: Math.random() * 0.5, duration: 2.2 + Math.random() * 1.6,
      drift: (Math.random() - 0.5) * 160, spin: (Math.random() - 0.5) * 900, color: COLORS[i % COLORS.length]!, size: 6 + Math.random() * 8,
    })),
    [],
  );
  if (reduced) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden" aria-hidden>
      {pieces.map((p) => (
        <motion.span
          key={p.id} className="absolute top-0 block rounded-[2px]"
          style={{ left: `${p.left}%`, width: p.size, height: p.size * 0.55, background: p.color }}
          initial={{ y: -30, x: 0, rotate: 0, opacity: 1 }} animate={{ y: '105vh', x: p.drift, rotate: p.spin, opacity: [1, 1, 0.9, 0] }}
          transition={{ duration: p.duration, delay: p.delay, ease: 'easeIn' }}
        />
      ))}
    </div>
  );
}
