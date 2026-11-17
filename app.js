/* Tower Patrol: record patrol paths + tower points, then navigate to any tower along recorded paths. Offline-first. */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const r6 = x => Math.round(x * 1e6) / 1e6;

/* ---------------- storage (IndexedDB key/value) ---------------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('tower-patrol', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const get = async k => { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
  const set = async (k, v) => { const db = await open(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); };
  const del = async k => { const db = await open(); return new Promise((res) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = () => res(); }); };
  return { get, set, del };
})();

const S = {
  towers: [],     // {id,name,line,lat,lon,acc,note,created,demo?}
  tracks: [],     // {id,name,line,created,segments:[[[lat,lon,t,acc],...]],dist,demo?}
  settings: { layer: 'osm', lastLine: '', maxAcc: 35 },
  rec: null,      // in-progress recording
  pos: null, fixes: [],
  heading: null, headingT: 0,
  nav: null, follow: true, graph: null,
};

async function saveTowers() { await DB.set('towers', S.towers); S.graph = null; }
async function saveTracks() { await DB.set('tracks', S.tracks); S.graph = null; }
async function saveSettings() { await DB.set('settings', S.settings); }

/* ---------------- geo helpers ---------------- */
const R = 6371008.8, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function dist(a, b) { // a,b: [lat,lon] or {lat,lon}
  const la1 = a.lat ?? a[0], lo1 = a.lon ?? a[1], la2 = b.lat ?? b[0], lo2 = b.lon ?? b[1];
  const dLa = rad(la2 - la1), dLo = rad(lo2 - lo1);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearing(a, b) {
  const la1 = rad(a.lat ?? a[0]), la2 = rad(b.lat ?? b[0]), dLo = rad((b.lon ?? b[1]) - (a.lon ?? a[1]));
  const y = Math.sin(dLo) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const DIRS = ['ઉત્તર (N)', 'ઉત્તર-પૂર્વ (NE)', 'પૂર્વ (E)', 'દક્ષિણ-પૂર્વ (SE)', 'દક્ષિણ (S)', 'દક્ષિણ-પશ્ચિમ (SW)', 'પશ્ચિમ (W)', 'ઉત્તર-પશ્ચિમ (NW)'];
const TYPES = { suspension: 'Suspension (સસ્પેન્શન - સીધો)', tension: 'Tension (ટેન્શન - ખૂણાનો)', deadend: 'Dead End (ડેડ એન્ડ)', gantry: 'Gantry / Substation (સબસ્ટેશન)' };
const TSHORT = { suspension: 'સસ્પેન્શન', tension: 'ટેન્શન', deadend: 'ડેડ એન્ડ', gantry: 'સબસ્ટેશન' };
function typeKey(v) { v = String(v || '').toLowerCase(); if (TYPES[v]) return v; if (/tens|ટેન્શન|angle|ખૂણ/.test(v)) return 'tension'; if (/dead|ડેડ/.test(v)) return 'deadend'; if (/gant|sub|સબ/.test(v)) return 'gantry'; if (/susp|સસ્પ/.test(v)) return 'suspension'; return ''; }
const dirName = b => DIRS[Math.round(b / 45) % 8];
function fmtDist(m) {
  if (!isFinite(m)) return '—';
  if (m < 1000) return Math.round(m) + ' મી';
  return (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' કિમી';
}
function fmtTime(sec) { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); }
const natCmp = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
function trackLen(segs) { let d = 0; for (const s of segs) for (let i = 1; i < s.length; i++) d += dist(s[i - 1], s[i]); return d; }

/* ---------------- toast / banner ---------------- */
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
function banner(html) { const b = $('#banner'); if (!html) { b.hidden = true; b.innerHTML = ''; return b; } b.innerHTML = html; b.hidden = false; return b; }

/* tap-twice confirmation (no browser confirm()) */
function confirmBtn(btn, label, fn) {
  if (btn.dataset.armed) { delete btn.dataset.armed; fn(); return; }
  const old = btn.textContent; btn.dataset.armed = '1'; btn.textContent = label;
  setTimeout(() => { if (btn.isConnected && btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = old; } }, 3500);
}

/* ---------------- map ---------------- */
const TILES = {
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attr: '© OpenStreetMap' },
  sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', max: 19, maxNative: 18, attr: 'Imagery © Esri' },
};
/* tiles are kept in the Cache API as they are seen, so the map also shows offline (works in browser and in the APK) */
const TILE_CACHE = 'tp-tiles-v2';
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
async function cachedTileBlob(url) {
  if (!('caches' in window)) return null;
  const c = await caches.open(TILE_CACHE);
  let res = await c.match(url);
  if (res && res.type === 'opaque') res = null;
  if (!res) {
    res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('tile ' + res.status);
    await c.put(url, res.clone());
  }
  return res.blob();
}
const CachedTiles = L.TileLayer.extend({
  createTile(coords, done) {
    const img = document.createElement('img');
    img.alt = ''; img.setAttribute('role', 'presentation');
    const url = this.getTileUrl(coords);
    img.onload = () => { if (img.dataset.blob) URL.revokeObjectURL(img.src); done(null, img); };
    img.onerror = e => done(e, img);
    cachedTileBlob(url).then(b => { if (!b) throw 0; img.dataset.blob = '1'; img.src = URL.createObjectURL(b); })
      .catch(() => { img.src = url; });   // CORS blocked or offline: plain load (browser cache may still have it)
    return img;
  }
});
const map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 20 }).setView([22.6, 71.8], 7);
map.attributionControl.setPrefix(false);
let baseLayer;
function setLayer(k) {
  if (baseLayer) map.removeLayer(baseLayer);
  const t = TILES[k];
  baseLayer = new CachedTiles(t.url, { maxZoom: 20, maxNativeZoom: t.maxNative || 19, attribution: t.attr }).addTo(map);
  $('#btn-layer').textContent = k === 'osm' ? 'સેટેલાઇટ' : 'નકશો';
  S.settings.layer = k;
}
const tracksLayer = L.layerGroup().addTo(map);
const towersLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const recLine = L.polyline([], { color: '#E53935', weight: 5, opacity: .9 }).addTo(map);
let meMarker, meAcc;

const PYLON = '<svg viewBox="0 0 24 24"><path d="M12 2 7 22M12 2l5 20M8.6 15h6.8M9.6 10.5h4.8M10.6 6h2.8M4 6h16M5 10.5h14M8.6 15l5.8 7M15.4 15l-5.8 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
function towerIcon(t, target) {
  return L.divIcon({ className: 'tw-ic', iconSize: [0, 0], html: `<div class="tw${target ? ' target' : ''}${t.type ? ' t-' + t.type : ''}"><span>${esc(t.name)}</span>${PYLON}</div>` });
}
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function drawTracks() {
  tracksLayer.clearLayers();
  const col = cssVar('--track') || '#FF6A00';
  for (const tr of S.tracks) for (const seg of tr.segments) {
    if (seg.length < 2) continue;
    L.polyline(seg.map(p => [p[0], p[1]]), { color: col, weight: 4, opacity: .85, dashArray: tr.demo ? '6 6' : null })
      .bindTooltip(esc(tr.name || tr.line || 'રસ્તો'), { sticky: true }).addTo(tracksLayer);
  }
}
function drawTowers() {
  towersLayer.clearLayers();
  const tgt = S.nav && S.nav.tower.id;
  for (const t of S.towers) {
    L.marker([t.lat, t.lon], { icon: towerIcon(t, t.id === tgt), zIndexOffset: t.id === tgt ? 1000 : 0 })
      .on('click', () => openDetail(t.id)).addTo(towersLayer);
  }
}
function fitAll() {
  const pts = [...S.towers.map(t => [t.lat, t.lon])];
  for (const tr of S.tracks) for (const s of tr.segments) for (let i = 0; i < s.length; i += 10) pts.push([s[i][0], s[i][1]]);
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(.15), { maxZoom: 17 });
}

