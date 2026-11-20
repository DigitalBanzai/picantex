// Funzioni che il service worker inietta nella pagina per far scegliere all'utente cosa catturare.

// Mostra l'overlay su cui tracciare il rettangolo da catturare.
// Deve essere autosufficiente; hintText è il suggerimento già tradotto. Trascinando senza tasti si cattura
// appena si lascia il mouse. Con Maiusc o Ctrl premuto, invece, il rettangolo resta sulla pagina: lo si
// sposta e lo si ridimensiona dalle maniglie, scorrendo la pagina (anche da sola, vicino ai bordi) per
// allungarlo oltre la finestra; Invio o "Cattura" lo affidano alla cattura dell'elemento, che fotografa
// anche un'area più grande della finestra. labels: { capture, cancel, adjust } già tradotti.
export function selectArea(hintText, labels = {}) {
  const ID = 'picantex-selection-overlay';
  // Evita di iniettare due volte l'overlay. Si guarda il nostro, tenuto in questo mondo isolato: un
  // elemento con lo stesso id messo dalla pagina non deve bastare a impedire la selezione.
  if (window.__picantexOverlay?.isConnected) return;

  const SHADE = 'rgba(0, 0, 0, 0.45)';
  const BLUE = '#1a73e8';
  const EDGE = 40; // vicino al bordo della finestra, trascinando, la pagina scorre da sola
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  // "all: initial" protegge i nostri elementi dagli stili della pagina
  const create = (styles) => {
    const el = document.createElement('div');
    el.style.all = 'initial';
    Object.assign(el.style, styles);
    return el;
  };

  // Overlay scuro a tutto schermo
  const overlay = create({
    display: 'block', position: 'fixed', inset: '0', zIndex: '2147483647',
    overflow: 'hidden', background: SHADE, cursor: 'crosshair', userSelect: 'none',
  });
  overlay.id = ID;
  window.__picantexOverlay = overlay;

  // Rettangolo di selezione: l'ombra enorme scurisce tutto ciò che resta fuori
  const box = create({
    display: 'none', position: 'absolute', boxSizing: 'border-box',
    border: '1px dashed #fff', boxShadow: `0 0 0 100vmax ${SHADE}`, pointerEvents: 'none',
  });

  const labelStyle = {
    display: 'block', position: 'absolute', padding: '5px 10px', borderRadius: '5px',
    background: 'rgba(0, 0, 0, 0.75)', color: '#fff', font: '13px/1.3 system-ui, sans-serif',
    whiteSpace: 'nowrap', pointerEvents: 'none',
  };
  const hint = create({ ...labelStyle, top: '16px', left: '50%', transform: 'translateX(-50%)' });
  hint.textContent = hintText;
  const size = create({ ...labelStyle, top: '4px', left: '4px', padding: '2px 6px', fontSize: '11px' });

  box.appendChild(size);
  overlay.append(box, hint);
  document.documentElement.appendChild(overlay);

  let start = null;      // punto di partenza del trascinamento (pixel della finestra, o della pagina se editable)
  let editable = false;  // il rettangolo resta modificabile (Maiusc o Ctrl all'inizio del trascinamento)
  let area = null;       // area modificabile, in pixel della pagina: { x, y, w, h }
  let drag = null;       // cosa si sta trascinando dell'area: { kind, from, area }
  let pointer = null;    // ultima posizione del puntatore nella finestra, per lo scorrimento automatico
  let scrolling = 0;     // richiesta di animazione dello scorrimento automatico

  // Rettangolo tra il punto iniziale e il puntatore (supporta il trascinamento in tutte le direzioni)
  const rectTo = (e) => {
    const x = clamp(e.clientX, 0, window.innerWidth);
    const y = clamp(e.clientY, 0, window.innerHeight);
    return {
      x: Math.min(x, start.x), y: Math.min(y, start.y),
      w: Math.abs(x - start.x), h: Math.abs(y - start.y),
    };
  };

  const draw = (rect) => {
    Object.assign(box.style, {
      display: 'block', left: `${rect.x}px`, top: `${rect.y}px`,
      width: `${rect.w}px`, height: `${rect.h}px`,
    });
    size.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
  };

  // --- Area modificabile ---
  // Pixel della pagina del punto della finestra (x, y)
  const onPage = (x, y) => ({ x: x + window.scrollX, y: y + window.scrollY });
  const pageWidth = () => document.documentElement.scrollWidth;
  const pageHeight = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);

  // Maniglie sugli angoli e sui lati; il nome dice quali bordi muovono (n, s, e, w)
  const HANDLES = { nw: 'nwse', n: 'ns', ne: 'nesw', e: 'ew', se: 'nwse', s: 'ns', sw: 'nesw', w: 'ew' };
  const handles = Object.entries(HANDLES).map(([name, cursor]) => {
    const h = create({
      display: 'none', position: 'absolute', width: '12px', height: '12px', boxSizing: 'border-box',
      background: '#fff', border: `2px solid ${BLUE}`, borderRadius: '3px', cursor: `${cursor}-resize`,
      pointerEvents: 'auto', transform: 'translate(-50%, -50%)',
    });
    h.dataset.edge = name;
    box.appendChild(h);
    return h;
  });
  const place = { n: ['50%', '0'], s: ['50%', '100%'], e: ['100%', '50%'], w: ['0', '50%'], nw: ['0', '0'], ne: ['100%', '0'], se: ['100%', '100%'], sw: ['0', '100%'] };
  for (const h of handles) [h.style.left, h.style.top] = place[h.dataset.edge];

  // Barra con le misure, Cattura e Annulla; sta vicino all'area ma sempre dentro la finestra
  const bar = create({
    display: 'none', position: 'fixed', alignItems: 'center', gap: '8px', padding: '6px 8px',
    borderRadius: '8px', background: 'rgba(0, 0, 0, 0.82)', color: '#fff', font: '13px/1.3 system-ui, sans-serif',
    pointerEvents: 'auto', cursor: 'default', zIndex: '1',
  });
  const barSize = create({ display: 'inline', color: '#fff', font: 'inherit', padding: '0 4px' });
  const button = (text, primary) => {
    const b = document.createElement('button');
    b.style.all = 'initial';
    Object.assign(b.style, {
      font: '600 13px/1.3 system-ui, sans-serif', color: '#fff', padding: '5px 12px', borderRadius: '6px',
      cursor: 'pointer', background: primary ? BLUE : 'rgba(255, 255, 255, 0.16)',
    });
    b.type = 'button';
    b.textContent = text;
    return b;
  };
  const captureButton = button(labels.capture || 'OK', true);
  const cancelButton = button(labels.cancel || '✕', false);
  bar.append(barSize, captureButton, cancelButton);
  overlay.append(bar);

  const drawArea = () => {
    const x = area.x - window.scrollX;
    const y = area.y - window.scrollY;
    draw({ x, y, w: area.w, h: area.h });
    barSize.textContent = `${Math.round(area.w)} × ${Math.round(area.h)}`;
    const width = bar.offsetWidth || 220;
    const height = bar.offsetHeight || 36;
    const below = y + area.h + 8;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, y - height - 8);
    bar.style.top = `${clamp(top, 8, window.innerHeight - height - 8)}px`;
    bar.style.left = `${clamp(x + area.w - width, 8, window.innerWidth - width - 8)}px`;
  };

  const adjust = (rect) => {
    area = rect;
    editable = true;
    overlay.style.background = 'transparent';
    overlay.style.cursor = 'crosshair';
    box.style.pointerEvents = 'auto';
    box.style.cursor = 'move';
    box.style.border = `2px solid ${BLUE}`;
    for (const h of handles) h.style.display = 'block';
    bar.style.display = 'flex';
    hint.textContent = labels.adjust || hintText;
    hint.style.display = 'block';
    drawArea();
  };

  // Nuova area secondo il trascinamento in corso, con il puntatore in (x, y) della finestra
  const dragTo = (x, y) => {
    const p = onPage(clamp(x, 0, window.innerWidth), clamp(y, 0, window.innerHeight));
    const a = drag.area;
    if (drag.kind === 'move') {
      area = {
        ...a,
        x: clamp(a.x + p.x - drag.from.x, 0, Math.max(0, pageWidth() - a.w)),
        y: clamp(a.y + p.y - drag.from.y, 0, Math.max(0, pageHeight() - a.h)),
      };
    } else {
      let [left, top, right, bottom] = [a.x, a.y, a.x + a.w, a.y + a.h];
      if (drag.kind.includes('w')) left = p.x;
      if (drag.kind.includes('e')) right = p.x;
      if (drag.kind.includes('n')) top = p.y;
      if (drag.kind.includes('s')) bottom = p.y;
      area = {
        x: Math.max(0, Math.min(left, right)), y: Math.max(0, Math.min(top, bottom)),
        w: Math.max(5, Math.abs(right - left)), h: Math.max(5, Math.abs(bottom - top)),
      };
    }
    drawArea();
  };

  // Trascinando vicino al bordo della finestra la pagina scorre, e l'area la segue
  const autoScroll = () => {
    scrolling = 0;
    if (!drag || !pointer) return;
    const speed = (d) => Math.ceil((EDGE - d) / 3);
    const dy = pointer.y < EDGE ? -speed(pointer.y) : pointer.y > window.innerHeight - EDGE ? speed(window.innerHeight - pointer.y) : 0;
    const dx = pointer.x < EDGE ? -speed(pointer.x) : pointer.x > window.innerWidth - EDGE ? speed(window.innerWidth - pointer.x) : 0;
    if (dx || dy) {
      window.scrollBy(dx, dy);
      dragTo(pointer.x, pointer.y);
    }
    scrolling = requestAnimationFrame(autoScroll);
  };

  // L'area si affida alla cattura dell'elemento: un'àncora invisibile, nella pagina, grande quanto lei
  const confirm = () => {
    const anchor = document.createElement('div');
    anchor.id = 'picantex-area';
    anchor.style.all = 'initial';
    Object.assign(anchor.style, {
      display: 'block', position: 'absolute', left: `${area.x}px`, top: `${area.y}px`,
      width: `${area.w}px`, height: `${area.h}px`, visibility: 'hidden', pointerEvents: 'none',
    });
    document.getElementById('picantex-area')?.remove();
    document.documentElement.appendChild(anchor);
    window.__picantexElement = anchor;
    close();
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'element-picked' });
    }, 50)));
  };

  // Solo i tasti e il mouse dell'utente (isTrusted): gli eventi creati da uno script della pagina non
  // devono poter decidere l'area, né chiudere l'overlay
  const onKey = (e) => {
    if (!e.isTrusted) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && area) {
      e.preventDefault();
      e.stopPropagation();
      confirm();
    }
  };
  const onScroll = () => { if (area) drawArea(); };

  function close() {
    cancelAnimationFrame(scrolling);
    overlay.remove();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
  }

  captureButton.addEventListener('click', (e) => { if (e.isTrusted) confirm(); });
  cancelButton.addEventListener('click', (e) => { if (e.isTrusted) close(); });
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());

  overlay.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || bar.contains(e.target)) return;
    e.preventDefault();
    if (e.button !== 0) return close();
    overlay.setPointerCapture(e.pointerId);
    pointer = { x: e.clientX, y: e.clientY };
    // Su un'area già tracciata: una maniglia la ridimensiona, il suo interno la sposta
    if (area && (e.target.dataset?.edge || e.target === box)) {
      drag = { kind: e.target.dataset?.edge || 'move', from: onPage(e.clientX, e.clientY), area: { ...area } };
      scrolling = requestAnimationFrame(autoScroll);
      return;
    }
    // Altrimenti si traccia un rettangolo nuovo
    editable = editable || e.shiftKey || e.ctrlKey || e.metaKey;
    if (editable) {
      const p = onPage(e.clientX, e.clientY);
      area = { x: p.x, y: p.y, w: 0, h: 0 };
      drag = { kind: 'se', from: p, area: { ...area } };
      for (const h of handles) h.style.display = 'none';
      bar.style.display = 'none';
      scrolling = requestAnimationFrame(autoScroll);
    } else {
      start = { x: e.clientX, y: e.clientY };
    }
    overlay.style.background = 'transparent';
    hint.style.display = 'none';
    if (editable) drawArea();
    else draw(rectTo(e));
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!e.isTrusted) return;
    pointer = { x: e.clientX, y: e.clientY };
    if (drag) dragTo(e.clientX, e.clientY);
    else if (start) draw(rectTo(e));
  });

  overlay.addEventListener('pointerup', (e) => {
    if (!e.isTrusted) return;
    cancelAnimationFrame(scrolling);
    if (drag) {
      drag = null;
      // Un click senza trascinare non lascia un'area: si ricomincia
      if (area.w < 5 || area.h < 5) return close();
      return adjust(area);
    }
    if (!start) return;
    const rect = rectTo(e);
    close();
    // Ignora i click accidentali
    if (rect.w < 5 || rect.h < 5) return;
    // Aspetta che la pagina sia ridisegnata senza overlay prima di chiedere la cattura
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'selection-done', rect, dpr: window.devicePixelRatio, vw: window.innerWidth });
    }, 50)));
  });

  overlay.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
}

