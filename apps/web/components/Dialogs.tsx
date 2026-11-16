'use client';

import { useEffect, useState } from 'react';
import type { GameView, PlayerStats } from '@ftt/shared-types';
import { api } from '@/lib/api';
import { formatTime, inviteLink, resultSummary, share } from '@/lib/format';
import { deviceId } from '@/lib/storage';
import { Button, Modal } from './ui';

export function HowToPlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="How to play" wide>
      <ol className="list-decimal space-y-2 pl-5 text-[17px] leading-snug">
        <li>You get a <b>start word</b> and a <b>target word</b> on the whiteboard.</li>
        <li>Fill the empty lines so each word changes <b>exactly one letter</b> from the word above it. No rearranging, adding or removing letters.</li>
        <li>Every line must be a real English word.</li>
        <li>Tap a line, write a word, and press <b>Check</b>. A correct word gets a <span className="text-green">green underline</span> and is <b>locked for good</b>.</li>
        <li>Work top-down, bottom-up, or from the middle. There is often more than one route — any valid one counts.</li>
      </ol>
      <p className="mt-4 rounded-2xl bg-wall p-3 text-center font-marker text-2xl tracking-[0.2em]">
        COLD → CORD → CARD → WARD → WARM
      </p>
      <p className="mt-4 text-[17px] leading-snug text-ink-soft">
        <b className="text-ink">Far apart?</b> Pick <b className="text-ink">Couples</b>, send your partner the link, and you will both write on the same board in real time — you can even watch each other&apos;s handwriting appear.
      </p>
      <Button className="mt-5 w-full" onClick={onClose}>Got it</Button>
    </Modal>
  );
}

export function StatsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    setError(false);
    api.stats(deviceId()).then(setStats).catch(() => setError(true));
  }, [open]);

  const rows: [string, string][] = stats
    ? [
        ['Games played', String(stats.gamesPlayed)],
        ['Games completed', String(stats.gamesCompleted)],
        ['Current streak', `${stats.currentStreak} 🔥`],
        ['Best streak', String(stats.bestStreak)],
        ['Best time', stats.bestTimeMs === null ? '—' : formatTime(stats.bestTimeMs)],
        ['Best score', String(stats.bestScore)],
        ['Correct words', String(stats.correctSubmissions)],
        ['Misses', String(stats.incorrectSubmissions)],
        ['Hints used', String(stats.hintsUsed)],
      ]
    : [];
  return (
    <Modal open={open} onClose={onClose} title="Statistics">
      {error ? (
        <p className="text-ink-soft">Couldn&apos;t load your statistics right now.</p>
      ) : !stats ? (
        <p className="text-ink-soft">Loading…</p>
      ) : (
        <dl className="grid grid-cols-2 gap-2">
          {rows.map(([k, v]) => (
            <div key={k} className="rounded-2xl bg-wall px-3 py-2">
              <dt className="text-sm text-ink-soft">{k}</dt>
              <dd className="font-marker text-3xl leading-none">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-3 text-sm text-ink-soft">Saved for this browser — no account needed.</p>
    </Modal>
  );
}

export function InviteDialog({ open, onClose, game, notify }: { open: boolean; onClose: () => void; game: GameView; notify: (t: string, tone?: 'success' | 'error') => void }) {
  const link = typeof window === 'undefined' ? '' : inviteLink(game.code);
  const send = async () => {
    const outcome = await share({ title: 'FROM THIS TO THAT', text: `Play FROM THIS TO THAT with me! Room code: ${game.code}`, url: link });
    if (outcome === 'copied') notify('Invite link copied!', 'success');
    if (outcome === 'failed') notify('Copy the code and send it to your partner.', 'error');
  };
  return (
    <Modal open={open} onClose={onClose} title="Invite your person">
      <p className="text-[17px] leading-snug text-ink-soft">Send this code or link. When they join, you&apos;ll both be writing on the same whiteboard — wherever you each are.</p>
      <p className="my-4 rounded-2xl bg-wall py-3 text-center font-marker text-5xl tracking-[0.25em]" aria-label={`Room code ${game.code.split('').join(' ')}`}>{game.code}</p>
      <p className="mb-4 truncate rounded-xl border-2 border-dashed border-wall-deep px-3 py-2 text-center text-sm text-ink-soft">{link}</p>
      <Button className="w-full" onClick={send}>Share invite link</Button>
      <Button variant="ghost" className="mt-2 w-full" onClick={onClose}>Start solving while I wait</Button>
    </Modal>
  );
}

export function ResultsDialog({ open, game, busy, onNewGame, onClose, notify }: {
  open: boolean; game: GameView; busy: boolean; onNewGame: () => void; onClose: () => void; notify: (t: string, tone?: 'success' | 'error') => void;
}) {
  const r = game.result;
  const ladder = [game.start, ...game.slots.map((s) => s.word ?? ''), game.target];
  const send = async () => {
    const outcome = await share({ title: 'FROM THIS TO THAT', text: resultSummary(game) });
    if (outcome === 'copied') notify('Result copied — paste it anywhere!', 'success');
    if (outcome === 'failed') notify("Couldn't share from this browser.", 'error');
  };
  return (
    <Modal open={open} onClose={onClose} title="YOU GOT FROM THIS TO THAT!" wide>
      <div className="rounded-2xl bg-wall p-3 text-center font-marker text-3xl leading-tight tracking-[0.18em]">
        {ladder.map((w, i) => (
          <div key={i} className={i === 0 || i === ladder.length - 1 ? '' : 'text-green'}>{w}</div>
        ))}
      </div>
      {r && (
        <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
          {[['Time', formatTime(r.elapsedMs)], ['Hints', r.hintsUsed], ['Misses', r.wrongAttempts], ['Score', r.score]].map(([k, v]) => (
            <div key={k} className="rounded-2xl bg-wall px-1 py-2">
              <dt className="text-sm text-ink-soft">{k}</dt>
              <dd className="font-marker text-2xl leading-none">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button variant="soft" onClick={send}>Share result</Button>
        <Button onClick={onNewGame} disabled={busy}>New Game</Button>
      </div>
    </Modal>
  );
}
