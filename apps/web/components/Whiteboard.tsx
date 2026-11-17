'use client';

import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { changedAt, type Draft } from '@ftt/game-engine/board';
import type { GameView } from '@ftt/shared-types';
import type { PeerDraft } from '@/lib/useGame';

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

/** A word that is already on the board: the start word or one a player wrote. */
function WrittenRow({ index, word, start, final, tag, ink, animate = false }: {
  index: number; word: string; start?: boolean; final?: boolean; tag?: { text: string; color: string } | null; ink?: string;
  /** Write the word in stroke by stroke (only for a word that has just been played). */
  animate?: boolean;
}) {
  const tilt = ((index * 37) % 5) - 2; // tiny per-row slant so it looks handwritten
  return (
    <div className="word-row">
      <div className="word-cells" aria-label={start ? `Start word ${word}` : `Word ${index}: ${word}`} style={{ rotate: `${tilt * 0.35}deg` }}>
        {[...word].map((ch, i) => (
          <span key={i} className="cell">
            <motion.span
              initial={animate ? { opacity: 0, scale: 0.5, y: '-0.15em', rotate: -10 } : false} animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 520, damping: 26, delay: animate ? i * 0.04 : 0 }}
              style={{ color: start ? 'var(--color-ink)' : ink ?? 'var(--color-ink)' }}
            >
              {ch}
            </motion.span>
          </span>
        ))}
        <Underline color={start ? 'var(--color-ink)' : final ? 'var(--color-green)' : ink ?? 'var(--color-green)'} animate={animate} wobble={index} />
        {final && (
          <motion.span
            className="pointer-events-none absolute inset-0 rounded-[0.2em]" aria-hidden
            initial={{ boxShadow: '0 0 0 0 rgb(23 146 77 / 0.5)', background: 'rgb(23 146 77 / 0.16)' }}
            animate={{ boxShadow: '0 0 0 0.5em rgb(23 146 77 / 0)', background: 'rgb(23 146 77 / 0)' }}
            transition={{ duration: 0.9 }}
          />
        )}
        {tag && <span className="row-tag" style={{ color: tag.color }}>{tag.text}</span>}
      </div>
    </div>
  );
}

/**
 * The last word on the board, which the next move changes in place: tap a letter and
 * type its replacement. When it is the partner's turn, their change shows here live.
 */
function CurrentRow({ index, word, start, text, changed, cursor, editable, ink, changeInk, highlight, shake, tag, animateIn, onSelect }: {
  index: number; word: string; start: boolean; text: string; changed: number | null; cursor: number | null; editable: boolean;
  ink: string; changeInk: string; highlight: number | null; shake: number; tag: { text: string; color: string } | null; animateIn: boolean; onSelect: (i: number) => void;
}) {
  const controls = useAnimationControls();
  const [wrong, setWrong] = useState(false);
  useEffect(() => {
    if (!shake) return;
    setWrong(true);
    void controls.start({ x: [0, -9, 9, -7, 7, -3, 0], transition: { duration: 0.42 } });
    const t = setTimeout(() => setWrong(false), 1100);
    return () => clearTimeout(t);
  }, [shake, controls]);

  const tilt = ((index * 37) % 5) - 2;
  const label = start ? `Start word ${word}` : `Word ${index}: ${word}`;
  return (
    <div className="word-row">
      <motion.div
        animate={controls} className="word-cells" role="group"
        aria-label={editable ? `${label}. Change one letter` : label}
        style={{ rotate: `${tilt * 0.35}deg` }}
      >
        {[...text].map((ch, i) => {
          const isChanged = changed === i;
          const style = {
            color: isChanged ? changeInk : ink,
            background: highlight === i ? 'rgb(255 214 64 / 0.55)' : cursor === i ? 'rgb(36 86 201 / 0.12)' : undefined,
            boxShadow: cursor === i ? 'inset 0 -0.09em 0 var(--color-blue)' : undefined,
          };
          const letter = (
            <AnimatePresence mode="popLayout" initial={animateIn}>
              <motion.span
                key={ch + (isChanged ? '*' : '')}
                initial={{ opacity: 0, scale: 0.5, y: '-0.15em', rotate: -10 }} animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
                exit={{ opacity: 0, scale: 0.8, filter: 'blur(3px)' }} transition={{ type: 'spring', stiffness: 520, damping: 26 }}
              >
                {ch}
              </motion.span>
            </AnimatePresence>
          );
          return editable ? (
            <button
              key={i} type="button" className="cell cell-pick" style={style} onClick={() => onSelect(i)}
              aria-label={`Letter ${i + 1}: ${ch}${isChanged ? `, changed from ${word[i]}` : ''}`} aria-pressed={cursor === i}
            >
              {letter}
            </button>
          ) : (
            <span key={i} className="cell" style={style}>{letter}</span>
          );
        })}
        <Underline color={wrong ? 'var(--color-red)' : start ? 'var(--color-ink)' : ink} animate={wrong} wobble={wrong ? index + 1 : index} />
        {tag && <span className="row-tag" style={{ color: tag.color }}>{tag.text}</span>}
      </motion.div>
    </div>
  );
}