function updateMe() {
  const p = S.pos; if (!p) return;
  const ll = [p.lat, p.lon];
  if (!meMarker) {
    meAcc = L.circle(ll, { radius: p.acc, color: '#1E88E5', weight: 1, fillOpacity: .12, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', iconSize: [18, 18], html: '<div class="me-wrap"><div class="me-cone" hidden></div><div class="me-dot"></div></div>' }), zIndexOffset: 2000, interactive: false }).addTo(map);
    if (!S.towers.length && !S.tracks.length) map.setView(ll, 16);
  } else { meMarker.setLatLng(ll); meAcc.setLatLng(ll).setRadius(p.acc); }
  updateCone();
  if (S.follow && (S.rec || S.nav)) map.panTo(ll, { animate: true });
}
function curHeading() {
  if (S.heading != null && Date.now() - S.headingT < 3000) return S.heading;
  if (S.pos && S.pos.course != null && !isNaN(S.pos.course) && (S.pos.speed || 0) > 0.8) return S.pos.course;
  return null;
}
function updateCone() {
  const el = meMarker && meMarker.getElement(); if (!el) return;
  const cone = el.querySelector('.me-cone'), h = curHeading();
  cone.hidden = h == null; if (h != null) cone.style.transform = `rotate(${h}deg)`;
}

/* ---------------- GPS ---------------- */
function gpsChip() {
  const c = $('#gps-chip'), p = S.pos; c.classList.remove('good', 'mid', 'bad');
  if (!p) return;
  const a = Math.round(p.acc);
  c.classList.add(a <= 12 ? 'good' : a <= S.settings.maxAcc ? 'mid' : 'bad');
  $('#gps-text').textContent = `GPS ±${a} મી`;
  if (S.rec) $('#st-acc').textContent = `±${a}`;
}
function startGPS() {
  if (!('geolocation' in navigator)) { banner('આ બ્રાઉઝરમાં GPS ઉપલબ્ધ નથી. Chrome માં ખોલો.'); return; }
  navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
}
function onPos(g) {
  const c = g.coords;
  S.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: g.timestamp || Date.now(), speed: c.speed, course: c.heading };
  S.fixes.push(S.pos); if (S.fixes.length > 12) S.fixes.shift();
  if ($('#banner').dataset.kind === 'gps') { banner(null); delete $('#banner').dataset.kind; }
  gpsChip(); updateMe();
  if (S.rec && !S.rec.paused) addRecPoint(S.pos);
  if (S.nav) updateNav();
  if (!$('#tab-towers').hidden) throttledList();
}
function onPosErr(e) {
  if (e.code === 1) {
    banner('<b>લોકેશનની પરવાનગી નથી.</b><br>Chrome માં ઉપર સરનામા પાસે 🔒 દબાવો → Location → Allow. પછી પેજ ફરી ખોલો. ફોનનું Location (GPS) પણ ચાલુ રાખો.').dataset.kind = 'gps';
  } else $('#gps-text').textContent = 'GPS સિગ્નલ નથી';
}
function bestFix() {
  const now = Date.now(), recent = S.fixes.filter(f => now - f.t < 20000);
  if (!recent.length) return S.pos;
  const best = Math.min(...recent.map(f => f.acc));
  const use = recent.filter(f => f.acc <= best * 1.6 + 2);
  let w = 0, la = 0, lo = 0;
  for (const f of use) { const k = 1 / (f.acc * f.acc); w += k; la += f.lat * k; lo += f.lon * k; }
  return { lat: la / w, lon: lo / w, acc: best };
}

/* compass */
function startCompass() {
  const h = e => {
    let hd = null;
    if (e.webkitCompassHeading != null) hd = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) hd = 360 - e.alpha;
    if (hd == null) return;
    const so = (screen.orientation && screen.orientation.angle) || 0;
    S.heading = (hd + so + 360) % 360; S.headingT = Date.now();
    scheduleArrow();
  };
  if ('ondeviceorientationabsolute' in window) addEventListener('deviceorientationabsolute', h);
  else addEventListener('deviceorientation', h);
}
async function askCompassPermission() {
  try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission(); } catch (_) {}
}
let arrowRAF = 0;
function scheduleArrow() { if (!arrowRAF) arrowRAF = requestAnimationFrame(() => { arrowRAF = 0; updateCone(); if (S.nav) drawArrow(); }); }

/* wake lock */
let wake = null;
async function keepAwake(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    if (!on && wake) { await wake.release(); wake = null; }
  } catch (_) { wake = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (S.rec || S.nav)) keepAwake(true); });

/* ---------------- recording ---------------- */
let recTimer, recSaveT;
function lineNames() { return [...new Set([...S.towers.map(t => t.line), ...S.tracks.map(t => t.line)].filter(Boolean))].sort(natCmp); }
function fillLineList() { $('#line-list').innerHTML = lineNames().map(n => `<option value="${esc(n)}">`).join(''); }

