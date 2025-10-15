/* Inventaire ONU — app.js (PHOTO UNIQUEMENT, sans cadre-guide)
 * - Icône "Scanner (photo)" -> ouvre l'appareil photo (input file caché)
 * - Décodage automatique dès que la photo est validée
 * - Décodage robuste : ZXing (multi-format) puis jsQR (fallback QR)
 * - Orientation EXIF + essais multi tailles/rotations
 * - POST x-www-form-urlencoded (no preflight CORS)
 * - Reset après succès + relance auto capture
 * - Compteur “Scans aujourd’hui” + Export CSV (dates)
 */

const API_BASE = "https://script.google.com/macros/s/AKfycbwtFL1iaSSdkB7WjExdXYGbQQbhPeIi_7F61pQdUEJK8kSFznjEOU68Fh6U538PGZW2/exec";
const APP_VERSION = "1.0.8";
const AUTO_RECAPTURE = true;

let canvasEl, ctx, statusEl, flashEl, previewEl;
let fileBlob = null;
let todayISO = new Date().toISOString().slice(0,10);
let todayCount = 0;

// PWA install (optionnel)
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  const btn = document.getElementById('btn-install');
  if (btn) {
    btn.hidden = false;
    btn.onclick = async () => { btn.hidden = true; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; };
  }
});

document.addEventListener('DOMContentLoaded', () => {
  canvasEl = document.getElementById('canvas');
  ctx = canvasEl.getContext('2d', { willReadFrequently: true });
  statusEl = document.getElementById('status');
  flashEl = document.getElementById('flash');
  previewEl = document.getElementById('preview');

  // Lanceur caméra
  const btnCapture = document.getElementById('btn-capture');
  const photoInput = document.getElementById('photoInput');
  if (btnCapture && photoInput) {
    btnCapture.addEventListener('click', () => { photoInput.click(); });
    photoInput.addEventListener('change', onPhotoPicked);
  }

  // Formulaire
  const typeSel = document.getElementById('type');
  const typeOtherWrap = document.getElementById('field-type-autre');
  if (typeSel && typeOtherWrap) {
    typeSel.addEventListener('change', () => { typeOtherWrap.hidden = typeSel.value !== 'Autre'; });
  }
  const dateInput = document.getElementById('date_mvt');
  if (dateInput) dateInput.value = todayISO;
  const form = document.getElementById('form');
  if (form) form.addEventListener('submit', onSubmit);
  const btnTest = document.getElementById('btn-test');
  if (btnTest) btnTest.addEventListener('click', onTest);

  // Export
  const exportFrom = document.getElementById('export_from');
  const exportTo = document.getElementById('export_to');
  const btnExport = document.getElementById('btn-export');
  if (exportFrom) exportFrom.value = todayISO;
  if (exportTo) exportTo.value = todayISO;
  if (btnExport) btnExport.addEventListener('click', onExport);

  // Service Worker
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');

  // Charger le compteur du jour
  refreshTodayCount();
});

/* ---------- UI helpers ---------- */
function setStatus(msg){ if (statusEl) statusEl.textContent = msg; }
function setApiMsg(msg, isError=false) {
  const el = document.getElementById('api-msg');
  if (!el) return; el.textContent = msg; el.style.color = isError ? 'var(--err)' : 'var(--ok)';
}
function vibrate(){ if (navigator.vibrate) navigator.vibrate(200); }
function flash(){ if (!flashEl) return; flashEl.classList.remove('active'); void flashEl.offsetWidth; flashEl.classList.add('active'); }
function beep(){
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type='sine'; o.frequency.setValueAtTime(1000, ctx.currentTime);
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    o.connect(g).connect(ctx.destination); o.start();
    g.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    o.stop(ctx.currentTime + 0.2);
  } catch(_) {}
}
function onCodeDetected(text){
  flash(); beep(); vibrate();
  setStatus(`Code détecté: ${text}`);
  const codeInput = document.getElementById('code');
  if (codeInput) { codeInput.value = text; codeInput.focus(); }
}

/* ---------- Compteur “Scans aujourd’hui” ---------- */
async function refreshTodayCount() {
  try {
    const res = await fetch(`${API_BASE}?route=/stats&day=${todayISO}`, { method:'GET', mode:'cors', credentials:'omit' });
    const data = await res.json().catch(()=> ({}));
    if (data && data.status === 200 && data.data && typeof data.data.count === 'number') {
      todayCount = data.data.count;
    }
  } catch(_) {}
  const el = document.getElementById('count-today');
  if (el) el.textContent = String(todayCount);
}

