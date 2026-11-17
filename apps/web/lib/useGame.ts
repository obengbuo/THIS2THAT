'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { changedAt, clearDraft, moveCursor, newDraft, setWord, typeLetter, type Draft } from '@ftt/game-engine/board';
import type { CreateGameRequest, Difficulty, GameView, HintType, ServerSocketMessage, Session, WordLength } from '@ftt/shared-types';
import { api, ApiClientError } from './api';
import { RoomSocket, type LinkStatus } from './socket';
import { sound } from './sound';
import { deviceId, loadSession, saveSession } from './storage';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success' | 'hint';
}
export interface FloatingReaction {
  id: number;
  emoji: string;
  mine: boolean;
}
/** What my partner is writing right now (valid only while `after` matches the board). */
export interface PeerDraft {
  after: number;
  text: string;
  cursor: number;
}

let nonce = 0;
const roundKey = (g: GameView) => `${g.code}:${g.round}`;
/** The word the next move changes: the last one on the board. */
export const currentWord = (g: GameView) => g.chain.at(-1)?.word ?? g.start;

/**
 * All client game state. The server is the source of truth for the words on the board;
 * this hook layers the local draft of the next move on top and keeps both in sync over
 * HTTP + WebSocket.
 */
export function useGame() {
  const [session, setSession] = useState<Session | null>(null);
  const [game, setGame] = useState<GameView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  /** Bumps whenever a move is refused, so the board can shake. */
  const [rejected, setRejected] = useState(0);
  /** Letter position a hint is pointing at. */
  const [highlight, setHighlight] = useState<number | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [peer, setPeer] = useState<PeerDraft | null>(null);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [link, setLink] = useState<LinkStatus>('connecting');
  const [clockOffset, setClockOffset] = useState(0);

  const latest = useRef<GameView | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const socketRef = useRef<RoomSocket | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((text: string, tone: Toast['tone'] = 'info', ms = 3200) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ id: ++nonce, text, tone });
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  /** Applies an authoritative view, ignoring anything older than what we already have. */
  const applyView = useCallback((view: GameView) => {
    const prev = latest.current;
    const sameRoom = prev?.code === view.code;
    if (sameRoom && (view.round < prev!.round || (view.round === prev!.round && view.version < prev!.version))) return;
    const newRound = !prev || !sameRoom || roundKey(prev) !== roundKey(view);

    // Sounds for things that changed (covers both my own moves and my partner's).
    if (prev && !newRound) {
      if (view.status === 'completed' && prev.status !== 'completed') sound.win();
      else if (view.chain.length > prev.chain.length) sound.lock();
      else if (view.chain.length < prev.chain.length) sound.erase();
      if (view.players.length > prev.players.length) sound.partner();
    } else if (prev && sameRoom) sound.wipe();

    latest.current = view;
    setClockOffset(view.serverNow - Date.now());
    setGame(view);
    // The draft always starts from the last word on the board.
    const base = currentWord(view);
    setDraft((d) => (!d || newRound || d.base !== base ? newDraft(base, newRound ? 0 : d?.cursor ?? 0) : d));
    if (newRound || !prev || currentWord(prev) !== base) setHighlight(null);
    if (newRound) setRejected(0);
    setPeer((p) => (p && !newRound && p.after === view.chain.length ? p : null));
  }, []);

  const enter = useCallback((next: Session, view: GameView) => {
    sessionRef.current = next;
    latest.current = null;
    saveSession(next);
    setSession(next);
    applyView(view);
  }, [applyView]);

  const leave = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    sessionRef.current = null;
    latest.current = null;
    saveSession(null);
    setSession(null);
    setGame(null);
    setDraft(null);
    setPeer(null);
    setReactions([]);
  }, []);

  // Resume a game after a refresh or a dropped connection.
  useEffect(() => {
    const saved = loadSession();
    if (!saved) return void setLoading(false);
    api.get(saved)
      .then((view) => enter(saved, view))
      .catch((err) => {
        if (err instanceof ApiClientError && [401, 404, 400].includes(err.status)) saveSession(null);
      })
      .finally(() => setLoading(false));
  }, [enter]);

  // Real-time link (couples rooms only).
  const live = game?.mode === 'couples';
  useEffect(() => {
    if (!session || !live) return;
    const onMessage = (msg: ServerSocketMessage) => {
      if (msg.type === 'state') {
        applyView(msg.game);
        const me = sessionRef.current?.playerId;
        if (msg.event?.kind === 'joined' && msg.event.playerId !== me) {
          const name = msg.game.players.find((p) => p.id === (msg.event as { playerId: string }).playerId)?.name;
          notify(`${name ?? 'Your partner'} joined the board 💛`, 'success');
        } else if (msg.event?.kind === 'hint' && msg.event.playerId !== me) notify('Your partner used a hint 💡', 'hint');
        else if (msg.event?.kind === 'rejected' && msg.event.playerId !== me) setRejected(++nonce);
        else if (msg.event?.kind === 'undone' && msg.event.playerId !== me) notify('Your partner took back the last word.', 'info');
      } else if (msg.type === 'draft') setPeer(msg.after === latest.current?.chain.length ? { after: msg.after, text: msg.text, cursor: msg.cursor } : null);
      else if (msg.type === 'reaction') {
        sound.partner();
        addReaction(msg.emoji, false);
      }
    };
    const socket = new RoomSocket(session, onMessage, setLink);
    socketRef.current = socket;
    return () => {
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, live]);

  // Safety net: while the socket is down, poll so the board still converges.
  useEffect(() => {
    if (!session || !live || link === 'online') return;
    const id = setInterval(() => void api.get(session).then(applyView).catch(() => {}), 4000);
    return () => clearInterval(id);
  }, [session, live, link, applyView]);

  const me = session?.playerId ?? null;
  const canPlay = !!game && game.status === 'playing'
    && (game.mode !== 'couples' || (game.players.length > 1 && game.turn === me));

  // Share the letter I am changing with my partner as I write.
  const after = game?.chain.length ?? 0;
  useEffect(() => {
    if (live && canPlay && draft) socketRef.current?.send({ type: 'draft', after, text: draft.text, cursor: draft.cursor });
  }, [live, canPlay, after, draft, link]);

  const addReaction = (emoji: string, mine: boolean) => {
    const id = ++nonce;
    setReactions((r) => [...r.slice(-11), { id, emoji, mine }]);
    setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 2600);
  };

  const fail = useCallback((err: unknown) => {
    const message = err instanceof ApiClientError ? err.message : 'Something went wrong.';
    notify(message, 'error');
    if (err instanceof ApiClientError && err.status === 404) leave();
    else if (err instanceof ApiClientError && ['not_your_turn', 'waiting', 'completed', 'nothing_to_undo'].includes(err.code) && sessionRef.current) void api.get(sessionRef.current).then(applyView).catch(() => {});
  }, [notify, leave, applyView]);

  const actions = useMemo(() => ({
    async start(settings: Omit<CreateGameRequest, 'deviceId'>) {
      setBusy(true);
      try {
        const res = await api.create({ ...settings, deviceId: deviceId() });
        enter(res.session, res.game);
        return true;
      } catch (err) {
        fail(err);
        return false;
      } finally {
        setBusy(false);
      }
    },
    async join(code: string, name: string) {
      setBusy(true);
      try {
        const res = await api.join(code.trim().toUpperCase(), name, deviceId());
        enter(res.session, res.game);
        return true;
      } catch (err) {
        fail(err);
        return false;
      } finally {
        setBusy(false);
      }
    },
    leave,
    /** Chooses which letter of the current word the next keystroke replaces. */
    select(index: number) {
      if (canPlay) setDraft((d) => (d ? moveCursor(d, index) : d));
    },
    move(delta: number) {
      if (canPlay) setDraft((d) => (d ? moveCursor(d, d.cursor + delta) : d));
    },
    type(letter: string) {
      if (!canPlay) return;
      sound.key();
      setDraft((d) => (d ? typeLetter(d, letter) : d));
    },
    /** Puts the current word back the way it was. */
    clear() {
      if (!canPlay) return;
      sound.erase();
      setDraft((d) => (d ? clearDraft(d) : d));
    },
    /** Takes the last word back off the board (for both players). */
    async undo() {
      const s = sessionRef.current;
      if (!s || busy) return;
      setBusy(true);
      try {
        applyView(await api.undo(s));
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    async submit() {
      const s = sessionRef.current;
      const g = latest.current;
      if (!s || !g || !draft || busy) return;
      if (!canPlay)
        return void notify(
          g.status === 'completed' ? 'This puzzle is done. Start a new game!' : g.players.length < 2 ? 'Waiting for your partner to join.' : "Hang on, it's not your turn.",
          'info',
        );
      if (changedAt(draft) === null) {
        setRejected(++nonce);
        return void notify(`Tap a letter of ${draft.base} and change it first.`, 'error');
      }
      setBusy(true);
      try {
        const res = await api.submit(s, draft.text, g.chain.length);
        applyView(res.game);
        if (!res.accepted) {
          sound.error();
          setRejected(++nonce);
          setDraft((d) => (d ? clearDraft(d) : d));
          notify(res.message, 'error');
        }
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    async hint(type: HintType) {
      const s = sessionRef.current;
      if (!s || busy) return;
      setBusy(true);
      try {
        const { hint, game: view } = await api.hint(s, type);
        applyView(view);
        sound.hint();
        setHighlight(hint.index);
        if (hint.type === 'next') {
          setDraft((d) => (d ? moveCursor(d, hint.index) : d));
          notify(hint.message, 'hint', 5000);
        } else if (hint.type === 'word') {
          setDraft((d) => (d ? setWord(d, hint.word) : d));
          notify(`Try ${hint.word}. Press Check to write it.`, 'hint', 5000);
        } else {
          setDraft((d) => (d ? typeLetter(moveCursor(d, hint.index), hint.letter) : d));
          notify(`Put ${hint.letter} in place ${hint.index + 1}.`, 'hint', 5000);
        }
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    async pass() {
      const s = sessionRef.current;
      if (!s) return;
      try {
        applyView(await api.pass(s));
      } catch (err) {
        fail(err);
      }
    },
    async newRound(settings: { length?: WordLength; difficulty?: Difficulty } = {}) {
      const s = sessionRef.current;
      if (!s || busy) return;
      setBusy(true);
      try {
        applyView(await api.newRound(s, settings));
      } catch (err) {
        fail(err);
      } finally {
        setBusy(false);
      }
    },
    react(emoji: string) {
      socketRef.current?.send({ type: 'reaction', emoji });
      addReaction(emoji, true);
    },
    notify,
  }), [applyView, busy, canPlay, draft, enter, fail, leave, notify]);

  return { session, game, draft, busy, loading, rejected, highlight, toast, peer, reactions, link, clockOffset, canPlay, me, actions };
}

export type GameController = ReturnType<typeof useGame>;
