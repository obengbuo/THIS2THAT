'use client';

import { Icon } from './ui';

const ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

export function Keyboard({ disabled, busy, onLetter, onBackspace, onEnter }: {
  disabled: boolean; busy: boolean; onLetter: (l: string) => void; onBackspace: () => void; onEnter: () => void;
}) {
  const key = 'kb-key h-11 rounded-lg bg-white text-xl leading-none shadow-[0_2px_0_rgb(0_0_0/0.18)] active:translate-y-[2px] active:shadow-none disabled:opacity-45 select-none';
  return (
    <div className="touch-keyboard mx-auto w-full max-w-xl select-none space-y-1.5 px-1.5 pb-[max(6px,env(safe-area-inset-bottom))]" aria-label="Keyboard">
      {ROWS.map((row, r) => (
        <div key={row} className="flex justify-center gap-1">
          {r === 2 && (
            <button type="button" onClick={onEnter} disabled={disabled || busy} className={`${key} flex-[1.6] bg-green! text-base text-white`} aria-label="Check word">
              CHECK
            </button>
          )}
          {[...row].map((l) => (
            <button key={l} type="button" onClick={() => onLetter(l)} disabled={disabled} className={`${key} flex-1`}>
              {l}
            </button>
          ))}
          {r === 2 && (
            <button type="button" onClick={onBackspace} disabled={disabled} className={`${key} grid flex-[1.4] place-items-center`} aria-label="Put the letter back">
              <Icon name="erase" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
