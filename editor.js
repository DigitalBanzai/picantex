// Editor: mostra la schermata catturata e gestisce strumenti, ritaglio e salvataggio.
import { addToDocument, drawDocument, printImages, saveDocumentPdf, setupDocument, toggleDocument } from './document.js';
import { buildFileName, compose, download, encode } from './export.js';
import { buildBase } from './frames.js';
import { loadLanguage, localizePage, saveLanguage, t } from './i18n.js';
import {
  LINE_HEIGHT, STEP_STYLES, boundsOf, bubblePad, contrastColor, drawScene, fitBubble, fontOf, nextStepSeq,
  handlesOf, hitTest, inRect, isSegment, layoutText, moveBy, resizeWithHandle, reworksBase,
} from './shapes.js';
import { POINTS_PER_CSS_PIXEL } from './pdf.js';
import { fetchFromTab, isLocalFile, openFileUrl } from './tab-file.js';
import { loadCapture, purgeOldCaptures, saveCapture } from './store.js';
import { addStamp, embedStamp, pdfInfo, renderFingerprint, sha256, verifyEnabled, watchVerify } from './verify.js';
import { openHelp, setupHints } from './hint.js';
const $ = (selector) => document.querySelector(selector);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const stage = $('#stage');
const textEditor = $('#text-editor');
const cropActions = $('#crop-actions');
const menu = $('#context-menu');
const colorInput = $('#color');
const hexInput = $('#hex');
const widthSelect = $('#stroke-width');
const sizeSelect = $('#font-size');
const formatSelect = $('#format');
const languageSelect = $('#language');
const zoomSelect = $('#zoom');
const stepSelect = $('#step-style');
const stepLabelInput = $('#step-label');

// Misure dell'interfaccia, in pixel CSS
const HANDLE_SIZE = 9;
const HIT_TOLERANCE = 6;
const MIN_DRAG = 4; // sotto questa distanza un trascinamento vale come click
const BUBBLE_WIDTH = 180;
const TEXT_TYPES = ['text', 'bubble'];
const FORMATS = ['png', 'jpeg', 'pdf'];
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
const STAGE_PADDING = 24; // margine attorno all'immagine, come in editor.css

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const state = {
  base: null,        // schermata originale (canvas, mai modificata)
  crop: null,        // porzione di schermata mostrata, in pixel immagine
  objects: [],       // annotazioni, in ordine di sovrapposizione
  selected: null,
  editing: null,     // oggetto di cui si sta scrivendo il testo
  pendingCrop: null, // ritaglio tracciato ma non ancora applicato
  text: [],          // parole della pagina catturata, con la loro posizione nell'immagine
  picking: null,     // area di cui si sta scegliendo il testo da copiare
  drag: null,
  tool: 'select',
  toolBeforePicker: 'select', // strumento a cui tornare dopo il contagocce
  unit: 1,           // pixel immagine per pixel CSS della pagina catturata
  ratio: 1,          // pixel immagine per pixel CSS nell'editor, zoom compreso
  pixelRatio: 1,     // lo stesso valore a zoom 100%
  zoom: 1,           // un fattore, oppure 'width' / 'page' per adattare l'immagine alla finestra
  meta: {},
  style: {
    color: '#e53935', highlight: '#ffeb3b', cover: '#111111',
    width: 4, size: 20, bold: false, italic: false,
    // Bollini: stile del contenuto, testo o simbolo (per gli stili che non contano), sottobollino
    stepStyle: 'number', stepLabel: '', stepSub: false,
  },
};

// --- Caricamento ---

async function init() {
  languageSelect.value = await loadLanguage();
  localizePage();
  showVerify(await verifyEnabled());
  await setupDocument({
    ready: () => Boolean(state.base),
    image: () => (commitText(), compose(state)),
    words: () => wordsToExport(),
    openPdf: (file) => openPdf(file, file.name, true),
    docPage: () => state.meta.docPage,
    openPage: (page) => openDocumentPage(page),
    unit: () => state.unit,
    meta: () => state.meta,
    stamp: () => verify && stampOn,
    fingerprint: (details) => showSavedFingerprint(details),
    snapshot: () => history.stack[history.index],
    markSaved: (snapshot) => markSaved(snapshot),
    toast,
    hideToast,
    // Aprendo o chiudendo il pannello cambia lo spazio per l'immagine: va riadattata se è "a misura"
    relayout: () => state.base && typeof state.zoom !== 'number' && resizeCanvas(),
  });

  const params = new URLSearchParams(location.search);
  // L'errore può essere una nostra chiave oppure un messaggio di Chrome, che resta com'è
  if (params.has('error')) return fail(t('errorCapture', t(params.get('error'))));
  // Un'immagine aperta direttamente in una scheda di Chrome: la si riprende da lì, a piena risoluzione
  if (params.has('src')) {
    showOpenPanel();
    return openFromTab(params.get('src'), params.get('name') || '', params.get('tab'));
  }
  // Senza una cattura da mostrare, l'editor si apre vuoto e aspetta un'immagine
  if (!params.has('id')) return showOpenPanel();
  const capture = await loadCapture(params.get('id'));
  if (!capture) return fail(t('errorNotFound'));

  state.base = await buildBase(capture);
  state.text = placeWords(capture);
  // Lo strumento del testo serve solo se nell'immagine è finita almeno una parola
  const frame = { x: 0, y: 0, w: state.base.width, h: state.base.height };
  const textTool = $('[data-tool="pagetext"]');
  if (state.text.some((word) => inRect(centerOf(word), frame))) {
    textTool.disabled = false;
    textTool.dataset.i18nTitle = 'toolPageText';
    textTool.title = t('toolPageText');
  }
  state.pixelRatio = window.devicePixelRatio || 1;
  state.unit = capture.dpr || state.pixelRatio;
  // captured: quando l'immagine è stata catturata o aperta; resta quella anche se passa dal documento
  state.meta = { url: capture.url, title: capture.title, docPage: capture.docPage, captured: capture.captured ?? capture.created };
  state.crop = { x: 0, y: 0, w: state.base.width, h: state.base.height };
  // Un'immagine molto più larga della finestra parte già adattata; le altre a grandezza reale
  state.zoom = fitFactor('width') < 0.8 ? 'width' : 1;
  zoomSelect.value = String(state.zoom);
  updateTitle();

  resizeCanvas();
  commit();
  markSaved(); // la cattura appena aperta non ha ancora nulla da perdere
  setTool('select');
  drawDocument(); // ora c'è un'immagine da poter aggiungere
  // Cattura fermata a metà: si può continuare da dove si è fermata
  const resume = capture.resume && { label: t('resumeCapture'), run: () => resumeCapture(capture.resume) };
  if (capture.long) {
    // Cattura a tappe: le parti sono già nel documento, si può salvare subito il PDF oppure rivederle prima
    toggleDocument(true, false);
    const { parts: count, resumed } = capture.long;
    const parts = resumed && count === 1 ? t('resumedPartsOne') : t(resumed ? 'resumedParts' : 'longCaptureParts', count);
    const text = parts + (capture.note ? ` ${t(capture.note)}` : '');
    toast(text, 120000, [
      resume,
      { label: t('longSaveNow'), run: () => { hideToast(); saveDocumentPdf(); } },
      { label: t('longReview'), run: hideToast },
    ]);
  } else if (resume) toast(t(capture.note), 120000, resume);
  else if (capture.note) toast(t(capture.note), 8000);
  // Foto di un PDF aperto in Chrome: con Picantex se ne avrebbero tutte le pagine e il testo
  if (capture.pdf && capture.url) {
    toast(t('pdfCaptured'), 20000, {
      label: t('pdfOpenIt'),
      run: async () => {
        hideToast();
        const tab = await chrome.tabs.getCurrent();
        chrome.tabs.create({ url: openFileUrl('pdf', capture.url, capture.title, capture.tabId), index: tab.index + 1, openerTabId: tab.id });
      },
    });
  }
}

function updateTitle() {
  if (state.meta.title) document.title = `${state.meta.title} – ${t('editorTitle')}`;
}

function fail(text) {
  $('#canvas-wrap').hidden = true;
  $('#message').textContent = text;
  $('#message').hidden = false;
}

// --- Immagini aperte dall'utente ---

function showOpenPanel() {
  $('#canvas-wrap').hidden = true;
  $('#open-panel').hidden = false;
  syncControls();
  updateButtons();
}

// Apre un'immagine scelta, trascinata o incollata. Segue lo stesso percorso di una cattura:
// viene salvata nell'archivio locale e mostrata dall'editor. Se c'è già un lavoro in corso
// si apre in un'altra scheda, così non va perso nulla.
async function openImage(blob, name = '') {
  if (isPdf(blob, name)) return openPdf(blob, name);
  try {
    (await createImageBitmap(blob)).close();
  } catch {
    return toast(t('errorImage'), 6000);
  }
  const id = crypto.randomUUID();
  await purgeOldCaptures();
  await saveCapture({ id, created: Date.now(), mode: 'image', title: name, url: '', frames: [{ blob, y: 0 }] });
  const url = `editor.html?id=${id}`;
  // Nella stessa scheda resta l'eventuale "#document", così il pannello del documento non si chiude
  if (!state.base) return location.replace(url + location.hash);
  const tab = await chrome.tabs.getCurrent();
  chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
}

