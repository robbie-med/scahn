/**
 * Viewer side of the relay link.
 *
 * The display creates the room (spec 7.2) and keeps it: a closing laptop lid
 * must not force a room full of learners to re-scan, so on reconnect we rejoin
 * the *same* code rather than asking for a new one.
 */

const STORAGE_KEY = 'scahn.viewer.room';

export class ViewerLink {
  constructor({ onCreated, onRoster, onOrient, onMode, onStatus }) {
    this.onCreated = onCreated;
    this.onRoster = onRoster;
    this.onOrient = onOrient;
    this.onMode = onMode;
    this.onStatus = onStatus ?? (() => {});

    this.room = sessionStorage.getItem(STORAGE_KEY) || null;
    this.ws = null;
    this.retry = 0;
    this._closed = false;

    // Safari suspends sockets when the tab backgrounds; re-check on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._ensure();
    });
    window.addEventListener('online', () => this._ensure());
  }

  url() {
    // On GitHub Pages the clients are static and the relay lives elsewhere, so
    // the WS origin is a build-time setting. Falls back to same-origin, which
    // is what the Node relay serves when it hosts the bundles itself.
    const configured = import.meta.env.VITE_SCAHN_WS;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = configured || `${proto}//${location.host}/ws`;
    // Role and room ride in the query string because the Worker must resolve
    // the room's Durable Object *before* the upgrade completes. The Node relay
    // ignores these and reads the create/join frame instead, so one client
    // build works against either backend.
    const q = new URLSearchParams({ role: 'display' });
    if (this.room) q.set('room', this.room);
    return `${base}?${q}`;
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
      // Rejoin an existing room if we have one, else ask for a fresh code.
      if (this.room) this.send({ type: 'join', role: 'display', room: this.room });
      else this.send({ type: 'create' });
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._handle(msg);
    };

    ws.onclose = () => {
      this.onStatus('disconnected');
      if (this._closed) return;
      // Exponential backoff, capped. Reconnecting is normal, not exceptional.
      const delay = Math.min(500 * 2 ** this.retry++, 8000);
      setTimeout(() => this._ensure(), delay);
    };

    ws.onerror = () => ws.close();
  }

  _handle(msg) {
    switch (msg.type) {
      case 'created':
        this.room = msg.room;
        sessionStorage.setItem(STORAGE_KEY, msg.room);
        this.onCreated(msg.room);
        break;
      case 'joined':
        if (msg.room) {
          this.room = msg.room;
          this.onCreated(msg.room);
        }
        break;
      case 'roster':
        this.onRoster(msg);
        break;
      case 'orient':
        this.onOrient(msg);
        break;
      case 'mode':
        this.onMode(msg.mode);
        break;
      case 'ping':
        this.send({ type: 'pong', t: msg.t });
        break;
      case 'error':
        // The room we remembered is gone (relay restarted, or it aged out).
        // Drop it and take a fresh one rather than sitting there dead.
        if (msg.code === 'no_such_room') {
          this.room = null;
          sessionStorage.removeItem(STORAGE_KEY);
          this.send({ type: 'create' });
        }
        break;
    }
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
