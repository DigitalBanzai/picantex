// I «?» accanto alle funzioni meno ovvie: un clic apre due o tre righe di spiegazione e il link
// «Scopri di più» alla sezione giusta dell'Aiuto, che si apre in una scheda nuova.
// Nella pagina: <button class="hint" data-hint="chiave del testo" data-section="id della sezione">?</button>
import { t } from './i18n.js';

let bubble = null;

// Apre l'Aiuto alla sezione indicata, accanto alla scheda da cui si parte
export async function openHelp(section = '') {
  const url = `help.html${section ? `#${section}` : ''}`;
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab) chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id });
  else chrome.tabs.create({ url }); // dal menu dell'icona, che non è una scheda
}

function close() {
  bubble?.remove();
  bubble = null;
}

function show(button) {
  close();
  bubble = document.createElement('div');
  bubble.className = 'hint-bubble';
  const text = document.createElement('p');
  text.textContent = t(button.dataset.hint);
  const more = document.createElement('a');
  more.href = '#';
  more.textContent = t('helpMore');
  more.addEventListener('click', (e) => {
    e.preventDefault();
    openHelp(button.dataset.section);
    close();
    if (document.body.dataset.page === 'popup') window.close();
  });
  bubble.append(text, more);
  document.body.append(bubble);
  // Sotto il «?», oppure sopra se sotto non c'è posto: il menu dell'icona non si allunga per farle spazio
  const box = button.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left + box.width / 2 - bubble.offsetWidth / 2), window.innerWidth - bubble.offsetWidth - 8);
  const below = box.bottom + 6;
  const top = below + bubble.offsetHeight <= window.innerHeight - 8 ? below : Math.max(8, box.top - bubble.offsetHeight - 6);
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

export function setupHints() {
  document.addEventListener('click', (e) => {
    const button = e.target.closest('.hint');
    if (button) {
      // Un «?» dentro un'etichetta non deve accendere l'interruttore che le sta accanto
      e.preventDefault();
      e.stopPropagation();
      if (bubble && bubble.dataset.for === button.dataset.hint) return close();
      show(button);
      bubble.dataset.for = button.dataset.hint;
    } else if (bubble && !bubble.contains(e.target)) {
      close();
    }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bubble) close();
  });
}
