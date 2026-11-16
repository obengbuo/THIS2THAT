import type { ClientSocketMessage, ServerSocketMessage, Session } from '@ftt/shared-types';
import { wsBase } from './api';

export type LinkStatus = 'connecting' | 'online' | 'reconnecting';

/** Self-healing room socket: reconnects with backoff and re-syncs state on every open. */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private session: Session,
    private onMessage: (msg: ServerSocketMessage) => void,
    private onStatus: (status: LinkStatus) => void,
  ) {
    this.open();
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
  }

  private wake = () => {
    if (this.closed || document.visibilityState === 'hidden') return;
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
      this.retry = 0;
      this.open();
    }
  };

  private open() {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    const { code, playerId, token } = this.session;
    const url = `${wsBase()}?code=${code}&playerId=${encodeURIComponent(playerId)}&token=${encodeURIComponent(token)}`;
    const ws = (this.ws = new WebSocket(url));
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('online');
      this.send({ type: 'hello' });
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 25_000);
    };
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(String(ev.data)));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.onStatus('reconnecting');
      const delay = Math.min(10_000, 500 * 2 ** this.retry++) + Math.random() * 300;
      this.timer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => ws.close();
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientSocketMessage) {
    if (this.isOpen) this.ws!.send(JSON.stringify(msg));
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
    this.ws?.close();
  }
}