async function startRec(resume) {
  if (!resume) {
    const line = $('#in-line').value.trim();
    S.settings.lastLine = line; saveSettings();
    S.rec = { id: uid(), line, name: (line || 'પેટ્રોલિંગ') + ' ' + new Date().toLocaleDateString('en-GB'), started: Date.now(), activeMs: 0, lastResume: Date.now(), segments: [[]], dist: 0, paused: false, towers: 0 };
  } else { S.rec.paused = false; S.rec.lastResume = Date.now(); S.rec.segments.push([]); }
  await keepAwake(true);
  recUI(); persistRec();
  clearInterval(recTimer); recTimer = setInterval(recTick, 1000);
  if (S.pos) addRecPoint(S.pos);
  S.follow = true; $('#btn-locate').classList.add('on');
  if (S.pos) map.setView([S.pos.lat, S.pos.lon], Math.max(map.getZoom(), 17));
}
function recElapsed() { const r = S.rec; return (r.activeMs + (r.paused ? 0 : Date.now() - r.lastResume)) / 1000; }
function recTick() { if (!S.rec) return; $('#st-time').textContent = fmtTime(recElapsed()); }
function addRecPoint(p) {
  const r = S.rec;
  if (p.acc > S.settings.maxAcc) return;
  const seg = r.segments[r.segments.length - 1];
  const pt = [r6(p.lat), r6(p.lon), Math.round(p.t / 1000), Math.round(p.acc)];
  const last = seg[seg.length - 1];
  if (last) {
    const d = dist(last, pt), dt = Math.max(1, pt[2] - last[2]);
    if (d < Math.max(5, Math.min(p.acc * 0.5, 15))) return;
    if (d / dt > 45) return;                                  // GPS jump
    if (dt > 120 && d > 100) { r.segments.push([pt]); }        // long gap: start new piece, don't draw straight line
    else { seg.push(pt); r.dist += d; }
  } else seg.push(pt);
  drawRec();
  $('#st-dist').textContent = fmtDist(r.dist);
  clearTimeout(recSaveT); recSaveT = setTimeout(persistRec, 8000);
}
function drawRec() { recLine.setLatLngs(S.rec ? S.rec.segments.filter(s => s.length).map(s => s.map(p => [p[0], p[1]])) : []); }
function persistRec() { if (S.rec) DB.set('rec', S.rec).catch(() => {}); }
function pauseRec() {
  const r = S.rec; if (!r) return;
  if (r.paused) { startRec(true); return; }
  r.activeMs += Date.now() - r.lastResume; r.paused = true; persistRec(); recUI();
}
async function stopRec() {
  const r = S.rec; if (!r) return;
  if (!r.paused) r.activeMs += Date.now() - r.lastResume;
  const segs = r.segments.filter(s => s.length >= 2);
  clearInterval(recTimer); S.rec = null; drawRec(); await DB.del('rec'); keepAwake(!!S.nav);
  if (segs.length) {
    S.tracks.push({ id: r.id, name: r.name, line: r.line, created: r.started, segments: segs, dist: trackLen(segs), duration: Math.round(r.activeMs / 1000) });
    await saveTracks(); drawTracks(); renderTracks();
    toast(`રસ્તો સચવાયો: ${fmtDist(trackLen(segs))}`);
  } else toast('રસ્તો બહુ ટૂંકો હતો, સાચવ્યો નથી');
  recUI(); fillLineList();
}
function recUI() {
  const r = S.rec;
  $('#patrol-idle').hidden = !!r; $('#patrol-rec').hidden = !r;
  if (!r) return;
  $('#patrol-rec').classList.toggle('paused', r.paused);
  $('#rec-title').textContent = r.paused ? 'થોભાવેલું' : 'રેકોર્ડિંગ ચાલુ';
  $('#rec-line').textContent = r.line ? '· ' + r.line : '';
  $('#btn-pause').textContent = r.paused ? '▶ ફરી ચાલુ' : '⏸ થોભો';
  $('#st-dist').textContent = fmtDist(r.dist); $('#st-towers').textContent = r.towers; recTick();
}

/* ---------------- towers ---------------- */
let editId = null;
function nextTowerName(line) {
  const same = S.towers.filter(t => (t.line || '') === (line || '')).sort((a, b) => b.created - a.created);
  const last = same[0]; if (!last) return '';
  const m = String(last.name).match(/^(.*?)(\d+)(\D*)$/);
  return m ? m[1] + (parseInt(m[2], 10) + 1) + m[3] : '';
}
function openTowerForm(opts) {
  editId = opts.id || null;
  const t = editId ? S.towers.find(x => x.id === editId) : null;
  const line = t ? t.line : (S.rec ? S.rec.line : ($('#in-line').value.trim() || S.settings.lastLine));
  $('#dt-title').textContent = t ? 'ટાવર સુધારો' : 'નવું ટાવર લોકેશન સેવ કરો';
  const ty = t ? (t.type || 'suspension') : 'suspension';
  $$('input[name=f-type]').forEach(r => r.checked = r.value === ty);
  $('#f-name').value = t ? t.name : nextTowerName(line);
  $('#f-line').value = line || '';
  $('#f-note').value = t ? (t.note || '') : '';
  const lat = t ? t.lat : opts.lat, lon = t ? t.lon : opts.lon;
  $('#f-lat').value = lat != null ? r6(lat) : ''; $('#f-lon').value = lon != null ? r6(lon) : ''; showLL();
  $('#f-acc').textContent = opts.acc ? `GPS ચોકસાઈ ±${Math.round(opts.acc)} મીટર` + (opts.acc > 20 ? ' (થોડી વાર ઊભા રહો તો ચોકસાઈ વધશે)' : '') : (opts.manual ? 'નકશા પરથી પસંદ કરેલી જગ્યા' : '');
  $('#dlg-tower').dataset.acc = opts.acc || '';
  $('#dlg-tower').showModal();
  setTitle();
  setTimeout(() => $('#f-name').focus(), 50);
}
function addTowerHere() {
  const f = bestFix();
  if (!f) { toast('GPS લોકેશન હજુ મળ્યું નથી. ખુલ્લી જગ્યાએ થોડી વાર રાહ જુઓ.'); return; }
  openTowerForm({ lat: f.lat, lon: f.lon, acc: f.acc });
}
$('#form-tower').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#f-name').value.trim(), lat = parseFloat($('#f-lat').value), lon = parseFloat($('#f-lon').value);
  if (!name) { toast('ટાવર નંબર લખો'); return; }
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { toast('Lat/Lon બરાબર નથી'); return; }
  const type = ($$('input[name=f-type]').find(r => r.checked) || {}).value || 'suspension';
  const data = { name, type, line: $('#f-line').value.trim(), note: $('#f-note').value.trim(), lat: r6(lat), lon: r6(lon) };
  if (editId) Object.assign(S.towers.find(x => x.id === editId), data);
  else {
    S.towers.push({ id: uid(), ...data, acc: parseFloat($('#dlg-tower').dataset.acc) || null, created: Date.now() });
    if (S.rec) { S.rec.towers++; $('#st-towers').textContent = S.rec.towers; persistRec(); }
  }
  await saveTowers();
  $('#dlg-tower').close(); drawTowers(); renderList(); fillLineList();
  toast(editId ? 'ફેરફાર સચવાયો' : `ટાવર ${name} સચવાયો`);
  if (navigator.vibrate) navigator.vibrate(60);
});
$('#f-cancel').onclick = () => $('#dlg-tower').close();
$('#f-x').onclick = () => $('#dlg-tower').close();
function setTitle() { const n = $('#f-name').value.trim(); $('#dt-title').textContent = (editId ? 'ટાવર સુધારો' : 'નવું ટાવર લોકેશન સેવ કરો'); if (n) $('#dt-title').textContent = `"${n}" ` + $('#dt-title').textContent; }
$('#f-name').addEventListener('input', setTitle);
function showLL() { const a = parseFloat($('#f-lat').value), b = parseFloat($('#f-lon').value); $('#f-ll').textContent = isFinite(a) && isFinite(b) ? `${a.toFixed(6)}, ${b.toFixed(6)}` : '—'; }
['#f-lat', '#f-lon'].forEach(s => $(s).addEventListener('input', showLL));
function setFormLL(lat, lon, note) { $('#f-lat').value = r6(lat); $('#f-lon').value = r6(lon); showLL(); $('#f-acc').textContent = note; $('#dlg-tower').dataset.acc = ''; }
$('#f-use-center').onclick = () => { const c = map.getCenter(); setFormLL(c.lat, c.lng, 'નકશાના વચ્ચેની જગ્યા લીધી (નકશો ખસેડી ટાવર વચ્ચે લાવીને દબાવો)'); };
$('#f-use-gps').onclick = () => { const f = bestFix(); if (!f) { toast('GPS લોકેશન હજુ મળ્યું નથી'); return; } setFormLL(f.lat, f.lon, `GPS ચોકસાઈ ±${Math.round(f.acc)} મીટર`); $('#dlg-tower').dataset.acc = f.acc; };

