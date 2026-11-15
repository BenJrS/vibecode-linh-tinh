// Memory-Graph: pin notes, photos and voice to the place you are standing in.
// Camera is live. Shutter freezes a frame, you tap where to pin, then write or record.
// A "place" is a frame learned by MindAR (image tracking); every memory sits at a point on that frame.

const $ = id => document.getElementById(id);
const TAGS = ['#FFD84D', '#8FE3B8', '#FF9FB2', '#9CCBFF', '#CDBBFF'];
const INK = '#14161F';
const HAND = '"Playpen Sans", "Bradley Hand", cursive';
const UI = '"Be Vietnam Pro", system-ui, sans-serif';
const CARD_W = 0.34;      // tag width in anchor units (1 = width of the learned frame)
const COMPILE_PX = 400;   // long side of the frame MindAR learns: smaller = much faster on phones

/* ---------- storage ---------- */
const db = await new Promise((res, rej) => {
  const r = indexedDB.open('memory-graph-ar', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('places', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const store = (mode, fn) => new Promise((res, rej) => {
  const r = fn(db.transaction('places', mode).objectStore('places'));
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const savePlace = p => store('readwrite', s => s.put(p));
const rawPlaces = () => store('readonly', s => s.getAll());                 // includes tombstones, for sync
const allPlaces = async () => (await rawPlaces()).filter(p => !p.deleted);
const getPlace = id => store('readonly', s => s.get(id));
const dropPlace = id => store('readwrite', s => s.delete(id));
const uuid = () => crypto.randomUUID();

/* ---------- state ---------- */
let places = [];          // { id, name, thumb, mind, memories: [{ id, x, y, text, photo, audio, audioDur, peaks, color, t }] }
let ar = null;            // { m, THREE, entries: [{ place, group, cards }], active, dirty }
let plain = null;         // MediaStream while no place exists yet (no tracking, so no cost)
let mode = 'live';        // live | pick
let shot = null;          // { entry, matrix, w, h, pos, pin }
let dy = 0;               // how far the stage is lifted above the compose sheet
let c = null;             // compose state { color, photo, img, audio, dur, peaks }
let viewing = null;
let busyCamera = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = t => new Date(t).toLocaleDateString('vi-VN', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDur = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const buzz = () => { try { navigator.vibrate?.(12); } catch {} };
const lazy = (() => {   // three + MindAR + tfjs are heavy: only load once a place exists
  let p;
  return () => p ??= Promise.all([import('three'), import('mindar-image-three'), import('mindar-image')])
    .then(([THREE, M, C]) => ({ THREE, MindARThree: M.MindARThree, Compiler: C.Compiler }));
})();

let toastT;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- sheets ---------- */
const sheets = ['compose', 'viewer', 'library', 'intro', 'account', 'friends'];
function openSheet(id) {
  sheets.forEach(s => $(s).classList.toggle('open', s === id));
  $('scrim').classList.toggle('on', id !== 'compose');   // compose keeps the frozen frame clear
}
function closeSheets() {
  stopPlayer();
  sheets.forEach(s => $(s).classList.remove('open'));
  $('scrim').classList.remove('on');
}
$('scrim').onclick = () => { if (!$('intro').classList.contains('open')) closeSheets(); };
addEventListener('keydown', e => { if (e.key === 'Escape' && mode === 'live') closeSheets(); });

/* ---------- status pill + library button ---------- */
function setStatus() {
  const n = ar?.active >= 0 ? ar.entries[ar.active].place.memories.length : 0;
  let text, state;
  if (mode === 'pick') { text = shot?.pos ? 'Chạm chỗ khác nếu muốn đổi vị trí' : 'Chạm vào chỗ muốn ghim'; state = 'pick'; }
  else if (!ar && !plain) { text = 'Đang mở camera'; state = 'scan'; }
  else if (ar?.active >= 0) { text = n ? `Đã nhận ra chỗ này, ${n} ghi chú` : 'Đã nhận ra chỗ này'; state = 'lock'; }
  else if (!places.length) { text = 'Lia tới chỗ muốn ghim rồi bấm chụp'; state = 'idle'; }
  else { text = 'Đang tìm chỗ đã ghim'; state = 'scan'; }
  $('status').textContent = text;
  $('pill').dataset.state = state;
  document.body.dataset.mode = mode;
}
function updateLib() {
  const last = places[places.length - 1];
  $('libImg').hidden = !last;
  $('libEmpty').style.display = last ? 'none' : '';
  if (last) $('libImg').src = last.thumb;
  const total = places.reduce((s, p) => s + p.memories.length, 0);
  $('libCount').hidden = !total;
  $('libCount').textContent = total;
}

/* ---------- tag drawing (shared by the AR cards, the live preview, and nothing else) ---------- */
const mctx = document.createElement('canvas').getContext('2d');
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = s => Math.round(((n >> s) & 255) * f);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
function wrap(g, text, maxW, maxLines) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + w : w;
      if (line && g.measureText(t).width > maxW) { lines.push(line); line = w; } else line = t;
    }
    lines.push(line);
  }
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}
function drawBars(g, peaks, x, y, w, h, color, progress = 0, activeColor = color) {
  const n = peaks.length, step = w / n;
  for (let i = 0; i < n; i++) {
    const bh = Math.max(6, peaks[i] * h);
    g.fillStyle = i / n < progress ? activeColor : color;
    g.beginPath();
    g.roundRect(x + i * step, y + (h - bh) / 2, Math.max(3, step - 4), bh, 3);
    g.fill();
  }
}
// tip: where along the bottom edge the pointer sits (0..1); the canvas bottom edge is the pin point.
function drawTag(cv, mem, img, tip = 0.5, placeholder = false) {
  const W = 512, PAD = 34, IW = W - PAD * 2, POINT = 40;
  const color = mem.color || TAGS[0];
  let text = mem.text || '';
  const ph = placeholder && !text && !mem.photo && !mem.audio;
  if (ph) text = 'Viết gì đó…';
  const size = text.length > 80 ? 34 : text.length > 36 ? 40 : 46;
  mctx.font = `700 ${size}px ${HAND}`;
  const lines = text ? wrap(mctx, text, IW, 6) : [];
  const lh = Math.round(size * 1.28);
  let h = 30 + 54;
  if (mem.photo) h += 350;
  if (lines.length) h += lines.length * lh + 14;
  if (mem.audio) h += 88;
  cv.width = W;
  cv.height = 14 + h + POINT;
  const g = cv.getContext('2d');
  const tipX = 8 + 44 + (W - 16 - 88) * tip;
  const shape = (y, fill) => {
    g.fillStyle = fill;
    g.beginPath(); g.roundRect(8, y, W - 16, h, 32); g.fill();
    g.beginPath(); g.moveTo(tipX - 28, y + h - 2); g.lineTo(tipX + 28, y + h - 2); g.lineTo(tipX, y + h + POINT); g.closePath(); g.fill();
  };
  shape(14, shade(color, 0.78));
  shape(8, color);

  g.textBaseline = 'top';
  let y = 8 + 26;
  if (mem.photo) {
    g.save();
    g.translate(W / 2, y + 160); g.rotate(-0.025);
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect(-IW / 2, -160, IW, 320, 10); g.fill();
    g.save();
    g.beginPath(); g.roundRect(-IW / 2 + 12, -148, IW - 24, 296, 4); g.clip();
    if (img) {
      const s = Math.max((IW - 24) / img.width, 296 / img.height);
      g.drawImage(img, -img.width * s / 2, -img.height * s / 2, img.width * s, img.height * s);
    } else { g.fillStyle = '#D3D9E6'; g.fillRect(-IW / 2, -160, IW, 320); }
    g.restore();
    g.rotate(0.07); g.fillStyle = 'rgba(255,255,255,.62)'; g.fillRect(-62, -178, 124, 36);
    g.restore();
    y += 350;
  }
  if (lines.length) {
    g.font = `700 ${size}px ${HAND}`;
    g.fillStyle = ph ? 'rgba(20,22,31,.35)' : INK;
    lines.forEach((l, i) => g.fillText(l, PAD, y + i * lh));
    y += lines.length * lh + 14;
  }
  if (mem.audio) {
    g.fillStyle = 'rgba(255,255,255,.62)'; g.beginPath(); g.roundRect(PAD, y, IW, 72, 36); g.fill();
    g.fillStyle = INK; g.beginPath(); g.arc(PAD + 36, y + 36, 26, 0, 7); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(PAD + 29, y + 22); g.lineTo(PAD + 29, y + 50); g.lineTo(PAD + 52, y + 36); g.closePath(); g.fill();
    drawBars(g, (mem.peaks || []).slice(0, 24), PAD + 80, y + 16, IW - 80 - 90, 40, INK);
    g.font = `600 26px ${UI}`; g.fillStyle = INK; g.textAlign = 'right';
    g.fillText(fmtDur(mem.audioDur || 0), PAD + IW - 20, y + 22); g.textAlign = 'left';
    y += 88;
  }
  g.font = `400 22px ${UI}`; g.fillStyle = 'rgba(20,22,31,.55)';
  g.fillText(fmtDate(mem.t || Date.now()), PAD, 8 + h - 46);
  return cv;
}

async function loadImage(src) {
  const im = new Image();
  im.src = src;
  await im.decode();
  return im;
}
function toCanvas(src, max) {
  const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
  const s = Math.min(1, max / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * s);
  cv.height = Math.round(h * s);
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return cv;
}

/* ---------- camera ---------- */
const videoEl = () => ar ? ar.m.video : $('cam');
function coverRect(vw, vh) {   // where a vw x vh video lands when it covers the viewport (same rule MindAR uses)
  const W = innerWidth, H = innerHeight, s = Math.max(W / vw, H / vh);
  return { left: (W - vw * s) / 2, top: (H - vh * s) / 2, width: vw * s, height: vh * s };
}
function layoutPlain() {
  const v = $('cam');
  if (!v.videoWidth) return;
  const r = coverRect(v.videoWidth, v.videoHeight);
  Object.assign(v.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}
addEventListener('resize', layoutPlain);

async function stopPlain() {
  plain?.getTracks().forEach(t => t.stop());
  plain = null;
  $('cam').srcObject = null;
  $('cam').hidden = true;
}
function stopAR() {
  if (!ar) return;
  const a = ar;
  ar = null;
  a.m.renderer.setAnimationLoop(null);
  try { a.m.stop(); } catch {}
  a.m.renderer.dispose();
  a.m.renderer.forceContextLoss();
  $('ar').innerHTML = '';
}

// Ask the camera for a small frame: tracking cost grows with pixels, and 640x480 is plenty to recognise a place.
async function withSmallFrames(fn) {
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
  md.getUserMedia = cons => orig(cons.video
    ? { ...cons, video: { ...cons.video, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } } : cons);
  try { return await fn(); } finally { md.getUserMedia = orig; }
}

async function startPlain() {
  plain = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  const v = $('cam');
  v.hidden = false;
  v.srcObject = plain;
  await v.play();
  layoutPlain();
}

async function startAR() {
  const { THREE, MindARThree, Compiler } = await lazy();
  const merged = new Compiler();
  merged.data = places.flatMap(p => new Compiler().importData(p.mind));
  const url = URL.createObjectURL(new Blob([merged.exportData()]));
  const m = new MindARThree({ container: $('ar'), imageTargetSrc: url, maxTrack: 1, uiLoading: 'no', uiScanning: 'no', uiError: 'no' });
  m.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));   // full retina buys nothing under a video feed
  const a = { m, THREE, entries: [], active: -1, dirty: false };
  places.forEach((place, i) => {
    const anchor = m.addAnchor(i);
    const entry = { place, group: anchor.group, cards: [] };
    a.entries.push(entry);
    anchor.onTargetFound = () => { a.active = i; a.dirty = true; setStatus(); };
    anchor.onTargetLost = () => { if (a.active === i) { a.active = -1; a.dirty = true; setStatus(); } };
  });
  ar = a;
  places.forEach((p, i) => p.memories.forEach(mem => addCard(a.entries[i], mem)));
  try {
    await withSmallFrames(() => m.start());
  } catch (e) {
    ar = null; stopAR(); throw e;
  } finally { URL.revokeObjectURL(url); }
  // render only while something is tracked: an idle scene costs the GPU nothing
  m.renderer.setAnimationLoop(() => {
    if (a.active >= 0 || a.dirty) { m.renderer.render(m.scene, m.camera); a.dirty = a.active >= 0; }
  });
}

async function openCamera() {
  if (busyCamera) return;
  busyCamera = true;
  $('gate').hidden = true;
  setStatus();
  try {
    stopAR(); await stopPlain();
    places = await allPlaces();
    updateLib();
    if (places.length) await startAR(); else await startPlain();
    setStatus();
  } catch (e) {
    showGate(e);
  } finally { busyCamera = false; }
}
function showGate(e) {
  const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
  $('gateTitle').textContent = denied ? 'Chưa có quyền dùng camera' : 'Chưa mở được camera';
  $('gateText').textContent = denied
    ? 'Cho phép camera cho trang này trong cài đặt trình duyệt, rồi bấm Thử lại.'
    : 'Đóng các ứng dụng khác đang dùng camera, rồi bấm Thử lại. Trang cần chạy trên https.';
  $('gate').hidden = false;
}
$('gateRetry').onclick = openCamera;
document.addEventListener('visibilitychange', () => {   // phones cut the camera when the app is backgrounded
  if (document.visibilityState !== 'visible' || mode !== 'live') return;
  const s = ar ? ar.m.video.srcObject : plain;
  if (s && s.getTracks().some(t => t.readyState === 'ended')) openCamera();
});

/* ---------- AR cards ---------- */
function addCard(entry, mem) {
  const { THREE } = ar;
  const cv = document.createElement('canvas');
  drawTag(cv, mem);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.center.set(0.5, 0);   // pivot at the pointer tip, so the tip lands on the pinned point
  sprite.scale.set(CARD_W, CARD_W * cv.height / cv.width, 1);
  sprite.position.set(mem.x, mem.y, 0.02);
  sprite.renderOrder = 2;
  sprite.userData.mem = mem;
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0075, 20), new THREE.MeshBasicMaterial({ color: 0x14161f, depthTest: false }));
  dot.position.set(mem.x, mem.y, 0.001);
  dot.renderOrder = 1;
  entry.group.add(dot, sprite);
  entry.cards.push({ sprite, dot });
  ar.dirty = true;
  if (mem.photo) loadImage(mem.photo).then(im => { drawTag(cv, mem, im); tex.needsUpdate = true; if (ar) ar.dirty = true; });
}
function removeCard(entry, mem) {
  const i = entry.cards.findIndex(k => k.sprite.userData.mem === mem);
  if (i < 0) return;
  const [{ sprite, dot }] = entry.cards.splice(i, 1);
  entry.group.remove(sprite, dot);
  sprite.material.map.dispose(); sprite.material.dispose(); dot.geometry.dispose(); dot.material.dispose();
  ar.dirty = true;
}

/* ---------- shutter: freeze a frame, pick a spot ---------- */
function resetCompose() {
  c = { color: TAGS[0], photo: null, img: null, audio: null, dur: 0, peaks: [] };
  $('memText').value = '';
  $('memPhoto').value = '';
  renderSwatches(); renderChips();
  $('micLabel').textContent = 'Ghi âm';
}

function capture() {
  const v = videoEl();
  if (mode !== 'live' || !v?.videoWidth || busyCamera) return;
  closeSheets();
  buzz();
  $('flash').classList.remove('on'); void $('flash').offsetWidth; $('flash').classList.add('on');
  const known = ar && ar.active >= 0 ? ar.entries[ar.active] : null;
  const fz = $('freeze');
  fz.width = v.videoWidth; fz.height = v.videoHeight;
  fz.getContext('2d').drawImage(v, 0, 0);
  const r = coverRect(fz.width, fz.height);
  Object.assign(fz.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  fz.hidden = false;
  $('ar').style.visibility = 'hidden';
  if (ar) ar.m.controller.stopProcessVideo();
  shot = { entry: known, matrix: known ? known.group.matrix.clone() : null, w: fz.width, h: fz.height, pos: null, pin: null };
  mode = 'pick';
  resetCompose();
  setStatus();
}

function leavePick() {
  shot = null; mode = 'live'; dy = 0;
  $('freeze').hidden = $('pin').hidden = $('tagPreview').hidden = true;
  $('stage').style.transform = '';
  $('ar').style.visibility = '';
  closeSheets();
  if (pendingReload) { pendingReload = false; setTimeout(openCamera, 50); }   // a sync finished while pinning
}
function cancelPick() {
  const hadAR = !!ar;
  leavePick();
  if (hadAR) ar.m.controller.processVideo(ar.m.video);
  setStatus();
}

// tap on the stage: open a tag (live) or choose the pin spot (pick)
$('stage').addEventListener('click', e => {
  if (busyCamera) return;
  if (mode === 'live') return tapTag(e);
  pickAt(e.clientX, e.clientY + dy);
});

function tapTag(e) {
  if (!ar || ar.active < 0) return;
  const { THREE } = ar, entry = ar.entries[ar.active];
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), ar.m.camera);
  const hit = ray.intersectObjects(entry.cards.map(k => k.sprite))[0];
  if (hit) openViewer(entry, hit.object.userData.mem);
}

