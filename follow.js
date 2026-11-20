// Il pannello laterale «Note a fianco», il taccuino delle ricerche. Le note nascono qui: con «Nuova nota», con
// la scorciatoia, dal menu del tasto destro o dal menu dell'icona, e allora citano il testo scelto e
// ricordano la pagina d'origine («Da:», che riporta lì senza doppioni). Il pannello è di Chrome e resta
// aperto cambiando pagina, sito o scheda: anche per copiare da una pagina e incollare in un'altra. Le note
// si scrivono, si copiano, si eliminano e si esportano. Nella versione gratuita stanno solo in memoria e
// durano finché Chrome resta aperto (vedi note.js). La fascia Dossier aggiunge le note attaccate alle
// pagine (con la puntina arrivano qui, e «Rimetti sulla pagina» le riattacca) e tiene tutto per sempre.
// In una finestra in incognito il pannello mostra solo le note prese in incognito, che restano in memoria
// anche con la fascia Dossier e spariscono chiudendo l'ultima finestra in incognito.
import { download, timeStamp } from './export.js';
import { loadLanguage, localizePage, t } from './i18n.js';
import {
  addPanelNote, goToNote, listNotes, noteMemory, notesChanged, removeNote, removeNotes, saveNote, sideShortcut,
} from './note.js';
import { notesMarkdown, notesPdf } from './note-export.js';
const $ = (selector) => document.querySelector(selector);
const SAVE_DELAY = 400;

await loadLanguage();
localizePage();
// La finestra del pannello: in incognito le note sono altre, e non restano
const here = await chrome.windows.getCurrent();
const incognito = Boolean(here.incognito);
// Quando le note sono state esportate l'ultima volta: dura quanto le note, in memoria
const EXPORTED_AT = incognito ? 'incognitoExportedAt' : 'notesExportedAt';
// La fascia: dice quanto durano le note e, con la fascia Dossier, se si possono rimettere su una pagina.
// kept: le note restano (fascia Dossier, fuori dall'incognito)
let memory = false;
let kept = false;
let sideKey = ''; // la scorciatoia della nota a margine (vedi sideShortcut)
const cards = new Map(); // id -> { el, area, note, timer, back }: per non toccare la nota su cui si scrive
// Una nota senza pagina dice, finché è vuota, come averne una che ricorda la pagina
const placeholder = (note) => {
  if (note.url) return t('pageNotePlaceholder');
  return sideKey ? t('pageNoteFollowLoose', sideKey) : t('pageNoteFollowLooseNoKey');
};
const showHint = async () => {
  memory = await noteMemory();
  kept = memory && !incognito;
  sideKey = await sideShortcut();
  // Nella versione gratuita e in incognito l'avviso che le note spariscono (vedi showUnexported)
  $('#keep .warning span').textContent = t(incognito ? 'pageNoteFollowIncognito' : 'pageNoteFollowFree');
  $('#empty').textContent = sideKey ? t('pageNoteFollowNoneFree', sideKey) : t('pageNoteFollowNoneFreeNoKey');
  for (const item of cards.values()) item.area.placeholder = placeholder(item.note);
};
await showHint();

const following = async () => (await listNotes(incognito)).filter((note) => note.follow).sort((a, b) => a.created - b.created);
const save = (note) => saveNote({ ...note, updated: Date.now() }, memory);
const remove = (note) => removeNote(note.id);
// Salva subito quello che si è scritto nella nota, senza aspettare la pausa
const flush = (item) => {
  clearTimeout(item.timer);
  item.timer = 0;
  save(item.note);
};
// Chiudendo il pannello si salva anche l'ultima parola scritta, e le note lasciate vuote spariscono: anche
// quelle in cui il cursore non è mai entrato, che il blur non toglie
addEventListener('pagehide', () => {
  const empty = [];
  for (const item of cards.values()) {
    if (item.gone) continue;
    if (!item.area.value.trim()) {
      clearTimeout(item.timer);
      empty.push(item.note.id);
    } else if (item.timer) flush(item);
  }
  if (empty.length) removeNotes(empty);
});

