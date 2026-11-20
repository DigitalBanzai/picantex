import { pickElement, selectArea } from './content_selection.js';
import { loadLanguage, t } from './i18n.js';
import { buildBase } from './frames.js';
import { purgeOldCaptures, removeStaleDatabases, saveCapture, savePage } from './store.js';
// <notes>
import {
  addPanelNote, focusInPanel, incognitoSession, isNoteKey, listNotes, NOTE_PREFIX, noteMemory, notesAllowed, notesChanged,
  releaseNoteTab,
} from './note.js';
// </notes>
// Altezza massima, in pixel reali, di un'immagine nell'editor: una cattura a pagina intera più lunga
// procede a tappe di questa misura, e ogni tappa diventa una pagina del documento (vedi captureFull)
const MAX_FULL_HEIGHT = 30000;
// Rete di sicurezza contro le pagine senza fine: oltre questa altezza, in pixel CSS, la cattura si ferma
const MAX_TOTAL_CSS = 1_000_000;
// Chrome consente al massimo 2 chiamate al secondo a captureVisibleTab
const CAPTURE_INTERVAL_MS = 600;

// Stile applicato alla pagina mentre viene catturata per intero
const CAPTURE_CSS = `
  html { scroll-behavior: auto !important; scrollbar-width: none !important; }
  html::-webkit-scrollbar { display: none !important; }
  [data-picantex-hidden] {
    visibility: hidden !important; opacity: 0 !important;
    transition: none !important; animation: none !important;
  }`;

// Voci del menu contestuale: modalità di cattura -> chiave del testo in _locales
const MENU_ITEMS = {
  visible: 'menuVisible', selection: 'menuSelection', element: 'menuElement', full: 'menuFull',
};
const MENU_ROOT = 'picantex';
const MENU_CONTEXTS = ['page', 'selection', 'link', 'image', 'video', 'audio', 'editable', 'frame'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Nelle finestre in incognito lavora una parte di Picantex tutta sua (manifest: "incognito": "split"), con
// un suo servizio: catture, documenti, dossier e download dell'incognito restano lì, nella memoria di
// Chrome, e spariscono con la sessione in incognito. chrome.storage invece è lo stesso per le due parti.
const INCOGNITO = chrome.extension.inIncognitoContext;

// Scelta dell'utente, dal menu dell'icona: far scorrere anche i riquadri interni delle pagine.
// È spenta finché non la accende: senza, si cattura solo ciò che scorre con la pagina.
const followsPanels = async () => (await chrome.storage.local.get('panels')).panels === true;

// Testi che vivono fuori dalle pagine dell'estensione: menu contestuale e suggerimento sull'icona.
// Una volta per volta: due rifacimenti accavallati (la lingua cambiata due volte di fila, o l'avvio
// insieme a un aggiornamento) creerebbero due volte le stesse voci.
let languageApplied = Promise.resolve();
function applyLanguage() {
  languageApplied = languageApplied.then(rebuildMenu, rebuildMenu);
  return languageApplied;
}

async function rebuildMenu() {
  await loadLanguage();
  chrome.action.setTitle({ title: t('actionTitle') });
  await chrome.contextMenus.removeAll();
  // Una voce "Picantex" con dentro i tre comandi: senza, Chrome userebbe come titolo il nome lungo dell'estensione
  chrome.contextMenus.create({ id: MENU_ROOT, title: 'Picantex', contexts: MENU_CONTEXTS });
  for (const [id, key] of Object.entries(MENU_ITEMS)) {
    chrome.contextMenus.create({ id, parentId: MENU_ROOT, title: t(key), contexts: MENU_CONTEXTS });
  }
  // <notes>
  // Le note: Chrome concede a un'estensione una sola voce principale, quindi stanno qui sotto. La nota a
  // margine (a fianco, nel pannello).
  chrome.contextMenus.create({ id: 'notes-line', parentId: MENU_ROOT, type: 'separator', contexts: MENU_CONTEXTS });
  chrome.contextMenus.create({ id: 'add-side-note', parentId: MENU_ROOT, title: t('pageNoteSide'), contexts: MENU_CONTEXTS });
  // </notes>
}

chrome.runtime.onInstalled.addListener(() => {
  applyLanguage();
  removeStaleDatabases();
  purgeOldCaptures().catch(() => {});
  // <notes>
  markNoteSites();
  followPanel();
  // </notes>
});
// A ogni avvio: la lingua del browser può essere cambiata, e le catture più vecchie di 24 ore si
// cancellano anche se Picantex non viene usato
// La parte in incognito parte con la prima finestra in incognito, e non riceve né l'uno né l'altro avviso:
// il menu del tasto destro e il pannello laterale li prepara subito
if (INCOGNITO) {
  applyLanguage();
  // <notes>
  followPanel();
  // </notes>
}
chrome.runtime.onStartup.addListener(() => {
  applyLanguage();
  purgeOldCaptures().catch(() => {});
});
// Quando l'utente sceglie un'altra lingua dall'editor (o cambia la fascia: le voci delle note cambiano)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.language || changes.tier) applyLanguage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab && info.menuItemId in MENU_ITEMS) capture(info.menuItemId, tab);
  // <notes>
  // Su un testo selezionato la nota nasce con quel testo
  if (tab && info.menuItemId === 'add-side-note') addSideNote(tab, info.selectionText);
  // </notes>
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'capture') {
    // Richiesta dal popup: scheda e modalità scelte dall'utente
    chrome.tabs.get(message.tabId).then((tab) => capture(message.mode, tab, message.seconds), () => {});
    sendResponse(true);
  } else if (message.type === 'selection-done' && sender.tab) {
    // L'utente ha finito di tracciare il rettangolo sulla pagina
    capture('visible', sender.tab, { mode: 'selection', rect: message.rect, dpr: message.dpr, vw: message.vw });
  } else if (message.type === 'element-picked' && sender.tab) {
    // L'utente ha cliccato l'elemento da catturare
    capture('picked', sender.tab);
  } else if (message.type === 'resume-capture') {
    // "Continua da qui" nell'editor: si torna alla scheda della pagina e si riprende dal punto indicato,
    // solo se la scheda c'è ancora e mostra la stessa pagina
    resumeCapture(message).then(sendResponse, () => sendResponse(false));
    return true;
  } else if (message.type === 'capture-state') {
    // Il popup chiede se nella scheda c'è una cattura in corso, e di che tipo
    sendResponse(capturing.get(message.tabId) || null);
  } else if (message.type === 'stop-capture') {
    // Esc sulla pagina (sender.tab) oppure il pulsante del popup (tabId). Uno script in una scheda
    // può fermare solo la cattura della sua scheda.
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    if (capturing.has(tabId)) stopping.add(tabId);
    sendResponse(capturing.has(tabId));
  }
  // <notes>
  // Dal menu dell'icona, per scrivere subito nel pannello: si apre qui, a menu chiuso, così Chrome gli dà la
  // tastiera (vedi panelToWrite in popup.js). Con la nota a margine, una nota nel pannello nata da questa scheda
  if ((message.type === 'panel-note' || message.type === 'open-panel') && !sender.tab) {
    chrome.sidePanel.open({ windowId: message.windowId }).catch(() => {});
  }
  if (message.type === 'panel-note' && !sender.tab) chrome.tabs.get(message.tabId).then((tab) => panelNote(tab), () => {});
  // </notes>
});

// detail: i secondi di attesa per 'delayed', i dati della selezione per 'visible'
async function capture(mode, tab, detail) {
  // Una cattura alla volta per scheda: una seconda (dal menu del tasto destro) si contenderebbe lo scorrimento
  if (capturing.has(tab.id)) return;
  try {
    if (mode === 'selection') await startSelection(tab);
    else if (mode === 'element') await startElementPicker(tab);
    else if (mode === 'picked') await captureElement(tab);
    else if (mode === 'full') await captureFull(tab);
    else if (mode === 'resume') await captureFull(tab, false, detail);
    else if (mode === 'delayed') await captureDelayed(tab, detail);
    else await captureVisible(tab, detail);
  } catch (error) {
    // Scheda chiusa mentre la si catturava: non c'è più nessuno a cui mostrare l'errore
    if (!(await chrome.tabs.get(tab.id).catch(() => null))) return;
    console.error(error);
    chrome.tabs.create({
      url: `editor.html?error=${encodeURIComponent(error.message)}`,
      index: tab.index + 1,
      windowId: tab.windowId,
    });
  }
}