function pickAt(px, py) {
  let pos;
  if (shot.entry) {   // a known place was in view: where the tap meets that place's plane
    const { THREE } = ar;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(px / innerWidth * 2 - 1, -(py / innerHeight) * 2 + 1), ar.m.camera);
    const local = ray.ray.clone().applyMatrix4(shot.matrix.clone().invert());
    const t = -local.origin.z / local.direction.z;
    if (!(t > 0)) return;
    const p = local.at(t, new THREE.Vector3());
    if (Math.abs(p.x) > 3 || Math.abs(p.y) > 3) return toast('Chỗ này quá xa mốc, khó bám theo. Chọn gần hơn.');
    pos = { x: p.x, y: p.y };
  } else {            // the frozen frame is the anchor itself: origin at its centre, 1 unit = its width, y up
    const r = coverRect(shot.w, shot.h);
    const u = (px - r.left) / r.width, v = (py - r.top) / r.height;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    pos = { x: u - 0.5, y: (0.5 - v) * r.height / r.width };
  }
  shot.pos = pos;
  shot.pin = { x: px, y: py };
  Object.assign($('pin').style, { left: px + 'px', top: py + 'px' });
  $('pin').hidden = false;
  buzz();
  openSheet('compose');
  setStatus();
  requestAnimationFrame(() => { liftStage(); updatePreview(); });
}

