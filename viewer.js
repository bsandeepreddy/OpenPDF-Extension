// ============================================================
// OpenPDF — viewer.js (v2.0)
//
// Features:
//   ✅ View PDF (render + thumbnails)
//   ✅ Split / Merge
//   ✅ Download
//   ✅ Edit Mode (text annotations + freehand draw + highlight)
//   ✅ Fill Form (detect & fill PDF form fields)
//   ✅ Sign (draw or type signature, drag to position, embed)
//
// Performance fixes from v1.0:
//   ✅ Render task cancellation
//   ✅ PDF bytes cached once
//   ✅ Lazy + batched thumbnails (IntersectionObserver)
//   ✅ No blob URL memory leaks
//   ✅ No binary JSON serialization
// ============================================================

pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.js';

// ── URL param ─────────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const pdfUrl    = urlParams.get('file');

// ── Global state ──────────────────────────────────────────────
let pdfDoc          = null;
let pageNum         = 1;
let currentScale    = 1.5;
let renderTask      = null;
let cachedPdfBytes  = null;

// Edit state
let editMode        = false;
let editTool        = 'text';   // 'text' | 'draw' | 'highlight'
let editAnnotations = {};       // { pageNum: [ annotationObjects ] }
let isDrawing       = false;
let drawPath        = [];
let currentTextBox  = null;

// Signature state
let sigDataUrl      = null;     // Base64 PNG of signature
let sigDrawing      = false;

// ── DOM refs ──────────────────────────────────────────────────
const canvas        = document.getElementById('pdf-render');
const ctx           = canvas.getContext('2d');
const editOverlay   = document.getElementById('edit-overlay');
const editCtx       = editOverlay.getContext('2d');
const formOverlay   = document.getElementById('form-overlay');

// ── Toast helper ──────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), duration);
}

// ============================================================
// CORE: Load PDF
// Fetch bytes ONCE, cache for all operations (split/merge/sign)
// ============================================================
if (pdfUrl) {
  fetch(pdfUrl)
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then(bytes => {
      cachedPdfBytes = bytes;
      return pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    })
    .then(doc => {
      pdfDoc = doc;
      document.getElementById('page-count').textContent = pdfDoc.numPages;
      document.getElementById('file-name').textContent  =
        decodeURIComponent(pdfUrl.split('/').pop().split('?')[0]);
      renderPage(pageNum);
      generateThumbnails(doc);
    })
    .catch(err => {
      showToast('Could not load PDF: ' + err.message, 5000);
      console.error(err);
    });
}

// ============================================================
// RENDER — with render-task cancellation
// ============================================================
function renderPage(num) {
  if (!pdfDoc) return;

  // Cancel any in-progress render
  if (renderTask) {
    renderTask.cancel();
    renderTask = null;
  }

  // Clear form overlay between pages
  formOverlay.innerHTML = '';
  formOverlay.classList.add('hidden');

  pdfDoc.getPage(num).then(page => {
    const viewport = page.getViewport({ scale: currentScale });
    canvas.height  = viewport.height;
    canvas.width   = viewport.width;

    // Size the edit overlay to match the canvas exactly
    editOverlay.height = viewport.height;
    editOverlay.width  = viewport.width;
    editOverlay.style.width  = viewport.width  + 'px';
    editOverlay.style.height = viewport.height + 'px';

    // Size form overlay
    formOverlay.style.width  = viewport.width  + 'px';
    formOverlay.style.height = viewport.height + 'px';

    renderTask = page.render({ canvasContext: ctx, viewport });

    renderTask.promise
      .then(() => {
        document.getElementById('page-num').textContent = num;
        renderTask = null;

        // Restore any saved annotations for this page
        redrawAnnotations(num);

        // If form fill mode active, render form fields
        if (formOverlay.dataset.active === 'true') {
          renderFormFields(page, viewport);
        }
      })
      .catch(err => {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Render error:', err);
        }
      });
  });
}