// Scrive sull'icona dell'estensione, per la sola scheda indicata. Se la scheda è stata chiusa non fa nulla.
// color: lo sfondo del contatore (rosso durante la pagina intera, per vederlo bene)
function setBadge(tab, text, color) {
  if (color) chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId: tab.id, text }).catch(() => {});
}

// Catture in corso, scheda per scheda: si fermano con Esc sulla pagina o dal menu dell'icona. Una pagina
// intera fermata a metà tiene gli scatti fatti fin lì; un conto alla rovescia fermato non cattura nulla.
const capturing = new Map(); // id della scheda -> 'full' | 'delayed'
const stopping = new Set();  // schede in cui l'utente ha chiesto di fermarsi

async function startTracking(tab, kind) {
  capturing.set(tab.id, kind);
  stopping.delete(tab.id);
  await loadLanguage();
  // Il suggerimento dell'icona lo dice: Esc ferma la cattura (sulla pagina non si scrive nulla, finirebbe nello scatto)
  chrome.action.setTitle({ tabId: tab.id, title: t('actionStopTitle') }).catch(() => {});
}

function stopTracking(tab) {
  capturing.delete(tab.id);
  stopping.delete(tab.id);
  chrome.action.setTitle({ tabId: tab.id, title: t('actionTitle') }).catch(() => {});
}

let lastCaptureAt = 0;
// Fotografa l'area visibile della scheda rispettando il limite di frequenza di Chrome
async function grab(tab) {
  const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return await (await fetch(dataUrl)).blob();
  } finally {
    lastCaptureAt = Date.now();
  }
}

// Salva la cattura e apre l'editor accanto alla scheda di origine.
// data.note, se presente, è la chiave di un avviso che l'editor mostrerà tradotto.
async function openEditor(tab, data) {
  const id = crypto.randomUUID();
  // Una cattura di un PDF aperto nel lettore di Chrome: l'editor proporrà di aprire il PDF con Picantex
  const pdf = await runInPage(tab, () => document.contentType === 'application/pdf').catch(() => false);
  await purgeOldCaptures();
  await saveCapture({ id, created: Date.now(), title: tab.title || '', url: tab.url || '', pdf, tabId: tab.id, ...data });
  await chrome.tabs.create({
    url: `editor.html?id=${id}`,
    index: tab.index + 1,
    windowId: tab.windowId,
    openerTabId: tab.id,
  });
}

// Testo che si vede nella scheda, con la posizione di ogni parola: l'editor lo usa per copiare il
// testo di un'area. null nelle pagine dove gli script non sono ammessi.
function readText(tab) {
  return runInPage(tab, pageText).catch(() => null);
}

async function captureVisible(tab, extra = {}) {
  const text = await readText(tab);
  const blob = await grab(tab);
  const { vw, ...rest } = extra;
  // Un'area scelta sulla pagina si ritaglia, e il testo si colloca, con le misure della foto (vedi photoScale)
  if (vw && rest.dpr) rest.dpr = await photoScale(blob, vw, rest.dpr);
  if (text?.vw) text.scale = await photoScale(blob, text.vw, text.scale);
  await openEditor(tab, { mode: 'visible', frames: [{ blob, y: 0 }], text, ...rest });
}

// Cattura l'area visibile dopo un conto alla rovescia: dà il tempo di aprire menu e
// suggerimenti che sparirebbero cliccando l'icona dell'estensione
async function captureDelayed(tab, seconds) {
  const count = Math.min(Math.max(Math.round(seconds) || 3, 1), 30);
  await startTracking(tab, 'delayed');
  // Il contatore compare sull'icona e, dove Chrome lo permette, in un angolo della pagina
  const onPage = chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: pageCountdown, args: [count] })
    .catch(() => {});
  let stopped = false;
  try {
    for (let tick = count * 10; tick > 0 && !stopped; tick--) {
      setBadge(tab, String(Math.ceil(tick / 10)));
      await sleep(100);
      stopped = stopping.has(tab.id);
    }
  } finally {
    setBadge(tab, '');
    stopTracking(tab);
  }
  if (stopped) {
    // Fermato: si toglie il contatore dalla pagina e non si cattura nulla
    await runInPage(tab, () => window.__picantexCountdown?.stop()).catch(() => {});
    return;
  }
  await onPage; // la pagina ha tolto il suo contatore e si è ridisegnata
  // Si fotografa ciò che la finestra mostra: dev'essere ancora questa scheda (se è stata chiusa, tabs.get fallisce).
  // Indirizzo e titolo sono quelli di adesso: durante l'attesa la pagina può averli cambiati.
  const current = await chrome.tabs.get(tab.id);
  if (!current.active) throw new Error('errorTabChanged'); // chiave: la traduce l'editor
  await captureVisible(current);
}

async function startSelection(tab) {
  try {
    await loadLanguage();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: selectArea,
      args: [t('selectionHint'), { capture: t('areaCapture'), cancel: t('areaCancel'), adjust: t('areaAdjustHint') }],
    });
  } catch {
    // Pagine protette (chrome://, Web Store...): gli script non sono ammessi
    await captureVisible(tab, { note: 'noteSelectionBlocked' });
  }
}

async function startElementPicker(tab) {
  try {
    await loadLanguage();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: pickElement, args: [t('elementHint'), await followsPanels()],
    });
  } catch {
    await captureVisible(tab, { note: 'noteSelectionBlocked' });
  }
}

// Pixel reali per pixel CSS di una foto della scheda. Di solito è la densità dello schermo, ma nella
// modalità dispositivo dello strumento per sviluppatori la pagina dichiara la densità del telefono
// emulato mentre la foto ha quella dello schermo vero: contano le misure della foto.
async function photoScale(blob, cssWidth, declared) {
  const bitmap = await createImageBitmap(blob);
  const measured = bitmap.width / cssWidth;
  bitmap.close();
  return Math.abs(measured - declared) > 0.02 ? measured : declared;
}

// Esegue una funzione dentro la pagina e ne restituisce il risultato
async function runInPage(tab, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  return result;
}

// Cattura l'elemento scelto dall'utente. Se si vede tutto basta uno scatto; se è più grande della
// finestra, o è un riquadro con del contenuto nascosto, lo si fa scorrere e si tiene solo la sua area.
async function captureElement(tab) {
  const view = await runInPage(tab, pageRevealElement, [await followsPanels()]);
  if (!view) throw new Error('errorElementGone'); // chiave: la traduce l'editor
  if (!view.fits) return captureFull(tab, true);
  let blob;
  let text;
  try {
    text = await readText(tab);
    blob = await grab(tab);
  } finally {
    await runInPage(tab, pageRestore).catch(() => {});
  }
  if (text?.vw) text.scale = await photoScale(blob, text.vw, text.scale);
  await openEditor(tab, {
    mode: 'selection',
    frames: [{ blob, y: 0 }],
    rect: view.rect,
    dpr: await photoScale(blob, view.vw, view.dpr),
    text,
    note: view.missed ? 'notePanelsOff' : undefined,
  });
}

