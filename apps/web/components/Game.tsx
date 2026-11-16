'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { REACTIONS, type Difficulty, type HintType, type WordLength } from '@ftt/shared-types';
import { formatTime, inviteLink, resultSummary, share } from '@/lib/format';
import type { Prefs } from '@/lib/storage';
import type { GameController } from '@/lib/useGame';
import { Confetti } from './Confetti';
import { InviteDialog, ResultsDialog } from './Dialogs';
import { Keyboard } from './Keyboard';
import { Button, Icon, Modal, Segmented } from './ui';
import { PLAYER_INK, Whiteboard } from './Whiteboard';

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const TOAST_STYLE = {
  info: 'bg-ink text-white',
  error: 'bg-red text-white',
  success: 'bg-green text-white',
  hint: 'bg-[#ffe27a] text-ink',
};

const HINTS: { type: HintType; title: string; detail: string }[] = [
  { type: 'next', title: 'Show next move', detail: 'Highlights a line you can solve now' },
  { type: 'letter', title: 'Reveal a letter', detail: 'One letter of the selected line' },
  { type: 'word', title: 'Suggest a word', detail: 'Writes a word for you to check' },
];

export function Game({ ctrl, prefs, updatePrefs }: { ctrl: GameController; prefs: Prefs; updatePrefs: (p: Partial<Prefs>) => void }) {
  const { actions, busy, canPlay, me } = ctrl;
  const game = ctrl.game!;
  const board = ctrl.board!;
  const playing = game.status === 'playing';
  const couples = game.mode === 'couples';
  const waiting = couples && game.players.length < 2;
  const partner = couples ? game.players.find((p) => p.id !== me) : undefined;

  const [hintOpen, setHintOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [next, setNext] = useState<{ length: WordLength; difficulty: Difficulty }>({ length: game.length, difficulty: game.difficulty });

  // Offer the invite as soon as a room is created.
  const invited = useRef(false);
  useEffect(() => {
    if (waiting && !invited.current && game.round === 1 && game.correctSubmissions === 0) setInviteOpen(true);
    invited.current = true;
  }, [waiting, game.round, game.correctSubmissions]);
  useEffect(() => {
    if (!waiting) setInviteOpen(false);
  }, [waiting]);

  // Celebrate once the last underline has been drawn.
  useEffect(() => {
    if (playing) return void setResultsOpen(false);
    const t = setTimeout(() => setResultsOpen(true), 1100);
    return () => clearTimeout(t);
  }, [playing, game.round]);

  const now = useNow(playing && game.startedAt !== null);
  const elapsed = game.result ? game.result.elapsedMs : game.startedAt === null ? 0 : now + ctrl.clockOffset - game.startedAt;

  // Physical keyboard.
  const handlers = useRef(actions);
  handlers.current = actions;
  const selectedRef = useRef(ctrl.selected);
  selectedRef.current = ctrl.selected;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          handlers.current.undo();
        }
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [data-modal]') || document.querySelector('[data-modal]')) return;
      if (/^[a-zA-Z]$/.test(e.key)) handlers.current.type(e.key.toUpperCase());
      else if (e.key === 'Backspace') handlers.current.backspace();
      else if (e.key === 'Enter') {
        if (target.closest('button')) return; // let focused buttons do their own thing
        e.preventDefault();
        void handlers.current.submit();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const open = board.slots.map((s, i) => (s.locked ? -1 : i)).filter((i) => i >= 0);
        if (!open.length) return;
        const at = open.indexOf(selectedRef.current ?? open[0]!);
        handlers.current.select(open[(at + (e.key === 'ArrowDown' ? 1 : open.length - 1)) % open.length]!);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [board]);

  const shareGame = async () => {
    const data = couples && playing
      ? { title: 'FROM THIS TO THAT', text: `Play FROM THIS TO THAT with me! Room code: ${game.code}`, url: inviteLink(game.code) }
      : playing
        ? { title: 'FROM THIS TO THAT', text: `Can you get from ${game.start} to ${game.target} in ${game.slots.length} words? ✍️`, url: window.location.origin + window.location.pathname }
        : { title: 'FROM THIS TO THAT', text: resultSummary(game) };
    const outcome = await share(data);
    if (outcome === 'copied') actions.notify('Copied — paste it anywhere!', 'success');
    if (outcome === 'failed') actions.notify("Couldn't share from this browser.", 'error');
  };

  const turnPlayer = game.turnBased ? game.players.find((p) => p.id === game.turn) : undefined;
  const myTurn = game.mode === 'pass' || game.turn === me;
  const tool = 'flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-[13px] leading-none text-ink hover:bg-black/5 disabled:opacity-40';

  return (
    <main className="mx-auto flex h-dvh max-w-2xl flex-col gap-2 px-2 pt-[max(8px,env(safe-area-inset-top))] sm:px-4">
      {/* top bar */}
      <header className="flex shrink-0 items-center gap-2">
        <button onClick={actions.leave} aria-label="Leave game" className="grid size-10 place-items-center rounded-full bg-white/70 hover:bg-white">
          <Icon name="home" className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="font-title text-[15px] leading-[1.05] sm:text-xl">FROM THIS <br className="sm:hidden" />TO THAT</h1>
          <p className="hidden truncate text-sm leading-tight text-ink-soft sm:block">
            {game.length} letters · {game.difficulty} · {game.mode === 'pass' ? 'pass the phone' : game.mode}
          </p>
        </div>
        {couples && (
          <button onClick={() => setInviteOpen(true)} className="flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1.5 text-sm hover:bg-white" aria-label={`Room ${game.code}. Invite`}>
            <span className={`size-2 rounded-full ${ctrl.link === 'online' ? 'bg-green' : 'animate-pulse bg-amber'}`} />
            <span className="font-marker text-lg leading-none tracking-widest">{game.code}</span>
          </button>
        )}
        <div className="rounded-full bg-white/70 px-3 py-1.5 font-marker text-xl leading-none tabular-nums" aria-label="Timer" role="timer">
          {formatTime(elapsed)}
        </div>
        <button
          onClick={() => updatePrefs({ sound: !prefs.sound })} aria-label={prefs.sound ? 'Sound on' : 'Sound off'} aria-pressed={prefs.sound}
          className="grid size-10 place-items-center rounded-full bg-white/70 hover:bg-white"
        >
          <Icon name={prefs.sound ? 'soundOn' : 'soundOff'} className="size-5" />
        </button>
      </header>

      {/* players / turn strip */}
      {(game.players.length > 1 || waiting) && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-[15px] leading-none">
          {game.players.map((p, i) => (
            <span
              key={p.id}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 ${game.turnBased && game.turn === p.id && playing ? 'bg-white shadow-sm ring-2 ring-ink/80' : 'bg-white/60'}`}
            >
              <span className="size-2.5 rounded-full" style={{ background: PLAYER_INK[i] }} />
              <span className="max-w-[9ch] truncate">{p.name}{p.id === me && couples ? ' (you)' : ''}</span>
              {couples && p.id !== me && <span className={`text-xs ${p.connected ? 'text-green' : 'text-ink-soft'}`}>{p.connected ? '● here' : '○ away'}</span>}
            </span>
          ))}
          {waiting && (
            <button onClick={() => setInviteOpen(true)} className="animate-pulse rounded-full border-2 border-dashed border-ink-soft/50 px-2.5 py-1 text-ink-soft">
              waiting for your partner… invite
            </button>
          )}
          {turnPlayer && playing && game.players.length > 1 && (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-ink-soft">{game.mode === 'pass' ? `${turnPlayer.name}'s turn` : myTurn ? 'your turn' : `${turnPlayer.name}'s turn`}</span>
              {myTurn && (
                <button onClick={actions.pass} className="flex items-center gap-1 rounded-full bg-white px-2.5 py-1.5 hover:bg-wall-deep">
                  pass <Icon name="pass" className="size-3.5" />
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {/* the whiteboard */}
      <section className="relative min-h-0 flex-1" aria-label="Whiteboard">
        <Whiteboard
          game={game} board={board} selected={playing ? ctrl.selected : null} canPlay={canPlay} me={me}
          highlight={ctrl.highlight} rejected={ctrl.rejected} peer={ctrl.peer} onSelect={actions.select}
        />
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4" aria-live="polite">
          <AnimatePresence>
            {ctrl.toast && (
              <motion.p
                key={ctrl.toast.id} role="status"
                className={`rounded-2xl px-4 py-2 text-center text-[17px] leading-snug shadow-lg ${TOAST_STYLE[ctrl.toast.tone]}`}
                initial={{ y: -16, opacity: 0, scale: 0.95 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: -8, opacity: 0 }}
              >
                {ctrl.toast.text}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
          <AnimatePresence>
            {ctrl.reactions.map((r) => (
              <motion.span
                key={r.id} className="absolute bottom-10 text-4xl" style={{ left: r.mine ? '72%' : '18%' }}
                initial={{ y: 0, opacity: 0, scale: 0.4 }} animate={{ y: -260, opacity: [0, 1, 1, 0], scale: 1.5, x: [0, 14, -10, 6] }}
                exit={{ opacity: 0 }} transition={{ duration: 2.4, ease: 'easeOut' }}
              >
                {r.emoji}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      </section>

      {/* toolbar */}
      <nav className="relative shrink-0" aria-label="Game controls">
        <AnimatePresence>
          {hintOpen && (
            <motion.div
              className="absolute bottom-full left-0 right-0 z-20 mx-auto mb-2 max-w-sm rounded-2xl bg-white p-2 shadow-xl"
              initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 10, opacity: 0 }}
            >
              {HINTS.map((h) => (
                <button
                  key={h.type} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left hover:bg-wall"
                  onClick={() => { setHintOpen(false); void actions.hint(h.type); }}
                >
                  <span><span className="block text-lg leading-tight">{h.title}</span><span className="block text-sm text-ink-soft">{h.detail}</span></span>
                  <span className="shrink-0 text-sm text-red">−100</span>
                </button>
              ))}
            </motion.div>
          )}
          {reactOpen && (
            <motion.div
              className="absolute bottom-full right-0 z-20 mb-2 flex gap-1 rounded-full bg-white p-1.5 shadow-xl"
              initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 10, opacity: 0 }}
            >
              {REACTIONS.map((emoji) => (
                <button key={emoji} className="grid size-11 place-items-center rounded-full text-2xl hover:bg-wall" onClick={() => actions.react(emoji)} aria-label={`Send ${emoji}`}>
                  {emoji}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
        <div className="toolbar flex items-stretch gap-0.5 rounded-2xl bg-white/75 p-1">
          <button className={tool} onClick={() => { setNext({ length: game.length, difficulty: game.difficulty }); setNewOpen(true); }}><Icon name="new" />New Game</button>
          <button className={tool} onClick={actions.reset} disabled={!playing}><Icon name="reset" />Reset</button>
          <button className={tool} onClick={actions.undo} disabled={!playing || board.history.length === 0}><Icon name="undo" />Undo</button>
          <button className={tool} onClick={() => { setReactOpen(false); setHintOpen((o) => !o); }} disabled={!playing || busy} aria-expanded={hintOpen}><Icon name="hint" />Hint</button>
          <button className={`${tool} bg-green! text-white! disabled:opacity-50`} onClick={() => void actions.submit()} disabled={!canPlay || busy}><Icon name="check" />Check Word</button>
          <button className={tool} onClick={shareGame}><Icon name="share" />Share</button>
          {couples && (
            <button className={tool} onClick={() => { setHintOpen(false); setReactOpen((o) => !o); }} aria-expanded={reactOpen} disabled={!partner}>
              <span className="grid size-6 place-items-center text-xl leading-none">❤️</span>React
            </button>
          )}
        </div>
      </nav>

      <Keyboard disabled={!canPlay} busy={busy} onLetter={actions.type} onBackspace={actions.backspace} onEnter={() => void actions.submit()} />
      <p className="desktop-hint shrink-0 pb-3 text-center text-sm text-ink-soft">
        Type to write · <kbd>Enter</kbd> to check · <kbd>↑</kbd> <kbd>↓</kbd> to change line · <kbd>Ctrl/⌘ Z</kbd> to undo
      </p>

      {/* dialogs */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New game">
        <div className="space-y-3">
          <Segmented label="Word length" value={next.length} onChange={(length) => setNext((n) => ({ ...n, length }))} options={[{ value: 4, label: '4 Letters' }, { value: 5, label: '5 Letters' }]} />
          <Segmented label="Difficulty" value={next.difficulty} onChange={(difficulty) => setNext((n) => ({ ...n, difficulty }))} options={[{ value: 'easy', label: 'Easy' }, { value: 'medium', label: 'Medium' }, { value: 'hard', label: 'Hard' }]} />
          {playing && (
            <p className="rounded-2xl bg-wall px-3 py-2 text-[15px] leading-snug text-ink-soft">
              This wipes the whole board{partner ? ' for both of you' : ''}, including locked words, and deals a fresh puzzle.
            </p>
          )}
          <Button
            className="w-full" disabled={busy}
            onClick={async () => { setNewOpen(false); updatePrefs(next); await actions.newRound(next); }}
          >
            Wipe the board &amp; deal
          </Button>
        </div>
      </Modal>
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} game={game} notify={actions.notify} />
      <ResultsDialog
        open={resultsOpen && !playing} game={game} busy={busy} notify={actions.notify}
        onClose={() => setResultsOpen(false)} onNewGame={() => void actions.newRound({})}
      />
      {!playing && resultsOpen && <Confetti key={`${game.code}:${game.round}`} />}
    </main>
  );
}
