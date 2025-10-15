/* Inventaire ONU — app.js (PHOTO UNIQUEMENT)
 * - Pas de getUserMedia, pas de flux vidéo.
 * - Input file (camera natif) → decode image (ZXing sur image, fallback jsQR pour QR).
 * - POST en x-www-form-urlencoded vers Apps Script (évite le preflight CORS).
 */

const API_BASE = "https://script.google.com/macros/s/AKfycbwtFL1iaSSdkB7WjExdXYGbQQbhPeIi_7F61pQdUEJK8kSFznjEOU68Fh6U538PGZW2/exec";
const APP_VERSION = "1.0.3";

let canvasEl, ctx, statusEl, flashEl, previewEl;
let fileBlob = null;

document.addEventListener('DOMContentLoaded', () => {
  canvasEl = document.getElementById('canvas');
  ctx = canvasEl.getContext('2d', { willReadFrequently: true });
  statusEl = document.getElementById('status');
  flashEl = document.getElementById('flash');
  previewEl = document.getElementById('preview');

  // Inputs
  document.getElementById('photoInput').addEventListener('change', onPhotoPicked);
  document.getElementById('btn-decode').addEventListener('click', decodePhoto);

  // Formulaire
  const typeSel = document.getElementById('type');
  const typeOtherWrap = document.getElementById('field-type-autre');
  typeSel.addEventListener('change', () => {
    typeOtherWrap.hidden = typeSel.value !== 'Autre';
  });
  document.getElementById('date_mvt').value = new Date().toISOString().slice(0,10);
  document.getElementById('form').addEventListener('submit', onSubmit);
  document.getElementById('btn-test').addEventListener('click', onTest);

  // SW PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js');
  }
});

function setStatus(msg){ statusEl.textContent = msg; }
function setApiMsg(msg, isError=false) {
  const el = document.getElementById('api-msg');
  el.textContent = msg;
  el.style.color = isError ? 'var(--err)' : 'var(--ok)';
}
function vibrate(){ if (navigator.vibrate) navigator.vibrate(200); }
function flash(){ flashEl.classList.remove('active'); void flashEl.offsetWidth; flashEl.classList.add('active'); }
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
  codeInput.value = text;
  codeInput.focus();
}

/* 1) Sélection de la photo */
function onPhotoPicked(ev){
  const file = ev.target.files && ev.target.files[0];
  if (!file) {
    fileBlob = null;
    previewEl.style.display = 'none';
    document.getElementById('btn-decode').disabled = true;
    setStatus('Aucune photo choisie.');
    return;
  }
  fileBlob = file;
  const url = URL.createObjectURL(file);
  previewEl.src = url;
  previewEl.style.display = 'block';
  document.getElementById('btn-decode').disabled = false;
  setStatus('Photo chargée. Cliquez sur "Décoder la photo".');
}

/* 2) Décodage photo → ZXing sur image, fallback jsQR */
async function decodePhoto(){
  if (!fileBlob) return alert('Choisissez d’abord une photo.');
  const img = new Image();
  img.onload = () => {
    // Dessine dans le canvas à la taille de l’image (limite raisonnable)
    const MAX_W = 1920, MAX_H = 1920;
    let w = img.naturalWidth, h = img.naturalHeight;
    const sc = Math.min(MAX_W / w, MAX_H / h, 1);
    w = Math.round(w * sc); h = Math.round(h * sc);

    canvasEl.width = w;
    canvasEl.height = h;
    ctx.drawImage(img, 0, 0, w, h);

    // ZXing sur image
    try {
      const luminanceSource = new ZXing.HTMLCanvasElementLuminanceSource(canvasEl);
      const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminanceSource));
      const reader = new ZXing.MultiFormatReader();
      const res = reader.decode(bitmap);
      if (res && res.getText) { onCodeDetected(res.getText()); return; }
    } catch(_) { /* on tente jsQR ensuite */ }

    // jsQR (QR uniquement)
    try {
      const imgData = ctx.getImageData(0,0,canvasEl.width,canvasEl.height);
      const code = jsQR(imgData.data, imgData.width, imgData.height);
      if (code && code.data) { onCodeDetected(code.data); return; }
    } catch(e){ /* ignore */ }

    setStatus('Aucun code détecté sur cette photo. Essayez une autre, plus nette/éclairée/centrée.');
  };
  img.onerror = () => setStatus('Impossible de lire la photo (format non supporté ?).');
  img.src = URL.createObjectURL(fileBlob);
}

/* 3) Envoi au backend (x-www-form-urlencoded, pas de preflight CORS) */
async function onSubmit(ev) {
  ev.preventDefault();
  const code = document.getElementById('code').value.trim();
  const from = document.getElementById('from').value.trim();
  const to = document.getElementById('to').value.trim();
  const type = document.getElementById('type').value;
  const typeAutre = document.getElementById('type_autre').value.trim();
  const date_mvt = document.getElementById('date_mvt').value;
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
      document.getElementById('code').value = '';
    } else {
      setApiMsg(`Erreur API: ${data && data.message ? data.message : 'Inconnue'}`, true);
    }
  } catch (err) {
    console.error(err);
    setApiMsg('Erreur réseau/API. Vérifiez la Web App.', true);
  }
}

function onTest() {
  document.getElementById('code').value = 'TEST-QR-123';
  document.getElementById('from').value = 'Voie Creuse';
  document.getElementById('to').value = 'Bibliothèque';
  document.getElementById('type').value = 'Bureau';
  document.getElementById('type').dispatchEvent(new Event('change'));
  setStatus('Champs de test remplis.');
}
