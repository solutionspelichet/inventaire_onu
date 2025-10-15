/* PWA Inventaire ONU — app.js (Vanilla JS)
 * - Caméra: getUserMedia({ video: { facingMode: "environment" } })
 * - Scanner: ZXing (video) + fallback jsQR (photo)
 * - Feedback: vibrate + bip + flash visuel
 * - API: Apps Script Web App avec CORS (voir README)
 */

const API_BASE = "https://script.google.com/macros/s/AKfycbwtFL1iaSSdkB7WjExdXYGbQQbhPeIi_7F61pQdUEJK8kSFznjEOU68Fh6U538PGZW2/exec"; // <= ⚠️ COLLE ICI ton URL, puis on ajoute ?route=...
const APP_VERSION = "1.0.0";

let videoEl, canvasEl, ctx, statusEl, flashEl;
let stream = null;
let zxingReader = null;
let scanning = false;
let deferredPrompt = null;

// ---------- PWA Install UI ----------
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById('btn-install');
  btn.hidden = false;
  btn.onclick = async () => {
    btn.hidden = true;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  };
});

// ---------- DOM Ready ----------
document.addEventListener('DOMContentLoaded', () => {
  videoEl = document.getElementById('video');
  canvasEl = document.getElementById('canvas');
  flashEl = document.getElementById('flash');
  statusEl = document.getElementById('status');
  ctx = canvasEl.getContext('2d', { willReadFrequently: true });

  document.getElementById('btn-start').addEventListener('click', startCamera);
  document.getElementById('btn-scan').addEventListener('click', startLiveScan);
  document.getElementById('btn-photo').addEventListener('click', photoFallback);
  document.getElementById('btn-stop').addEventListener('click', stopCamera);

  // Formulaire
  const typeSel = document.getElementById('type');
  const typeOtherWrap = document.getElementById('field-type-autre');
  typeSel.addEventListener('change', () => {
    typeOtherWrap.hidden = typeSel.value !== 'Autre';
  });

  // Date du jour par défaut
  document.getElementById('date_mvt').value = new Date().toISOString().slice(0,10);

  // Soumission
  document.getElementById('form').addEventListener('submit', onSubmit);
  document.getElementById('btn-test').addEventListener('click', onTest);

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js');
  }
});

// ---------- Caméra ----------
async function startCamera() {
  try {
    setStatus('Ouverture de la caméra…');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    document.getElementById('btn-scan').disabled = false;
    document.getElementById('btn-photo').disabled = false;
    document.getElementById('btn-stop').disabled = false;
    setStatus('Caméra prête. Cliquez sur "Scanner".');
  } catch (err) {
    console.error(err);
    setStatus('Impossible d’accéder à la caméra. Vérifiez les permissions.');
    alert("Autorisez la caméra (HTTPS requis). Sur iOS: Réglages > Safari > Caméra.");
  }
}

async function stopCamera() {
  try {
    scanning = false;
    if (zxingReader) {
      zxingReader = null;
    }
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    videoEl.srcObject = null;
    setStatus('Caméra arrêtée.');
    document.getElementById('btn-scan').disabled = true;
    document.getElementById('btn-photo').disabled = true;
    document.getElementById('btn-stop').disabled = true;
  } catch(_) {}
}

// ---------- ZXing live scan ----------
async function startLiveScan() {
  if (!stream) return alert("Démarrez la caméra d’abord.");
  if (scanning) return;

  setStatus('Scan en cours… Visez le code.');
  scanning = true;

  try {
    const codeReader = ZXing.BrowserMultiFormatReader;
    zxingReader = new codeReader();
    const result = await zxingReader.decodeFromVideoDevice(null, videoEl, (res, err, controls) => {
      if (res && scanning) {
        scanning = false;
        controls.stop();
        onCodeDetected(res.getText());
      }
    });
  } catch (err) {
    console.warn('ZXing live fail, utilisez Fallback Photo.', err);
    setStatus('Lecture vidéo instable. Essayez "Photo (fallback)".');
  }
}

// ---------- Fallback Photo + jsQR (QR uniquement) ----------
async function photoFallback() {
  if (!stream) return alert("Démarrez la caméra d’abord.");
  // Capture image du flux vidéo
  canvasEl.width = videoEl.videoWidth;
  canvasEl.height = videoEl.videoHeight;
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
  const imgData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
  try {
    const code = jsQR(imgData.data, imgData.width, imgData.height);
    if (code && code.data) {
      onCodeDetected(code.data);
    } else {
      setStatus('Aucun QR détecté (fallback). Approchez-vous ou éclairez la scène.');
    }
  } catch (err) {
    console.error(err);
    setStatus('Erreur de décodage (fallback).');
  }
}

// ---------- Détection code ----------
function onCodeDetected(text) {
  flash();
  beep();
  vibrate();
  setStatus(`Code détecté: ${text}`);
  const codeInput = document.getElementById('code');
  codeInput.value = text;
  codeInput.focus();
}

// Feedbacks
function vibrate() {
  if (navigator.vibrate) navigator.vibrate(200);
}
function flash() {
  flashEl.classList.remove('active');
  void flashEl.offsetWidth; // reflow
  flashEl.classList.add('active');
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1000, ctx.currentTime);
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    o.connect(g).connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.1, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
    o.stop(ctx.currentTime + 0.2);
  } catch(_) { /* iOS: nécessite interaction préalable */ }
}

// ---------- Formulaire ----------
async function onSubmit(ev) {
  ev.preventDefault();
  const code = document.getElementById('code').value.trim();
  const from = document.getElementById('from').value.trim();
  const to = document.getElementById('to').value.trim();
  const type = document.getElementById('type').value;
  const typeAutre = document.getElementById('type_autre').value.trim();
  const date_mvt = document.getElementById('date_mvt').value;

  if (!code || !from || !to || !type) {
    return setApiMsg('Veuillez remplir tous les champs obligatoires.', true);
  }

  // Arrête la caméra pour économiser
  await stopCamera();

  const payload = {
    code_scanné: code,
    emplacement_depart: from,
    emplacement_destination: to,
    type_mobilier: type,
    type_mobilier_autre: (type === 'Autre') ? typeAutre : '',
    date_mouvement: date_mvt,
    source_app_version: APP_VERSION
  };

  try {
    const url = `${API_BASE}?route=/items`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      mode: 'cors',
      credentials: 'omit'
    });
    const xStatus = res.headers.get('X-Status') || '200';
    const data = await res.json().catch(()=>({}));
    if (xStatus.startsWith('2') && data.status >= 200 && data.status < 300) {
      setApiMsg('Écrit dans Google Sheets ✅', false);
      // Reset code uniquement
      document.getElementById('code').value = '';
    } else {
      setApiMsg(`Erreur API (${xStatus}): ${data.message || 'Inconnue'}`, true);
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

function setStatus(msg) {
  statusEl.textContent = msg;
}
function setApiMsg(msg, isError=false) {
  const el = document.getElementById('api-msg');
  el.textContent = msg;
  el.style.color = isError ? 'var(--err)' : 'var(--ok)';
}
