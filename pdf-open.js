// Apertura dei PDF: le pagine diventano immagini, con il loro testo, da annotare nell'editor o da
// mettere nel documento a più pagine. A leggere il PDF è PDF.js, chiuso nella pagina isolata
// pdf-sandbox.html: questa pagina gli manda il file e ne riceve soltanto immagini e parole, che
// controlla prima di usarle.
import { loadLanguage, localizePage, t } from './i18n.js';
import { POINTS_PER_CSS_PIXEL } from './pdf.js';
import { loadCapture, purgeOldCaptures, saveCapture, savePage } from './store.js';
import { fetchFromTab, isLocalFile } from './tab-file.js';
const $ = (selector) => document.querySelector(selector);
const reader = $('#reader');
const pageList = $('#pages');
const fileInput = $('#file');

// Le pagine escono a due pixel per pixel CSS, come una cattura su uno schermo ad alta densità:
// un foglio A4 diventa un'immagine di 1588 × 2246 pixel
const UNIT = 2;
const THUMB_WIDTH = 170; // pixel CSS
const MAX_EDITOR_TABS = 10;
// Limiti per ciò che arriva dalla pagina isolata
const MAX_PAGES = 5000;
const MAX_WORDS = 100000;
const MAX_WORD = 500;

const state = {
  name: '',
  blob: null,
  sizes: [],          // misure delle pagine, in punti
  chosen: new Set(),  // numeri delle pagine scelte
  anchor: null,       // ultima pagina cliccata, per scegliere un intervallo con Maiusc
  busy: false,
};

// --- Avvisi ---

let toastTimer;
// action: { label, run } per un pulsante nell'avviso
function toast(text, duration = 3500, action = null) {
  const el = $('#toast');
  el.replaceChildren(text);
  if (action) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    el.append(button);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, duration);
}

// --- Colloquio con la pagina isolata ---

let nextId = 1;
const waiting = new Map();
let markReady;
const readerReady = new Promise((resolve) => { markReady = resolve; });

window.addEventListener('message', (event) => {
  if (event.source !== reader.contentWindow) return;
  const data = event.data || {};
  if (data.ready) return markReady();
  const pending = waiting.get(data.id);
  if (!pending) return;
  waiting.delete(data.id);
  if (data.error !== undefined) pending.reject(new Error(String(data.error)));
  else pending.resolve(data.result);
});

// La pagina isolata annuncia di essere pronta appena parte; se fosse partita prima di questa, glielo si chiede
const ping = () => reader.contentWindow?.postMessage({ ping: true }, '*');
reader.addEventListener('load', ping);
ping();

async function ask(action, request, transfer = []) {
  await readerReady;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    reader.contentWindow.postMessage({ id, action, ...request }, '*', transfer);
  });
}

// Ciò che torna dalla pagina isolata si controlla campo per campo: un PDF costruito ad arte non
// deve poter far arrivare qui altro che un'immagine e delle parole
function cleanPage(result) {
  const number = (value) => typeof value === 'number' && Number.isFinite(value);
  const ok = result && result.blob instanceof Blob && /^image\/(png|jpeg)$/.test(result.blob.type)
    && number(result.width) && number(result.height) && number(result.scale) && result.scale > 0;
  if (!ok) throw new Error('reader');
  const words = (Array.isArray(result.words) ? result.words.slice(0, MAX_WORDS) : [])
    .filter((word) => word && typeof word.t === 'string' && word.t.length <= MAX_WORD
      && typeof word.s === 'string' && /^[ \n]{0,2}$/.test(word.s) && ['x', 'y', 'w', 'h'].every((key) => number(word[key])))
    .map(({ t: text, s, x, y, w, h }) => ({ t: text, s, x, y, w, h }));
  return { blob: result.blob, width: result.width, height: result.height, unit: result.scale * POINTS_PER_CSS_PIXEL, words };
}

// --- Apertura ---