// Cattura tutto ciò che scorre: la pagina oppure, se l'utente lo ha chiesto, il riquadro che scorre
// al suo interno quando la pagina sta ferma. usePicked: si cattura l'elemento scelto con startElementPicker.
// resumeFrom: "Continua da qui", pixel CSS dall'inizio della pagina da cui riprendere una cattura fermata
async function captureFull(tab, usePicked = false, resumeFrom = null) {
  const target = { tabId: tab.id };

  let page;
  try {
    await chrome.scripting.insertCSS({ target, css: CAPTURE_CSS });
    page = await runInPage(tab, pagePrepare, [MAX_FULL_HEIGHT, MAX_TOTAL_CSS, usePicked, await followsPanels(), resumeFrom]);
  } catch {
    // pagePrepare può essersi fermata a metà: la pagina torna com'era (anche l'ascoltatore di Esc)
    await runInPage(tab, pageRestore).catch(() => {});
    await chrome.scripting.removeCSS({ target, css: CAPTURE_CSS }).catch(() => {});
    await captureVisible(tab, { note: 'noteFullBlocked' });
    return;
  }

  let shots = [];
  const parts = []; // tappe già messe nel documento (vedi savePart)
  // Una ripresa comincia esattamente dove si era fermata la cattura precedente, e va tutta nel documento
  const resuming = resumeFrom !== null && Boolean(page?.staged);
  const top = () => (resuming && !parts.length ? page.from : shots[0].y);
  const started = Date.now();
  let stopped = false;
  await loadLanguage();
  await startTracking(tab, 'full');
  try {
    if (!page) throw new Error('errorElementGone'); // chiave: la traduce l'editor
    const count = page.positions.length;
    for (const [index, y] of page.positions.entries()) {
      // Fermata con Esc, dal riquadro o dal menu dell'icona: si tengono gli scatti fatti (almeno il primo)
      if (index > 0 && stopping.has(tab.id)) {
        stopped = true;
        break;
      }
      // L'avanzamento si vede sull'icona, in rosso, e davanti al titolo della scheda: niente sulla pagina,
      // che finirebbe nelle foto (e nasconderlo a ogni scatto la farebbe lampeggiare)
      const percent = `${Math.floor((index / count) * 100)}%`;
      setBadge(tab, percent, '#c62828');
      runInPage(tab, pageTitleProgress, [`⏺ ${percent}`]).catch(() => {});
      const scrolledTo = await runInPage(tab, pageScrollTo, [y, index, count, resuming]);
      if (!(await chrome.tabs.get(tab.id)).active) {
        throw new Error('errorTabChanged'); // chiave: la traduce l'editor
      }
      const text = await readText(tab);
      const blob = await grab(tab);
      if (index === 0) page.dpr = await photoScale(blob, page.view.w, page.dpr);
      // Tappa piena: ciò che è stato catturato fin qui diventa una pagina del documento e lascia la memoria;
      // la tappa successiva comincia esattamente dove finisce questa
      if (page.staged && shots.length && (scrolledTo + page.view.h - shots[0].y) * page.dpr > MAX_FULL_HEIGHT) {
        parts.push(await savePart(tab, page, shots, scrolledTo, started, top()));
        shots = [];
      }
      shots.push({ blob, y: scrolledTo, words: text?.words });
    }
  } finally {
    setBadge(tab, '');
    stopTracking(tab);
    await runInPage(tab, pageRestore).catch(() => {});
    await chrome.scripting.removeCSS({ target, css: CAPTURE_CSS }).catch(() => {});
  }

  // Fermata a metà (o al limite di sicurezza): l'editor potrà proporre di continuare da dove finisce
  const last = shots.at(-1);
  const resume = page.staged && last && (stopped || page.truncated)
    ? { tabId: tab.id, url: tab.url, from: Math.round(last.y + page.view.h) }
    : undefined;

  if (parts.length || resuming) {
    // Cattura a tappe: anche l'ultima va nel documento; l'editor si apre sulla prima, che vi si aggiorna al suo posto
    parts.push(await savePart(tab, page, shots, null, started, top()));
    new BroadcastChannel('document').postMessage('changed'); // le schede dell'editor già aperte aggiornano il pannello
    const [first] = parts;
    await openEditor(tab, {
      mode: 'full',
      dpr: page.dpr,
      frames: [{ blob: first.blob, y: 0 }],
      text: { scale: 1, words: first.words },
      docPage: first.id,
      captured: started,
      long: { parts: parts.length, resumed: resuming },
      resume,
      note: stopped ? 'noteStopped' : page.truncated ? 'noteTruncated' : undefined,
    });
    return;
  }

  const arranged = arrange(page, shots);
  // Fermata a metà: l'area dell'elemento scelto non va oltre ciò che è stato catturato
  if (stopped && arranged.rect) {
    const height = arranged.size ? arranged.size.h : shots.at(-1).y - shots[0].y + page.view.h;
    arranged.rect.h = Math.max(1, Math.min(arranged.rect.h, height - arranged.rect.y));
  }
  await openEditor(tab, {
    mode: 'full',
    dpr: page.dpr,
    resume,
    ...arranged,
    note: stopped ? 'noteStopped' : page.truncated ? 'noteTruncated' : page.missed ? 'notePanelsOff' : undefined,
  });
}

// "Continua da qui": la scheda deve esserci ancora e mostrare la stessa pagina; la si rimette davanti
// (la foto si può fare solo della scheda visibile) e si riprende la pagina intera dal punto indicato
async function resumeCapture({ tabId, url, from }) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.url !== url || capturing.has(tab.id)) return false;
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(300);
  capture('resume', await chrome.tabs.get(tab.id), from);
  return true;
}

// Una tappa di una cattura lunga diventa una pagina del documento, con il suo testo cercabile.
// end: dove comincia la tappa successiva (pixel CSS dall'inizio della pagina); null per l'ultima.
// top: dove comincia questa tappa; in una ripresa vicino al fondo il browser può fermare lo scorrimento più
// in alto del punto richiesto, e ciò che sta sopra c'è già nella parte precedente: si taglia.
async function savePart(tab, page, shots, end, captured, top = shots[0].y) {
  const arranged = arrange(page, shots);
  const shift = shots[0].y - top; // negativo se il primo scatto parte più in alto
  const height = (end ?? shots.at(-1).y + page.view.h) - top;
  const frames = arranged.frames.map((frame) => ({ ...frame, y: frame.y + shift }));
  const canvas = await buildBase({ dpr: page.dpr, frames, size: { w: page.view.w, h: height }, fill: page.fill });
  const scale = page.dpr;
  const words = arranged.text.words
    .map((word) => ({ ...word, y: word.y + shift }))
    .filter((word) => word.y >= 0 && word.y < height)
    .map((word) => ({ t: word.t, s: word.s, x: word.x * scale, y: word.y * scale, w: word.w * scale, h: word.h * scale }));
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const id = crypto.randomUUID();
  await savePage({
    id, order: Date.now(), created: Date.now(), captured, blob, thumb: await partThumbnail(canvas),
    width: canvas.width, height: canvas.height, unit: scale, title: tab.title || '', url: tab.url || '', words,
  });
  return { id, blob, words };
}

// Miniatura per il pannello del documento, come quelle che fa l'editor (vedi document.js)
async function partThumbnail(canvas) {
  const scale = Math.min(1, 440 / canvas.width);
  const small = new OffscreenCanvas(Math.max(1, Math.round(canvas.width * scale)), Math.max(1, Math.min(Math.round(canvas.height * scale), 520)));
  const ctx = small.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, small.width, small.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, canvas.width, small.height / scale, 0, 0, small.width, small.height);
  return small.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}

// Dispone gli scatti nell'immagine finale. Ogni scatto è l'intera finestra, fotografata dopo aver
// scorso fino a y. Se a scorrere è un riquadro interno, di ogni scatto serve solo la parte che lo
// mostra (clip), da mettere all'altezza del contenuto che si vede in quel momento.
function arrange(page, shots) {
  const { clip, view } = page;
  const start = shots[0].y;
  const last = shots.at(-1);
  const scrolled = last.y - start;
  // L'area dell'elemento scelto è misurata dall'inizio del contenuto: qui parte dal primo scatto
  const rect = page.rect ? { ...page.rect, y: page.rect.y - start } : undefined;

  // Pezzi dell'immagine: ognuno è uno scatto (o una sua parte) con la posizione in cui va messo
  let pieces;
  let extra = {};
  if (!clip) {
    pieces = shots.map((shot) => ({ shot, y: shot.y - start }));
  } else if (page.layout === 'panel') {
    // Solo il contenuto del riquadro
    pieces = shots.map((shot) => ({ shot, y: shot.y - start, clip }));
    extra = { size: { w: clip.w, h: scrolled + clip.h } };
  } else {
    // Pagina intera: il primo scatto dà tutto ciò che sta sopra e di fianco al riquadro, i successivi
    // allungano solo il riquadro, l'ultimo dà la barra che gli sta sotto (strip). Dove non arriva
    // nessuno scatto resta lo sfondo della pagina.
    const { strip } = page;
    const [first] = shots;
    const below = clip.y + clip.h;
    const rest = view.h - below;
    pieces = [{ shot: first, y: 0, clip: { x: 0, y: 0, w: view.w, h: below } }];
    if (strip) {
      // Di fianco alla barra, le colonne laterali della prima schermata scendono fino in fondo alla finestra
      const end = strip.x + strip.w;
      if (strip.x > 0) pieces.push({ shot: first, y: below, clip: { x: 0, y: below, w: strip.x, h: rest } });
      if (end < view.w) pieces.push({ shot: first, x: end, y: below, clip: { x: end, y: below, w: view.w - end, h: rest } });
    }
    pieces.push(...shots.slice(1).map((shot) => ({ shot, x: clip.x, y: clip.y + shot.y - start, clip })));
    if (strip) {
      pieces.push({ shot: last, x: strip.x, y: below + scrolled, clip: { x: strip.x, y: below, w: strip.w, h: rest } });
    }
    extra = { size: { w: view.w, h: view.h + scrolled }, fill: page.fill };
  }

  return {
    frames: pieces.map(({ shot, ...place }) => ({ blob: shot.blob, ...place })),
    text: { scale: page.dpr, words: arrangeWords(pieces) },
    rect,
    ...extra,
  };
}