// Eseguita dentro la pagina: evidenzia l'elemento sotto il puntatore e, al click, lo affida alla cattura.
// Deve essere autosufficiente; hintText è il suggerimento già tradotto. panels: di un riquadro che
// scorre verrà catturato tutto il contenuto, e l'etichetta lo deve dire.
export function pickElement(hintText, panels) {
  const ID = 'picantex-element-picker';
  if (window.__picantexPicker?.isConnected) return; // il nostro, come in selectArea

  const create = (styles) => {
    const el = document.createElement('div');
    el.style.all = 'initial';
    Object.assign(el.style, styles);
    return el;
  };

  // Strato trasparente che riceve il mouse al posto della pagina
  const layer = create({
    display: 'block', position: 'fixed', inset: '0', zIndex: '2147483647',
    overflow: 'hidden', cursor: 'crosshair', userSelect: 'none',
  });
  layer.id = ID;
  window.__picantexPicker = layer;

  const box = create({
    display: 'none', position: 'absolute', boxSizing: 'border-box',
    border: '2px solid #1a73e8', background: 'rgba(26, 115, 232, 0.12)', pointerEvents: 'none',
  });

  const labelStyle = {
    display: 'block', position: 'absolute', padding: '5px 10px', borderRadius: '5px',
    background: 'rgba(0, 0, 0, 0.75)', color: '#fff', font: '13px/1.3 system-ui, sans-serif',
    whiteSpace: 'nowrap', pointerEvents: 'none',
  };
  const hint = create({ ...labelStyle, top: '16px', left: '50%', transform: 'translateX(-50%)' });
  hint.textContent = hintText;
  const size = create({ ...labelStyle, top: '4px', left: '4px', padding: '2px 6px', fontSize: '11px' });

  box.appendChild(size);
  layer.append(box, hint);
  document.documentElement.appendChild(layer);

  // chain[0] è l'elemento sotto il puntatore; con ↑ (o la rotellina) si sale ai contenitori, con ↓ si torna giù
  let chain = [];
  let depth = 0;
  let pointer = null;

  const show = () => {
    const el = chain[depth];
    const rect = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
    // Di un riquadro che scorre si cattura tutto il contenuto: l'etichetta ne dà l'altezza intera
    const hidden = el.scrollHeight - el.clientHeight;
    const scrolls = panels && el !== document.scrollingElement && hidden > 8
      && /auto|scroll|overlay/.test(getComputedStyle(el).overflowY);
    size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height + (scrolls ? hidden : 0))}${scrolls ? ' ↕' : ''}`;
  };

  // Sale di un livello verso il contenitore (wider) oppure torna verso l'elemento di partenza
  const step = (wider) => {
    if (!chain.length) return;
    if (!wider) {
      depth = Math.max(depth - 1, 0);
    } else if (depth + 1 < chain.length) {
      depth++;
    } else {
      const parent = chain[depth].parentElement;
      if (parent && parent !== document.documentElement) {
        chain.push(parent);
        depth++;
      }
    }
    show();
  };

  // Trova l'elemento sotto il puntatore; refresh serve quando la pagina è scorsa sotto il mouse fermo
  const pick = (refresh) => {
    if (!pointer) return;
    // Lo strato va tolto un istante dal bersaglio, altrimenti "sotto il puntatore" ci sarebbe lui
    layer.style.pointerEvents = 'none';
    const el = document.elementFromPoint(pointer.x, pointer.y);
    layer.style.pointerEvents = 'auto';
    if (!el) return;
    if (el !== chain[0]) {
      chain = [el];
      depth = 0;
    } else if (!refresh) {
      return;
    }
    show();
  };

  // Come in selectArea, solo gli eventi dell'utente (isTrusted)
  const onKey = (e) => {
    if (!e.isTrusted || !['Escape', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else step(e.key === 'ArrowUp');
  };
  const onScroll = () => pick(true);

  function close() {
    layer.remove();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
  }

  layer.addEventListener('pointermove', (e) => {
    if (!e.isTrusted) return;
    pointer = { x: e.clientX, y: e.clientY };
    pick(false);
  });

  // Rotellina in su allarga, in giù restringe. I touchpad mandano tanti piccoli scatti: si accumulano.
  let wheelTotal = 0;
  let wheelTime = 0;
  layer.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!e.isTrusted) return;
    wheelTotal += e.deltaY;
    if (Math.abs(wheelTotal) < 40 || Date.now() - wheelTime < 120) return;
    step(wheelTotal < 0);
    wheelTotal = 0;
    wheelTime = Date.now();
  }, { passive: false });

  layer.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const el = chain[depth];
    close();
    if (!el) return;
    window.__picantexElement = el;
    // Aspetta che la pagina sia ridisegnata senza evidenziazione prima di chiedere la cattura
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'element-picked' });
    }, 50)));
  });

  layer.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (e.isTrusted) close();
  });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
}
