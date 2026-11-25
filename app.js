'use strict';
// Offline music PWA. Audio blobs live in IndexedDB; playback is a single <audio> element.
// Rule for reliable lock-screen skipping on iOS: every track change sets audio.src and calls
// play() synchronously — no awaits — so all object URLs are prepared up front.

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const SINGLES = ''; // group name for tracks not in an album/playlist

// ---------- local prefs (per-device conveniences; always guarded) ----------
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const DEFAULTS = { accent: '#ffffff', size: 13, status: true, resume: true, smartPrev: true, shuffle: false, repeat: 'all' };
const settings = { ...DEFAULTS, ...lsGet('om-settings', {}) };
const saveSettings = () => lsSet('om-settings', settings);

// ---------- debug log (persisted so you can read what happened while locked) ----------
let logLines = lsGet('om-log', []);
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logLines.push(`${t} [${document.visibilityState}] ${msg}`);
  if (logLines.length > 300) logLines = logLines.slice(-300);
  lsSet('om-log', logLines);
  $('log').textContent = logLines.slice().reverse().join('\n');
}
$('clearlog').onclick = () => { logLines = []; log('log cleared'); };
document.addEventListener('visibilitychange', () => {
  log('visibility → ' + document.visibilityState);
  if (document.visibilityState === 'hidden') saveResume();
});
let flashTimer;
const flash = (m) => { $('msg').textContent = m; clearTimeout(flashTimer); flashTimer = setTimeout(() => { $('msg').textContent = ''; }, 6000); };

// ---------- IndexedDB ----------
// tracks: { id, name, title, artist, album, size, type, duration, artId }
//   album = album/playlist name ('' = singles); artId = key into the art store (shared per album).
// blobs: audio Blob by track id.  art: image Blob by artId.
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('offline-music', 2);
    r.onupgradeneeded = (e) => {
      const d = r.result;
      if (e.oldVersion < 1) { d.createObjectStore('tracks', { keyPath: 'id' }); d.createObjectStore('blobs'); }
      if (e.oldVersion < 2) d.createObjectStore('art');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); }
function done(tx) { return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }

// ---------- state ----------
let tracks = [];            // all tracks, sorted by album then filename
const byId = new Map();
const urls = new Map();     // track id -> audio object URL
const artUrls = new Map();  // artId -> image object URL
let baseQueue = [];         // track ids in album order (what you started playing from)
let queue = [];             // actual play order (= baseQueue, or shuffled)
let qpos = -1;
let pendingSeek = 0;        // resume position applied once metadata loads
const current = () => (qpos >= 0 ? byId.get(queue[qpos]) : null);

const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
function groups() {
  const m = new Map();
  for (const t of tracks) { const g = t.album || SINGLES; if (!m.has(g)) m.set(g, []); m.get(g).push(t); }
  return [...m.entries()].sort(([a], [b]) => (a === SINGLES) - (b === SINGLES) || cmp(a, b));
}

async function loadLibrary() {
  tracks = await req(store('tracks').getAll());
  for (const t of tracks) if (t.hasArt && !t.artId) t.artId = t.id; // records from before shared art
  tracks.sort((a, b) => cmp(a.album || '￿', b.album || '￿') || cmp(a.name, b.name));
  byId.clear();
  for (const t of tracks) byId.set(t.id, t);
  // Prepare every object URL now so track changes never need to await.
  // IndexedDB blobs are disk-backed in Safari, so this doesn't pull audio into memory.
  for (const t of tracks) {
    if (!urls.has(t.id)) {
      const blob = await req(store('blobs').get(t.id));
      if (blob) urls.set(t.id, URL.createObjectURL(blob));
    }
    if (t.artId && !artUrls.has(t.artId)) {
      const img = await req(store('art').get(t.artId));
      if (img) artUrls.set(t.artId, URL.createObjectURL(img));
    }
  }
  const cur = current();
  baseQueue = baseQueue.filter((id) => byId.has(id));
  queue = queue.filter((id) => byId.has(id));
  qpos = cur && byId.has(cur.id) ? queue.indexOf(cur.id) : -1;
  render();
}