function openDetail(id) {
  const t = S.towers.find(x => x.id === id); if (!t) return;
  const d = S.pos ? dist(S.pos, t) : null;
  const ll = `${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}`;
  $('#detail-body').innerHTML = `
    <h2>ટાવર ${esc(t.name)}</h2>
    ${t.line ? `<div class="muted">${esc(t.line)}</div>` : ''}
    ${t.type ? `<div><b>પ્રકાર:</b> ${esc(TYPES[t.type] || t.type)}</div>` : ''}
    ${t.note ? `<div>${esc(t.note)}</div>` : ''}
    <div class="coords" id="dt-coords">${ll}</div>
    ${d != null ? `<div class="muted">અહીંથી સીધું અંતર: <b>${fmtDist(d)}</b> · ${dirName(bearing(S.pos, t))}</div>` : ''}
    <button class="btn route big" id="dt-go" type="button">➜ અહીં જાઓ (રેકોર્ડ કરેલા રસ્તે)</button>
    <div class="row two">
      <a class="btn" target="_blank" rel="noopener" href="${gmapsUrl(t)}">Google Maps</a>
      <button class="btn" id="dt-copy" type="button">લોકેશન કૉપી</button>
    </div>
    <div class="row two">
      <button class="btn" id="dt-show" type="button">નકશા પર</button>
      <button class="btn" id="dt-edit" type="button">સુધારો</button>
    </div>
    <div class="row two">
      <button class="btn danger-o" id="dt-del" type="button">કાઢી નાખો</button>
      <button class="btn" id="dt-close" type="button">બંધ</button>
    </div>`;
  const dlg = $('#dlg-detail');
  $('#dt-go').onclick = () => { dlg.close(); startNav(t.id); };
  $('#dt-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(ll); toast('કૉપી થયું'); }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('#dt-coords')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('લખાણ પસંદ કર્યું છે, કૉપી કરો'); }
  };
  $('#dt-show').onclick = () => { dlg.close(); S.follow = false; $('#btn-locate').classList.remove('on'); map.setView([t.lat, t.lon], 18); };
  $('#dt-edit').onclick = () => { dlg.close(); openTowerForm({ id: t.id }); };
  $('#dt-del').onclick = e => confirmBtn(e.currentTarget, 'ખાતરી? ફરી દબાવો', async () => {
    S.towers = S.towers.filter(x => x.id !== t.id); await saveTowers();
    if (S.nav && S.nav.tower.id === t.id) stopNav();
    dlg.close(); drawTowers(); renderList(); toast('ટાવર કાઢી નાખ્યો');
  });
  $('#dt-close').onclick = () => dlg.close();
  dlg.showModal();
}
const gmapsUrl = t => `https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lon}&travelmode=driving`;

/* tower list */
let listT = 0;
function throttledList() { const n = Date.now(); if (n - listT > 5000) { listT = n; renderList(); } }
function renderList() {
  const q = $('#in-search').value.trim().toLowerCase();
  const box = $('#tower-list');
  if (!S.towers.length) { box.innerHTML = '<div class="empty">હજુ કોઈ ટાવર નથી.<br>પેટ્રોલિંગ ટૅબમાં જઈ "અહીં ટાવર ઉમેરો" દબાવો, અથવા ડેટા ટૅબમાંથી લિસ્ટ Import કરો.</div>'; return; }
  const list = S.towers.filter(t => !q || (t.name + ' ' + (t.line || '') + ' ' + (t.note || '')).toLowerCase().includes(q));
  if (!list.length) { box.innerHTML = '<div class="empty">આ નામનો ટાવર મળ્યો નહીં</div>'; return; }
  const groups = {};
  for (const t of list) (groups[t.line || 'લાઇન વગર'] ||= []).push(t);
  box.innerHTML = Object.keys(groups).sort(natCmp).map(g => `<div class="linehead">${esc(g)} · ${groups[g].length}</div>` +
    groups[g].sort((a, b) => natCmp(a.name, b.name)).map(t => `
      <button class="titem" data-id="${t.id}" type="button">
        <span class="tnum">${esc(String(t.name).slice(0, 6))}</span>
        <span class="tmain"><b>ટાવર ${esc(t.name)}</b><small>${t.type ? `<span class="ttag">${TSHORT[t.type] || ''}</span>` : ''}${esc(t.note || (t.demo ? 'ડેમો' : ''))}</small></span>
        <span class="tdist">${S.pos ? fmtDist(dist(S.pos, t)) : ''}</span>
      </button>`).join('')).join('');
}
$('#tower-list').addEventListener('click', e => { const b = e.target.closest('.titem'); if (b) openDetail(b.dataset.id); });
$('#in-search').addEventListener('input', renderList);

function renderTracks() {
  const box = $('#track-list');
  if (!S.tracks.length) { box.innerHTML = '<div class="empty">હજુ કોઈ રસ્તો રેકોર્ડ થયો નથી</div>'; return; }
  box.innerHTML = [...S.tracks].sort((a, b) => b.created - a.created).map(t => `
    <div class="trk"><div><b>${esc(t.name || t.line || 'રસ્તો')}</b><small>${new Date(t.created).toLocaleDateString('en-GB')} · ${fmtDist(t.dist ?? trackLen(t.segments))}</small></div>
    <button class="btn small" data-show="${t.id}" type="button">જુઓ</button>
    <button class="btn small danger-o" data-del="${t.id}" type="button">કાઢો</button></div>`).join('');
}
$('#track-list').addEventListener('click', e => {
  const s = e.target.closest('[data-show]'), d = e.target.closest('[data-del]');
  if (s) { const t = S.tracks.find(x => x.id === s.dataset.show); const pts = t.segments.flat().map(p => [p[0], p[1]]); S.follow = false; $('#btn-locate').classList.remove('on'); map.fitBounds(L.latLngBounds(pts).pad(.1)); }
  if (d) confirmBtn(d, 'ખાતરી?', async () => { S.tracks = S.tracks.filter(x => x.id !== d.dataset.del); await saveTracks(); drawTracks(); renderTracks(); toast('રસ્તો કાઢી નાખ્યો'); });
});

