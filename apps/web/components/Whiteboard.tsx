'use client';

import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { useEffect, useState } from 'react';
import type { Board } from '@ftt/game-engine/board';
import type { GameView } from '@ftt/shared-types';

export const PLAYER_INK = ['var(--color-pink)', 'var(--color-blue)'];

/** A slightly wobbly hand-drawn stroke under a word. */
function Underline({ color, animate, wobble }: { color: string; animate: boolean; wobble: number }) {
  const paths = [
    'M2 5 C 18 2.5, 34 7, 52 4.5 S 84 3, 98 5.5',
    'M2 4.5 C 22 7, 40 2.5, 60 5 S 86 6.5, 98 4',
    'M2 5.5 C 16 3.5, 42 6, 58 4 S 80 4.5, 98 5',
  ];
  return (
    <svg className="pointer-events-none absolute inset-x-0 -bottom-[0.06em] h-[0.2em] w-full overflow-visible" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden>
      <motion.path
        d={paths[wobble % paths.length]} fill="none" stroke={color} strokeWidth="3.2" strokeLinecap="round"
        initial={animate ? { pathLength: 0, opacity: 0.6 } : false} animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.45, ease: [0.3, 0.7, 0.3, 1] }}
      />
    </svg>
  );
}

interface RowProps {
  index: number;
  length: number;
  text: string;
  kind: 'fixed' | 'locked' | 'open';
  selected?: boolean;
  disabled?: boolean;
  highlighted?: boolean;
  revealed?: (string | null)[];
  peerText?: string;
  tag?: { text: string; color: string } | null;
  ink?: string;
  shake?: number;
  label: string;
  onSelect?: () => void;
}

function WordRow({ index, length, text, kind, selected, disabled, highlighted, revealed, peerText, tag, ink, shake, label, onSelect }: RowProps) {
  const controls = useAnimationControls();
  const [wrong, setWrong] = useState(false);
  // Words that were already locked when the row first rendered don't replay the stroke.
  const [wasLockedAtMount] = useState(kind !== 'open');

  useEffect(() => {
    if (!shake) return;
    setWrong(true);
    void controls.start({ x: [0, -9, 9, -7, 7, -3, 0], transition: { duration: 0.42 } });
    const t = setTimeout(() => setWrong(false), 1100);
    return () => clearTimeout(t);
  }, [shake, controls]);

  const tilt = ((index * 37) % 5) - 2; // tiny per-row slant so it looks handwritten
  const cells = Array.from({ length }, (_, i) => {
    const mine = text[i];
    const peer = !mine && !text ? peerText?.[i] : undefined;
    const ghost = !mine && !peer ? revealed?.[i] ?? undefined : undefined;
    return { mine, peer, ghost };
  });

  return (
    <div className="word-row">
      <motion.div
        animate={controls}
        role={kind === 'open' ? 'button' : undefined}
        tabIndex={kind === 'open' && !disabled ? 0 : undefined}
        aria-label={label}
        aria-pressed={kind === 'open' ? !!selected : undefined}
        onClick={kind === 'open' ? onSelect : undefined}
        onKeyDown={(e) => kind === 'open' && e.key === ' ' && (e.preventDefault(), onSelect?.())}
        className={`word-cells ${kind === 'open' ? 'cursor-pointer' : ''}`}
        style={{
          rotate: `${tilt * 0.35}deg`,
          background: highlighted ? 'rgb(255 214 64 / 0.45)' : selected ? 'rgb(36 86 201 / 0.07)' : undefined,
          boxShadow: highlighted ? '0 0 0 0.12em rgb(255 214 64 / 0.45)' : undefined,
          transition: 'background 0.25s, box-shadow 0.25s',
        }}
      >
        {cells.map((c, i) => (
          <span key={i} className={`cell ${kind === 'open' ? 'cell-dash' : ''}`}>
            <AnimatePresence mode="popLayout" initial={false}>
              {c.mine && (
                <motion.span
                  key={`m${c.mine}`}
                  initial={{ opacity: 0, scale: 0.5, y: '-0.15em', rotate: -10 }} animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
                  exit={{ opacity: 0, scale: 0.8, filter: 'blur(3px)' }} transition={{ type: 'spring', stiffness: 520, damping: 26 }}
                  style={{ color: kind === 'open' ? 'var(--color-ink)' : ink ?? 'var(--color-ink)' }}
                >
                  {c.mine}
                </motion.span>
              )}
              {c.peer && (
                <motion.span key={`p${c.peer}`} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 0.55, scale: 1 }} exit={{ opacity: 0 }} style={{ color: tag?.color ?? 'var(--color-blue)' }}>
                  {c.peer}
                </motion.span>
              )}
              {c.ghost && (
                <motion.span key={`g${c.ghost}`} initial={{ opacity: 0, scale: 1.6 }} animate={{ opacity: 0.6, scale: 1 }} exit={{ opacity: 0 }} style={{ color: 'var(--color-amber)' }}>
                  {c.ghost}
                </motion.span>
              )}
            </AnimatePresence>
            {selected && !disabled && i === Math.min(text.length, length - 1) && text.length < length && <span className="caret" style={{ left: '12%' }} />}
          </span>
        ))}
        {kind !== 'open' && <Underline color={kind === 'fixed' ? 'var(--color-ink)' : 'var(--color-green)'} animate={!wasLockedAtMount} wobble={index} />}
        {kind === 'open' && wrong && <Underline color="var(--color-red)" animate wobble={index + 1} />}
        {kind === 'locked' && !wasLockedAtMount && (
          <motion.span
            className="pointer-events-none absolute inset-0 rounded-[0.2em]" aria-hidden
            initial={{ boxShadow: '0 0 0 0 rgb(23 146 77 / 0.5)', background: 'rgb(23 146 77 / 0.16)' }}
            animate={{ boxShadow: '0 0 0 0.5em rgb(23 146 77 / 0)', background: 'rgb(23 146 77 / 0)' }}
            transition={{ duration: 0.9 }}
          />
        )}
        {tag && <span className="row-tag" style={{ color: tag.color }}>{tag.text}</span>}
      </motion.div>
    </div>
  );
}