function liftStage() {   // keep the pin above the compose sheet
  const sh = $('compose').getBoundingClientRect().height;
  dy = Math.min(Math.max(0, shot.pin.y - (innerHeight - sh - 28)), sh);
  $('stage').style.transform = dy ? `translateY(${-dy}px)` : '';
}

/* ---------- compose ---------- */
function renderSwatches() {
  const box = $('swatches');
  box.innerHTML = '';
  TAGS.forEach((col, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', 'Màu ' + (i + 1));
    b.setAttribute('aria-checked', String(col === c.color));
    b.style.background = col;
    b.onclick = () => { c.color = col; renderSwatches(); updatePreview(); };
    box.append(b);
  });
}
function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  const chip = (label, onremove) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label + '  ✕';
    b.onclick = onremove;
    box.append(b);
  };
  if (c.photo) chip('Ảnh đính kèm', () => { c.photo = c.img = null; $('memPhoto').value = ''; renderChips(); updatePreview(); });
  if (c.audio) chip(`Ghi âm ${fmtDur(c.dur)}`, () => { c.audio = null; c.peaks = []; c.dur = 0; $('micLabel').textContent = 'Ghi âm'; renderChips(); updatePreview(); });
}
let previewQueued = false;
function updatePreview() {
  if (previewQueued || !shot?.pin) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    if (!shot?.pin) return;
    const cv = $('tagPreview');
    const w = Math.min(176, innerWidth - 24);
    const left = Math.min(Math.max(shot.pin.x - w / 2, 10), innerWidth - w - 10);
    const tip = Math.min(1, Math.max(0, (shot.pin.x - left) / w));
    drawTag(cv, { text: $('memText').value.trim(), color: c.color, photo: c.photo, audio: c.audio, audioDur: c.dur, peaks: c.peaks, t: Date.now() }, c.img, tip, true);
    const h = w * cv.height / cv.width;
    Object.assign(cv.style, { width: w + 'px', height: h + 'px', left: left + 'px', top: shot.pin.y - h + 'px' });
    cv.hidden = false;
  });
}
$('memText').addEventListener('input', updatePreview);