// Mostra l'invito a scegliere un PDF; message lo sostituisce con una spiegazione
function showChoose(message = t('pdfChoosePrompt')) {
  $('#choose p').textContent = message;
  $('#choose').hidden = false;
}

// Un PDF aperto in una scheda di Chrome: lo si riprende da lì (vedi tab-file.js). Se non si riesce lo
// si spiega, e si propone di sceglierlo dal computer.
async function fromUrl(src, name, tabId) {
  $('#file-name').textContent = name;
  toast(t('pdfDownloading'), 120000);
  const blob = await fetchFromTab(src, tabId, isPdfData);
  if (blob) return openFile(blob, name);
  $('#toast').hidden = true;
  showChoose(t(isLocalFile(src) ? 'pdfLocalHint' : 'pdfDownloadFailed', name));
}

// Al posto del PDF un sito può rispondere con una pagina (per esempio quella di accesso)
async function isPdfData(blob) {
  return (await blob.slice(0, 1024).text()).includes('%PDF');
}

const isImageFile = (file, name = file.name || '') => /^image\//.test(file.type) || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name);

// Un'immagine qui non serve: si apre nell'editor, come se l'avessi aperta da lì
async function openImageInEditor(blob, name) {
  try {
    (await createImageBitmap(blob)).close();
  } catch {
    toast(t('errorImage'), 6000);
    return showChoose();
  }
  const id = crypto.randomUUID();
  await purgeOldCaptures();
  await saveCapture({ id, created: Date.now(), mode: 'image', title: name, url: '', frames: [{ blob, y: 0 }] });
  location.replace(`editor.html?id=${id}`);
}

async function openFile(blob, name) {
  if (isImageFile(blob, name)) return openImageInEditor(blob, name);
  state.blob = blob;
  state.name = name || 'PDF';
  state.chosen.clear();
  state.sizes = [];
  drawPages(); // via le pagine del PDF di prima
  $('#file-name').textContent = state.name;
  document.title = `${state.name} – ${t('pdfTitle')}`;
  $('#choose').hidden = true;
  await readPdf();
}

async function readPdf(password) {
  toast(t('pdfLoading'), 120000);
  try {
    const data = await state.blob.arrayBuffer();
    const result = await ask('open', { data, password }, [data]);
    const sizes = Array.isArray(result?.sizes) ? result.sizes.slice(0, MAX_PAGES) : [];
    state.sizes = sizes.map(({ width, height }) => ({ width: Number(width) || 595, height: Number(height) || 842 }));
    $('#password').hidden = true;
    $('#toast').hidden = true;
    drawPages();
  } catch (error) {
    $('#toast').hidden = true;
    // PDF protetto: si chiede la password (code 2: quella data è sbagliata)
    if (error.message.startsWith('password:')) {
      $('#password').hidden = false;
      $('#password-note').textContent = error.message === 'password:2' ? t('pdfPasswordWrong') : '';
      $('#password-input').value = '';
      $('#password-input').focus();
      return;
    }
    console.warn('PDF', error);
    toast(t('pdfError'), 9000);
    showChoose();
  }
}

$('#password').addEventListener('submit', (e) => {
  e.preventDefault();
  readPdf($('#password-input').value);
});

// --- Pagine ---

function drawPages() {
  for (const image of pageList.querySelectorAll('img')) URL.revokeObjectURL(image.src);
  pageList.replaceChildren(...state.sizes.map((size, index) => {
    const item = document.createElement('li');
    item.dataset.page = index + 1;
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.style.setProperty('--ratio', String(size.width / size.height));
    const number = document.createElement('span');
    number.className = 'number';
    number.textContent = index + 1;
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.textContent = '✓';
    item.append(sheet, number, tick);
    thumbs.observe(item);
    return item;
  }));
  $('#hint').hidden = state.sizes.length === 0;
  for (const action of ['all', 'none']) $(`[data-action="${action}"]`).hidden = state.sizes.length < 2;
  updateChoice();
}