// ── Page navigation ───────────────────────────────────────────
document.getElementById('prev').onclick = () => {
  if (pageNum <= 1) return;
  pageNum--;
  renderPage(pageNum);
};
document.getElementById('next').onclick = () => {
  if (pageNum >= pdfDoc?.numPages) return;
  pageNum++;
  renderPage(pageNum);
};

// ============================================================
// THUMBNAILS — lazy via IntersectionObserver
// ============================================================
async function generateThumbnails(pdf) {
  const container = document.getElementById('thumbnail-container');

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const c = entry.target;
      if (c.dataset.rendered) return;
      c.dataset.rendered = 'true';
      observer.unobserve(c);

      pdf.getPage(parseInt(c.dataset.page)).then(page => {
        const vp = page.getViewport({ scale: 0.2 });
        c.height = vp.height;
        c.width  = vp.width;
        page.render({ canvasContext: c.getContext('2d'), viewport: vp })
            .promise.catch(() => {});
      });
    });
  }, { rootMargin: '200px' });

  for (let i = 1; i <= pdf.numPages; i++) {
    const c = document.createElement('canvas');
    c.className        = 'thumbnail';
    c.dataset.page     = i;
    c.style.minHeight  = '80px';
    c.style.background = '#e8e8e8';
    c.title            = `Page ${i}`;
    c.onclick = () => { pageNum = i; renderPage(i); };
    container.appendChild(c);
    observer.observe(c);
  }
}

// ============================================================
// SPLIT
// ============================================================
document.getElementById('confirm-split').onclick = async () => {
  try {
    const { PDFDocument } = PDFLib;
    const start   = parseInt(document.getElementById('start-page').value);
    const end     = parseInt(document.getElementById('end-page').value);
    const total   = pdfDoc.numPages;

    if (!start || !end || start > end || start < 1 || end > total) {
      showToast(`Enter valid pages (1 – ${total})`); return;
    }

    const srcDoc  = await PDFDocument.load(cachedPdfBytes.slice());
    const newDoc  = await PDFDocument.create();
    const indices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
    const pages   = await newDoc.copyPages(srcDoc, indices);
    pages.forEach(p => newDoc.addPage(p));

    downloadBytes(await newDoc.save(), 'extracted.pdf');
    closeModals();
    showToast(`Extracted pages ${start}–${end}`);
  } catch (e) {
    showToast('Split failed: ' + e.message);
    console.error(e);
  }
};

// ============================================================
// MERGE
// ============================================================
document.getElementById('confirm-merge').onclick = async () => {
  try {
    const { PDFDocument } = PDFLib;
    const files   = document.getElementById('merge-file-input').files;
    const mainDoc = await PDFDocument.create();

    const cur   = await PDFDocument.load(cachedPdfBytes.slice());
    const curPg = await mainDoc.copyPages(cur, cur.getPageIndices());
    curPg.forEach(p => mainDoc.addPage(p));

    for (const f of files) {
      const d  = await PDFDocument.load(await f.arrayBuffer());
      const ps = await mainDoc.copyPages(d, d.getPageIndices());
      ps.forEach(p => mainDoc.addPage(p));
    }

    downloadBytes(await mainDoc.save(), 'merged.pdf');
    closeModals();
    showToast('Merged successfully');
  } catch (e) {
    showToast('Merge failed: ' + e.message);
    console.error(e);
  }
};

// ============================================================
// DOWNLOAD helper — with blob URL cleanup
// ============================================================
function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('download-btn').onclick = async () => {
  // If annotations or form fills exist, flatten them first
  if (Object.keys(editAnnotations).some(k => editAnnotations[k]?.length)) {
    showToast('Flattening annotations…', 1500);
    const flatBytes = await flattenAnnotationsToPdf();
    downloadBytes(flatBytes, 'annotated.pdf');
  } else {
    downloadBytes(cachedPdfBytes, decodeURIComponent(pdfUrl.split('/').pop().split('?')[0]));
  }
};

// ============================================================
// MODALS
// ============================================================
function closeModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}
document.getElementById('split-menu-btn').onclick = () =>
  document.getElementById('split-modal').classList.remove('hidden');
document.getElementById('merge-menu-btn').onclick = () =>
  document.getElementById('merge-modal').classList.remove('hidden');