// Porta le parole lette a ogni scatto nella posizione che hanno nell'immagine finale. La stessa parola
// può comparire in due scatti che si toccano o si sovrappongono: si tiene una volta sola.
function arrangeWords(pieces) {
  const words = [];
  const placed = new Map(); // testo della parola -> posizioni in cui è già stata messa
  for (const { shot, x = 0, y, clip } of pieces) {
    const area = clip || { x: 0, y: 0, w: Infinity, h: Infinity };
    for (const word of shot.words || []) {
      // Vale ogni parola che tocca la parte di scatto usata
      if (word.x + word.w <= area.x || word.x >= area.x + area.w) continue;
      if (word.y + word.h <= area.y || word.y >= area.y + area.h) continue;
      const moved = { ...word, x: word.x - area.x + x, y: word.y - area.y + y };
      const twins = placed.get(word.t) || [];
      if (twins.some((twin) => Math.abs(twin.x - moved.x) < 2 && Math.abs(twin.y - moved.y) < 2)) continue;
      placed.set(word.t, [...twins, moved]);
      words.push(moved);
    }
  }
  return words;
}

// <notes>
// --- Note sulle pagine (vedi note.js) ---

// I siti con delle note: è Chrome a segnare l'icona quando se ne apre una pagina. Un pallino giallo sulle
// pagine che hanno note, tre pallini piccoli sulle altre pagine del sito. Picantex gli consegna solo
// l'elenco delle pagine e dei siti e non viene a sapere quali pagine si visitano. Le regole restano
// salvate in Chrome; si riscrivono quando cambia l'elenco, una volta per volta.
let noteSitesWritten = Promise.resolve();
let noteSites = null; // l'elenco scritto per ultimo, per non riscrivere le regole a ogni parola
function markNoteSites() {
  // In incognito l'icona non si segna: Chrome salva le regole sul disco
  if (INCOGNITO) return noteSitesWritten;
  noteSitesWritten = noteSitesWritten.then(writeNoteRules).catch((error) => {
    noteSites = null; // la prossima volta si riprova
    console.error(error);
  });
  return noteSitesWritten;
}

// Le regole di Chrome rispondono con chrome.runtime.lastError: qui diventa un errore vero
const ruled = (call) => new Promise((resolve, reject) => call(() => {
  if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
  else resolve();
}));

async function writeNoteRules() {
  // Ogni nota con una pagina d'origine la segna, anche quelle del pannello: tornando sul sito, l'icona
  // ricorda che ci sono. Una nota ancora vuota no.
  const notes = (await listNotes()).filter((note) => note.page && note.text.trim());
  const sites = [...new Set(notes.map((note) => note.site))].sort();
  const pages = [...new Set(notes.map((note) => note.page))].sort();
  if (`${sites}|${pages}` === noteSites) return;
  noteSites = `${sites}|${pages}`;
  const { onPageChanged, PageStateMatcher, SetIcon } = chrome.declarativeContent;
  await ruled((done) => onPageChanged.removeRules(undefined, done));
  if (!sites.length) return;
  // Una pagina con note: stesso indirizzo, a parte la parte dopo # (i parametri di tracciamento tolti
  // dalla nota fanno cadere il confronto: lì restano i tre pallini del sito). L'indirizzo intero: con
  // queryEquals vuoto Chrome non riconosce le pagine senza «?», cioè quasi tutte
  const pageMatcher = (key) => new PageStateMatcher({ pageUrl: { urlEquals: key } });
  // Le due regole non valgono mai insieme: quella del sito salta le pagine con note. Con una priorità più
  // alta per la pagina non basterebbe: quando una regola smette di valere Chrome lascia vuoto il suo posto,
  // e da lì in poi in quella scheda non mostra più le icone di priorità più bassa (i tre pallini)
  const [siteIcon, pageIcon] = [await markedIcon('site'), await markedIcon('page')];
  await ruled((done) => onPageChanged.addRules([{
    // Il sito, con e senza www: come l'elenco del sito nel menu dell'icona (vedi siteKey in note.js)
    conditions: sites.flatMap((site) => {
      const urlMatches = otherThan(notes.filter((note) => note.site === site).map((note) => note.page));
      return [site, `www.${site}`].map((host) => new PageStateMatcher({ pageUrl: { hostEquals: host, schemes: ['http', 'https'], urlMatches } }));
    }),
    actions: [new SetIcon({ imageData: siteIcon })],
  }, {
    conditions: pages.map(pageMatcher),
    actions: [new SetIcon({ imageData: pageIcon })],
  }], done));
}

// Un'espressione regolare (RE2, come le vuole Chrome) che vale per ogni indirizzo tranne quelli dati: le
// regole di Chrome non hanno un «diverso da». Gli indirizzi stanno in un albero di caratteri; a ogni
// carattere un indirizzo diverso può finire lì, prendere un carattere che nessuno prende, o proseguire.
function otherThan(urls) {
  const root = { next: new Map(), end: false };
  for (const url of new Set(urls)) {
    let node = root;
    for (const char of url) {
      if (!node.next.has(char)) node.next.set(char, { next: new Map(), end: false });
      node = node.next.get(char);
    }
    node.end = true;
  }
  const literal = (char) => (/[\\^$.|?*+()[\]{}\-/]/.test(char) ? `\\${char}` : char);
  const other = (node) => {
    const ways = node.end ? [] : [''];
    ways.push(node.next.size ? `[^${[...node.next.keys()].map(literal).join('')}].*` : '.+');
    for (const [char, next] of node.next) ways.push(literal(char) + other(next));
    return `(?:${ways.join('|')})`;
  };
  return `^${other(root)}$`;
}

chrome.runtime.onStartup.addListener(markNoteSites);

// Il pannello laterale con le note che ti seguono (vedi follow.js): resta aperto cambiando pagina, sito
// o scheda, e non sta dentro le pagine
function followPanel() {
  chrome.sidePanel.setOptions({ path: 'follow.html', enabled: true }).catch(() => {});
}
chrome.runtime.onStartup.addListener(followPanel);

// Le note che non restano (versione gratuita e incognito) stanno solo in memoria (vedi note.js): Chrome le
// toglie uscendo, e con loro quando sono state esportate. I passaggi che le spostano vanno uno alla volta,
// e quelli delle note normali li fa solo la parte normale di Picantex.
let notesMoved = Promise.resolve();
const moveNotes = (step) => {
  notesMoved = notesMoved.then(step).catch((error) => console.error(error));
  return notesMoved;
};
const noteKeys = (all, test = () => true) => Object.keys(all).filter((key) => isNoteKey(key) && test(all[key]));

// Un aggiornamento di Picantex svuota anche la memoria. Chrome lo installa quando Picantex è a riposo
// (pannello e menu chiusi), a qualunque ora: da quando è pronto, le note della versione gratuita hanno
// una copia sul disco che le segue, e installato l'aggiornamento tornano in memoria e la copia si toglie.
// Quelle in incognito no: per loro sparire è la promessa.
const CARRIED = 'notesCarried';
chrome.runtime.onUpdateAvailable.addListener(() => {
  if (!INCOGNITO) chrome.storage.session.set({ updateReady: true }).then(carryNotes, () => {});
});
function carryNotes() {
  if (INCOGNITO) return notesMoved;
  return moveNotes(async () => {
    const held = await chrome.storage.session.get(null);
    if (!held.updateReady) return;
    const notes = noteKeys(held, (note) => !note.incognito).map((key) => held[key]);
    if (notes.length) await chrome.storage.local.set({ [CARRIED]: notes });
    else await chrome.storage.local.remove(CARRIED);
  });
}
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'update' || INCOGNITO) return;
  moveNotes(async () => {
    const { [CARRIED]: notes = [] } = await chrome.storage.local.get(CARRIED);
    if (notes.length) await chrome.storage.session.set(Object.fromEntries(notes.map((note) => [NOTE_PREFIX + note.id, note])));
    await chrome.storage.local.remove([CARRIED, 'notesExportedAt']);
  });
});