// L'immagine di una scheda (vedi tab-file.js): se non si riesce a riprenderla, lo si dice e resta
// l'invito ad aprirla dal computer
async function openFromTab(src, name, tabId) {
  toast(t('imageDownloading'), 60000);
  const isImage = async (file) => {
    try {
      (await createImageBitmap(file)).close();
      return true;
    } catch {
      return false;
    }
  };
  const blob = await fetchFromTab(src, tabId, isImage);
  if (blob) return openImage(blob, name);
  toast(t(isLocalFile(src) ? 'imageLocalHint' : 'imageDownloadFailed', name), 12000);
}

// Riapre nell'editor una pagina del documento, con il suo testo: finite le modifiche, il pannello la
// aggiorna al suo posto (vedi document.js). Con un lavoro già aperto si usa un'altra scheda.
async function openDocumentPage(page) {
  const id = crypto.randomUUID();
  await purgeOldCaptures();
  await saveCapture({
    id, created: Date.now(), captured: page.captured ?? page.created, mode: 'image', title: page.title || '', url: page.url || '', dpr: page.unit,
    frames: [{ blob: page.blob, y: 0 }], text: { scale: 1, words: page.words || [] }, docPage: page.id,
  });
  const url = `editor.html?id=${id}#document`;
  if (!state.base) return location.replace(url);
  const tab = await chrome.tabs.getCurrent();
  chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
}

const isPdf = (file, name = file.name || '') => file.type === 'application/pdf' || /\.pdf$/i.test(name);

// Un PDF si apre nella pagina dei PDF, dove se ne scelgono le pagine. Passa dall'archivio locale come
// una cattura; newTab: in un'altra scheda anche se l'editor è vuoto.
async function openPdf(blob, name = '', newTab = false) {
  const id = crypto.randomUUID();
  await purgeOldCaptures();
  await saveCapture({ id, created: Date.now(), mode: 'pdf', title: name, url: '', blob });
  const url = `pdf-open.html?id=${id}`;
  if (!state.base && !newTab) return location.replace(url);
  const tab = await chrome.tabs.getCurrent();
  chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
}

const fileInput = $('#file-input');
fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  if (file) openImage(file, file.name);
  fileInput.value = '';
});

const carriesFiles = (e) => e.dataTransfer?.types.includes('Files');
window.addEventListener('dragover', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  stage.classList.add('drop');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) stage.classList.remove('drop');
});
window.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  stage.classList.remove('drop');
  const [file] = e.dataTransfer.files;
  if (file) openImage(file, file.name);
});

window.addEventListener('paste', (e) => {
  // Mentre si scrive un testo, o in un campo, incollare resta un'operazione sul testo
  if (state.editing || e.target.closest?.('input, textarea')) return;
  // Negli appunti può esserci un oggetto copiato dall'editor, oppure un'immagine da aprire
  if (state.base && pasteClip(e.clipboardData?.getData(CLIP_TYPE))) return e.preventDefault();
  const item = [...(e.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  openImage(item.getAsFile());
});

// --- Cronologia (annulla / ripeti) ---

const history = { stack: [], index: -1 };

function commit() {
  const snapshot = JSON.stringify({ objects: state.objects, crop: state.crop });
  if (snapshot === history.stack[history.index]) return;
  history.stack.length = history.index + 1;
  history.stack.push(snapshot);
  history.index++;
  updateButtons();
}

// L'ultimo stato messo al sicuro (salvato, o messo nel documento): se quello attuale è diverso, chiudendo
// la scheda Chrome chiede conferma. Le annotazioni non si salvano da sole, e senza conferma si perderebbero.
// snapshot: lo stato preso quando si è composta l'immagine, perché durante il salvataggio si può
// continuare a disegnare, e quei segni non sono al sicuro.
let savedSnapshot = null;
const markSaved = (snapshot = history.stack[history.index]) => {
  savedSnapshot = snapshot;
};
window.addEventListener('beforeunload', (e) => {
  if (state.base && (state.editing || history.stack[history.index] !== savedSnapshot)) e.preventDefault();
});

function travel(step) {
  commitText();
  const snapshot = history.stack[history.index + step];
  if (!snapshot) return;
  history.index += step;
  Object.assign(state, JSON.parse(snapshot), { selected: null, pendingCrop: null });
  resizeCanvas();
  updateButtons();
}

// --- Disegno ---

let renderQueued = false;
let renderWhole = false;

// whole = false ridisegna solo la parte visibile: basta (ed è più veloce) durante i trascinamenti
function requestRender(whole = true) {
  renderWhole ||= whole;
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render(renderWhole);
    renderWhole = false;
  });
}

function render(whole) {
  if (!state.base) return;
  ctx.save();
  if (!whole) {
    const view = visibleArea();
    ctx.beginPath();
    ctx.rect(view.x, view.y, view.w, view.h);
    ctx.clip();
  }
  ctx.translate(-state.crop.x, -state.crop.y);
  drawScene(ctx, state.base, state.objects, state.editing);
  if (state.pendingCrop) drawCropShade(state.pendingCrop);
  if (state.picking) drawPicking(state.picking);
  const framed = state.pendingCrop || (!state.editing && state.selected);
  if (framed) drawFrame(framed);
  ctx.restore();
}

// Parte del canvas che si vede nell'area di lavoro, in pixel del canvas, allargata di un margine
function visibleArea(margin = 200) {
  const c = canvas.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  const k = canvas.width / c.width;
  const x = Math.max(0, Math.floor((s.left - c.left) * k) - margin);
  const y = Math.max(0, Math.floor((s.top - c.top) * k) - margin);
  const right = Math.min(canvas.width, Math.ceil((s.right - c.left) * k) + margin);
  const bottom = Math.min(canvas.height, Math.ceil((s.bottom - c.top) * k) + margin);
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}

// Scurisce tutto ciò che il ritaglio in corso lascerebbe fuori
function drawCropShade(pending) {
  const c = state.crop;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.beginPath();
  ctx.rect(c.x, c.y, c.w, c.h);
  ctx.rect(pending.x, pending.y, pending.w, pending.h);
  ctx.fill('evenodd');
}

// Contorno tratteggiato e maniglie dell'oggetto selezionato (o del ritaglio in corso)
function drawFrame(obj) {
  const k = state.ratio;
  const size = HANDLE_SIZE * k;
  ctx.save();
  ctx.lineWidth = k;
  ctx.strokeStyle = obj.type === 'crop' ? '#ffffff' : '#1a73e8';
  if (!isSegment(obj)) {
    const b = boundsOf(obj);
    // Gli oggetti senza maniglie hanno il contorno un po' staccato
    const gap = handlesOf(obj).length ? 0 : 3 * k;
    ctx.setLineDash([5 * k, 4 * k]);
    ctx.strokeRect(b.x - gap, b.y - gap, b.w + gap * 2, b.h + gap * 2);
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = '#1a73e8';
  ctx.fillStyle = '#ffffff';
  for (const handle of handlesOf(obj)) {
    ctx.fillRect(handle.x - size / 2, handle.y - size / 2, size, size);
    ctx.strokeRect(handle.x - size / 2, handle.y - size / 2, size, size);
  }
  ctx.restore();
}

// Fattore con cui l'immagine entra nell'area di lavoro: in larghezza ('width') o tutta ('page')
function fitFactor(mode) {
  const { crop, pixelRatio } = state;
  const across = (stage.clientWidth - STAGE_PADDING * 2) / (crop.w / pixelRatio);
  const down = (stage.clientHeight - STAGE_PADDING * 2) / (crop.h / pixelRatio);
  return clamp(mode === 'page' ? Math.min(across, down) : across, 0.02, 4);
}

function zoomFactor() {
  return typeof state.zoom === 'number' ? state.zoom : fitFactor(state.zoom);
}

// Adegua il canvas all'area di ritaglio e allo zoom. I pixel restano quelli dell'immagine:
// lo zoom cambia solo la grandezza a schermo, così i comandi non si rimpiccioliscono.
function resizeCanvas() {
  const { crop } = state;
  const zoom = zoomFactor();
  state.ratio = state.pixelRatio / zoom;
  if (canvas.width !== crop.w || canvas.height !== crop.h) {
    canvas.width = crop.w;
    canvas.height = crop.h;
  }
  canvas.style.width = `${crop.w / state.ratio}px`;
  canvas.style.height = `${crop.h / state.ratio}px`;
  $('#size-image').textContent = `${crop.w} × ${crop.h}`;
  $('#size-zoom').textContent = ` · ${Math.round(zoom * 100)}%`;
  updateCropActions();
  if (state.editing) layoutTextEditor();
  render(true);
}

// choice: un fattore, 'width' o 'page'. anchor: evento del mouse il cui punto deve restare fermo.
function setZoom(choice, anchor) {
  if (!state.base) return;
  const view = stage.getBoundingClientRect();
  const x = anchor ? anchor.clientX : view.left + view.width / 2;
  const y = anchor ? anchor.clientY : view.top + view.height / 2;
  const before = canvas.getBoundingClientRect();
  const fx = (x - before.left) / before.width;
  const fy = (y - before.top) / before.height;

  state.zoom = choice;
  zoomSelect.value = String(choice);
  resizeCanvas();

  const after = canvas.getBoundingClientRect();
  stage.scrollLeft += after.left + fx * after.width - x;
  stage.scrollTop += after.top + fy * after.height - y;
}

// Passa alla tappa di zoom successiva (direction > 0) o precedente. Oltre ai livelli fissi sono
// tappe anche i due adattamenti alla finestra: così si può sempre tornare a vedere l'immagine intera.
function stepZoom(direction, anchor) {
  const current = zoomFactor();
  const fits = ['width', 'page'].map((choice) => ({ choice, factor: fitFactor(choice) }));
  // Un livello fisso quasi uguale a un adattamento si salta: sarebbero due tappe per la stessa grandezza
  const levels = ZOOM_LEVELS
    .filter((level) => fits.every((fit) => Math.abs(level / fit.factor - 1) > 0.08))
    .map((level) => ({ choice: level, factor: level }));
  const stops = [...levels, ...fits].sort((a, b) => a.factor - b.factor);
  const next = direction > 0
    ? stops.find((stop) => stop.factor > current * 1.01)
    : stops.findLast((stop) => stop.factor < current * 0.99);
  if (next) setZoom(next.choice, anchor);
}

// --- Oggetti ---

// Diametro della gomma, in base allo spessore scelto
function eraserSize(width) {
  return width * 5;
}

// Lato dei blocchi del mosaico, in base allo spessore scelto
function pixelBlock(width) {
  return Math.max(8, width * 3);
}

function blurRadius(width) {
  return Math.max(6, width * 2);
}

// Lo spessore del menu che dà questa misura (forza di sfocatura o mosaico): quello più vicino
function widthFor(value, measure) {
  const widths = [...widthSelect.options].map((option) => Number(option.value));
  return widths.reduce((best, width) => (Math.abs(measure(width) - value) < Math.abs(measure(best) - value) ? width : best));
}

// sub: un sottobollino anche senza l'interruttore (Maiusc+clic)
function createObject(tool, p, sub = false) {
  const { color, highlight, width, size, bold, italic } = state.style;
  const u = state.unit;
  const rect = { type: tool, x: p.x, y: p.y, w: 0, h: 0 };
  switch (tool) {
    case 'line':
    case 'arrow':
      return { type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width: width * u };
    case 'highlight':
      return { ...rect, color: highlight };
    case 'blur':
      return { ...rect, radius: blurRadius(width) * u };
    case 'pixel':
      return { ...rect, block: pixelBlock(width) * u };
    case 'cover':
      return { ...rect, color: state.style.cover };
    case 'bubble':
      return { ...rect, tx: p.x, ty: p.y, text: '', color, size: size * u, bold, italic };
    case 'step':
      // x, y sono il centro del bollino; il numero dipende dall'ordine in cui i passi sono stati messi (seq, vedi stepLabels)
      return {
        type: tool, x: p.x, y: p.y, color, size: size * u, ...stepContent(), level: sub || state.style.stepSub ? 2 : 1,
        seq: nextStepSeq(state.objects),
      };
    default:
      return { ...rect, color, width: width * u };
  }
}

// Coda del fumetto nella posizione predefinita: in basso a sinistra
function placeTail(obj) {
  obj.tx = Math.round(obj.x + obj.w * 0.25);
  obj.ty = Math.round(obj.y + obj.h + obj.size * 1.6);
}

// Dà forma all'oggetto in base al trascinamento da a fino a b
function shapeFromDrag(obj, a, b, constrain) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (isSegment(obj)) {
    if (constrain) {
      // Blocca la direzione sui multipli di 45°
      const step = Math.PI / 4;
      const angle = Math.round(Math.atan2(dy, dx) / step) * step;
      const length = Math.hypot(dx, dy);
      dx = Math.round(Math.cos(angle) * length);
      dy = Math.round(Math.sin(angle) * length);
    }
    Object.assign(obj, { x1: a.x, y1: a.y, x2: a.x + dx, y2: a.y + dy });
    return;
  }
  if (constrain) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * side;
    dy = Math.sign(dy || 1) * side;
  }
  Object.assign(obj, {
    x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy),
    w: Math.abs(dx), h: Math.abs(dy),
  });
  if (obj.type === 'bubble') placeTail(obj);
}

