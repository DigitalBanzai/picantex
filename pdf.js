// Generatore PDF minimale: ogni foglio contiene una schermata, o un suo tratto, senza perdita di qualità.
// Sopra l'immagine può esserci il suo testo, invisibile: così nel PDF si può cercare e copiare.

// Un punto tipografico (1/72 di pollice) corrisponde a 0,75 pixel CSS
export const POINTS_PER_CSS_PIXEL = 0.75;
// Lato massimo di una pagina PDF, in punti (limite dei lettori più diffusi)
const MAX_PAGE_SIDE = 14400;
// Foglio A4 in punti, con un centimetro di margine
export const A4 = { width: 595.28, height: 841.89, margin: 28.35 };
// Quanta parte di un foglio A4 si è disposti a lasciare vuota in fondo pur di tagliare tra due righe
const CUT_REACH = 0.15;
// La schermata è divisa in fasce orizzontali, ognuna un'immagine a sé. Oltre i 60 MB di pixel
// per immagine il visualizzatore PDF di Chrome sbaglia la decodifica e il testo esce a strisce.
const MAX_BAND_BYTES = 16_000_000;
// Righe in comune tra una fascia e la successiva: senza, alcuni lettori mostrano una riga
// sottile sulle giunture quando la pagina viene rimpicciolita.
const BAND_OVERLAP = 16;

// Comprime le righe [top, top + rows) nel formato richiesto dal PDF (zlib + filtro PNG "Up").
// Legge a strisce per non tenere in memoria tutti i pixel non compressi.
async function compressRows(ctx, width, top, rows) {
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  const compressed = new Response(stream.readable).blob();

  const rowLength = width * 3 + 1;
  const stripRows = Math.max(1, Math.floor(1_000_000 / width));
  const previous = new Uint8Array(width * 3);
  const end = top + rows;

  for (let y = top; y < end; y += stripRows) {
    const count = Math.min(stripRows, end - y);
    const rgba = ctx.getImageData(0, y, width, count).data;
    const out = new Uint8Array(count * rowLength);
    let source = 0;
    let target = 0;
    for (let row = 0; row < count; row++) {
      out[target++] = 2; // filtro "Up": ogni byte è la differenza con quello della riga sopra
      for (let i = 0; i < width * 3; i += 3, source += 4) {
        for (let channel = 0; channel < 3; channel++) {
          const value = rgba[source + channel];
          out[target++] = value - previous[i + channel];
          previous[i + channel] = value;
        }
      }
    }
    await writer.write(out);
  }
  await writer.close();
  return compressed;
}

// Fasce in cui dividere un tratto d'immagine alto "height" pixel: { top, rows }
function splitInBands(width, height) {
  const step = Math.max(BAND_OVERLAP * 4, Math.floor(MAX_BAND_BYTES / (width * 3)));
  const bands = [];
  for (let top = 0; top < height; top += step) {
    const rows = Math.min(step + BAND_OVERLAP, height - top);
    bands.push({ top, rows });
    if (top + rows === height) break;
  }
  return bands;
}

// Riga in cui tagliare tra un foglio e il successivo: tra le righe [from, to) la più "vuota", cioè
// con meno cambi di colore da un pixel all'altro. Così il taglio cade tra due righe di testo.
function quietRow(ctx, width, from, to) {
  const data = ctx.getImageData(0, from, width, to - from).data;
  const changes = new Uint32Array(to - from);
  let least = Infinity;
  for (let row = 0; row < changes.length; row++) {
    let i = row * width * 4;
    for (let x = 1; x < width; x++, i += 4) {
      const jump = Math.abs(data[i] - data[i + 4]) + Math.abs(data[i + 1] - data[i + 5]) + Math.abs(data[i + 2] - data[i + 6]);
      if (jump > 40) changes[row]++;
    }
    least = Math.min(least, changes[row]);
  }
  // Delle righe più vuote si prende l'ultima serie, la più vicina alla fine del foglio, e la si taglia a metà
  const quiet = (row) => changes[row] <= least + 2;
  let last = changes.length - 1;
  while (!quiet(last)) last--;
  let first = last;
  while (first > 0 && quiet(first - 1)) first--;
  return from + Math.ceil((first + last) / 2);
}