// Le miniature si disegnano quando la pagina sta per comparire sullo schermo
const thumbs = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbs.unobserve(entry.target);
    drawThumb(entry.target);
  }
}, { rootMargin: '400px' });

async function drawThumb(item) {
  const number = Number(item.dataset.page);
  const scale = (THUMB_WIDTH * (window.devicePixelRatio || 1)) / state.sizes[number - 1].width;
  try {
    const { blob } = cleanPage(await ask('render', { page: number, scale, text: false, type: 'image/jpeg' }));
    const image = new Image();
    image.alt = '';
    image.src = URL.createObjectURL(blob);
    item.querySelector('.sheet').append(image);
  } catch (error) {
    // pagina che non si disegna: resta il foglio bianco
    console.warn('miniatura', number, error);
  }
}

function updateChoice() {
  const pages = state.sizes.length;
  const chosen = state.chosen.size;
  for (const item of pageList.children) item.classList.toggle('chosen', state.chosen.has(Number(item.dataset.page)));
  $('#count').textContent = pages
    ? `${t(pages === 1 ? 'pdfPagesOne' : 'pdfPagesMany', pages)}${chosen ? ` · ${t(chosen === 1 ? 'pdfChosenOne' : 'pdfChosen', chosen)}` : ''}`
    : '';
  for (const action of ['editor', 'document', 'dossier']) {
    const button = $(`[data-action="${action}"]`);
    if (button) button.disabled = !chosen || state.busy;
  }
  const editor = $('[data-action="editor"]');
  if (chosen > MAX_EDITOR_TABS) editor.disabled = true;
  editor.title = t(chosen > MAX_EDITOR_TABS ? 'pdfTooMany' : 'pdfOpenEditorTitle');
}

// Clic: sceglie o lascia una pagina; con Maiusc tutte quelle fino all'ultima cliccata
pageList.addEventListener('click', (e) => {
  const item = e.target.closest('li');
  if (!item) return;
  const number = Number(item.dataset.page);
  if (e.shiftKey && state.anchor) {
    const [from, to] = [state.anchor, number].sort((a, b) => a - b);
    for (let n = from; n <= to; n++) state.chosen.add(n);
  } else if (state.chosen.has(number)) {
    state.chosen.delete(number);
  } else {
    state.chosen.add(number);
  }
  state.anchor = number;
  updateChoice();
});

// Doppio clic: quella pagina, da sola, nell'editor
pageList.addEventListener('dblclick', (e) => {
  const item = e.target.closest('li');
  if (!item) return;
  state.chosen = new Set([Number(item.dataset.page)]);
  updateChoice();
  openInEditor();
});

// --- Dove vanno le pagine ---

const chosenPages = () => [...state.chosen].sort((a, b) => a - b);
const pageTitle = (number) => t('pdfPageTitle', state.name.replace(/\.pdf$/i, ''), number);

// Disegna le pagine scelte, a grandezza piena e con il testo, una alla volta; each(page, number, index).
// Restituisce false se qualcosa è andato storto (l'avviso lo dice già).
async function eachChosen(each) {
  if (state.busy) return false;
  state.busy = true;
  updateChoice();
  const numbers = chosenPages();
  try {
    for (const [index, number] of numbers.entries()) {
      toast(t('pdfPreparing', index + 1, numbers.length), 120000);
      const scale = UNIT / POINTS_PER_CSS_PIXEL;
      await each(cleanPage(await ask('render', { page: number, scale, text: true })), number, index);
    }
  } catch (error) {
    console.error(error);
    toast(t('errorFailed', error.message), 7000);
    return false;
  } finally {
    state.busy = false;
    updateChoice();
  }
  return true;
}