function removeObject(obj) {
  state.objects = state.objects.filter((o) => o !== obj);
  if (state.selected === obj) select(null);
}

function deleteSelected() {
  if (!state.selected) return;
  removeObject(state.selected);
  commit();
  requestRender();
}

function select(obj) {
  state.selected = obj;
  if (obj) adoptStyle(obj);
  syncControls();
  updateButtons();
  requestRender();
}

// Oggetto più in alto sotto il punto p. Le sfocature stanno sotto a tutto, come nel disegno.
function objectAt(p) {
  const tolerance = HIT_TOLERANCE * state.ratio;
  const hit = (o) => hitTest(o, p, tolerance);
  return state.objects.findLast((o) => !reworksBase(o) && hit(o))
    || state.objects.findLast((o) => reworksBase(o) && hit(o));
}

function handleAt(obj, p) {
  const reach = (HANDLE_SIZE / 2 + 3) * state.ratio;
  return handlesOf(obj).findLast((h) => Math.abs(p.x - h.x) <= reach && Math.abs(p.y - h.y) <= reach);
}

// --- Puntatore ---

// Ultimo evento del puntatore sopra l'immagine; null quando ne è fuori
let pointer = null;

function toImage(e) {
  const rect = canvas.getBoundingClientRect();
  const k = canvas.width / rect.width;
  return {
    x: Math.round((e.clientX - rect.left) * k) + state.crop.x,
    y: Math.round((e.clientY - rect.top) * k) + state.crop.y,
  };
}

function cursorAt(p) {
  const { tool, pendingCrop, selected } = state;
  const target = tool === 'crop' ? pendingCrop : selected;
  const handle = target && handleAt(target, p);
  if (handle) return handle.cursor;
  if (tool === 'crop') return pendingCrop && inRect(p, pendingCrop) ? 'move' : 'crosshair';
  if (tool === 'eraser') return eraserCursor();
  if (tool === 'select') {
    return objectAt(p) || (selected && inRect(p, boundsOf(selected))) ? 'move' : 'default';
  }
  return tool === 'text' ? 'text' : 'crosshair';
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !state.base) return;
  hideMenu();
  // Un click fuori dal testo in corso serve solo a confermarlo
  if (state.editing) return commitText();
  canvas.setPointerCapture(e.pointerId);

  const p = toImage(e);
  const { tool } = state;
  toolFlyout = false;
  syncFlyout();
  if (tool === 'picker') return pickColor(p);
  if (tool === 'eraser' || tool === 'pen') {
    if (tool === 'pen') startStroke(p, state.style.color, state.style.width * state.unit);
    else startErasing(p);
    return requestRender(false);
  }
  if (tool === 'pagetext') {
    state.picking = { type: 'pick', x: p.x, y: p.y, w: 0, h: 0 };
    state.drag = { kind: 'create', obj: state.picking, start: p };
    return requestRender(false);
  }
  // Le maniglie dell'oggetto selezionato restano attive con qualunque strumento
  const target = tool === 'crop' ? state.pendingCrop : state.selected;
  const handle = target && handleAt(target, p);

  if (handle) {
    state.drag = { kind: 'resize', obj: target, handle: handle.id, original: { ...target }, start: p };
  } else if (tool === 'crop') {
    if (target && inRect(p, target)) {
      state.drag = { kind: 'move', obj: target, last: p, start: p };
    } else {
      state.pendingCrop = { type: 'crop', x: p.x, y: p.y, w: 0, h: 0 };
      state.drag = { kind: 'create', obj: state.pendingCrop, start: p };
    }
  } else if (tool === 'select') {
    const inside = state.selected && inRect(p, boundsOf(state.selected));
    const hit = objectAt(p) || (inside ? state.selected : null);
    select(hit);
    if (hit) state.drag = { kind: 'move', obj: hit, last: p, start: p };
  } else if (tool === 'text') {
    const hit = objectAt(p);
    if (hit && TEXT_TYPES.includes(hit.type)) {
      select(hit);
      startTextEdit(hit);
    } else {
      addText(p);
    }
  } else if (tool === 'step') {
    // Il bollino compare subito e si può trascinare al punto giusto prima di rilasciare
    const obj = createObject(tool, p, e.shiftKey);
    state.objects.push(obj);
    select(null);
    state.drag = { kind: 'move', obj, last: p, start: p, isNew: true };
  } else {
    const obj = createObject(tool, p);
    state.objects.push(obj);
    select(null);
    state.drag = { kind: 'create', obj, start: p };
  }
  updateCropActions();
  requestRender();
});

canvas.addEventListener('pointerleave', () => { pointer = null; });

canvas.addEventListener('pointermove', (e) => {
  if (!state.base) return;
  pointer = e;
  const p = toImage(e);
  const { drag } = state;
  if (!drag) {
    // Con il contagocce il riquadro e il campo del codice mostrano in anteprima il colore sotto il puntatore
    if (state.tool === 'picker') {
      colorInput.value = colorAt(p);
      hexInput.value = colorInput.value;
    }
    canvas.style.cursor = cursorAt(p);
    return;
  }
  const { obj } = drag;
  if (drag.kind === 'create') {
    shapeFromDrag(obj, drag.start, p, e.shiftKey);
  } else if (drag.kind === 'resize') {
    resizeWithHandle(obj, drag.handle, p, drag.original);
    if (obj.type === 'bubble') fitBubble(obj);
  } else if (drag.kind === 'draw') {
    const [x, y] = obj.points.at(-1);
    if (x !== p.x || y !== p.y) obj.points.push([p.x, p.y]);
  } else {
    moveBy(obj, p.x - drag.last.x, p.y - drag.last.y);
    drag.last = p;
  }
  if (obj.type === 'crop') clampCrop(obj, drag.kind === 'move');
  requestRender(false);
});