// Divide un'immagine nei tratti verticali che vanno ciascuno su un foglio A4. L'immagine non viene
// mai ingrandita; se è più larga del foglio la si rimpicciolisce quanto basta, e se è lunga prosegue
// sui fogli successivi. scale: punti per pixel; slices: [{ top, rows }].
export function paginate(canvas, pixelsPerPoint) {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const scale = Math.min(1 / pixelsPerPoint, (A4.width - A4.margin * 2) / width);
  const perSheet = Math.max(1, Math.floor((A4.height - A4.margin * 2) / scale));
  const reach = Math.max(1, Math.floor(perSheet * CUT_REACH));
  const slices = [];
  let top = 0;
  while (height - top > perSheet) {
    const cut = quietRow(ctx, width, top + perSheet - reach, top + perSheet);
    slices.push({ top, rows: cut - top });
    top = cut;
  }
  slices.push({ top, rows: height - top });
  return { scale, slices };
}

// Fogli su cui va un'immagine: uno solo, grande quanto lei, oppure quanti ne servono in A4.
// Ogni foglio: misure in punti e tratti d'immagine { top, rows } con l'angolo in alto a sinistra x, y.
function layOut(canvas, pixelsPerPoint, a4) {
  const { width, height } = canvas;
  if (!a4) {
    // Punti per pixel, ridotti se la pagina supererebbe il lato massimo
    const scale = Math.min(1 / pixelsPerPoint, MAX_PAGE_SIDE / Math.max(width, height));
    return { scale, sheets: [{ width: width * scale, height: height * scale, x: 0, y: 0, top: 0, rows: height }] };
  }
  const { scale, slices } = paginate(canvas, pixelsPerPoint);
  const x = (A4.width - width * scale) / 2;
  return { scale, sheets: slices.map((slice) => ({ width: A4.width, height: A4.height, x, y: A4.margin, ...slice })) };
}

// --- Testo invisibile ---
// Il testo sta sopra l'immagine senza essere disegnato, come nei documenti scansionati: si cerca, si
// seleziona e si copia, ma si vede solo l'immagine. Usa un carattere senza disegni, composto qui sotto:
// ogni simbolo è vuoto e largo mezzo em. Il codice di ogni carattere è il suo valore UTF-16, e la
// tabella ToUnicode dice al lettore quale lettera rappresenta. Vale per qualunque alfabeto, e anche per
// i caratteri fuori dal piano base, come le emoji (vedi codeOf).

const GLYPH_WIDTH = 500; // millesimi di em
// Parte del simbolo sopra e sotto la linea di base, in millesimi di em: il simbolo è alto quanto la
// parola, e la selezione nel lettore copre la parola intera
const ASCENT = 800;
const DESCENT = 200;
const FONT_NAME = 'GlyphLess';