$('memPhoto').onchange = async () => {
  const file = $('memPhoto').files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    const cv = toCanvas(await loadImage(url), 720);
    c.photo = cv.toDataURL('image/jpeg', 0.8);
    c.img = cv;
    renderChips(); updatePreview();
  } catch { toast('Không đọc được ảnh này. Thử ảnh JPG hoặc PNG.'); }
  URL.revokeObjectURL(url);
};

// voice note: max 60s, stored as a data URL; the level meter samples become the bars shown on the tag
let rec = null;
$('toolMic').onclick = async () => {
  if (rec) return rec.stop();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('Chưa có quyền micro. Cho phép micro cho trang này để ghi âm.'); }
  const chunks = [], t0 = Date.now(), samples = [];
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const an = ac.createAnalyser();
  an.fftSize = 512;
  ac.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const mr = new MediaRecorder(stream);
  rec = mr;
  const tick = setInterval(() => {
    an.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    samples.push(peak / 128);
    const s = Math.floor((Date.now() - t0) / 1000);
    $('micLabel').textContent = `Dừng ${fmtDur(s)}`;
    if (s >= 60) mr.stop();
  }, 100);
  mr.ondataavailable = e => chunks.push(e.data);
  mr.onstop = () => {
    clearInterval(tick);
    stream.getTracks().forEach(t => t.stop());
    ac.close();
    rec = null;
    $('toolMic').classList.remove('rec');
    $('composeSave').disabled = false;
    if (!shot) return;   // sheet was dismissed meanwhile
    c.dur = Math.max(1, Math.floor((Date.now() - t0) / 1000));
    const max = Math.max(0.05, ...samples), bars = 24;
    c.peaks = Array.from({ length: bars }, (_, i) => {
      const a = Math.floor(i * samples.length / bars), b = Math.max(a + 1, Math.floor((i + 1) * samples.length / bars));
      return Math.min(1, Math.max(...samples.slice(a, b), 0) / max);
    });
    $('micLabel').textContent = 'Ghi lại';
    const fr = new FileReader();
    fr.onload = () => { c.audio = fr.result; renderChips(); updatePreview(); };
    fr.readAsDataURL(new Blob(chunks, { type: mr.mimeType }));
  };
  $('composeSave').disabled = true;
  $('toolMic').classList.add('rec');
  $('micLabel').textContent = 'Dừng 0:00';
  mr.start();
};