function endDrag(e) {
  const { drag } = state;
  if (!drag) return;
  state.drag = null;
  const { obj } = drag;
  const p = toImage(e);
  const moved = Math.hypot(p.x - drag.start.x, p.y - drag.start.y) >= MIN_DRAG * state.ratio;

  if (obj.type === 'pick') {
    state.picking = null;
    if (moved) copyPageText(obj);
    else toast(t('textHint'));
  } else if (obj.type === 'crop') {
    if (drag.kind === 'create' && !moved) state.pendingCrop = null;
    updateCropActions();
  } else if (drag.kind === 'draw') {
    commit();
  } else if (drag.kind !== 'create') {
    // Un oggetto appena messo va registrato anche se non è stato trascinato
    if (drag.isNew) select(obj);
    if (moved || drag.isNew) commit();
  } else if (obj.type === 'bubble') {
    // Un semplice click crea un fumetto di dimensioni standard
    if (!moved) Object.assign(obj, { x: p.x, y: p.y, w: BUBBLE_WIDTH * state.unit, h: 0 });
    fitBubble(obj);
    placeTail(obj);
    select(obj);
    startTextEdit(obj);
  } else if (moved) {
    select(obj);
    commit();
  } else {
    removeObject(obj);
  }
  requestRender();
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('dblclick', (e) => {
  const hit = state.tool === 'select' && objectAt(toImage(e));
  if (hit && TEXT_TYPES.includes(hit.type)) {
    select(hit);
    startTextEdit(hit);
  }
});

// Ctrl + rotellina (o il pizzico sul touchpad) ingrandisce solo l'immagine, non tutta la pagina
let zoomWheel = 0;
stage.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !state.base) return;
  e.preventDefault();
  zoomWheel += e.deltaY;
  if (Math.abs(zoomWheel) < 40) return;
  stepZoom(-zoomWheel, e);
  zoomWheel = 0;
}, { passive: false });

window.addEventListener('resize', () => {
  if (state.base && typeof state.zoom !== 'number') resizeCanvas();
});

stage.addEventListener('scroll', () => {
  if (state.drag) requestRender(false);
});

// --- Testo ---

function addText(p) {
  const { color, bold, italic } = state.style;
  const size = state.style.size * state.unit;
  const y = Math.round(p.y - (size * LINE_HEIGHT) / 2);
  const obj = { type: 'text', x: p.x, y, text: '', color, size, bold, italic };
  state.objects.push(obj);
  select(obj);
  startTextEdit(obj);
}

// Mentre si scrive, il testo vive in una textarea sovrapposta all'oggetto
function startTextEdit(obj) {
  state.editing = obj;
  textEditor.value = obj.text;
  textEditor.hidden = false;
  layoutTextEditor();
  textEditor.focus();
  textEditor.setSelectionRange(obj.text.length, obj.text.length);
  syncFlyout();
  requestRender();
}

function layoutTextEditor() {
  const obj = state.editing;
  const { crop, ratio } = state;
  let box;
  if (obj.type === 'bubble') {
    fitBubble(obj);
    const pad = bubblePad(obj);
    box = { x: obj.x + pad, y: obj.y + pad, w: obj.w - pad * 2, h: obj.h - pad * 2 };
  } else {
    // Un po' di spazio in più a destra per il carattere che sta per arrivare
    const layout = layoutText(obj);
    box = { x: obj.x, y: obj.y, w: layout.width + obj.size, h: layout.height };
  }
  Object.assign(textEditor.style, {
    left: `${(box.x - crop.x) / ratio}px`,
    top: `${(box.y - crop.y) / ratio}px`,
    width: `${box.w / ratio}px`,
    height: `${box.h / ratio}px`,
    font: fontOf(obj, obj.size / ratio),
    lineHeight: LINE_HEIGHT,
    color: obj.type === 'bubble' ? contrastColor(obj.color) : obj.color,
    whiteSpace: obj.type === 'bubble' ? 'pre-wrap' : 'pre',
  });
}

function commitText() {
  const obj = state.editing;
  if (!obj) return;
  state.editing = null;
  textEditor.hidden = true;
  obj.text = textEditor.value.trimEnd();
  // Un testo lasciato vuoto non serve a niente
  if (obj.type === 'text' && !obj.text) removeObject(obj);
  commit();
  syncFlyout();
  requestRender();
}

textEditor.addEventListener('blur', commitText);
textEditor.addEventListener('input', () => {
  state.editing.text = textEditor.value;
  layoutTextEditor();
  requestRender(false);
});

// --- Strumenti e stile ---

// chosen: scelto con un clic sul suo pulsante (non con Esc o tornando dal contagocce)
function setTool(tool, chosen = false) {
  commitText();
  const again = tool === state.tool;
  if (chosen) toolFlyout = again ? !toolFlyout : true;
  else if (!again) toolFlyout = false;
  if (tool !== 'crop') state.pendingCrop = null;
  // Il contagocce serve per un colore solo: poi si torna allo strumento di prima
  if (tool === 'picker' && state.tool !== 'picker') state.toolBeforePicker = state.tool;
  state.tool = tool;
  for (const button of document.querySelectorAll('[data-tool]')) {
    button.classList.toggle('active', button.dataset.tool === tool);
  }
  if (tool === 'crop' || tool === 'pagetext') {
    select(null);
    toast(t(tool === 'crop' ? 'cropHint' : 'textHint'), 6000, tool === 'pagetext' ? { label: t('helpMore'), run: () => openHelp('text') } : null);
  }
  canvas.style.cursor = tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';
  syncControls();
  updateCropActions();
  requestRender();
}

// Canvas di appoggio per leggere i pixel della schermata. Leggerli direttamente da quello
// grande lo rallenterebbe, e Chrome lo segnala con un avviso.
const sampler = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });

// Pixel (RGBA) della schermata nel rettangolo indicato, senza le annotazioni
function readBase(x, y, w, h) {
  const { canvas: copy } = sampler;
  if (copy.width < w) copy.width = w;
  if (copy.height < h) copy.height = h;
  sampler.drawImage(state.base, x, y, w, h, 0, 0, w, h);
  return sampler.getImageData(0, 0, w, h).data;
}

