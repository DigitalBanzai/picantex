// Aiuto: carica il testo nella lingua scelta in Picantex (help/<lingua>.html), ne costruisce l'indice e
// mette nella sezione Privacy il pulsante che svuota subito l'archivio delle catture.
import { LANGUAGES, loadLanguage, localizePage, t } from './i18n.js';
import { clearCaptures } from './store.js';

const $ = (selector) => document.querySelector(selector);

await loadLanguage();
localizePage();
$('#version').textContent = `Picantex ${chrome.runtime.getManifest().version}`;

// La lingua scelta dall'utente, altrimenti quella del browser; l'inglese se non è tra le nostre
const language = document.documentElement.lang.slice(0, 2);
const file = LANGUAGES.includes(language) ? language : 'en';
$('#help').innerHTML = await (await fetch(chrome.runtime.getURL(`help/${file}.html`))).text();

// Indice: una voce per sezione
const links = [...document.querySelectorAll('#help section')].map((section) => {
  const link = document.createElement('a');
  link.href = `#${section.id}`;
  link.textContent = section.querySelector('h2').textContent;
  const item = document.createElement('li');
  item.append(link);
  $('#toc').append(item);
  return link;
});

// Mentre si legge, l'indice segna la sezione in vista
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) for (const link of links) link.classList.toggle('current', link.hash === `#${entry.target.id}`);
  }
}, { rootMargin: '-80px 0px -70% 0px' });
for (const section of document.querySelectorAll('#help section')) observer.observe(section);

// Arrivando da un «Scopri di più», si va alla sezione indicata (il testo è arrivato dopo il caricamento).
// Per id e non come selettore: un indirizzo scritto a mano come #1x non deve fermare la pagina.
const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
target?.scrollIntoView({ behavior: 'instant' });

// --- Svuotare l'archivio delle catture, con una conferma ---

const purge = $('.purge');
if (purge) {
  const button = (text, className, onClick) => {
    const el = document.createElement('button');
    el.className = `btn ${className}`;
    el.textContent = text;
    el.addEventListener('click', onClick);
    return el;
  };
  const showStart = (message = '') => {
    const done = document.createElement('span');
    done.className = 'done';
    done.textContent = message;
    purge.replaceChildren(button(t('purgeButton'), 'danger', ask), done);
  };
  const ask = () => {
    const question = document.createElement('p');
    question.className = 'ask';
    question.textContent = t('purgeAsk');
    purge.replaceChildren(question, button(t('purgeYes'), 'danger', run), button(t('purgeNo'), '', () => showStart()));
  };
  const run = async () => {
    try {
      const count = await clearCaptures();
      showStart(count ? t('purgeDone', count) : t('purgeEmpty'));
    } catch (error) {
      showStart(t('errorFailed', error.message));
    }
  };
  showStart();
}
