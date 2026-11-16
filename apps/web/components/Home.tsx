'use client';

import { useEffect, useState } from 'react';
import type { Prefs } from '@/lib/storage';
import type { GameController } from '@/lib/useGame';
import { HowToPlay, StatsDialog } from './Dialogs';
import { Button, Modal, Segmented, TextField } from './ui';

const TOAST_STYLE = { info: 'bg-ink text-white', error: 'bg-red text-white', success: 'bg-green text-white', hint: 'bg-[#ffe27a] text-ink' };

export function Home({ ctrl, prefs, updatePrefs }: { ctrl: GameController; prefs: Prefs; updatePrefs: (p: Partial<Prefs>) => void }) {
  const { actions, busy } = ctrl;
  const [howOpen, setHowOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [code, setCode] = useState('');

  // Invite links look like /?room=ABC234 — open the join dialog straight away.
  useEffect(() => {
    const room = new URLSearchParams(window.location.search).get('room');
    if (room && /^[A-Za-z0-9]{6}$/.test(room)) {
      setCode(room.toUpperCase());
      setJoinOpen(true);
    }
  }, []);
  const clearInvite = () => window.history.replaceState(null, '', window.location.pathname);

  const start = () =>
    actions.start({
      length: prefs.length, difficulty: prefs.difficulty, mode: prefs.mode, turnBased: prefs.mode === 'couples' && prefs.turnBased,
      name: prefs.name.trim() || 'Player 1', partnerName: prefs.partnerName.trim() || 'Player 2',
    });

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await actions.join(code, prefs.name.trim() || 'Player 2')) clearInvite();
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 px-4 pb-8 pt-[max(20px,env(safe-area-inset-top))]">
      <div className="board-frame">
        <div className="board-surface px-4 pb-4 pt-5 text-center">
          <h1 className="font-title text-[clamp(2rem,10vw,2.9rem)] leading-[0.95]" style={{ rotate: '-1.5deg' }}>
            FROM <span className="text-blue">THIS</span>
            <br />
            TO <span className="text-pink">THAT</span>
          </h1>
          <p className="mt-2 font-marker text-2xl text-ink-soft">Can you connect the words?</p>
          <p className="mx-auto mt-1 max-w-[34ch] text-[15px] leading-snug text-ink-soft">
            The whiteboard word game for two — one board, two markers, even when you&apos;re miles apart.
          </p>
        </div>
        <div className="board-tray" aria-hidden />
      </div>

      <form className="space-y-3 rounded-3xl bg-white/70 p-4" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <Segmented
          label="Who's playing" value={prefs.mode} onChange={(mode) => updatePrefs({ mode })}
          options={[
            { value: 'couples', label: 'Couples', hint: 'two phones, anywhere' },
            { value: 'pass', label: 'Pass-the-Phone', hint: 'one device' },
            { value: 'solo', label: 'Solo', hint: 'just me' },
          ]}
        />
        <Segmented label="Word length" value={prefs.length} onChange={(length) => updatePrefs({ length })} options={[{ value: 4, label: '4 Letters' }, { value: 5, label: '5 Letters' }]} />
        <Segmented
          label="Difficulty" value={prefs.difficulty} onChange={(difficulty) => updatePrefs({ difficulty })}
          options={[{ value: 'easy', label: 'Easy', hint: '2–3 words' }, { value: 'medium', label: 'Medium', hint: '4–5 words' }, { value: 'hard', label: 'Hard', hint: '6–8 words' }]}
        />
        <div className={`grid gap-2 ${prefs.mode === 'pass' ? 'grid-cols-2' : ''}`}>
          <TextField label={prefs.mode === 'pass' ? 'Player 1' : 'Your name'} value={prefs.name} maxLength={16} autoComplete="given-name" placeholder="e.g. Ama" onChange={(e) => updatePrefs({ name: e.target.value })} />
          {prefs.mode === 'pass' && <TextField label="Player 2" value={prefs.partnerName} maxLength={16} placeholder="e.g. Kofi" onChange={(e) => updatePrefs({ partnerName: e.target.value })} />}
        </div>
        {prefs.mode === 'couples' && (
          <label className="flex cursor-pointer items-center gap-3 rounded-2xl bg-wall px-3 py-2.5">
            <input type="checkbox" className="size-5 accent-ink" checked={prefs.turnBased} onChange={(e) => updatePrefs({ turnBased: e.target.checked })} />
            <span className="leading-tight">Take turns <span className="block text-sm text-ink-soft">otherwise you both write freely</span></span>
          </label>
        )}
        <Button type="submit" className="w-full py-4 font-title text-2xl tracking-wide" disabled={busy}>
          {busy ? 'DEALING…' : 'START GAME'}
        </Button>
        {prefs.mode === 'couples' && <p className="text-center text-sm text-ink-soft">You&apos;ll get a link to send to your partner.</p>}
      </form>

      <div className="grid grid-cols-3 gap-2">
        <Button variant="soft" className="px-2 text-base" onClick={() => setJoinOpen(true)}>Join Room</Button>
        <Button variant="soft" className="px-2 text-base" onClick={() => setHowOpen(true)}>How to Play</Button>
        <Button variant="soft" className="px-2 text-base" onClick={() => setStatsOpen(true)}>Statistics</Button>
      </div>

      {ctrl.toast && (
        <p role="status" className={`fixed inset-x-4 bottom-6 z-[70] mx-auto max-w-sm rounded-2xl px-4 py-2 text-center shadow-lg ${TOAST_STYLE[ctrl.toast.tone]}`}>
          {ctrl.toast.text}
        </p>
      )}

      <Modal open={joinOpen} onClose={() => { setJoinOpen(false); clearInvite(); }} title="Join a room">
        <form className="space-y-3" onSubmit={join}>
          <TextField
            label="Room code" value={code} maxLength={6} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="ABC234"
            className="text-center font-marker text-3xl tracking-[0.3em]" onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          />
          <TextField label="Your name" value={prefs.name} maxLength={16} placeholder="e.g. Kofi" onChange={(e) => updatePrefs({ name: e.target.value })} />
          <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>{busy ? 'Joining…' : 'Join the board'}</Button>
        </form>
      </Modal>
      <HowToPlay open={howOpen} onClose={() => setHowOpen(false)} />
      <StatsDialog open={statsOpen} onClose={() => setStatsOpen(false)} />
    </main>
  );
}
