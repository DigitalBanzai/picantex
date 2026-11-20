// Ricompone l'immagine di una cattura a partire dai suoi fotogrammi. In un file a sé perché la
// usano l'editor, il service worker (le catture a tappe, vedi background.js) e le prove automatiche
// (che controllano l'immagine pixel per pixel).

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Una tela: nelle pagine un <canvas>, nel service worker (che non ha documento) una OffscreenCanvas
function newCanvas(width = 1, height = 1) {
  if (typeof document === 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Ricompone la schermata: un solo fotogramma, oppure più fotogrammi incollati in verticale.
// Le misure della cattura sono in pixel CSS della pagina; quelle dei fotogrammi in pixel reali.
export async function buildBase(capture) {
  const scale = capture.dpr || 1;
  const px = (value) => Math.round(value * scale);
  const base = newCanvas();
  let baseCtx;
  for (const frame of capture.frames) {
    const bitmap = await createImageBitmap(frame.blob);
    if (!baseCtx) {
      // Senza misure dichiarate l'immagine è larga un fotogramma e finisce dove finisce l'ultimo
      base.width = capture.size ? px(capture.size.w) : bitmap.width;
      base.height = capture.size ? px(capture.size.h) : px(capture.frames.at(-1).y) + bitmap.height;
      baseCtx = base.getContext('2d');
      if (capture.fill) {
        // Colore di sfondo della pagina, sul bianco nel caso sia trasparente
        for (const color of ['#ffffff', capture.fill]) {
          baseCtx.fillStyle = color;
          baseCtx.fillRect(0, 0, base.width, base.height);
        }
      }
    }
    // Quando a scorrere è un riquadro interno, di un fotogramma serve solo la parte indicata da clip
    const { clip } = frame;
    const sx = clip ? px(clip.x) : 0;
    const sy = clip ? px(clip.y) : 0;
    const sw = clip ? px(clip.x + clip.w) - sx : bitmap.width;
    const sh = clip ? px(clip.y + clip.h) - sy : bitmap.height;
    baseCtx.drawImage(bitmap, sx, sy, sw, sh, px(frame.x || 0), px(frame.y), sw, sh);
    bitmap.close();
  }
  if (!capture.rect) return base;

  // Cattura di una selezione: resta solo il rettangolo tracciato sulla pagina
  const x = clamp(Math.round(capture.rect.x * scale), 0, base.width - 1);
  const y = clamp(Math.round(capture.rect.y * scale), 0, base.height - 1);
  const cut = newCanvas(clamp(Math.round(capture.rect.w * scale), 1, base.width - x), clamp(Math.round(capture.rect.h * scale), 1, base.height - y));
  cut.getContext('2d').drawImage(base, -x, -y);
  return cut;
}
