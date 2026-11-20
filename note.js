// Note sulle pagine web: due righe lasciate su una pagina per quando ci si torna. Restano solo sul
// computer, una chiave per nota («note:<id>»). Picantex non guarda le pagine che si visitano: è Chrome a
// segnare l'icona sui siti con delle note (vedi background.js), e le note compaiono sulla pagina
// quando si clicca l'icona. Una nota si aggiunge dal menu dell'icona, dal menu del tasto destro o con
// la scorciatoia da tastiera (Alt+N).
//
// Nella versione gratuita le note stanno nel pannello laterale (vedi follow.js), con la citazione del
// testo scelto e la pagina d'origine, e solo nella memoria di Chrome (chrome.storage.session): Picantex
// non le scrive sul disco e spariscono uscendo da Chrome; per tenerle si esportano (vedi note-export.js).
// Con la fascia Dossier ci sono anche le note attaccate alle pagine, e tutto resta per sempre, su tutti
// i siti, in chrome.storage.local, dove anche la pagina su cui sono scritte (note-page.js) può salvarle.
// Le note prese in incognito stanno sempre e solo in memoria, si vedono solo nelle finestre in
// incognito e spariscono chiudendo l'ultima (vedi background.js). In incognito Picantex ha una parte sua
// (manifest: "incognito": "split"), ma chrome.storage è lo stesso per le due parti.
import { t } from './i18n.js';

export const NOTE_PREFIX = 'note:';

// La fascia dell'utente. Le licenze non ci sono ancora: per ora la fascia Dossier si accende solo
// dall'interruttore di prova della copia di lavoro, nel pannello laterale
export const noteMemory = async () => (await chrome.storage.local.get('tier')).tier === 'dossier';

// Le schede in cui le note di ogni sito sono in uso, in chrome.storage.session: { sito: [id delle schede] }.
// Si azzera da sola chiudendo Chrome, come le schede.
export const NOTE_TABS = 'noteTabs';
let tabsWritten = Promise.resolve();
export function useNoteTab(tabId, site) {
  tabsWritten = tabsWritten.then(async () => {
    const { [NOTE_TABS]: tabs = {} } = await chrome.storage.session.get(NOTE_TABS);
    tabs[site] = [...new Set([...(tabs[site] || []), tabId])];
    await chrome.storage.session.set({ [NOTE_TABS]: tabs });
  }).catch(() => {});
  return tabsWritten;
}

// Chiusa una scheda: i siti che non hanno più schede in cui le loro note sono in uso
export function releaseNoteTab(tabId) {
  let freed = [];
  tabsWritten = tabsWritten.then(async () => {
    const { [NOTE_TABS]: tabs = {} } = await chrome.storage.session.get(NOTE_TABS);
    for (const [site, ids] of Object.entries(tabs)) {
      if (!ids.includes(tabId)) continue;
      const left = ids.filter((id) => id !== tabId);
      if (left.length) tabs[site] = left;
      else {
        delete tabs[site];
        freed.push(site);
      }
    }
    await chrome.storage.session.set({ [NOTE_TABS]: tabs });
  }).catch(() => {
    freed = [];
  });
  return tabsWritten.then(() => freed);
}

// Parametri che dicono da dove arriva un visitatore, non quale pagina è
const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i;

// L'indirizzo che una nota ricorda (e che finisce nelle esportazioni): senza i parametri di tracciamento.
// La parte dopo # resta: può essere la sezione della pagina o, in un'applicazione web, la pagina stessa.
export function cleanUrl(href) {
  const url = new URL(href);
  for (const name of [...url.searchParams.keys()]) if (TRACKING.test(name)) url.searchParams.delete(name);
  return url.href;
}

// La pagina: l'indirizzo senza la parte dopo # e senza i parametri di tracciamento
export function pageKey(href) {
  const url = new URL(cleanUrl(href));
  url.hash = '';
  return url.href;
}

// Il sito: il nome del server senza «www.»
export const siteKey = (href) => new URL(href).hostname.replace(/^www\./, '');

// Su quali pagine si possono mettere note
export const notesAllowed = (href) => /^https?:/.test(href || '');

export const isNoteKey = (key) => key.startsWith(NOTE_PREFIX);
export const notesChanged = (changes) => Object.keys(changes).some(isNoteKey);

// Dove sta una nota: sul disco solo con la fascia Dossier e fuori dall'incognito, se no in memoria.
// memory: la fascia, se chi salva la sa già (così il salvataggio parte subito, anche chiudendo il pannello)
export function saveNote(note, memory) {
  const write = (keep) => (note.incognito || !keep ? chrome.storage.session : chrome.storage.local).set({ [NOTE_PREFIX + note.id]: note });
  return memory === undefined ? noteMemory().then(write) : write(memory);
}

// In incognito ogni sessione (dalla prima finestra in incognito all'ultima) ha un suo nome, che le note
// prese lì portano nel campo incognito. Il nome sta nell'archivio della parte in incognito di Picantex,
// che Chrome tiene in memoria e cancella con la sessione: così le note di una sessione finita non si
// vedono più, anche se Chrome non ha fatto in tempo a dire che l'ultima finestra si chiudeva. Solo nelle
// pagine e nel servizio in incognito.
export const INCOGNITO_DB = 'picantex-incognito';
let sessionName;
export function incognitoSession() {
  sessionName ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(INCOGNITO_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('session');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('session', 'readwrite');
      const store = tx.objectStore('session');
      let name;
      store.get('name').onsuccess = (event) => {
        name = event.target.result;
        if (!name) store.put((name = crypto.randomUUID()), 'name');
      };
      tx.oncomplete = () => {
        db.close();
        resolve(name);
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    };
  });
  return sessionName;
}

