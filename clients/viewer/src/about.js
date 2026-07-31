/**
 * The About / credits panel.
 *
 * Attribution is a licence obligation for the CC-licensed assets, not a
 * courtesy, so this panel is built from the same data as the README and is
 * reachable from the running app (spec section 11: README, in-app credits, and
 * asset metadata).
 */

import { t, getLang } from '@scahn/protocol/i18n';
import { HOW_IT_WORKS, MODELS_CREDITS, TOOLS_CREDITS } from './credits.js';

/**
 * Pick the field for the current language when one exists, else the English.
 *
 * Long-form prose is carried as `usedKo`, `pFr`, ... beside the English field
 * rather than in the string catalogue, because it is per-credit content, not UI
 * chrome. A missing translation falls back to English rather than blanking:
 * these are licence notes, and an empty licence note is worse than an
 * untranslated one.
 */
const L = (obj, key) => {
  const lang = getLang();
  if (lang === 'en') return obj[key];
  const suffixed = key + lang[0].toUpperCase() + lang.slice(1);
  return obj[suffixed] ?? obj[key];
};

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
    <span class="meta">${esc(t('about.by'))} ${author} — ${esc(L(m, 'used'))}</span>
    ${L(m, 'note') ? `<span class="note">${esc(L(m, 'note'))}</span>` : ''}
  </p>`;
}

export function initAbout() {
  const modal = document.getElementById('about');
  const body = document.getElementById('about-body');
  const needsReview = MODELS_CREDITS.filter((m) => m.status !== 'ok');

  body.innerHTML = `
    <h2>Scahn</h2>
    <p>${esc(t('about.intro'))}</p>

    <p class="lic-warn"><b>${esc(t('about.prealphaWarn'))}</b>
    ${esc(t('about.prealphaWarnBody'))}</p>

    <h3>${esc(t('about.how'))}</h3>
    ${HOW_IT_WORKS.map((s) => `<h4>${esc(L(s, 'h'))}</h4><p>${esc(L(s, 'p'))}</p>`).join('')}

    <h3>${esc(t('about.models3d'))}</h3>
    ${MODELS_CREDITS.map(creditHtml).join('')}
    ${needsReview.length ? `<p class="lic-warn"><b>${esc(t('about.licenceReview'))}</b>
      ${esc(t('about.licenceReviewBody',
        { n: needsReview.length, total: MODELS_CREDITS.length }))}</p>` : ''}

    <h3>${esc(t('about.software'))}</h3>
    ${TOOLS_CREDITS.map((t) => `<p class="tool">${link(t.url, t.name)}
      <span class="meta">(${esc(t.licence)}) — ${esc(t.used)}</span></p>`).join('')}

    <h3>${esc(t('about.source'))}</h3>
    <p>${link('https://github.com/robbie-med/scahn', 'github.com/robbie-med/scahn')}
    ${esc(t('about.sourceNote'))}</p>
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