// Riaprendo Chrome: la copia di un aggiornamento rimasto a metà si butta, e anche le note che ne fossero
// appena tornate (se l'aggiornamento si è installato all'avvio); Chrome può avvisare dell'avvio e
// dell'aggiornamento in un ordine o nell'altro, ma i passaggi vanno uno alla volta. Nella versione
// gratuita nemmeno sul disco restano note, per esempio da quando c'era la fascia Dossier.
chrome.runtime.onStartup.addListener(() => !INCOGNITO && moveNotes(async () => {
  await chrome.storage.local.remove([CARRIED, 'notesExportedAt']);
  await chrome.storage.session.remove(noteKeys(await chrome.storage.session.get(null)));
  if (!(await noteMemory())) await chrome.storage.local.remove(noteKeys(await chrome.storage.local.get(null)));
}));

// Cambiando fascia le note cambiano posto: con la fascia Dossier restano (sul disco), senza stanno in
// memoria. Quelle in incognito restano comunque in memoria. Se una nota c'è già dall'altra parte, vale la
// più recente.
function placeNotes(kept) {
  if (INCOGNITO) return notesMoved;
  return moveNotes(async () => {
    const [from, to] = kept ? [chrome.storage.session, chrome.storage.local] : [chrome.storage.local, chrome.storage.session];
    const all = await from.get(null);
    const keys = noteKeys(all, (note) => !note.incognito);
    if (!keys.length) return;
    const there = await to.get(keys);
    await to.set(Object.fromEntries(keys.filter((key) => !(there[key]?.updated >= all[key].updated)).map((key) => [key, all[key]])));
    await from.remove(keys);
  });
}

// In incognito le note durano quanto la sessione in incognito: chiusa l'ultima finestra spariscono, e
// quelle di una sessione già finita (se Chrome non ha fatto in tempo a dirlo) si tolgono appena ne
// comincia un'altra (vedi incognitoSession in note.js). Lo fa la parte in incognito, l'unica che vede
// quelle finestre.
function forgetIncognitoNotes() {
  return moveNotes(async () => {
    const open = (await chrome.windows.getAll()).length > 0;
    const session = open ? await incognitoSession() : null;
    const held = await chrome.storage.session.get(null);
    const gone = noteKeys(held, (note) => note.incognito && note.incognito !== session);
    if (!open) gone.push('incognitoExportedAt');
    if (gone.length) await chrome.storage.session.remove(gone);
  });
}
if (INCOGNITO) {
  forgetIncognitoNotes();
  chrome.windows.onRemoved.addListener(forgetIncognitoNotes);
}
// Le schede chiuse non tengono più vivo il ricordo delle loro note (vedi goToNote in note.js)
chrome.tabs.onRemoved.addListener((tabId) => releaseNoteTab(tabId));

// La fascia, tenuta anche qui per decidere subito, nel tasto o nel clic, se aprire il pannello: dopo
// un'attesa Chrome non lo permetterebbe più (vedi addNote). Al primo risveglio del servizio vale la
// versione gratuita finché la lettura non arriva.
let memoryNow = false;
noteMemory().then((memory) => { memoryNow = memory; }, () => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tier) {
    memoryNow = changes.tier.newValue === 'dossier';
    placeNotes(memoryNow);
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (!notesChanged(changes)) return;
  markNoteSites();
  if (area === 'session') carryNotes();
});

// L'icona di Picantex segnata in basso a destra: kind 'page', un pallino giallo (note su questa pagina);
// 'site', tre pallini piccoli raggruppati (note su altre pagine del sito)
async function markedIcon(kind) {
  const icons = {};
  for (const size of [16, 32]) {
    const bitmap = await createImageBitmap(await (await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))).blob());
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, size, size);
    const dot = (x, y, radius) => {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#fdd835';
      ctx.fill();
      ctx.lineWidth = Math.max(1, size / 16);
      ctx.strokeStyle = '#26282c';
      ctx.stroke();
    };
    if (kind === 'page') {
      const radius = size * 0.24;
      dot(size - radius - size / 32, size - radius - size / 32, radius);
    } else {
      const radius = size * 0.13;
      const edge = size - radius - size / 24;
      dot(edge, edge, radius);
      dot(edge - radius * 2.3, edge, radius);
      dot(edge - radius * 1.15, edge - radius * 2.1, radius);
    }
    icons[size] = ctx.getImageData(0, 0, size, size);
  }
  return icons;
}

// Nota a margine: una nota a fianco, nel pannello, che si apre subito
function addSideNote(tab, quote) {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  panelNote(tab, quote);
}

// Una nota nel pannello, nata da una scheda: cita il testo scelto (quello del tasto destro, o quello
// selezionato sulla pagina) e ne ricorda la pagina. La crea il servizio, che resta in vita anche quando,
// aprendosi il pannello, il menu dell'icona si chiude. Il testo selezionato si legge subito, anche su una
// pagina che non ha finito di caricarsi, e anche nei riquadri della pagina dello stesso sito.
function panelNote(tab, quote) {
  (async () => {
    await loadLanguage();
    const chosen = quote ?? await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, func: () => String(getSelection() || ''), injectImmediately: true,
    }).then((frames) => frames.map((frame) => frame.result).find(Boolean) || '', () => '');
    await addPanelNote(tab, chosen);
  })().catch(() => {});
}

// Alt+M: la nota a margine. Alt+N (solo nella copia di lavoro, per ora): la nota sulla pagina con la
// fascia Dossier, a margine senza.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'add-side-note' && tab) addSideNote(tab);
});

// </notes>

// --- Funzioni eseguite dentro la pagina (devono essere autosufficienti) ---

