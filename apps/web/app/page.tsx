'use client';

import { MotionConfig } from 'motion/react';
import { useEffect, useState } from 'react';
import { Game } from '@/components/Game';
import { Home } from '@/components/Home';
import { setSoundEnabled } from '@/lib/sound';
import { DEFAULT_PREFS, loadPrefs, savePrefs, type Prefs } from '@/lib/storage';
import { useGame } from '@/lib/useGame';

export default function Page() {
  const ctrl = useGame();
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = loadPrefs();
    setPrefs(stored);
    setSoundEnabled(stored.sound);
    setReady(true);
  }, []);

  const updatePrefs = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      setSoundEnabled(next.sound);
      return next;
    });

  return (
    <MotionConfig reducedMotion="user">
      {!ready || ctrl.loading ? (
        <main className="grid h-dvh place-items-center">
          <p className="font-title text-2xl text-ink-soft">FROM THIS TO THAT</p>
        </main>
      ) : ctrl.game && ctrl.board && ctrl.session ? (
        <Game ctrl={ctrl} prefs={prefs} updatePrefs={updatePrefs} />
      ) : (
        <Home ctrl={ctrl} prefs={prefs} updatePrefs={updatePrefs} />
      )}
    </MotionConfig>
  );
}
