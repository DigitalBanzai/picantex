// Esportazione: immagine finale, conversione nel formato scelto e download.
import { t } from './i18n.js';
import { POINTS_PER_CSS_PIXEL, canvasToPdf } from './pdf.js';
import { drawScene } from './shapes.js';

const JPEG_QUALITY = 0.92;

// Disegna schermata e annotazioni su un canvas nuovo, limitato all'area di ritaglio
export function compose({ base, objects, crop }) {
  const canvas = document.createElement('canvas');
  canvas.width = crop.w;
  canvas.height = crop.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.translate(-crop.x, -crop.y);
  drawScene(ctx, base, objects);
  return canvas;
}

// format: 'png' | 'jpeg' | 'pdf'; unit: pixel dell'immagine per pixel CSS della pagina;
// words: il testo che vi si legge, che nel PDF diventa cercabile (vedi pdf.js); info: le proprietà del PDF
export async function encode(canvas, format, unit = 1, words = undefined, info = undefined) {
  if (format === 'pdf') return canvasToPdf(canvas, unit / POINTS_PER_CSS_PIXEL, words, info);
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
  if (!blob) throw new Error(t('errorTooLarge'));
  return blob;
}

// Data e ora di adesso nella forma usata nei nomi dei file: 2026-10-11_15-30-00
export function timeStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${date}_${time}`;
}

// Nome proposto nella finestra di salvataggio. url: l'indirizzo della pagina, solo con gli strumenti di
// verifica accesi, e allora il nome dice anche il sito. Spenti, il nome non rivela da dove viene l'immagine.
export function buildFileName(format, url = '') {
  let host = '';
  try {
    if (url) host = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '');
  } catch {
    // Pagina senza indirizzo utilizzabile: il nome resta senza sito
  }
  const extension = format === 'jpeg' ? 'jpg' : format;
  return `screenshot_${host ? `${host}_` : ''}${timeStamp()}.${extension}`;
}

// Chiede sempre all'utente dove salvare. Risolve con il nome del file scritto, che l'utente può aver
// cambiato nella finestra di salvataggio, oppure false se ha annullato.
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    let settled = false;
    let downloadId;
    // state ed error sono quelli di chrome.downloads: 'complete', 'interrupted', 'USER_CANCELED'...
    const settle = (state, error) => {
      if (settled || state === 'in_progress') return;
      settled = true;
      URL.revokeObjectURL(url);
      if (state === 'complete') {
        chrome.downloads.search({ id: downloadId }, ([item]) => resolve(item?.filename.split(/[\\/]/).pop() || filename));
      } else if (/cancel/i.test(error)) resolve(false);
      else reject(new Error(error || t('errorDownload')));
    };

    chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
      downloadId = id;
      if (id === undefined) return settle('interrupted', chrome.runtime.lastError?.message);
      chrome.downloads.onChanged.addListener(function onChanged(delta) {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current !== 'in_progress') chrome.downloads.onChanged.removeListener(onChanged);
        settle(delta.state.current, delta.error?.current);
      });
      // Nel caso il download sia già finito prima che l'ascolto fosse attivo
      chrome.downloads.search({ id }, ([item]) => item && settle(item.state, item.error));
    });
  });
}