// Misura la pagina, decide che cosa far scorrere (la finestra oppure un riquadro interno) e calcola
// le posizioni da fotografare. usePicked: va catturato l'elemento scelto dall'utente.
// panels: i riquadri interni si possono far scorrere; altrimenti scorre solo la finestra.
// maxHeight: pixel reali di un'immagine; maxTotal: pixel CSS di una cattura a tappe. Le tappe valgono per
// la pagina che scorre; un riquadro interno o un elemento scelto restano in una sola immagine.
// resumeFrom: si riparte da quel punto della pagina (solo quando scorre la pagina stessa)
function pagePrepare(maxHeight, maxTotal, usePicked, panels, resumeFrom = null) {
  const MIN_HIDDEN = 8; // sotto questa misura, in pixel, il contenuto nascosto non fa di un riquadro uno che scorre
  // Esc ferma la cattura e tiene quello che è già stato catturato (lo toglie pageRestore)
  // Solo l'Esc dell'utente (isTrusted): uno script della pagina non deve poter troncare la cattura.
  // Un ascoltatore rimasto da una cattura precedente si toglie, se no Esc resterebbe bloccato.
  if (window.__picantexStop) window.removeEventListener('keydown', window.__picantexStop, true);
  window.__picantexStop = (e) => {
    if (!e.isTrusted || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'stop-capture' });
  };
  window.addEventListener('keydown', window.__picantexStop, true);
  const dpr = window.devicePixelRatio;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const root = document.scrollingElement || document.documentElement;
  const picked = usePicked ? window.__picantexElement : null;
  if (usePicked && !picked?.isConnected) return null;

  // Il genitore di un nodo, uscendo anche dagli shadow DOM
  const parentOf = (node) => node.parentElement || node.getRootNode().host || null;
  const within = (node, container) => {
    for (let n = node; n; n = parentOf(n)) if (n === container) return true;
    return false;
  };
  // Un riquadro con del contenuto nascosto; scrolls dice se lo si può anche far scorrere
  const hides = (el) => el !== root && el.scrollHeight - el.clientHeight > MIN_HIDDEN
    && /auto|scroll|overlay/.test(getComputedStyle(el).overflowY);
  const scrolls = (el) => panels && hides(el);
  // Area interna di un riquadro, senza bordi né barre di scorrimento
  const innerBox = (el) => {
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft;
    const top = r.top + el.clientTop;
    return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight };
  };

  // Il riquadro principale tra quelli che scorrono: occupa almeno un quarto della finestra, è in
  // primo piano e, a parità di grandezza, è quello che nasconde più contenuto
  const findMain = () => {
    const found = [];
    const visit = (scope) => {
      for (const el of scope.querySelectorAll('*')) {
        if (el.shadowRoot) visit(el.shadowRoot);
        if (!hides(el) || !el.checkVisibility({ visibilityProperty: true })) continue;
        const box = innerBox(el);
        const left = Math.max(box.left, 0);
        const top = Math.max(box.top, 0);
        const w = Math.min(box.right, vw) - left;
        const h = Math.min(box.bottom, vh) - top;
        if (w <= 0 || h <= 0 || w * h < vw * vh * 0.25) continue;
        const front = document.elementFromPoint(left + w / 2, top + h / 2);
        if (!front || !(within(front, el) || within(el, front))) continue;
        found.push({ el, score: w * h * Math.sqrt(el.scrollHeight - el.clientHeight) });
      }
    };
    visit(document);
    found.sort((a, b) => b.score - a.score);
    return found[0]?.el || null;
  };

  let scroller = null; // null: scorre la finestra
  let whole = true;    // si cattura tutto ciò che scorre, non il solo elemento scelto
  // Vero se resta fuori il contenuto di un riquadro perché l'utente non ha chiesto di farli scorrere
  let missed = false;
  if (picked && scrolls(picked)) {
    scroller = picked;
  } else if (picked) {
    whole = false;
    missed = hides(picked);
    // Se l'elemento non sta nel riquadro che lo contiene, è quello a dover scorrere
    const size = picked.getBoundingClientRect();
    for (let a = parentOf(picked); a && !scroller; a = parentOf(a)) {
      if (scrolls(a) && (size.height > a.clientHeight + 1 || size.width > a.clientWidth + 1)) scroller = a;
    }
  } else {
    // La pagina è ferma (o quasi) se non ha altro da mostrare, o se il suo scorrimento è bloccato
    const html = getComputedStyle(document.documentElement).overflowY;
    const overflow = html === 'visible' && document.body ? getComputedStyle(document.body).overflowY : html;
    if (/hidden|clip/.test(overflow) || root.scrollHeight - vh <= vh * 0.1) {
      const main = findMain();
      if (panels) scroller = main;
      else missed = Boolean(main);
    }
  }

  // Posizioni da ripristinare alla fine: la finestra e ogni riquadro che può essere stato spostato
  const saved = window.__picantexCapture || { x: window.scrollX, y: window.scrollY, trail: [] };
  for (let node = scroller || picked; node; node = parentOf(node)) {
    if (!saved.trail.some(([known]) => known === node)) saved.trail.push([node, node.scrollLeft, node.scrollTop]);
  }
  if (picked) (scroller || picked).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });

  let clip = null;                      // parte della finestra in cui si vede il riquadro
  let port = { top: 0, bottom: vh };    // bordi entro cui il contenuto scorre
  const overrides = [];
  if (scroller) {
    // Niente barra, niente agganci e niente animazioni mentre lo si fa scorrere
    for (const [name, value] of [['scrollbar-width', 'none'], ['scroll-snap-type', 'none'], ['scroll-behavior', 'auto']]) {
      overrides.push([name, scroller.style.getPropertyValue(name), scroller.style.getPropertyPriority(name)]);
      scroller.style.setProperty(name, value, 'important');
    }
    const box = innerBox(scroller);
    port = { top: box.top, bottom: box.bottom };
    // Solo ciò che cade nella finestra, e sui pixel interi dello schermo: un bordo a metà pixel
    // lascerebbe una riga sfumata a ogni giunzione
    const snap = (value, round) => round(value * dpr) / dpr;
    const x = snap(Math.max(box.left, 0), Math.ceil);
    const y = snap(Math.max(box.top, 0), Math.ceil);
    clip = {
      x, y,
      w: Math.max(1, snap(Math.min(box.right, vw), Math.floor) - x),
      h: Math.max(1, snap(Math.min(box.bottom, vh), Math.floor) - y),
    };
  }

  const size = clip ? clip.h : vh; // altezza di ciò che si vede a ogni tappa
  const reach = scroller ? scroller.scrollHeight - scroller.clientHeight + size : Math.max(root.scrollHeight, vh);
  let from = 0;
  let to = reach;
  let rect;
  if (picked && !whole) {
    // Area dell'elemento rispetto all'inizio del contenuto che scorre: basta fotografare quel tratto
    const r = picked.getBoundingClientRect();
    const top = r.top - (clip ? clip.y : 0) + (scroller ? scroller.scrollTop : window.scrollY);
    rect = { x: r.left - (clip ? clip.x : 0), y: top, w: r.width, h: r.height };
    from = Math.max(0, Math.floor(top));
    to = Math.min(reach, Math.ceil(top + r.height));
  }

  if (resumeFrom !== null && !scroller && !picked) from = Math.max(0, Math.min(resumeFrom, reach - 1));

  // Nella pagina intera attorno al riquadro resta il resto della finestra, che conta nell'altezza finale
  const layout = !clip ? null : picked ? 'panel' : 'page';
  const around = layout === 'page' ? vh - size : 0;

  // Sotto il riquadro può esserci una barra larga quanto la finestra, oppure una barra solo sua con
  // di fianco le colonne laterali che scendono fino in fondo. strip dice quanta larghezza ne va presa.
  let strip = null;
  const below = clip ? clip.y + clip.h : vh;
  if (layout === 'page' && vh - below >= 1) {
    // La barra è il contenitore più esterno di ciò che sta sotto il riquadro, fra quelli che non
    // contengono anche il riquadro: la sua larghezza è quella da prendere
    let bar = null;
    const under = document.elementFromPoint(clip.x + clip.w / 2, (below + vh) / 2);
    for (let node = under; node && !within(scroller, node); node = parentOf(node)) bar = node;
    const end = clip.x + clip.w;
    const box = bar ? bar.getBoundingClientRect() : { left: clip.x, right: end };
    const left = Math.max(0, Math.floor(Math.min(box.left, clip.x)));
    const right = Math.min(vw, Math.ceil(Math.max(box.right, end)));
    strip = { x: left, w: right - left };
  }

  const staged = !clip && !rect;
  const limit = staged ? maxTotal : Math.floor(maxHeight / dpr) - around;
  const total = Math.min(to - from, Math.max(limit, size));
  // Le tappe si sovrappongono di un pixel: copre gli arrotondamenti dello scorrimento e, sugli schermi
  // a densità non intera (110%, 125%…), l'altezza dei fotogrammi in pixel reali, che non è un numero
  // intero: senza sovrapposizione ogni tanto resterebbe una riga vuota, nera nei PDF
  const step = Math.max(1, size - 1);
  const positions = [];
  const lastStop = from + total - size;
  for (let y = from; y < lastStop; y += step) positions.push(y);
  // L'ultima tappa chiede un pixel in più: il browser si ferma al vero fondo, che sugli schermi
  // ad alta densità può non essere un numero intero
  positions.push(lastStop > from ? lastStop + 1 : from);

  const fill = [document.body, document.documentElement]
    .map((el) => el && getComputedStyle(el).backgroundColor)
    .find((color) => color && !/^transparent$|^rgba\(.*,\s*0\)$/.test(color));

  window.__picantexCapture = { ...saved, scroller, clip, port, overrides, only: Boolean(picked) && !whole };
  return {
    dpr, positions, clip, layout, rect, strip, missed, staged, from, reach,
    truncated: to - from > total,
    view: { w: vw, h: vh },
    fill: fill || '#ffffff',
  };
}

