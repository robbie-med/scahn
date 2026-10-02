/**
 * Save the current frame as a PNG for a slide deck. ROADMAP Part A3.
 *
 * Composition: the WebGL canvas (both viewports, or the panel alone),
 * copied right after a synchronous render so no `preserveDrawingBuffer` is
 * needed; the panel's SVG overlay rasterised on top (mask, graticule,
 * calipers, FROZEN tag); then a burned-in footer with the window,
 * transducer and depth, the model's attribution line (a screenshot is a
 * redistribution, and attribution is a licence obligation), the date and the
 * pre-alpha notice. Nothing leaves the browser: the PNG is a Blob download.
 */

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas     the WebGL canvas
 * @param {SVGSVGElement} o.svg            the panel overlay
 * @param {{x:number,y:number,w:number,h:number}} o.rect2d   panel rect, CSS px
 * @param {{x:number,y:number,w:number,h:number}} o.rect3d   3D rect, CSS px
 * @param {boolean} o.panelOnly
 * @param {string[]} o.footer              lines of text
 * @param {string} o.filename
 */
export async function saveImage({ canvas, svg, rect2d, rect3d, panelOnly, footer, filename }) {
  const dpr = window.devicePixelRatio || 1;
  // Source region in CSS px: the panel alone, or the union of both viewports.
  const region = panelOnly ? rect2d : {
    x: Math.min(rect2d.x, rect3d.x),
    y: Math.min(rect2d.y, rect3d.y),
    w: Math.max(rect2d.x + rect2d.w, rect3d.x + rect3d.w) - Math.min(rect2d.x, rect3d.x),
    h: Math.max(rect2d.y + rect2d.h, rect3d.y + rect3d.h) - Math.min(rect2d.y, rect3d.y),
  };
  const footerH = 14 * footer.length + 16;
  const out = document.createElement('canvas');
  out.width = Math.round(region.w * dpr);
  out.height = Math.round((region.h + footerH) * dpr);
  const ctx = out.getContext('2d');
  ctx.scale(dpr, dpr);

  // The canvas's backing store is window-sized at `dpr`; copy the region.
  const sx = region.x * (canvas.width / canvas.clientWidth);
  const sy = region.y * (canvas.height / canvas.clientHeight);
  const sw = region.w * (canvas.width / canvas.clientWidth);
  const sh = region.h * (canvas.height / canvas.clientHeight);
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, region.w, region.h);

  // Overlay: serialise the SVG with explicit size so it rasterises.
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(rect2d.w));
  clone.setAttribute('height', String(rect2d.h));
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    ctx.drawImage(img, rect2d.x - region.x, rect2d.y - region.y, rect2d.w, rect2d.h);
  } finally {
    URL.revokeObjectURL(url);
  }

  // Footer.
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, region.h, region.w, footerH);
  ctx.fillStyle = '#8b98a8';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  footer.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? '#e8eef5' : '#8b98a8';
    ctx.fillText(line, 12, region.h + 8 + 14 * i, region.w - 24);
  });

  const png = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(png);
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return png;
}

/** `scahn-<window>-<yyyymmdd-hhmm>.png` */
export function imageFilename(windowSlug) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `scahn-${(windowSlug || 'free').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}-${stamp}.png`;
}