$('composeCancel').onclick = $('btnCancel').onclick = () => { if (rec) rec.stop(); cancelPick(); };

$('composeSave').onclick = async () => {
  const text = $('memText').value.trim();
  if (!text && !c.photo && !c.audio) return toast('Viết gì đó, thêm ảnh hoặc ghi âm trước khi ghim.');
  const s = shot;
  const mem = { id: uuid(), x: s.pos.x, y: s.pos.y, text, photo: c.photo, audio: c.audio, audioDur: c.dur, peaks: c.peaks, color: c.color, t: Date.now(), up: false };
  if (s.entry) {   // joins a place that is already known
    const fresh = (await getPlace(s.entry.place.id)) || s.entry.place;   // sync may have added memories since this place was loaded
    fresh.memories.push(mem);
    await savePlace(fresh);
    if (fresh !== s.entry.place) s.entry.place.memories.push(mem);
    addCard(s.entry, mem);
    cancelPick();
    updateLib();
    scheduleSync();
    return toast('Đã ghim');
  }
  // brand-new place: learn this frame, then restart the camera with it as a target
  const frame = toCanvas($('freeze'), COMPILE_PX);
  closeSheets();
  showBusy(true);
  try {
    stopAR(); await stopPlain();
    const { Compiler } = await lazy();
    const mind = await compileFrame(Compiler, frame, p => $('busyBar').style.width = p + '%');
    const name = 'Chỗ ' + new Date().toLocaleString('vi-VN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    await savePlace({ id: uuid(), name, thumb: frame.toDataURL('image/jpeg', 0.6), mind, memories: [mem], dirty: true, mindUp: false });
    try { navigator.storage?.persist?.(); } catch {}
    leavePick();
    await openCamera();
    scheduleSync();
    toast('Đã ghim');
  } catch {
    leavePick();
    await openCamera();
    toast('Không ghi nhớ được chỗ này. Thử chụp chỗ có nhiều chi tiết hơn.');
  }
  showBusy(false);
};

async function compileFrame(Compiler, frame, onProgress) {
  for (let i = 0; ; i++) {
    try {
      const comp = new Compiler();
      await comp.compileImageTargets([frame], onProgress);
      return comp.exportData();
    } catch (e) { if (i) throw e; await sleep(400); }
  }
}
function showBusy(on) {
  $('busy').hidden = !on;
  $('busyBar').style.width = '0';
}

/* ---------- viewer + voice player ---------- */
let audio = null;
function stopPlayer() {
  if (audio) { audio.pause(); audio = null; }
  $('playIcon').setAttribute('d', 'M8 5.5v13l11-6.5z');
}
function drawPlayer(progress = 0) {
  const cv = $('playWave'), g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  drawBars(g, viewing.mem.peaks || [], 0, 0, cv.width, cv.height, '#C3C9D8', progress, INK);
}
function openViewer(entry, mem) {
  viewing = { entry, mem };
  $('viewPhoto').hidden = !mem.photo;
  if (mem.photo) $('viewPhoto').src = mem.photo;
  $('viewText').textContent = mem.text;
  $('viewText').hidden = !mem.text;
  $('viewAudio').hidden = !mem.audio;
  if (mem.audio) { $('playTime').textContent = fmtDur(mem.audioDur || 0); drawPlayer(0); }
  $('viewDate').textContent = fmtDate(mem.t);
  const del = $('viewDelete');
  del.textContent = 'Xóa';
  del.dataset.sure = '';
  openSheet('viewer');
}
$('playBtn').onclick = () => {
  if (audio) return stopPlayer();
  const mem = viewing.mem;
  audio = new Audio(mem.audio);
  $('playIcon').setAttribute('d', 'M7 5h4v14H7zM13 5h4v14h-4z');
  audio.ontimeupdate = () => {
    drawPlayer(audio.currentTime / (audio.duration || mem.audioDur || 1));
    $('playTime').textContent = fmtDur(Math.floor(audio.currentTime));
  };
  audio.onended = () => { stopPlayer(); drawPlayer(0); $('playTime').textContent = fmtDur(mem.audioDur || 0); };
  audio.play().catch(() => { stopPlayer(); toast('Không phát được ghi âm này.'); });
};
$('viewClose').onclick = closeSheets;
$('viewDelete').onclick = async () => {
  const del = $('viewDelete');
  if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = 'Bấm lại để xóa'; return; }
  const { entry, mem } = viewing;
  const p = (await getPlace(entry.place.id)) || entry.place;
  p.memories = p.memories.filter(m => m.id !== mem.id);
  if (mem.up) p.tomb = [...(p.tomb || []), { id: mem.id }];   // already in the cloud: tell it
  await savePlace(p);
  entry.place.memories = entry.place.memories.filter(m => m.id !== mem.id);
  removeCard(entry, mem);
  closeSheets(); updateLib(); setStatus();
  scheduleSync();
  toast('Đã xóa');
};