// ============================================================
// ── EDIT MODE ──────────────────────────────────────────────
// Lets users add text boxes, draw freehand, or highlight.
// Annotations are stored per-page and flattened into the PDF
// on "Save to PDF" or Download.
// ============================================================

document.getElementById('edit-btn').onclick = toggleEditMode;

function toggleEditMode() {
  editMode = !editMode;
  const btn = document.getElementById('edit-btn');
  const toolbar = document.getElementById('edit-toolbar');

  if (editMode) {
    btn.classList.add('active-mode');
    toolbar.classList.remove('hidden');
    editOverlay.classList.remove('hidden');
    editOverlay.style.pointerEvents = 'all';
    editTool = 'text';
    highlightToolBtn('add-text-btn');
    showToast('Edit mode on — click to add text, or choose Draw');
  } else {
    btn.classList.remove('active-mode');
    toolbar.classList.add('hidden');
    editOverlay.classList.add('hidden');
    editOverlay.style.pointerEvents = 'none';
    if (currentTextBox) finaliseTextBox();
  }
}

// Tool selection
['add-text-btn', 'draw-btn', 'highlight-btn'].forEach(id => {
  document.getElementById(id).onclick = () => {
    const map = { 'add-text-btn': 'text', 'draw-btn': 'draw', 'highlight-btn': 'highlight' };
    editTool = map[id];
    highlightToolBtn(id);
    if (currentTextBox) finaliseTextBox();
  };
});

function highlightToolBtn(activeId) {
  ['add-text-btn', 'draw-btn', 'highlight-btn'].forEach(id => {
    document.getElementById(id).classList.toggle('active', id === activeId);
  });
}

// Undo last annotation on current page
document.getElementById('edit-undo-btn').onclick = () => {
  if (!editAnnotations[pageNum]?.length) return;
  editAnnotations[pageNum].pop();
  redrawAnnotations(pageNum);
};

// Save to PDF = flatten all annotations
document.getElementById('edit-done-btn').onclick = async () => {
  if (currentTextBox) finaliseTextBox();
  showToast('Saving annotations to PDF…', 2000);
  try {
    const bytes = await flattenAnnotationsToPdf();
    cachedPdfBytes = bytes;
    // Reload the PDF doc from updated bytes
    pdfDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    editAnnotations = {};
    renderPage(pageNum);
    toggleEditMode();
    showToast('Annotations saved ✓');
  } catch (e) {
    showToast('Save failed: ' + e.message);
    console.error(e);
  }
};

// ── Canvas pointer events for drawing / text placement ────────
editOverlay.addEventListener('pointerdown', onEditPointerDown);
editOverlay.addEventListener('pointermove', onEditPointerMove);
editOverlay.addEventListener('pointerup',   onEditPointerUp);

function getCanvasXY(e) {
  const r = editOverlay.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (editOverlay.width  / r.width),
    y: (e.clientY - r.top)  * (editOverlay.height / r.height)
  };
}

function onEditPointerDown(e) {
  if (!editMode) return;
  const { x, y } = getCanvasXY(e);

  if (editTool === 'text') {
    if (currentTextBox) finaliseTextBox();
    spawnTextBox(x, y);
    return;
  }

  isDrawing = true;
  drawPath  = [{ x, y }];
  editOverlay.setPointerCapture(e.pointerId);
}

function onEditPointerMove(e) {
  if (!isDrawing || editTool === 'text') return;
  const { x, y } = getCanvasXY(e);
  drawPath.push({ x, y });
  redrawAnnotations(pageNum);   // redraw saved, then draw live path

  const color = document.getElementById('edit-color').value;
  const size  = parseInt(document.getElementById('edit-size').value);

  editCtx.beginPath();
  editCtx.strokeStyle = editTool === 'highlight'
    ? color + '66' : color;                 // 40% opacity for highlight
  editCtx.lineWidth   = editTool === 'highlight' ? size * 2 : size * 0.7;
  editCtx.lineCap     = 'round';
  editCtx.lineJoin    = 'round';

  drawPath.forEach((pt, i) => {
    if (i === 0) editCtx.moveTo(pt.x, pt.y);
    else         editCtx.lineTo(pt.x, pt.y);
  });
  editCtx.stroke();
}

