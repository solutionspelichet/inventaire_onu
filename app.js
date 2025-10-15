/* PWA Inventaire ONU — app.js (Vanilla JS, CORS simple)
 * - URL Apps Script: fournie ci-dessous (API_BASE)
 * - Pas d'en-têtes custom ni JSON → évite le preflight CORS
 * - Décodeur: BarcodeDetector natif si dispo, sinon ZXing en live, sinon fallback photo (ZXing sur image puis jsQR)
 * - UI: sélecteur caméra, lampe, zoom, feedback (flash/bip/vibration)
 */

const API_BASE = "https://script.google.com/macros/s/AKfycbwtFL1iaSSdkB7WjExdXYGbQQbhPeIi_7F61pQdUEJK8kSFznjEOU68Fh6U538PGZW2/exec";
const APP_VERSION = "1.0.2";

let videoEl, canvasEl, ctx, statusEl, flashEl;
let stream = null;
let scanning = false;
let barcodeDetector = null;
let zxingReader = null;
let zxingControls = null;
let deviceId = null;
let track = null;
let torchOn = false;
let deferredPrompt = null;

// ---------- PWA install ----------
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById('btn-install');
  if (btn) {
    btn.hidden = false;
    btn.onclick = async () => {
      btn.hidden = true;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    };
  }
});

// ---------- DOM Ready ----------
document.addEventListener('DOMContentLoaded', () => {
  videoEl = document.getElementById('video');
  canvasEl = document.getElementById('canvas');
  flashEl = document.getElementById('flash');
  statusEl = document.getElementById('status');
  ctx = canvasEl.getContext('2d', { willReadFrequently: true });

  // Boutons camera
  document.getElementById('btn-start').addEventListener('click', startCamera);
  document.getElementById('btn-scan').addEventListener('click', startLiveScan);
  document.getElementById('btn-photo').addEventListener('click', photoFallback);
  document.getElementById('btn-stop').addEventListener('click', stopCamera);
  document.getElementById('btn-torch').addEventListener('click', toggleTorch);
  document.getElementById('zoom').addEventListener('input', onZoom);
  const camSel = document.getElementById('cameraSelect');
  camSel.addEventListener('change', () => {
    deviceId = camSel.value || null;
    if (stream) restartCamera();
  });

  // Formulaire
  const typeSel = document.getElementById('type');
  const typeOtherWrap = document.getElementById('field-type-autre');
  typeSel.addEventListener('change', () => {
    typeOtherWrap.hidden = typeSel.value !== 'Autre';
  });
  document.getElementById('date_mvt').value = new Date().toISOString().slice(0,10);
  document.getElementById('form').addEventListener('submit', onSubmit);
  document.getElementById('btn-test').addEventListener('click', onTest);

  // SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js');
  }

  // Décodeur natif si dispo
  if ('BarcodeDetector' in window) {
    try {
      barcodeDetector = new BarcodeDetector({
        formats: ['qr_code','ean_13','ean_8','code_128','code_39','upc_a','upc_e','itf','codabar','data_matrix','pdf417','aztec']
      });
    } catch (e) { barcodeDetector = null; }
  }

  // iOS: un geste débloque l’audio/lecture inline
  document.body.addEventListener('touchstart', ()=>{}, { once:true });
  document.body.addEventListener('click', ()=>{}, { once:true });
});

// ---------- Helpers UI ----------
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