// Ogni pagina si apre nell'editor in una scheda sua, come una cattura: con il testo da copiare
async function openInEditor() {
  if (state.chosen.size > MAX_EDITOR_TABS) return toast(t('pdfTooMany'), 6000);
  await purgeOldCaptures();
  const tab = await chrome.tabs.getCurrent();
  const done = await eachChosen(async (page, number, index) => {
    const id = crypto.randomUUID();
    await saveCapture({
      id, created: Date.now(), mode: 'image', title: pageTitle(number), url: '', dpr: page.unit,
      frames: [{ blob: page.blob, y: 0 }], text: { scale: 1, words: page.words },
    });
    await chrome.tabs.create({ url: `editor.html?id=${id}`, index: tab.index + 1 + index, openerTabId: tab.id, active: index === 0 });
  });
  if (done) $('#toast').hidden = true;
}

// Miniatura per il pannello del documento: la parte alta della pagina, rimpicciolita (come in document.js)
async function thumbnailOf(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 440 / bitmap.width);
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.min(Math.round(bitmap.height * scale), 520)));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, bitmap.width, canvas.height / scale, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

async function addToDocument() {
  let added = 0;
  const done = await eachChosen(async (page, number) => {
    await savePage({
      id: crypto.randomUUID(), order: Date.now() + added, created: Date.now(),
      blob: page.blob, thumb: await thumbnailOf(page.blob), width: page.width, height: page.height,
      unit: page.unit, title: pageTitle(number), url: '', words: page.words,
    });
    added++;
  });
  // Le schede dell'editor aperte aggiornano il loro pannello del documento
  new BroadcastChannel('document').postMessage('changed');
  if (!done) return;
  toast(t('pdfAddedDocument', added), 8000, {
    label: t('popupDocument'),
    run: () => chrome.tabs.create({ url: 'editor.html#document' }),
  });
}

// --- Avviso sul lettore dei PDF ---

async function showNotice(show) {
  $('#notice').hidden = !show;
}

// --- Comandi ---

const actions = {
  info: () => showNotice($('#notice').hidden),
  'notice-ok': () => {
    showNotice(false);
    chrome.storage.local.set({ pdfNotice: 'seen' });
  },
  choose: () => fileInput.click(),
  all: () => {
    state.chosen = new Set(state.sizes.map((size, index) => index + 1));
    updateChoice();
  },
  none: () => {
    state.chosen.clear();
    updateChoice();
  },
  editor: openInEditor,
  document: addToDocument,
};

document.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-action]');
  if (button && !button.disabled) actions[button.dataset.action]();
});

fileInput.addEventListener('change', () => {
  const [file] = fileInput.files;
  if (file) openFile(file, file.name);
  fileInput.value = '';
});

// Un PDF trascinato sulla pagina si apre al posto di quello mostrato
const carriesFiles = (e) => e.dataTransfer?.types.includes('Files');
window.addEventListener('dragover', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  document.body.classList.add('drop');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('drop');
});
window.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  document.body.classList.remove('drop');
  // Un PDF, oppure un'immagine (che va nell'editor)
  const files = [...e.dataTransfer.files];
  const file = files.find((entry) => entry.type === 'application/pdf' || /\.pdf$/i.test(entry.name)) || files.find((entry) => isImageFile(entry));
  if (file) openFile(file, file.name);
});

await loadLanguage();
localizePage();
// La prima volta si spiega come lavora il lettore dei PDF
const { pdfNotice } = await chrome.storage.local.get('pdfNotice');
showNotice(pdfNotice !== 'seen');
// Un PDF passato dall'editor (aperto o trascinato lì) arriva dall'archivio locale, come una cattura;
// uno aperto in una scheda di Chrome arriva come indirizzo, e lo si scarica da lì
const params = new URLSearchParams(location.search);
const capture = params.has('id') ? await loadCapture(params.get('id')) : null;
if (capture?.mode === 'pdf' && capture.blob) openFile(capture.blob, capture.title);
else if (params.has('src')) fromUrl(params.get('src'), params.get('name') || 'PDF', params.get('tab'));
else showChoose();