// Album art hook: attach an image Blob to a single track (e.g. from embedded tags later).
async function setTrackArt(id, imageBlob) {
  const t = byId.get(id);
  if (!t) return;
  const artId = 't:' + id;
  const tx = db.transaction(['art', 'tracks'], 'readwrite');
  tx.objectStore('art').put(imageBlob, artId);
  tx.objectStore('tracks').put({ ...t, artId });
  await done(tx);
  t.artId = artId;
  if (artUrls.has(artId)) URL.revokeObjectURL(artUrls.get(artId));
  artUrls.set(artId, URL.createObjectURL(imageBlob));
  if (current() === t) { updateSession(); updateNow(); }
}
window.setTrackArt = setTrackArt;

// ---------- import ----------
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|alac|aif|aiff|caf|ogg|opus)$/i;
const IMG_EXT = /\.(jpe?g|png|webp)$/i;
const COVER_NAME = /^(cover|folder|front|album|artwork)\b/i;
const isAudio = (f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name);
const parentDir = (f) => { const p = (f.webkitRelativePath || '').split('/'); return p.length > 1 ? p[p.length - 2] : ''; };

$('file').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; importFiles(f); });
$('folder').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; importFiles(f); });

async function importFiles(files) {
  const audioFiles = files.filter(isAudio);
  if (!audioFiles.length) { flash('no audio files found'); return; }

  // Group by folder. One folder (or plain multi-select) → ask for the album/playlist name.
  const dirs = [...new Set(audioFiles.map(parentDir))];
  let rename = null;
  if (dirs.length === 1 && (audioFiles.length > 1 || dirs[0])) {
    const name = prompt('Album / playlist name\n(leave blank to add as singles)', dirs[0]);
    if (name === null) { flash('import cancelled'); return; }
    rename = name.trim();
  }
  const groupOf = (f) => (rename !== null ? rename : parentDir(f));

  // Folder cover art: cover/folder/front.jpg, or the only image in that folder.
  const artIdFor = new Map(); // dir -> artId
  for (const d of dirs) {
    if (!d) continue;
    const imgs = files.filter((f) => IMG_EXT.test(f.name) && parentDir(f) === d);
    const img = imgs.find((f) => COVER_NAME.test(f.name)) || (imgs.length === 1 ? imgs[0] : null);
    const g = rename !== null ? rename : d;
    if (!img || !g) continue;
    const artId = 'g:' + g;
    try {
      const blob = new Blob([await img.arrayBuffer()], { type: img.type || 'image/jpeg' });
      await req(store('art', 'readwrite').put(blob, artId));
      if (artUrls.has(artId)) { URL.revokeObjectURL(artUrls.get(artId)); artUrls.delete(artId); }
      artIdFor.set(d, artId);
    } catch (err) { log(`cover failed ${img.name}: ${err && err.message}`); }
  }

  const existing = new Set(tracks.map((t) => (t.album || '') + '|' + t.name + '|' + t.size));
  let added = 0, skipped = 0;
  for (const f of audioFiles) {
    flash(`importing ${added + skipped + 1}/${audioFiles.length} ${f.name}`);
    const album = groupOf(f);
    if (existing.has(album + '|' + f.name + '|' + f.size)) { skipped++; continue; }
    try {
      // Copy into a fresh Blob: Safari has had bugs storing picker File objects directly.
      const blob = new Blob([await f.arrayBuffer()], { type: f.type || guessType(f.name) });
      const id = crypto.randomUUID();
      const prior = tracks.find((t) => t.album === album && t.artId && t.artId.startsWith('g:'));
      const tx = db.transaction(['tracks', 'blobs'], 'readwrite');
      tx.objectStore('blobs').put(blob, id);
      tx.objectStore('tracks').put({
        id, name: f.name, title: f.name.replace(/\.[^.]+$/, '').replace(/^\d{1,3}[\s._-]+/, ''),
        artist: '', album, size: f.size, type: blob.type, duration: 0,
        artId: artIdFor.get(parentDir(f)) || (prior && prior.artId) || null,
      });
      await done(tx);
      added++;
    } catch (err) {
      log(`import failed ${f.name}: ${err && err.name} ${err && err.message}`);
    }
  }
  const where = rename !== null ? (rename ? ` into "${rename}"` : ' as singles') : dirs.length > 1 ? ` into ${dirs.length} albums` : '';
  flash(`+${added}${where}${skipped ? `, ${skipped} dup skipped` : ''}`);
  log(`import: ${added} added${where}, ${skipped} skipped`);
  await loadLibrary();
  showStorage();
}

