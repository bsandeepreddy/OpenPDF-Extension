pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.js';
const urlParams = new URLSearchParams(window.location.search);
const pdfUrl = urlParams.get('file');
let pdfDoc = null, pageNum = 1, canvas = document.getElementById('pdf-render'), ctx = canvas.getContext('2d');

const renderPage = num => {
    pdfDoc.getPage(num).then(page => {
        const viewport = page.getViewport({ scale: 1.5 });
        canvas.height = viewport.height; canvas.width = viewport.width;
        page.render({ canvasContext: ctx, viewport: viewport });
        document.getElementById('page-num').textContent = num;
    });
};

if (pdfUrl) {
    pdfjsLib.getDocument(pdfUrl).promise.then(doc => {
        pdfDoc = doc;
        document.getElementById('page-count').textContent = pdfDoc.numPages;
        document.getElementById('file-name').textContent = pdfUrl.split('/').pop();
        renderPage(pageNum);
        generateThumbnails(doc);
    });
}

document.getElementById('prev').onclick = () => { if (pageNum <= 1) return; pageNum--; renderPage(pageNum); };
document.getElementById('next').onclick = () => { if (pageNum >= pdfDoc.numPages) return; pageNum++; renderPage(pageNum); };

const closeModals = () => document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
document.getElementById('split-menu-btn').onclick = () => document.getElementById('split-modal').classList.remove('hidden');
document.getElementById('merge-menu-btn').onclick = () => document.getElementById('merge-modal').classList.remove('hidden');

document.getElementById('confirm-split').onclick = async () => {
    const { PDFDocument } = PDFLib;
    const start = parseInt(document.getElementById('start-page').value);
    const end = parseInt(document.getElementById('end-page').value);
    const bytes = await fetch(pdfUrl).then(res => res.arrayBuffer());
    const srcDoc = await PDFDocument.load(bytes);
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(srcDoc, Array.from({length: end-start+1}, (_,i) => start-1+i));
    pages.forEach(p => newDoc.addPage(p));
    download(await newDoc.save(), 'split.pdf');
    closeModals();
};

document.getElementById('confirm-merge').onclick = async () => {
    const { PDFDocument } = PDFLib;
    const files = document.getElementById('merge-file-input').files;
    const mainDoc = await PDFDocument.create();
    const currentBytes = await fetch(pdfUrl).then(res => res.arrayBuffer());
    const currentDoc = await PDFDocument.load(currentBytes);
    const currentPages = await mainDoc.copyPages(currentDoc, currentDoc.getPageIndices());
    currentPages.forEach(p => mainDoc.addPage(p));
    for (let f of files) {
        const d = await PDFDocument.load(await f.arrayBuffer());
        const p = await mainDoc.copyPages(d, d.getPageIndices());
        p.forEach(page => mainDoc.addPage(page));
    }
    download(await mainDoc.save(), 'merged.pdf');
    closeModals();
};

const download = (bytes, name) => {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
};

async function generateThumbnails(pdf) {
    const container = document.getElementById('thumbnail-container');
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 0.2 });
        const c = document.createElement('canvas');
        c.className = 'thumbnail';
        c.height = vp.height; c.width = vp.width;
        c.onclick = () => { pageNum = i; renderPage(i); };
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        container.appendChild(c);
    }
}