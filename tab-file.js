// File aperti direttamente in una scheda di Chrome, un PDF o un'immagine: come riconoscerli e come
// riprenderli per aprirli in Picantex, che altrimenti potrebbe solo fotografare lo schermo.
// Lo usano il menu dell'icona, l'editor e la pagina dei PDF.

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

// Nome del file: l'ultimo pezzo dell'indirizzo, se ha l'estensione giusta; altrimenti il titolo della scheda
export function fileName(url, title = '', extension = 'pdf') {
  const fits = (name) => (extension === 'pdf' ? /\.pdf$/i.test(name) : IMAGE_NAME.test(name));
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop());
    if (fits(last)) return last;
  } catch {
    // indirizzo non leggibile: vale il titolo
  }
  if (fits(title)) return title;
  return extension === 'pdf' ? `${title || 'PDF'}.pdf` : title || 'image';
}

// Indirizzo della pagina che apre il file: pdf-open.html per un PDF, editor.html per un'immagine.
// tabId: la scheda in cui il file è aperto. Se il sito non lo dà a Picantex, lo si richiede da lì
// dentro, con la sessione dell'utente (vedi fetchFromTab).
export function openFileUrl(kind, url, title, tabId) {
  const page = kind === 'pdf' ? 'pdf-open.html' : 'editor.html';
  const params = { src: url, name: fileName(url, title, kind) };
  if (tabId) params.tab = String(tabId);
  return `${page}?${new URLSearchParams(params)}`;
}

// 'pdf' o 'image' se la scheda mostra un file di quel tipo nel visualizzatore di Chrome, altrimenti null.
// L'indirizzo spesso lo dice; altrimenti lo dice il tipo del documento, letto con il permesso avuto
// al clic sull'icona.
export async function tabFileType(tab) {
  if (!/^(https?|file):/.test(tab?.url || '')) return null;
  const { pathname } = new URL(tab.url);
  if (/\.pdf$/i.test(pathname)) return 'pdf';
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.contentType });
    if (result === 'application/pdf') return 'pdf';
    if (/^image\//.test(result) && result !== 'image/svg+xml') return 'image';
  } catch {
    // pagina in cui gli script non sono ammessi
  }
  return null;
}

export const isLocalFile = (src) => /^file:/i.test(src);

// Riprende il file aperto in una scheda: prima direttamente dal suo indirizzo, con il permesso avuto
// al clic sull'icona; se il sito non lo dà a Picantex (perché vuole la sessione dell'utente) lo si
// richiede dall'interno della scheda. I file del computer (file://) Chrome li lascia leggere solo se
// l'utente ha dato a Picantex l'accesso ai file. accept(blob) dice se ciò che è arrivato va bene
// (un sito può rispondere con la pagina di accesso). Restituisce il file, oppure null.
export async function fetchFromTab(src, tabId, accept) {
  let url;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) return null;
  const attempts = url.protocol === 'file:'
    ? [async () => (await chrome.extension.isAllowedFileSchemeAccess() ? readLocal(src) : null)]
    : [() => fetchDirect(src), () => fetchInTab(tabId, src)];
  for (const attempt of attempts) {
    const blob = await attempt().catch((error) => console.warn('file', error));
    if (blob?.size && await accept(blob)) return blob;
  }
  return null;
}

async function fetchDirect(src) {
  const response = await fetch(src, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
}

// Richiesta fatta dalla pagina stessa: per il sito è una sua richiesta, con la sessione dell'utente.
// Solo se la scheda mostra ancora quel file.
async function fetchInTab(tabId, src) {
  if (!Number(tabId)) return null;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId) },
    args: [src],
    func: async (expected) => {
      if (location.href !== expected) return null;
      const response = await fetch(location.href);
      if (!response.ok) return null;
      // Il risultato passa come testo: i byte si scrivono in base64, a pezzi
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { type: response.headers.get('content-type') || '', data: btoa(binary) };
    },
  });
  if (!result?.data) return null;
  const type = /^[\w.+-]+\/[\w.+-]+/.exec(result.type)?.[0] || 'application/octet-stream';
  return (await fetch(`data:${type};base64,${result.data}`)).blob();
}

// I file del computer si leggono così: fetch non accetta gli indirizzi file://
function readLocal(src) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', src);
    request.responseType = 'blob';
    request.onload = () => (request.response?.size ? resolve(request.response) : reject(new Error('file')));
    request.onerror = () => reject(new Error('file'));
    request.send();
  });
}