// Colore più frequente nella cornice di un pixel attorno all'area: su uno sfondo uniforme
// è il colore dello sfondo, anche se dentro l'area c'è del testo
function surroundingColor(area) {
  const { width, height } = state.base;
  const left = clamp(Math.round(area.x) - 1, 0, width - 1);
  const top = clamp(Math.round(area.y) - 1, 0, height - 1);
  const right = clamp(Math.round(area.x + area.w), left, width - 1);
  const bottom = clamp(Math.round(area.y + area.h), top, height - 1);
  const counts = new Map();
  // I quattro lati della cornice, ognuno letto come una striscia di pixel
  const strips = [
    [left, top, right - left + 1, 1], [left, bottom, right - left + 1, 1],
    [left, top, 1, bottom - top + 1], [right, top, 1, bottom - top + 1],
  ];
  for (const [x, y, w, h] of strips) {
    const data = readBase(x, y, w, h);
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const [winner] = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return `#${winner.toString(16).padStart(6, '0')}`;
}

// Inizia un tratto a mano libera, che segue il puntatore finché resta premuto: è così che
// disegnano la penna e la gomma. extra: ciò che distingue il tratto (la gomma lo segna come tale).
function startStroke(p, color, width, extra = {}) {
  const obj = { type: 'stroke', ...extra, points: [[p.x, p.y]], color, width };
  state.objects.push(obj);
  select(null);
  state.drag = { kind: 'draw', obj, start: p };
}

// Inizia una passata di gomma: un tratto del colore dello sfondo attorno al punto di partenza.
// Stando sopra a ciò che c'era, lo fa sparire, schermata o annotazioni che siano.
function startErasing(p) {
  const width = eraserSize(state.style.width) * state.unit;
  // Il colore si legge in una cornice più larga della gomma: partendo sopra un testo si prende comunque lo sfondo
  const around = { x: p.x - width, y: p.y - width, w: width * 2, h: width * 2 };
  startStroke(p, surroundingColor(around), width, { eraser: true });
}

// Cerchio grande quanto la gomma, da usare come puntatore; oltre un certo diametro Chrome non lo mostra
function eraserCursor() {
  const size = Math.round((eraserSize(state.style.width) * state.unit) / state.ratio);
  if (size > 120) return 'crosshair';
  const box = size + 4;
  const circle = (color, width) => `<circle cx='${box / 2}' cy='${box / 2}' r='${size / 2}' fill='none' stroke='${color}' stroke-width='${width}'/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${box}' height='${box}'>${circle('white', 3)}${circle('black', 1)}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${box / 2} ${box / 2}, crosshair`;
}

// Colore (#rrggbb) della schermata nel punto p, senza le annotazioni
function colorAt(p) {
  const x = clamp(p.x, 0, state.base.width - 1);
  const y = clamp(p.y, 0, state.base.height - 1);
  const [r, g, b] = readBase(x, y, 1, 1);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

// Il colore preso va all'oggetto selezionato, oppure allo strumento che si stava usando
function pickColor(p) {
  const color = colorAt(p);
  setTool(state.toolBeforePicker);
  setColor(color);
}

// Evidenziatore e copertura hanno ciascuno un colore proprio, distinto da quello di forme e testi.
// Restituisce la voce di state.style che vale per l'oggetto o, senza oggetto, per lo strumento attivo.
function colorSlot(obj) {
  const kind = obj ? obj.type : state.tool;
  return kind === 'highlight' || kind === 'cover' ? kind : 'color';
}

// Stile e testo di un nuovo bollino, presi dalle scelte della barra
function stepContent() {
  const { stepStyle, stepLabel } = state.style;
  return stepStyle === 'symbol' || stepStyle === 'custom' ? { style: stepStyle, label: stepLabel } : { style: stepStyle };
}

// Selezionando un oggetto, il suo stile diventa quello corrente
function adoptStyle(obj) {
  // Una passata di gomma ha il colore dello sfondo: non deve diventare il colore con cui si disegna
  if (obj.eraser) return;
  const { style, unit } = state;
  if (obj.color) style[colorSlot(obj)] = obj.color;
  if (obj.width) style.width = Math.round(obj.width / unit);
  // Di sfocature e mosaici lo spessore è la forza
  if (obj.type === 'blur') style.width = widthFor(obj.radius / unit, blurRadius);
  if (obj.type === 'pixel') style.width = widthFor(obj.block / unit, pixelBlock);
  if (obj.size) style.size = Math.round(obj.size / unit);
  if (TEXT_TYPES.includes(obj.type)) Object.assign(style, { bold: obj.bold, italic: obj.italic });
  // Del bollino si prende il contenuto, non il livello: un sottobollino fatto con Maiusc+clic non deve
  // trasformare in sottobollini anche quelli che seguono
  if (obj.type === 'step') {
    Object.assign(style, { stepStyle: STEP_STYLES.includes(obj.style) ? obj.style : 'number', stepLabel: obj.label || '' });
  }
}

// Le scelte dei bollini, nel pannello delle proprietà: quelle del bollino selezionato o dei prossimi
function syncStepControls() {
  const { stepStyle, stepLabel, stepSub } = state.style;
  stepSelect.value = stepStyle === 'symbol' ? `symbol:${stepLabel}` : stepStyle;
  if (!stepSelect.value) stepSelect.value = 'custom';
  stepLabelInput.hidden = stepStyle !== 'custom';
  if (document.activeElement !== stepLabelInput) stepLabelInput.value = stepLabel;
  // L'interruttore mostra il livello del bollino selezionato, oppure quello dei bollini che verranno
  const selected = state.selected?.type === 'step' ? state.selected : null;
  $('[data-action="step-sub"]').classList.toggle('active', selected ? selected.level === 2 : stepSub);
}

// La scelta vale per il bollino selezionato e per quelli che verranno. final = false mentre si scrive.
function setStep(patch, final = true) {
  Object.assign(state.style, patch);
  const obj = state.selected?.type === 'step' ? state.selected : null;
  if (obj) {
    delete obj.label;
    Object.assign(obj, stepContent());
  }
  if (obj && final) commit();
  syncControls();
  requestRender();
}

// Bollino o sottobollino: vale per quello selezionato e per i prossimi
function toggleSubStep() {
  const obj = state.selected?.type === 'step' ? state.selected : null;
  const sub = !(obj ? obj.level === 2 : state.style.stepSub);
  state.style.stepSub = sub;
  if (obj) {
    obj.level = sub ? 2 : 1;
    commit();
  }
  syncControls();
  requestRender();
}

stepSelect.addEventListener('change', () => {
  const [style, symbol] = stepSelect.value.split(':');
  const label = style === 'symbol' ? symbol : style === 'custom' ? state.style.stepLabel || '' : '';
  setStep({ stepStyle: style, stepLabel: label });
  if (style === 'custom') {
    stepLabelInput.focus();
    stepLabelInput.select();
  } else {
    stepSelect.blur();
  }
});
stepLabelInput.addEventListener('input', () => setStep({ stepLabel: stepLabelInput.value }, false));
stepLabelInput.addEventListener('change', () => setStep({ stepLabel: stepLabelInput.value }));
stepLabelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') stepLabelInput.blur();
});

function syncControls() {
  const { style } = state;
  const color = style[colorSlot(state.editing || state.selected)];
  // Il selettore di Chrome non conosce la trasparenza: riceve solo le prime sei cifre
  colorInput.value = color.slice(0, 7);
  hexInput.value = color;
  widthSelect.value = style.width;
  sizeSelect.value = style.size;
  $('[data-toggle="bold"]').classList.toggle('active', style.bold);
  $('[data-toggle="italic"]').classList.toggle('active', style.italic);
  syncStepControls();
  syncFlyout();
}

// Ogni modifica di stile vale per l'oggetto attivo e per quelli disegnati in seguito.
// final = false durante la scelta dal selettore colore: la cronologia si aggiorna solo alla fine.
function styleChanged(obj, final = true) {
  if (obj?.type === 'bubble') fitBubble(obj);
  if (state.editing) layoutTextEditor();
  else if (obj && final) commit();
  syncControls();
  requestRender();
}

function setColor(color, final) {
  const obj = state.editing || state.selected;
  state.style[colorSlot(obj)] = color;
  if (obj && 'color' in obj) obj.color = color;
  styleChanged(obj, final);
}

function setWidth(width) {
  const obj = state.selected;
  state.style.width = width;
  if (obj?.type === 'blur') obj.radius = blurRadius(width) * state.unit;
  else if (obj?.type === 'pixel') obj.block = pixelBlock(width) * state.unit;
  else if (obj?.eraser) obj.width = eraserSize(width) * state.unit;
  else if (obj?.width) obj.width = width * state.unit;
  styleChanged(obj);
}

// patch: { size } in pixel CSS, oppure { bold } / { italic }
function setFont(patch) {
  const obj = state.editing || state.selected;
  Object.assign(state.style, patch);
  const { size, bold, italic } = state.style;
  if (obj?.size) obj.size = size * state.unit;
  if (obj && TEXT_TYPES.includes(obj.type)) Object.assign(obj, { bold, italic });
  styleChanged(obj);
}

function updateButtons() {
  $('[data-action="undo"]').disabled = history.index <= 0;
  $('[data-action="redo"]').disabled = history.index >= history.stack.length - 1;
  for (const button of document.querySelectorAll('[data-action="delete"], [data-action="copy-object"]')) {
    button.disabled = !state.selected;
  }
  $('[data-action="paste-object"]').disabled = !clip;
  $('[data-action="copy-text"]').disabled = $('[data-tool="pagetext"]').disabled;
  const layers = state.selected && layerPlaces(state.selected);
  $('[data-action="layer-front"]').disabled = !layers?.front;
  $('[data-action="layer-forward"]').disabled = !layers?.forward;
  $('[data-action="layer-backward"]').disabled = !layers?.backward;
  $('[data-action="layer-back"]').disabled = !layers?.back;
}

// --- Livelli ---

// Ogni segno sta sopra quelli che lo precedono in state.objects. Sfocature e mosaici fanno pila a sé,
// sotto a tutti gli altri segni (vedi drawScene), quindi un segno si sposta solo dentro la sua pila.
// Avanti e indietro scavalcano il primo segno che gli si sovrappone: ogni passo cambia qualcosa che si vede.
// Restituisce, per ogni spostamento, il segno accanto a cui andare e da che parte; null se non c'è dove andare.
function layerPlaces(obj) {
  const pile = state.objects.filter((o) => reworksBase(o) === reworksBase(obj));
  const at = pile.indexOf(obj);
  const box = boundsOf(obj);
  const overlaps = (o) => {
    const b = boundsOf(o);
    return b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h;
  };
  const above = pile.slice(at + 1).find(overlaps);
  const below = pile.slice(0, at).findLast(overlaps);
  return {
    front: at < pile.length - 1 ? { next: pile.at(-1), after: true } : null,
    forward: above ? { next: above, after: true } : null,
    backward: below ? { next: below, after: false } : null,
    back: at > 0 ? { next: pile[0], after: false } : null,
  };
}

// where: 'front' | 'forward' | 'backward' | 'back'
function moveLayer(where) {
  const obj = state.selected;
  const place = obj && layerPlaces(obj)[where];
  if (!place) return;
  state.objects.splice(state.objects.indexOf(obj), 1);
  state.objects.splice(state.objects.indexOf(place.next) + (place.after ? 1 : 0), 0, obj);
  commit();
  requestRender();
}

// --- Ritaglio ---

// Tiene il ritaglio in corso dentro l'immagine
function clampCrop(pending, keepSize) {
  const c = state.crop;
  if (keepSize) {
    pending.x = clamp(pending.x, c.x, c.x + c.w - pending.w);
    pending.y = clamp(pending.y, c.y, c.y + c.h - pending.h);
    return;
  }
  const right = clamp(pending.x + pending.w, c.x, c.x + c.w);
  const bottom = clamp(pending.y + pending.h, c.y, c.y + c.h);
  pending.x = clamp(pending.x, c.x, c.x + c.w);
  pending.y = clamp(pending.y, c.y, c.y + c.h);
  pending.w = right - pending.x;
  pending.h = bottom - pending.y;
}

// Posiziona i pulsanti Applica / Annulla sotto l'angolo del ritaglio (o dentro, se non c'è spazio)
function updateCropActions() {
  const pending = state.pendingCrop;
  cropActions.hidden = !pending || Boolean(state.drag);
  if (cropActions.hidden) return;
  const { crop, ratio } = state;
  const right = (pending.x + pending.w - crop.x) / ratio;
  const bottom = (pending.y + pending.h - crop.y) / ratio;
  const height = cropActions.offsetHeight + 8;
  const fitsBelow = bottom + height <= crop.h / ratio;
  cropActions.style.left = `${Math.max(0, right - cropActions.offsetWidth)}px`;
  cropActions.style.top = `${fitsBelow ? bottom + 8 : bottom - height}px`;
}

