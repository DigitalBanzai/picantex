// Documento a più pagine: le immagini che l'utente mette da parte dall'editor per salvarle in un
// solo PDF o stamparle insieme. Le pagine stanno nell'archivio locale finché non le toglie lui.
import { download, encode, timeStamp } from './export.js';
import { t } from './i18n.js';
import { POINTS_PER_CSS_PIXEL, imagesToPdf, paginate } from './pdf.js';
import { clearPages, deletePage, loadPages, orderPages, savePage } from './store.js';
import { documentPdfInfo, drawStamp, sha256, stampLayout, stampWords, verifyEnabled } from './verify.js';

const $ = (selector) => document.querySelector(selector);
// Misure massime delle miniature, in pixel: delle immagini lunghe si vede solo l'inizio
const THUMB_WIDTH = 440;
const THUMB_HEIGHT = 520;
const LAYOUTS = ['original', 'a4'];

const panel = $('#document');
const list = $('#doc-pages');
const layoutSelect = $('#doc-layout');
const fileInput = $('#doc-files');
// Le schede dell'editor aperte si avvisano a vicenda quando il documento cambia
const channel = new BroadcastChannel('document');

let editor; // ciò che serve dell'editor: vedi setupDocument
let pages = [];
let working = false;

// options: ready() dice se c'è un'immagine; image() la restituisce com'è ora, annotazioni comprese;
// words() il testo della pagina che vi si legge; openPdf(file) apre un PDF nella pagina dei PDF;
// docPage() la pagina del documento riaperta nell'editor, se è una di queste; openPage(page) riapre
// una pagina nell'editor; unit() sono i suoi pixel per pixel CSS; meta() titolo e indirizzo della pagina di origine;
// toast e hideToast mostrano gli avvisi; relayout() va chiamata quando cambia lo spazio per l'immagine.
export async function setupDocument(options) {
  editor = options;
  if (LAYOUTS.includes(localStorage.getItem('layout'))) layoutSelect.value = localStorage.getItem('layout');
  layoutSelect.addEventListener('change', () => {
    localStorage.setItem('layout', layoutSelect.value);
    layoutSelect.blur();
  });
  panel.addEventListener('click', onClick);
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  channel.addEventListener('message', refresh);
  // Finita una stampa, i fogli preparati non servono più
  window.addEventListener('afterprint', clearSheets);
  await refresh();
  // Aperto dal menu dell'icona per guardare il documento: il pannello si mostra in questa scheda soltanto,
  // senza diventare la scelta per le catture che verranno. Altrimenti si riapre se l'utente l'aveva lasciato aperto.
  if (location.hash === '#document') toggleDocument(true, false);
  else if (localStorage.getItem('document') === 'open') toggleDocument(true);
}

// remember: la scelta vale anche per le prossime schede dell'editor
export function toggleDocument(open = panel.hidden, remember = true) {
  panel.hidden = !open;
  if (remember) localStorage.setItem('document', open ? 'open' : 'closed');
  $('[data-action="doc-toggle"]').classList.toggle('active', open);
  askClear(false);
  editor.relayout();
}

// Un'operazione lunga alla volta, con il suo avviso; gli errori finiscono in un avviso anche loro
async function work(message, task) {
  if (working) return;
  working = true;
  editor.toast(message, 60000);
  try {
    await task();
  } catch (error) {
    console.error(error);
    editor.toast(t('errorFailed', error.message), 7000);
  } finally {
    working = false;
  }
}

// --- Elenco delle pagine ---

async function refresh() {
  pages = await loadPages();
  drawDocument();
}