// Le note delle finestre normali, oppure (incognito) quelle di questa sessione in incognito: non si
// mescolano. Mentre cambiano posto, cambiando fascia, una nota può stare in entrambi: vale la più recente.
export async function listNotes(incognito = false) {
  const session = incognito ? await incognitoSession() : undefined;
  const [kept, held] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]);
  const notes = new Map();
  for (const [key, note] of [...Object.entries(kept), ...Object.entries(held)]) {
    if (!isNoteKey(key) || (incognito ? note.incognito !== session : Boolean(note.incognito))) continue;
    if (!(notes.get(note.id)?.updated > note.updated)) notes.set(note.id, note);
  }
  return [...notes.values()];
}

export const removeNotes = (ids) => {
  const keys = ids.map((id) => NOTE_PREFIX + id);
  return Promise.all([chrome.storage.local.remove(keys), chrome.storage.session.remove(keys)]);
};
export const removeNote = (id) => removeNotes([id]);

// Le prime parole di una nota, per gli elenchi
export function firstWords(text, length = 40) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return t('pageNoteEmpty');
  return flat.length > length ? `${flat.slice(0, length).replace(/\s+\S*$/, '')}…` : flat;
}

// Una nota nuova nel pannello laterale. source: la scheda da cui nasce ({ url, title, id, incognito }): se
// Picantex ne conosce la pagina, la nota ne tiene la pagina d'origine, e la scheda ne tiene in vita il
// ricordo per tornarci senza doppioni; in incognito la nota resta tra quelle in incognito. quote: il testo
// scelto sulla pagina, che la nota cita. Il pannello della finestra della scheda (windowId) porta il cursore
// su di lei. Le note a fianco lasciate vuote si tolgono: anche quelle in cui il cursore non è mai entrato
// (una nota a margine presa mentre si lavorava sulla pagina), che il pannello da solo non toglierebbe.
export async function addPanelNote(source, quote) {
  await removeEmptyNotes(Boolean(source?.incognito));
  const now = Date.now();
  const cited = String(quote || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const from = notesAllowed(source?.url) ? source : null;
  const note = {
    id: crypto.randomUUID(), follow: true, text: cited ? `${t('pageNoteQuote', cited)}\n` : '',
    url: from ? cleanUrl(from.url) : '', page: from ? pageKey(from.url) : '', site: from ? siteKey(from.url) : '', title: from?.title || '',
    created: now, updated: now, min: false, anchor: null,
  };
  if (source?.incognito) note.incognito = await incognitoSession();
  await saveNote(note);
  await focusInPanel(note.id, source?.windowId);
  if (from?.id) await useNoteTab(from.id, note.site);
  return note;
}

// Le note a fianco vuote (in incognito quelle della sessione, fuori quelle normali)
async function removeEmptyNotes(incognito) {
  const empty = (await listNotes(incognito)).filter((note) => note.follow && !String(note.text || '').trim());
  if (empty.length) await removeNotes(empty.map((note) => note.id));
}

// Il pannello della finestra windowId porta il cursore sulla nota: quello di un'altra finestra la lascia stare
export const focusInPanel = (id, windowId) => chrome.storage.session.set({ focusNote: { id, windowId } });

// Le schede aperte da qui per arrivare alla pagina di una nota (id -> { page, loaded }): si riusano finché
// non cambiano pagina. Picantex non ne vede l'indirizzo, quindi le segue solo finché questa pagina (il
// pannello, o «Le mie note») resta aperta: chiusa, la volta dopo si apre una scheda nuova.
const opened = new Map();
let watching = false;
function rememberOpened(tabId, page) {
  opened.set(tabId, { page, loaded: false });
  if (watching) return;
  watching = true;
  chrome.tabs.onUpdated.addListener((id, info) => {
    const entry = opened.get(id);
    if (entry && info.status === 'complete') entry.loaded = true;
    else if (entry?.loaded && info.status === 'loading') opened.delete(id);
  });
  chrome.tabs.onRemoved.addListener((id) => opened.delete(id));
}

// Porta alla pagina di una nota senza doppioni: se è già aperta in una scheda, porta in primo piano quella
// (anche in un'altra finestra). Picantex sa dov'è una scheda solo se vi ha ancora accesso (le schede dove
// le note del sito sono in uso: lo perde quando cambiano sito) o se l'ha aperta lui (vedi sopra). Se la
// nota è sulla pagina, lampeggia. Altrimenti la pagina si apre in una scheda nuova della finestra
// windowId. Una nota presa in incognito porta solo a schede in incognito, le altre solo a schede normali.
export async function goToNote(note, windowId) {
  if (!notesAllowed(note.url)) return;
  const { [NOTE_TABS]: tabs = {} } = await chrome.storage.session.get(NOTE_TABS);
  const ids = new Set([...(tabs[note.site] || []), ...opened.keys()]);
  const open = (await Promise.all([...ids].map((id) => chrome.tabs.get(id).catch(() => null))))
    .filter((candidate) => candidate && candidate.incognito === Boolean(note.incognito));
  const tab = open.find((candidate) => (candidate.url ? pageKey(candidate.url) : opened.get(candidate.id)?.page) === note.page);
  if (!tab) {
    const created = await chrome.tabs.create({ url: note.url, windowId });
    rememberOpened(created.id, note.page);
    return;
  }
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// Il nome della scorciatoia di un comando, come l'ha impostata l'utente ('' se non c'è)
export async function noteShortcut(name) {
  const commands = await chrome.commands.getAll();
  return commands.find((command) => command.name === name)?.shortcut || '';
}

// La scorciatoia della nota a margine (Alt+M)
export const sideShortcut = () => noteShortcut('add-side-note');