/* ---------------- routing graph over recorded tracks ---------------- */
const JOIN = 20;          // metres: points of different paths closer than this are treated as connected
function buildGraph() {
  const lat = [], lon = [], adj = [];
  const add = p => { lat.push(p[0]); lon.push(p[1]); adj.push([]); return lat.length - 1; };
  const link = (a, b) => { const w = dist([lat[a], lon[a]], [lat[b], lon[b]]); adj[a].push(b, w); adj[b].push(a, w); };
  const segs = S.tracks.flatMap(t => t.segments);
  if (S.rec) segs.push(...S.rec.segments);
  for (const seg of segs) {
    let prev = -1, lastP = null;
    for (const p of seg) {
      if (lastP && dist(lastP, p) < 6) continue;   // thin very dense points
      const i = add(p); if (prev >= 0) link(prev, i); prev = i; lastP = p;
    }
  }
  const n = lat.length; if (!n) return null;
  const lat0 = lat[0], cy = JOIN / 111320, cx = JOIN / (111320 * Math.cos(rad(lat0)));
  const grid = new Map(), key = (gx, gy) => gx + ',' + gy;
  for (let i = 0; i < n; i++) { const k = key(Math.floor(lon[i] / cx), Math.floor(lat[i] / cy)); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
  for (let i = 0; i < n; i++) {
    const gx = Math.floor(lon[i] / cx), gy = Math.floor(lat[i] / cy);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const cell = grid.get(key(gx + dx, gy + dy)); if (!cell) continue;
      for (const j of cell) {
        if (j <= i) continue;
        if (dist([lat[i], lon[i]], [lat[j], lon[j]]) > JOIN) continue;
        const a = adj[i]; let has = false; for (let k = 0; k < a.length; k += 2) if (a[k] === j) { has = true; break; }
        if (!has) link(i, j);
      }
    }
  }
  return { lat, lon, adj, n };
}
function dijkstraFrom(g, sources) { // sources: [[node, cost]]
  const D = new Float64Array(g.n).fill(Infinity), P = new Int32Array(g.n).fill(-1);
  const heap = []; // binary heap of [cost,node]
  const push = (c, v) => { heap.push([c, v]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  for (const [v, c] of sources) if (c < D[v]) { D[v] = c; push(c, v); }
  while (heap.length) {
    const [c, v] = pop(); if (c > D[v]) continue;
    const a = g.adj[v];
    for (let k = 0; k < a.length; k += 2) { const u = a[k], nc = c + a[k + 1]; if (nc < D[u]) { D[u] = nc; P[u] = v; push(nc, u); } }
  }
  return { D, P };
}
function nearestNodes(g, p, radius) {
  const out = []; let best = Infinity, bi = -1;
  for (let i = 0; i < g.n; i++) {
    const d = dist(p, [g.lat[i], g.lon[i]]);
    if (d < best) { best = d; bi = i; }
    if (d <= radius) out.push([i, d]);
  }
  if (!out.length && bi >= 0) out.push([bi, best]);
  return out;
}

/* ---------------- navigation ---------------- */
async function startNav(id) {
  const t = S.towers.find(x => x.id === id); if (!t) return;
  askCompassPermission();
  if (!S.graph) S.graph = buildGraph();
  const g = S.graph;
  let tree = null, towerLink = Infinity;
  if (g) {
    const src = nearestNodes(g, t, 80);
    towerLink = Math.min(...src.map(s => s[1]));
    tree = dijkstraFrom(g, src);
  }
  S.nav = { tower: t, tree, towerLink, arrived: false, lastRouteAt: null };
  $('#nav-panel').hidden = false; $('#nav-title').textContent = `ટાવર ${t.name}` + (t.line ? ` · ${t.line}` : '');
  $('#nav-gmaps').href = gmapsUrl(t);
  S.follow = true; $('#btn-locate').classList.add('on');
  keepAwake(true); drawTowers(); navLabels(); updateNav(true);
  if (S.pos) fitRoute(); else map.setView([t.lat, t.lon], 17);
}
function stopNav() { S.nav = null; routeLayer.clearLayers(); $('#nav-panel').hidden = true; drawTowers(); keepAwake(!!S.rec); }
function fitRoute() {
  const pts = []; routeLayer.eachLayer(l => { if (l.getLatLngs) pts.push(...l.getLatLngs()); });
  if (S.pos) pts.push([S.pos.lat, S.pos.lon]); pts.push([S.nav.tower.lat, S.nav.tower.lon]);
  S.follow = false; $('#btn-locate').classList.remove('on');
  map.fitBounds(L.latLngBounds(pts).pad(.2), { maxZoom: 18 });
}
function computeRoute() {
  const N = S.nav, g = S.graph, me = S.pos, t = N.tower;
  const straight = dist(me, t);
  const res = { path: null, total: straight, offStart: 0, onRoute: false, straight };
  if (!g || !N.tree) return res;
  const cands = nearestNodes(g, me, 60);
  const nearest = Math.min(...cands.map(c => c[1]));
  let best = Infinity, bi = -1;
  for (const [i, d] of nearestNodes(g, me, Math.max(60, nearest + 40))) { const c = d * 1.4 + N.tree.D[i]; if (c < best) { best = c; bi = i; } }
  if (bi < 0 || !isFinite(N.tree.D[bi])) return res;
  const offStart = dist(me, [g.lat[bi], g.lon[bi]]);
  const total = offStart + N.tree.D[bi];
  if (straight < 40 || total > straight * 4 + 500) return res;   // too close, or path is a huge detour: go straight
  const path = []; for (let v = bi; v >= 0; v = N.tree.P[v]) path.push([g.lat[v], g.lon[v]]);
  return { path, total, offStart, onRoute: true, straight };
}
function updateNav() {
  const N = S.nav; if (!N) return;
  const t = N.tower;
  if (!S.pos) { $('#nav-dist').textContent = '—'; $('#nav-sub').textContent = 'GPS લોકેશનની રાહ જુઓ છીએ…'; return; }
  const r = computeRoute(); N.route = r;
  routeLayer.clearLayers();
  const rc = cssVar('--route') || '#1463FF';
  const me = [S.pos.lat, S.pos.lon], tw = [t.lat, t.lon];
  if (r.onRoute) {
    L.polyline(r.path, { color: '#fff', weight: 10, opacity: .9, interactive: false }).addTo(routeLayer);
    L.polyline(r.path, { color: rc, weight: 6, opacity: 1, interactive: false }).addTo(routeLayer);
    if (r.offStart > 8) L.polyline([me, r.path[0]], { color: rc, weight: 4, dashArray: '4 8', interactive: false }).addTo(routeLayer);
    const end = r.path[r.path.length - 1];
    if (dist(end, tw) > 5) L.polyline([end, tw], { color: rc, weight: 4, dashArray: '4 8', interactive: false }).addTo(routeLayer);
  } else L.polyline([me, tw], { color: rc, weight: 4, dashArray: '8 8', interactive: false }).addTo(routeLayer);

  // look-ahead target for the arrow
  let target = tw;
  if (r.onRoute) { target = r.path[r.path.length - 1]; for (const p of r.path) if (dist(me, p) >= 25) { target = p; break; } if (dist(me, tw) < 40) target = tw; }
  N.targetBearing = bearing(me, target);

  const arrived = r.straight <= Math.max(20, Math.min(S.pos.acc, 35));
  if (arrived && !N.arrived && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  N.arrived = arrived;
  $('#arrow-wrap').classList.toggle('arrived', arrived);
  $('#nav-dist').textContent = arrived ? 'પહોંચી ગયા ✓' : fmtDist(r.total);
  let sub;
  if (arrived) sub = `ટાવર ${t.name} આસપાસ ${Math.round(r.straight)} મીટરમાં છે`;
  else if (r.onRoute) sub = `રેકોર્ડ કરેલા રસ્તે · સીધું ${fmtDist(r.straight)}` + (r.offStart > 40 ? ` · પહેલાં ${fmtDist(r.offStart)} દૂર રસ્તા સુધી જાઓ` : '');
  else sub = (S.graph ? 'આ બાજુ રેકોર્ડ કરેલો રસ્તો નથી, ' : '') + `સીધી દિશા: ${dirName(bearing(me, tw))}`;
  $('#nav-sub').textContent = sub;
  drawArrow();
}
function drawArrow() {
  const N = S.nav; if (!N || N.targetBearing == null) return;
  const h = curHeading();
  const rot = h == null ? N.targetBearing : N.targetBearing - h;
  $('#nav-arrow').style.transform = `rotate(${rot}deg)`;
  $('#arrow-wrap').title = h == null ? 'હોકાયંત્ર નથી: તીર ઉત્તર (ઉપર) પ્રમાણે' : 'તીર ફોનની દિશા પ્રમાણે';
}
$('#nav-stop').onclick = stopNav;
$('#nav-fit').onclick = fitRoute;
function neighbourTower(step) {   // next/previous tower on the same line, by tower number
  const cur = S.nav && S.nav.tower; if (!cur) return null;
  const line = S.towers.filter(t => (t.line || '') === (cur.line || '')).sort((a, b) => natCmp(a.name, b.name));
  const i = line.findIndex(t => t.id === cur.id);
  return line[i + step] || null;
}
function navLabels() {
  const n = neighbourTower(1), p = neighbourTower(-1);
  $('#nav-next').hidden = !n; $('#nav-prev').hidden = !p;
  if (n) $('#nav-next').textContent = `ટાવર ${n.name} ▶`;
  if (p) $('#nav-prev').textContent = `◀ ${p.name}`;
}
$('#nav-next').onclick = () => { const t = neighbourTower(1); if (t) startNav(t.id); };
$('#nav-prev').onclick = () => { const t = neighbourTower(-1); if (t) startNav(t.id); };

/* ---------------- export / import ---------------- */
const xmlEsc = esc;
const iso = s => new Date(s * 1000).toISOString();
function toGPX() {
  let o = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Tower Patrol" xmlns="http://www.topografix.com/GPX/1/1">\n';
  for (const t of S.towers) o += `<wpt lat="${t.lat}" lon="${t.lon}"><name>${xmlEsc(t.name)}</name>${t.note ? `<desc>${xmlEsc(t.note)}</desc>` : ''}${t.line ? `<type>${xmlEsc(t.line)}</type>` : ''}${t.type ? `<cmt>${t.type}</cmt>` : ''}<sym>Tower</sym></wpt>\n`;
  for (const tr of S.tracks) {
    o += `<trk><name>${xmlEsc(tr.name || '')}</name>${tr.line ? `<type>${xmlEsc(tr.line)}</type>` : ''}\n`;
    for (const s of tr.segments) o += '<trkseg>' + s.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] ? `<time>${iso(p[2])}</time>` : ''}</trkpt>`).join('') + '</trkseg>\n';
    o += '</trk>\n';
  }
  return o + '</gpx>\n';
}
function toKML() {
  const lines = lineNames(); if (S.towers.some(t => !t.line) || S.tracks.some(t => !t.line)) lines.push('');
  let o = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Tower Patrol</name>\n' +
    '<Style id="tw"><IconStyle><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/triangle.png</href></Icon></IconStyle></Style>' +
    '<Style id="trk"><LineStyle><color>ff006aff</color><width>4</width></LineStyle></Style>\n';
  for (const ln of lines) {
    o += `<Folder><name>${xmlEsc(ln || 'લાઇન વગર')}</name>\n`;
    for (const t of S.towers.filter(x => (x.line || '') === ln)) o += `<Placemark><name>${xmlEsc(t.name)}</name>${t.note || t.type ? `<description>${xmlEsc([TYPES[t.type], t.note].filter(Boolean).join(' · '))}</description>` : ''}<styleUrl>#tw</styleUrl><Point><coordinates>${t.lon},${t.lat},0</coordinates></Point></Placemark>\n`;
    for (const tr of S.tracks.filter(x => (x.line || '') === ln)) o += `<Placemark><name>${xmlEsc(tr.name || 'રસ્તો')}</name><styleUrl>#trk</styleUrl><MultiGeometry>` + tr.segments.map(s => '<LineString><tessellate>1</tessellate><coordinates>' + s.map(p => `${p[1]},${p[0]},0`).join(' ') + '</coordinates></LineString>').join('') + '</MultiGeometry></Placemark>\n';
    o += '</Folder>\n';
  }
  return o + '</Document></kml>\n';
}
function toCSV() {
  const q = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v ?? '');
  return '﻿name,line,type,lat,lon,note\n' + [...S.towers].sort((a, b) => natCmp(a.line, b.line) || natCmp(a.name, b.name)).map(t => [t.name, t.line || '', TYPES[t.type] || '', t.lat, t.lon, t.note || ''].map(q).join(',')).join('\n') + '\n';
}
function toJSON() { return JSON.stringify({ app: 'tower-patrol', version: 1, exported: new Date().toISOString(), towers: S.towers.filter(t => !t.demo), tracks: S.tracks.filter(t => !t.demo) }); }