// Ridisegna il pannello; va richiamata anche quando cambia la lingua
export function drawDocument() {
  for (const image of list.querySelectorAll('img')) URL.revokeObjectURL(image.src);
  list.replaceChildren(...pages.map(pageItem));
  const count = pages.length;
  $('#doc-count').textContent = count || '';
  $('#doc-title').textContent = count
    ? `${t('docTitle')} · ${t(count === 1 ? 'docPagesOne' : 'docPagesMany', count)}`
    : t('docTitle');
  $('#doc-empty').hidden = count > 0;
  $('[data-doc="add"]').disabled = !editor.ready();
  // Una pagina riaperta nell'editor si aggiorna al suo posto, invece di aggiungerne un'altra
  const reopened = pages.findIndex((page) => page.id === editor.docPage());
  $('[data-doc="add"] span').textContent = reopened >= 0 ? t('docUpdatePage', reopened + 1) : t('docAdd');
  for (const action of ['save', 'print', 'clear']) $(`[data-doc="${action}"]`).disabled = count === 0;
  if (!count) askClear(false);
}

function pageItem(page, index) {
  const item = document.createElement('li');
  item.draggable = true;
  item.dataset.id = page.id;
  item.title = t('docDragTitle');

  const image = new Image();
  image.src = URL.createObjectURL(page.thumb);
  image.alt = '';
  image.draggable = false;
  const number = document.createElement('span');
  number.className = 'number';
  number.textContent = index + 1;
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = `${page.width} × ${page.height}`;
  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.dataset.doc = 'remove';
  remove.title = t('docRemoveTitle');
  remove.textContent = '✕';

  item.append(image, number, remove, size);
  return item;
}

// Il documento è cambiato: lo sanno anche le altre schede dell'editor
async function changed() {
  channel.postMessage('changed');
  await refresh();
}

// Trascinando una miniatura la si sposta tra le altre; al rilascio l'ordine viene salvato
let dragged = null;
list.addEventListener('dragstart', (e) => {
  dragged = e.target.closest('li');
  dragged.classList.add('dragging');
  // Lasciata nell'area di lavoro invece che nel pannello, la pagina si riapre nell'editor
  e.dataTransfer.setData(PAGE_TYPE, dragged.dataset.id);
  e.dataTransfer.effectAllowed = 'copyMove';
});
list.addEventListener('dragover', (e) => {
  if (!dragged) return;
  e.preventDefault();
  const over = e.target.closest('li');
  if (!over || over === dragged) return;
  const box = over.getBoundingClientRect();
  if (e.clientY > box.top + box.height / 2) over.after(dragged);
  else over.before(dragged);
});
list.addEventListener('dragend', async () => {
  if (!dragged) return;
  dragged.classList.remove('dragging');
  dragged = null;
  await orderPages([...list.children].map((item) => item.dataset.id));
  await changed();
});

// Una pagina trascinata nell'area di lavoro, o con un doppio clic, si riapre nell'editor
const PAGE_TYPE = 'application/x-picantex-page';
const stage = $('#stage');
stage.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes(PAGE_TYPE)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  stage.classList.add('drop');
});
stage.addEventListener('dragleave', (e) => {
  if (!stage.contains(e.relatedTarget)) stage.classList.remove('drop');
});
stage.addEventListener('drop', (e) => {
  const id = e.dataTransfer?.getData(PAGE_TYPE);
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  stage.classList.remove('drop');
  reopen(id);
});
list.addEventListener('dblclick', (e) => {
  const item = e.target.closest('li');
  if (item && !e.target.closest('[data-doc]')) reopen(item.dataset.id);
});

function reopen(id) {
  const page = pages.find((entry) => entry.id === id);
  if (page) editor.openPage(page);
}

// --- Azioni ---

function onClick(e) {
  const button = e.target.closest('[data-doc]');
  if (!button || button.disabled) return;
  const run = {
    close: () => toggleDocument(false),
    add: addPage,
    files: () => fileInput.click(),
    remove: () => removePage(button.closest('li').dataset.id),
    save: savePdf,
    print: () => printImages(pages.map(sourceOf)),
    clear: () => askClear(true),
    'clear-no': () => askClear(false),
    'clear-yes': emptyDocument,
  };
  run[button.dataset.doc]();
}

