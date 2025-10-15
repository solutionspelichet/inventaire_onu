/* Inventaire ONU — app.js (PHOTO UNIQUEMENT)
 * - Pas de getUserMedia : on utilise <input type="file" accept="image/*" capture="environment">
 * - Décodage image : ZXing sur image, puis jsQR en fallback (QR only)
 * - Orientation EXIF respectée (rotation/miroir) + tailles & rotations d’essai
 * - Envoi backend Apps Script en x-www-form-urlencoded (évite le preflight CORS)
 */

const API_BASE = "https://script.google.com/macros/s/AKfycbwtFL1iaSSdkB7WjExdXYGbQQbhPeIi_7F61pQdUEJK8kSFznjEOU68Fh6U538PGZW2/exec";
const APP_VERSION = "1.0.4";

let canvasEl, ctx, statusEl, flashEl, previewEl;
let fileBlob = null;

document.addEventListener('DOMContentLoaded', () => {
  canvasEl = document.getElementById('canvas');
  ctx = canvasEl.getContext('2d', { willReadFrequently: true });
  statusEl = document.getElementById('status');
  flashEl = document.getElementById('flash');
  previewEl = document.getElementById('preview');

  // Inputs photo
  const photoInput = document.getElementById('photoInput');
  const btnDecode = document.getElementById('btn-decode');
  if (photoInput) photoInput.addEventListener('change', onPhotoPicked);
  if (btnDecode) btnDecode.addEventListener('click', decodePhoto);

  // Formulaire
  const typeSel = document.getElementById('type');
  const typeOtherWrap = document.getElementById('field-type-autre');
  if (typeSel && typeOtherWrap) {
    typeSel.addEventListener('change', () => {
      typeOtherWrap.hidden = typeSel.value !== 'Autre';
    });
  }
  const dateInput = document.getElementById('date_mvt');
  if (dateInput) dateInput.value = new Date().toISOString().slice(0,10);

  const form = document.getElementById('form');
  if (form) form.addEventListener('submit', onSubmit);

  const btnTest = document.getElementById('btn-test');
  if (btnTest) btnTest.addEventListener('click', onTest);

  // SW PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js');
  }
});

/* ---------- Helpers UI ---------- */
function setStatus(msg){ if (statusEl) statusEl.textContent = msg; }
function setApiMsg(msg, isError=false) {
  const el = document.getElementById('api-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--err)' : 'var(--ok)';
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
  if (codeInput) {
    codeInput.value = text;
    codeInput.focus();
  }
}

/* ---------- 1) Sélection de la photo ---------- */
function onPhotoPicked(ev){
  const file = ev.target.files && ev.target.files[0];
  if (!file) {
    fileBlob = null;
    if (previewEl) previewEl.style.display = 'none';
    const btn = document.getElementById('btn-decode');
    if (btn) btn.disabled = true;
    setStatus('Aucune photo choisie.');
    return;
  }
  fileBlob = file;
  const url = URL.createObjectURL(file);
  if (previewEl) {
    previewEl.src = url;
    previewEl.style.display = 'block';
  }
  const btn = document.getElementById('btn-decode');
  if (btn) btn.disabled = false;
  setStatus('Photo chargée. Cliquez sur "Décoder la photo".');
}

/* ---------- 2) Décodage photo robuste ---------- */
async function decodePhoto(){
  if (!fileBlob) return alert('Choisissez d’abord une photo.');

  // Charge l’image avec orientation EXIF respectée
  const {bitmap, width, height} = await loadImageWithOrientation(fileBlob);

  // Essais : plusieurs échelles + rotations
  const scales = [1.0, 0.75, 0.5];
  const rotations = [0, 90, 180, 270];

  for (const scale of scales) {
    for (const rot of rotations) {
      const targetW = Math.round(width * scale);
      const targetH = Math.round(height * scale);
      const {w, h} = sizeAfterRotation(targetW, targetH, rot);

      canvasEl.width = w;
      canvasEl.height = h;

      const ctx2 = canvasEl.getContext('2d', { willReadFrequently: true });
      ctx2.save();
      ctx2.translate(w/2, h/2);
      ctx2.rotate(rot * Math.PI/180);
      ctx2.filter = 'contrast(1.15) brightness(1.05)';
      ctx2.drawImage(bitmap, -targetW/2, -targetH/2, targetW, targetH);
      ctx2.restore();

      // ZXing (multi-format)
      try {
        const luminanceSource = new ZXing.HTMLCanvasElementLuminanceSource(canvasEl);
        const bitmapZX = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminanceSource));
        const reader = new ZXing.MultiFormatReader();
        const res = reader.decode(bitmapZX);
        if (res && res.getText) {
          showPreviewFromCanvas();
          onCodeDetected(res.getText());
          return;
        }
      } catch (_) { /* ignore, on tente jsQR ensuite */ }

      // jsQR (QR uniquement)
      try {
        const imgData = ctx2.getImageData(0,0,canvasEl.width,canvasEl.height);
        const code = jsQR(imgData.data, imgData.width, imgData.height);
        if (code && code.data) {
          showPreviewFromCanvas();
          onCodeDetected(code.data);
          return;
        }
      } catch (_) {}
    }
  }

  showPreviewFromCanvas();
  setStatus('Aucun code détecté. Reprenez la photo (plus net, plus proche, meilleure lumière).');
}