let pendingFile = null;
function offerFile(name, text, mime) {
  pendingFile = new File([text], name, { type: mime });
  $('#sh-name').textContent = name + ' · ' + Math.max(1, Math.round(pendingFile.size / 1024)) + ' KB';
  pendingFile.text = text;
  $('#sh-share').hidden = !IS_NATIVE && !(navigator.canShare && navigator.canShare({ files: [pendingFile] }));
  $('#sh-dl').hidden = IS_NATIVE;
  $('#dlg-share').showModal();
}
async function nativeShare() {   // APK: write the file to app cache, then open Android's share sheet
  const P = window.Capacitor.Plugins;
  const w = await P.Filesystem.writeFile({ path: pendingFile.name, data: pendingFile.text, directory: 'CACHE', encoding: 'utf8' });
  await P.Share.share({ title: pendingFile.name, files: [w.uri], dialogTitle: 'ફાઇલ મોકલો / સાચવો' });
}
$('#sh-share').onclick = async () => { try { if (IS_NATIVE) { await nativeShare(); $('#dlg-share').close(); return; } await navigator.share({ files: [pendingFile], title: pendingFile.name }); $('#dlg-share').close(); } catch (e) { if (e.name !== 'AbortError' && !/cancel/i.test(e.message || '')) toast('શેર ન થયું, ડાઉનલોડ કરો'); } };
$('#sh-dl').onclick = () => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(pendingFile); a.download = pendingFile.name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $('#dlg-share').close(); toast('ફાઇલ Downloads માં સચવાઈ');
};
$('#sh-close').onclick = () => $('#dlg-share').close();
$$('[data-export]').forEach(b => b.onclick = () => {
  if (!S.towers.length && !S.tracks.length) { toast('હજુ કોઈ ડેટા નથી'); return; }
  const d = new Date().toISOString().slice(0, 10), k = b.dataset.export;
  if (k === 'json') offerFile(`tower-patrol-backup-${d}.json`, toJSON(), 'application/json');
  if (k === 'gpx') offerFile(`tower-patrol-${d}.gpx`, toGPX(), 'application/gpx+xml');
  if (k === 'kml') offerFile(`tower-patrol-${d}.kml`, toKML(), 'application/vnd.google-earth.kml+xml');
  if (k === 'csv') offerFile(`towers-${d}.csv`, toCSV(), 'text/csv');
});

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',' || c === '\t' || c === ';') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
function importCSV(text) {
  const rows = parseCSV(text.replace(/^﻿/, '')); if (!rows.length) return { towers: [], tracks: [] };
  const h = rows[0].map(x => x.trim().toLowerCase());
  const find = (...names) => h.findIndex(x => names.some(n => x === n || x.startsWith(n)));
  let iN = find('name', 'tower', 'loc', 'no', 'નામ', 'ટાવર'), iLa = find('lat', 'latitude', 'y'), iLo = find('lon', 'lng', 'long', 'x'), iL = find('line', 'લાઇન', 'feeder'), iNo = find('note', 'remark', 'desc', 'નોંધ'), iT = find('type', 'પ્રકાર');
  let body = rows.slice(1);
  if (iLa < 0 || iLo < 0) { // no header: assume name,lat,lon[,line,note]
    body = rows; iN = 0; iLa = 1; iLo = 2; iL = 3; iNo = 4;
  }
  const towers = [];
  for (const r of body) {
    const lat = parseFloat(r[iLa]), lon = parseFloat(r[iLo]);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || (!lat && !lon)) continue;
    towers.push({ name: (r[iN] ?? '').trim() || String(towers.length + 1), line: iL >= 0 ? (r[iL] || '').trim() : '', type: iT >= 0 ? typeKey(r[iT]) : '', note: iNo >= 0 ? (r[iNo] || '').trim() : '', lat, lon });
  }
  return { towers, tracks: [] };
}
function txt(el, sel) { const x = el.getElementsByTagName(sel)[0]; return x ? x.textContent.trim() : ''; }
function importGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const towers = [...doc.getElementsByTagName('wpt')].map(w => ({ name: txt(w, 'name') || '?', note: txt(w, 'desc') || (typeKey(txt(w, 'cmt')) ? '' : txt(w, 'cmt')), type: typeKey(txt(w, 'cmt')), line: txt(w, 'type'), lat: +w.getAttribute('lat'), lon: +w.getAttribute('lon') }));
  const tracks = [];
  for (const t of doc.getElementsByTagName('trk')) {
    const segments = [...t.getElementsByTagName('trkseg')].map(s => [...s.getElementsByTagName('trkpt')].map(p => { const tm = txt(p, 'time'); return [+p.getAttribute('lat'), +p.getAttribute('lon'), tm ? Math.round(Date.parse(tm) / 1000) : 0, 0]; })).filter(s => s.length > 1);
    if (segments.length) tracks.push({ name: txt(t, 'name'), line: txt(t, 'type'), segments });
  }
  for (const r of doc.getElementsByTagName('rte')) {
    const seg = [...r.getElementsByTagName('rtept')].map(p => [+p.getAttribute('lat'), +p.getAttribute('lon'), 0, 0]);
    if (seg.length > 1) tracks.push({ name: txt(r, 'name'), line: '', segments: [seg] });
  }
  return { towers, tracks };
}
function importKML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const towers = [], tracks = [];
  const coords = s => s.trim().split(/\s+/).map(c => c.split(',').map(Number)).filter(c => c.length >= 2 && !isNaN(c[0]) && !isNaN(c[1])).map(c => [c[1], c[0], 0, 0]);
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const name = [...pm.children].find(c => c.tagName === 'name')?.textContent.trim() || '';
    const desc = [...pm.children].find(c => c.tagName === 'description')?.textContent.trim() || '';
    let folder = pm.parentElement; while (folder && folder.tagName !== 'Folder') folder = folder.parentElement;
    const line = folder ? ([...folder.children].find(c => c.tagName === 'name')?.textContent.trim() || '') : '';
    const pts = pm.getElementsByTagName('Point');
    if (pts.length) { const c = coords(txt(pts[0], 'coordinates'))[0]; if (c) towers.push({ name: name || '?', note: desc.replace(/<[^>]+>/g, ' ').trim().slice(0, 200), line, lat: c[0], lon: c[1] }); }
    const segs = [...pm.getElementsByTagName('LineString')].map(l => coords(txt(l, 'coordinates'))).filter(s => s.length > 1);
    if (segs.length) tracks.push({ name, line, segments: segs });
  }
  return { towers, tracks };
}
async function mergeImport(data) {
  let nt = 0, nk = 0;
  for (const t of data.towers || []) {
    if (!(Math.abs(t.lat) <= 90 && Math.abs(t.lon) <= 180)) continue;
    const dup = S.towers.find(x => x.id === t.id || (x.name === t.name && (x.line || '') === (t.line || '') && dist(x, t) < 8));
    if (dup) continue;
    S.towers.push({ id: t.id || uid(), name: String(t.name), line: t.line || '', type: typeKey(t.type), note: t.note || '', lat: r6(+t.lat), lon: r6(+t.lon), acc: t.acc || null, created: t.created || Date.now() }); nt++;
  }
  for (const tr of data.tracks || []) {
    if (tr.id && S.tracks.some(x => x.id === tr.id)) continue;
    const segments = (tr.segments || []).filter(s => s.length > 1);
    if (!segments.length) continue;
    S.tracks.push({ id: tr.id || uid(), name: tr.name || 'Import', line: tr.line || '', created: tr.created || Date.now(), segments, dist: trackLen(segments) }); nk++;
  }
  await saveTowers(); await saveTracks();
  drawTowers(); drawTracks(); renderList(); renderTracks(); fillLineList(); fitAll();
  return [nt, nk];
}
$('#in-file').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const text = await f.text(), n = f.name.toLowerCase();
    let data;
    if (n.endsWith('.kmz')) { toast('KMZ ફાઇલ ચાલતી નથી. Google Earth માંથી KML તરીકે સાચવો.'); return; }
    if (n.endsWith('.json') || text.trim().startsWith('{')) { data = JSON.parse(text); }
    else if (n.endsWith('.gpx') || /<gpx[\s>]/.test(text)) data = importGPX(text);
    else if (n.endsWith('.kml') || /<kml[\s>]/.test(text)) data = importKML(text);
    else data = importCSV(text);
    const [nt, nk] = await mergeImport(data);
    toast(`${nt} ટાવર અને ${nk} રસ્તા ઉમેર્યા`, 4000);
  } catch (err) { console.error(err); toast('આ ફાઇલ વાંચી શકાઈ નહીં'); }
});