/* ---------- library, backup ---------- */
function renderLibrary() {
  const ul = $('places');
  ul.innerHTML = '';
  for (const p of places) {
    const li = document.createElement('li');
    li.innerHTML = '<img alt=""><div class="info"><input maxlength="40" aria-label="Tên chỗ"><div class="count"></div></div><button class="del">Xóa</button>';
    li.querySelector('img').src = p.thumb;
    const input = li.querySelector('input');
    input.value = p.name;
    input.onchange = async () => { p.name = input.value.trim() || p.name; input.value = p.name; p.dirty = true; await savePlace(p); scheduleSync(); };
    li.querySelector('.count').textContent = p.memories.length + ' ghi chú';
    const del = li.querySelector('.del');
    del.onclick = async () => {
      if (!del.classList.contains('sure')) { del.classList.add('sure'); del.textContent = 'Xóa thật?'; return; }
      if (p.mindUp) await savePlace({ ...p, deleted: true });   // tombstone until the cloud copy is removed
      else await dropPlace(p.id);                               // never left this device
      closeSheets();
      toast('Đã xóa chỗ này');
      openCamera();
      scheduleSync();
    };
    ul.append(li);
  }
  $('libEmptyState').hidden = places.length > 0;
  $('btnExport').disabled = !places.length;
}
$('btnLib').onclick = () => { renderLibrary(); openSheet('library'); };
$('libClose').onclick = $('libStart').onclick = closeSheets;

