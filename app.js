/* Inventaire ONU — app.js
 * - Bouton "Installer" : prompt Android/desktop + aide iOS (Safari), jamais auto
 * - Thème Pelichet (clair par défaut) + toggle
 * - Scan photo : BarcodeDetector → ZXing + hints → jsQR (fallback)
 * - Persistance des champs (from/to/type) + bouton d’effacement
 * - POST vers Apps Script en x-www-form-urlencoded
 * - Export XLSX : colonne C texte + largeur auto
 */

const API_BASE = "https://script.google.com/macros/s/AKfycbwtFL1iaSSdkB7WjExdXYGbQQbhPeIi_7F61pQdUEJK8kSFznjEOU68Fh6U538PGZW2/exec";
const APP_VERSION = "1.5.0";
const AUTO_RECAPTURE = true;

let canvasEl, ctx, statusEl, flashEl, previewEl;
let fileBlob = null;
let todayISO = new Date().toISOString().slice(0,10);
let todayCount = 0;

/* ===== PWA Install (Android prompt + iOS aide) ===== */
let deferredPrompt = null;
const IOS_A2HS_DISMISSED_KEY = 'ios_a2hs_dismissed_v1';

function isIos() {
  const ua = window.navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isSafari() {
  const ua = window.navigator.userAgent || '';
  // vrai Safari (pas Chrome/Firefox/Edge iOS)
  return /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
}
function isInStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// Android/desktop Chrome: capturer l’événement du prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById('btn-install');
  // Bouton visible si pas déjà installé
  if (btn && !isInStandalone()) btn.hidden = false;
});

// Ouvre le panneau iOS (jamais automatiquement, seulement à la demande)
function openIosA2hsPanel() {
  const panel = document.getElementById('ios-a2hs');
  if (!panel) return;
  panel.hidden = false;
  const ok = document.getElementById('ios-a2hs-close');
  if (ok) setTimeout(()=>ok.focus(), 0);
}

function closeIosA2hsPanel(persistDismiss = true) {
  const panel = document.getElementById('ios-a2hs');
  if (!panel) return;
  panel.hidden = true;
  if (persistDismiss) {
    try { localStorage.setItem(IOS_A2HS_DISMISSED_KEY, '1'); } catch(_) {}
  }
}

/* ===== Thème clair/sombre ===== */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme','dark'); else root.removeAttribute('data-theme');
  // meta couleur barre adresse
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.setAttribute('name','theme-color'); document.head.appendChild(meta); }
  meta.setAttribute('content', theme === 'dark' ? '#121417' : '#f6f8fa');
  // icônes bouton
  const btn = document.getElementById('btn-theme');
  const sun = document.getElementById('icon-sun');
  const moon = document.getElementById('icon-moon');
  if (btn && sun && moon) {
    const isDark = theme === 'dark';
    btn.setAttribute('aria-pressed', String(isDark));
    sun.hidden = isDark;
    moon.hidden = !isDark;
  }
}
function initTheme() {
  const stored = localStorage.getItem('theme');
  applyTheme(stored || 'light'); // défaut clair
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

/* ===== Valeurs persistées (from, to, type) ===== */
const PERSIST_KEY = 'inventaire_defaults_v1';
function loadPersistentDefaults() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      if (data.from) document.getElementById('from').value = data.from;
      if (data.to) document.getElementById('to').value = data.to;
      if (data.type) {
        const sel = document.getElementById('type');
        sel.value = data.type;
        sel.dispatchEvent(new Event('change'));
      }
    }
  } catch(_) {}
}
function savePersistentDefaults() {
  try {
    const from = (document.getElementById('from')?.value || '').trim();
    const to   = (document.getElementById('to')?.value || '').trim();
    const type = document.getElementById('type')?.value || '';
    const data = { from, to, type };
    localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
  } catch(_) {}
}
function clearPersistentDefaults() {
  try { localStorage.removeItem(PERSIST_KEY); } catch(_) {}
  const from = document.getElementById('from'); if (from) from.value = '';
  const to   = document.getElementById('to');   if (to) to.value   = '';
  const type = document.getElementById('type'); if (type) { type.value=''; type.dispatchEvent(new Event('change')); }
  setStatus('Valeurs par défaut effacées.');
}

/* ===== Détecteurs & hints (moteur scan renforcé) ===== */
const ZX_HINTS = (function(){
  try {
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const formats = [
      ZXing.BarcodeFormat.QR_CODE,
      ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.EAN_13,
      ZXing.BarcodeFormat.CODE_39,
      ZXing.BarcodeFormat.ITF,
      ZXing.BarcodeFormat.UPC_A,
      ZXing.BarcodeFormat.UPC_E,
    ];
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    return hints;
  } catch(_) { return null; }
})();