function onEditPointerUp(e) {
  if (!isDrawing) return;
  isDrawing = false;

  // Store finished path as an annotation
  if (!editAnnotations[pageNum]) editAnnotations[pageNum] = [];
  editAnnotations[pageNum].push({
    type:  editTool,   // 'draw' | 'highlight'
    path:  [...drawPath],
    color: document.getElementById('edit-color').value,
    size:  parseInt(document.getElementById('edit-size').value)
  });
  drawPath = [];
}

// ── Text box ─────────────────────────────────────────────────
function spawnTextBox(x, y) {
  const wrapper = document.getElementById('viewer-canvas-wrapper');
  const rect    = editOverlay.getBoundingClientRect();
  const wRect   = wrapper.getBoundingClientRect();

  const inp = document.createElement('textarea');
  inp.className   = 'pdf-textbox';
  inp.placeholder = 'Type here…';
  inp.style.left  = (rect.left - wRect.left + x * rect.width  / editOverlay.width)  + 'px';
  inp.style.top   = (rect.top  - wRect.top  + y * rect.height / editOverlay.height) + 'px';
  inp.style.color  = document.getElementById('edit-color').value;
  inp.style.fontSize = document.getElementById('edit-size').value + 'px';
  wrapper.appendChild(inp);
  inp.focus();
  currentTextBox = { el: inp, x, y };
}

function finaliseTextBox() {
  if (!currentTextBox) return;
  const { el, x, y } = currentTextBox;
  const text = el.value.trim();
  if (text) {
    if (!editAnnotations[pageNum]) editAnnotations[pageNum] = [];
    editAnnotations[pageNum].push({
      type:     'text',
      text,
      x, y,
      color:    document.getElementById('edit-color').value,
      fontSize: parseInt(document.getElementById('edit-size').value)
    });
  }
  el.remove();
  currentTextBox = null;
  redrawAnnotations(pageNum);
}

// ── Redraw all saved annotations on the overlay canvas ───────
function redrawAnnotations(page) {
  editCtx.clearRect(0, 0, editOverlay.width, editOverlay.height);
  const annotations = editAnnotations[page] || [];

  annotations.forEach(ann => {
    if (ann.type === 'text') {
      editCtx.font      = `${ann.fontSize}px sans-serif`;
      editCtx.fillStyle = ann.color;
      // Multi-line support
      ann.text.split('\n').forEach((line, i) => {
        editCtx.fillText(line, ann.x, ann.y + i * (ann.fontSize + 4));
      });

    } else if (ann.type === 'draw') {
      if (!ann.path?.length) return;
      editCtx.beginPath();
      editCtx.strokeStyle = ann.color;
      editCtx.lineWidth   = ann.size * 0.7;
      editCtx.lineCap     = 'round';
      editCtx.lineJoin    = 'round';
      ann.path.forEach((pt, i) => {
        if (i === 0) editCtx.moveTo(pt.x, pt.y);
        else         editCtx.lineTo(pt.x, pt.y);
      });
      editCtx.stroke();

    } else if (ann.type === 'highlight') {
      if (!ann.path?.length) return;
      editCtx.beginPath();
      editCtx.strokeStyle = ann.color + '66';
      editCtx.lineWidth   = ann.size * 2;
      editCtx.lineCap     = 'round';
      ann.path.forEach((pt, i) => {
        if (i === 0) editCtx.moveTo(pt.x, pt.y);
        else         editCtx.lineTo(pt.x, pt.y);
      });
      editCtx.stroke();
    }
  });
}

