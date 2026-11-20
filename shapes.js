// Geometria e disegno delle annotazioni. Tutte le coordinate sono in pixel dell'immagine.

export const LINE_HEIGHT = 1.25;
const FONT_FAMILY = 'Arial, Helvetica, sans-serif';

// Maniglie dei rettangoli: [id, frazione orizzontale, frazione verticale, cursore]
const RECT_HANDLES = [
  ['nw', 0, 0, 'nwse-resize'], ['n', 0.5, 0, 'ns-resize'], ['ne', 1, 0, 'nesw-resize'],
  ['e', 1, 0.5, 'ew-resize'], ['se', 1, 1, 'nwse-resize'], ['s', 0.5, 1, 'ns-resize'],
  ['sw', 0, 1, 'nesw-resize'], ['w', 0, 0.5, 'ew-resize'],
];

const measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
// Aree rielaborate (sfocate o a mosaico) già calcolate, una per oggetto
const patchCache = new WeakMap();

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
export const isSegment = (o) => o.type === 'line' || o.type === 'arrow';

// --- Testo ---

export function fontOf(o, size = o.size) {
  return `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${size}px ${FONT_FAMILY}`;
}

export function bubblePad(o) {
  return Math.round(o.size * 0.6);
}

// Bianco o nero, a seconda di quale si legge meglio sul colore dato (#rrggbb, con o senza trasparenza)
export function contrastColor(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const luminance = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return luminance > 150 ? '#111111' : '#ffffff';
}