const element = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const button = (text, className, onClick) => {
  const el = element('button', className, text);
  el.addEventListener('click', onClick);
  return el;
};

function card(note) {
  const el = element('article', 'card');
  if (note.url) {
    const from = element('p', 'from', `${t('pageNoteFollowFrom')} `);
    const link = element('a', '', note.title || note.url);
    link.href = note.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = note.url;
    // Clic normale: alla pagina senza doppioni (vedi goToNote); con Ctrl, Maiusc o il tasto centrale, una
    // scheda nuova. Sempre in questa finestra: una nota presa in incognito non si apre in una finestra normale.
    const newTab = () => chrome.tabs.create({ url: item.note.url, windowId: here.id, active: false });
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.shiftKey) newTab();
      else goToNote(item.note, here.id);
    });
    link.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      newTab();
    });
    from.append(link);
    el.append(from);
  }
  const area = element('textarea');
  area.value = note.text || '';
  area.placeholder = placeholder(note);
  const message = element('p', 'message');
  message.hidden = true;
  const actions = element('div', 'actions');
  const item = { el, area, note, timer: 0 };
  const copy = button(t('pageNoteFollowCopy'), '', async () => {
    await navigator.clipboard.writeText(area.value);
    copy.textContent = t('pageNoteFollowCopied');
    setTimeout(() => { copy.textContent = t('pageNoteFollowCopy'); }, 1500);
  });
  const tools = [copy];
  const start = () => actions.replaceChildren(...tools, button(t('pageNoteDelete'), '', ask));
  const ask = () => actions.replaceChildren(
    element('span', '', t('pageNoteDeleteAsk')),
    button(t('pageNoteDeleteYes'), 'yes', () => remove(item.note)),
    button(t('pageNoteDeleteNo'), '', start),
  );
  start();
  area.addEventListener('input', () => {
    item.note = { ...item.note, text: area.value };
    clearTimeout(item.timer);
    item.timer = setTimeout(() => flush(item), SAVE_DELAY);
  });
  // Una nota lasciata vuota non serve: sparisce. Uscendo dalla nota si salva solo quello che aspettava
  // di esserlo: così una nota soltanto guardata non risulta cambiata. Una nota eliminata altrove non torna.
  area.addEventListener('blur', () => {
    if (item.gone) return;
    if (!area.value.trim()) {
      clearTimeout(item.timer);
      remove(item.note);
    } else if (item.timer) flush(item);
  });
  el.append(area, message, actions);
  cards.set(note.id, item);
  return item;
}

async function render() {
  const notes = await following();
  const ids = new Set(notes.map((note) => note.id));
  for (const [id, item] of cards) {
    if (!ids.has(id)) {
      clearTimeout(item.timer);
      item.gone = true;
      item.el.remove();
      cards.delete(id);
    }
  }
  // Le note già al loro posto non si toccano: spostare quella su cui si scrive le toglierebbe il cursore
  const box = $('#list');
  notes.forEach((note, index) => {
    const item = cards.get(note.id) || card(note);
    if (document.activeElement !== item.area && note.updated > item.note.updated) {
      item.note = note;
      item.area.value = note.text;
    }
    if (box.children[index] !== item.el) box.insertBefore(item.el, box.children[index] || null);
  });
  $('#empty').hidden = notes.length > 0;
  $('#tools').hidden = notes.length === 0;
  showUnexported(notes);
  // Una nota appena creata (qui, dal menu, dal tasto destro o dalla scorciatoia) in questa finestra: il
  // cursore va su di lei
  const { focusNote } = await chrome.storage.session.get('focusNote');
  const fresh = focusNote?.windowId === here.id && cards.get(focusNote.id);
  if (fresh) {
    await chrome.storage.session.remove('focusNote');
    fresh.area.focus();
    fresh.area.setSelectionRange(fresh.area.value.length, fresh.area.value.length);
    fresh.el.scrollIntoView({ block: 'nearest' });
    showFresh(fresh);
  }
}