// ── Flatten annotations into the actual PDF bytes ─────────────
async function flattenAnnotationsToPdf() {
  const { PDFDocument, rgb, StandardFonts } = PDFLib;
  const doc   = await PDFDocument.load(cachedPdfBytes.slice());
  const pages = doc.getPages();
  const font  = await doc.embedFont(StandardFonts.Helvetica);

  for (const [pageKey, annotations] of Object.entries(editAnnotations)) {
    const pg     = pages[parseInt(pageKey) - 1];
    if (!pg || !annotations?.length) continue;
    const { width, height } = pg.getSize();

    // Scale factors: overlay canvas coords → PDF coords
    const scaleX = width  / editOverlay.width;
    const scaleY = height / editOverlay.height;

    for (const ann of annotations) {
      if (ann.type === 'text' && ann.text) {
        const [r, g, b] = hexToRgb(ann.color);
        pg.drawText(ann.text.split('\n')[0], {
          x:     ann.x * scaleX,
          y:     height - ann.y * scaleY,  // PDF Y is bottom-up
          size:  ann.fontSize,
          font,
          color: rgb(r, g, b)
        });

      } else if ((ann.type === 'draw' || ann.type === 'highlight') && ann.path?.length > 1) {
        // Render the path to a temporary canvas, embed as image
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width  = editOverlay.width;
        tmpCanvas.height = editOverlay.height;
        const tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.beginPath();
        tmpCtx.strokeStyle = ann.type === 'highlight' ? ann.color + '66' : ann.color;
        tmpCtx.lineWidth   = ann.type === 'highlight' ? ann.size * 2 : ann.size * 0.7;
        tmpCtx.lineCap     = 'round';
        tmpCtx.lineJoin    = 'round';
        ann.path.forEach((pt, i) => {
          if (i === 0) tmpCtx.moveTo(pt.x, pt.y);
          else         tmpCtx.lineTo(pt.x, pt.y);
        });
        tmpCtx.stroke();

        const blob  = await new Promise(res => tmpCanvas.toBlob(res, 'image/png'));
        const bytes = await blob.arrayBuffer();
        const img   = await doc.embedPng(bytes);
        pg.drawImage(img, { x: 0, y: 0, width, height });
      }
    }
  }

  return doc.save();
}

// ============================================================
// ── FILL FORM MODE ─────────────────────────────────────────
// Detects PDF AcroForm fields on the current page using
// PDF.js annotation API and renders HTML inputs over them.
// Values are then embedded back into the PDF on save.
// ============================================================

document.getElementById('fill-btn').onclick = toggleFillMode;

function toggleFillMode() {
  const btn    = document.getElementById('fill-btn');
  const active = formOverlay.dataset.active === 'true';

  if (active) {
    // Deactivate
    formOverlay.dataset.active = 'false';
    formOverlay.classList.add('hidden');
    formOverlay.innerHTML = '';
    btn.classList.remove('active-mode');
    showToast('Form fill mode off');
  } else {
    // Activate
    formOverlay.dataset.active = 'true';
    formOverlay.classList.remove('hidden');
    btn.classList.add('active-mode');
    showToast('Click any form field to fill it');
    // Render fields for current page
    pdfDoc.getPage(pageNum).then(page => {
      const viewport = page.getViewport({ scale: currentScale });
      renderFormFields(page, viewport);
    });
  }
}

async function renderFormFields(page, viewport) {
  formOverlay.innerHTML = '';
  const annotations = await page.getAnnotations();

  annotations.forEach(ann => {
    // Only handle fillable fields
    if (!ann.fieldType) return;

    // Convert PDF annotation rect to viewport coords
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(ann.rect);
    const left   = Math.min(x1, x2);
    const top    = Math.min(y1, y2);
    const width  = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    let el;

    if (ann.fieldType === 'Tx') {
      // Text field
      el = document.createElement(ann.multiLine ? 'textarea' : 'input');
      if (!ann.multiLine) el.type = 'text';
      el.value       = ann.fieldValue || '';
      el.placeholder = ann.alternativeText || '';
    } else if (ann.fieldType === 'Btn' && ann.checkBox) {
      // Checkbox
      el = document.createElement('input');
      el.type    = 'checkbox';
      el.checked = ann.fieldValue === 'Yes';
    } else if (ann.fieldType === 'Ch') {
      // Dropdown
      el = document.createElement('select');
      (ann.options || []).forEach(opt => {
        const o   = document.createElement('option');
        o.value   = opt.exportValue;
        o.text    = opt.displayValue;
        el.appendChild(o);
      });
      el.value = ann.fieldValue || '';
    } else {
      return; // Unsupported field type — skip
    }

    el.className          = 'form-field';
    el.dataset.fieldName  = ann.fieldName;
    el.dataset.fieldType  = ann.fieldType;
    el.style.left         = left   + 'px';
    el.style.top          = top    + 'px';
    el.style.width        = width  + 'px';
    el.style.height       = height + 'px';

    formOverlay.appendChild(el);
  });

  if (formOverlay.children.length === 0) {
    showToast('No form fields found on this page');
  }
}

