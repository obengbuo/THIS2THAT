'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyLocks, backspace as eraseLetter, createBoard, firstOpenSlot, resetDrafts, setDraft, typeLetter, undo as undoDraft, type Board } from '@ftt/game-engine/board';
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
interface Peer {
  drafts: Record<number, string>;
  focus: number | null;
}

let nonce = 0;
const roundKey = (g: GameView) => `${g.code}:${g.round}`;

/**
 * All client game state. The server is the source of truth for locked words; this hook
 * layers local drafts (Board) on top and keeps both in sync over HTTP + WebSocket.
 */
export function useGame() {
  const [session, setSession] = useState<Session | null>(null);
  const [game, setGame] = useState<GameView | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rejected, setRejected] = useState<{ slot: number; nonce: number } | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [peer, setPeer] = useState<Peer>({ drafts: {}, focus: null });
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
      const before = prev.slots.filter((s) => s.word).length;
      const after = view.slots.filter((s) => s.word).length;
      if (view.status === 'completed' && prev.status !== 'completed') sound.win();
      else if (after > before) sound.lock();
      if (view.players.length > prev.players.length) sound.partner();
    } else if (prev && sameRoom) sound.wipe();

    latest.current = view;
    setClockOffset(view.serverNow - Date.now());
    setGame(view);
    const words = view.slots.map((s) => s.word);
    setBoard((b) => (newRound || !b ? applyLocks(createBoard(view.length, view.slots.length), words) : applyLocks(b, words)));
    if (newRound) {
      setPeer({ drafts: {}, focus: null });
      setHighlight(null);
      setRejected(null);
      setSelected(null);
    } else
      setPeer((p) => {
        const drafts = { ...p.drafts };
        words.forEach((w, i) => w && delete drafts[i]);
        return { ...p, drafts };
      });
  }, []);

  // Keep the cursor on an open slot.
  useEffect(() => {
    if (!board) return;
    if (selected === null || board.slots[selected]?.locked) setSelected(firstOpenSlot(board, (selected ?? -1) + 1));
  }, [board, selected]);

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
    setBoard(null);
    setSelected(null);
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
        else if (msg.event?.kind === 'rejected' && msg.event.playerId !== me) setRejected({ slot: msg.event.slot, nonce: ++nonce });
      } else if (msg.type === 'draft') setPeer((p) => ({ ...p, drafts: { ...p.drafts, [msg.slot]: msg.text } }));
      else if (msg.type === 'focus') setPeer((p) => ({ ...p, focus: msg.slot }));
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

  // Share my handwriting and cursor with my partner as I write.
  const myDraft = selected !== null && board && !board.slots[selected]?.locked ? board.slots[selected]!.text : '';
  useEffect(() => {
    if (live && selected !== null) socketRef.current?.send({ type: 'draft', slot: selected, text: myDraft });
  }, [live, selected, myDraft, link]);
  useEffect(() => {
    if (live) socketRef.current?.send({ type: 'focus', slot: selected });
  }, [live, selected, link]);

  const addReaction = (emoji: string, mine: boolean) => {
    const id = ++nonce;
    setReactions((r) => [...r.slice(-11), { id, emoji, mine }]);
    setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), 2600);
  };

  const me = session?.playerId ?? null;
  const canPlay = !!game && game.status === 'playing' && (!game.turnBased || game.mode === 'pass' || game.turn === me);

  const fail = useCallback((err: unknown) => {
    const message = err instanceof ApiClientError ? err.message : 'Something went wrong.';
    notify(message, 'error');
    if (err instanceof ApiClientError && err.status === 404) leave();
    else if (err instanceof ApiClientError && err.code === 'not_your_turn' && sessionRef.current) void api.get(sessionRef.current).then(applyView).catch(() => {});
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
    select(slot: number) {
      if (board && !board.slots[slot]?.locked) setSelected(slot);
    },
    type(letter: string) {
      if (!canPlay || selected === null) return;
      sound.key();
      setBoard((b) => (b ? typeLetter(b, selected, letter) : b));
    },
    backspace() {
      if (!canPlay || selected === null) return;
      sound.erase();
      setBoard((b) => (b ? eraseLetter(b, selected) : b));
    },
    undo() {
      setBoard((b) => (b ? undoDraft(b) : b));
    },
    reset() {
      sound.erase();
      setBoard((b) => (b ? resetDrafts(b) : b));
      notify('Drafts wiped. Locked words stay on the board.', 'info');
    },
    async submit() {
      const s = sessionRef.current;
      const g = latest.current;
      if (!s || !g || !board || selected === null || busy) return;
      if (!canPlay) return void notify(g.status === 'completed' ? 'This puzzle is done — start a new game!' : "Hang on — it's not your turn.", 'info');
      const slot = selected;
      const word = board.slots[slot]!.text;
      if (word.length !== g.length) {
        setRejected({ slot, nonce: ++nonce });
        return void notify(`Write all ${g.length} letters first.`, 'error');
      }
      setBusy(true);
      try {
        const res = await api.submit(s, slot, word);
        applyView(res.game);
        if (res.accepted) setHighlight((h) => (h === slot ? null : h));
        else {
          sound.error();
          setRejected({ slot, nonce: ++nonce });
          notify(res.code === 'slot_locked' ? 'Your partner just locked that one!' : res.message, 'error');
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
        const slot = type === 'next' ? undefined : selected ?? undefined;
        const { hint, game: view } = await api.hint(s, type, slot);
        applyView(view);
        sound.hint();
        setSelected(hint.slot);
        if (hint.type === 'next') {
          setHighlight(hint.slot);
          notify(hint.message, 'hint', 5000);
        } else if (hint.type === 'word') {
          setBoard((b) => (b ? setDraft(b, hint.slot, hint.word) : b));
          notify(`Try ${hint.word} — press Check to lock it in.`, 'hint', 5000);
        } else notify(`Letter ${hint.index + 1} is ${hint.letter}.`, 'hint', 4000);
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
  }), [applyView, board, busy, canPlay, enter, fail, leave, notify, selected]);

  return { session, game, board, selected, busy, loading, rejected, highlight, toast, peer, reactions, link, clockOffset, canPlay, me, actions };
}

export type GameController = ReturnType<typeof useGame>;