function applyCrop() {
  const pending = state.pendingCrop;
  if (!pending) return;
  if (pending.w >= 2 && pending.h >= 2) {
    state.crop = { x: pending.x, y: pending.y, w: pending.w, h: pending.h };
  }
  setTool('select');
  resizeCanvas();
  commit();
}

function cancelCrop() {
  state.pendingCrop = null;
  updateCropActions();
  requestRender();
}

// --- Copia e incolla degli oggetti ---

const CLIP_TYPE = 'application/x-picantex';
const PASTE_OFFSET = 16; // scostamento di una copia incollata sopra l'originale, in pixel CSS
const MAX_COORDINATE = 100000;
const MAX_MEASURE = 2000;
const MAX_TEXT = 20000;
const MAX_POINTS = 50000;

// Campi di ogni tipo di oggetto. Negli appunti può aver scritto chiunque: un oggetto incollato
// si ricostruisce da questo elenco, un campo alla volta, e si scarta se un valore non torna.
const BOX = ['x', 'y', 'w', 'h'];
const SEGMENT = ['x1', 'y1', 'x2', 'y2', 'color', 'width'];
const OBJECT_FIELDS = {
  rect: [...BOX, 'color', 'width'],
  ellipse: [...BOX, 'color', 'width'],
  line: SEGMENT,
  arrow: SEGMENT,
  highlight: [...BOX, 'color'],
  cover: [...BOX, 'color'],
  blur: [...BOX, 'radius'],
  pixel: [...BOX, 'block'],
  text: ['x', 'y', 'text', 'color', 'size', 'bold', 'italic'],
  bubble: [...BOX, 'tx', 'ty', 'text', 'color', 'size', 'bold', 'italic'],
  step: ['x', 'y', 'color', 'size', 'level', 'style', 'label'],
  stroke: ['points', 'color', 'width', 'eraser'],
};
// Campi che una copia può non avere
const OPTIONAL_FIELDS = ['level', 'style', 'label'];
const STYLE_MEASURES = ['width', 'size', 'radius', 'block'];

// L'ultimo oggetto copiato (testo JSON) resta anche in memoria, condiviso tra le schede dell'editor
// aperte: serve alla voce «Incolla oggetto» del menu, che non può leggere gli appunti.
const clipChannel = new BroadcastChannel('clip');
let clip = null;
clipChannel.addEventListener('message', ({ data }) => {
  // Una scheda appena aperta chiede se c'è qualcosa di copiato: chi ce l'ha risponde
  if (data.ask) {
    if (clip) clipChannel.postMessage({ clip });
  } else {
    clip = data.clip;
    updateButtons();
  }
});
clipChannel.postMessage({ ask: true });

// Ultima copia o ultimo incolla: l'oggetto, il testo finito negli appunti e il punto dell'immagine
// su cui stava il puntatore
let lastPlaced = { object: null, text: '', point: null };

// Punto dell'immagine sotto il puntatore, oppure null se il puntatore è altrove
function pointerInImage() {
  const p = pointer && toImage(pointer);
  return p && inRect(p, state.crop) ? p : null;
}

function copyObject(e) {
  const obj = state.selected;
  // Senza un oggetto selezionato, o dentro un campo di testo, copia e taglia restano quelli del browser
  if (!obj || e.target.closest?.('input, textarea')) return;
  e.preventDefault();
  clip = JSON.stringify({ unit: state.unit, object: obj });
  e.clipboardData.setData(CLIP_TYPE, clip);
  clipChannel.postMessage({ clip });
  lastPlaced = { object: obj, text: clip, point: pointerInImage() };
  if (e.type === 'cut') deleteSelected();
  updateButtons();
  toast(t(e.type === 'cut' ? 'objectCut' : 'objectCopied'), 5000);
}

document.addEventListener('copy', copyObject);
document.addEventListener('cut', copyObject);

// Oggetto contenuto nel testo copiato, pronto per questa immagine; null se il testo non ne contiene uno valido
function readClip(text) {
  try {
    const { unit, object } = JSON.parse(text);
    // Le misure seguono la scala della schermata: da una all'altra l'oggetto resta grande uguale a schermo
    return rebuildObject(object, state.unit / unit);
  } catch {
    return null;
  }
}

function rebuildObject(source, scale) {
  const need = (ok) => {
    if (!ok) throw new Error('clip');
  };
  const measure = (value, min, max) => {
    need(typeof value === 'number' && value * scale >= min && value * scale <= max);
    return value * scale;
  };
  const coordinate = (value) => Math.round(measure(value, -MAX_COORDINATE, MAX_COORDINATE));

  need(Object.hasOwn(OBJECT_FIELDS, source.type) && scale > 0);
  const obj = { type: source.type };
  for (const name of OBJECT_FIELDS[source.type]) {
    const value = source[name];
    if (OPTIONAL_FIELDS.includes(name) && value === undefined) continue;
    if (name === 'level') {
      need(value === 1 || value === 2);
      obj.level = value;
    } else if (name === 'style') {
      need(STEP_STYLES.includes(value));
      obj.style = value;
    } else if (name === 'label') {
      need(typeof value === 'string' && value.length <= 12);
      obj.label = value;
    } else if (name === 'text') {
      need(typeof value === 'string' && value.length <= MAX_TEXT);
      obj.text = value;
    } else if (name === 'color') {
      obj.color = parseHex(String(value));
      need(obj.color);
    } else if (name === 'bold' || name === 'italic') {
      obj[name] = value === true;
    } else if (name === 'eraser') {
      if (value === true) obj.eraser = true;
    } else if (name === 'points') {
      need(Array.isArray(value) && value.length > 0 && value.length <= MAX_POINTS);
      obj.points = value.map(([x, y]) => [coordinate(x), coordinate(y)]);
    } else if (STYLE_MEASURES.includes(name)) {
      obj[name] = measure(value, 0.1, MAX_MEASURE);
    } else if (name === 'w' || name === 'h') {
      // Un oggetto non può essere più grande dell'immagine su cui arriva
      const side = name === 'w' ? state.base.width : state.base.height;
      obj[name] = Math.min(Math.round(measure(value, 0, MAX_COORDINATE)), side);
    } else {
      obj[name] = coordinate(value);
    }
  }
  return obj;
}