// ---------- Caméra ----------
async function listCameras() {
  const sel = document.getElementById('cameraSelect');
  sel.innerHTML = '';
  sel.disabled = true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const vids = devices.filter(d => d.kind === 'videoinput');
    vids.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Caméra ${i+1}`;
      sel.appendChild(opt);
    });
    if (vids.length) {
      sel.disabled = false;
      const back = vids.find(v => /back|arrière|environment/i.test(v.label));
      deviceId = (back ? back.deviceId : vids[0].deviceId);
      sel.value = deviceId;
    }
  } catch (e) { /* ignore */ }
}

async function startCamera() {
  try {
    setStatus('Ouverture de la caméra…');
    await listCameras();
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } },
      audio: false
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.setAttribute('playsinline','');
    videoEl.muted = true;
    videoEl.srcObject = stream;
    await videoEl.play();

    track = stream.getVideoTracks()[0];

    document.getElementById('btn-scan').disabled = false;
    document.getElementById('btn-photo').disabled = false;
    document.getElementById('btn-stop').disabled = false;

    // Torch/Zoom si supportés
    const torchBtn = document.getElementById('btn-torch');
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    torchBtn.disabled = !caps.torch;

    const zoomInput = document.getElementById('zoom');
    if (caps.zoom) {
      zoomInput.min = caps.zoom.min || 1;
      zoomInput.max = caps.zoom.max || 1;
      zoomInput.step = caps.zoom.step || 0.1;
      zoomInput.value = track.getSettings().zoom || zoomInput.min;
      zoomInput.disabled = false;
    } else {
      zoomInput.disabled = true;
    }

    setStatus('Caméra prête. Cliquez sur "Scanner".');
  } catch (err) {
    console.error(err);
    setStatus('Impossible d’accéder à la caméra. Vérifiez HTTPS et permissions.');
    alert("Autorisez la caméra (HTTPS requis). Sur iOS: Réglages > Safari > Caméra.");
  }
}

async function restartCamera(){ await stopCamera(); return startCamera(); }

async function stopCamera() {
  try {
    scanning = false;
    if (zxingControls) { try { zxingControls.stop(); } catch(_) {} zxingControls = null; }
    zxingReader = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    track = null;
    videoEl.srcObject = null;
    document.getElementById('btn-scan').disabled = true;
    document.getElementById('btn-photo').disabled = true;
    document.getElementById('btn-stop').disabled = true;
    document.getElementById('btn-torch').disabled = true;
    document.getElementById('zoom').disabled = true;
    setStatus('Caméra arrêtée.');
  } catch(_) {}
}

async function toggleTorch(){
  if (!track) return;
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.torch) return;
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); }
  catch(e){ torchOn = !torchOn; }
}
async function onZoom(e){
  if (!track) return;
  const val = Number(e.target.value);
  try { await track.applyConstraints({ advanced: [{ zoom: val }] }); }
  catch(err){ /* ignore */ }
}

// ---------- Live scan ----------
async function startLiveScan() {
  if (!stream) return alert("Démarrez la caméra d’abord.");
  if (scanning) return;
  scanning = true;
  setStatus('Scan en cours… Visez le code.');

  // 1) BarcodeDetector natif
  if (barcodeDetector) {
    const loop = async () => {
      if (!scanning || !stream) return;
      try {
        const barcodes = await barcodeDetector.detect(videoEl);
        if (barcodes && barcodes.length) {
          scanning = false;
          onCodeDetected(barcodes[0].rawValue || barcodes[0].raw || '');
          return;
        }
      } catch(e) {
        barcodeDetector = null; // bascule sur ZXing
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return;
  }

  // 2) ZXing live
  try {
    const codeReader = ZXing.BrowserMultiFormatReader;
    zxingReader = new codeReader();
    zxingControls = await zxingReader.decodeFromVideoDevice(deviceId || null, videoEl, (res, err, controls) => {
      if (!scanning) return;
      if (res) {
        scanning = false;
        controls.stop();
        onCodeDetected(res.getText());
      }
    });
  } catch (err) {
    console.warn('ZXing live échec — utilisez "Photo (fallback)".', err);
    setStatus('Lecture vidéo instable. Essayez "Photo (fallback)".');
  }
}

// ---------- Fallback photo (image → ZXing puis jsQR) ----------
async function photoFallback() {
  if (!stream) return alert("Démarrez la caméra d’abord.");
  canvasEl.width = videoEl.videoWidth;
  canvasEl.height = videoEl.videoHeight;
  ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

  // ZXing sur image
  try {
    const luminanceSource = new ZXing.HTMLCanvasElementLuminanceSource(canvasEl);
    const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminanceSource));
    const reader = new ZXing.MultiFormatReader();
    const res = reader.decode(bitmap);
    if (res && res.getText) { onCodeDetected(res.getText()); return; }
  } catch(_) { /* on tente jsQR */ }

  // jsQR (QR uniquement)
  try {
    const imgData = ctx.getImageData(0,0,canvasEl.width,canvasEl.height);
    const code = jsQR(imgData.data, imgData.width, imgData.height);
    if (code && code.data) { onCodeDetected(code.data); return; }
  } catch(e){ /* ignore */ }

  setStatus('Aucun code détecté. Approchez-vous, éclairez mieux, ou changez d’angle.');
}

// ---------- Formulaire & API (CORS simple: x-www-form-urlencoded) ----------
async function onSubmit(ev) {
  ev.preventDefault();
  const code = document.getElementById('code').value.trim();
  const from = document.getElementById('from').value.trim();
  const to = document.getElementById('to').value.trim();
  const type = document.getElementById('type').value;
  const typeAutre = document.getElementById('type_autre').value.trim();
  const date_mvt = document.getElementById('date_mvt').value;
  if (!code || !from || !to || !type) return setApiMsg('Veuillez remplir tous les champs.', true);

  await stopCamera(); // économiser la batterie pendant l’envoi

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