// Divide il testo in righe; con maxWidth manda a capo come farebbe un paragrafo
export function layoutText(o, maxWidth = Infinity) {
  measureCtx.font = fontOf(o);
  const widthOf = (text) => measureCtx.measureText(text).width;
  const lines = [];

  for (const paragraph of o.text.split('\n')) {
    if (maxWidth === Infinity) {
      lines.push(paragraph);
      continue;
    }
    let line = '';
    for (let word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (widthOf(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line !== '') lines.push(line);
      // Parola più larga della riga: va spezzata
      while (word.length > 1 && widthOf(word) > maxWidth) {
        let n = 1;
        while (n < word.length - 1 && widthOf(word.slice(0, n + 1)) <= maxWidth) n++;
        lines.push(word.slice(0, n));
        word = word.slice(n);
      }
      line = word;
    }
    lines.push(line);
  }

  // Stessa posizione della linea di base che userebbe il browser in una riga di testo
  const metrics = measureCtx.measureText('Mg');
  const ascent = metrics.fontBoundingBoxAscent;
  const lineHeight = o.size * LINE_HEIGHT;
  return {
    lines,
    lineHeight,
    baseline: (lineHeight - ascent - metrics.fontBoundingBoxDescent) / 2 + ascent,
    width: Math.max(...lines.map(widthOf)),
    height: lines.length * lineHeight,
  };
}

function drawLines(ctx, o, x, y, layout, color) {
  ctx.font = fontOf(o);
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  layout.lines.forEach((line, i) => ctx.fillText(line, x, y + i * layout.lineHeight + layout.baseline));
}

// --- Fumetto ---

// Allarga il fumetto quanto basta per contenere il suo testo
export function fitBubble(o) {
  const pad = bubblePad(o);
  o.w = Math.max(o.w, o.size * 3 + pad * 2);
  const grown = layoutText(o, o.w - pad * 2).height + pad * 2 - o.h;
  if (grown <= 0) return;
  // Se la coda punta verso il basso, scende insieme al bordo
  if (o.ty > o.y + o.h) o.ty += grown;
  o.h += grown;
}

// Punto del corpo del fumetto da cui parte la coda, e sua semi-larghezza
function bubbleTail(o) {
  const radius = Math.min(o.size * 0.7, o.w / 2, o.h / 2);
  return {
    radius,
    half: radius * 0.85,
    x: clamp(o.tx, o.x + radius, o.x + o.w - radius),
    y: clamp(o.ty, o.y + radius, o.y + o.h - radius),
  };
}

function drawBubble(ctx, o, hideText) {
  const tail = bubbleTail(o);
  const dx = o.tx - tail.x;
  const dy = o.ty - tail.y;
  const length = Math.hypot(dx, dy);

  // Coda e corpo in un solo tracciato: con un colore trasparente la zona in comune
  // non deve risultare più scura del resto
  ctx.fillStyle = o.color;
  ctx.beginPath();
  if (length > 1) {
    let px = (-dy / length) * tail.half;
    let py = (dx / length) * tail.half;
    // Stesso verso di percorrenza del rettangolo, altrimenti la zona in comune resterebbe vuota
    if (px * dy - py * dx < 0) {
      px = -px;
      py = -py;
    }
    ctx.moveTo(o.tx, o.ty);
    ctx.lineTo(tail.x - px, tail.y - py);
    ctx.lineTo(tail.x + px, tail.y + py);
    ctx.closePath();
  }
  ctx.roundRect(o.x, o.y, o.w, o.h, tail.radius);
  ctx.fill();

  if (hideText) return;
  const pad = bubblePad(o);
  drawLines(ctx, o, o.x + pad, o.y + pad, layoutText(o, o.w - pad * 2), contrastColor(o.color));
}

// --- Freccia ---

function drawArrow(ctx, o) {
  const dx = o.x2 - o.x1;
  const dy = o.y2 - o.y1;
  const length = Math.hypot(dx, dy);
  if (length < 1) return;

  const ux = dx / length;
  const uy = dy / length;
  const head = Math.min(length, o.width * 4.5);
  const half = head * 0.45;
  // Base della punta: l'asta si ferma qui, così non sporge oltre il vertice
  const bx = o.x2 - ux * head;
  const by = o.y2 - uy * head;
  // Semi-larghezza dell'asta, mai più larga della punta
  const shaft = Math.min(o.width / 2, half);
  // Vettore perpendicolare alla freccia
  const nx = -uy;
  const ny = ux;

  // Asta, estremità arrotondata e punta in un solo contorno: nessuna parte si sovrappone
  // a un'altra, quindi un colore trasparente resta uniforme
  const back = Math.atan2(-ny, -nx);
  ctx.beginPath();
  ctx.moveTo(o.x1 + nx * shaft, o.y1 + ny * shaft);
  ctx.lineTo(bx + nx * shaft, by + ny * shaft);
  ctx.lineTo(bx + nx * half, by + ny * half);
  ctx.lineTo(o.x2, o.y2);
  ctx.lineTo(bx - nx * half, by - ny * half);
  ctx.lineTo(bx - nx * shaft, by - ny * shaft);
  ctx.lineTo(o.x1 - nx * shaft, o.y1 - ny * shaft);
  ctx.arc(o.x1, o.y1, shaft, back, back - Math.PI, true);
  ctx.closePath();
  ctx.fill();
}

// --- Sfocatura ---

// Porzione sfocata della schermata; ricalcolata solo quando l'area cambia. Per i video la base cambia a
// ogni fotogramma: base.frame, se c'è, ne è il numero e rende nuovo il calcolo.
function blurredPatch(o, base) {
  const x = Math.round(o.x);
  const y = Math.round(o.y);
  const w = Math.round(o.w);
  const h = Math.round(o.h);
  const key = [x, y, w, h, o.radius, base.frame ?? 0].join();
  const cached = patchCache.get(o);
  if (cached?.key === key) return cached.canvas;

  // Sorgente più larga dell'area, così la sfocatura non sfuma verso il trasparente ai bordi
  const pad = Math.ceil(o.radius * 3);
  const source = new OffscreenCanvas(w + pad * 2, h + pad * 2);
  const sourceCtx = source.getContext('2d');
  const left = clamp(x - pad, 0, base.width);
  const top = clamp(y - pad, 0, base.height);
  const right = clamp(x + w + pad, 0, base.width);
  const bottom = clamp(y + h + pad, 0, base.height);
  if (right > left && bottom > top) {
    // Riempimento grossolano per le zone oltre il bordo della schermata, poi i pixel veri
    sourceCtx.drawImage(base, left, top, right - left, bottom - top, 0, 0, source.width, source.height);
    sourceCtx.drawImage(base, left, top, right - left, bottom - top, left - x + pad, top - y + pad, right - left, bottom - top);
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.filter = `blur(${o.radius}px)`;
  ctx.drawImage(source, -pad, -pad);
  patchCache.set(o, { key, canvas });
  return canvas;
}

// --- Pixel ---

// Mosaico della schermata: ogni blocco prende il colore medio della zona che copre
function pixelatedPatch(o, base) {
  const x = Math.round(o.x);
  const y = Math.round(o.y);
  const w = Math.round(o.w);
  const h = Math.round(o.h);
  const key = [x, y, w, h, o.block, base.frame ?? 0].join();
  const cached = patchCache.get(o);
  if (cached?.key === key) return cached.canvas;

  const canvas = new OffscreenCanvas(w, h);
  // Si lavora solo sulla parte che cade dentro la schermata
  const left = clamp(x, 0, base.width);
  const top = clamp(y, 0, base.height);
  const width = clamp(x + w, 0, base.width) - left;
  const height = clamp(y + h, 0, base.height) - top;
  if (width > 0 && height > 0) {
    // Rimpicciolisce fino a un pixel per blocco, poi ingrandisce senza sfumare
    const columns = Math.max(1, Math.round(width / o.block));
    const rows = Math.max(1, Math.round(height / o.block));
    const small = new OffscreenCanvas(columns, rows);
    const smallCtx = small.getContext('2d');
    smallCtx.imageSmoothingQuality = 'high';
    smallCtx.drawImage(base, left, top, width, height, 0, 0, columns, rows);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, columns, rows, left - x, top - y, width, height);
  }
  patchCache.set(o, { key, canvas });
  return canvas;
}

// --- Passo numerato ---
// Un bollino (livello 1) o un sottobollino (livello 2, più piccolo). Il contenuto dipende dallo stile:
// numeri, lettere maiuscole o minuscole, numeri romani, un simbolo o un testo scelto dall'utente.
// I bollini si contano per stile, ognuno nella sua serie; i sottobollini dentro il bollino che li
// precede, e si scrivono come negli elenchi: 1.1, 1.2...

export const STEP_STYLES = ['number', 'upper', 'lower', 'roman', 'symbol', 'custom'];
const SUB_STEP = 0.75; // grandezza di un sottobollino rispetto a un bollino
// Metà larghezza dei bollini allungati per contenere un testo lungo: la calcola il disegno
const stepHalfWidths = new WeakMap();

export function stepRadius(o) {
  return o.size * 0.8 * (o.level === 2 ? SUB_STEP : 1);
}

const stepStyleOf = (o) => (STEP_STYLES.includes(o.style) ? o.style : 'number');

function lettersOf(n) {
  let text = '';
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) text = String.fromCharCode(65 + ((rest - 1) % 26)) + text;
  return text;
}

