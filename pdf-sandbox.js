// Lettore dei PDF, in una pagina isolata. È l'unico posto in cui lavora codice non scritto da noi:
// PDF.js di Mozilla (vendor/pdfjs). La pagina è dichiarata "sandbox" nel manifest: non ha le funzioni
// dell'estensione, non vede l'archivio di Picantex e le sue regole (content_security_policy.sandbox)
// le vietano qualsiasi connessione. Riceve un PDF dalla pagina che la contiene (pdf-open.js) e
// restituisce soltanto immagini delle pagine e il loro testo.
import * as pdfjs from './vendor/pdfjs/pdf.min.mjs';

// Una pagina isolata non può avviare un worker: PDF.js lavora qui, senza
pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', document.baseURI).href;

// Pixel massimi di un'immagine di pagina: i fogli giganti (poster, tavole) si disegnano più piccoli
const MAX_PIXELS = 40_000_000;
// Parte del carattere sopra la linea di base, e altezza della riga, rispetto alla grandezza del carattere
const ASCENT = 0.9;
const LINE = 1.15;

let task = null; // apertura del documento in corso o finita: chiudendola si libera la memoria
let doc = null;
const measure = new OffscreenCanvas(1, 1).getContext('2d');

const reply = (data, transfer = []) => parent.postMessage(data, '*', transfer);

async function open({ data, password }) {
  if (task) await task.destroy();
  doc = null;
  // Le opzioni più prudenti: niente codice generato al volo, niente caratteri o tabelle da scaricare
  task = pdfjs.getDocument({
    data, password, isEvalSupported: false, useSystemFonts: true, disableAutoFetch: true, stopAtErrors: false,
  });
  doc = await task.promise;
  const sizes = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const { width, height } = (await doc.getPage(n)).getViewport({ scale: 1 });
    sizes.push({ width, height });
  }
  return { pages: doc.numPages, sizes };
}

// Disegna una pagina. scale: pixel per punto tipografico. text: anche il testo, parola per parola.
async function render({ page: number, scale, text, type = 'image/png' }) {
  const page = await doc.getPage(number);
  const natural = page.getViewport({ scale: 1 });
  const fit = Math.min(scale, Math.sqrt(MAX_PIXELS / (natural.width * natural.height)));
  const viewport = page.getViewport({ scale: fit });
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
  const ctx = canvas.getContext('2d');
  // Sotto la pagina il bianco della carta: alcuni PDF non disegnano lo sfondo
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // L'intento "print" disegna tutto d'un fiato: quello normale aspetta i fotogrammi dello schermo, che
  // in una pagina nascosta (o in una scheda in secondo piano) non arrivano mai. Così la pagina esce
  // anche com'è sulla carta, moduli compresi.
  await page.render({ canvas, viewport, background: '#ffffff', intent: 'print' }).promise;
  const blob = await canvas.convertToBlob(type === 'image/jpeg' ? { type, quality: 0.85 } : { type });
  const words = text ? wordsOf((await page.getTextContent()).items, viewport) : [];
  page.cleanup();
  return { blob, width: canvas.width, height: canvas.height, scale: fit, words };
}

// Il testo della pagina nella forma che usa Picantex per le catture (vedi editor.js): parole con il
// separatore che le precede (s) e il rettangolo che occupano nell'immagine. PDF.js dà pezzi di testo
// con la loro posizione: ogni pezzo si divide in parole, con larghezze in proporzione ai caratteri.
function wordsOf(items, viewport) {
  const words = [];
  let previous = null; // { baseline, right, size } dell'ultimo pezzo
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = pdfjs.Util.transform(viewport.transform, item.transform);
    // Il testo ruotato o inclinato resta fuori: la sua posizione non si descrive con un rettangolo
    if (Math.abs(b) > Math.abs(a) * 0.05 || Math.abs(c) > Math.abs(d) * 0.05 || a <= 0) continue;
    const size = Math.hypot(c, d);
    const width = item.width * viewport.scale;
    if (!(size > 0.5 && width > 0)) continue;

    // Che cosa separa questo pezzo dal precedente: niente, uno spazio, un a capo, una riga vuota
    let separator = '';
    if (previous) {
      const drop = f - previous.baseline;
      if (Math.abs(drop) > previous.size * 0.5) separator = drop > previous.size * 1.8 ? '\n\n' : '\n';
      else if (e - previous.right > size * 0.12 || /^\s/.test(item.str)) separator = ' ';
    }
    measure.font = `${size}px sans-serif`;
    const k = width / Math.max(1, measure.measureText(item.str).width);
    const parts = [...item.str.matchAll(/\S+/g)];
    parts.forEach((part, i) => {
      words.push({
        t: part[0],
        s: i === 0 ? separator : ' ',
        x: e + measure.measureText(item.str.slice(0, part.index)).width * k,
        y: f - size * ASCENT,
        w: measure.measureText(part[0]).width * k,
        h: size * LINE,
      });
    });
    previous = { baseline: f, right: e + width, size };
  }
  return words;
}

// Le richieste arrivano solo dalla pagina che contiene questa, una alla volta, nell'ordine
let queue = Promise.resolve();
window.addEventListener('message', (event) => {
  if (event.source !== parent) return;
  if (event.data?.ping) return reply({ ready: true });
  const { id, action, ...request } = event.data || {};
  const work = { open, render }[action];
  if (typeof id !== 'number' || !work) return;
  queue = queue.then(async () => {
    try {
      reply({ id, result: await work(request) });
    } catch (error) {
      reply({ id, error: error?.name === 'PasswordException' ? `password:${error.code}` : String(error?.message || error) });
    }
  });
});

reply({ ready: true });