function guessType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', alac: 'audio/mp4',
           aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf', ogg: 'audio/ogg', opus: 'audio/ogg' }[ext] || '';
}

async function deleteTracks(list, label) {
  if (!list.length || !confirm(`Delete ${label} (${list.length} track${list.length === 1 ? '' : 's'}) from this app?`)) return;
  const cur = current();
  if (cur && list.includes(cur)) { audio.pause(); audio.removeAttribute('src'); audio.load(); qpos = -1; queue = []; baseQueue = []; }
  const ids = new Set(list.map((t) => t.id));
  const tx = db.transaction(['tracks', 'blobs', 'art'], 'readwrite');
  for (const t of list) {
    tx.objectStore('tracks').delete(t.id);
    tx.objectStore('blobs').delete(t.id);
    if (urls.has(t.id)) { URL.revokeObjectURL(urls.get(t.id)); urls.delete(t.id); }
  }
  const stillUsed = new Set(tracks.filter((t) => !ids.has(t.id)).map((t) => t.artId));
  for (const a of new Set(list.map((t) => t.artId))) {
    if (a && !stillUsed.has(a)) {
      tx.objectStore('art').delete(a);
      if (artUrls.has(a)) { URL.revokeObjectURL(artUrls.get(a)); artUrls.delete(a); }
    }
  }
  await done(tx);
  log(`deleted ${label}: ${list.length}`);
  await loadLibrary(); showStorage(); syncPlayState(); saveResume();
}
$('clear').onclick = () => deleteTracks(tracks.slice(), 'all tracks');

// ---------- playback (all synchronous) ----------
function shuffled(ids) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// Start playing from a list the user chose (album, track tap). Handles shuffle.
function startQueue(ids, pos, why) {
  if (!ids.length) return;
  baseQueue = ids.slice();
  if (settings.shuffle) {
    const first = ids[pos];
    playAt([first, ...shuffled(ids.filter((id) => id !== first))], 0, why);
  } else {
    playAt(baseQueue, pos, why);
  }
}
function playAt(ids, pos, why) {
  if (!ids.length) return;
  pos = (pos + ids.length) % ids.length;
  const t = byId.get(ids[pos]);
  const url = t && urls.get(t.id);
  if (!url) { log(`no url for ${t ? t.name : ids[pos]}`); return; }
  queue = ids; qpos = pos; pendingSeek = 0;
  audio.src = url;
  const p = audio.play();
  if (p) p.catch((err) => log(`play() rejected: ${err.name} ${err.message}`));
  log(`${why} → ${t.album ? t.album + ' / ' : ''}#${pos + 1} ${t.title}`);
  updateSession();
  render();
  saveResume();
}
const next = (why) => playAt(queue, qpos + 1, why);
const prev = (why) => {
  if (settings.smartPrev && audio.currentTime > 3) { audio.currentTime = 0; log(`${why} → restart`); return; }
  playAt(queue, qpos - 1, why);
};
function toggle() {
  if (qpos < 0) {
    const first = groups()[0];
    if (first) startQueue(first[1].map((t) => t.id), 0, 'toggle');
    else openSheet('library');
    return;
  }
  if (audio.paused) audio.play().catch((e) => log('play() rejected: ' + e.name)); else audio.pause();
}

audio.addEventListener('ended', () => {
  if (settings.repeat === 'off' && qpos === queue.length - 1) { log('ended: end of queue'); syncPlayState(); return; }
  next('ended');
});
audio.addEventListener('playing', () => { registerHandlers(); syncPlayState(); });
audio.addEventListener('play', syncPlayState);
audio.addEventListener('pause', () => { syncPlayState(); saveResume(); });
audio.addEventListener('error', () => log(`audio error: code ${audio.error && audio.error.code}`));
audio.addEventListener('stalled', () => log('event: stalled'));
let lastSave = 0;
audio.addEventListener('timeupdate', () => {
  updateNow();
  if (Date.now() - lastSave > 5000) saveResume();
});
audio.addEventListener('loadedmetadata', () => {
  if (pendingSeek && isFinite(audio.duration)) { audio.currentTime = Math.min(pendingSeek, audio.duration - 1); pendingSeek = 0; }
  updatePosition(); updateNow();
  const t = current();
  if (t && isFinite(audio.duration) && !t.duration) {   // remember duration for the list
    t.duration = audio.duration;
    store('tracks', 'readwrite').put(t);
    render();
  }
});