/* ---------- 3) Envoi au backend (x-www-form-urlencoded) ---------- */
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
      const codeInput = document.getElementById('code');
      if (codeInput) codeInput.value = '';
    } else {
      setApiMsg(`Erreur API: ${data && data.message ? data.message : 'Inconnue'}`, true);
    }
  } catch (err) {
    console.error(err);
    setApiMsg('Erreur réseau/API. Vérifiez la Web App.', true);
  }
}

function onTest() {
  const codeEl = document.getElementById('code');
  const fromEl = document.getElementById('from');
  const toEl = document.getElementById('to');
  const typeEl = document.getElementById('type');
  if (codeEl) codeEl.value = 'TEST-QR-123';
  if (fromEl) fromEl.value = 'Voie Creuse';
  if (toEl) toEl.value = 'Bibliothèque';
  if (typeEl) {
    typeEl.value = 'Bureau';
    typeEl.dispatchEvent(new Event('change'));
  }
  setStatus('Champs de test remplis.');
}

/* ---------- Helpers image / EXIF ---------- */

// Charge l’image en respectant l’EXIF orientation quand c’est possible
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
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    bmp = c; // acceptable comme source de drawImage
  }

  if (orientation === 1) {
    return { bitmap: bmp, width: bmp.width || img.naturalWidth, height: bmp.height || img.naturalHeight };
  }

  const {canvas, w, h} = drawOriented(bmp, orientation);
  return { bitmap: canvas, width: w, height: h };
}

function sizeAfterRotation(w, h, deg) {
  if (deg % 180 === 0) return { w, h };
  return { w: h, h: w };
}

function showPreviewFromCanvas() {
  if (!previewEl) return;
  try {
    previewEl.src = canvasEl.toDataURL('image/png');
    previewEl.style.display = 'block';
  } catch (_) {}
}

// Charge un <img> depuis un File
function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/* Lecture minimale du tag EXIF Orientation (JPEG) :
   Retourne 1 (normal) si introuvable.
   Orientations :
     1 = normal
     2 = miroir horizontal
     3 = rotation 180
     4 = miroir vertical
     5 = miroir + rotation 90 CW
     6 = rotation 90 CW
     7 = miroir + rotation 270 CW
     8 = rotation 270 CW
*/
async function getExifOrientation(file) {
  const buf = await file.slice(0, 64*1024).arrayBuffer();
  const view = new DataView(buf);

  if (view.getUint16(0, false) !== 0xFFD8) return 1; // pas JPEG
  let offset = 2;
  const length = view.byteLength;

  while (offset < length) {
    const marker = view.getUint16(offset, false);
    offset += 2;
    if (marker === 0xFFE1) { // APP1
      const app1Len = view.getUint16(offset, false);
      offset += 2;
      if (view.getUint32(offset, false) !== 0x45786966) return 1; // 'Exif'
      offset += 6; // "Exif\0\0"
      const tiffOffset = offset;
      const little = view.getUint16(tiffOffset, false) === 0x4949;
      const firstIFDOffset = view.getUint32(tiffOffset+4, little);
      if (firstIFDOffset < 0x00000008) return 1;

      const dirStart = tiffOffset + firstIFDOffset;
      const entries = view.getUint16(dirStart, little);
      for (let i=0; i<entries; i++) {
        const entryOffset = dirStart + 2 + i*12;
        const tag = view.getUint16(entryOffset, little);
        if (tag === 0x0112) { // Orientation
          const val = view.getUint16(entryOffset + 8, little);
          return val || 1;
        }
      }
      return 1;
    } else if ((marker & 0xFF00) !== 0xFF00) {
      break;
    } else {
      offset += view.getUint16(offset, false);
    }
  }
  return 1;
}

// Applique la transformation d’orientation EXIF à un bitmap/canvas source
function drawOriented(srcBitmap, orientation) {
  const sw = srcBitmap.width || srcBitmap.canvas?.width;
  const sh = srcBitmap.height || srcBitmap.canvas?.height;

  let dw = sw, dh = sh;
  if (orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8) {
    dw = sh; dh = sw;
  }
  const canvas = document.createElement('canvas');
  canvas.width = dw; canvas.height = dh;
  const ctx = canvas.getContext('2d');

  switch (orientation) {
    case 2: // miroir horizontal
      ctx.translate(dw, 0); ctx.scale(-1, 1); break;
    case 3: // 180
      ctx.translate(dw, dh); ctx.rotate(Math.PI); break;
    case 4: // miroir vertical
      ctx.translate(0, dh); ctx.scale(1, -1); break;
    case 5: // miroir + 90 CW
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1); break;
    case 6: // 90 CW
      ctx.rotate(0.5 * Math.PI);
      ctx.translate(0, -dh); break;
    case 7: // miroir + 270 CW
      ctx.rotate(1.5 * Math.PI);
      ctx.scale(1, -1);
      ctx.translate(-dw, 0); break;
    case 8: // 270 CW
      ctx.rotate(1.5 * Math.PI);
      ctx.translate(-dw, 0); break;
    default:
      // 1: rien
      break;
  }

  ctx.drawImage(srcBitmap, 0, 0, sw, sh);
  return { canvas, w: dw, h: dh };
}