function romanOf(n) {
  const parts = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let text = '';
  let rest = n;
  for (const [value, digits] of parts) for (; rest >= value; rest -= value) text += digits;
  return text;
}

function counted(n, style) {
  if (style === 'upper') return lettersOf(n);
  if (style === 'lower') return lettersOf(n).toLowerCase();
  if (style === 'roman') return romanOf(n);
  return String(n);
}

// Il contenuto di ogni bollino, numerati nell'ordine in cui sono stati messi: Map bollino → testo
export function stepLabels(objects) {
  const labels = new Map();
  const counts = {};
  let parent = { label: '', counts: {} }; // ultimo bollino da cui dipendono i sottobollini
  // Nell'ordine in cui i bollini sono stati messi (seq), che non cambia portandoli sopra o sotto gli altri
  // segni. Senza seq (le pagine che non lo usano) vale la posizione tra i segni.
  const steps = objects.filter((o) => o.type === 'step')
    .map((o, index) => ({ o, order: o.seq ?? index }))
    .sort((a, b) => a.order - b.order);
  for (const { o } of steps) {
    const style = stepStyleOf(o);
    // Simboli e testi non si contano: mostrano quello che l'utente ha scelto
    if (style === 'symbol' || style === 'custom') {
      labels.set(o, String(o.label || ''));
      if (o.level !== 2 && style === 'custom') parent = { label: labels.get(o), counts: {} };
      continue;
    }
    if (o.level === 2) {
      parent.counts[style] = (parent.counts[style] || 0) + 1;
      const index = counted(parent.counts[style], style);
      labels.set(o, parent.label ? `${parent.label}.${index}` : index);
    } else {
      counts[style] = (counts[style] || 0) + 1;
      labels.set(o, counted(counts[style], style));
      parent = { label: labels.get(o), counts: {} };
    }
  }
  return labels;
}

// Numero d'ordine di un bollino nuovo: viene dopo tutti quelli che ci sono (vedi stepLabels)
export function nextStepSeq(objects) {
  return objects.filter((o) => o.type === 'step').reduce((last, o, index) => Math.max(last, o.seq ?? index), -1) + 1;
}