// Aggiunge all'immagine l'oggetto contenuto nel testo copiato; restituisce false se non ce n'è uno.
// at: punto in cui metterne il centro (dal menu è quello del click destro). Senza, vale il puntatore,
// se si è spostato dall'ultima copia o dall'ultimo incolla.
function pasteClip(text, at) {
  const obj = readClip(text);
  if (!obj) return false;
  setTool('select');
  if (obj.type === 'bubble') fitBubble(obj);
  const here = pointerInImage();
  const { object: previous, point } = lastPlaced;
  const still = here && point && Math.hypot(here.x - point.x, here.y - point.y) < MIN_DRAG * state.ratio;
  const target = at || (still ? null : here);

  // Porta l'angolo in alto a sinistra dell'oggetto nel punto indicato
  const moveTo = (x, y) => {
    const b = boundsOf(obj);
    moveBy(obj, Math.round(x - b.x), Math.round(y - b.y));
  };
  const centerOn = (p) => {
    const b = boundsOf(obj);
    moveTo(p.x - b.w / 2, p.y - b.h / 2);
  };

  if (target) {
    centerOn(target);
  } else {
    // Puntatore fermo: un'altra copia dello stesso oggetto parte dalla precedente, se c'è ancora;
    // negli altri casi da dov'era l'originale
    if (text === lastPlaced.text && state.objects.includes(previous)) {
      const from = boundsOf(previous);
      moveTo(from.x, from.y);
    }
    // Dove non si vedrebbe non serve: va al centro della parte visibile
    const view = visibleArea(0);
    view.x += state.crop.x;
    view.y += state.crop.y;
    const b = boundsOf(obj);
    if (!inRect({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, view)) {
      centerOn({ x: view.x + view.w / 2, y: view.y + view.h / 2 });
    }
    // Poi si scosta finché nello stesso punto c'è già un altro oggetto, per non coprirlo
    const offset = Math.max(1, Math.round(PASTE_OFFSET * state.ratio));
    const sameCorner = (o) => {
      const a = boundsOf(o);
      const c = boundsOf(obj);
      return Math.abs(a.x - c.x) < 1 && Math.abs(a.y - c.y) < 1;
    };
    while (state.objects.some(sameCorner)) moveBy(obj, offset, offset);
  }

  // Un bollino incollato è l'ultimo messo: prende il numero dopo gli altri
  if (obj.type === 'step') obj.seq = nextStepSeq(state.objects);
  state.objects.push(obj);
  select(obj);
  commit();
  lastPlaced = { object: obj, text, point: here };
  return true;
}

// --- Testo della pagina ---

// Insieme alla cattura arriva il testo che la pagina mostrava, parola per parola. Qui lo si porta
// sui pixel dell'immagine. Restano anche le parole finite fuori: servono a sapere dove si va a capo.
function placeWords(capture) {
  const { scale, words } = capture.text || {};
  if (!words) return [];
  // Di una selezione resta solo il rettangolo tracciato sulla pagina: le parole si spostano con lui
  const { rect, dpr = 1 } = capture;
  const dx = rect ? Math.max(0, Math.round(rect.x * dpr)) : 0;
  const dy = rect ? Math.max(0, Math.round(rect.y * dpr)) : 0;
  return words.map((word) => ({
    t: word.t, s: word.s,
    x: word.x * scale - dx, y: word.y * scale - dy, w: word.w * scale, h: word.h * scale,
  }));
}

const centerOf = (word) => ({ x: word.x + word.w / 2, y: word.y + word.h / 2 });
// Forza di ciò che separa due parole: riga vuota, a capo, tabulazione, spazio, niente
const separatorRank = (sep) => (sep.includes('\n\n') ? 4 : sep.includes('\n') ? 3 : sep.includes('\t') ? 2 : sep ? 1 : 0);

// Dice se una parola non si legge più nell'immagine: coperta, sfocata, messa a mosaico, sotto un fumetto
// o un bollino, o cancellata con la gomma, anche solo in parte. Non va nei PDF e non si copia.
function hiddenWords() {
  const { objects } = state;
  const covers = objects.filter((o) => ['blur', 'pixel', 'cover', 'bubble', 'step'].includes(o.type)).map(boundsOf);
  const erasers = objects.filter((o) => o.eraser);
  const touches = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  return (word) => covers.some((box) => touches(word, box))
    || erasers.some((o) => hitTest(o, centerOf(word), Math.max(word.w, word.h) / 2));
}

// Testo delle parole che cadono nell'area, nell'ordine e con gli a capo che hanno nella pagina
function textIn(area) {
  const hidden = hiddenWords();
  let text = '';
  let pending = '';
  for (const word of state.text) {
    // Tra due parole prese vale il separatore più forte incontrato nel frattempo, anche su quelle saltate
    if (separatorRank(word.s) > separatorRank(pending)) pending = word.s;
    if (!inRect(centerOf(word), area) || hidden(word)) continue;
    text += (text ? pending : '') + word.t;
    pending = '';
  }
  return text;
}

// Area che si sta tracciando con lo strumento del testo, con evidenziate le parole che verranno copiate
function drawPicking(area) {
  const k = state.ratio;
  const hidden = hiddenWords();
  ctx.save();
  ctx.fillStyle = 'rgba(26, 115, 232, 0.3)';
  for (const word of state.text) {
    if (inRect(centerOf(word), area) && !hidden(word)) ctx.fillRect(word.x, word.y, word.w, word.h);
  }
  ctx.lineWidth = k;
  ctx.strokeStyle = '#1a73e8';
  ctx.setLineDash([5 * k, 4 * k]);
  ctx.strokeRect(area.x, area.y, area.w, area.h);
  ctx.restore();
}

// Parole della pagina che si leggono ancora nell'immagine ritagliata, con la posizione nell'immagine:
// vanno nei PDF come testo invisibile, da cercare e copiare (vedi hiddenWords per ciò che resta fuori)
function wordsToExport() {
  const { crop } = state;
  const hidden = hiddenWords();
  return state.text
    .filter((word) => inRect(centerOf(word), crop) && !hidden(word))
    .map((word) => ({ ...word, x: word.x - crop.x, y: word.y - crop.y }));
}

async function copyPageText(area) {
  const text = textIn(area);
  if (!text) return toast(t('textNone'));
  try {
    await navigator.clipboard.writeText(text);
    // L'avviso mostra l'inizio di ciò che è stato copiato
    const preview = text.replace(/\s+/g, ' ');
    toast(t('textCopied', preview.length > 60 ? `${preview.slice(0, 60)}…` : preview), 5000);
  } catch (error) {
    toast(t('errorFailed', error.message), 7000);
  }
}

// --- Salvataggio ---

let busy = false;

async function withBusy(message, task) {
  if (busy || !state.base) return;
  busy = true;
  commitText();
  toast(message, 60000);
  try {
    await task();
  } catch (error) {
    console.error(error);
    toast(t('errorFailed', error.message), 7000);
  } finally {
    busy = false;
  }
}

function exportImage() {
  return withBusy(t('preparing'), async () => {
    const format = formatSelect.value;
    const snapshot = history.stack[history.index];
    let image = compose(state);
    let words = format === 'pdf' ? wordsToExport() : undefined;
    const stamped = verify && stampOn;
    if (stamped) ({ canvas: image, words } = addStamp(image, state.meta, state.unit, words));
    let blob = await encode(image, format, state.unit, words, stamped ? pdfInfo(state.meta) : undefined);
    if (stamped) blob = await embedStamp(blob, format, state.meta);
    // Da qui in poi è aperta la finestra di salvataggio: l'avviso "preparo il file" non serve più
    hideToast();
    const name = await download(blob, buildFileName(format, verify ? state.meta.url : ''));
    toast(t(name ? 'saved' : 'saveCancelled'));
    if (name) markSaved(snapshot);
    if (name && verify) showSavedFingerprint({ name, hash: await sha256(blob), captured: state.meta.captured, saved: Date.now() });
  });
}

// --- Strumenti di verifica (vedi verify.js) ---
// Si accendono dalla tendina dello scudo, accanto a «Salva»: dopo ogni salvataggio, nella stessa
// tendina compare l'impronta del file, e il timbro aggiunge sotto l'immagine l'indirizzo e l'ora della
// cattura. Il timbro parte acceso e vale per i salvataggi di questa scheda, compreso il PDF del documento.

let verify = false;
let stampOn = true;

function showVerify(on) {
  verify = on;
  $('[data-action="verify-menu"]').classList.toggle('on', on);
  $('#verify-on').checked = on;
  $('#stamp-on').checked = stampOn;
  $('#stamp-on').disabled = !on;
  if (!on) $('#fingerprint').hidden = true;
}

$('#verify-on').addEventListener('change', () => {
  showVerify($('#verify-on').checked);
  chrome.storage.local.set({ verify });
});
$('#stamp-on').addEventListener('change', () => {
  stampOn = $('#stamp-on').checked;
});

// Dopo un salvataggio l'impronta si vede subito: la tendina si apre da sola
function showSavedFingerprint(details) {
  renderFingerprint($('#fingerprint'), details);
  openDropdown($('#verify-menu'), $('[data-action="verify-menu"]'));
}

watchVerify(showVerify);
setupHints();

// --- Tendine e finestrelle ---
// «Apri» e la verifica scendono dalla barra in alto; i colori si aprono accanto agli strumenti. Ne resta
// aperta una sola, e si chiude cliccando altrove o con Esc.

let dropdown = null; // { menu, anchor }

// place: 'below' sotto il pulsante, 'side' attaccata a destra della colonna degli strumenti
function openDropdown(menu, anchor, place = 'below') {
  closeDropdown();
  menu.hidden = false;
  const box = anchor.getBoundingClientRect();
  if (place === 'side') {
    menu.style.left = `${$('#toolbar').getBoundingClientRect().right}px`;
    menu.style.top = `${clamp(box.bottom - menu.offsetHeight, 8, window.innerHeight - menu.offsetHeight - 8)}px`;
  } else {
    menu.style.left = `${clamp(box.left, 8, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${box.bottom + 4}px`;
  }
  anchor.classList.add('open');
  dropdown = { menu, anchor };
}

function closeDropdown() {
  if (!dropdown) return;
  dropdown.menu.hidden = true;
  dropdown.anchor.classList.remove('open');
  dropdown = null;
}

function toggleDropdown(menu, anchor, place) {
  if (dropdown?.menu === menu) closeDropdown();
  else openDropdown(menu, anchor, place);
}

function toggleOpenMenu() {
  // Accanto al documento, quante pagine contiene già (lo stesso numero del suo pulsante)
  $('#open-doc-count').textContent = $('#doc-count').textContent;
  toggleDropdown($('#open-menu'), $('[data-action="open-menu"]'));
}

// --- Tendine degli strumenti ---
// Gli strumenti che hanno opzioni (un triangolino nell'angolo lo segnala) le mostrano in una tendina che
// scivola fuori accanto al loro pulsante: si apre scegliendo lo strumento, si ritira appena si comincia a
// disegnare e si riapre cliccando di nuovo lo strumento. Un segno selezionato mostra le sue accanto al
// pulsante del suo strumento, e così il testo mentre lo si scrive. Il colore ha la sua tendina, dal cerchio
// in fondo agli strumenti.

const toolOptions = $('#tool-options');
const WIDTH_TYPES = ['rect', 'ellipse', 'line', 'arrow', 'pen', 'blur', 'pixel', 'eraser'];
const OPTION_TOOLS = [...WIDTH_TYPES, ...TEXT_TYPES, 'step'];
const WIDTH_LABELS = { blur: 'propsStrength', pixel: 'propsStrength', eraser: 'propsSize' };
let toolFlyout = false; // la tendina dello strumento in uso è aperta

for (const tool of OPTION_TOOLS) $(`#toolbar [data-tool="${tool}"]`).classList.add('has-options');

// Lo strumento che fa un segno: i tratti sono della penna o della gomma
const toolOf = (obj) => (obj.type === 'stroke' ? (obj.eraser ? 'eraser' : 'pen') : obj.type);

// Di quale strumento mostrare le opzioni, oppure null
function flyoutTool() {
  const { editing, selected, tool } = state;
  if (editing) return toolOf(editing);
  if (selected && tool === 'select') return toolOf(selected);
  // Il testo appena scritto, con il suo strumento ancora in mano: scegliendone la grandezza il campo
  // perde il fuoco e la scrittura si chiude, ma la tendina deve restare
  if (selected && TEXT_TYPES.includes(selected.type) && selected.type === tool) return tool;
  return toolFlyout ? tool : null;
}

function syncFlyout() {
  // Il cerchio dei colori mostra il colore di ciò che si disegna ora
  $('#color-button .dot').style.background = state.style[colorSlot(state.editing || state.selected)];
  const tool = flyoutTool();
  if (!OPTION_TOOLS.includes(tool)) {
    toolOptions.hidden = true;
    return;
  }
  const shown = { width: WIDTH_TYPES.includes(tool), font: TEXT_TYPES.includes(tool) || tool === 'step', step: tool === 'step' };
  for (const section of toolOptions.querySelectorAll('[data-prop]')) section.hidden = !shown[section.dataset.prop];
  toolOptions.querySelector('.styles').hidden = !TEXT_TYPES.includes(tool);
  $('#width-label').textContent = t(WIDTH_LABELS[tool] || 'propsWidth');
  $('#eraser-hint').hidden = tool !== 'eraser';
  toolOptions.hidden = false;
  // Accanto al pulsante dello strumento, attaccata alla colonna
  const button = $(`#toolbar [data-tool="${tool}"]`).getBoundingClientRect();
  toolOptions.style.left = `${$('#toolbar').getBoundingClientRect().right}px`;
  toolOptions.style.top = `${clamp(button.top + button.height / 2 - toolOptions.offsetHeight / 2, 50, window.innerHeight - toolOptions.offsetHeight - 8)}px`;
}

// Stampa l'immagine così com'è ora, su fogli A4
function printImage() {
  if (!state.base) return;
  commitText();
  printImages([{ canvas: compose(state), pixelsPerPoint: state.unit / POINTS_PER_CSS_PIXEL }]);
}

function copyImage() {
  return withBusy(t('copying'), async () => {
    const png = encode(compose(state), 'png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast(t('copied'));
  });
}

// --- Avvisi, menu e comandi ---

let toastTimer;

// action: { label, run } per un pulsante nell'avviso
// "Continua da qui": la parte già catturata va nel documento (se non c'è), poi si riprende la pagina
// dal punto in cui la cattura si era fermata. La pagina dev'essere ancora aperta, la stessa.
async function resumeCapture(resume) {
  hideToast();
  if (!state.meta.docPage) {
    await addToDocument();
    toggleDocument(true, false);
  }
  const ok = await chrome.runtime.sendMessage({ type: 'resume-capture', ...resume }).catch(() => false);
  if (!ok) toast(t('resumeGone'), 8000);
}

// action: un pulsante { label, run }, oppure un elenco di pulsanti
function toast(text, duration = 3500, action = null) {
  const el = $('#toast');
  el.replaceChildren(text);
  for (const one of [action].flat().filter(Boolean)) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.textContent = one.label;
    button.addEventListener('click', one.run);
    el.append(button);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
}

function hideMenu() {
  menu.hidden = true;
}

// Punto dell'immagine su cui è stato aperto il menu: «Incolla oggetto» mette lì la copia
let menuPoint = null;

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!state.base) return;
  commitText();
  menuPoint = toImage(e);
  const hit = objectAt(menuPoint);
  if (hit) select(hit);
  updateButtons(); // i livelli dipendono da dove sono i segni adesso
  menu.hidden = false;
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
});