interface Props {
  game: GameView;
  draft: Draft;
  canPlay: boolean;
  me: string | null;
  highlight: number | null;
  rejected: number;
  peer: PeerDraft | null;
  onSelect: (index: number) => void;
}

export function Whiteboard({ game, draft, canPlay, me, highlight, rejected, peer, onSelect }: Props) {
  const playerIndex = (id: string | null) => Math.max(0, game.players.findIndex((p) => p.id === id));
  const multi = game.players.length > 1;
  const playing = game.status === 'playing';
  const words = [{ word: game.start, by: null as string | null }, ...game.chain];
  const last = words.length - 1;
  const inkOf = (by: string | null) => (by === null ? 'var(--color-ink)' : multi ? PLAYER_INK[playerIndex(by)]! : 'var(--color-green)');
  const nameTag = (by: string | null) => (by !== null && multi ? { text: game.players[playerIndex(by)]?.name ?? '', color: PLAYER_INK[playerIndex(by)]! } : null);

  // Whose change is showing on the last word: mine while it is my turn, otherwise my partner's.
  const turnPlayer = game.turnBased ? game.players.find((p) => p.id === game.turn) : game.players[0];
  const partnerWriting = game.mode === 'couples' && !canPlay && playing && peer?.after === game.chain.length && peer.text.length === game.length;
  const shown = canPlay ? draft.text : partnerWriting ? peer!.text : words[last]!.word;
  const changed = canPlay ? changedAt(draft) ?? -1 : partnerWriting ? [...shown].findIndex((ch, i) => ch !== words[last]!.word[i]) : -1;
  const writerInk = multi && turnPlayer ? PLAYER_INK[playerIndex(turnPlayer.id)]! : 'var(--color-blue)';

  // Keep the newest word in view as the ladder grows.
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [words.length, game.round]);

  // Words that were already on the board when it first appeared are not re-animated.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  const moves = game.chain.length;
  return (
    <div className="board-frame flex h-full min-h-0 flex-col">
      <div className="board-surface flex min-h-0 flex-1 flex-col px-3 pb-2 pt-2 sm:px-6">
        <p className="shrink-0 truncate text-center font-marker text-[clamp(1.05rem,4.6vw,1.6rem)] text-blue" style={{ rotate: '-1deg' }} aria-label={`Goal: get from ${game.start} to ${game.target}`}>
          get from <b className="font-normal tracking-wider">{game.start}</b> to <b className="font-normal tracking-wider">{game.target}</b>
        </p>
        <p className="shrink-0 text-center text-[13px] leading-tight text-ink-soft">
          {moves === 0 ? `change one letter at a time · can be done in ${game.optimalMoves} moves` : `${moves} ${moves === 1 ? 'move' : 'moves'} so far · can be done in ${game.optimalMoves}`}
        </p>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${game.code}:${game.round}`} className="board-rows relative"
            initial={{ opacity: 0, filter: 'blur(6px)' }} animate={{ opacity: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: 60, filter: 'blur(8px)' }} transition={{ duration: 0.35 }}
          >
            <div className="board-rows-inner" style={{ ['--rows' as string]: Math.min(8, Math.max(5, words.length)), ['--letters' as string]: game.length }}>
              {words.map((w, i) =>
                i === last && playing ? (
                  <CurrentRow
                    key={i} index={i} word={w.word} start={i === 0} text={shown} changed={changed >= 0 ? changed : null}
                    cursor={canPlay ? draft.cursor : partnerWriting ? peer!.cursor : null} editable={canPlay}
                    ink={inkOf(w.by)} changeInk={writerInk} highlight={canPlay ? highlight : null} shake={rejected}
                    tag={partnerWriting && turnPlayer ? { text: `${turnPlayer.name} ✍️`, color: writerInk } : nameTag(w.by)}
                    animateIn={mounted.current && i > 0} onSelect={onSelect}
                  />
                ) : (
                  <WrittenRow key={i} index={i} word={w.word} start={i === 0} final={i === last && !playing} animate={mounted.current && i === last} tag={nameTag(w.by)} ink={inkOf(w.by)} />
                ),
              )}
              <div ref={end} aria-hidden />
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
