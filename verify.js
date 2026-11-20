// Strumenti di verifica: l'impronta SHA-256 dei file salvati e il timbro con l'origine e l'ora
// dell'immagine. Si accendono dalla tendina con lo scudo, nell'editor (impostazione «verify»). Spenti, Picantex non scrive
// nei file nulla su da dove vengono: chi condivide una schermata non deve rivelarlo per sbaglio.
import { download } from './export.js';
import { t } from './i18n.js';

export async function verifyEnabled() {
  return (await chrome.storage.local.get('verify')).verify === true;
}

// callback(acceso): quando l'impostazione cambia, anche da un'altra scheda
export function watchVerify(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'verify' in changes) callback(changes.verify.newValue === true);
  });
}

// --- Impronta ---

export async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// --- Timbro ---

// 2026-10-21 18:42:05 UTC+02:00: la stessa forma in ogni lingua, senza ambiguità tra giorno e mese
export function stampTime(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`;
}

// meta: { url, title, captured }. Una cattura ha l'indirizzo della pagina; un file aperto dal computer
// (immagine o pagina di un PDF) ha solo il suo nome, e l'ora è quella in cui è stato aperto.
function stampLines(meta) {
  const when = t(meta.url ? 'stampCaptured' : 'stampOpened', stampTime(meta.captured ?? Date.now()));
  return [meta.url || meta.title || '', `${when} · Picantex`].filter(Boolean);
}

// Il timbro in una riga sola, per le proprietà dei file
export function stampText(meta) {
  return stampLines(meta).join(' · ');
}

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const STAMP_FONT_SIZE = 12; // pixel CSS: nell'immagine diventano unit volte tanti

// Dove si va a capo in una riga troppo lunga: dopo uno spazio o un separatore dell'indirizzo,
// altrimenti dove capita
function wrap(ctx, text, width) {
  const pieces = [];
  let rest = text;
  while (rest) {
    if (ctx.measureText(rest).width <= width) {
      pieces.push(rest);
      break;
    }
    let fit = 1;
    while (fit < rest.length && ctx.measureText(rest.slice(0, fit + 1)).width <= width) fit++;
    const head = rest.slice(0, fit);
    const breakAt = Math.max(head.lastIndexOf(' '), head.lastIndexOf('/'), head.lastIndexOf('?'), head.lastIndexOf('&'));
    const cut = breakAt > fit / 2 ? breakAt + 1 : fit;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  return pieces;
}

// Fascia del timbro per un'immagine larga width pixel, con unit pixel per pixel CSS: si calcola senza
// l'immagine, così il documento la conosce prima di aprire le pagine
export function stampLayout(width, unit, meta) {
  const size = Math.max(10, Math.round(STAMP_FONT_SIZE * unit));
  const pad = Math.round(8 * unit);
  const lineHeight = Math.round(size * 1.45);
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  ctx.font = `${size}px ${FONT}`;
  const lines = stampLines(meta).flatMap((line) => wrap(ctx, line, Math.max(size * 4, width - pad * 2)))
    .map((text, index) => ({ text, width: ctx.measureText(text).width, baseline: pad + Math.round(size * 0.95) + index * lineHeight }));
  return { size, pad, lines, height: pad * 2 + (lines.length - 1) * lineHeight + Math.round(size * 1.25) };
}

// Disegna la fascia sotto l'immagine: restituisce un canvas nuovo, più alto, e non copre nulla
export function drawStamp(image, layout, unit) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height + layout.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  ctx.fillStyle = '#f4f5f7';
  ctx.fillRect(0, image.height, canvas.width, layout.height);
  ctx.fillStyle = '#c9ced6';
  ctx.fillRect(0, image.height, canvas.width, Math.max(1, Math.round(unit)));
  ctx.fillStyle = '#2b2f35';
  ctx.font = `${layout.size}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  for (const line of layout.lines) ctx.fillText(line.text, layout.pad, image.height + line.baseline);
  return canvas;
}

// Le righe del timbro come testo del PDF (vedi pdf.js): si possono cercare e copiare
export function stampWords(layout, top) {
  return layout.lines.map((line) => ({
    t: line.text, x: layout.pad, y: top + line.baseline - layout.size * 0.8, w: line.width, h: layout.size, space: true,
  }));
}

