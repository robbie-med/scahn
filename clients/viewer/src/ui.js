/**
 * Pairing panel, roster, and the debug readout.
 */

import { t } from '@scahn/protocol/i18n';
import qrcode from 'qrcode-generator';

/**
 * The QR encodes the full phone URL *with* the room in the query string, so
 * scanning with the native camera app lands on an already-paired page. We use
 * the OS camera rather than an in-page scanner deliberately: the orientation
 * permission prompt is already one prompt, and a camera prompt from our own
 * origin in the same ten seconds is where people give up.
 */
export function phoneUrl(room) {
  // Trailing slash matters: GitHub Pages serves /phone/ as a real directory
  // index and has no rewrite rule, unlike the Node relay's static handler.
  return `${location.origin}/phone/?room=${room}`;
}

export function renderQr(el, room) {
  const qr = qrcode(0, 'M');
  qr.addData(phoneUrl(room));
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
}

export function renderRoster(el, roster) {
  el.innerHTML = '';
  if (!roster || roster.sensors.length === 0) {
    const p = document.createElement('div');
    p.className = 'sensor';
    p.innerHTML = '<span class="dot"></span><span class="name"></span>';
    p.querySelector('.name').textContent = t('viewer.waitingPhone');
    el.appendChild(p);
    return;
  }
  for (const s of roster.sensors) {
    const row = document.createElement('div');
    row.className = `sensor${s.active ? ' active' : ''}`;
    const rtt = s.rtt == null ? '' : `${s.rtt} ms`;
    row.innerHTML = `<span class="dot"></span><span class="name"></span><span class="rtt"></span>`;
    row.querySelector('.name').textContent = s.name + (s.active ? ` — ${t('viewer.driving')}` : '');
    row.querySelector('.rtt').textContent = rtt;
    el.appendChild(row);
  }
}

export class Stats {
  constructor(dl) {
    this.dl = dl;
    this.rows = new Map();
    this.frames = 0;
    this.lastFpsAt = performance.now();
    this.fps = 0;

    this.lastSeq = null;
    this.dropped = 0;
    this.received = 0;
    this.latency = null;
  }

  /** Called for every inbound orientation frame. */
  noteOrient(msg) {
    this.received++;
    if (this.lastSeq != null && msg.seq > this.lastSeq + 1) {
      this.dropped += msg.seq - this.lastSeq - 1;
    }
    this.lastSeq = msg.seq;
    if (typeof msg.t === 'number') {
      // Sender-clock latency. Phone and viewer clocks are not synchronised, so
      // the ABSOLUTE number is meaningless — only its drift over a session is
      // informative. Labelled accordingly rather than quietly lying.
      const d = Date.now() - msg.t;
      this.latency = this.latency == null ? d : this.latency * 0.9 + d * 0.1;
    }
  }

  set(key, value) {
    let dd = this.rows.get(key);
    if (!dd) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      dd = document.createElement('dd');
      this.dl.append(dt, dd);
      this.rows.set(key, dd);
    }
    dd.textContent = value;
  }

  tick() {
    this.frames++;
    const now = performance.now();
    if (now - this.lastFpsAt >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.lastFpsAt));
      this.frames = 0;
      this.lastFpsAt = now;
    }
  }

  render(extra = {}) {
    this.set('fps', this.fps);
    this.set('frames rx', this.received);
    this.set('dropped', this.dropped);
    this.set('skew (uncal.)', this.latency == null ? '—' : `${Math.round(this.latency)} ms`);
    for (const [k, v] of Object.entries(extra)) this.set(k, v);
  }
}