// Scorre fino a y e nasconde ciò che starebbe fermo, ripetendosi in ogni scatto: elementi fissi,
// intestazioni agganciate al bordo e, quando scorre un riquadro, quello che gli sta sopra.
// resumed: cattura ripresa con "Continua da qui": nemmeno il primo scatto è l'inizio della pagina
async function pageScrollTo(y, index, count, resumed = false) {
  const { scroller, clip, port, only } = window.__picantexCapture;
  if (scroller) scroller.scrollTo({ top: y, behavior: 'instant' });
  else window.scrollTo({ left: window.scrollX, top: y, behavior: 'instant' });
  for (const el of document.querySelectorAll('[data-picantex-hidden]')) el.removeAttribute('data-picantex-hidden');

  if (count > 1) {
    const middle = (Math.max(port.top, 0) + Math.min(port.bottom, window.innerHeight)) / 2;
    // Catturando un solo elemento, tutto ciò che gli passerebbe sopra va nascosto sempre
    const picked = only ? window.__picantexElement : null;
    const hide = (el) => el.setAttribute('data-picantex-hidden', '');
    // Ciò che sta in alto resta solo nel primo scatto, ciò che sta in basso solo nell'ultimo
    const floats = (rect, first, last) => (rect.top < middle ? !first : !last);

    for (const el of (scroller || document.body).querySelectorAll('*')) {
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      // L'elemento scelto resta visibile, insieme a ciò che lo contiene; quello che ha dentro
      // segue la regola di sempre, come in una pagina intera
      const inside = picked && picked !== el && picked.contains(el);
      if (picked && !inside && el.contains(picked)) continue;
      const first = index === 0 && !resumed && (!picked || inside);
      const last = index === count - 1 && (!picked || inside);

      if (style.position === 'fixed') {
        if (floats(rect, first, last)) hide(el);
      } else {
        // Sticky: va nascosto solo quando è "agganciato" al bordo
        const stuckTop = Math.abs(rect.top - port.top - parseFloat(style.top)) < 1;
        const stuckBottom = Math.abs(port.bottom - rect.bottom - parseFloat(style.bottom)) < 1;
        if ((stuckTop && !first) || (stuckBottom && !last)) hide(el);
      }
    }

    if (scroller) {
      // Quello che copre il riquadro senza farne parte (pulsanti sospesi, barre sovrapposte) non
      // scorre con lui e si ripeterebbe: va trattato come gli elementi fissi
      const first = index === 0 && !only;
      const last = index === count - 1 && !only;
      // Il riquadro e ciò che lo contiene, uscendo anche dagli shadow DOM
      const around = new Set();
      for (let node = scroller; node; node = node.parentElement || node.getRootNode().host) around.add(node);
      for (const el of document.body.querySelectorAll('*')) {
        if (around.has(el) || scroller.contains(el)) continue;
        const rect = el.getBoundingClientRect();
        const left = Math.max(rect.left, clip.x);
        const top = Math.max(rect.top, clip.y);
        const right = Math.min(rect.right, clip.x + clip.w);
        const bottom = Math.min(rect.bottom, clip.y + clip.h);
        if (right - left < 1 || bottom - top < 1) continue;

        const style = getComputedStyle(el);
        let covers = false;
        if (style.pointerEvents === 'none') {
          // Non risponde al mouse, quindi non si può sapere se è davanti: di solito è una sfumatura sovrapposta
          covers = style.position !== 'static';
        } else {
          // È davanti se, nel suo punto centrale, lo si incontra prima del riquadro
          for (const front of document.elementsFromPoint((left + right) / 2, (top + bottom) / 2)) {
            covers = front === el || el.contains(front);
            if (covers || around.has(front) || scroller.contains(front)) break;
          }
        }
        if (covers && floats(rect, first, last)) hide(el);
      }
    }
  }

  // Lascia alla pagina il tempo di ridisegnarsi
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 150));
  return scroller ? scroller.scrollTop : window.scrollY;
}

// Legge il testo che si vede nella finestra, parola per parola, con la posizione di ogni parola.
// È il testo vero della pagina, non una lettura dell'immagine. Di ogni parola si annota anche che
// cosa la separa dalla precedente (s): niente, uno spazio, una tabulazione o un a capo.
function pageText() {
  const MAX_WORDS = 20000;
  const SKIPPED = new Set([
    'script', 'style', 'noscript', 'template', 'title', 'desc', 'iframe', 'object', 'embed',
    'canvas', 'video', 'audio', 'datalist',
  ]);
  const SPACED = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']); // staccati da una riga vuota
  const PICTURES = new Set(['img', 'picture', 'video', 'canvas', 'iframe', 'embed', 'object']);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const words = [];
  const range = document.createRange();
  const round = (value) => Math.round(value * 10) / 10;
  const inWindow = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;

  // Forza di un separatore: riga vuota, a capo, tabulazione, spazio, niente
  const rank = (sep) => (sep.includes('\n\n') ? 4 : sep.includes('\n') ? 3 : sep.includes('\t') ? 2 : sep ? 1 : 0);
  // Separatore più forte incontrato: dopo l'ultima parola presa (pending) e dopo l'ultima parola
  // della pagina, presa o no (local). Il secondo serve alla prima parola della finestra, che viene
  // dopo tutto il testo rimasto sopra: di quello conta solo la parola subito prima.
  let pending = '';
  let local = '';
  let previous = null; // area dell'ultima parola presa
  const stronger = (sep, current) => (rank(sep) > rank(current) ? sep : current);
  const bump = (sep) => {
    pending = stronger(sep, pending);
    local = stronger(sep, local);
  };
  // Una o più parole lasciate indietro: da qui in poi ciò che segue è staccato almeno da uno spazio
  const skip = (sep = ' ') => {
    pending = stronger(sep, pending);
    local = '';
  };
  // Spazi tra le parole: contano così come sono solo dove la pagina li conserva (codice, testo preformattato)
  const kept = (blank, current) => (rank(blank) >= rank(current) ? blank
    : current + blank.slice(blank.lastIndexOf('\n') + 1)); // rientro dopo un a capo già annotato
  const space = (blank, context) => {
    if (!context.keeps) return bump(' ');
    pending = kept(blank, pending);
    local = kept(blank, local);
  };

  // Vero se un elemento copre ciò che gli sta dietro: un'immagine, uno sfondo, un colore non trasparente
  const solidity = new Map();
  const isSolid = (el) => {
    if (!solidity.has(el)) {
      const style = getComputedStyle(el);
      const color = style.backgroundColor;
      const alpha = color.includes('/') ? parseFloat(color.split('/')[1])
        : color.startsWith('rgba(') ? parseFloat(color.split(',')[3]) : color === 'transparent' ? 0 : 1;
      solidity.set(el, PICTURES.has(el.localName) || style.backgroundImage !== 'none' || alpha >= 0.5);
    }
    return solidity.get(el);
  };
  // Vero se nel punto centrale dell'area si vede l'elemento el, e non qualcosa che lo copre o lo taglia
  const inFront = (r, el) => {
    const x = Math.min(Math.max((r.left + r.right) / 2, 0), vw - 1);
    const y = Math.min(Math.max((r.top + r.bottom) / 2, 0), vh - 1);
    const root = el.getRootNode();
    const scope = root.elementFromPoint ? root : document;
    if (scope.elementFromPoint(x, y) === el) return true;
    // Sopra può esserci qualcosa di trasparente (un collegamento esteso, un velo): conta solo ciò che copre
    for (const front of scope.elementsFromPoint(x, y)) {
      if (front === el) return true;
      if (isSolid(front)) return false;
    }
    return false;
  };

  const take = (text, r, context) => {
    let sep = words.length ? pending : local;
    if (previous) {
      const overlap = Math.min(r.bottom, previous.bottom) - Math.max(r.top, previous.top);
      const sameLine = overlap > Math.min(r.height, previous.height) / 2;
      const gap = r.left - previous.right;
      // Blocchi diversi ma affiancati sulla stessa riga (celle, colonne): tra loro una tabulazione, non un a capo
      if (sep === '\n' && sameLine && gap > 0) sep = '\t';
      // Attaccate nel codice della pagina ma staccate a vista: uno spazio
      else if (sep === '' && sameLine && gap > r.height * 0.2) sep = ' ';
    }
    const shown = context.upper ? text.toUpperCase() : context.lower ? text.toLowerCase() : text;
    words.push({ t: shown, x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height), s: sep });
    previous = r;
    pending = '';
    local = '';
  };

  // Vero se si vede il testo scritto dentro l'elemento (lo si chiede una volta sola per elemento)
  const visible = (context) => {
    context.shown ??= context.box.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    return context.shown;
  };

  const readText = (node, context) => {
    const text = node.nodeValue;
    if (!/\S/.test(text)) return space(text, context);
    range.selectNodeContents(node);
    // Fuori dalla finestra non c'è da misurare parola per parola: basta sapere che lì c'era del testo
    if (!inWindow(range.getBoundingClientRect()) || !visible(context) || words.length >= MAX_WORDS) {
      skip(context.keeps && text.includes('\n') ? '\n' : ' ');
      // Dopo l'ultima parola del nodo possono esserci altri spazi
      const tail = text.slice(text.search(/\s*$/));
      return tail ? space(tail, context) : undefined;
    }
    const finder = /\S+/g;
    let last = 0;
    for (let match = finder.exec(text); match; match = finder.exec(text)) {
      if (match.index > last) space(text.slice(last, match.index), context);
      last = finder.lastIndex;
      range.setStart(node, match.index);
      range.setEnd(node, last);
      const r = range.getBoundingClientRect();
      if (inWindow(r) && (context.loose || inFront(r, context.box))) take(match[0], r, context);
      else skip();
    }
    if (last < text.length) space(text.slice(last), context);
  };

  // Campi di un modulo: il testo che mostrano non è nel contenuto della pagina, è il loro valore
  const readControl = (el, context) => {
    const hidden = ['password', 'hidden', 'checkbox', 'radio', 'file', 'range', 'color', 'image'];
    let value = '';
    if (el.localName === 'select') value = el.multiple ? '' : el.selectedOptions[0]?.label || '';
    else if (el.localName === 'textarea' || !hidden.includes(el.type)) value = el.value;
    value = value.trim();
    bump(' ');
    const r = el.getBoundingClientRect();
    if (value && inWindow(r) && visible(context) && (context.loose || inFront(r, el))) take(value, r, context);
    else if (value) skip();
    bump(' ');
  };

  // box: l'elemento che fa da contenitore visibile al testo. Chi non ha un'area propria
  // (display: contents, gli <slot>) passa ai figli quello del proprio contenitore.
  const visit = (el, box) => {
    const tag = el.localName;
    if (SKIPPED.has(tag)) return;
    const style = getComputedStyle(el);
    const { display } = style;
    if (display === 'none') return;
    if (tag === 'br') return bump('\n');
    const context = {
      box: display === 'contents' ? box : el,
      keeps: style.whiteSpaceCollapse !== 'collapse',
      upper: style.textTransform === 'uppercase',
      lower: style.textTransform === 'lowercase',
      // Un elemento che non risponde al mouse non si può sapere se è coperto: lo si dà per visibile
      loose: style.pointerEvents === 'none',
    };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return readControl(el, context);

    // Che cosa stacca il contenuto dell'elemento da ciò che lo circonda
    const flowing = display === 'inline' || display === 'contents';
    const edge = SPACED.has(tag) ? '\n\n' : display === 'table-cell' ? '\t'
      : flowing ? '' : display.startsWith('inline') ? ' ' : '\n';
    bump(edge);
    // Dentro un componente con shadow DOM si vede il suo contenuto interno; nei suoi <slot>, ciò che la pagina vi ha messo
    const assigned = tag === 'slot' ? el.assignedNodes({ flatten: true }) : [];
    for (const child of el.shadowRoot ? el.shadowRoot.childNodes : assigned.length ? assigned : el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) readText(child, context);
      else if (child.nodeType === Node.ELEMENT_NODE) visit(child, context.box);
    }
    bump(edge);
  };

  if (document.body) visit(document.body, document.body);
  return { scale: window.devicePixelRatio, vw: window.innerWidth, words };
}

