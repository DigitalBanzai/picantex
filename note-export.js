// Esportare le note di un sito, per tenerle: in Markdown (testo semplice, con i link alle pagine) e in PDF
// (fogli A4 con il testo vero, ricercabile, che si può anche aggiungere al documento a più pagine). Le
// note si raggruppano per pagina, nell'ordine in cui sono state scritte.
import { t } from './i18n.js';
import { A4, imagesToPdf } from './pdf.js';

const when = (ms, lang) => new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });

// Le pagine con le loro note, nell'ordine della prima nota di ognuna. Le note vuote non si esportano.
function byPage(notes) {
  const pages = new Map();
  for (const note of notes.filter((item) => String(item.text || '').trim()).sort((a, b) => a.created - b.created)) {
    if (!pages.has(note.page)) pages.set(note.page, { title: note.title, url: note.url, notes: [] });
    pages.get(note.page).notes.push(note);
  }
  return [...pages.values()];
}

// --- Markdown ---

// Una riga di testo che resta tale anche in Markdown. Il titolo di una pagina e le parole citate vengono dal
// web: un'immagine, un link o dell'HTML potrebbero far scaricare qualcosa da internet a chi apre il file
// (Obsidian, Typora...). Quindi i caratteri che diventano formattazione, link, immagini o HTML si
// neutralizzano con la barra rovesciata, ovunque; a inizio riga anche titoli, elenchi e righe di
// separazione. Gli spazi iniziali diventano spazi fissi, che non trasformano la riga in codice.
function plain(line) {
  const text = line.replace(/[\\`*_[\]<>&|~]/g, '\\$&').replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, '    ').replace(/ /g, '\u00a0'));
  return text.replace(/^([#+=-])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
}

// title: il titolo del file («Note a fianco», o «Note su <sito>» per le note di un sito). Le note senza
// pagina (scritte nel pannello laterale) stanno sotto «Senza pagina».
export function notesMarkdown(site, notes, lang, title) {
  const lines = [`# ${title}`, '', t('pageNoteExported', when(Date.now(), lang)), ''];
  for (const page of byPage(notes)) {
    lines.push(`## ${plain(page.title || page.url || t('pageNoteNoPage'))}`, '');
    if (page.url) lines.push(`<${page.url}>`, '');
    for (const note of page.notes) {
      // Due spazi in fondo: in Markdown la riga va a capo come nella nota
      lines.push(...note.text.split('\n').map((line) => `${plain(line)}  `), '', `*${when(note.updated, lang)}*`, '');
    }
    lines.push('---', '');
  }
  return lines.join('\n');
}

// --- PDF ---

const PIXELS_PER_POINT = 2;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// Le righe in cui va a capo un paragrafo nella larghezza data: tra le parole, e dentro una parola
// (un indirizzo lungo) solo se da sola non ci sta
function wrap(ctx, paragraph, width) {
  // In una riga non stanno più del doppio dei caratteri stretti che la riempiono: oltre non si misura
  const most = Math.ceil(width / Math.max(1, ctx.measureText('i').width)) * 2;
  const lines = [];
  let line = '';
  for (const word of paragraph.split(/(\s+)/)) {
    const candidate = line + word;
    if (candidate.length <= most && ctx.measureText(candidate).width <= width) {
      line = candidate;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = word.trimStart();
    // Una parola più lunga della riga si spezza dove serve, cercando il punto a metà per volta: anche un
    // testo lunghissimo senza spazi (un codice incollato) si esporta subito
    while (line.length > 1) {
      const head = line.slice(0, most + 1);
      if (ctx.measureText(head).width <= width) {
        if (head.length === line.length) break;
        lines.push(line.slice(0, most));
        line = line.slice(most);
        continue;
      }
      let low = 1;
      let high = Math.min(line.length - 1, most);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (ctx.measureText(line.slice(0, middle)).width <= width) low = middle;
        else high = middle - 1;
      }
      // Senza separare le due metà di un carattere come un'emoji
      if (low > 1 && /[\uD800-\uDBFF]/.test(line[low - 1])) low--;
      lines.push(line.slice(0, low));
      line = line.slice(low);
    }
  }
  lines.push(line.trimEnd());
  return lines;
}

export function notesPdf(site, notes, lang, title) {
  const width = Math.round(A4.width * PIXELS_PER_POINT);
  const height = Math.round(A4.height * PIXELS_PER_POINT);
  const margin = 48 * PIXELS_PER_POINT;
  const pages = [];
  let ctx;
  let words;
  let links;
  let y;
  const newPage = () => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    // Il produttore di PDF poi rilegge i pixel per comprimerli: Chrome va avvisato prima di disegnare
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    words = [];
    links = [];
    pages.push({ canvas, pixelsPerPoint: PIXELS_PER_POINT, words, links });
    y = margin;
  };
  // Scrive un testo andando a capo; ogni riga diventa testo ricercabile, e con link si apre con un clic.
  // size in punti tipografici
  const write = (text, { size, weight = 'normal', color = '#1c2430', after = 0.4, link = '' }) => {
    const px = size * PIXELS_PER_POINT;
    const font = `${weight} ${px}px ${FONT}`;
    ctx.font = font;
    for (const paragraph of String(text).split('\n')) {
      for (const line of wrap(ctx, paragraph, width - margin * 2)) {
        if (y + px * 1.35 > height - margin) {
          newPage();
          ctx.font = font;
        }
        ctx.fillStyle = color;
        ctx.fillText(line, margin, y + px);
        if (line.trim()) {
          const box = { x: margin, y: y + px * 0.2, w: ctx.measureText(line).width, h: px };
          words.push({ t: line, ...box, space: true });
          if (link) links.push({ ...box, url: link });
        }
        y += px * 1.35;
      }
    }
    y += px * after;
  };
  const rule = () => {
    ctx.fillStyle = '#d5dae1';
    ctx.fillRect(margin, y, width - margin * 2, PIXELS_PER_POINT);
    y += 14 * PIXELS_PER_POINT;
  };

  newPage();
  write(title, { size: 18, weight: 'bold', after: 0.3 });
  write(t('pageNoteExported', when(Date.now(), lang)), { size: 9, color: '#6b7686', after: 1.6 });
  for (const page of byPage(notes)) {
    // Il titolo e l'indirizzo della pagina si aprono con un clic nel lettore PDF
    write(page.title || page.url || t('pageNoteNoPage'), { size: 13, weight: 'bold', after: page.url ? 0.1 : 1, link: page.url });
    if (page.url) write(page.url, { size: 9, color: '#3d5a99', after: 1.2, link: page.url });
    for (const note of page.notes) {
      write(note.text, { size: 11, after: 0.2 });
      write(when(note.updated, lang), { size: 8.5, color: '#6b7686', after: 1.4 });
    }
    rule();
  }
  return imagesToPdf(pages, false, { Title: title, Creator: 'Picantex', Producer: 'Picantex' });
}