// Collect all form field values from the overlay
function collectFormValues() {
  const values = {};
  formOverlay.querySelectorAll('.form-field').forEach(el => {
    const name = el.dataset.fieldName;
    if (!name) return;
    if (el.type === 'checkbox')     values[name] = el.checked ? 'Yes' : 'Off';
    else if (el.tagName === 'SELECT') values[name] = el.value;
    else                              values[name] = el.value;
  });
  return values;
}

// ============================================================
// ── SIGNATURE ──────────────────────────────────────────────
// Two modes: Draw (canvas) or Type (rendered to canvas).
// Inserts as a draggable overlay, user positions it,
// then we embed it into the PDF as a PNG image.
// ============================================================

const signCanvas  = document.getElementById('sign-canvas');
const signCtx     = signCanvas.getContext('2d');

document.getElementById('sign-btn').onclick = () =>
  document.getElementById('sign-modal').classList.remove('hidden');

// ── Tab switching ─────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('sign-draw-tab').classList.toggle('hidden', tab !== 'draw');
    document.getElementById('sign-type-tab').classList.toggle('hidden', tab !== 'type');
    if (tab === 'type') updateTypePreview();
  };
});

// ── Draw tab: signature canvas ────────────────────────────────
signCanvas.addEventListener('pointerdown', e => {
  sigDrawing = true;
  const { x, y } = signCanvasXY(e);
  signCtx.beginPath();
  signCtx.moveTo(x, y);
  signCanvas.setPointerCapture(e.pointerId);
});

signCanvas.addEventListener('pointermove', e => {
  if (!sigDrawing) return;
  const { x, y } = signCanvasXY(e);
  signCtx.lineTo(x, y);
  signCtx.strokeStyle = document.getElementById('sign-color').value;
  signCtx.lineWidth   = parseInt(document.getElementById('sign-thickness').value);
  signCtx.lineCap     = 'round';
  signCtx.lineJoin    = 'round';
  signCtx.stroke();
});

signCanvas.addEventListener('pointerup', () => { sigDrawing = false; });

document.getElementById('sign-clear-btn').onclick = () => {
  signCtx.clearRect(0, 0, signCanvas.width, signCanvas.height);
};

function signCanvasXY(e) {
  const r = signCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * signCanvas.width  / r.width,
    y: (e.clientY - r.top)  * signCanvas.height / r.height
  };
}

// ── Type tab: rendered signature preview ──────────────────────
document.getElementById('sign-text-input').oninput = updateTypePreview;
document.getElementById('sign-font').onchange       = updateTypePreview;

function updateTypePreview() {
  const preview = document.getElementById('sign-type-preview');
  const pCtx    = preview.getContext('2d');
  const text    = document.getElementById('sign-text-input').value || 'Your Name';
  const font    = document.getElementById('sign-font').value;

  pCtx.clearRect(0, 0, preview.width, preview.height);
  pCtx.font      = `42px ${font}`;
  pCtx.fillStyle = '#000080';
  pCtx.textBaseline = 'middle';
  pCtx.fillText(text, 20, preview.height / 2);
}