function preprocessCanvas(ctx, w, h) {
  const img = ctx.getImageData(0,0,w,h);
  const d = img.data;
  const gamma = 0.9, contrast = 1.15, mid = 128;
  for (let i=0; i<d.length; i+=4) {
    let r=d[i], g=d[i+1], b=d[i+2];
    r = 255*Math.pow(r/255, gamma);
    g = 255*Math.pow(g/255, gamma);
    b = 255*Math.pow(b/255, gamma);
    r = (r - mid)*contrast + mid;
    g = (g - mid)*contrast + mid;
    b = (b - mid)*contrast + mid;
    d[i]   = Math.max(0, Math.min(255, r));
    d[i+1] = Math.max(0, Math.min(255, g));
    d[i+2] = Math.max(0, Math.min(255, b));
  }
  ctx.putImageData(img, 0, 0);
}
async function tryBarcodeDetector(canvas) {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const sup = await BarcodeDetector.getSupportedFormats?.();
    const wanted = ['qr_code','ean_13','code_128','code_39','itf','upc_e','upc_a'];
    const fmts = sup ? wanted.filter(f => sup.includes(f)) : wanted;
    const det = new BarcodeDetector({ formats: fmts });
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png', 0.92));
    const imgBitmap = await createImageBitmap(blob);
    const res = await det.detect(imgBitmap);
    if (res && res[0] && res[0].rawValue) return { text: res[0].rawValue, engine: 'BarcodeDetector' };
  } catch(_) {}
  return null;
}
function tryZXingFromCanvas(canvas) {
  try {
    const luminance = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    const bin = new ZXing.HybridBinarizer(luminance);
    const bmp = new ZXing.BinaryBitmap(bin);
    const reader = new ZXing.MultiFormatReader();
    if (ZX_HINTS) reader.setHints(ZX_HINTS);
    const res = reader.decode(bmp);
    if (res && res.getText) return { text: res.getText(), engine: 'ZXing' };
  } catch(_) {}
  return null;
}
function tryJsQRFromCanvas(ctx, w, h) {
  try {
    const data = ctx.getImageData(0,0,w,h);
    const code = jsQR(data.data, w, h);
    if (code && code.data) return { text: code.data, engine: 'jsQR' };
  } catch(_) {}
  return null;
}

/* ===== DOM Ready ===== */
document.addEventListener('DOMContentLoaded', () => {
  // Thème
  initTheme();
  const btnTheme = document.getElementById('btn-theme');
  if (btnTheme) btnTheme.addEventListener('click', toggleTheme);

  // Install button logic (Android prompt / iOS aide)
  const btnInstall = document.getElementById('btn-install');
  const iosPanel   = document.getElementById('ios-a2hs');
  const iosClose   = document.getElementById('ios-a2hs-close');

  // Ne jamais ouvrir automatiquement (ni iOS ni Android). On montre le bouton :
  // - Android/desktop: quand l'événement beforeinstallprompt arrive (voir listener plus haut)
  // - iOS Safari: on l'affiche pour permettre d'ouvrir l'aide (pas de prompt natif)
  if (btnInstall && isIos() && isSafari() && !isInStandalone()) {
    btnInstall.hidden = false;
  }

  if (btnInstall) {
    btnInstall.addEventListener('click', async () => {
      // iOS Safari : afficher l’aide (pas de prompt Apple)
      if (isIos() && isSafari() && !isInStandalone()) {
        openIosA2hsPanel();
        return;
      }
      // Autres plateformes (Android/desktop) : déclencher le prompt natif si capturé
      if (deferredPrompt) {
        btnInstall.hidden = true;
        try {
          await deferredPrompt.prompt();
          await deferredPrompt.userChoice; // accepted/dismissed
        } catch (_) {}
        deferredPrompt = null;
      } else {
        alert('Pour installer : utilisez le menu du navigateur (“Ajouter à l’écran d’accueil”).');
      }
    });
  }

  // Fermer correctement le panneau iOS
  if (iosClose) iosClose.addEventListener('click', () => closeIosA2hsPanel(true));
  if (iosPanel) {
    iosPanel.addEventListener('click', (ev) => {
      if (ev.target === iosPanel) closeIosA2hsPanel(true); // clic sur l’overlay
    });
    window.addEventListener('keydown', (ev) => {
      if (!iosPanel.hidden && ev.key === 'Escape') closeIosA2hsPanel(true);
    });
    if (isInStandalone()) iosPanel.hidden = true; // si déjà installé, ne jamais montrer
  }
  // On ne ré-affiche jamais automatiquement (on lit la clé au cas où pour usage futur)
  const _dismissed = localStorage.getItem(IOS_A2HS_DISMISSED_KEY) === '1';
  // pas d’action

  // Réfs UI
  canvasEl = document.getElementById('canvas');
  ctx = canvasEl.getContext('2d', { willReadFrequently: true });
  statusEl = document.getElementById('status');
  flashEl = document.getElementById('flash');
  previewEl = document.getElementById('preview');

  // Capture photo
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
    typeSel.addEventListener('change', () => { typeOtherWrap.hidden = (typeSel.value !== 'Autre'); });
  }
  const dateInput = document.getElementById('date_mvt');
  if (dateInput) dateInput.value = todayISO;

  const form = document.getElementById('form');
  if (form) form.addEventListener('submit', onSubmit);

  const btnTest = document.getElementById('btn-test');
  if (btnTest) btnTest.addEventListener('click', onTest);

  const btnClearDefaults = document.getElementById('btn-clear-defaults');
  if (btnClearDefaults) btnClearDefaults.addEventListener('click', clearPersistentDefaults);

  // Export XLS
  const exportFrom = document.getElementById('export_from');
  const exportTo = document.getElementById('export_to');
  const btnXls = document.getElementById('btn-download-xls');
  if (exportFrom) exportFrom.value = todayISO;
  if (exportTo) exportTo.value = todayISO;
  if (btnXls) btnXls.addEventListener('click', onDownloadXls);

  // Service Worker
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');

  // Compteur + valeurs persistées
  refreshTodayCount();
  loadPersistentDefaults();
});