const actions = {
  save: exportImage,
  copy: copyImage,
  // Passa dall'evento copy, come Ctrl+C: è lì che l'oggetto finisce negli appunti
  'copy-object': () => document.execCommand('copy'),
  'paste-object': () => pasteClip(clip, menuPoint),
  'copy-text': () => copyPageText(state.crop),
  print: printImage,
  'verify-menu': () => toggleDropdown($('#verify-menu'), $('[data-action="verify-menu"]')),
  'open-menu': toggleOpenMenu,
  colors: () => toggleDropdown($('#color-pop'), $('#color-button'), 'side'),
  'verify-file': async () => {
    closeDropdown();
    const tab = await chrome.tabs.getCurrent();
    chrome.tabs.create({ url: 'verify-file.html', index: tab.index + 1, openerTabId: tab.id });
  },
  'doc-toggle': () => toggleDocument(),
  'doc-open': () => toggleDocument(true),
  'step-sub': toggleSubStep,
  undo: () => travel(-1),
  redo: () => travel(1),
  delete: deleteSelected,
  'layer-front': () => moveLayer('front'),
  'layer-forward': () => moveLayer('forward'),
  'layer-backward': () => moveLayer('backward'),
  'layer-back': () => moveLayer('back'),
  open: () => fileInput.click(),
  'crop-apply': applyCrop,
  'crop-cancel': cancelCrop,
};

document.addEventListener('click', (e) => {
  hideMenu();
  // Un clic fuori dalla tendina aperta la chiude; dentro, la chiudono le scelte fatte (non gli interruttori)
  const inside = dropdown && (dropdown.menu.contains(e.target) || dropdown.anchor.contains(e.target));
  if (dropdown && !inside) closeDropdown();
  const button = e.target.closest('button');
  if (!button || button.disabled) return;
  const { action, tool, color, toggle } = button.dataset;
  if (tool) setTool(tool, true);
  else if (color) setColor(color);
  else if (toggle) setFont({ [toggle]: !state.style[toggle] });
  else if (action) actions[action]();
  if (inside && dropdown && (tool || color || button.closest('#open-menu'))) closeDropdown();
});

// Il canvas e i pulsanti di stile non devono togliere il cursore al testo in corso
document.addEventListener('mousedown', (e) => {
  if (e.target === canvas || e.target.closest('[data-keep-focus]')) e.preventDefault();
});

colorInput.addEventListener('input', () => setColor(colorInput.value, false));
colorInput.addEventListener('change', commit);

// Codice scritto a mano: accetta #rgb, #rrggbb e le forme con trasparenza #rgba e #rrggbbaa.
// Restituisce il colore in forma estesa, oppure null se il testo non è un codice valido.
function parseHex(text) {
  let digits = text.trim().replace(/^#/, '').toLowerCase();
  if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(digits)) return null;
  if (digits.length < 6) digits = [...digits].map((d) => d + d).join('');
  // Una trasparenza "ff" equivale a nessuna trasparenza
  return `#${digits.length === 8 && digits.endsWith('ff') ? digits.slice(0, 6) : digits}`;
}

hexInput.addEventListener('change', () => {
  const color = parseHex(hexInput.value);
  if (color) setColor(color);
  else syncControls(); // codice non valido: torna quello di prima
});
hexInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') hexInput.blur();
});
// Entrando nel campo il codice si seleziona tutto: basta scrivere o incollare quello nuovo
hexInput.addEventListener('focus', () => hexInput.select());
widthSelect.addEventListener('change', () => setWidth(Number(widthSelect.value)));
sizeSelect.addEventListener('change', () => setFont({ size: Number(sizeSelect.value) }));
formatSelect.addEventListener('change', () => localStorage.setItem('format', formatSelect.value));

// Cambio di lingua: i testi si aggiornano sul posto, senza perdere il lavoro in corso
languageSelect.addEventListener('change', async () => {
  await saveLanguage(languageSelect.value);
  await loadLanguage();
  localizePage();
  updateTitle();
  drawDocument();
});

// Dopo la scelta, il fuoco torna alla pagina: così Canc e le scorciatoie funzionano subito
zoomSelect.addEventListener('change', () => {
  const choice = zoomSelect.value;
  setZoom(Number(choice) || choice);
});

for (const control of [widthSelect, sizeSelect, formatSelect, languageSelect, zoomSelect]) {
  control.addEventListener('change', () => control.blur());
}

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (key === 'escape' && !menu.hidden) return hideMenu();
  if (key === 'escape' && dropdown) return closeDropdown();
  if (e.target === textEditor) {
    // Esc o Ctrl+Invio confermano il testo; tutti gli altri tasti servono per scrivere
    if (key === 'escape' || (key === 'enter' && mod)) commitText();
    return;
  }
  if (e.target.matches('input, select')) return;

  let handled = true;
  // Livelli: Ctrl+↑ e Ctrl+↓ di un passo, con Maiusc fino in cima o in fondo. Le frecce, a differenza
  // di [ e ], sono uguali su ogni tastiera, e Ctrl++ è già lo zoom del browser.
  if (mod && state.selected && (key === 'arrowup' || key === 'arrowdown')) {
    moveLayer(key === 'arrowup' ? (e.shiftKey ? 'front' : 'forward') : (e.shiftKey ? 'back' : 'backward'));
  } else if (mod && key === 'z') travel(e.shiftKey ? 1 : -1);
  else if (mod && key === 'y') travel(1);
  else if (mod && key === 's') exportImage();
  // La stampa del browser stamperebbe l'editor con tutte le sue barre: qui si stampa l'immagine
  else if (mod && key === 'p') printImage();
  // Con un oggetto selezionato Ctrl+C copia l'oggetto (vedi copyObject); senza, o con Maiusc, l'immagine
  else if (mod && key === 'c' && (e.shiftKey || !state.selected)) copyImage();
  else if (key === 'delete' || key === 'backspace') deleteSelected();
  else if (key === 'enter' && state.pendingCrop) applyCrop();
  else if (key === 'escape' && state.pendingCrop) cancelCrop();
  else if (key === 'escape' && state.tool === 'picker') setTool(state.toolBeforePicker);
  else if (key === 'escape' && state.selected) select(null);
  else if (key === 'escape') setTool('select');
  else if (!mod && (key === '+' || key === '=')) stepZoom(1);
  else if (!mod && key === '-') stepZoom(-1);
  else if (!mod && key === '0') setZoom(1);
  else handled = false;
  if (handled) e.preventDefault();
});

for (const swatch of document.querySelectorAll('[data-color]')) swatch.style.background = swatch.dataset.color;
if (FORMATS.includes(localStorage.getItem('format'))) formatSelect.value = localStorage.getItem('format');

init().catch((error) => {
  console.error(error);
  fail(t('errorOpen', error.message));
});
