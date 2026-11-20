import { loadLanguage, localizePage, t } from './i18n.js';
import { openFileUrl, tabFileType } from './tab-file.js';
import { countPages } from './store.js';
import { openHelp, setupHints } from './hint.js';
// <notes>
import { firstWords, focusInPanel, listNotes, noteMemory, notesAllowed, pageKey, sideShortcut, siteKey } from './note.js';
// </notes>
await loadLanguage();
localizePage();

// I comandi vanno collegati subito: ciò che segue aspetta l'archivio e non deve ritardarli

// Avvia sulla scheda attiva la cattura scelta, poi chiude il popup
for (const button of document.querySelectorAll('button[data-mode]')) {
  button.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { mode, seconds } = button.dataset;
    await chrome.runtime.sendMessage({ type: 'capture', mode, seconds: Number(seconds) || undefined, tabId: tab.id });
    window.close();
  });
}

// Apre Picantex senza catturare: dall'editor si aprono immagini, PDF, il documento e i dossier
document.querySelector('[data-open]').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'editor.html' });
  window.close();
});

// Un PDF o un'immagine aperti direttamente in Chrome si possono solo fotografare: con Picantex si hanno
// tutte le pagine e il testo del PDF, o l'immagine originale. Le voci compaiono solo lì (vedi più sotto).
for (const button of document.querySelectorAll('[data-tab-file]')) {
  button.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = openFileUrl(button.dataset.tabFile, tab.url, tab.title, tab.id);
    await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
    window.close();
  });
}

// Interruttore dei riquadri che scorrono: resta salvato e vale per le catture da qui in avanti
const panels = document.querySelector('#panels');
panels.addEventListener('change', () => chrome.storage.local.set({ panels: panels.checked }));
panels.checked = (await chrome.storage.local.get('panels')).panels === true;

const [current] = await chrome.tabs.query({ active: true, currentWindow: true });

// Sulle pagine di Chrome stesso e sullo store Chrome non lascia entrare nessuna estensione: lì si può
// fotografare solo ciò che si vede. Il menu lo dice subito, invece di farlo scoprire dopo la cattura.
// La prova è uno script vuoto, che non legge nulla della pagina. Parte subito, senza aspettare che la
// pagina finisca di caricarsi: il menu deve rispondere anche su una pagina lenta.
const scriptable = await chrome.scripting.executeScript({ target: { tabId: current.id }, func: () => true, injectImmediately: true })
  .then(() => true, () => false);
if (!scriptable) {
  for (const mode of ['selection', 'element', 'full']) document.querySelector(`.modes [data-mode="${mode}"]`).disabled = true;
  document.querySelector('#restricted').hidden = false;
}

// <notes>
// Note (vedi note.js). Versione gratuita: «Aggiungi una nota» apre il pannello laterale con una nota nuova,
// che cita il testo scelto e ricorda questa pagina. Fascia Dossier: la nota si attacca alla pagina. In cima
// al menu, le note che vengono da questo sito: sulla pagina o nel pannello. In incognito solo le note del
// pannello, e solo quelle prese in incognito.
const SITE_NOTES_SHOWN = 5;
const incognito = Boolean(current.incognito);
const memory = (await noteMemory()) && !incognito;
const allowed = scriptable && notesAllowed(current.url);
// Il pannello si apre subito, nel clic: dopo un'attesa Chrome non lo permetterebbe più
const openPanel = () => chrome.sidePanel.open({ windowId: current.windowId }).catch(() => {});
// Il pannello per scriverci subito: lo apre il servizio, che ha ancora il clic, quando questo menu si è già
// chiuso. Aperto da qui, chiudendosi il menu Chrome ridarebbe la tastiera alla pagina, e scrivendo non si
// scriverebbe nella nota. message: cosa fare insieme (vedi background.js)
const panelToWrite = (message) => {
  chrome.runtime.sendMessage({ ...message, windowId: current.windowId }).catch(() => {});
  window.close();
};
// Nota a margine: una nota a fianco, nel pannello. La crea il servizio (vedi panelNote in background.js)
const sideNote = () => panelToWrite({ type: 'panel-note', tabId: current.id });
const noteSide = document.querySelector('[data-note-side]');
noteSide.addEventListener('click', sideNote);
// Il suggerimento dice anche la scorciatoia, come l'ha impostata l'utente (vedi sideShortcut)
const sideKey = await sideShortcut();
if (sideKey) noteSide.title += ` (${sideKey})`;
// Il pannello laterale (vedi follow.js)
document.querySelector('[data-note-follow]').addEventListener('click', async () => {
  await openPanel();
  window.close();
});
if (notesAllowed(current.url)) {
  const page = pageKey(current.url);
  const site = siteKey(current.url);
  const notes = (await listNotes(incognito)).filter((note) => note.site === site && (memory || note.follow)).sort((a, b) => b.updated - a.updated);
  // Nell'elenco del sito, le note con qualcosa scritto
  const written = notes.filter((note) => note.text.trim());
  if (written.length) showSiteNotes(written, page);
}