$('prev').onclick = () => prev('button');
$('next').onclick = () => next('button');
$('toggle').onclick = toggle;

$('shuffle').onclick = () => {
  settings.shuffle = !settings.shuffle; saveSettings();
  const cur = current();
  if (cur) {
    if (settings.shuffle) { queue = [cur.id, ...shuffled(baseQueue.filter((id) => id !== cur.id))]; qpos = 0; }
    else { queue = baseQueue.slice(); qpos = queue.indexOf(cur.id); }
  }
  flash(settings.shuffle ? 'shuffle on' : 'shuffle off');
  syncModes(); render(); saveResume();
};
$('repeat').onclick = () => {
  settings.repeat = { all: 'one', one: 'off', off: 'all' }[settings.repeat] || 'all';
  saveSettings(); flash('repeat ' + settings.repeat); syncModes();
};
function syncModes() {
  $('shuffle').classList.toggle('on', settings.shuffle);
  $('repeat').classList.toggle('on', settings.repeat !== 'off');
  $('repeat-one').hidden = settings.repeat !== 'one';
  audio.loop = settings.repeat === 'one';
}

// scrub bar
(() => {
  const bar = $('bar');
  let dragging = false;
  const seekFrom = (e) => {
    if (!isFinite(audio.duration)) return;
    const r = bar.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    audio.currentTime = f * audio.duration;
    updateNow(); updatePosition();
  };
  bar.addEventListener('pointerdown', (e) => { dragging = true; bar.setPointerCapture(e.pointerId); seekFrom(e); });
  bar.addEventListener('pointermove', (e) => { if (dragging) seekFrom(e); });
  bar.addEventListener('pointerup', () => { dragging = false; });
  bar.addEventListener('pointercancel', () => { dragging = false; });
})();

// ---------- resume where you left off ----------
function saveResume() {
  lastSave = Date.now();
  const t = current();
  lsSet('om-resume', t ? { base: baseQueue, queue, id: t.id, time: audio.currentTime || pendingSeek || 0 } : null);
}
function restoreResume() {
  const r = settings.resume && lsGet('om-resume', null);
  if (!r || !byId.has(r.id) || !urls.has(r.id)) return;
  baseQueue = (r.base || []).filter((id) => byId.has(id));
  queue = (r.queue || []).filter((id) => byId.has(id));
  qpos = queue.indexOf(r.id);
  if (qpos < 0) { queue = [r.id]; qpos = 0; }
  pendingSeek = r.time || 0;
  audio.src = urls.get(r.id);
  updateSession();
  log(`resumed at ${byId.get(r.id).title} ${fmt(pendingSeek)}`);
}