/* ---------------- offline map tiles ---------------- */
function tileXY(lat, lon, z) { const n = 2 ** z; const x = Math.floor((lon + 180) / 360 * n); const y = Math.floor((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * n); return [x, y]; }
$('#btn-offline').onclick = async e => {
  const btn = e.currentTarget, st = $('#offline-status');
  const pts = S.towers.map(t => [t.lat, t.lon]);
  for (const tr of S.tracks) for (const s of tr.segments) for (const p of s) pts.push(p);
  if (!pts.length) { st.textContent = 'પહેલાં રસ્તો રેકોર્ડ કરો અથવા ટાવર ઉમેરો.'; return; }
  if (!navigator.onLine) { st.textContent = 'નેટ ચાલુ કરીને ફરી પ્રયાસ કરો.'; return; }
  const tpl = TILES[S.settings.layer].url, set = new Set();
  for (const z of [13, 14, 15, 16, 17]) {
    const pad = z >= 16 ? 1 : 0;
    for (const p of pts) { const [x, y] = tileXY(p[0], p[1], z); for (let dx = -pad; dx <= pad; dx++) for (let dy = -pad; dy <= pad; dy++) set.add(`${z}/${x + dx}/${y + dy}`); }
  }
  let urls = [...set].map(k => { const [z, x, y] = k.split('/'); return tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y); });
  if (urls.length > 3000) { urls = urls.slice(0, 3000); }
  btn.disabled = true; let done = 0, fail = 0;
  const work = async () => { while (urls.length) { const u = urls.pop(); try { if (!(await cachedTileBlob(u))) throw 0; } catch (_) { fail++; } done++; if (done % 10 === 0) st.textContent = `સાચવાય છે… ${done} ટાઇલ`; } };
  const total = urls.length;
  st.textContent = `સાચવાય છે… 0 / ${total}`;
  await Promise.all([work(), work(), work(), work()]);
  btn.disabled = false;
  st.textContent = fail ? `${total - fail} ટાઇલ સચવાઈ, ${fail} બાકી રહી (નેટ ધીમું હતું). ફરી દબાવી શકો.` : `થઈ ગયું: ${total} નકશા ટાઇલ ફોનમાં સચવાઈ (${S.settings.layer === 'sat' ? 'સેટેલાઇટ' : 'નકશો'}).`;
};