// Una nota del pannello: il pannello si apre e porta il cursore su di lei
function openInPanel(note) {
  focusInPanel(note.id, current.windowId);
  panelToWrite({ type: 'open-panel' });
}

function showSiteNotes(notes, page) {
  document.querySelector('#site-notes-head span').textContent = notes.length === 1 ? t('pageNoteSiteOne') : t('pageNoteSiteMany', notes.length);
  const list = document.querySelector('#site-notes-list');
  for (const [index, note] of notes.slice(0, SITE_NOTES_SHOWN).entries()) {
    const button = document.createElement('button');
    const words = document.createElement('b');
    words.textContent = `${index + 1}. ${t('pageNoteQuote', firstWords(note.text))}`;
    const where = document.createElement('small');
    const place = note.page === page ? t('pageNoteThisPage') : note.title || note.url;
    where.textContent = note.follow ? `${t('pageNoteInPanel')} · ${place}` : place;
    button.append(words, where);
    button.addEventListener('click', async () => {
      if (note.follow) {
        await openInPanel(note);
        return;
      }
    });
    const item = document.createElement('li');
    item.append(button);
    list.append(item);
  }
  // Tutte le note del sito ed esportarle: nella versione gratuita stanno nel pannello, con la fascia
  // Dossier nella pagina delle note, già filtrata
  const toAll = async () => {
    if (!memory) return openInPanel(notes[0]);
  };
  if (notes.length > SITE_NOTES_SHOWN) {
    const more = document.createElement('button');
    more.className = 'more';
    more.textContent = t('pageNoteMore', notes.length);
    more.addEventListener('click', toAll);
    list.append(more);
  }
  // Nella versione gratuita il pulsante apre il pannello; con la fascia Dossier esporta
  const toAllButton = document.querySelector('#site-notes-export');
  toAllButton.addEventListener('click', toAll);
  document.querySelector('#site-notes').hidden = false;
}
// </notes>

// Una cattura in corso in questa scheda si può solo fermare: della pagina intera resta la parte già
// catturata, il conto alla rovescia non cattura nulla
const running = await chrome.runtime.sendMessage({ type: 'capture-state', tabId: current.id }).catch(() => null);
if (running) {
  document.body.classList.add('capturing');
  document.querySelector('#stop').hidden = false;
  document.querySelector('#stop-note').textContent = t(running === 'full' ? 'popupStopFull' : 'popupStopDelayed');
}
document.querySelector('#stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop-capture', tabId: current.id });
  window.close();
});
const kind = await tabFileType(current);
for (const button of document.querySelectorAll('[data-tab-file]')) button.hidden = button.dataset.tabFile !== kind;

document.querySelector('#version').textContent = `Picantex ${chrome.runtime.getManifest().version}`;
setupHints();
document.querySelector('#help-link').addEventListener('click', async () => {
  await openHelp();
  window.close();
});

// Accanto a «Apri Picantex», quante pagine contiene già il documento
const pageCount = await countPages();
document.querySelector('#pages').textContent = pageCount;
document.querySelector('#pages').hidden = pageCount === 0;