// Carattere TrueType minimo: il simbolo 0 (obbligatorio) è un rettangolo, il simbolo 1 è vuoto
function glyphlessFont() {
  const bytes = (...groups) => groups.flat();
  const u16 = (...values) => values.flatMap((v) => [(v >> 8) & 255, v & 255]);
  const u32 = (...values) => values.flatMap((v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
  const utf16 = (text) => u16(...[...text].map((c) => c.charCodeAt(0)));
  const negative = (v) => v & 0xffff;

  const names = [[1, FONT_NAME], [2, 'Regular'], [4, FONT_NAME], [6, FONT_NAME]];
  let nameOffset = 0;
  const nameRecords = names.map(([id, text]) => {
    const record = u16(3, 1, 0x409, id, text.length * 2, nameOffset);
    nameOffset += text.length * 2;
    return record;
  });
  const tables = {
    'OS/2': bytes(u16(1, GLYPH_WIDTH, 400, 5, 0, 650, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0), new Array(10).fill(0),
      u32(0, 0, 0, 0), [78, 79, 78, 69], u16(0x40, 0x20, 0xffff, ASCENT, negative(-DESCENT), 0, ASCENT, DESCENT), u32(1, 0)),
    cmap: bytes(u16(0, 1, 3, 1), u32(12), u16(4, 24, 0, 2, 2, 0, 0, 0xffff, 0, 0xffff, 1, 0)),
    glyf: bytes(u16(1, 0, negative(-DESCENT), GLYPH_WIDTH, ASCENT, 3, 0), [1, 1, 1, 1],
      u16(0, GLYPH_WIDTH, 0, negative(-GLYPH_WIDTH)), u16(negative(-DESCENT), 0, ASCENT + DESCENT, 0)),
    head: bytes(u32(0x10000, 0x10000, 0, 0x5f0f3cf5), u16(0x000b, 1000), new Array(16).fill(0),
      u16(0, negative(-DESCENT), GLYPH_WIDTH, ASCENT, 0, 3, 2, 0, 0)),
    hhea: bytes(u32(0x10000), u16(ASCENT, negative(-DESCENT), 0, GLYPH_WIDTH, 0, 0, GLYPH_WIDTH, 1, 0, 0, 0, 0, 0, 0, 0, 2)),
    hmtx: u16(GLYPH_WIDTH, 0, GLYPH_WIDTH, 0),
    loca: u16(0, 17, 17), // posizioni nel glyf, divise per due: il simbolo 1 non ha dati
    maxp: bytes(u32(0x10000), u16(2, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0)),
    name: bytes(u16(0, names.length, 6 + names.length * 12), ...nameRecords, ...names.map(([, text]) => utf16(text))),
    post: bytes(u32(0x30000, 0), u16(negative(-100), 50), u32(1, 0, 0, 0, 0)),
  };

  // Intestazione, indice delle tabelle, poi le tabelle allineate a quattro byte
  const tags = Object.keys(tables).sort();
  const sum = (data) => {
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      total = (total + ((data[i] << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0))) >>> 0;
    }
    return total;
  };
  const header = u32(0x10000).concat(u16(tags.length, 128, 3, tags.length * 16 - 128));
  let offset = header.length + tags.length * 16;
  const directory = [];
  const body = [];
  let headAt = 0;
  for (const tag of tags) {
    const data = tables[tag];
    if (tag === 'head') headAt = offset;
    directory.push(...[...tag].map((c) => c.charCodeAt(0)), ...u32(sum(data), offset, data.length));
    const padded = data.concat(new Array((4 - (data.length % 4)) % 4).fill(0));
    body.push(...padded);
    offset += padded.length;
  }
  const font = new Uint8Array([...header, ...directory, ...body]);
  // Il controllo dell'intero file va scritto nella tabella head
  const adjustment = (0xb1b0afba - sum(font)) >>> 0;
  font.set(u32(adjustment), headAt + 8);
  return font;
}

// Un carattere fuori dal piano base (un'emoji) in UTF-16 sono due codici, che da soli non sono lettere.
// Nel documento ne prende uno solo, tra quelli delle metà di coppia (D800–DFFF), liberi proprio perché da
// soli non valgono nulla: astral tiene quale (fino a 2048 caratteri diversi per documento).
const SPARE = 0xd800;
function codeOf(char, astral) {
  const point = char.codePointAt(0);
  if (point < 0x10000) return point >= 0xd800 && point <= 0xdfff ? 0xfffd : point;
  if (!astral.has(char)) {
    if (astral.size >= 0x800) return 0xfffd;
    astral.set(char, SPARE + astral.size);
  }
  return astral.get(char);
}

const hex4 = (value) => value.toString(16).padStart(4, '0').toUpperCase();

// Tabella che dice al lettore a quale lettera corrisponde ogni codice: a se stessa, tranne quelli dati ai
// caratteri fuori dal piano base
function toUnicodeCMap(astral) {
  const ranges = [];
  for (let high = 0; high < 256; high++) {
    if (high >= 0xd8 && high <= 0xdf) continue;
    const h = high.toString(16).padStart(2, '0').toUpperCase();
    ranges.push(`<${h}00> <${h}FF> <${h}00>`);
  }
  const chars = [...astral].map(([char, code]) => `<${hex4(code)}> <${hex4(char.charCodeAt(0))}${hex4(char.charCodeAt(1))}>`);
  const blocks = [];
  for (let i = 0; i < ranges.length; i += 100) {
    const block = ranges.slice(i, i + 100);
    blocks.push(`${block.length} beginbfrange\n${block.join('\n')}\nendbfrange`);
  }
  for (let i = 0; i < chars.length; i += 100) {
    const block = chars.slice(i, i + 100);
    blocks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
  }
  return '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
    + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
    + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n'
    + '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
    + `${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`;
}

const number = (value) => (Math.round(value * 1000) / 1000).toString();

// Le scritture da destra a sinistra (ebraico, arabo...) si scrivono nell'ordine in cui si vedono, come si
// aspetta chi legge il PDF, che poi le rimette nell'ordine giusto: ogni tratto da destra a sinistra si
// rovescia, e se la riga comincia in quella direzione si rovescia anche l'ordine dei tratti (numeri e
// parole latine restano come sono). Gli spazi e i segni tra due tratti seguono la direzione della riga.
const RIGHT_TO_LEFT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const STRONG = /[\p{L}\p{N}]/u;
function visualOrder(text) {
  if (!RIGHT_TO_LEFT.test(text)) return text;
  const chars = [...text];
  const kinds = chars.map((char) => (RIGHT_TO_LEFT.test(char) ? 'R' : STRONG.test(char) ? 'L' : ''));
  const base = kinds.find(Boolean);
  // La direzione forte più vicina prima e dopo di ogni segno neutro
  const before = [];
  let last = '';
  for (const kind of kinds) before.push((last = kind || last));
  const after = [];
  last = '';
  for (let i = kinds.length - 1; i >= 0; i--) after[i] = (last = kinds[i] || last);
  const runs = [];
  chars.forEach((char, i) => {
    const kind = kinds[i] || (before[i] && before[i] === after[i] ? before[i] : base);
    if (runs.at(-1)?.kind === kind) runs.at(-1).chars.push(char);
    else runs.push({ kind, chars: [char] });
  });
  if (base === 'R') runs.reverse();
  return runs.map((run) => (run.kind === 'R' ? run.chars.reverse() : run.chars).join('')).join('');
}

// Istruzioni che scrivono le parole, invisibili. place(word) dà la posizione in punti della linea di
// base, la grandezza e la larghezza che la parola occupa nell'immagine. astral: vedi codeOf.
function textLayer(words, place, astral) {
  let out = 'BT\n3 Tr\n';
  for (const word of words) {
    const text = visualOrder(word.t.replace(/\s+/g, ' ').trim());
    if (!text) continue;
    const { x, y, size, width } = place(word);
    if (!(size > 0.5 && width > 0)) continue;
    const codes = [...text].map((char) => codeOf(char, astral));
    let hex = codes.map((code) => code.toString(16).padStart(4, '0')).join('');
    // Lo spazio dopo la parola aiuta chi copia a ritrovare le parole separate
    if (word.space) hex += '0020';
    // I simboli si stringono o si allargano fino a coprire esattamente la parola nell'immagine
    const stretch = (100 * width) / ((codes.length * GLYPH_WIDTH * size) / 1000);
    out += `/F0 ${number(size)} Tf ${number(stretch)} Tz 1 0 0 1 ${number(x)} ${number(y)} Tm <${hex}> Tj\n`;
  }
  return `${out}ET\n`;
}

async function deflate(data) {
  return new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'))).blob();
}

// images: [{ canvas, pixelsPerPoint, words }], una per pagina del documento. canvas può essere anche una
// funzione che lo prepara al momento: così le immagini si tengono in memoria una alla volta.
// pixelsPerPoint: quanti pixel dell'immagine stanno in un punto tipografico.
// words, facoltative: il testo da rendere ricercabile, [{ t, x, y, w, h, space }] in pixel dell'immagine.
// links, facoltativi: zone che si aprono con un clic nel lettore, [{ x, y, w, h, url }] in pixel dell'immagine.
// a4: impagina su fogli A4 invece di dare a ogni immagine una pagina della sua misura.
// info, facoltative: le proprietà del documento ({ Title, Subject, Creator, Producer, CreationDate }).
export async function imagesToPdf(images, a4 = false, info = null) {
  // Il PDF vuole la posizione in byte di ogni oggetto: le parti sono solo ASCII o binarie
  const parts = [];
  const offsets = [];
  let position = 0;
  const push = (part) => {
    parts.push(part);
    position += typeof part === 'string' ? part.length : part.size ?? part.length;
  };
  const object = (number, body) => {
    offsets[number] = position;
    push(`${number} 0 obj\n${body}\nendobj\n`);
  };

  // Oggetto 1: il documento; 2: l'elenco delle pagine, scritto per ultimo quando si sa quante sono.
  // Se c'è del testo, i numeri che seguono vanno al carattere invisibile, scritto anch'esso alla fine.
  let next = 3;
  const pages = [];
  const astral = new Map(); // i caratteri fuori dal piano base e il loro codice (vedi codeOf)
  const hasText = images.some((image) => image.words?.length);
  const font = hasText ? next : 0;
  if (hasText) next += 6;
  const fontResource = hasText ? ` /Font << /F0 ${font} 0 R >>` : '';
  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // segnala che il file è binario
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');

  for (const image of images) {
    const canvas = typeof image.canvas === 'function' ? await image.canvas() : image.canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { scale, sheets } = layOut(canvas, image.pixelsPerPoint, a4);
    const drawnWidth = (canvas.width * scale).toFixed(2);

    for (const sheet of sheets) {
      // Ogni fascia viene disegnata al suo posto; l'origine del PDF è in basso a sinistra
      const bands = splitInBands(canvas.width, sheet.rows);
      const page = next++;
      const contents = next++;
      const firstImage = next;
      next += bands.length;
      let content = bands.map(({ top, rows }, index) => {
        const bandHeight = (rows * scale).toFixed(3);
        const bottom = (sheet.height - sheet.y - (top + rows) * scale).toFixed(3);
        return `q ${drawnWidth} 0 0 ${bandHeight} ${sheet.x.toFixed(3)} ${bottom} cm /Im${index} Do Q\n`;
      }).join('');
      // Le parole di questo foglio: quelle il cui centro cade nel tratto d'immagine che contiene
      const words = (image.words || []).filter((word) => {
        const middle = word.y + word.h / 2;
        return middle >= sheet.top && middle < sheet.top + sheet.rows;
      });
      if (words.length) {
        content += textLayer(words, (word) => ({
          x: sheet.x + word.x * scale,
          y: sheet.height - sheet.y - (word.y + (word.h * ASCENT) / (ASCENT + DESCENT) - sheet.top) * scale,
          size: word.h * scale,
          width: word.w * scale,
        }), astral);
      }
      const names = bands.map((band, index) => `/Im${index} ${firstImage + index} 0 R`).join(' ');
      // I link di questo foglio, come le parole: quelli il cui centro cade nel suo tratto d'immagine
      const links = (image.links || []).filter((link) => {
        const middle = link.y + link.h / 2;
        return middle >= sheet.top && middle < sheet.top + sheet.rows;
      });
      const annotations = links.map(() => next++);
      const annots = annotations.length ? ` /Annots [${annotations.map((n) => `${n} 0 R`).join(' ')}]` : '';

      pages.push(page);
      object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${sheet.width.toFixed(2)} ${sheet.height.toFixed(2)}] `
        + `/Resources << /XObject << ${names} >>${fontResource} >> /Contents ${contents} 0 R${annots} >>`);
      for (const [index, link] of links.entries()) {
        const left = sheet.x + link.x * scale;
        const top = sheet.height - sheet.y - (link.y - sheet.top) * scale;
        const rect = [left, top - link.h * scale, left + link.w * scale, top].map(number).join(' ');
        object(annotations[index], `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] `
          + `/A << /S /URI /URI ${pdfString(asciiUrl(link.url))} >> >>`);
      }
      if (words.length) {
        // Con il testo le istruzioni diventano lunghe: si comprimono
        const packed = await deflate(content);
        offsets[contents] = position;
        push(`${contents} 0 obj\n<< /Length ${packed.size} /Filter /FlateDecode >>\nstream\n`);
        push(packed);
        push('\nendstream\nendobj\n');
      } else {
        object(contents, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
      }

      for (const [index, { top, rows }] of bands.entries()) {
        const pixels = await compressRows(ctx, canvas.width, sheet.top + top, rows);
        offsets[firstImage + index] = position;
        push(`${firstImage + index} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${rows} `
          + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode '
          + `/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${canvas.width} >> `
          + `/Length ${pixels.size} >>\nstream\n`);
        push(pixels);
        push('\nendstream\nendobj\n');
      }
    }
  }

  object(2, `<< /Type /Pages /Kids [${pages.map((page) => `${page} 0 R`).join(' ')}] /Count ${pages.length} >>`);

  if (hasText) {
    // Carattere composto (Type0) che rimanda a quello vero, alla sua descrizione, al file del
    // carattere, alla tabella che porta ogni codice al simbolo vuoto e a quella delle lettere
    const [descendant, descriptor, file, map, unicode] = [1, 2, 3, 4, 5].map((n) => font + n);
    object(font, `<< /Type /Font /Subtype /Type0 /BaseFont /${FONT_NAME} /Encoding /Identity-H `
      + `/DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`);
    object(descendant, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${FONT_NAME} `
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> '
      + `/FontDescriptor ${descriptor} 0 R /DW ${GLYPH_WIDTH} /CIDToGIDMap ${map} 0 R >>`);
    object(descriptor, `<< /Type /FontDescriptor /FontName /${FONT_NAME} /Flags 5 /FontBBox [0 -${DESCENT} ${GLYPH_WIDTH} ${ASCENT}] `
      + `/ItalicAngle 0 /Ascent ${ASCENT} /Descent -${DESCENT} /CapHeight ${ASCENT} /StemV 80 /FontFile2 ${file} 0 R >>`);
    const fontFile = glyphlessFont();
    offsets[file] = position;
    push(`${file} 0 obj\n<< /Length ${fontFile.length} /Length1 ${fontFile.length} >>\nstream\n`);
    push(fontFile);
    push('\nendstream\nendobj\n');
    // Ogni codice, da 0 a 65535, va al simbolo 1: due byte per codice
    const glyphs = new Uint8Array(65536 * 2);
    for (let i = 1; i < glyphs.length; i += 2) glyphs[i] = 1;
    const packed = await deflate(glyphs);
    offsets[map] = position;
    push(`${map} 0 obj\n<< /Length ${packed.size} /Filter /FlateDecode >>\nstream\n`);
    push(packed);
    push('\nendstream\nendobj\n');
    const cmap = toUnicodeCMap(astral);
    object(unicode, `<< /Length ${cmap.length} >>\nstream\n${cmap}endstream`);
  }

  let infoReference = '';
  const entries = Object.entries(info || {}).filter(([, value]) => value);
  if (entries.length) {
    const number = next++;
    object(number, `<< ${entries.map(([key, value]) => `/${key} ${pdfString(value)}`).join(' ')} >>`);
    infoReference = ` /Info ${number} 0 R`;
  }

  const xrefPosition = position;
  let xref = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let number = 1; number < next; number++) {
    xref += `${String(offsets[number]).padStart(10, '0')} 00000 n \n`;
  }
  push(`${xref}trailer\n<< /Size ${next} /Root 1 0 R${infoReference} >>\nstartxref\n${xrefPosition}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}

// Una sola immagine, in una pagina della sua misura
export function canvasToPdf(canvas, pixelsPerPoint, words, info) {
  return imagesToPdf([{ canvas, pixelsPerPoint, words }], false, info);
}

// Un indirizzo per un link del PDF, che lo vuole di soli caratteri ASCII: com'è scritto dal browser, che
// codifica già tutto il resto (decodificarlo e ricodificarlo cambierebbe i %26, %3D, %2F di una ricerca).
// Solo pagine web: nessun altro tipo di link.
function asciiUrl(url) {
  try {
    const { href, protocol } = new URL(url);
    return /^https?:$/.test(protocol) ? href : '';
  } catch {
    return '';
  }
}

// Una stringa del PDF: com'è se è ASCII semplice, altrimenti in UTF-16 scritto in esadecimale (il file
// resta di soli caratteri ASCII, come vuole il calcolo delle posizioni)
function pdfString(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return `(${text.replace(/[\\()]/g, '\\$&')})`;
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}