// Contatore in un angolo della pagina: non intercetta il mouse e sparisce prima della cattura
async function pageCountdown(seconds) {
  const badge = document.createElement('div');
  badge.id = 'picantex-countdown';
  badge.style.all = 'initial';
  Object.assign(badge.style, {
    display: 'block', position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
    minWidth: '46px', padding: '6px 0', borderRadius: '23px', textAlign: 'center',
    background: 'rgba(38, 40, 44, 0.9)', color: '#fff', font: '700 22px/1.4 system-ui, sans-serif',
    pointerEvents: 'none',
  });
  document.documentElement.appendChild(badge);
  // Esc, o il pulsante del popup (vedi captureDelayed), ferma il conto e non cattura nulla
  let stopped = false;
  const onKey = (e) => {
    if (!e.isTrusted || e.key !== 'Escape') return; // come in pagePrepare
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'stop-capture' });
    stop();
  };
  const stop = () => {
    stopped = true;
    badge.remove();
    window.removeEventListener('keydown', onKey, true);
    delete window.__picantexCountdown;
  };
  window.__picantexCountdown = { stop };
  window.addEventListener('keydown', onKey, true);
  for (let left = seconds; left > 0 && !stopped; left--) {
    badge.textContent = String(left);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (stopped) return;
  stop();
  // Aspetta che la pagina sia ridisegnata senza il contatore
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// Porta in vista l'elemento scelto, se si può vedere tutto in una volta, e ne restituisce l'area.
// Con fits = false non basta uno scatto: è più grande della finestra o del riquadro che lo contiene,
// oppure, se i riquadri interni vanno fatti scorrere (panels), è lui stesso un riquadro con del
// contenuto nascosto.
async function pageRevealElement(panels) {
  const el = window.__picantexElement;
  if (!el || !el.isConnected) return null;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const parentOf = (node) => node.parentElement || node.getRootNode().host || null;
  const hides = (node) => node !== document.scrollingElement && node.scrollHeight - node.clientHeight > 8
    && /auto|scroll|overlay/.test(getComputedStyle(node).overflowY);
  const scrolls = (node) => panels && hides(node);
  if (scrolls(el)) return { fits: false };
  let rect = el.getBoundingClientRect();
  if (rect.width > vw || rect.height > vh) return { fits: false };

  // Vero se l'elemento si vede tutto: dentro la finestra e dentro i riquadri che scorrono attorno a lui
  const shown = () => {
    rect = el.getBoundingClientRect();
    let [left, top, right, bottom] = [0, 0, vw, vh];
    for (let a = parentOf(el); a; a = parentOf(a)) {
      if (!scrolls(a)) continue;
      const box = a.getBoundingClientRect();
      left = Math.max(left, box.left + a.clientLeft);
      top = Math.max(top, box.top + a.clientTop);
      right = Math.min(right, box.left + a.clientLeft + a.clientWidth);
      bottom = Math.min(bottom, box.top + a.clientTop + a.clientHeight);
    }
    return rect.left >= left - 0.5 && rect.top >= top - 0.5 && rect.right <= right + 0.5 && rect.bottom <= bottom + 0.5;
  };

  if (!shown()) {
    const trail = [];
    for (let a = parentOf(el); a; a = parentOf(a)) trail.push([a, a.scrollLeft, a.scrollTop]);
    window.__picantexCapture = { x: window.scrollX, y: window.scrollY, trail };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (!shown()) return { fits: false };
  }
  return {
    fits: true,
    dpr: window.devicePixelRatio,
    vw: window.innerWidth,
    rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
    // È un riquadro con altro contenuto, che resta fuori perché l'utente non ha chiesto di farli scorrere
    missed: hides(el),
  };
}

// Avanzamento davanti al titolo della scheda ("⏺ 37% · Titolo"); pageRestore rimette il titolo originale.
// Se nel frattempo la pagina ha cambiato titolo da sé, si tiene il suo.
function pageTitleProgress(prefix) {
  const shown = document.title;
  const ours = window.__picantexTitle;
  const original = ours && shown === ours.shown ? ours.original : shown;
  document.title = `${prefix} · ${original}`;
  window.__picantexTitle = { original, shown: document.title };
}

// Rimette la pagina com'era prima della cattura
function pageRestore() {
  const title = window.__picantexTitle;
  if (title && document.title === title.shown) document.title = title.original;
  delete window.__picantexTitle;
  document.getElementById('picantex-area')?.remove(); // l'àncora di un'area scelta (vedi selectArea)
  if (window.__picantexStop) window.removeEventListener('keydown', window.__picantexStop, true);
  delete window.__picantexStop;
  for (const el of document.querySelectorAll('[data-picantex-hidden]')) el.removeAttribute('data-picantex-hidden');
  const saved = window.__picantexCapture;
  if (saved) {
    for (const [name, value, priority] of saved.overrides || []) {
      if (value) saved.scroller.style.setProperty(name, value, priority);
      else saved.scroller.style.removeProperty(name);
    }
    for (const [el, left, top] of saved.trail || []) el.scrollTo({ left, top, behavior: 'instant' });
    window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
  }
  delete window.__picantexCapture;
  delete window.__picantexElement;
}