// Immagine e testo dell'editor con il timbro sotto
export function addStamp(image, meta, unit, words) {
  const layout = stampLayout(image.width, unit, meta);
  return {
    canvas: drawStamp(image, layout, unit),
    words: words && [...words, ...stampWords(layout, image.height)],
  };
}

// Le stesse informazioni nelle proprietà del PDF
export function pdfInfo(meta) {
  return { Title: meta.title || '', Subject: stampText(meta), Creator: 'Picantex', Producer: 'Picantex', CreationDate: pdfDate(Date.now()) };
}

export function documentPdfInfo() {
  return { Creator: 'Picantex', Producer: 'Picantex', CreationDate: pdfDate(Date.now()) };
}

// D:20261021184205+02'00'
function pdfDate(ms) {
  const [, date, time, sign, hours, minutes] = stampTime(ms).match(/^(\S+) (\S+) UTC([+-])(\d\d):(\d\d)$/);
  return `D:${date.replace(/-/g, '')}${time.replace(/:/g, '')}${sign}${hours}'${minutes}'`;
}

// --- Proprietà di PNG e JPEG ---

const encoder = new TextEncoder();

// PNG: dei blocchi di testo (iTXt, in UTF-8) subito dopo l'intestazione
// JPEG: un commento (COM) dopo l'intestazione JFIF
export async function embedStamp(blob, format, meta) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (format === 'png') {
    const fields = [['Title', meta.title || ''], ['Description', stampText(meta)], ['Creation Time', stampTime(meta.captured ?? Date.now())], ['Software', 'Picantex']];
    const chunks = fields.filter(([, value]) => value).map(([key, value]) => pngChunk('iTXt', [...encoder.encode(key), 0, 0, 0, 0, 0, ...encoder.encode(value)]));
    const afterHeader = 8 + 8 + readUint32(bytes, 8) + 4; // firma, poi il blocco IHDR con lunghezza, tipo e CRC
    return new Blob([bytes.slice(0, afterHeader), ...chunks, bytes.slice(afterHeader)], { type: blob.type });
  }
  if (format === 'jpeg') {
    const text = encoder.encode([stampText(meta), meta.title].filter(Boolean).join('\n')).slice(0, 65000);
    let at = 2;
    if (bytes[2] === 0xff && bytes[3] === 0xe0) at = 4 + ((bytes[4] << 8) | bytes[5]);
    const length = text.length + 2;
    const comment = new Uint8Array([0xff, 0xfe, length >> 8, length & 0xff, ...text]);
    return new Blob([bytes.slice(0, at), comment, bytes.slice(at)], { type: blob.type });
  }
  return blob;
}

const readUint32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
const uint32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function pngChunk(type, data) {
  const body = [...encoder.encode(type), ...data];
  return new Uint8Array([...uint32(data.length), ...body, ...uint32(crc32(body))]);
}

let crcTable;
function crc32(bytes) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// --- L'impronta nella tendina della verifica ---

// Dopo un salvataggio: il nome del file, la sua impronta e i pulsanti per copiarla o salvarla in un
// file .sha256 da tenere accanto (lo verificano gli strumenti del sistema, per esempio sha256sum -c).
// panel: l'elemento in cui mostrarla (nell'editor, dentro la tendina dello scudo).
export function renderFingerprint(panel, { name, hash, captured, saved }) {
  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  const code = element('code', 'hash', hash);
  const times = [captured && t('fpCaptured', stampTime(captured)), t('fpSaved', stampTime(saved))].filter(Boolean).join(' · ');
  const copy = element('button', 'btn', t('fpCopy'));
  // Un errore, raro, si legge sul pulsante stesso
  const failed = (button) => (error) => { button.textContent = t('errorFailed', error.message); };
  copy.addEventListener('click', () => navigator.clipboard.writeText(hash).then(() => {
    copy.textContent = t('fpCopied');
    setTimeout(() => { copy.textContent = t('fpCopy'); }, 2000);
  }, failed(copy)));
  const save = element('button', 'btn', t('fpSave'));
  save.title = t('fpSaveTitle');
  save.addEventListener('click', () => download(new Blob([`${hash}  ${name}\n`], { type: 'text/plain' }), `${name}.sha256`).catch(failed(save)));
  const actions = element('div', 'actions');
  actions.append(copy, save);
  panel.replaceChildren(element('h2', '', t('fpTitle')), element('p', 'name', name), code, element('p', 'times', times), actions);
  panel.hidden = false;
}