/* ---------- UI helpers ---------- */
function setStatus(msg){ if (statusEl) statusEl.textContent = msg; }
function setApiMsg(msg, isError=false) {
  const el = document.getElementById('api-msg');
  if (!el) return; el.textContent = msg; el.style.color = isError ? '#ef4444' : '#22c55e';
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

/* ---------- Télécharger XLS (colonne C en texte + largeur auto) ---------- */
async function onDownloadXls() {
  const from = document.getElementById('export_from')?.value;
  const to   = document.getElementById('export_to')?.value;
  if (!from || !to) { setStatus('Choisissez une période complète (du… au…).'); return; }
  if (from > to)     { setStatus('La date de début doit être antérieure à la date de fin.'); return; }

  try {
    setStatus('Préparation de l’export…');

    const url = `${API_BASE}?route=/export&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const res = await fetch(url, { method:'GET', mode:'cors', credentials:'omit' });

    const ct = res.headers.get('content-type') || '';
    const csvText = await res.text();

    if (!res.ok) { setStatus(`Erreur export (${res.status}).`); return; }
    if (ct.includes('application/json')) {
      try { const j = JSON.parse(csvText); setStatus(`Export: ${j.message || 'réponse JSON inattendue'}`); }
      catch { setStatus('Export: réponse JSON inattendue.'); }
      return;
    }

    const nonEmpty = csvText.trim();
    const lineCount = nonEmpty ? nonEmpty.split(/\r?\n/).length : 0;
    if (lineCount <= 1) { setStatus('Aucune donnée dans la période choisie.'); return; }

    if (typeof XLSX === 'undefined') { setStatus('Librairie Excel indisponible.'); return; }

    const wb = XLSX.read(csvText, { type: 'string', raw: true, cellText: false, cellDates: false });

    const first = wb.SheetNames[0];
    if (first !== 'Export') {
      if (wb.Sheets['Export']) { delete wb.Sheets['Export']; const i = wb.SheetNames.indexOf('Export'); if (i>-1) wb.SheetNames.splice(i,1); }
      wb.Sheets['Export'] = wb.Sheets[first];
      delete wb.Sheets[first];
      const idxFirst = wb.SheetNames.indexOf(first);
      if (idxFirst > -1) wb.SheetNames[idxFirst] = 'Export';
    }
    const ws = wb.Sheets['Export'];

    // Forcer colonne C (index 2) en texte + largeur auto
    const ref = ws['!ref'];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      const colIdx = 2; // C
      let maxLen = 'code_scanné'.length;

      for (let R = range.s.r + 1; R <= range.e.r; R++) { // +1 header
        const addr = XLSX.utils.encode_cell({ r: R, c: colIdx });
        const cell = ws[addr];
        if (!cell) continue;
        const val = (cell.v == null) ? '' : String(cell.v);
        cell.t = 's'; cell.v = val; cell.w = val; cell.z = '@';
        if (val.length > maxLen) maxLen = val.length;
      }

      const wch = Math.max(18, Math.min(40, maxLen + 2));
      const cols = ws['!cols'] || [];
      while (cols.length <= colIdx) cols.push({});
      cols[colIdx] = { wch, hidden: false };
      ws['!cols'] = cols;
    }

    const filename = `inventaire_${from}_au_${to}.xlsx`;
    XLSX.writeFile(wb, filename);

    setStatus('Fichier Excel téléchargé ✅ (colonne C en texte)');
  } catch (err) {
    console.error(err);
    setStatus('Erreur export. Vérifiez la période et réessayez.');
  }
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

/* ---------- Décodage robuste (BarcodeDetector -> ZXing -> jsQR) ---------- */
async function decodePhoto(){
  if (!fileBlob) return;

  const {bitmap, width, height} = await loadImageWithOrientation(fileBlob);
  const scales    = [1.0, 0.8, 0.6, 0.45];
  const rotations = [0, 90, 180, 270];

  for (const scale of scales) {
    for (const rot of rotations) {
      const targetW = Math.max(240, Math.round(width * scale));
      const targetH = Math.max(240, Math.round(height * scale));
      const {w, h} = sizeAfterRotation(targetW, targetH, rot);
      canvasEl.width = w; canvasEl.height = h;

      const ctx2 = canvasEl.getContext('2d', { willReadFrequently: true });
      ctx2.save();
      ctx2.translate(w/2, h/2);
      ctx2.rotate(rot * Math.PI/180);
      ctx2.drawImage(bitmap, -targetW/2, -targetH/2, targetW, targetH);
      ctx2.restore();

      // petit pré-traitement
      preprocessCanvas(ctx2, w, h);

      // 1) BarcodeDetector (quand dispo)
      const bd = await tryBarcodeDetector(canvasEl);
      if (bd) { showPreviewFromCanvas(); console.log('Decoded via', bd.engine); onCodeDetected(bd.text); return; }

      // 2) ZXing avec hints
      const zx = tryZXingFromCanvas(canvasEl);
      if (zx) { showPreviewFromCanvas(); console.log('Decoded via', zx.engine); onCodeDetected(zx.text); return; }

      // 3) jsQR (fallback)
      const jq = tryJsQRFromCanvas(ctx2, w, h);
      if (jq) { showPreviewFromCanvas(); console.log('Decoded via', jq.engine); onCodeDetected(jq.text); return; }
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

      // Sauvegarde des valeurs par défaut choisies
      savePersistentDefaults();

      if (document.getElementById('date_mvt')?.value === todayISO) {
        todayCount += 1; const el = document.getElementById('count-today'); if (el) el.textContent = String(todayCount);
      } else {
        refreshTodayCount();
      }
      resetFormUI(); // reset doux (ne touche pas from/to/type)
    } else {
      setApiMsg(`Erreur API: ${data && data.message ? data.message : 'Inconnue'}`, true);
    }
  } catch (err) {
    console.error(err);
    setApiMsg('Erreur réseau/API. Vérifiez la Web App.', true);
  }
}

/* ---------- Reset doux + relance auto capture ---------- */
function resetFormUI() {
  // Ne PAS réinitialiser from/to/type (ils sont persistés)
  const codeEl = document.getElementById('code');      if (codeEl) codeEl.value = '';
  const typeOtherWrap = document.getElementById('field-type-autre');
  const typeAutre = document.getElementById('type_autre');
  if (typeOtherWrap) typeOtherWrap.hidden = (document.getElementById('type')?.value !== 'Autre');
  if (typeAutre) typeAutre.value = '';
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

/* ---------- Bouton Test (mock) ---------- */
function onTest() {
  const codeEl = document.getElementById('code');
  const fromEl = document.getElementById('from');
  const toEl = document.getElementById('to');
  const typeEl = document.getElementById('type');
  const dateEl = document.getElementById('date_mvt');

  if (codeEl) codeEl.value = 'TEST-QR-123';
  if (fromEl && !fromEl.value) fromEl.value = 'Voie Creuse';
  if (toEl && !toEl.value) toEl.value = 'Bibliothèque';
  if (typeEl && !typeEl.value) { typeEl.value = 'Bureau'; typeEl.dispatchEvent(new Event('change')); }
  if (dateEl) dateEl.value = todayISO;

  setStatus('Champs de test remplis. Appuyez sur “Enregistrer”.');
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
  if (view.getUint16(0, false) !== 0xFFD8) return 1;
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