interface Props {
  game: GameView;
  board: Board;
  selected: number | null;
  canPlay: boolean;
  me: string | null;
  highlight: number | null;
  rejected: { slot: number; nonce: number } | null;
  peer: { drafts: Record<number, string>; focus: number | null };
  onSelect: (slot: number) => void;
}

export function Whiteboard({ game, board, selected, canPlay, me, highlight, rejected, peer, onSelect }: Props) {
  const playerIndex = (id: string | null) => Math.max(0, game.players.findIndex((p) => p.id === id));
  const partner = game.mode === 'couples' ? game.players.find((p) => p.id !== me) : undefined;
  const partnerInk = partner ? PLAYER_INK[playerIndex(partner.id)]! : PLAYER_INK[1]!;
  const multi = game.players.length > 1;

  return (
    <div className="board-frame flex h-full min-h-0 flex-col">
      <div className="board-surface flex min-h-0 flex-1 flex-col px-3 pb-2 pt-2 sm:px-6">
        <p className="shrink-0 truncate text-center font-marker text-[clamp(1.05rem,4.6vw,1.6rem)] text-blue" style={{ rotate: '-1deg' }}>
          get from <b className="font-normal tracking-wider">{game.start}</b> to <b className="font-normal tracking-wider">{game.target}</b>
        </p>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${game.code}:${game.round}`} className="board-rows relative"
            initial={{ opacity: 0, filter: 'blur(6px)' }} animate={{ opacity: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: 60, filter: 'blur(8px)' }} transition={{ duration: 0.35 }}
          >
            <div className="board-rows-inner" style={{ ['--rows' as string]: game.slots.length + 2, ['--letters' as string]: game.length }}>
              <WordRow index={0} length={game.length} text={game.start} kind="fixed" label={`Start word ${game.start}`} />
              {game.slots.map((slot, i) => {
                const local = board.slots[i]!;
                const locked = local.locked;
                const peerHere = partner && peer.focus === i && !locked;
                const tag = locked && multi
                  ? { text: game.players[playerIndex(slot.lockedBy)]?.name ?? '', color: PLAYER_INK[playerIndex(slot.lockedBy)]! }
                  : peerHere ? { text: `${partner!.name} ✍️`, color: partnerInk } : null;
                return (
                  <WordRow
                    key={i} index={i + 1} length={game.length} text={local.text} kind={locked ? 'locked' : 'open'}
                    selected={selected === i} disabled={!canPlay} highlighted={highlight === i && !locked}
                    revealed={slot.revealed} peerText={partner ? peer.drafts[i] : undefined} tag={tag}
                    shake={rejected?.slot === i ? rejected.nonce : 0}
                    label={locked ? `Word ${i + 1}: ${local.text}, locked` : `Word ${i + 1}: ${local.text || 'empty'}`}
                    onSelect={() => onSelect(i)}
                  />
                );
              })}
              <WordRow index={game.slots.length + 1} length={game.length} text={game.target} kind="fixed" label={`Target word ${game.target}`} />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="board-tray" aria-hidden>
        <span className="absolute -top-[9px] left-[14%] h-[11px] w-[74px] rounded-[3px] bg-gradient-to-b from-[#2b2b31] to-[#0e0e11]"><span className="absolute inset-y-0 left-0 w-3 rounded-l-[3px] bg-[#dedede]" /></span>
        <span className="absolute -top-[13px] right-[16%] h-[15px] w-[58px] rounded-[4px] bg-gradient-to-b from-[#8fd3e8] to-[#4aa7c4] shadow-[0_2px_0_#3a3a3a]" />
      </div>
    </div>
  );
}