/* ---------------- demo data ---------------- */
function destPt(p, brg, m) { const d = m / R, b = rad(brg), la = rad(p[0]), lo = rad(p[1]); const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b)); const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2)); return [r6(deg(la2)), r6(deg(lo2))]; }
function makeDemo() {
  const base = S.pos ? [S.pos.lat, S.pos.lon] : [23.2156, 72.6369];
  const line = 'ડેમો 66KV લાઇન', towers = [], segs = [];
  const start = destPt(base, 200, 300);
  const road = []; for (let i = 0; i <= 40; i++) { const p = destPt(start, 78, i * 75); road.push(destPt(p, 168, Math.sin(i / 4) * 25)); }
  segs.push(road.map((p, i) => [...p, 0, 0]));
  for (let k = 0; k < 8; k++) {
    const tw = destPt(destPt(start, 78, 200 + k * 360), 348, 260 + (k % 3) * 40);
    towers.push({ id: 'demo-t' + k, name: String(101 + k), line, type: k === 0 ? 'gantry' : k === 4 ? 'tension' : k === 7 ? 'deadend' : 'suspension', note: k === 3 ? 'ખેતરમાં, કૂવા પાસે' : '', lat: tw[0], lon: tw[1], created: Date.now() + k, demo: true });
    const ri = Math.round((200 + k * 360) / 75); const from = road[Math.min(ri, road.length - 1)];
    const spur = []; for (let j = 0; j <= 10; j++) { const f = j / 10; spur.push([r6(from[0] + (tw[0] - from[0]) * f + Math.sin(j) * 0.00008), r6(from[1] + (tw[1] - from[1]) * f), 0, 0]); }
    segs.push(spur);
  }
  return { towers, tracks: [{ id: 'demo-trk', name: 'ડેમો રસ્તો', line, created: Date.now(), segments: segs, demo: true }] };
}
$('#btn-demo').onclick = async () => {
  const d = makeDemo();
  S.towers = S.towers.filter(t => !t.demo).concat(d.towers);
  S.tracks = S.tracks.filter(t => !t.demo).concat(d.tracks.map(t => ({ ...t, dist: trackLen(t.segments) })));
  await saveTowers(); await saveTracks(); drawTowers(); drawTracks(); renderList(); renderTracks(); fillLineList(); fitAll();
  toast('ડેમો ડેટા લોડ થયો. ટાવર ટૅબમાંથી કોઈ ટાવર પસંદ કરી "અહીં જાઓ" દબાવો.', 5000);
};
$('#btn-demo-clear').onclick = async () => {
  S.towers = S.towers.filter(t => !t.demo); S.tracks = S.tracks.filter(t => !t.demo);
  if (S.nav && S.nav.tower.demo) stopNav();
  await saveTowers(); await saveTracks(); drawTowers(); drawTracks(); renderList(); renderTracks(); fillLineList(); toast('ડેમો ડેટા કાઢી નાખ્યો');
};

/* ---------------- UI wiring ---------------- */
function showTab(k) {
  $$('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === k));
  ['patrol', 'towers', 'data'].forEach(x => $('#tab-' + x).hidden = x !== k);
  if (k === 'towers') renderList();
  if (k === 'data') { renderTracks(); storageInfo(); }
}
$$('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));
$('#btn-start').onclick = () => startRec(false);
$('#btn-pause').onclick = pauseRec;
$('#btn-stop').onclick = e => confirmBtn(e.currentTarget, 'ખાતરી? ફરી દબાવો', stopRec);
$('#btn-add-tower').onclick = addTowerHere;
$('#btn-add-tower-idle').onclick = addTowerHere;
$('#btn-layer').onclick = () => { setLayer(S.settings.layer === 'osm' ? 'sat' : 'osm'); saveSettings(); };
$('#btn-locate').onclick = () => {
  if (!S.pos) { toast('GPS લોકેશન હજુ મળ્યું નથી'); return; }
  S.follow = true; $('#btn-locate').classList.add('on'); map.setView([S.pos.lat, S.pos.lon], Math.max(map.getZoom(), 17));
};
$('#gps-chip').onclick = () => $('#btn-locate').click();
map.on('dragstart', () => { S.follow = false; $('#btn-locate').classList.remove('on'); });
map.on('contextmenu', e => openTowerForm({ lat: e.latlng.lat, lon: e.latlng.lng, manual: true }));

async function storageInfo() {
  let s = `${S.towers.length} ટાવર · ${S.tracks.length} રસ્તા સચવાયેલા.`;
  try { if (navigator.storage && navigator.storage.persisted) s += (await navigator.storage.persisted()) ? ' ફોનમાં કાયમી સ્ટોરેજ ચાલુ છે.' : ''; } catch (_) {}
  $('#storage-info').textContent = s;
}

/* ---------------- boot ---------------- */
(async function boot() {
  try {
    S.towers = (await DB.get('towers')) || [];
    S.tracks = (await DB.get('tracks')) || [];
    S.settings = Object.assign(S.settings, (await DB.get('settings')) || {});
    const rec = await DB.get('rec');
    if (rec) {
      S.rec = rec; if (!rec.paused) { rec.activeMs += 0; rec.paused = true; }
      const b = banner('<b>અધૂરું પેટ્રોલિંગ મળ્યું.</b> ઍપ બંધ થઈ ગઈ હતી. શું કરવું છે?<div class="row"><button class="btn primary small" id="rb-go" type="button">ચાલુ રાખો</button><button class="btn small" id="rb-save" type="button">સાચવી લો</button></div>');
      b.querySelector('#rb-go').onclick = () => { banner(null); showTab('patrol'); startRec(true); };
      b.querySelector('#rb-save').onclick = () => { banner(null); stopRec(); };
      drawRec(); recUI();
    }
  } catch (e) { console.error(e); banner('ફોનમાં ડેટા સાચવી શકાતો નથી (Private/Incognito મોડ?). સામાન્ય Chrome માં ખોલો.'); }
  setLayer(S.settings.layer in TILES ? S.settings.layer : 'osm');
  $('#in-line').value = S.settings.lastLine || '';
  drawTracks(); drawTowers(); fillLineList(); renderList(); fitAll();
  startGPS(); startCompass();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (_) {}
  if (!IS_NATIVE && 'serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