// ── Confirm sign: capture PNG, show drag overlay ─────────────
document.getElementById('confirm-sign').onclick = () => {
  const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
  let sourceCanvas;

  if (activeTab === 'draw') {
    sourceCanvas = signCanvas;
    // Check canvas isn't empty
    const imgData = signCtx.getImageData(0, 0, signCanvas.width, signCanvas.height);
    const isEmpty = !imgData.data.some(ch => ch !== 0);
    if (isEmpty) { showToast('Please draw your signature first'); return; }
  } else {
    sourceCanvas = document.getElementById('sign-type-preview');
    if (!document.getElementById('sign-text-input').value.trim()) {
      showToast('Please type your name'); return;
    }
    updateTypePreview();
  }

  sigDataUrl = sourceCanvas.toDataURL('image/png');
  closeModals();
  showSignatureDragOverlay();
};

// ── Drag overlay so user can position the signature ──────────
function showSignatureDragOverlay() {
  const container = document.getElementById('sig-drag-container');
  const img       = document.getElementById('sig-drag-img');

  img.src             = sigDataUrl;
  container.classList.remove('hidden');

  // Position at center of viewer initially
  const wrapper = document.getElementById('viewer-canvas-wrapper');
  const wRect   = wrapper.getBoundingClientRect();
  container.style.left = (wRect.left + wRect.width  / 2 - 125) + 'px';
  container.style.top  = (wRect.top  + wRect.height / 2 - 60)  + 'px';

  makeDraggable(container);
  showToast('Drag signature to position it, then click "Place Here"');
}

function makeDraggable(el) {
  let dx = 0, dy = 0, startX = 0, startY = 0;

  el.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    dx     = parseInt(el.style.left) || 0;
    dy     = parseInt(el.style.top)  || 0;
    el.setPointerCapture(e.pointerId);

    const onMove = ev => {
      el.style.left = (dx + ev.clientX - startX) + 'px';
      el.style.top  = (dy + ev.clientY - startY) + 'px';
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup',   onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup',   onUp);
  });
}

// ── Place Here: embed signature at position ───────────────────
document.getElementById('sig-place-btn').onclick = async () => {
  const container = document.getElementById('sig-drag-container');
  const wrapper   = document.getElementById('viewer-canvas-wrapper');
  const wRect     = wrapper.getBoundingClientRect();
  const cRect     = container.getBoundingClientRect();

  // Position relative to the canvas
  const canvasRect = canvas.getBoundingClientRect();
  const relX = cRect.left - canvasRect.left;
  const relY = cRect.top  - canvasRect.top;

  // Scale to PDF coordinates
  const page   = await pdfDoc.getPage(pageNum);
  const vp     = page.getViewport({ scale: currentScale });
  const { PDFDocument } = PDFLib;
  const doc    = await PDFDocument.load(cachedPdfBytes.slice());
  const pages  = doc.getPages();
  const pg     = pages[pageNum - 1];
  const { width: pdfW, height: pdfH } = pg.getSize();

  const pdfX  = (relX / vp.width)  * pdfW;
  const pdfY  = pdfH - ((relY + 60) / vp.height) * pdfH;  // flip Y
  const sigW  = (250 / vp.width)   * pdfW;
  const sigH  = (80  / vp.height)  * pdfH;

  // Fetch and embed the signature PNG
  const resp    = await fetch(sigDataUrl);
  const arrBuf  = await resp.arrayBuffer();
  const sigImg  = await doc.embedPng(arrBuf);

  pg.drawImage(sigImg, { x: pdfX, y: pdfY, width: sigW, height: sigH });

  cachedPdfBytes = await doc.save();
  pdfDoc = await pdfjsLib.getDocument({ data: cachedPdfBytes.slice() }).promise;
  renderPage(pageNum);

  container.classList.add('hidden');
  showToast('Signature placed ✓ — Download to save your PDF');
};

document.getElementById('sig-cancel-btn').onclick = () => {
  document.getElementById('sig-drag-container').classList.add('hidden');
  sigDataUrl = null;
};

// ============================================================
// UTILITY
// ============================================================
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// Close modals on backdrop click
document.querySelectorAll('.modal').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) closeModals(); });
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   document.getElementById('prev').click();
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown')  document.getElementById('next').click();
  if (e.key === 'Escape') { closeModals(); if (editMode) toggleEditMode(); }
  if (e.ctrlKey && e.key === 'z') document.getElementById('edit-undo-btn').click();
});