const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
$('btnExport').onclick = () => {
  const data = { app: 'memory-graph', v: 1, places: places.map(p => ({ ...p, mind: b64(new Uint8Array(p.mind)) })) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `memory-graph-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Đã tạo file sao lưu');
};
$('importFile').onchange = async () => {
  const f = $('importFile').files[0];
  $('importFile').value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'memory-graph' || !Array.isArray(data.places)) throw 0;
    for (const p of data.places) await savePlace(freshIds({ ...p, mind: unb64(p.mind) }));
    closeSheets();
    toast(`Đã khôi phục ${data.places.length} chỗ`);
    openCamera();
    scheduleSync();
  } catch { toast('File này không phải bản sao lưu của Memory-Graph.'); }
};

/* ---------- ids, account, sync ---------- */
const isUuid = s => typeof s === 'string' && /^[0-9a-f-]{36}$/.test(s);
function freshIds(p) {   // older builds used numeric ids; the cloud needs uuids. Also used for restored backups.
  if (!isUuid(p.id)) p.id = uuid();
  p.memories = (p.memories || []).map(m => ({ ...m, id: isUuid(m.id) ? m.id : uuid(), up: false }));
  Object.assign(p, { dirty: true, mindUp: false, tomb: [] });
  delete p.deleted;
  return p;
}
async function migrateIds() {
  for (const p of await rawPlaces()) {
    if (isUuid(p.id) && (p.memories || []).every(m => isUuid(m.id))) continue;
    const old = p.id;
    await savePlace(freshIds(p));
    if (old !== p.id) await dropPlace(old);
  }
}

let session = null, syncT = 0, syncing = false, syncAgain = false, pendingReload = false;
let syncInfo = { state: 'idle', at: 0, msg: '' };
const sinceKey = () => `mg-since-${session.user.id}`;
const store_ = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: k => { try { localStorage.removeItem(k); } catch {} } };

function scheduleSync(delay = 1500) {
  if (!session) return;
  clearTimeout(syncT);
  syncT = setTimeout(doSync, delay);
}
function explain(e) {
  const m = `${e?.code || ''} ${e?.message || e}`;
  if (/PGRST205|schema cache|does not exist/i.test(m)) return 'Máy chủ chưa được thiết lập: thiếu bảng dữ liệu.';
  if (/row-level security|42501/i.test(m)) return 'Máy chủ từ chối quyền ghi. Kiểm tra quy tắc bảo mật.';
  if (/Bucket not found/i.test(m)) return 'Máy chủ chưa được thiết lập: thiếu kho lưu file.';
  return 'Chưa đồng bộ được. Sẽ thử lại khi có mạng.';
}
async function doSync() {
  if (!session) return false;
  if (!navigator.onLine) { syncInfo = { state: 'offline', at: syncInfo.at, msg: '' }; renderSync(); return false; }
  if (mode !== 'live' || busyCamera) { scheduleSync(4000); return false; }   // never swap data under an open pin
  if (syncing) { syncAgain = true; return false; }
  syncing = true;
  syncInfo = { ...syncInfo, state: 'syncing' }; renderSync();
  let ok = false;
  try {
    const [{ runSync }, cloud] = await Promise.all([import('./sync.js'), import('./cloud.js')]);
    const key = sinceKey();
    const changed = await runSync({
      remote: await cloud.remote(), uid: session.user.id,
      local: { raw: rawPlaces, put: savePlace, remove: dropPlace, getSince: () => store_.get(key), setSince: v => store_.set(key, v) },
    });
    ok = true;
    syncInfo = { state: 'ok', at: Date.now(), msg: '' };
    if (changed) { if (mode === 'live') { await openCamera(); updateLib(); } else pendingReload = true; }
  } catch (e) {
    console.warn('sync failed', e);
    syncInfo = { state: 'err', at: syncInfo.at, msg: explain(e) };
  } finally {
    syncing = false;
    renderSync();
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
  return ok;
}
addEventListener('online', () => scheduleSync(300));
addEventListener('offline', () => { if (session) { syncInfo = { ...syncInfo, state: 'offline' }; renderSync(); } });

function renderSync() {
  const t = new Date(syncInfo.at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  $('syncState').textContent = { idle: 'Chưa đồng bộ.', syncing: 'Đang đồng bộ…', ok: `Đã đồng bộ lúc ${t}.`,
    offline: 'Đang offline. Sẽ đồng bộ khi có mạng.', err: syncInfo.msg }[syncInfo.state];
  $('acctDot').dataset.state = syncInfo.state;
}
function renderAccount() {
  $('acctOut').hidden = !!session;
  $('acctIn').hidden = !session;
  $('acctDot').hidden = !session;
  if (session) { $('acctMail').textContent = session.user.email; renderSync(); }
  else if (!$('acctOut').dataset.keep) { $('stepEmail').hidden = false; $('stepCode').hidden = true; }
  const b = $('acctOutBtn');
  b.dataset.sure = ''; b.textContent = 'Đăng xuất';
}
async function initAccount() {
  try {
    const cloud = await import('./cloud.js');
    session = await cloud.getSession();
    renderAccount();
    cloud.onAuthChange(s => { const was = session; session = s; friendsCtl = null; renderAccount(); if (s && !was) { scheduleSync(300); checkPendingAdd(); } });
    if (session) scheduleSync(2500);
    checkPendingAdd();
  } catch { /* offline on first load: stay local-only */ }
}

$('btnAccount').onclick = () => { $('acctHint').hidden = !store_.get('mg-add'); renderAccount(); openSheet('account'); if (session) refreshFriendsBadge(); };
$('acctClose').onclick = closeSheets;
let codeEmail = '';
$('acctSend').onclick = async () => {
  const email = $('acctEmail').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Nhập đúng địa chỉ email, ví dụ ten@gmail.com.');
  const b = $('acctSend');
  b.disabled = true;
  try {
    await (await import('./cloud.js')).sendCode(email);
    codeEmail = email;
    $('codeHint').textContent = `Đã gửi mã tới ${email}. Nếu chưa thấy, kiểm tra thư rác.`;
    $('stepEmail').hidden = true; $('stepCode').hidden = false;
    $('acctOut').dataset.keep = '1';
    $('acctCode').value = ''; $('acctCode').focus();
  } catch (e) {
    toast(e?.status === 429 || /rate|seconds/i.test(e?.message || '') ? 'Gửi mã quá nhanh. Đợi một phút rồi thử lại.' : 'Không gửi được mã. Kiểm tra email và mạng rồi thử lại.');
  }
  b.disabled = false;
};
$('acctBack').onclick = () => { delete $('acctOut').dataset.keep; $('stepEmail').hidden = false; $('stepCode').hidden = true; };
$('acctVerify').onclick = async () => {
  const token = $('acctCode').value.replace(/\D/g, '');
  if (token.length < 6) return toast('Nhập mã trong email (6 số trở lên).');
  const b = $('acctVerify');
  b.disabled = true;
  try {
    session = await (await import('./cloud.js')).verifyCode(codeEmail, token);
    delete $('acctOut').dataset.keep;
    friendsCtl = null;
    renderAccount(); closeSheets();
    toast('Đã đăng nhập');
    scheduleSync(300);
    checkPendingAdd();
  } catch { toast('Mã sai hoặc đã hết hạn. Bấm Đổi email để nhận mã mới.'); }
  b.disabled = false;
};
$('acctSync').onclick = async () => { clearTimeout(syncT); await doSync(); };
$('acctOutBtn').onclick = async () => {
  const b = $('acctOutBtn');
  if (!b.dataset.sure) {
    b.disabled = true; b.textContent = 'Đang lưu lên máy chủ…';
    clearTimeout(syncT);
    const saved = await doSync();
    b.disabled = false;
    if (!saved) {   // do not silently throw away notes that never reached the cloud
      b.dataset.sure = '1';
      b.textContent = 'Chưa lưu hết. Bấm lại để đăng xuất và xóa';
      return;
    }
  }
  try { await (await import('./cloud.js')).signOut(); } catch {}
  for (const p of await rawPlaces()) await dropPlace(p.id);   // the account's data stays in the cloud; this device starts clean
  store_.del(sinceKey());
  session = null; friendsCtl = null; syncInfo = { state: 'idle', at: 0, msg: '' };
  renderAccount(); closeSheets();
  await openCamera();
  toast('Đã đăng xuất');
};

/* ---------- friends ---------- */
let friendsCtl = null;
const appLink = code => `${location.origin}${location.pathname.replace(/index\.html$/, '')}?add=${code}`;
async function ensureFriends() {
  if (!session) return null;
  if (!friendsCtl) {
    const [{ createFriends }, cloud] = await Promise.all([import('./friends.js'), import('./cloud.js')]);
    friendsCtl = createFriends({ api: await cloud.friendsApi(session.user.id), ui: { toast, appLink }, root: $('frBody') });
  }
  return friendsCtl;
}
async function openFriends() {
  try {
    const f = await ensureFriends();
    await f.load();
    openSheet('friends');
  } catch (e) { toast(navigator.onLine ? 'Không mở được danh sách bạn bè. Thử lại sau.' : 'Không có mạng. Thử lại khi có kết nối.'); }
}
async function refreshFriendsBadge() {
  try {
    const f = await ensureFriends();
    await f.load();
    const n = f.incomingCount();
    $('acctFriends').textContent = n ? `Bạn bè (${n} lời mời)` : 'Bạn bè';
  } catch { /* badge is optional */ }
}
// someone opened an invite link (?add=code): never send anything without asking
async function checkPendingAdd() {
  const code = store_.get('mg-add');
  if (!code || $('intro').classList.contains('open')) return;
  if (!session) { $('acctHint').hidden = false; renderAccount(); openSheet('account'); return; }
  try {
    const f = await ensureFriends();
    store_.del('mg-add');
    await f.offerFor(code);
    await f.load();
    openSheet('friends');
  } catch { toast('Không mở được lời mời kết bạn. Thử lại sau.'); }
}
$('acctFriends').onclick = openFriends;
$('frClose').onclick = closeSheets;
{
  const code = new URLSearchParams(location.search).get('add');
  if (/^[0-9a-f]{8}$/.test(code || '')) store_.set('mg-add', code);
  if (code !== null) history.replaceState(null, '', location.pathname);
}

/* ---------- intro + boot ---------- */
$('btnHelp').onclick = () => openSheet('intro');
$('introGo').onclick = () => {
  const first = !(ar || plain);
  closeSheets();
  try { localStorage.setItem('mg-seen', '1'); } catch {}
  if (first) openCamera();
  checkPendingAdd();
};
$('shutter').onclick = capture;

try { navigator.serviceWorker?.register('sw.js'); } catch {}
await Promise.all([
  document.fonts.load(`700 40px ${HAND}`, 'Viết ắẳằẵặ'), document.fonts.load(`400 22px ${UI}`, 'ắẳằ'), document.fonts.load(`600 26px ${UI}`, '0123'),
]).catch(() => {});
await migrateIds();
places = await allPlaces();
updateLib();
setStatus();
let seen = false;
try { seen = !!localStorage.getItem('mg-seen'); } catch {}
if (seen) openCamera(); else openSheet('intro');
initAccount();
