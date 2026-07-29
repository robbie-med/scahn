/**
 * The About / credits panel.
 *
 * Attribution is a licence obligation for the CC-licensed assets, not a
 * courtesy, so this panel is built from the same data as the README and is
 * reachable from the running app (spec section 11: README, in-app credits, and
 * asset metadata).
 */

import { HOW_IT_WORKS, MODELS_CREDITS, TOOLS_CREDITS } from './credits.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const link = (url, text) =>
  url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text ?? url)}</a>` : esc(text ?? '');

function creditHtml(m) {
  const cls = m.status === 'ok' ? '' : m.status;
  const author = m.authorUrl ? link(m.authorUrl, m.author) : esc(m.author);
  const licence = m.licenceUrl ? link(m.licenceUrl, m.licence) : esc(m.licence);
  return `<p class="credit">
    <span class="t">${m.source ? link(m.source, m.title) : esc(m.title)}</span>
    <span class="badge-lic ${cls}">${licence}</span><br>
    <span class="meta">by ${author} — ${esc(m.used)}</span>
    ${m.note ? `<span class="note">${esc(m.note)}</span>` : ''}
  </p>`;
}

export function initAbout() {
  const modal = document.getElementById('about');
  const body = document.getElementById('about-body');
  const needsReview = MODELS_CREDITS.filter((m) => m.status !== 'ok');

  body.innerHTML = `
    <h2>Scahn</h2>
    <p>A teaching tool for ultrasound scanning technique. A phone acts as the
    probe; this screen shows the anatomy being cut and the cross-section that
    cut corresponds to, side by side.</p>

    <p class="lic-warn"><b>Pre-alpha.</b> Organ shapes and positions are
    approximate, window presets have not been clinically reviewed, and there is
    no acoustic simulation. Not for anatomy or clinical instruction.</p>

    <h3>How it works</h3>
    ${HOW_IT_WORKS.map((s) => `<h4>${esc(s.h)}</h4><p>${esc(s.p)}</p>`).join('')}

    <h3>3D models</h3>
    ${MODELS_CREDITS.map(creditHtml).join('')}
    ${needsReview.length ? `<p class="lic-warn"><b>Licence review outstanding.</b>
      ${needsReview.length} of ${MODELS_CREDITS.length} models are not cleared for
      publication in the form used here — see the notes above.</p>` : ''}

    <h3>Software</h3>
    ${TOOLS_CREDITS.map((t) => `<p class="tool">${link(t.url, t.name)}
      <span class="meta">(${esc(t.licence)}) — ${esc(t.used)}</span></p>`).join('')}

    <h3>Source</h3>
    <p>${link('https://github.com/robbie-med/scahn', 'github.com/robbie-med/scahn')}
    — application code is MIT. Model licences are listed above and are separate.</p>
  `;

  const open = () => modal.classList.remove('hidden');
  const close = () => modal.classList.add('hidden');

  document.getElementById('about-btn').addEventListener('click', open);
  document.getElementById('about-close').addEventListener('click', close);
  // Click-outside and Escape, so the panel never traps a projected display.
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });
}