// Bollino pieno con il contenuto al centro e un bordo sottile che lo stacca dallo sfondo.
// Un contenuto che non sta nel cerchio lo allunga in orizzontale.
export function drawStep(ctx, o, label) {
  const text = String(label);
  const radius = stepRadius(o);
  const ink = contrastColor(o.color);
  const font = (radius / 0.8) * (text.length > 2 ? 0.7 : 1);
  ctx.save();
  ctx.font = fontOf({ bold: true }, font);
  const metrics = ctx.measureText(text);
  const half = Math.max(radius, metrics.width / 2 + radius * 0.45);
  stepHalfWidths.set(o, half);
  const border = (radius / 0.8) * 0.1;
  const outline = (inset) => {
    ctx.beginPath();
    ctx.roundRect(o.x - half + inset, o.y - radius + inset, (half - inset) * 2, (radius - inset) * 2, radius - inset);
  };
  // Il riempimento si ferma dove comincia il bordo, così non si sommano
  outline(border / 2);
  ctx.fillStyle = o.color;
  ctx.fill();
  outline(0);
  ctx.lineWidth = border;
  ctx.strokeStyle = ink;
  ctx.stroke();

  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, o.x, o.y + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
  ctx.restore();
}

// --- Disegno ---

export function drawObject(ctx, o, base, hideText = false) {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = o.color;
  ctx.lineWidth = o.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (o.type) {
    case 'rect':
      ctx.strokeRect(o.x, o.y, o.w, o.h);
      break;
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(o.x + o.w / 2, o.y + o.h / 2, o.w / 2, o.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'line':
      ctx.beginPath();
      ctx.moveTo(o.x1, o.y1);
      ctx.lineTo(o.x2, o.y2);
      ctx.stroke();
      break;
    case 'arrow':
      drawArrow(ctx, o);
      break;
    case 'highlight':
      // "multiply" lascia leggibile il testo scuro, come un vero evidenziatore
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillRect(o.x, o.y, o.w, o.h);
      // Un velo leggero rende visibile l'evidenziazione anche sugli sfondi scuri
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.2;
      ctx.fillRect(o.x, o.y, o.w, o.h);
      break;
    case 'blur':
      if (o.w >= 1 && o.h >= 1) ctx.drawImage(blurredPatch(o, base), Math.round(o.x), Math.round(o.y));
      break;
    case 'pixel':
      if (o.w >= 1 && o.h >= 1) ctx.drawImage(pixelatedPatch(o, base), Math.round(o.x), Math.round(o.y));
      break;
    case 'cover':
      ctx.fillRect(o.x, o.y, o.w, o.h);
      break;
    case 'stroke':
      drawStroke(ctx, o);
      break;
    case 'text':
      if (!hideText) drawLines(ctx, o, o.x, o.y, layoutText(o), o.color);
      break;
    case 'bubble':
      drawBubble(ctx, o, hideText);
      break;
  }
  ctx.restore();
}

// Tratto a mano libera che passa per o.points; con un punto solo è un tondo
function drawStroke(ctx, o) {
  const [first, ...rest] = o.points;
  ctx.beginPath();
  if (rest.length) {
    ctx.moveTo(first[0], first[1]);
    // Ogni punto fa da guida a una curva che arriva a metà strada verso il successivo:
    // il tratto passa morbido dove la mano ha cambiato direzione, senza spigoli
    for (let i = 0; i < rest.length - 1; i++) {
      const [x, y] = rest[i];
      const [nextX, nextY] = rest[i + 1];
      ctx.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
    }
    ctx.lineTo(...rest.at(-1));
    ctx.stroke();
  } else {
    ctx.arc(first[0], first[1], o.width / 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Sfocatura e pixel rielaborano la schermata, quindi stanno sotto a tutte le altre annotazioni
export const reworksBase = (o) => o.type === 'blur' || o.type === 'pixel';

// Schermata più annotazioni.
export function drawScene(ctx, base, objects, editing = null) {
  ctx.drawImage(base, 0, 0);
  for (const o of objects) if (reworksBase(o)) drawObject(ctx, o, base);
  // I passi si numerano da soli, nell'ordine in cui sono stati messi
  const labels = stepLabels(objects);
  for (const o of objects) {
    if (o.type === 'step') drawStep(ctx, o, labels.get(o));
    else if (!reworksBase(o)) drawObject(ctx, o, base, o === editing);
  }
}

// --- Geometria ---

export function boundsOf(o) {
  if (isSegment(o)) {
    return {
      x: Math.min(o.x1, o.x2), y: Math.min(o.y1, o.y2),
      w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1),
    };
  }
  if (o.type === 'text') {
    const layout = layoutText(o);
    return { x: o.x, y: o.y, w: layout.width, h: layout.height };
  }
  if (o.type === 'step') {
    const radius = stepRadius(o);
    const half = stepHalfWidths.get(o) || radius;
    return { x: o.x - half, y: o.y - radius, w: half * 2, h: radius * 2 };
  }
  if (o.type === 'stroke') {
    const xs = o.points.map(([x]) => x);
    const ys = o.points.map(([, y]) => y);
    const half = o.width / 2;
    const left = Math.min(...xs) - half;
    const top = Math.min(...ys) - half;
    return { x: left, y: top, w: Math.max(...xs) + half - left, h: Math.max(...ys) + half - top };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

export function inRect(p, r, grow = 0) {
  return r.w + grow * 2 > 0 && r.h + grow * 2 > 0
    && p.x >= r.x - grow && p.x <= r.x + r.w + grow
    && p.y >= r.y - grow && p.y <= r.y + r.h + grow;
}

function inEllipse(p, r, grow) {
  const rx = r.w / 2 + grow;
  const ry = r.h / 2 + grow;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (p.x - r.x - r.w / 2) / rx;
  const dy = (p.y - r.y - r.h / 2) / ry;
  return dx * dx + dy * dy <= 1;
}

function distanceToSegment(p, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq ? clamp(((p.x - x1) * dx + (p.y - y1) * dy) / lengthSq, 0, 1) : 0;
  return Math.hypot(p.x - x1 - t * dx, p.y - y1 - t * dy);
}

// Vero se il punto tocca l'oggetto. Le forme vuote si prendono solo sul bordo.
export function hitTest(o, p, tolerance) {
  const reach = tolerance + (o.width || 0) / 2;
  switch (o.type) {
    case 'line':
    case 'arrow':
      return distanceToSegment(p, o.x1, o.y1, o.x2, o.y2) <= reach;
    case 'rect':
      return inRect(p, o, reach) && !inRect(p, o, -reach);
    case 'ellipse':
      return inEllipse(p, o, reach) && !inEllipse(p, o, -reach);
    case 'stroke':
      // Si prende solo toccando il tratto, non tutto il rettangolo che lo contiene
      return o.points.some(([x, y], i) => {
        const [nx, ny] = o.points[i + 1] || [x, y];
        return distanceToSegment(p, x, y, nx, ny) <= reach;
      });
    case 'bubble': {
      const tail = bubbleTail(o);
      return inRect(p, o, tolerance) || distanceToSegment(p, tail.x, tail.y, o.tx, o.ty) <= tail.half;
    }
    default:
      return inRect(p, boundsOf(o), tolerance);
  }
}

export function handlesOf(o) {
  if (isSegment(o)) {
    return [
      { id: 'p1', x: o.x1, y: o.y1, cursor: 'move' },
      { id: 'p2', x: o.x2, y: o.y2, cursor: 'move' },
    ];
  }
  // Testi, passi e tratti a mano libera si spostano soltanto: la dimensione si regola dalla barra in alto
  if (o.type === 'text' || o.type === 'step' || o.type === 'stroke') return [];
  const handles = RECT_HANDLES.map(([id, fx, fy, cursor]) => ({ id, x: o.x + o.w * fx, y: o.y + o.h * fy, cursor }));
  if (o.type === 'bubble') handles.push({ id: 'tail', x: o.tx, y: o.ty, cursor: 'move' });
  return handles;
}

// Sposta una maniglia nel punto p; "original" è la geometria all'inizio del trascinamento
export function resizeWithHandle(o, id, p, original) {
  if (id === 'p1') return Object.assign(o, { x1: p.x, y1: p.y });
  if (id === 'p2') return Object.assign(o, { x2: p.x, y2: p.y });
  if (id === 'tail') return Object.assign(o, { tx: p.x, ty: p.y });

  let left = original.x;
  let top = original.y;
  let right = original.x + original.w;
  let bottom = original.y + original.h;
  if (id.includes('w')) left = p.x;
  if (id.includes('e')) right = p.x;
  if (id.includes('n')) top = p.y;
  if (id.includes('s')) bottom = p.y;
  return Object.assign(o, {
    x: Math.min(left, right), y: Math.min(top, bottom),
    w: Math.abs(right - left), h: Math.abs(bottom - top),
  });
}

export function moveBy(o, dx, dy) {
  if (isSegment(o)) {
    o.x1 += dx; o.y1 += dy; o.x2 += dx; o.y2 += dy;
    return;
  }
  if (o.type === 'stroke') {
    o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
    return;
  }
  o.x += dx; o.y += dy;
  if (o.type === 'bubble') { o.tx += dx; o.ty += dy; }
}