/* ---------- Export CSV ---------- */
function onExport() {
  const from = document.getElementById('export_from')?.value;
  const to = document.getElementById('export_to')?.value;
  if (!from || !to) { setStatus('Choisissez une période complète (du… au…).'); return; }
  if (from > to) { setStatus('La date de début doit être antérieure à la date de fin.'); return; }
  const url = `${API_BASE}?route=/export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  window.location.href = url;
}

/* ---------- Sélection photo -> décodage auto ---------- */
function onPhotoPicked(ev){
  const file = ev.target.files && ev.target.files[0];
  if (!file) {
    fileBlob = null; if (previewEl) previewEl.style.display = 'none';
    setStatus('Aucune photo choisie.'); return;
  }
  fileBlob = file;
  const url = URL.createObjectURL(file);
  if (previewEl) { previewEl.src = url; previewEl.style.display = 'block'; }

  const btnCapture = document.getElementById('btn-capture');
  if (btnCapture) btnCapture.classList.remove('pulse');

  setStatus('Décodage en cours…');
  setTimeout(decodePhoto, 0);
}

/* ---------- Décodage (ZXing + jsQR + EXIF) ---------- */
async function decodePhoto(){
  if (!fileBlob) return;
  const {bitmap, width, height} = await loadImageWithOrientation(fileBlob);
  const scales = [1.0, 0.75, 0.5];
  const rotations = [0, 90, 180, 270];

  for (const scale of scales) {
    for (const rot of rotations) {
      const targetW = Math.round(width * scale);
      const targetH = Math.round(height * scale);
      const {w, h} = sizeAfterRotation(targetW, targetH, rot);
      canvasEl.width = w; canvasEl.height = h;

      const ctx2 = canvasEl.getContext('2d', { willReadFrequently: true });
      ctx2.save();
      ctx2.translate(w/2, h/2);
      ctx2.rotate(rot * Math.PI/180);
      ctx2.filter = 'contrast(1.15) brightness(1.05)';
      ctx2.drawImage(bitmap, -targetW/2, -targetH/2, targetW, targetH);
      ctx2.restore();

      try {
        const luminanceSource = new ZXing.HTMLCanvasElementLuminanceSource(canvasEl);
        const bitmapZX = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminanceSource));
        const reader = new ZXing.MultiFormatReader();
        const res = reader.decode(bitmapZX);
        if (res && res.getText) { showPreviewFromCanvas(); onCodeDetected(res.getText()); return; }
      } catch (_) {}

      try {
        const imgData = ctx2.getImageData(0,0,canvasEl.width,canvasEl.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height);
        if (code && code.data) { showPreviewFromCanvas(); onCodeDetected(code.data); return; }
      } catch (_) {}
    }
  }

  showPreviewFromCanvas();
  setStatus('Aucun code détecté. Reprenez la photo (plus net, plus proche, meilleure lumière).');
}

/* ---------- Envoi backend ---------- */
async function onSubmit(ev) {
  ev.preventDefault();
  const code = (document.getElementById('code')?.value || '').trim();
  const from = (document.getElementById('from')?.value || '').trim();
  const to = (document.getElementById('to')?.value || '').trim();
  const type = document.getElementById('type')?.value;
  const typeAutre = (document.getElementById('type_autre')?.value || '').trim();
  const date_mvt = document.getElementById('date_mvt')?.value;

  if (!code || !from || !to || !type) return setApiMsg('Veuillez remplir tous les champs.', true);

  const form = new URLSearchParams();
  form.set('action', 'create');
  form.set('code_scanné', code);
  form.set('emplacement_depart', from);
  form.set('emplacement_destination', to);
  form.set('type_mobilier', type);
  form.set('type_mobilier_autre', (type === 'Autre') ? typeAutre : '');
  form.set('date_mouvement', date_mvt);
  form.set('source_app_version', APP_VERSION);

  try {
    const res = await fetch(`${API_BASE}?route=/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString(),
      mode: 'cors',
      credentials: 'omit'
    });
    const data = await res.json().catch(()=> ({}));
    if (data && data.status >= 200 && data.status < 300) {
      setApiMsg('Écrit dans Google Sheets ✅', false);
      if (document.getElementById('date_mvt')?.value === todayISO) {
        todayCount += 1; const el = document.getElementById('count-today'); if (el) el.textContent = String(todayCount);
      } else {
        refreshTodayCount();
      }
      resetFormUI();
    } else {
      setApiMsg(`Erreur API: ${data && data.message ? data.message : 'Inconnue'}`, true);
    }
  } catch (err) {
    console.error(err);
    setApiMsg('Erreur réseau/API. Vérifiez la Web App.', true);
  }
}

