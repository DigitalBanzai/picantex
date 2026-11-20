// Traduzioni. I testi stanno in _locales/<lingua>/messages.json: di norma vale la lingua del
// browser, ma l'utente può sceglierne un'altra dal menu dell'editor.

export const LANGUAGES = ['de', 'en', 'es', 'fr', 'it'];

let chosen = '';     // lingua scelta dall'utente; vuota = lingua del browser
let messages = null; // testi della lingua scelta

// Legge la preferenza salvata e ne carica i testi. Va chiamata prima di usare t().
export async function loadLanguage() {
  const { language } = await chrome.storage.local.get('language');
  chosen = LANGUAGES.includes(language) ? language : '';
  messages = chosen
    ? await (await fetch(chrome.runtime.getURL(`_locales/${chosen}/messages.json`))).json()
    : null;
  return chosen;
}

// Un codice vuoto riporta alla lingua del browser
export function saveLanguage(code) {
  return code ? chrome.storage.local.set({ language: code }) : chrome.storage.local.remove('language');
}

// Testo tradotto; i valori extra sostituiscono $1, $2... Una chiave sconosciuta torna così com'è.
export function t(key, ...values) {
  if (messages) {
    const text = messages[key]?.message ?? key;
    return text.replace(/\$(\d)/g, (placeholder, n) => values[n - 1] ?? placeholder);
  }
  return (/^\w+$/.test(key) && chrome.i18n.getMessage(key, values.map(String))) || key;
}

// Riempie gli elementi marcati con data-i18n (testo) e data-i18n-title (suggerimento al passaggio del mouse)
export function localizePage() {
  document.documentElement.lang = chosen || chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}
