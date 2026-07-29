/**
 * Phone side of the relay link.
 *
 * Reconnect grace is mandatory, not a nicety (spec 7.3). iOS suspends
 * WebSockets whenever Safari backgrounds, and it *will* background — every time
 * someone glances at a notification. Room code and session token live in
 * localStorage and are replayed on reconnect, so control resumes silently.
 * Without this the tool feels broken in a way that has nothing to do with
 * rendering, and the bug reports point at the wrong subsystem.
 */

const key = (room) => `scahn.phone.token.${room}`;

export class SensorLink {
  constructor({ room, name, onJoined, onRoster, onStatus }) {
    this.room = room;
    this.name = name;
    this.onJoined = onJoined ?? (() => {});
    this.onRoster = onRoster ?? (() => {});
    this.onStatus = onStatus ?? (() => {});

    this.id = null;
    this.token = localStorage.getItem(key(room));
    this.ws = null;
    this.retry = 0;
    this.seq = 0;
    this._closed = false;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._ensure();
    });
    window.addEventListener('online', () => this._ensure());
    window.addEventListener('pageshow', () => this._ensure());
  }

  url() {
    // See the matching note in the viewer client: on GitHub Pages the relay is
    // a different origin, baked in at build time.
    const configured = import.meta.env.VITE_SCAHN_WS;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = configured || `${proto}//${location.host}/ws`;
    // See the matching note in the viewer client.
    return `${base}?${new URLSearchParams({ role: 'sensor', room: this.room })}`;
  }

  connect() {
    this._closed = false;
    this._open();
  }

  _ensure() {
    if (this._closed) return;
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) this._open();
  }

  _open() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.onStatus('connecting');

    const ws = new WebSocket(this.url());
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('connected');
      this.send({
        type: 'join',
        role: 'sensor',
        room: this.room,
        name: this.name,
        token: this.token,
      });
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'joined':
          this.id = msg.id;
          this.token = msg.token;
          if (msg.token) localStorage.setItem(key(this.room), msg.token);
          this.onJoined(msg);
          break;
        case 'roster':
          this.onRoster(msg);
          break;
        case 'ping':
          this.send({ type: 'pong', t: msg.t });
          break;
        case 'error':
          this.onStatus(`error: ${msg.code}`);
          if (msg.code === 'no_such_room') {
            // Stale token for a room that no longer exists.
            localStorage.removeItem(key(this.room));
            this._closed = true;
          }
          break;
      }
    };

    ws.onclose = () => {
      this.onStatus('reconnecting…');
      if (this._closed) return;
      const delay = Math.min(400 * 2 ** this.retry++, 6000);
      setTimeout(() => this._ensure(), delay);
    };

    ws.onerror = () => ws.close();
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(obj) {
    if (this.open) this.ws.send(JSON.stringify(obj));
  }

  claim() {
    this.send({ type: 'claim', id: this.id });
  }

  sendOrient(payload) {
    if (!this.open) return;
    this.ws.send(JSON.stringify({ v: 1, type: 'orient', t: Date.now(), seq: this.seq++, ...payload }));
  }
}