/* ---------- Reset + relance auto capture ---------- */
function resetFormUI() {
  const form = document.getElementById('form'); if (form) form.reset();
  const typeOtherWrap = document.getElementById('field-type-autre'); if (typeOtherWrap) typeOtherWrap.hidden = true;
  const dateInput = document.getElementById('date_mvt'); if (dateInput) dateInput.value = todayISO;
  const preview = document.getElementById('preview'); if (preview) { preview.src = ''; preview.style.display = 'none'; }
  const photoInput = document.getElementById('photoInput'); if (photoInput) { photoInput.value = ''; }
  fileBlob = null;

  setStatus('Saisie enregistrée ✅. Préparation d’un nouveau scan…');
  if (navigator.vibrate) navigator.vibrate(50);

  if (AUTO_RECAPTURE && photoInput) {
    const btnCapture = document.getElementById('btn-capture');
    setTimeout(() => {
      try {
        photoInput.click();
        setStatus('Appareil photo ouvert. Cadrez le code et validez la photo.');
        if (btnCapture) btnCapture.classList.remove('pulse');
      } catch (e) {
        setStatus('Touchez “Scanner (photo)” pour une nouvelle prise.');
        if (btnCapture) btnCapture.classList.add('pulse');
      }
    }, 300);
  }
}

/* ---------- Helpers image / EXIF ---------- */
async function loadImageWithOrientation(file) {
  if ('createImageBitmap' in window) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { bitmap: bmp, width: bmp.width, height: bmp.height };
    } catch (_) { /* fallback */ }
  }
  const orientation = await getExifOrientation(file).catch(()=>1);
  const img = await loadImageElement(file);
  let bmp;
  if ('createImageBitmap' in window) {
    bmp = await createImageBitmap(img);
  } else {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    bmp = c;
  }
  if (orientation === 1) {
    return { bitmap: bmp, width: bmp.width || img.naturalWidth, height: bmp.height || img.naturalHeight };
  }
  const {canvas, w, h} = drawOriented(bmp, orientation);
  return { bitmap: canvas, width: w, height: h };
}
function sizeAfterRotation(w, h, deg){ return (deg % 180 === 0) ? {w, h} : {w: h, h: w}; }
function showPreviewFromCanvas() { if (!previewEl) return; try { previewEl.src = canvasEl.toDataURL('image/png'); previewEl.style.display = 'block'; } catch (_) {} }

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
async function getExifOrientation(file) {
  const buf = await file.slice(0, 64*1024).arrayBuffer();
  const view = new DataView(buf);
  if (view.getUint16(0, false) !== 0xFFD8) return 1; // pas JPEG
  let offset = 2; const length = view.byteLength;
  while (offset < length) {
    const marker = view.getUint16(offset, false); offset += 2;
    if (marker === 0xFFE1) {
      const app1Len = view.getUint16(offset, false); offset += 2;
      if (view.getUint32(offset, false) !== 0x45786966) return 1; // 'Exif'
      offset += 6;
      const tiff = offset;
      const little = view.getUint16(tiff, false) === 0x4949;
      const firstIFD = view.getUint32(tiff+4, little);
      if (firstIFD < 8) return 1;
      const dirStart = tiff + firstIFD;
      const entries = view.getUint16(dirStart, little);
      for (let i=0; i<entries; i++) {
        const entry = dirStart + 2 + i*12;
        const tag = view.getUint16(entry, little);
        if (tag === 0x0112) {
          const val = view.getUint16(entry + 8, little);
          return val || 1;
        }
      }
      return 1;
    } else if ((marker & 0xFF00) !== 0xFF00) { break; }
    else { offset += view.getUint16(offset, false); }
  }
  return 1;
}
function drawOriented(srcBitmap, orientation) {
  const sw = srcBitmap.width || srcBitmap.canvas?.width;
  const sh = srcBitmap.height || srcBitmap.canvas?.height;
  let dw = sw, dh = sh;
  if ([5,6,7,8].includes(orientation)) { dw = sh; dh = sw; }
  const canvas = document.createElement('canvas'); canvas.width = dw; canvas.height = dh;
  const c = canvas.getContext('2d');
  switch (orientation) {
    case 2: c.translate(dw, 0); c.scale(-1, 1); break;
    case 3: c.translate(dw, dh); c.rotate(Math.PI); break;
    case 4: c.translate(0, dh); c.scale(1, -1); break;
    case 5: c.rotate(0.5 * Math.PI); c.scale(1, -1); break;
    case 6: c.rotate(0.5 * Math.PI); c.translate(0, -dh); break;
    case 7: c.rotate(1.5 * Math.PI); c.scale(1, -1); c.translate(-dw, 0); break;
    case 8: c.rotate(1.5 * Math.PI); c.translate(-dw, 0); break;
    default: break;
  }
  c.drawImage(srcBitmap, 0, 0, sw, sh);
  return { canvas, w: dw, h: dh };
}