// Miniatura dell'immagine: la parte alta, rimpicciolita
function thumbnail(canvas) {
  const scale = Math.min(1, THUMB_WIDTH / canvas.width);
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(canvas.width * scale));
  small.height = Math.max(1, Math.min(Math.round(canvas.height * scale), THUMB_HEIGHT));
  const ctx = small.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, small.width, small.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, canvas.width, small.height / scale, 0, 0, small.width, small.height);
  return new Promise((resolve) => small.toBlob(resolve, 'image/jpeg', 0.85));
}

// Mette una pagina in fondo al documento. image: l'immagine da cui fare la miniatura;
// blob: il file che la contiene; unit: i suoi pixel per pixel CSS; words: il testo che vi si legge,
// che nel PDF diventa cercabile; captured: quando è stata catturata o aperta (vedi verify.js).
async function appendPage(image, blob, unit, title = '', url = '', words = [], captured = Date.now()) {
  await savePage({
    id: crypto.randomUUID(),
    order: Date.now(), // dopo tutte le altre, anche se sono state riordinate
    created: Date.now(),
    captured,
    blob,
    thumb: await thumbnail(image),
    width: image.width,
    height: image.height,
    unit,
    title,
    url,
    words,
  });
}

// Aggiunge in fondo al documento l'immagine dell'editor, così come si vede in questo momento.
// Se l'immagine è una pagina del documento riaperta, la aggiorna al suo posto.
function addPage() {
  const reopened = pages.find((page) => page.id === editor.docPage());
  if (reopened) return updatePage(reopened);
  return work(t('docAdding'), async () => {
    const canvas = editor.image();
    const snapshot = editor.snapshot(); // lo stato che finisce nel documento
    const { title, url, captured } = editor.meta();
    await appendPage(canvas, await encode(canvas, 'png'), editor.unit(), title, url, editor.words(), captured);
    await changed();
    list.lastElementChild?.scrollIntoView({ block: 'nearest' });
    editor.toast(t('docAdded', pages.length));
    editor.markSaved(snapshot); // l'immagine annotata è al sicuro nel documento
  });
}

function updatePage(page) {
  return work(t('docAdding'), async () => {
    const canvas = editor.image();
    const snapshot = editor.snapshot();
    await savePage({
      ...page,
      blob: await encode(canvas, 'png'),
      thumb: await thumbnail(canvas),
      width: canvas.width,
      height: canvas.height,
      unit: editor.unit(),
      words: editor.words(),
    });
    await changed();
    editor.toast(t('docPageUpdated', pages.findIndex((entry) => entry.id === page.id) + 1));
    editor.markSaved(snapshot);
  });
}

// Aggiunge come pagine, nell'ordine in cui arrivano, le immagini scelte o trascinate dal computer.
// Ogni file resta com'è: non viene ricodificato.
function addFiles(files) {
  // Di un PDF si scelgono le pagine nella pagina dei PDF, da cui si aggiungono al documento
  const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  for (const pdf of files.filter(isPdf)) editor.openPdf(pdf);
  files = files.filter((file) => !isPdf(file));
  if (!files.length) return undefined;
  return work(t('docAdding'), async () => {
    let added = 0;
    for (const file of files) {
      const bitmap = await createImageBitmap(file).catch(() => null);
      if (!bitmap) continue; // non è un'immagine che il browser sa aprire
      // Come per le immagini aperte nell'editor, vale la densità dello schermo
      await appendPage(bitmap, file, window.devicePixelRatio || 1, file.name);
      bitmap.close();
      added++;
    }
    if (added) await changed();
    list.lastElementChild?.scrollIntoView({ block: 'nearest' });
    const skipped = files.length - added;
    editor.toast(t('docFilesAdded', added) + (skipped ? ` · ${t('docFilesSkipped', skipped)}` : ''), skipped ? 7000 : 3500);
  });
}

