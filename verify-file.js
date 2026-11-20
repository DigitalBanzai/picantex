// Verifica di un file: se ne ricalcola l'impronta SHA-256, sul computer, e la si confronta con quella
// attesa, presa da un file .sha256 (anche con più file elencati) oppure incollata. È solo una comodità:
// chi non deve fidarsi di Picantex usa gli strumenti del sistema (sha256sum -c, Get-FileHash).
import { loadLanguage, localizePage, t } from './i18n.js';
import { sha256 } from './verify.js';

const $ = (selector) => document.querySelector(selector);
const files = new Map();    // nome -> File da controllare
const expected = new Map(); // nome -> impronta attesa, dai file .sha256
const hashes = new Map();   // File -> impronta calcolata (Promise), per non rifare il calcolo
let pasted = '';

// Una riga di sha256sum: l'impronta, uno spazio, e il nome (con un asterisco davanti in modo binario)
const LINE = /^([0-9a-f]{64}) [ *](.+)$/i;
const isChecksumList = (file) => /\.sha256(sum)?$/i.test(file.name);

async function addFiles(list) {
  for (const file of list) {
    if (isChecksumList(file)) {
      for (const line of (await file.text()).split(/\r?\n/)) {
        const match = line.trim().match(LINE);
        if (match) expected.set(match[2].trim(), match[1].toLowerCase());
      }
    } else {
      files.set(file.name, file);
    }
  }
  render();
}

const hashOf = (file) => {
  if (!hashes.has(file)) hashes.set(file, sha256(file));
  return hashes.get(file);
};

const element = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
};

// L'impronta, con un'etichetta: «Impronta del file: …» o «Impronta attesa: …»
function hashLine(label, value) {
  const code = element('code');
  code.append(`${label} `, element('b', '', value));
  return code;
}

function copyButton(value) {
  const button = element('button', 'btn', t('fpCopy'));
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(value);
    button.textContent = t('fpCopied');
    setTimeout(() => { button.textContent = t('fpCopy'); }, 2000);
  });
  return button;
}

async function render() {
  const items = [];
  for (const [name, file] of files) {
    const item = element('li', 'pending');
    const status = element('span', 'status', t('vfComputing'));
    const hashesBox = element('div', 'hashes');
    item.append(element('span', 'mark', '…'), element('span', 'name', name), status, hashesBox);
    items.push(item);
    hashOf(file).then((hash) => {
      // L'impronta attesa: quella elencata per questo nome, altrimenti quella incollata
      const wanted = expected.get(name) || pasted;
      hashesBox.replaceChildren(hashLine(t('vfComputed'), hash));
      if (!wanted) {
        item.className = 'unknown';
        item.querySelector('.mark').textContent = '•';
        status.textContent = t('vfNoReference');
        item.append(copyButton(hash));
      } else if (wanted === hash) {
        item.className = 'same';
        item.querySelector('.mark').textContent = '✓';
        status.textContent = t('vfSame');
      } else {
        item.className = 'different';
        item.querySelector('.mark').textContent = '✗';
        status.textContent = t('vfDifferent');
        hashesBox.append(hashLine(t('vfExpected'), wanted));
      }
    }, (error) => {
      item.className = 'different';
      status.textContent = t('errorFailed', error.message);
    });
  }
  // Elencati nel .sha256 ma non scelti: lo si dice, così non sembra tutto a posto
  for (const name of expected.keys()) {
    if (files.has(name)) continue;
    const item = element('li', 'missing');
    item.append(element('span', 'mark', '?'), element('span', 'name', name), element('span', 'status', t('vfMissing')));
    items.push(item);
  }
  $('#results').replaceChildren(...items);
}

// --- Scelta dei file e impronta incollata ---

$('[data-action="choose"]').addEventListener('click', () => $('#files').click());
$('#files').addEventListener('change', () => {
  addFiles([...$('#files').files]);
  $('#files').value = '';
});

const drop = $('#drop');
window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  drop.classList.add('over');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) drop.classList.remove('over');
});
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  drop.classList.remove('over');
  addFiles([...e.dataTransfer.files]);
});

// Si accetta anche una riga intera di sha256sum: conta l'impronta all'inizio
$('#pasted').addEventListener('input', () => {
  const text = $('#pasted').value.trim();
  const hash = text.match(/^[0-9a-f]{64}/i)?.[0].toLowerCase() || '';
  $('#paste-error').hidden = !text || Boolean(hash);
  pasted = hash;
  render();
});

await loadLanguage();
localizePage();
