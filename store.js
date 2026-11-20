// Archivio locale delle catture (IndexedDB), condiviso tra service worker ed editor.
// Non ha il limite di 10 MB di chrome.storage e non richiede permessi.
const DB_NAME = 'picantex';
const STORE = 'captures';
// Pagine del documento: a differenza delle catture, restano finché non le toglie l'utente
const PAGES = 'pages';
// Dossier, e il materiale di ciascuno (immagini con il testo che contengono): restano anch'essi
const DOSSIERS = 'dossiers';
const ASSETS = 'assets';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [STORE, PAGES, DOSSIERS]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' }).createIndex('dossier', 'dossier');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Esegue un'operazione in una transazione sull'archivio indicato e ne restituisce il risultato
async function run(mode, operation, name = STORE) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const request = operation(tx.objectStore(name));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function saveCapture(capture) {
  return run('readwrite', (store) => store.put(capture));
}

export function loadCapture(id) {
  return run('readonly', (store) => store.get(id));
}

// Elimina gli archivi rimasti da versioni precedenti che usavano un altro nome (non quello che dà un nome
// alla sessione in incognito, che vive solo in incognito)
export async function removeStaleDatabases() {
  for (const { name } of await indexedDB.databases()) {
    if (name !== DB_NAME && name !== 'picantex-incognito') indexedDB.deleteDatabase(name);
  }
}

// Elimina le catture più vecchie di un giorno, per non lasciare schermate in giro
export function purgeOldCaptures() {
  const limit = Date.now() - MAX_AGE_MS;
  return run('readwrite', (store) => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.created < limit) cursor.delete();
      cursor.continue();
    };
    return request;
  });
}

// Svuota subito l'archivio delle catture, senza aspettare le 24 ore (dalla pagina Aiuto): restituisce
// quante erano. Le pagine del documento e i dossier restano.
export async function clearCaptures() {
  const count = await run('readonly', (store) => store.count());
  await run('readwrite', (store) => store.clear());
  return count;
}

// --- Documento a più pagine ---

export function savePage(page) {
  return run('readwrite', (store) => store.put(page), PAGES);
}

// Pagine del documento, nell'ordine scelto dall'utente
export async function loadPages() {
  const pages = await run('readonly', (store) => store.getAll(), PAGES);
  return pages.sort((a, b) => a.order - b.order);
}

export function countPages() {
  return run('readonly', (store) => store.count(), PAGES);
}

export function deletePage(id) {
  return run('readwrite', (store) => store.delete(id), PAGES);
}

export function clearPages() {
  return run('readwrite', (store) => store.clear(), PAGES);
}

// Dà alle pagine l'ordine in cui compaiono gli identificativi
export function orderPages(ids) {
  return run('readwrite', (store) => {
    ids.forEach((id, order) => {
      const found = store.get(id);
      found.onsuccess = () => found.result && store.put({ ...found.result, order });
    });
    return store.count();
  }, PAGES);
}