// Una nota appena nata lampeggia e per un momento dice di esserlo: quando prende il posto di una nota vuota
// (che sparisce), il pannello sembrerebbe altrimenti non aver fatto nulla
function showFresh(item) {
  item.el.querySelector('.fresh')?.remove();
  const tag = element('span', 'fresh', t('pageNoteFollowNew'));
  tag.addEventListener('animationend', () => tag.remove());
  item.el.querySelector('.actions').append(tag);
  item.el.classList.remove('flash');
  requestAnimationFrame(() => item.el.classList.add('flash'));
}

// Una nota nuova, scritta qui: per incollarci quello che si copia da una pagina. Ricorda la pagina che si ha
// davanti se Picantex la conosce già (lo si è usato lì, e Chrome gli lascia vedere la scheda); se no nasce
// senza pagina, e dice come averla
$('#new').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  addPanelNote({ ...tab, incognito, windowId: here.id }, '');
});

// Eliminare tutte le note a fianco, con una conferma
function showClear() {
  const clear = $('#clear');
  const start = () => clear.replaceChildren(button(t('pageNoteFollowDeleteAll'), 'btn danger', ask));
  const ask = async () => {
    const notes = await following();
    clear.replaceChildren(
      element('span', '', t('pageNoteFollowDeleteAllAsk', notes.length)),
      button(t('pageNoteDeleteYes'), 'btn danger yes', async () => {
        await removeNotes(notes.map((note) => note.id));
        start();
      }),
      button(t('pageNoteDeleteNo'), 'btn', start),
    );
  };
  start();
}
showClear();

// Versione gratuita e incognito: le note spariscono chiudendo Chrome (o l'ultima finestra in incognito), e
// Chrome non avvisa le estensioni quando si chiude. Il promemoria sta in cima, ben visibile: quante note
// sono cambiate dopo l'ultima esportazione, e i pulsanti per esportarle subito.
async function showUnexported(notes) {
  const keep = $('#keep');
  keep.hidden = kept || notes.length === 0;
  if (keep.hidden) return keepClear();
  const { [EXPORTED_AT]: exportedAt = 0 } = await chrome.storage.session.get(EXPORTED_AT);
  // Esportate, i pulsanti restano: c'è chi vuole più copie (sul computer, su una chiavetta…). Finché le
  // note sono tutte vuote non c'è niente da esportare
  const written = notes.filter((note) => note.text.trim());
  const count = written.filter((note) => note.updated > exportedAt).length;
  $('#unexported').textContent = count === 0 ? t('pageNoteAllExported') : count === 1 ? t('pageNoteUnexportedOne') : t('pageNoteUnexportedMany', count);
  $('#unexported').hidden = written.length === 0;
  $('#export-now').hidden = written.length === 0;
  keepClear();
}

// Portando in vista una nota, lo scorrimento non la deve lasciare sotto la parte fissa in alto
function keepClear() {
  document.documentElement.style.scrollPaddingTop = `${$('#top').offsetHeight + 8}px`;
}

async function exportNotes(format) {
  // Esportate sono le note com'erano adesso: quello che si scrive mentre si sceglie dove salvare non lo è
  const exportedAt = Date.now();
  const notes = await following();
  const lang = document.documentElement.lang;
  const title = t('pageNoteFollowExportTitle');
  const blob = format === 'pdf' ? await notesPdf('', notes, lang, title) : new Blob([notesMarkdown('', notes, lang, title)], { type: 'text/markdown' });
  if (await download(blob, `note_${timeStamp()}.${format === 'pdf' ? 'pdf' : 'md'}`)) {
    await chrome.storage.session.set({ [EXPORTED_AT]: exportedAt });
    render();
  }
}
$('#export-pdf').addEventListener('click', () => exportNotes('pdf'));
$('#export-md').addEventListener('click', () => exportNotes('md'));
for (const button of document.querySelectorAll('[data-export]')) button.addEventListener('click', () => exportNotes(button.dataset.export));

chrome.storage.onChanged.addListener((changes, area) => {
  if (notesChanged(changes) || (area === 'session' && changes.focusNote?.newValue)) render();
  if (area === 'local' && changes.tier) {
    showHint().then(render);
  }
});
render();