// ---------- Media Session (lock screen / Control Center / AirPods) ----------
// iOS home-screen apps were showing ±10s skip instead of next/prev. Fixes:
//  - explicitly clear seekforward/seekbackward (they win over next/prev if present),
//  - (re)register handlers once playback is actually running, since iOS can drop or ignore
//    handlers registered before the page became the active Now Playing session.
const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
let handlersLogged = false;
function registerHandlers() {
  if (!ms) return;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); return true; } catch { return false; } };
  set('seekforward', null);
  set('seekbackward', null);
  const ok = {
    play: set('play', () => { log('ms: play'); audio.play().catch((e) => log('play() rejected: ' + e.name)); }),
    pause: set('pause', () => { log('ms: pause'); audio.pause(); }),
    nexttrack: set('nexttrack', () => next('ms: nexttrack')),
    previoustrack: set('previoustrack', () => prev('ms: previoustrack')),
    seekto: set('seekto', (d) => { audio.currentTime = d.seekTime; updatePosition(); }),
  };
  if (!handlersLogged) { log('ms handlers: ' + JSON.stringify(ok)); handlersLogged = true; }
}
function artFor(t) {
  const u = t && t.artId && artUrls.get(t.artId);
  return u ? [{ src: u, sizes: '512x512' }] : [{ src: 'icon-512.png?v=2', sizes: '512x512', type: 'image/png' }];
}
function updateSession() {
  const t = current();
  if (!ms || !t) return;
  ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: t.album || '', artwork: artFor(t) });
  registerHandlers();
}
function syncPlayState() {
  const t = current();
  if (ms) ms.playbackState = !t ? 'none' : audio.paused ? 'paused' : 'playing';
  $('toggle-path').setAttribute('d', audio.paused ? 'M4 2l10 6-10 6z' : 'M3 2h3.5v12H3zM9.5 2H13v12H9.5z');
  $('toggle').setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  $('mode').textContent = !t ? 'IDLE' : audio.paused ? 'PAUSED' : 'PLAYING';
  updatePosition();
}
function updatePosition() {
  if (!ms || !ms.setPositionState || !isFinite(audio.duration)) return;
  try { ms.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch {}
}

// ---------- sheets ----------
function openSheet(id) { $(id).classList.add('open'); if (id === 'settings') showStorage(); }
function closeSheets() { document.querySelectorAll('.sheet.open').forEach((s) => s.classList.remove('open')); }
$('open-lib').onclick = () => openSheet('library');
$('open-set').onclick = () => openSheet('settings');
document.querySelectorAll('.sheet .close').forEach((b) => (b.onclick = closeSheets));

// ---------- settings ----------
const ACCENTS = ['#ffffff', '#8d8d8d', '#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd'];
function readableOn(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? '#000000' : '#ffffff';
}
function applySettings() {
  const root = document.documentElement.style;
  root.setProperty('--acc', settings.accent);
  root.setProperty('--on-acc', readableOn(settings.accent));
  root.setProperty('--fs', settings.size + 'px');
  document.body.classList.toggle('nostatus', !settings.status);
  document.querySelectorAll('#swatches .sw').forEach((s) => s.classList.toggle('on', s.dataset.c === settings.accent || (s.classList.contains('custom') && !ACCENTS.includes(settings.accent))));
  document.querySelectorAll('#size button').forEach((b) => b.classList.toggle('on', +b.dataset.v === settings.size));
  $('s-status').classList.toggle('on', settings.status);
  $('s-resume').classList.toggle('on', settings.resume);
  $('s-smartprev').classList.toggle('on', settings.smartPrev);
  syncModes();
}
(() => {
  const wrap = $('swatches');
  for (const c of ACCENTS) {
    const b = document.createElement('button');
    b.className = 'sw'; b.dataset.c = c; b.style.background = c; b.setAttribute('aria-label', 'Accent ' + c);
    b.onclick = () => { settings.accent = c; saveSettings(); applySettings(); };
    wrap.append(b);
  }
  const custom = document.createElement('label');
  custom.className = 'sw custom'; custom.setAttribute('aria-label', 'Custom accent');
  const input = document.createElement('input'); input.type = 'color'; input.value = settings.accent;
  input.oninput = () => { settings.accent = input.value; saveSettings(); applySettings(); };
  custom.append(input); wrap.append(custom);
  document.querySelectorAll('#size button').forEach((b) => (b.onclick = () => { settings.size = +b.dataset.v; saveSettings(); applySettings(); }));
  const tog = (id, key) => ($(id).onclick = () => { settings[key] = !settings[key]; saveSettings(); applySettings(); });
  tog('s-status', 'status'); tog('s-resume', 'resume'); tog('s-smartprev', 'smartPrev');
})();

// ---------- UI ----------
const fmt = (s) => (s && isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const PLAY_SVG = '<svg class="ic" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg>';
const NOTE_SVG = '<svg viewBox="0 0 100 100"><use href="#i-note"/></svg>';

let collapsed = new Set(lsGet('om-collapsed', []));

let shownArt = null;
function updateNow() {
  const t = current();
  $('title').textContent = t ? t.title : 'nothing playing';
  $('sub').textContent = t ? [t.artist, t.album].filter(Boolean).join(' · ') || 'single' : tracks.length ? 'tap play or pick from the library' : 'open the library to add music';
  const u = t && t.artId ? artUrls.get(t.artId) : undefined;
  if (u !== shownArt || !$('art').firstChild) {
    shownArt = u;
    if (u) { const img = new Image(); img.src = u; img.alt = ''; $('art').replaceChildren(img); }
    else $('art').innerHTML = NOTE_SVG;
  }
  const d = audio.duration, c = audio.currentTime || pendingSeek || 0;
  const pct = isFinite(d) && d > 0 ? (c / d) * 100 : 0;
  $('fill').style.width = pct + '%';
  $('head').style.left = pct + '%';
  $('cur').textContent = fmt(c);
  $('dur').textContent = fmt(d || (t && t.duration));
  $('pos').textContent = `${qpos + 1}/${queue.length}`;
  $('qname').innerHTML = '<sup>1</sup>';
  $('qname').append(t ? (t.album || 'singles') + (settings.shuffle ? ' ~shuffled' : '') : 'queue');
}
function render() {
  $('count').innerHTML = '<sup>1</sup>';
  $('count').append(`${tracks.length} track${tracks.length === 1 ? '' : 's'}`);
  const ol = $('list');
  if (!tracks.length) {
    ol.replaceChildren(el('li', 'empty', '~ empty — tap [+folder] or [+files]'));
    updateNow();
    return;
  }
  const cur = current();
  const rows = [];
  for (const [name, list] of groups()) {
    const ids = list.map((t) => t.id);
    const isOpen = !collapsed.has(name);
    const playingHere = cur && (cur.album || SINGLES) === name;

    const h = el('li', 'grp' + (playingHere ? ' here' : ''));
    const label = el('span', 'gname', `${isOpen ? '▾' : '▸'} ${name || 'singles'}`);
    const cnt = el('span', 'gcnt', String(list.length));
    const play = el('button', 'btn gbtn'); play.innerHTML = PLAY_SVG; play.setAttribute('aria-label', `Play ${name || 'singles'}`);
    play.onclick = (e) => { e.stopPropagation(); startQueue(ids, settings.shuffle ? Math.floor(Math.random() * ids.length) : 0, 'album'); closeSheets(); };
    const del = el('button', 'btn gbtn', '×'); del.setAttribute('aria-label', `Delete ${name || 'singles'}`);
    del.onclick = (e) => { e.stopPropagation(); deleteTracks(list, name ? `"${name}"` : 'singles'); };
    h.append(label, cnt, play, del);
    h.onclick = () => { isOpen ? collapsed.add(name) : collapsed.delete(name); lsSet('om-collapsed', [...collapsed]); render(); };
    rows.push(h);

    if (!isOpen) continue;
    list.forEach((t, i) => {
      const on = t === cur;
      const li = el('li', 'trk' + (on ? ' cur' : ''));
      li.append(el('span', 'n', on ? '▸' : String(i + 1).padStart(2, '0')), el('span', 'nm', t.title), el('span', 'd', t.duration ? fmt(t.duration) : ''));
      li.onclick = () => { startQueue(ids, i, 'tap'); closeSheets(); };
      rows.push(li);
    });
  }
  ol.replaceChildren(...rows);
  updateNow();
}
async function showStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const h = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + 'G' : (b / 1048576).toFixed(0) + 'M');
  $('store').textContent = `${h(usage)}/${h(quota)}`;
  $('store2').textContent = `${h(usage)} / ${h(quota)}`;
  if (navigator.storage.persisted) {
    const p = await navigator.storage.persisted();
    $('persist').textContent = p ? 'protected from cleanup' : 'not marked persistent';
  }
}

// ---------- boot ----------
applySettings();
$('log').textContent = logLines.slice().reverse().join('\n');
(async () => {
  log(`boot · standalone=${navigator.standalone === true || matchMedia('(display-mode: standalone)').matches}`);
  if ('serviceWorker' in navigator) {
    // When a new service worker takes over, reload once so the new version shows immediately
    // (skipped mid-song so an update never interrupts playback).
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && audio.paused) location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((r) => r.update())
      .catch((e) => log('SW register failed: ' + e.message));
  }
  if (navigator.storage && navigator.storage.persist) {
    try { log('persist() → ' + (await navigator.storage.persist())); } catch {}
  }
  registerHandlers();
  db = await openDB();
  await loadLibrary();
  restoreResume();
  render();
  syncPlayState();
  showStorage();
})().catch((e) => log('boot error: ' + e.message));
