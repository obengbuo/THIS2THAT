import type { GameView } from '@ftt/shared-types';

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const inviteLink = (code: string) => `${window.location.origin}${window.location.pathname}?room=${code}`;

export function resultSummary(game: GameView): string {
  const r = game.result;
  const ladder = [game.start, ...game.slots.map((s) => s.word ?? '????'), game.target].join(' → ');
  const who = game.players.length > 1 ? `${game.players.map((p) => p.name).join(' + ')} got` : 'I got';
  return [
    `FROM THIS TO THAT ✍️`,
    `${who} from ${game.start} to ${game.target}!`,
    ladder,
    r ? `⏱ ${formatTime(r.elapsedMs)} · 💡 ${r.hintsUsed} hints · ❌ ${r.wrongAttempts} misses · ⭐ ${r.score}` : '',
  ].filter(Boolean).join('\n');
}

/** Uses the native share sheet when there is one, otherwise copies to the clipboard. */
export async function share(data: { title: string; text: string; url?: string }): Promise<'shared' | 'copied' | 'failed'> {
  try {
    if (navigator.share) {
      await navigator.share(data);
      return 'shared';
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return 'shared';
  }
  try {
    await navigator.clipboard.writeText([data.text, data.url].filter(Boolean).join('\n'));
    return 'copied';
  } catch {
    return 'failed';
  }
}