// I file trascinati sul pannello diventano pagine; altrove nell'editor verrebbero aperti come immagine
const carriesFiles = (e) => e.dataTransfer?.types.includes('Files');
panel.addEventListener('dragover', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  $('#stage').classList.remove('drop');
  panel.classList.add('drop');
});
panel.addEventListener('dragleave', (e) => {
  if (!panel.contains(e.relatedTarget)) panel.classList.remove('drop');
});
panel.addEventListener('drop', (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  e.stopPropagation();
  panel.classList.remove('drop');
  addFiles([...e.dataTransfer.files]);
});

async function removePage(id) {
  await deletePage(id);
  await changed();
}

// Svuotare il documento è definitivo: prima si chiede conferma, lì accanto
function askClear(asking) {
  $('#doc-confirm').hidden = !asking;
  $('[data-doc="clear"]').hidden = asking;
}

async function emptyDocument() {
  await clearPages();
  await changed();
  editor.toast(t('docCleared'));
}

// Immagine di una pagina, pronta per il PDF o la stampa; viene preparata solo quando serve.
// stamped: con il timbro della pagina sotto l'immagine (vedi verify.js), anche nel testo del PDF.
function sourceOf(page, stamped = false) {
  const layout = stamped && stampLayout(page.width, page.unit, { url: page.url, title: page.title, captured: page.captured ?? page.created });
  return {
    pixelsPerPoint: page.unit / POINTS_PER_CSS_PIXEL,
    words: layout ? [...(page.words || []), ...stampWords(layout, page.height)] : page.words,
    canvas: async () => {
      const bitmap = await createImageBitmap(page.blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
      bitmap.close();
      return layout ? drawStamp(canvas, layout, page.unit) : canvas;
    },
  };
}

// Mette nel documento l'immagine dell'editor (o aggiorna la pagina riaperta); la usa anche "Continua da qui"
export function addToDocument() {
  return addPage();
}

// Salva tutte le pagine in un PDF; la usa anche l'editor per l'avviso delle catture a tappe
export function saveDocumentPdf() {
  return savePdf();
}

function savePdf() {
  return work(t('preparing'), async () => {
    const verify = await verifyEnabled();
    const stamped = verify && editor.stamp();
    const pdf = await imagesToPdf(pages.map((page) => sourceOf(page, stamped)), layoutSelect.value === 'a4', stamped ? documentPdfInfo() : null);
    // Da qui in poi è aperta la finestra di salvataggio: l'avviso "preparo il file" non serve più
    editor.hideToast();
    const name = await download(pdf, `document_${timeStamp()}.pdf`);
    if (name) editor.toast(t('docSaved'), 8000);
    else editor.toast(t('saveCancelled'));
    if (name && verify) editor.fingerprint({ name, hash: await sha256(pdf), saved: Date.now() });
  });
}

// --- Stampa ---

function clearSheets() {
  const area = $('#print-area');
  for (const image of area.querySelectorAll('img')) URL.revokeObjectURL(image.src);
  area.replaceChildren();
}

// Stampa le immagini su fogli A4, impaginate come nel PDF: [{ canvas, pixelsPerPoint }]
export function printImages(images) {
  return work(t('printing'), async () => {
    clearSheets();
    for (const image of images) {
      const canvas = typeof image.canvas === 'function' ? await image.canvas() : image.canvas;
      const { scale, slices } = paginate(canvas, image.pixelsPerPoint);
      for (const { top, rows } of slices) {
        const piece = new OffscreenCanvas(canvas.width, rows);
        piece.getContext('2d').drawImage(canvas, 0, -top);
        const picture = new Image();
        picture.src = URL.createObjectURL(await piece.convertToBlob());
        picture.style.width = `${canvas.width * scale}pt`;
        picture.style.height = `${rows * scale}pt`;
        const sheet = document.createElement('div');
        sheet.className = 'sheet';
        sheet.append(picture);
        $('#print-area').append(sheet);
        await picture.decode();
      }
    }
    editor.hideToast();
    window.print();
  });
}
