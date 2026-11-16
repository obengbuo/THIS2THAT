'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, type ReactNode } from 'react';

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose?: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-[2px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}
          data-modal
        >
          <motion.div
            role="dialog" aria-modal="true" aria-label={title}
            className={`max-h-[88dvh] w-full overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl sm:p-6 ${wide ? 'max-w-lg' : 'max-w-sm'}`}
            initial={{ y: 24, scale: 0.96 }} animate={{ y: 0, scale: 1 }} exit={{ y: 16, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <h2 className="font-title text-2xl leading-tight">{title}</h2>
              {onClose && (
                <button onClick={onClose} aria-label="Close" className="-mr-1 -mt-1 grid size-9 shrink-0 place-items-center rounded-full text-2xl text-ink-soft hover:bg-black/5">
                  ×
                </button>
              )}
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Button({ variant = 'primary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'soft' }) {
  const styles = {
    primary: 'bg-ink text-white shadow-[0_4px_0_#000] active:translate-y-[3px] active:shadow-[0_1px_0_#000] disabled:opacity-50',
    soft: 'bg-wall text-ink hover:bg-wall-deep disabled:opacity-50',
    ghost: 'text-ink hover:bg-black/5 disabled:opacity-40',
  }[variant];
  return <button {...props} className={`rounded-2xl px-5 py-3 text-lg leading-none transition ${styles} ${className}`} />;
}

export function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm uppercase tracking-wider text-ink-soft">{label}</legend>
      <div className="grid gap-1 rounded-2xl bg-wall p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <button
            key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}
            className={`rounded-xl px-2 py-2 leading-tight transition ${o.value === value ? 'bg-white shadow-sm' : 'text-ink-soft hover:text-ink'}`}
          >
            <span className="block text-[17px]">{o.label}</span>
            {o.hint && <span className="block text-xs text-ink-soft">{o.hint}</span>}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function TextField({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm uppercase tracking-wider text-ink-soft">{label}</span>
      <input {...props} className={`w-full rounded-2xl border-2 border-wall-deep bg-white px-4 py-2.5 text-lg outline-none focus:border-blue ${props.className ?? ''}`} />
    </label>
  );
}

const ICONS: Record<string, ReactNode> = {
  new: <path d="M12 5v14M5 12h14" />,
  reset: <><path d="M4 12a8 8 0 1 0 2.6-5.9" /><path d="M4 4v5h5" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>,
  hint: <><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.4 1 2.5h6c0-1.1.3-1.8 1-2.5A6 6 0 0 0 12 3Z" /></>,
  check: <path d="m5 12 5 5 9-10" />,
  soundOn: <><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></>,
  soundOff: <><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="m17 9 5 6M22 9l-5 6" /></>,
  share: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" /></>,
  home: <><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10" /></>,
  back: <path d="M6 6l12 12M18 6 6 18" />,
  erase: <><path d="M20 5H9l-6 7 6 7h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z" /><path d="m12 9 6 6M18 9l-6 6" /></>,
  pass: <><path d="M4 12h14" /><path d="m13 6 6 6-6 6" /></>,
};

export function Icon({ name, className = 'size-6' }: { name: keyof typeof ICONS | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {ICONS[name]}
    </svg>
  );
}
