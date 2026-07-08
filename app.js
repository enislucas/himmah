/* Himmah. Copyright (c) 2026 Enis Lucas Ziadin. All rights reserved. */
/* Himmah - vanilla JS dashboard. No framework, no build.
   State is the whole tasks.json; we PUT it (debounced) and the server snapshots each save. */
"use strict";

// ---- importance scale (the PRIMARY axis: shown as heat + glow) ----
const IMP = {
  3: { label: "critical", color: "#e068ff" },
  2: { label: "high",     color: "#b06bff" },
  1: { label: "normal",   color: "#4a8fff" },
  0: { label: "someday",  color: "#5a6373" },
};
const IMP_DEFAULT = { 3: "#e068ff", 2: "#b06bff", 1: "#4a8fff", 0: "#5a6373" }; // factory colors (reset target)
// user-changeable urgency colors live in meta.ui.urgencyColors; applying them mutates IMP so every
// reference (cards, zones, stats, filters) picks them up automatically.
function applyUrgencyColors() {
  const u = (state.meta && state.meta.ui && state.meta.ui.urgencyColors) || {};
  [3, 2, 1, 0].forEach((n) => { IMP[n].color = u[n] || IMP_DEFAULT[n]; });
}
const DONE_COLOR = "#7cd99e";
// HABITS are a separate world from tasks: their own 3-level importance scale + a FIXED set of 5
// categories (tasks keep their dynamic, user-defined categories). "someday" makes no sense for a habit.
const HABIT_IMP = {
  2: { label: "fundamental",  color: "#b06bff" }, // purple - non-negotiable
  1: { label: "beneficial",   color: "#7cd99e" }, // green  - clearly good for me
  0: { label: "advantageous", color: "#f5c46f" }, // yellow - nice bonus
};
const HABIT_IMP_ORDER = [2, 1, 0];
const HABIT_CATS = [ // fixed; colours chosen distinct from the importance trio (tweakable later)
  { id: "hc_religion", name: "Religion",         color: "#34d399" },
  { id: "hc_finances", name: "Finances",         color: "#fb923c" },
  { id: "hc_education", name: "Education",        color: "#38bdf8" },
  { id: "hc_self",     name: "Self-Improvement", color: "#f472b6" },
  { id: "hc_social",   name: "Social",           color: "#818cf8" },
];
const habitCat = (id) => HABIT_CATS.find((c) => c.id === id) || null;
// Rhythms (v5.4.3) - a SEPARATE concept from Habits: habit-like but little/no dedicated time (done in
// parallel or attached to something existing), so they carry NO daily time budget. Miss-based, not streaks.
// Stored in their own state.rhythms array (never mixed with state.items). Own category namespace.
const RITUAL_CATS = [
  { id: "religious", name: "Religious", color: "#34d399" },
  { id: "natural",   name: "Natural",   color: "#7cd0f5" },
];
const ritualCat = (id) => RITUAL_CATS.find((c) => c.id === id) || RITUAL_CATS[0];
const isHabit = (t) => t === "rhythm"; // internal type stays "rhythm"; UI says "habit"
const canProtect = (i) => isHabit(i && i.type) || (i && i.type) === "project"; // v6.6.24: the Guardian shields ongoing goods (habits) + long-term ventures (projects/macros), NOT transient one-off tasks
const impMap = (type) => (isHabit(type) ? HABIT_IMP : IMP);
const impScale = (type) => (isHabit(type) ? HABIT_IMP_ORDER : [3, 2, 1, 0]);
const catList = (type) => (isHabit(type) ? HABIT_CATS : [...state.categories].sort((a, b) => a.order - b.order));
const SMOKE_COLORS = ["#e068ff", "#b06bff", "#4a8fff", "#62e3ff", "#7cd99e", "#f5c46f"];
const prefersReduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isToday = (iso) => (iso || "").slice(0, 10) === new Date().toISOString().slice(0, 10);
const FOCUS_CAP = 5; // soft

let state = { version: 1, categories: [], items: [], meta: {} };
let editingId = null;
let _editorSnap = null;        // {categoryId, importance} when the editor opened - to detect manual edits
let _ifthenProposal = null;    // last AI if-then proposal {callId,itemId,if,then} - to log accept-vs-edit on save
let focusExpanded = false;
let saveTimer = null;

// dual-axis view state: group by category (lanes) or by urgency (4 levels); filter by both.
let viewMode = "category"; // "category" | "urgency"
const filterUrg = new Set();
const filterCat = new Set();
const toggleSet = (s, v) => { s.has(v) ? s.delete(v) : s.add(v); };
const passFilter = (i) => (!filterUrg.size || filterUrg.has(i.importance)) && (!filterCat.size || filterCat.has(i.categoryId));

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const byId = (id) => document.getElementById(id);
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const cat = (id) => state.categories.find((c) => c.id === id) || null;
const item = (id) => state.items.find((i) => i.id === id) || null;
const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 9);
const nowIso = () => new Date().toISOString().slice(0, 19);

// v6.6.13: a transient "AI is thinking" overlay (3 pulsing dots) for multi-second calls like Calendarize.
function showAiLoading(msg) {
  let el = byId("aiLoading");
  if (!el) { el = document.createElement("div"); el.id = "aiLoading"; el.className = "ai-loading"; document.body.appendChild(el); }
  el.innerHTML = `<div class="ai-loading-card"><div class="ai-dots"><i></i><i></i><i></i></div><div class="ai-loading-msg">${esc(msg || "thinking...")}</div></div>`;
  el.hidden = false;
}
function hideAiLoading() { const el = byId("aiLoading"); if (el) el.hidden = true; }
function toast(msg) {
  const t = byId("toast");
  t.textContent = msg;
  t.hidden = false;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove("show"); setTimeout(() => (t.hidden = true), 250); }, 1700);
}
// v6.5.7: a richer toast that holds a clickable Undo for ~8s (one pending undo at a time).
let _undoTimer = null;
function undoToast(msg, restoreFn) {
  const t = byId("undoToast"); byId("undoToastMsg").textContent = msg;
  t._restore = restoreFn; t.hidden = false;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(_undoTimer); _undoTimer = setTimeout(() => hideUndoToast(), 8000);
}
function hideUndoToast() { const t = byId("undoToast"); t.classList.remove("show"); t._restore = null; clearTimeout(_undoTimer); setTimeout(() => (t.hidden = true), 250); }
// v6.5.10: voice capture via the browser's built-in Web Speech API (Windows speech engine on the laptop). No network from our code.
let _recog = null, _recogOn = false;
function setupVoiceCapture() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition, btn = byId("micBtn");
  if (!SR || !btn) return; // unsupported -> mic button stays hidden, no-op
  btn.hidden = false;
  _recog = new SR(); _recog.lang = "en-US"; _recog.interimResults = true; _recog.continuous = false;
  let base = "";
  _recog.onstart = () => { _recogOn = true; btn.classList.add("listening"); base = byId("captureInput").value; };
  _recog.onend = () => { _recogOn = false; btn.classList.remove("listening"); };
  _recog.onerror = () => { _recogOn = false; btn.classList.remove("listening"); };
  _recog.onresult = (e) => { let txt = ""; for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript; byId("captureInput").value = (base ? base + " " : "") + txt.trim(); };
}
function toggleVoiceCapture() { if (!_recog) return; if (_recogOn) _recog.stop(); else { try { byId("captureInput").focus(); _recog.start(); } catch (_) {} } }
// v6.6.4 (A4): an optional "brain dump in 60 seconds" helper - a small 🧠 button by the mic. A calm
// multi-line box that funnels each line straight through the EXISTING addCapture (split + parse + file).
// Not a first-run wall; never auto-shown; no AI, no new state.
function openBrainDump() {
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card bd-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">🧠 brain dump in 60 seconds</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="hist-note">One thought per line. Do not organise - just empty your head. Tag inline if you like: <code>/crit</code> <code>/urg2</code> <code>/&lt;category&gt;</code> <code>/eta 30m</code>.</div>
    <textarea id="bdBox" class="bd-box" spellcheck="false" placeholder="one thought per line…"></textarea>
    <div class="drawer-actions">
      <button class="glow-btn" data-act="bd-add-all">＋ Add all</button>
      <button class="ghost-btn" data-act="close-popup">Cancel</button>
    </div>
    <div class="hist-note">Empty lines are skipped. Tagged lines get auto-filed; the rest land in your Inbox - no guilt, sort them whenever.</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  const box = byId("bdBox");
  box.value = "call dentist /eta 15m\nemail thesis advisor /urg2\nbuy groceries by friday\n";
  box.focus(); const n = box.value.length; box.setSelectionRange(n, n);
}
function brainDumpAddAll() {
  const box = byId("bdBox"); if (!box) return;
  const text = box.value.trim();
  if (!text) { toast("nothing to add - jot a line first"); return; }
  closePopup();
  addCapture(text); // reuses the full capture pipeline: split on \n, parseCapture per line, file, count toast
}

// ---------- server ----------
async function loadState() {
  const r = await fetch("/api/state");
  state = await r.json();
  normalize();
  renderNow(); // v6.6.28: paint the board SYNCHRONOUSLY on boot. render() coalesces into a rAF (v6.6.17), which a throttled CPU or an occluded launch can stall - leaving a blank board. The first paint must never wait on a frame.
}
function normalize() {
  state.meta = state.meta || {};
  // Rhythms (v5.4.3): own array, seeded once. Religious + Natural, all daily, miss-based.
  if (!Array.isArray(state.rhythms)) {
    const seed = (title, cat) => ({ id: uid("ry"), title, cat, cadence: "daily", missDates: [],
      createdAt: nowIso(), updatedAt: nowIso() });
    state.rhythms = [
      seed("Adhkar after Fajr", "religious"), seed("Adhkar after Asr", "religious"),
      seed("12 sunnah (rawatib) prayers", "religious"),
      seed("Morning sunlight", "natural"), seed("Lights off 3h before sleep", "natural"),
      seed("No food 3h before sleep", "natural"),
    ];
    scheduleSave(); // v6.7.1: persist freshly-seeded rhythms so their ids/dates are stable across boots
  }
  state.rhythms.forEach((r) => { if (!Array.isArray(r.missDates)) r.missDates = []; if (!r.cadence) r.cadence = "daily"; });
  seedCalendar(); // v6.1.1: own schedules + events namespace
  // v6.7.1: self-heal - strip any transient calendarize preview events/schedules that leaked into a prior save
  state.events = (state.events || []).filter((e) => !e._calzPreview);
  state.schedules = (state.schedules || []).filter((s) => !s._calzPreview);
  if (state.meta.ui && state.meta.ui.viewMode) viewMode = state.meta.ui.viewMode;
  if (!["category", "urgency", "canvas"].includes(viewMode)) viewMode = "category"; // v6.7.1: canvas is first-class now, keep it (and urgency) across reloads; only unknown/legacy values fall back
  panX = 0; panY = 0; zoom = 1; // canvas ALWAYS opens at 100%, centred (locked decision)
  if (state.meta.ui && Array.isArray(state.meta.ui.toggled)) state.meta.ui.toggled.forEach((k) => toggled.add(k));
  applyUrgencyColors();
  // make sure every item has the fields we rely on (older/seed items)
  state.items.forEach((i) => {
    i.urgency = i.urgency || { due: null, soon: false };
    i.nextAction = i.nextAction || { if: "", then: "" };
    if (i.inFocus == null) i.inFocus = false;
    if (i.type == null) i.type = "task";
    if (i.history == null) i.history = [];
    if (i.waitingOn === undefined) i.waitingOn = null; // B3: lazy back-fill, idempotent
    if (i.type === "project" && i.isMacro == null) i.isMacro = false; // v6.6.8: consistency only (falsy == normal project)
    if (i.protected == null) i.protected = false; // v6.6.9: Priorities Guardian shield flag
    if (i.protected && !canProtect(i)) i.protected = false; // v6.6.24: Guardian no longer covers plain tasks - clear any orphaned shield (one-way; idempotent)
    if (i.type === "rhythm") i.streak = computeStreak(i); // v6.7.1: recompute the cached streak from history on load so the 🔥 chip never shows a stale/broken streak
  });
  state.meta.guardian = state.meta.guardian || { protectedIds: [], deal: null, ledger: [] }; // v6.6.9
  if (!Array.isArray(state.meta.guardian.protectedIds)) state.meta.guardian.protectedIds = [];
  if (!Array.isArray(state.meta.guardian.ledger)) state.meta.guardian.ledger = [];
  state.meta.guardian.protectedIds = state.items.filter((i) => i.protected).map((i) => i.id); // items are the source of truth
  // one-time: UNDO the old keyword "auto-rhythm" guess. Those items were really TASKS (workflows,
  // plans, pipelines) - not habits. Habits are now added deliberately by the user into the Parking Lot.
  if (!state.meta.revertedAutoRhythms) {
    state.items = state.items.filter((i) => !(i.type === "rhythm" && i.title === "New rhythm" && !(i.history && i.history.length) && !i.lastDone)); // drop stray test habit
    state.items.forEach((i) => {
      if (i.type === "rhythm") { i.type = "task"; i.queued = false; i.cadence = null; i.everyNDays = null;
        i.status = i.status === "done" ? "done" : (i.categoryId ? "active" : "inbox"); }
    });
    state.meta.revertedAutoRhythms = true;
    scheduleSave();
  }
}
function scheduleSave(label) {
  clearTimeout(saveTimer);
  byId("app").classList.add("saving");
  saveTimer = setTimeout(() => { saveTimer = null; doSave(label); }, 650); // v6.7.1: null the id so `if (saveTimer)` truly means "a save is pending"
}
function saveNow(label) { clearTimeout(saveTimer); saveTimer = null; return doSave(label); } // v6.5.2: persist immediately (no debounce) for state that must survive a quick app close
// v6.7.1: the snapshot we persist NEVER includes transient calendarize preview events/schedules (they exist only during a day-plan review)
function _persistable() {
  return Object.assign({}, state, {
    events: (state.events || []).filter((e) => !e._calzPreview),
    schedules: (state.schedules || []).filter((s) => !s._calzPreview),
  });
}
async function doSave() {
  try {
    state.meta = state.meta || {};
    state.meta.savedAt = nowIso();
    await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_persistable()),
    });
  } catch (e) { toast("⚠ save failed - is the server running?"); }
  byId("app").classList.remove("saving");
}
// flush pending save when leaving
window.addEventListener("beforeunload", () => {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null;
    navigator.sendBeacon && navigator.sendBeacon("/api/state", new Blob([JSON.stringify(_persistable())], { type: "application/json" }));
  }
});

// ---------- mutations ----------
function touch(i) { i.updatedAt = nowIso(); }

const isoDay = (d) => d.toISOString().slice(0, 10);
function parseEtaToken(v) {
  v = v.toLowerCase(); let m;
  if (m = v.match(/^(\d+(?:\.\d+)?)\s*h(?:r|rs|our|ours)?$/)) return { mins: Math.round(parseFloat(m[1]) * 60) };
  if (m = v.match(/^(\d+)\s*m(?:in|ins)?$/)) { const n = +m[1]; return n > 0 ? { mins: n } : {}; } // v6.7.1: /eta 0m is no estimate, not estimateMins=0
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { due: v };
  const today = new Date(); today.setHours(0, 0, 0, 0); // v6.7.1: anchor to LOCAL midnight + use _isod (was UTC isoDay -> off-by-one in non-UTC zones)
  const ahead = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return _isod(d); };
  if (v === "today") return { due: ahead(0) };
  if (v === "tomorrow" || v === "tmr") return { due: ahead(1) };
  const days = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const dk = v.slice(0, 3);
  if (days[dk] != null) { let add = (days[dk] - today.getDay() + 7) % 7; if (!add) add = 7; return { due: ahead(add) }; }
  return {};
}
// natural-language deadlines (v5.2, FREE - no AI): "by friday", "tomorrow", "in 3 days", "next week".
// Conservative on purpose: bare weekday names need by/due/before/on so prose isn't misread.
const _WDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
function parseNaturalDue(line) {
  const l = line.toLowerCase(); const today = new Date(); today.setHours(0, 0, 0, 0); let m; // v6.7.1: LOCAL midnight anchor + _isod
  const ahead = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return _isod(d); };
  if (m = l.match(/\b(?:by|due|before|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thur?s?|fri|sat)(?!['\w])/)) { // v6.7.1: lookahead blocks "monday's"/prose possessives
    let add = (_WDAYS[m[1]] - today.getDay() + 7) % 7; if (!add) add = 7;
    return { due: ahead(add), phrase: m[0] };
  }
  if (m = l.match(/\b(?:by\s+|due\s+)?(tomorrow|tmr)\b/)) return { due: ahead(1), phrase: m[0] };
  if (m = l.match(/\b(?:by\s+|due\s+)?(tonight|today)\b/)) return { due: ahead(0), phrase: m[0] };
  if (m = l.match(/\bin\s+(\d{1,2})\s+days?\b/)) return { due: ahead(+m[1]), phrase: m[0] };
  if (m = l.match(/\bnext week\b/)) return { due: ahead(7), phrase: m[0] };
  return null;
}
// /crit /urg1 /urg2 /urg3 /<category> /eta <val> /ench - raw text still works without any.
function parseCapture(line) {
  const out = { title: line, importance: null, categoryId: null, estimateMins: null, due: null, ench: false };
  const eta = line.match(/\/eta\s+([^\s\/]+)/i);
  if (eta) { const v = parseEtaToken(eta[1]); if (v.mins != null) out.estimateMins = v.mins; if (v.due) out.due = v.due; }
  (line.match(/\/[^\s]+/g) || []).forEach((tok) => {
    const t = tok.slice(1).toLowerCase();
    if (t === "crit") out.importance = 3;
    else if (t === "urg3") out.importance = 2;
    else if (t === "urg2") out.importance = 1;
    else if (t === "urg1") out.importance = 0;
    else if (t === "ench") out.ench = true; // enhance after capture (preview + approve)
    else if (t === "cal") out.cal = true; // v6.2.1: ask AI to suggest a scheduled block
    else if (t === "eta" || /^\d/.test(t)) { /* eta value handled above */ }
    else {
      const flat = t.replace(/\W+/g, "");
      const c = state.categories.find((c) => { const n = c.name.toLowerCase().replace(/\W+/g, ""); return n === flat || n.startsWith(flat) || flat.startsWith(n); });
      if (c) out.categoryId = c.id;
    }
  });
  // v6.4: /cal may carry an explicit time block ("/cal work tomorrow 06:00-16:00") - use it verbatim.
  let _tr = null, _tv = null;
  if (out.cal) {
    _tr = line.match(/\b(\d{1,2}):(\d{2})\s*(?:[-–]|to)\s*(\d{1,2}):(\d{2})\b/i);
    if (_tr && (+_tr[1] > 23 || +_tr[3] > 23 || +_tr[2] > 59 || +_tr[4] > 59)) _tr = null; // v6.7.1: reject impossible times (e.g. 25:00 / 12:99); let the AI scheduler handle it instead of clamping silently
    if (_tr) { const pad = (h, m) => String(+h).padStart(2, "0") + ":" + m; out.calStart = pad(_tr[1], _tr[2]); out.calEnd = pad(_tr[3], _tr[4]); }
    // v6.5.4: "travel N min/hour" extends the block on BOTH sides (leave early, get back late); "round trip" => half each side.
    _tv = line.match(/\btravel\s+(?:(?:round[\s-]?trip|both\s+ways|one[\s-]?way)\s+)?(\d+(?:\.\d+)?)\s*(min|mins|minutes|h|hr|hrs|hour|hours)\b/i);
    if (_tv) {
      let mins = parseFloat(_tv[1]) * (/^h/i.test(_tv[2]) ? 60 : 1);
      if (/\bround[\s-]?trip\b/i.test(line) || /\bboth\s+ways\b/i.test(line)) mins = mins / 2; // total there-and-back => half each side
      out.buffer = Math.round(mins);
    }
  }
  out.title = line.replace(/\/eta\s+[^\s\/]+/ig, " ").replace(/\/[^\s]+/g, " ");
  if (_tr) out.title = out.title.replace(_tr[0], " ");
  if (_tv) out.title = out.title.replace(_tv[0], " ").replace(/\bone[\s-]?way\b|\bround[\s-]?trip\b|\bboth\s+ways\b|\beach\s+(?:way|side)\b|\bper\s+way\b/ig, " ").replace(/\s*\+\s*/g, " ");
  out.title = out.title.replace(/\s+/g, " ").trim() || line;
  if (!out.due) { // plain-text deadline, only when /eta didn't already set one
    const nl = parseNaturalDue(out.title);
    if (nl) {
      out.due = nl.due;
      const stripped = out.title.replace(new RegExp(nl.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ").replace(/\s+/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
      if (stripped) out.title = stripped; // never leave an empty title
    }
  }
  return out;
}
// similar-task warning (v5.2, FREE): nudge when a capture overlaps an existing open task.
function findSimilar(title, excludeId) {
  const tw = new Set(words(title)); if (tw.size < 2) return null;
  let best = null, bestOv = 0;
  state.items.forEach((i) => {
    if (i.id === excludeId || i.status === "done" || i.type === "rhythm") return;
    const iw = new Set(words(i.title)); let ov = 0;
    iw.forEach((w) => { if (tw.has(w)) ov++; });
    const need = Math.min(3, Math.min(tw.size, iw.size)); // small titles: full overlap; big ones: 3 words
    if (ov >= Math.max(2, need) && ov > bestOv) { bestOv = ov; best = i; }
  });
  return best;
}
function addCapture(text) {
  text = text.trim();
  if (!text) return;
  let lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // v7.1.1: a line beginning /idea (or /i) is a random thought, NOT a task - route it to the Idea Parking Lot.
  const ideaLines = [];
  lines = lines.filter((l) => { const m = l.match(/^\/(idea|i)\b\s*(.*)$/i); if (m) { if (m[2].trim()) ideaLines.push(m[2].trim()); return false; } return true; });
  ideaLines.forEach((t) => addIdea(t));
  if (ideaLines.length) toast(`\u{1F4A1} parked ${ideaLines.length} idea${ideaLines.length > 1 ? "s" : ""} · open Ideas to sort`);
  if (!lines.length) return;
  let tagged = 0;
  let similar = null;
  const calIds = []; // v6.2.1: /cal items get an AI-suggested time block
  lines.forEach((line) => {
    const p = parseCapture(line);
    const categorized = !!p.categoryId;
    if (p.importance != null || p.categoryId || p.estimateMins != null || p.due) tagged++;
    const it = {
      id: uid("t"), type: "task", title: p.title, notes: "",
      categoryId: p.categoryId, importance: p.importance == null ? 1 : p.importance,
      urgency: { due: p.due || null, soon: false },
      status: categorized ? "active" : "inbox", nextAction: { if: "", then: "" }, estimateMins: p.estimateMins,
      projectId: null, subtaskIds: [], nextActionId: null,
      cadence: null, everyNDays: null, streak: 0, lastDone: null, history: [],
      inFocus: false, order: -1, createdAt: nowIso(), updatedAt: nowIso(),
      completedAt: null,
    };
    if (!similar) similar = findSimilar(p.title, it.id); // check BEFORE pushing so it can't match itself
    if (p.cal && p.calStart) it.calHint = { start: p.calStart, end: p.calEnd, buffer: p.buffer || 0 }; // v6.5.4
    else if (p.cal && p.buffer) it.calBuffer = p.buffer; // buffer but no explicit time -> hand it to the AI scheduler
    state.items.push(it);
    if (p.cal) calIds.push(it.id);
  });
  normalizeOrders();
  scheduleSave();
  render();
  if (similar) toast(`Captured - ⚠ similar to “${similar.title.length > 42 ? similar.title.slice(0, 42) + "…" : similar.title}”`);
  else toast(lines.length > 1 ? `Captured ${lines.length}${tagged ? " (" + tagged + " auto-filed)" : ""}` : (tagged ? "Captured + filed" : "Captured → Inbox"));
  // v5.4.1: NO auto AI on capture - enhance/enrich/triage are on-demand. EXCEPTION: /cal opts in explicitly.
  calIds.forEach((id) => scheduleSuggest(id));
}
// v6.2.1: ask DeepSeek for a time-block + ETA; the task sits in the inbox showing the suggestion.
async function scheduleSuggest(id) {
  const i = item(id); if (!i) return;
  // v6.4: an explicit time from /cal is used verbatim (deterministic, works offline - no AI spend).
  if (i.calHint && i.calHint.start) {
    const buf = +i.calHint.buffer || 0; // v6.5.4: travel buffer extends the block both sides
    const rawEnd = i.calHint.end || _minToHM(_hmToMin(i.calHint.start) + 30);
    const sMin = _hmToMin(i.calHint.start) - buf, eMin = _hmToMin(rawEnd) + buf;
    const clipped = buf && (sMin < 0 || eMin > 24 * 60 - 1); // v6.5.13: do not advertise a buffer the day's edges clip away
    const start = _minToHM(sMin), end = _minToHM(eMin);
    const due = (i.urgency && i.urgency.due) ? String(i.urgency.due).slice(0, 10) : _isod(new Date());
    const eta = Math.max(15, _hmToMin(end) - _hmToMin(start));
    i.schedSuggest = { date: due, start, end, eta, reason: buf ? `your /cal block plus ${buf} min travel each side${clipped ? " (clipped to the day)" : ""}` : "the time you set in /cal", callId: null };
    i.estimateMins = eta; delete i.calHint; touch(i); scheduleSave(); render(); refreshInboxCount();
    toast("📅 a slot is proposed - review it in the Inbox"); return;
  }
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ /cal needs AI - see Setup Guides"); return; }
  toast("✦ finding a slot…");
  const now = new Date();
  let res;
  try { res = await aiFetch("schedule", { title: i.title, today: _isod(now), weekday: CAL_FULLDOW[now.getDay()], travel_min: i.calBuffer || 0 }); delete i.calBuffer; }
  catch (e) { toast("⚠ " + e.message); return; }
  if (!res || !res.date || !res.start) { toast("✦ no slot suggested"); return; }
  const eta = +res.eta_minutes || null;
  const RE = /^\d{1,2}:\d{2}$/; // v6.7.1: validate the AI's times before building an event (no malformed/backwards slots)
  let st = res.start, en = res.end || _minToHM(_hmToMin(res.start) + (eta || 30));
  if (!RE.test(st) || !RE.test(en) || _hmToMin(st) >= 24 * 60 || _hmToMin(en) > 24 * 60) { toast("✦ no valid slot"); return; }
  en = _minToHM(Math.max(_hmToMin(st) + 15, _hmToMin(en)));
  const date = String(res.date).length === 5 ? now.getFullYear() + "-" + res.date : res.date;
  i.schedSuggest = { date, start: st, end: en, eta, reason: res.reason || "", callId: lastCallId() };
  if (eta) i.estimateMins = eta;
  touch(i); scheduleSave(); render(); refreshInboxCount();
  toast("📅 a slot is proposed - review it in the Inbox");
}
// v6.7.1: resolve the auto "Tasks" schedule by a STABLE id (state.meta.taskScheduleId), not its editable display name -
// so renaming any schedule to/from "Tasks" can't break the binding or spawn a duplicate. Name-match migrates old data once.
function taskSchedule() {
  state.meta = state.meta || {}; state.schedules = state.schedules || [];
  let sch = state.meta.taskScheduleId && state.schedules.find((x) => x.id === state.meta.taskScheduleId);
  if (!sch) sch = state.schedules.find((x) => x.name === "Tasks");
  if (!sch) { sch = { id: uid("sch"), name: "Tasks", color: "#f5c46f", hidden: false }; state.schedules.push(sch); }
  state.meta.taskScheduleId = sch.id;
  return sch;
}
function acceptSchedule(id) {
  const i = item(id), s = i && i.schedSuggest; if (!s) return;
  const sch = taskSchedule();
  state.events = state.events || [];
  state.events.push({ id: uid("ev"), scheduleId: sch.id, title: i.title, date: s.date, start: s.start, end: s.end, allDay: false, notes: "scheduled from a task", taskId: i.id });
  logOutcome({ call_id: s.callId, item_id: i.id, kind: "schedule", decision: "accept",
    ai_proposed: { date: s.date, start: s.start, end: s.end, eta: s.eta }, my_final: { date: s.date, start: s.start, end: s.end }, my_reason: null, original_input: i.title });
  delete i.schedSuggest; touch(i); scheduleSave(); render(); refreshInboxCount();
  toast(`📅 scheduled · ${s.date} ${s.start}`);
}
function denySchedule(id) {
  const i = item(id), s = i && i.schedSuggest; if (!s) return;
  const callId = s.callId, proposed = { date: s.date, start: s.start, end: s.end, eta: s.eta }, title = i.title;
  delete i.schedSuggest; touch(i); scheduleSave(); render();
  askWhy(`why not schedule "${title}" at ${proposed.date} ${proposed.start}? (helps Himmah learn how you like to schedule)`).then((reason) =>
    logOutcome({ call_id: callId, item_id: id, kind: "schedule", decision: "reject", ai_proposed: proposed, my_final: null, my_reason: reason, original_input: title }));
}

function toggleDone(id) {
  const i = item(id); if (!i) return;
  if (i.type === "rhythm") return markRhythmToday(id);
  if (i.status === "done") { i.status = "active"; i.completedAt = null; touch(i); scheduleSave(); render(); return; }
  // completing → smoke
  const finish = () => { i.status = "done"; i.completedAt = nowIso(); i.inFocus = false; const n = clearFutureTaskEvents(i.id); const freed = releaseDependents(i.id); touch(i); scheduleSave(); render(); if (freed.length) toast(`✓ done · freed ${freed.length} waiting task${freed.length > 1 ? "s" : ""}`); else if (n) toast(`✓ done · cleared ${n} upcoming slot${n > 1 ? "s" : ""}`); }; // B3: completing a blocker frees its dependents (one-way; un-completing does not re-block)
  const el = document.querySelector(`.card[data-id="${id}"]`);
  if (el && el.classList.contains("smoking")) return; // v6.7.1: a second click during the 880ms smoke must not schedule finish() twice
  if (el && !prefersReduced()) { playSmoke(el); el.classList.add("smoking"); setTimeout(finish, 880); }
  else finish();
}
// v6.5.12: completing a task clears its FUTURE one-off calendar events (date >= today). Recurring occurrences
// (seriesId) are left alone (the series is its own commitment); un-completing does NOT recreate them.
function clearFutureTaskEvents(taskId) {
  const today = _isod(new Date()), evs = state.events || []; // v6.5.13: local date (events store local dates) - avoids a TZ off-by-one
  const doomed = evs.filter((e) => e.taskId === taskId && !e.seriesId && (e.date || "") >= today);
  if (!doomed.length) return 0;
  const ids = new Set(doomed.map((e) => e.id));
  state.events = evs.filter((e) => !ids.has(e.id));
  return doomed.length;
}
function playSmoke(el) {
  const layer = byId("smokeLayer"); if (!layer) return;
  const r = el.getBoundingClientRect();
  for (let n = 0; n < 16; n++) {
    const p = document.createElement("span"); p.className = "smoke-particle";
    p.style.left = (r.left + Math.random() * r.width) + "px";
    p.style.top = (r.top + r.height * 0.45 + (Math.random() - 0.4) * r.height * 0.5) + "px";
    p.style.setProperty("--c", SMOKE_COLORS[n % SMOKE_COLORS.length]);
    p.style.setProperty("--dx", (Math.random() * 70 - 35) + "px");
    p.style.setProperty("--dur", (1.05 + Math.random() * 0.55) + "s");
    p.style.animationDelay = (Math.random() * 0.2) + "s";
    layer.appendChild(p); setTimeout(() => p.remove(), 1800);
  }
}
function restoreItem(id) {
  const i = item(id); if (!i) return;
  i.status = (i.categoryId || i.projectId) ? "active" : "inbox"; i.completedAt = null; touch(i); scheduleSave(); render(); // v6.7.1: a project subtask restores active under its project, not loose in the Inbox
  if (!prefersReduced()) setTimeout(() => { const el = document.querySelector(`.card[data-id="${id}"]`); if (el) el.classList.add("materialize"); }, 20);
}
function cycleImp(id) {
  const i = item(id); if (!i) return;
  i.importance = (i.importance + 1) % 4; // 0..3
  if (i.importance > 0) delete i.parkedAt; // v6.7.1: raising a pushed-out task's importance re-admits it to the week budget
  touch(i); scheduleSave(); render();
}
function togglePin(id) {
  const i = item(id); if (!i) return;
  i.inFocus = !i.inFocus;
  if (i.inFocus && i.status === "inbox") i.status = "active";
  touch(i); scheduleSave(); render();
}
// ---- streaks (period-aware). All date math is on YYYY-MM-DD strings in UTC to match the rest of the app. ----
const _DAY = 864e5;
const _dnum = (ds) => new Date(ds + "T00:00:00Z").getTime();
const _dstr = (ms) => new Date(ms).toISOString().slice(0, 10);
const _todayStr = () => new Date().toISOString().slice(0, 10);
const _weekKey = (ds) => { const t = _dnum(ds); const dow = (new Date(t).getUTCDay() + 6) % 7; return _dstr(t - dow * _DAY); }; // Monday
const _monthKey = (ds) => ds.slice(0, 7); // YYYY-MM
function dailyStreak(histSet) {
  let t = _dnum(_todayStr());
  if (!histSet.has(_dstr(t))) t -= _DAY; // today not ticked yet → don't break the chain
  let s = 0; while (histSet.has(_dstr(t))) { s++; t -= _DAY; } return s;
}
function periodStreak(hist, unit, target) {
  const keyOf = unit === "month" ? _monthKey : _weekKey;
  const counts = {}; hist.forEach((ds) => { const k = keyOf(ds); counts[k] = (counts[k] || 0) + 1; });
  const back = unit === "month"
    ? (key) => { let [y, m] = key.split("-").map(Number); if (--m < 1) { m = 12; y--; } return y + "-" + String(m).padStart(2, "0"); }
    : (key) => _dstr(_dnum(key) - 7 * _DAY);
  let cur = keyOf(_todayStr());
  if ((counts[cur] || 0) < target) cur = back(cur); // current period still in progress → grace
  let s = 0; while ((counts[cur] || 0) >= target) { s++; cur = back(cur); } return s;
}
function computeStreak(r) {
  const hist = r.history || []; if (!hist.length) return 0;
  if (r.cadence === "weekly") return periodStreak(hist, "week", r.perWeek || 1);
  if (r.cadence === "monthly") return periodStreak(hist, "month", r.perMonth || 1);
  return dailyStreak(new Set(hist));
}
function periodProgress(r) { // "2/3 this week" for weekly/monthly habits; null for daily
  const hist = r.history || [];
  if (r.cadence === "weekly") { const k = _weekKey(_todayStr()); return hist.filter((d) => _weekKey(d) === k).length + "/" + (r.perWeek || 1) + " this week"; }
  if (r.cadence === "monthly") { const k = _monthKey(_todayStr()); return hist.filter((d) => _monthKey(d) === k).length + "/" + (r.perMonth || 1) + " this month"; }
  return null;
}
const streakUnit = (r) => (r.cadence === "weekly" ? "w" : r.cadence === "monthly" ? "mo" : "");
function markRhythmToday(id) {
  const i = item(id); if (!i) return;
  const today = _todayStr();
  i.history = i.history || [];
  if (i.history.includes(today)) i.history = i.history.filter((d) => d !== today); // toggle today off
  else i.history.push(today);
  i.history.sort();
  i.lastDone = i.history.length ? i.history[i.history.length - 1] : null;
  i.streak = computeStreak(i); // always recompute from history - robust + period-aware
  touch(i); scheduleSave(); render();
}
function delItem(id) {
  const kill = new Set([id, ...descendantIds(id)]); // v6.6.8: cascade to grandchildren (macro -> projects -> tasks)
  const removed = state.items.filter((i) => kill.has(i.id)); // v6.5.7: capture for undo
  if (!removed.length) return;
  state.items = state.items.filter((i) => !kill.has(i.id));
  if (state.events) state.events = state.events.filter((ev) => !(ev.guardResume && kill.has(ev.taskId))); // v6.7.1: prune orphaned Guardian "Resume:" events for deleted goods
  const _deal = guardActiveDeal();
  if (_deal && Array.isArray(_deal.plan)) _deal.plan = _deal.plan.filter((e) => !kill.has(e.id)); // v6.7.1: drop now-dead deal-plan entries so the deal card counts stay honest
  scheduleSave(); render();
  const label = removed.length > 1 ? removed.length + " items" : (removed[0].title || "item");
  undoToast('Deleted "' + label + '"', () => { removed.forEach((i) => state.items.push(i)); scheduleSave(); render(); });
}

// add a rhythm - lands PARKED (queued) by default so it adds zero budget load until you
// choose to activate it (the "park a future idea, guilt-free" flow + the overload lesson).
function addRhythm() {
  const r = {
    id: uid("r"), type: "rhythm", title: "New habit", notes: "",
    categoryId: null, importance: 1, urgency: { due: null, soon: false }, // importance 1 = "beneficial" (habit scale)
    status: "active", nextAction: { if: "", then: "" }, estimateMins: 15,
    projectId: null, subtaskIds: [], nextActionId: null,
    cadence: "daily", perWeek: null, perMonth: null, everyNDays: null, streak: 0, lastDone: null, history: [],
    queued: true, inFocus: false, order: -1, createdAt: nowIso(), updatedAt: nowIso(), completedAt: null,
  };
  state.items.push(r); scheduleSave(); render();
  setTimeout(() => { openEditor(r.id); const t = byId("e-title"); if (t) { t.focus(); t.select(); } }, 30);
}

// categories
function addCategory() {
  const c = { id: uid("c"), name: "New category", color: pickColor(), order: state.categories.length, collapsed: false };
  state.categories.push(c); scheduleSave(); render();
  setTimeout(() => startRename(c.id), 30);
}
function pickColor() {
  const used = state.categories.map((c) => c.color);
  const pal = ["#8B5CF6", "#3B82F6", "#FACC15", "#22C55E", "#F472B6", "#38BDF8", "#FB923C", "#A78BFA"];
  return pal.find((c) => !used.includes(c)) || pal[state.categories.length % pal.length];
}
function toggleCollapse(id) { const c = cat(id); if (c) { c.collapsed = !c.collapsed; scheduleSave(); render(); } }
function delCategory(id) {
  if (!confirm("Delete this category? Its tasks move to the Inbox.")) return;
  const c = cat(id); if (!c) return;
  const idx = state.categories.indexOf(c); // v6.5.7: capture for undo (category + position + item mutations)
  const touched = state.items.filter((i) => i.categoryId === id).map((i) => ({ ref: i, categoryId: i.categoryId, status: i.status }));
  touched.forEach(({ ref }) => { ref.categoryId = null; ref.status = ref.status === "done" ? "done" : "inbox"; });
  state.categories = state.categories.filter((x) => x.id !== id);
  scheduleSave(); render();
  undoToast('Deleted category "' + (c.name || "category") + '"', () => {
    state.categories.splice(idx, 0, c);
    touched.forEach((t) => { t.ref.categoryId = t.categoryId; t.ref.status = t.status; });
    scheduleSave(); render();
  });
}
function recolorCategory(id) {
  const c = cat(id); if (!c) return;
  const pal = ["#8B5CF6", "#3B82F6", "#FACC15", "#22C55E", "#F472B6", "#38BDF8", "#FB923C", "#A78BFA", "#FB7185", "#34D399"];
  c.color = pal[(pal.indexOf(c.color) + 1) % pal.length];
  scheduleSave(); render();
}
function startRename(id) {
  const el = document.querySelector(`[data-rename="${id}"]`);
  if (!el) return;
  el.contentEditable = "true"; el.focus();
  document.execCommand && document.getSelection().selectAllChildren(el);
  const finish = () => {
    el.contentEditable = "false";
    const c = cat(id); if (c) { c.name = el.textContent.trim() || c.name; }
    scheduleSave(); render();
  };
  el.addEventListener("blur", finish, { once: true });
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
}

// ---------- focus engine (importance-protected) ----------
function isImportantNotUrgent(i) {
  return i.importance >= 2 && !(i.urgency && (i.urgency.soon || i.urgency.due));
}
// B3 (v6.6.6): a task waiting on a dependency or an external reply is parked OUT of the focus pool (no-guilt).
// Self-healing: if a task-type blocker was deleted or is already done, the dependent is no longer waiting.
function isWaiting(i) {
  const w = i && i.waitingOn;
  if (!w) return false;
  if (w.type === "task") { const b = item(w.taskId); return !!(b && b.status !== "done"); }
  return w.type === "note" && !!(w.note || "").trim();
}
function waitingList() {
  return state.items.filter((i) => (i.type === "task" || i.type === "project") && i.status === "active" && isWaiting(i));
}
// When a blocker completes, quietly free everything waiting on it (back into the focus pool).
function releaseDependents(blockerId) {
  const freed = state.items.filter((i) => i.waitingOn && i.waitingOn.type === "task" && i.waitingOn.taskId === blockerId && i.status === "active");
  freed.forEach((i) => { i.waitingOn = null; touch(i); });
  return freed;
}
let _aiFocus = null; // v6.2.2: AI-picked "small wins" (array of ids) - overrides the heuristic for the session
let _aiFocusGen = 0; // v6.7.12: bumped on every successful pick-my-5 so the tour's pick5 do-step advances even when the AI returns the same ids twice
let _focusAIBusy = false; // v6.9.3 R6: one pick-my-5 at a time - concurrent taps would each fire a REAL /api/ai call (the owner tapped it ~7 times because nothing visibly reacted)
function computeFocus() {
  const active = state.items.filter((i) => i.status === "active" && i.type !== "rhythm" && !isWaiting(i) && !isMacro(i) && !isNestedUnderMacro(i) && !i.guardPaused); // B3 + v6.6.8 + v6.6.9: parked/blocked, macro containers/descendants, AND guardian-paused tasks never compete for NOW
  if (_aiFocus && _aiFocus.length) {
    const list = _aiFocus.map((id) => active.find((x) => x.id === id)).filter(Boolean).slice(0, FOCUS_CAP);
    if (list.length >= 2) return { list, pinnedCount: 0, totalActive: active.length, ai: true };
    _aiFocus = null; // v6.5.13: AI picks dwindled to <2 -> back to the heuristic (NOW bar never sticks on a stale 1)
  }
  const pinned = active.filter((i) => i.inFocus);
  const rest = active.filter((i) => !i.inFocus)
    .sort((a, b) => b.importance - a.importance || (a.order - b.order));
  const out = [...pinned];
  for (const i of rest) { if (out.length >= FOCUS_CAP) break; out.push(i); }
  // guarantee at least one important-not-urgent (protect faith/knowledge/long-term)
  if (!out.some(isImportantNotUrgent)) {
    const champ = rest.find(isImportantNotUrgent);
    if (champ) {
      if (out.length >= FOCUS_CAP) { // swap the lowest-importance non-pinned out
        const swapIdx = [...out].map((x, idx) => [x, idx]).filter(([x]) => !x.inFocus)
          .sort((a, b) => a[0].importance - b[0].importance)[0];
        if (swapIdx) out[swapIdx[1]] = champ;
      } else out.push(champ);
    }
  }
  return { list: out, pinnedCount: pinned.length, totalActive: active.length };
}

// v6.5.9: short-term tasks gone quiet deserve a gentle prune nudge. We do NOT nag long-horizon items
// (someday-importance, a far-off due date, a "summer/long-term/someday/later" category or title).
const LONGTERM_RE = /summer|long.?term|someday|later|eventually|one.?day/i;
function _dayShift(n) { return _isod(new Date(Date.now() + n * 864e5)); }
function isLongHorizon(i) {
  if (i.importance <= 0) return true; // someday importance
  const c = cat(i.categoryId);
  if (c && LONGTERM_RE.test(c.name)) return true;
  if (LONGTERM_RE.test(i.title || "")) return true;
  const due = i.urgency && i.urgency.due;
  if (due) return due > _dayShift(21); // a far-out due date = not short-term
  return false;
}
function stalePruneList() {
  const today = _todayStr(), cut10 = _dayShift(-10), soon3w = _dayShift(21);
  return state.items.filter((i) =>
    i.status === "active" && i.type === "task" && i.importance >= 1 &&
    (i.updatedAt || "") < cut10 && !isLongHorizon(i) && (i.pruneSnoozed || "") < today &&
    (((i.urgency && i.urgency.due) && i.urgency.due <= soon3w) || !(i.urgency && i.urgency.due))
  ).sort((a, b) => (a.updatedAt || "").localeCompare(b.updatedAt || ""));
}
function renderPruneNudge() {
  const el = byId("pruneNudge"); if (!el) return;
  const list = stalePruneList().slice(0, 6);
  el.hidden = false; // v6.6.4: lives in the Tidy side-panel now; show a friendly empty state instead of collapsing
  if (!list.length) { el.innerHTML = `<div class="prune-empty empty">Nothing to tidy - your active list is fresh.</div>`; return; }
  const rows = list.map((i) => {
    const c = cat(i.categoryId);
    const age = Math.max(1, Math.round((Date.now() - new Date(i.updatedAt || nowIso()).getTime()) / 864e5));
    return `<div class="prune-row" data-id="${i.id}">
      <span class="prune-dot" style="background:${c ? c.color : IMP[i.importance].color}"></span>
      <span class="prune-title">${esc(i.title)}</span>
      <span class="prune-age">quiet ${age}d</span>
      <span class="prune-acts">
        <button class="ghost-btn sm" data-act="prune-keep" data-id="${i.id}" title="still relevant - keep it active">keep</button>
        <button class="ghost-btn sm" data-act="prune-snooze" data-id="${i.id}" title="ask me again in a week">snooze 7d</button>
        <button class="ghost-btn sm prune-arch" data-act="prune-archive" data-id="${i.id}" title="archive it - find it later in History">archive</button>
      </span></div>`;
  }).join("");
  el.innerHTML = `<div class="prune-head"><span class="kicker">quiet for a while</span>
      <span class="prune-hint">${list.length} short-term task${list.length > 1 ? "s" : ""} untouched ~10+ days - tidy when you like</span></div>
    <div class="prune-list">${rows}</div>`;
}
// ---------- rendering ----------
// v6.6.17 (perf): coalesce render() into ONE animation frame. Most actions do mutate -> scheduleSave -> render
// in a burst, and a drag fires it many times a second; collapsing repeated render() calls to a single frame
// removes the jank that made the app feel slow. renderNow() holds the actual work; anything that must paint
// synchronously can call renderNow() directly (audited: no caller reads freshly-rendered board geometry right
// after render(); the one render()-then-read touches the persistent search input, which render() never rebuilds).
let _renderRAF = 0;
function render() { if (_renderRAF) return; _renderRAF = requestAnimationFrame(() => { _renderRAF = 0; renderNow(); }); }
function renderNow() {
  renderStats();
  renderFocus();
  renderPruneNudge(); // v6.5.9 -> now writes into the #tidyPanel side-panel
  refreshTidyCount(); // v6.6.4: topbar count of quiet tasks
  refreshIdeaCount(); // v7.1.1: topbar count of parked ideas
  if (!byId("ideasFull").hidden) renderIdeasFull(); // v7.1.1: keep the Idea Parking Lot live
  renderRhythms();
  renderRituals();
  renderCanvas();
  refreshInboxCount();
  if (!byId("inboxPanel").hidden) renderInboxPanel();
  if (!byId("inboxFull").hidden) renderInboxFull(); // v6.6.5: keep the full-screen inbox live
  refreshWaitingCount(); // B3
  if (!byId("waitingPanel").hidden) renderWaitingPanel();
}
function refreshTidyCount() { // v6.6.4: mirror refreshInboxCount for the Tidy topbar pill
  const n = stalePruneList().length;
  const el = byId("tidyCount"); if (el) { el.textContent = n || ""; el.style.display = n ? "" : "none"; }
  refreshMoreCount();
}
function refreshWaitingCount() { // B3 (v6.6.6): topbar pill of parked/blocked tasks
  const n = waitingList().length;
  const el = byId("waitingCount"); if (el) { el.textContent = n || ""; el.style.display = n ? "" : "none"; }
  refreshMoreCount();
}
function refreshMoreCount() { // v6.9.1: the "⋯ More" button carries a combined waiting+tidy badge so those counts stay visible while collapsed
  const n = waitingList().length + stalePruneList().length;
  const el = byId("moreCount"); if (el) { el.textContent = n || ""; el.style.display = n ? "" : "none"; }
}
function refreshInboxCount() {
  const n = state.items.filter((i) => i.status === "inbox").length;
  const el = byId("inboxCount"); if (el) { el.textContent = n || ""; el.style.display = n ? "" : "none"; }
}

function fmtMins(m) { if (!m) return "0h"; const h = Math.floor(m / 60), mm = m % 60; return ((h ? h + "h" : "") + (mm ? " " + mm + "m" : "")).trim() || "0h"; }
function renderStats() {
  const el = byId("stats");
  const tasks = state.items.filter((i) => i.type === "task" || i.type === "project");
  const crit = tasks.filter((i) => i.importance === 3);
  const critDone = crit.filter((i) => i.status === "done").length;
  const critPct = crit.length ? Math.round((critDone / crit.length) * 100) : 0;
  const weekEnd = _dayShift(7); // v6.7.1: LOCAL 7-day horizon (matches the now-local due strings + the overcommit horizon; was UTC isoDay -> 1-day boundary drift)
  const weekMins = tasks.filter((i) => i.status === "active" && i.urgency && i.urgency.due && i.urgency.due <= weekEnd).reduce((s, i) => s + (i.estimateMins || 0), 0);
  const activeCount = tasks.filter((i) => i.status === "active").length;
  const doneToday = state.items.filter((i) => i.status === "done" && isToday(i.completedAt)).length;
  const gd = guardData(); const wkAgo = Date.now() - 7 * 864e5; // v6.6.9: identity meter (what you KEPT, never a deficit)
  const honored = (gd.ledger || []).filter((l) => l.ts && new Date(l.ts).getTime() >= wkAgo && (l.type === "keep" || l.type === "reduce" || l.type === "resume" || l.type === "protect")).length;
  const dealOn = !!gd.deal;
  el.innerHTML = `
    <div class="stat">
      <div class="stat-top"><span class="kicker" style="color:${IMP[3].color}">critical cleared</span><b>${critDone}/${crit.length}</b></div>
      <div class="prog"><div class="prog-bar" style="width:${critPct}%; background:${IMP[3].color}; box-shadow:0 0 10px ${IMP[3].color}"></div></div>
    </div>
    <div class="stat"><div class="stat-top"><span class="kicker">this week</span><b>${fmtMins(weekMins)}</b></div><div class="stat-sub">estimated · due ≤ 7 days</div></div>
    <div class="stat"><div class="stat-top"><span class="kicker">active</span><b>${activeCount}</b></div><div class="stat-sub">tasks in motion</div></div>
    <button class="stat clickable" data-act="open-donetoday"><div class="stat-top"><span class="kicker" style="color:#7cd99e">done today</span><b>${doneToday}</b></div><div class="stat-sub">tap to view ↗</div></button>
    <button class="stat clickable guard-stat" data-act="open-guardian"><div class="stat-top"><span class="kicker" style="color:var(--gold)">⛨ guarded</span><b>${honored}</b></div><div class="stat-sub">${dealOn ? "deal window - returns " + gd.deal.returnDate : "goods kept alive this week"}</div></button>`;
}

function perDayMin(r) {
  const m = r.estimateMins || 0;
  if (r.cadence === "weekly") return m * (r.perWeek || 1) / 7;   // X sessions per week
  if (r.cadence === "monthly") return m * (r.perMonth || 1) / 30; // Y sessions per month
  return m; // daily (default)
}
function freqLabel(r) {
  if (r.cadence === "weekly") return (r.perWeek || 1) + "×/week";
  if (r.cadence === "monthly") return (r.perMonth || 1) + "×/month";
  return "daily";
}
function renderRhythms() {
  const el = byId("rhythms"); if (!el) return;
  const habits = state.items.filter((i) => i.type === "rhythm"); // internal type stays "rhythm"; UI says "habit"
  el.hidden = false;
  const active = habits.filter((r) => !r.queued);   // habits you've committed to (count toward the daily budget)
  const parked = habits.filter((r) => r.queued);    // the Habit Parking Lot - future ideas, no load
  const budget = (state.meta && state.meta.rhythmBudget) || 60;
  const today = new Date().toISOString().slice(0, 10);
  const rcard = (r) => {
    const doneToday = r.lastDone === today;
    const imp = HABIT_IMP[r.importance] != null ? HABIT_IMP[r.importance] : HABIT_IMP[1];
    const hc = habitCat(r.categoryId);
    const accent = hc ? hc.color : imp.color;
    return `<div class="rhythm-card ${doneToday ? "done-today" : ""}" data-id="${r.id}" style="--cat:${accent}; --imp:${imp.color}">
      <button class="rhythm-check" data-act="rhythm-done" data-id="${r.id}" title="mark done today">${doneToday ? "✓" : "○"}</button>
      <div class="rhythm-body" data-act="edit" data-id="${r.id}">
        <div class="rhythm-title">${esc(r.title)}</div>
        <div class="rhythm-meta">
          <span class="chip imp-chip" style="--imp:${imp.color}">${imp.label}</span>
          ${hc ? `<span class="chip cat"><i style="background:${hc.color}"></i>${esc(hc.name)}</span>` : ""}
          <span class="chip">↻ ${esc(freqLabel(r))}</span>
          ${periodProgress(r) ? `<span class="chip prog-chip">${periodProgress(r)}</span>` : ""}
          ${r.estimateMins ? `<span class="chip">${r.estimateMins}m</span>` : ""}
          ${r.streak ? `<span class="chip" title="streak">🔥 ${r.streak}${streakUnit(r)}</span>` : ""}
        </div>
      </div>
      <button class="rhythm-toggle" data-act="rhythm-queue" data-id="${r.id}" title="${r.queued ? "activate - start doing it (counts toward your daily budget)" : "park it back in the Parking Lot (no load)"}">${r.queued ? "▲ activate" : "park"}</button>
    </div>`;
  };
  const addBtn = `<button class="ghost-btn sm add-rhythm" data-act="add-rhythm" title="add a habit - lands in your Parking Lot, zero daily load until you activate it">＋ habit</button>`;
  // the daily-load meter only matters once you've activated a habit (your overload guard)
  let meter = "";
  if (active.length) {
    const load = Math.round(active.reduce((s, r) => s + perDayMin(r), 0));
    const pct = budget ? Math.min(100, Math.round((load / budget) * 100)) : 0;
    const over = load > budget;
    const meterColor = over ? IMP[3].color : (pct > 80 ? "#f5c46f" : "#7cd99e");
    meter = `<div class="load-meter ${over ? "over" : ""}">
        <div class="load-bar" style="width:${pct}%; background:${meterColor}; box-shadow:0 0 12px ${meterColor}"></div>
        <span class="load-label">${fmtMins(load)} / ${fmtMins(budget)} active${over ? " · over budget - park one" : ""}</span>
      </div>
      <div class="rhythm-list">${active.map(rcard).join("")}</div>`;
  }
  const lot = `<details class="queued-wrap habit-lot" open>
      <summary><span class="lot-tag">🅿 Habit Parking Lot</span>${parked.length ? `<span class="lot-count">${parked.length}</span>` : ""}<span class="lot-hint">future habit ideas wait here - guilt-free, zero daily load</span></summary>
      <div class="rhythm-list">${parked.length ? parked.map(rcard).join("") : `<div class="empty mini">empty - hit <b>＋ habit</b> to park an idea (e.g. <i>Quran 5 pages · daily</i>, or <i>Gym 30m · 3×/week</i>)</div>`}</div>
    </details>`;
  const head = `<div class="rhythm-head">
      <span class="kicker" style="color:#7cd99e">habits</span>
      <div class="budget">${addBtn}${active.length ? ` budget <input id="rhythm-budget" type="number" min="0" step="15" value="${budget}"><span>min/day</span>` : ""}</div>
    </div>`;
  el.innerHTML = head + meter + lot;
}

// ---------- Rhythms (v5.4.3) - miss-based, no daily budget, escalation when missed too often ----------
function _ritualToday() { return new Date().toISOString().slice(0, 10); }
function ritualMisses(r, days) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  return (r.missDates || []).filter((d) => d >= cutoff).length;
}
// Escalation for a DAILY rhythm: >3/month → nudge, >10/2mo → second warning, >20/3mo → suggest downgrade.
function ritualEscalation(r) {
  if (r.cadence !== "daily") return null;
  const m90 = ritualMisses(r, 90), m60 = ritualMisses(r, 60), m30 = ritualMisses(r, 30);
  if (m90 > 20) return { level: 3, color: "#ff6b6b", msg: `${m90} misses in 3 months - this may really need dedicated time.` };
  if (m60 > 10) return { level: 2, color: "#f5c46f", msg: `${m60} misses in 2 months - worth a gentle rethink.` };
  if (m30 > 3) return { level: 1, color: "#f5c46f", msg: `${m30} misses this month - just a nudge, no shame.` };
  return null;
}
function renderRituals() {
  const el = byId("rituals"); if (!el) return;
  const rhythms = state.rhythms || [];
  const today = _ritualToday();
  const card = (r) => {
    const missedToday = (r.missDates || []).includes(today);
    const m30 = ritualMisses(r, 30);
    const escl = ritualEscalation(r);
    const c = ritualCat(r.cat);
    return `<div class="ritual-card ${missedToday ? "missed-today" : ""}" data-id="${r.id}" style="--cat:${c.color}">
      <div class="ritual-body" data-act="ritual-edit" data-id="${r.id}">
        <div class="ritual-title">${esc(r.title)}</div>
        <div class="ritual-meta">
          <span class="chip">↻ daily</span>
          <span class="chip ${m30 ? "miss-on" : ""}" title="misses in the last 30 days">${m30} missed · 30d</span>
          ${escl ? `<span class="chip escl" style="border-color:${escl.color}; color:${escl.color}">⚠ ${escl.level === 3 ? "downgrade?" : "nudge"}</span>` : ""}
        </div>
        ${escl ? `<div class="ritual-escl-msg" style="color:${escl.color}">${esc(escl.msg)}${escl.level === 3 ? ` <button class="ghost-btn xs" data-act="ritual-downgrade" data-id="${r.id}" title="move it to your Habits parking lot, where it gets dedicated time">↓ make it a Habit</button>` : ""}</div>` : ""}
      </div>
      ${missedToday
        ? `<button class="ritual-miss undo" data-act="ritual-unmiss" data-id="${r.id}" title="undo today's miss">missed today · undo</button>`
        : `<button class="ritual-miss" data-act="ritual-missed" data-id="${r.id}" title="mark missed today - no shame, just data">✗ missed today</button>`}
    </div>`;
  };
  let groups = "";
  const cats = RITUAL_CATS.slice();
  rhythms.forEach((r) => { if (!cats.some((c) => c.id === r.cat)) cats.push({ id: r.cat, name: r.cat, color: "#9aa4b5" }); }); // extensible
  cats.forEach((cat) => {
    const list = rhythms.filter((r) => r.cat === cat.id);
    if (!list.length) return;
    groups += `<div class="ritual-group"><div class="ritual-cat-head" style="color:${cat.color}"><i style="background:${cat.color}"></i>${esc(cat.name)}</div>
      <div class="ritual-list">${list.map(card).join("")}</div></div>`;
  });
  const head = `<div class="rhythm-head">
      <span class="kicker" style="color:#7cd0f5">rhythms</span>
      <button class="ghost-btn sm" data-act="add-ritual" title="add a rhythm - done in parallel, no time budget, tracked by misses">＋ rhythm</button>
    </div>
    <div class="ritual-sub">light, parallel routines - <b>no daily time budget</b>; you log <b>misses</b>, not streaks</div>`;
  el.innerHTML = head + (groups || `<div class="empty mini">no rhythms yet - hit <b>＋ rhythm</b></div>`);
}
function ritualMissToday(id, miss) {
  const r = (state.rhythms || []).find((x) => x.id === id); if (!r) return;
  const today = _ritualToday(); r.missDates = r.missDates || [];
  if (miss) { if (!r.missDates.includes(today)) r.missDates.push(today); }
  else r.missDates = r.missDates.filter((d) => d !== today);
  r.updatedAt = nowIso(); scheduleSave(); render();
}
function ritualDowngrade(id) {
  const r = (state.rhythms || []).find((x) => x.id === id); if (!r) return;
  const hc = r.cat === "religious" ? "hc_religion" : "hc_self"; // map to a habit category
  state.items.push({ id: uid("t"), type: "rhythm", title: r.title, notes: "", categoryId: hc, importance: 1,
    urgency: { due: null, soon: false }, status: "active", nextAction: { if: "", then: "" }, estimateMins: 10,
    projectId: null, subtaskIds: [], nextActionId: null, cadence: "daily", everyNDays: null, perWeek: null, perMonth: null,
    streak: 0, lastDone: null, history: [], inFocus: false, order: -1, queued: true, createdAt: nowIso(), updatedAt: nowIso(), completedAt: null });
  state.rhythms = state.rhythms.filter((x) => x.id !== id);
  scheduleSave(); render(); toast("↓ moved to your Habit Parking Lot - give it dedicated time");
}
function ritualDelete(id) {
  state.rhythms = (state.rhythms || []).filter((x) => x.id !== id);
  if (!byId("popup").hidden) closePopup();
  scheduleSave(); render(); toast("rhythm removed");
}
function openRitualEditor(id) {
  const r = id ? (state.rhythms || []).find((x) => x.id === id) : null;
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#7cd0f5">${r ? "edit rhythm" : "＋ rhythm"}</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <label class="fld"><span>What's the rhythm?</span><input id="ry-title" placeholder="e.g. Adhkar after Fajr" value="${r ? esc(r.title) : ""}"></label>
    <label class="fld"><span>Category</span><select id="ry-cat">${RITUAL_CATS.map((c) => `<option value="${c.id}" ${r && r.cat === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    <div class="hist-note">rhythms are light & parallel - no daily time budget. You'll log <b>misses</b>, not streaks.</div>
    <div class="drawer-actions"><button class="glow-btn" id="ry-save">${r ? "Save" : "Add rhythm"}</button>${r ? `<button class="ghost-btn danger" data-act="ritual-del" data-id="${r.id}">Delete</button>` : ""}</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  setTimeout(() => { const t = byId("ry-title"); if (t) t.focus(); }, 30);
  byId("ry-save").addEventListener("click", () => {
    const title = byId("ry-title").value.trim(); if (!title) { toast("name it first"); return; }
    const cat = byId("ry-cat").value;
    if (r) { r.title = title; r.cat = cat; r.updatedAt = nowIso(); }
    else state.rhythms.push({ id: uid("ry"), title, cat, cadence: "daily", missDates: [], createdAt: nowIso(), updatedAt: nowIso() });
    closePopup(); scheduleSave(); render(); toast(r ? "Saved" : "Rhythm added");
  });
}

// ===================== Calendar (v6.1.1) =====================
// OWN namespace: state.schedules + state.events. NEVER reuses task categories or rhythm categories.
// Multiple named, colour-coded, individually toggle-able schedules; events belong to a schedule.
function seedCalendar() {
  if (!Array.isArray(state.schedules)) {
    state.schedules = [
      { id: "sch_uni", name: "Data course", color: "#4a8fff", hidden: false },
      { id: "sch_biz", name: "Business",   color: "#b06bff", hidden: false },
      { id: "sch_tut", name: "Tutoring",   color: "#7cd99e", hidden: false },
    ];
  }
  if (!Array.isArray(state.events)) {
    const t = new Date(); const day = (off) => { const d = new Date(t); d.setDate(d.getDate() + off); return _isod(d); };
    state.events = [
      { id: uid("ev"), scheduleId: "sch_uni", title: "Data course - study session", date: day(1), start: "10:00", end: "11:00", allDay: false, notes: "" },
      { id: uid("ev"), scheduleId: "sch_tut", title: "Tutoring Amina (maths)", date: day(2), start: "17:00", end: "18:30", allDay: false, notes: "" },
      { id: uid("ev"), scheduleId: "sch_biz", title: "Side-project planning call", date: day(4), start: "14:00", end: "15:00", allDay: false, notes: "" },
      { id: uid("ev"), scheduleId: "sch_uni", title: "Certificate exam week", date: day(9), start: "", end: "", allDay: true, notes: "" },
    ];
  }
  state.schedules.forEach((s) => { if (s.hidden == null) s.hidden = false; });
}
function _isod(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function schedule(id) { return (state.schedules || []).find((s) => s.id === id) || null; }
function eventsOn(dstr) {
  const vis = new Set((state.schedules || []).filter((s) => !s.hidden).map((s) => s.id));
  return (state.events || []).filter((e) => e.date === dstr && vis.has(e.scheduleId))
    .sort((a, b) => (a.allDay ? "" : a.start || "zz").localeCompare(b.allDay ? "" : b.start || "zz"));
}
const CAL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CAL_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CAL_DOW_MON = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]; // v6.6.3: Monday-first header row for month/week grids
let _calDate = null, _calView = "month";
function openCalendar() {
  if (!_calDate) _calDate = new Date();
  byId("calendarview").hidden = false; document.body.classList.add("cal-open");
  byId("scrim").hidden = false; renderCalendar();
}
function closeCalendar() { calSelClear(); byId("calendarview").hidden = true; document.body.classList.remove("cal-open"); byId("scrim").hidden = true; } // v6.4.15: clear multi-select so its Delete bar can't orphan onto the dashboard
function calShift(delta) {
  let d = new Date(_calDate);
  if (_calView === "month") d = new Date(d.getFullYear(), d.getMonth() + delta, 1); // v6.7.1: anchor to the 1st so day-of-month 29-31 can't overflow into a skipped month
  else if (_calView === "week") d.setDate(d.getDate() + delta * 7);
  else d.setDate(d.getDate() + delta); // day view
  _calDate = d; renderCalendar();
}
function calToday() { _calDate = new Date(); renderCalendar(); }
function calSetView(v) { _calView = v; renderCalendar(); }
function _weekDays(date) {
  const start = new Date(date); start.setDate(date.getDate() - ((date.getDay() + 6) % 7)); // v6.6.3: Monday-first week
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(start); x.setDate(start.getDate() + i); return x; });
}
const CAL_FULLDOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_HOUR_H = 46; // px per hour in the day-view time grid
// Greedy interval-graph layout: pack overlapping timed events into side-by-side columns.
function _layoutDay(timed) {
  const evs = timed.map((e) => ({ e, s: _hmToMin(e.start), end: e.end ? Math.max(_hmToMin(e.end), _hmToMin(e.start) + 20) : _hmToMin(e.start) + 30 }))
    .sort((a, b) => a.s - b.s || a.end - b.end);
  const out = []; let cluster = [], clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const lanes = [];
    cluster.forEach((x) => { let col = lanes.findIndex((end) => x.s >= end); if (col < 0) { col = lanes.length; lanes.push(x.end); } else lanes[col] = x.end; x.col = col; });
    cluster.forEach((x) => { x.cols = lanes.length; out.push(x); });
    cluster = []; clusterEnd = -1;
  };
  evs.forEach((x) => { if (cluster.length && x.s >= clusterEnd) flush(); cluster.push(x); clusterEnd = Math.max(clusterEnd, x.end); });
  flush();
  return out;
}
let _calzHiddenCats = new Set(); // v6.6.13: task-category ids toggled OFF in the calendarize legend (view filter)
function _dayBody(d) {
  const ds = _isod(d), evs = eventsOn(ds);
  const allday = evs.filter((e) => e.allDay);
  const laid = _layoutDay(evs.filter((e) => !e.allDay && e.start));
  const hourRows = Array.from({ length: 24 }, (_, h) => `<div class="day-row" data-act="cal-day-slot" data-date="${ds}" data-hour="${h}" style="height:${DAY_HOUR_H}px"><span class="day-hr">${String(h).padStart(2, "0")}:00</span></div>`).join("");
  const blocks = laid.map((x) => {
    const e = x.e, s = schedule(e.scheduleId) || {};
    const top = (x.s / 60) * DAY_HOUR_H, h = Math.max(20, ((x.end - x.s) / 60) * DAY_HOUR_H);
    const left = 3 + (x.col / x.cols) * 95, width = (1 / x.cols) * 95 - 1.5;
    // v6.6.13: a calendarize PREVIEW block tints by the TASK's category (so the owner can tell tasks apart),
    // not the temp gold schedule; a dashed/zebra "proposed" cue keeps it readable as not-yet-committed.
    let cc = s.color || "#8a93a6", prev = "";
    if (e._calzPreview) { const t = item(e.taskId), c = t && cat(t.categoryId); cc = (c && c.color) || "#8a93a6"; const key = (t && t.categoryId) || "_none"; prev = " calz-prev" + (_calzHiddenCats.has(key) ? " calz-cat-hidden" : ""); }
    return `<div class="day-ev${prev}" data-act="cal-ev" data-id="${e.id}" style="top:${top}px;height:${h}px;left:${left}%;width:${width}%;--c:${cc}" title="${esc(e.title)}"><span class="ev-rz top"></span><b>${esc(e.start)}${e.end ? "–" + esc(e.end) : ""}</b> <span class="day-ev-t">${esc(e.title)}</span><span class="ev-rz bot"></span></div>`;
  }).join("");
  let nowLine = "";
  if (ds === _isod(new Date())) { const n = new Date(); nowLine = `<div class="day-now" style="top:${((n.getHours() * 60 + n.getMinutes()) / 60) * DAY_HOUR_H}px"></div>`; }
  const adStrip = allday.length ? `<div class="day-allday">${allday.map((e) => { const s = schedule(e.scheduleId) || {}; return `<div class="cal-ev" data-act="cal-ev" data-id="${e.id}" style="--c:${s.color || "#8a93a6"}">${esc(e.title)}</div>`; }).join("")}</div>` : "";
  return `${adStrip}<div class="day-grid" id="dayGrid" data-date="${ds}" data-timegrid="1" style="height:${24 * DAY_HOUR_H}px">${hourRows}<div class="day-events">${blocks}${nowLine}</div></div>`;
}
// v6.1.8: the week is now a live 7-day time grid (was a static agenda list).
function _weekBody(days) {
  const todayStr = _isod(new Date());
  const heads = days.map((d) => { const ds = _isod(d); return `<div class="wk-head ${ds === todayStr ? "today" : ""}">${CAL_DOW[d.getDay()]} <b>${d.getDate()}</b></div>`; }).join("");
  const allRow = days.map((d) => { const ds = _isod(d); const ad = eventsOn(ds).filter((e) => e.allDay);
    return `<div class="wk-adcell" data-act="cal-day-slot" data-date="${ds}" data-hour="9">${ad.map((e) => { const s = schedule(e.scheduleId) || {}; return `<div class="cal-ev" data-act="cal-ev" data-id="${e.id}" style="--c:${s.color || "#8a93a6"}">${esc(e.title)}</div>`; }).join("")}</div>`; }).join("");
  const gutter = Array.from({ length: 24 }, (_, h) => `<div class="wk-hr" style="height:${DAY_HOUR_H}px"><span>${String(h).padStart(2, "0")}:00</span></div>`).join("");
  const cols = days.map((d) => {
    const ds = _isod(d), laid = _layoutDay(eventsOn(ds).filter((e) => !e.allDay && e.start));
    const rows = Array.from({ length: 24 }, (_, h) => `<div class="wk-row" data-act="cal-day-slot" data-date="${ds}" data-hour="${h}" style="height:${DAY_HOUR_H}px"></div>`).join("");
    const blocks = laid.map((x) => { const e = x.e, s = schedule(e.scheduleId) || {};
      const top = (x.s / 60) * DAY_HOUR_H, h = Math.max(15, ((x.end - x.s) / 60) * DAY_HOUR_H);
      const left = 1.5 + (x.col / x.cols) * 97, width = (1 / x.cols) * 97 - 1.5;
      return `<div class="wk-ev" data-act="cal-ev" data-id="${e.id}" style="top:${top}px;height:${h}px;left:${left}%;width:${width}%;--c:${s.color || "#8a93a6"}"><span class="ev-rz top"></span><b>${esc(e.start)}</b> <span>${esc(e.title)}</span><span class="ev-rz bot"></span></div>`; }).join("");
    const now = ds === todayStr ? `<div class="day-now" style="top:${((new Date().getHours() * 60 + new Date().getMinutes()) / 60) * DAY_HOUR_H}px"></div>` : "";
    return `<div class="wk-col ${ds === todayStr ? "today" : ""}" data-date="${ds}" data-timegrid="1" style="height:${24 * DAY_HOUR_H}px">${rows}<div class="wk-evs">${blocks}${now}</div></div>`;
  }).join("");
  return `<div class="wk-wrap">
    <div class="wk-headrow"><div class="wk-corner"></div>${heads}</div>
    <div class="wk-allrow"><div class="wk-corner sm">all-day</div>${allRow}</div>
    <div class="wk-scroll" id="wkScroll"><div class="wk-gutter">${gutter}</div><div class="wk-cols">${cols}</div></div>
  </div>`;
}
function renderCalendar() {
  const el = byId("calendarview");
  if (!el || el.hidden) { // v6.6.1: drawer closed -> refresh the canvas calendar rail IN PLACE (rail edits/moves/deletes now show), preserve scroll
    const cc = state.meta.ui && state.meta.ui.canvasCal;
    if (cc && cc.open) { const rail = document.querySelector(".canvas-cal-rail"); if (rail) {
      const w = rail.querySelector(".cal-day-wrap"), st = w ? w.scrollTop : null;
      rail.innerHTML = _canvasCalRail(cc.date || _isod(new Date()));
      const w2 = rail.querySelector(".cal-day-wrap"); if (w2 && st != null) w2.scrollTop = st;
    } }
    return;
  }
  const todayStr = _isod(new Date());
  const evChip = (e) => { const s = schedule(e.scheduleId) || {}; return `<div class="cal-ev" data-act="cal-ev" data-id="${e.id}" draggable="true" style="--c:${s.color || "#8a93a6"}" title="${esc(e.title)}${e.start ? " · " + e.start : ""}">${e.allDay ? "" : `<b>${esc(e.start || "")}</b> `}${esc(e.title)}</div>`; };
  let title, body;
  if (_calView === "month") {
    const y = _calDate.getFullYear(), m = _calDate.getMonth();
    title = `${CAL_MONTHS[m]} ${y}`;
    const first = new Date(y, m, 1); const lead = (first.getDay() + 6) % 7; const gridStart = new Date(y, m, 1 - lead); // v6.6.3: grid starts Monday
    let cells = "";
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); const ds = _isod(d);
      // v6.1.7: prayers clutter the month - hide here (still shown in week/day).
      // v6.7.8: recurring occurrences (seriesId) also clutter every month cell - hide by default; the toolbar toggle (month only) brings them back. Week/day always show them.
      const showRecur = !!(state.meta.ui && state.meta.ui.calShowRecurInMonth);
      const evs = eventsOn(ds).filter((e) => !e.prayer && (showRecur || !e.seriesId));
      cells += `<div class="cal-cell ${d.getMonth() === m ? "" : "out"} ${ds === todayStr ? "today" : ""}" data-act="cal-day" data-date="${ds}" data-droptarget="1">
        <div class="cal-daynum">${d.getDate()}</div>
        <div class="cal-evs">${evs.slice(0, 4).map(evChip).join("")}${evs.length > 4 ? `<div class="cal-more">+${evs.length - 4} more</div>` : ""}</div></div>`;
    }
    body = `<div class="cal-dow">${CAL_DOW_MON.map((n) => `<div>${n}</div>`).join("")}</div><div class="cal-grid month">${cells}</div>`;
  } else if (_calView === "week") {
    const days = _weekDays(_calDate);
    title = `${CAL_MONTHS[days[0].getMonth()]} ${days[0].getDate()} – ${days[6].getMonth() !== days[0].getMonth() ? CAL_MONTHS[days[6].getMonth()] + " " : ""}${days[6].getDate()}, ${days[6].getFullYear()}`;
    body = _weekBody(days);
  } else { // day view - a scrollable time grid (v6.1.7)
    title = `${CAL_FULLDOW[_calDate.getDay()]}, ${CAL_MONTHS[_calDate.getMonth()]} ${_calDate.getDate()}, ${_calDate.getFullYear()}`;
    body = `<div class="cal-day-wrap">${_dayBody(_calDate)}</div>`;
  }
  const legend = (state.schedules || []).map((s) => `<button class="cal-leg ${s.hidden ? "off" : ""}" data-act="cal-toggle-sch" data-id="${s.id}" title="show/hide ${esc(s.name)}"><i style="background:${s.color}"></i>${esc(s.name)}<span class="cal-leg-edit" data-act="cal-edit-sch" data-id="${s.id}" title="edit schedule">✎</span></button>`).join("");
  el.innerHTML = `
    <div class="cal-bar">
      <div class="cal-nav">
        <button class="ghost-btn sm" data-act="cal-prev" title="previous">‹</button>
        <button class="ghost-btn sm" data-act="cal-today">Today</button>
        <button class="ghost-btn sm" data-act="cal-next" title="next">›</button>
        <h2 class="cal-title">${title}</h2>
      </div>
      <div class="cal-tools">
        <div class="seg cal-viewseg">
          <button class="${_calView === "month" ? "on" : ""}" data-act="cal-view-month">Month</button>
          <button class="${_calView === "week" ? "on" : ""}" data-act="cal-view-week">Week</button>
          <button class="${_calView === "day" ? "on" : ""}" data-act="cal-view-day">Day</button>
        </div>
        ${_calView === "month" ? `<button class="ghost-btn sm cal-recur-toggle ${state.meta.ui && state.meta.ui.calShowRecurInMonth ? "on" : ""}" data-act="cal-toggle-recur" title="show or hide repeating events in the month grid (they always show in week and day)">${state.meta.ui && state.meta.ui.calShowRecurInMonth ? "↻ repeats: on" : "↻ repeats: off"}</button>` : ""}
        <button class="glow-btn sm" data-act="cal-add-ev">＋ event</button>
        <div class="calz-combo">
          <button class="calz-trigger calz-main" data-act="cal-calendarize" title="✦ AI lays out tomorrow's tasks as time blocks (importance-first, prayer-aware)">✦ Calendarize tomorrow</button>
          <span class="calz-combo-sep" aria-hidden="true"></span>
          <button class="calz-quiz-btn" data-act="cal-prefs-quiz" title="✦ Tune how Himmah calendarizes - a quick preferences quiz (~5 min)">⚙</button>
        </div>
        <button class="ghost-btn sm focus-drop ${dayOvercommitted() ? "over" : ""}" data-act="focus-drop" title="⚖ too much due next week? protect your top priorities, push the farthest-deadline, lowest-priority ones to someday">⚖ what to drop?</button>
        <button class="ghost-btn close-cal" data-act="close-calendar" title="close">✕</button>
      </div>
    </div>
    <div class="cal-legend">${legend}<button class="cal-leg add" data-act="cal-add-sch" title="add a schedule">＋ schedule</button>
      <button class="cal-leg add" data-act="cal-import" title="import a Google calendar via its iCal URL">⬇ import .ics</button>
      <button class="cal-leg add prayer" data-act="cal-prayers" title="block out your prayer times for the week/month">📿 prayer times</button></div>
    <div class="cal-body">${body}</div>`;
  // v6.4: open the time grid already scrolled to the working day - 08:00 by default (no more staring
  // at an empty 00:00-08:00); if today is in view and it's later, land on the current hour instead.
  const scrollGrid = (container, includesToday) => {
    if (!container) return;
    const n = new Date();
    const h = (includesToday && n.getHours() > 8) ? n.getHours() - 1 : 8;
    container.scrollTop = h * DAY_HOUR_H;
  };
  if (_calView === "day") { const g = byId("dayGrid"); if (g) scrollGrid(g.parentElement, ds_is_today(_calDate)); }
  else if (_calView === "week") { const todayStr = _isod(new Date()); scrollGrid(byId("wkScroll"), _weekDays(_calDate).some((d) => _isod(d) === todayStr)); }
  // v6.4.4: keep multi-select highlights across re-renders; prune ids that no longer exist
  for (const sid of _calSel) if (!(state.events || []).some((e) => e.id === sid)) _calSel.delete(sid);
  calSelPaint(); calSelBar();
}
function ds_is_today(d) { return _isod(d) === _isod(new Date()); }
// v6.1.11: generate a real Google Meet link (server calls the Google Calendar API) into the description.
async function genMeetLink() {
  const date = byId("ev-date") ? byId("ev-date").value : _isod(new Date());
  const title = byId("ev-title") ? byId("ev-title").value.trim() || "Meeting" : "Meeting";
  toast("🎥 creating Meet link…");
  let d;
  try { d = await (await fetch("/api/meet", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary: title, date, startTime: (byId("ev-start") || {}).value || "09:00", endTime: (byId("ev-end") || {}).value || "09:30" }) })).json(); }
  catch (e) { toast("⚠ couldn't reach the server"); return; }
  if (d.needsSetup) { toast("🎥 connect Google first - open GOOGLE-MEET-SETUP-GUIDE.html in the app folder"); return; }
  if (!d.ok) { toast("⚠ " + (d.error || "Meet link failed")); return; }
  const ta = byId("ev-notes"); if (ta) { ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + "Google Meet: " + d.link; toast("🎥 Meet link added - Save to keep"); }
}
// v6.6.4: paste an EXISTING Meet link (a standing/recurring room you already have) - no Google OAuth needed.
// Deliberately understated (a faint 🔗 next to the generate button) since it is rarely used. Writes the SAME
// "Google Meet: <url>" line into the notes as genMeetLink, so it renders/joins identically.
function pasteExistingMeet() {
  if (byId("ev-meet-paste-row")) { byId("ev-meet-paste-in").focus(); return; } // already open
  const head = document.querySelector("#popup .ev-aibtns"); if (!head) return;
  const row = document.createElement("div");
  row.id = "ev-meet-paste-row"; row.className = "ev-meet-paste-row";
  row.innerHTML = `<input id="ev-meet-paste-in" placeholder="paste a meet.google.com link" spellcheck="false" autocomplete="off"><button type="button" class="ibx-btn" id="ev-meet-paste-go">add</button>`;
  head.closest(".fld-head").insertAdjacentElement("afterend", row);
  const inp = byId("ev-meet-paste-in"); inp.focus();
  const commit = () => {
    let url = inp.value.trim();
    if (!url) { row.remove(); return; }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;        // accept a bare meet.google.com/xxx paste
    if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(url)) { toast("that does not look like a link"); return; }
    const ta = byId("ev-notes"); if (ta) ta.value = (ta.value.trim() ? ta.value.trim() + "\n" : "") + "Google Meet: " + url;
    row.remove(); toast("🔗 Meet link added - Save to keep");
  };
  byId("ev-meet-paste-go").addEventListener("click", commit);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { e.stopPropagation(); row.remove(); } });
}
// v6.1.12: draft an event description from the owner's life context (same source as Enrich).
async function genEventDescription() {
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  const title = byId("ev-title") ? byId("ev-title").value.trim() : "";
  if (!title) { toast("name the event first"); return; }
  toast("✦ drafting a description…");
  let res;
  try { res = await aiFetch("event_desc", { title, date: byId("ev-date") ? byId("ev-date").value : "", notes: byId("ev-notes") ? byId("ev-notes").value : "" }); }
  catch (e) { toast("⚠ " + e.message); return; }
  const desc = res && res.description;
  if (!desc) { toast("✦ nothing drafted"); return; }
  openDescEditor(desc, lastCallId(), title); // v6.4: edit the draft in a popup; log original + edit + reason
}
// v6.4: the AI draft opens in an editable popup. On save we write it to the event AND log both the model's
// original proposal and your final text (+ an optional one-line reason) to ai_actions.jsonl as training data.
function openDescEditor(aiDraft, callId, title) {
  const ov = document.createElement("div");
  ov.className = "popup desc-overlay"; ov.hidden = false;
  ov.innerHTML = `<div class="popup-card desc-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">✦ AI description <small>(edit before saving)</small></span>
      <button class="ghost-btn" data-d="cancel" title="cancel">✕</button></div>
    <div class="hist-note">Himmah drafted this from your life context. Edit it freely, then save. Both the original and your edit are logged to learn your taste.</div>
    <textarea class="desc-draft" rows="5">${esc(aiDraft)}</textarea>
    <input class="desc-reason" placeholder="one line: why you changed it (optional)" autocomplete="off" maxlength="200">
    <div class="drawer-actions"><button class="glow-btn" data-d="save">Use this description</button>
      <button class="ghost-btn" data-d="cancel">Cancel</button></div></div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("open"));
  const ta = ov.querySelector(".desc-draft"), reason = ov.querySelector(".desc-reason");
  setTimeout(() => { if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 30);
  const close = () => { ov.classList.remove("open"); setTimeout(() => ov.remove(), 180); };
  const save = () => {
    const final = ta.value.trim();
    const note = byId("ev-notes"); if (note) note.value = final;
    const changed = final !== String(aiDraft).trim();
    logOutcome({ call_id: callId, item_id: null, kind: "event_desc", decision: changed ? "edit" : "accept",
      ai_proposed: aiDraft, my_final: final, my_reason: reason.value.trim() || null, original_input: title });
    close(); toast(changed ? "✦ saved your edited description" : "✦ description saved");
  };
  ov.addEventListener("click", (e) => {
    const b = e.target.closest("[data-d]");
    if (b) { if (b.dataset.d === "save") save(); else close(); return; }
    if (e.target === ov) close(); // click the dim backdrop to cancel
  });
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
}
// ---- v6.1.10: drag events - month (day→day), day/week time-grid (drag to retime, 15-min snap) ----
let _dragEv = null;
document.addEventListener("dragstart", (e) => {
  if (e.ctrlKey) { _dragEv = null; return; } // v6.7.1: ctrl+click is multi-select; never start a drag (mirrors the mousedown + click guards)
  const ev = e.target.closest && e.target.closest(".cal-ev,.day-ev,.wk-ev");
  if (ev && ev.dataset.id) { _dragEv = ev.dataset.id; if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", ev.dataset.id); } catch (_) {} } ev.classList.add("dragging"); }
});
document.addEventListener("dragend", () => { _dragEv = null; document.querySelectorAll(".dragging").forEach((x) => x.classList.remove("dragging")); });
document.addEventListener("dragover", (e) => {
  if (!_dragEv || !e.target.closest) return;
  if (e.target.closest(".cal-cell[data-date],[data-timegrid]")) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; }
});
document.addEventListener("drop", (e) => {
  if (!_dragEv || !e.target.closest) return;
  const ev = (state.events || []).find((x) => x.id === _dragEv); _dragEv = null;
  if (!ev) return;
  const cell = e.target.closest(".cal-cell[data-date]");
  if (cell) { e.preventDefault(); if (ev.date !== cell.dataset.date) { const det = _detachOccurrence(ev); ev.date = cell.dataset.date; scheduleSave(); renderCalendar(); toast("📅 moved to " + cell.dataset.date + (det ? " (this one only)" : "")); } return; }
  const grid = e.target.closest("[data-timegrid]");
  if (grid) {
    e.preventDefault();
    const rect = grid.getBoundingClientRect();
    let mins = Math.round((e.clientY - rect.top) / DAY_HOUR_H * 60 / 15) * 15;
    const dur = ev.end ? Math.max(15, _hmToMin(ev.end) - _hmToMin(ev.start)) : 30;
    mins = Math.max(0, Math.min(24 * 60 - dur, mins)); // v6.7.1: clamp the START so a drop near the bottom keeps the FULL duration (was clamped to 23:45 -> collapsed)
    const det = _detachOccurrence(ev); // v6.4.15: dragging one occurrence detaches it from the series (no silent desync)
    ev.allDay = false; ev.start = _minToHM(mins); ev.end = _minToHM(mins + dur);
    if (grid.dataset.date) ev.date = grid.dataset.date;
    scheduleSave(); renderCalendar(); toast("🕐 rescheduled to " + ev.start + (det ? " (this one only)" : ""));
  }
});
// v6.4: precise pointer move + edge-resize for time-grid events (Google-Calendar feel). HTML5 drag gave no
// feedback so you couldn't land on a time; this shows a live time label, snaps to 15 min, and resizes by the
// top/bottom edges. Move waits for a real drag so a plain click still opens the editor.
let _gp = null, _gpMoved = false, _gpSuppressClick = false;
// v6.4.4: ctrl+click multi-select of calendar events (ephemeral, never persisted).
let _calSel = new Set();
function calSelToggle(id) { if (_calSel.has(id)) _calSel.delete(id); else _calSel.add(id); calSelPaint(); calSelBar(); }
function calSelPaint() { document.querySelectorAll(".cal-ev,.day-ev,.wk-ev").forEach((el) => el.classList.toggle("cal-selected", _calSel.has(el.dataset.id))); }
function calSelClear() { _calSel.clear(); calSelPaint(); calSelBar(); }
function calSelBar() {
  let bar = byId("calSelBar");
  if (!_calSel.size) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "calSelBar"; bar.className = "cal-selbar"; document.body.appendChild(bar); }
  bar.innerHTML = `<span class="cal-selbar-n">${_calSel.size} selected</span>
    <button class="glow-btn sm sel-del" data-act="cal-sel-del">🗑 Delete</button>
    <button class="ghost-btn sm" data-act="cal-sel-clear">De-select</button>`;
}
function calSelDelete() {
  const n = _calSel.size; if (!n) return;
  state.events = (state.events || []).filter((e) => !_calSel.has(e.id));
  _calSel.clear(); if (!byId("popup").hidden) closePopup();
  scheduleSave(); renderCalendar(); calSelBar();
  toast(`${n} event${n !== 1 ? "s" : ""} removed`);
}
function _gpShowLabel(text, x, y) {
  let el = byId("gpLabel");
  if (!el) { el = document.createElement("div"); el.id = "gpLabel"; el.className = "gp-label"; document.body.appendChild(el); }
  el.textContent = text; el.style.left = (x + 14) + "px"; el.style.top = (y + 14) + "px"; el.hidden = false;
}
function _gpHideLabel() { const el = byId("gpLabel"); if (el) el.hidden = true; }
document.addEventListener("mousedown", (e) => {
  _gpSuppressClick = false; // v6.7.1: clear any stranded suppress flag at the start of a fresh interaction so it can't swallow an unrelated click
  if (e.ctrlKey) return; // v6.4.4: ctrl+click is multi-select, not a drag
  if (e.target.closest(".calz-ev-btn") || e.target.closest(".calz-chip")) return; // v6.6.10: block-tool clicks + tray chips are not drags
  const evEl = e.target.closest && e.target.closest(".day-ev,.wk-ev");
  if (!evEl) return;
  if (_calzProposal && _calzProposal.schId && !(evEl.dataset.id || "").startsWith("calzev")) return; // v6.6.10: in the day-view editor only proposal blocks are draggable (fixed/real events are read-only context)
  const grid = evEl.closest("[data-timegrid]"); if (!grid) return;
  const ev = (state.events || []).find((x) => x.id === evEl.dataset.id); if (!ev) return;
  const handle = e.target.closest(".ev-rz");
  const mode = handle ? (handle.classList.contains("top") ? "top" : "bot") : "move";
  const origStart = _hmToMin(ev.start || "09:00");
  const origEnd = ev.end ? Math.max(origStart + 15, _hmToMin(ev.end)) : origStart + 30;
  _gp = { id: ev.id, mode, evEl, grid, startClientY: e.clientY, origStart, origEnd, cur: null, preview: !!ev._calzPreview };
  _gpMoved = mode !== "move"; // resize is active at once; move waits for a real drag (so clicks still open the editor)
  if (_gpMoved) { e.preventDefault(); evEl.classList.add("gp-active"); document.body.classList.add("gp-dragging"); }
});
document.addEventListener("mousemove", (e) => {
  if (!_gp) return;
  if (!_gpMoved) {
    if (Math.abs(e.clientY - _gp.startClientY) < 4) return; // below threshold: still a click, not a drag
    _gpMoved = true; _gp.evEl.classList.add("gp-active"); document.body.classList.add("gp-dragging");
  }
  e.preventDefault();
  // v6.6.39/.40: holding SHIFT LOCKS a proposal block's time for ANY grab - the body (move) OR a white resize edge (top/bot).
  // The block stops responding to the cursor (no accidental re-time AND no accidental resize); the Other Tasks box becomes the drop target.
  if (e.shiftKey && _gp.preview) {
    _gp.cur = { s: _gp.origStart, en: _gp.origEnd };
    _gp.evEl.style.top = (_gp.origStart / 60 * DAY_HOUR_H) + "px";
    _gp.evEl.style.height = Math.max(14, (_gp.origEnd - _gp.origStart) / 60 * DAY_HOUR_H) + "px";
    _gp.evEl.classList.add("gp-removing");
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const otherBox = under && under.closest(".calz-tray.calz-other");
    document.querySelectorAll(".calz-rm-hi").forEach((x) => x.classList.remove("calz-rm-hi"));
    if (otherBox) otherBox.classList.add("calz-rm-hi");
    _gpShowLabel(otherBox ? "release to un-schedule" : "drag onto Other Tasks to un-schedule", e.clientX, e.clientY);
    return;
  }
  _gp.evEl.classList.remove("gp-removing"); // shift released mid-drag: resume normal time-change
  document.querySelectorAll(".calz-rm-hi").forEach((x) => x.classList.remove("calz-rm-hi"));
  const rect = _gp.grid.getBoundingClientRect();
  const snap = (px) => Math.round(px / DAY_HOUR_H * 60 / 15) * 15; // 15-min snap
  let s = _gp.origStart, en = _gp.origEnd;
  if (_gp.mode === "move") {
    const dur = _gp.origEnd - _gp.origStart;
    s = Math.max(0, Math.min(24 * 60 - dur, _gp.origStart + snap(e.clientY - _gp.startClientY))); en = s + dur;
  } else if (_gp.mode === "top") {
    s = Math.max(0, Math.min(_gp.origEnd - 15, snap(e.clientY - rect.top))); en = _gp.origEnd;
  } else {
    en = Math.min(24 * 60, Math.max(_gp.origStart + 15, snap(e.clientY - rect.top))); s = _gp.origStart;
  }
  _gp.cur = { s, en };
  _gp.evEl.style.top = (s / 60 * DAY_HOUR_H) + "px";
  _gp.evEl.style.height = Math.max(14, (en - s) / 60 * DAY_HOUR_H) + "px";
  _gpShowLabel(_minToHM(s) + " - " + _minToHM(en), e.clientX, e.clientY);
});
document.addEventListener("mouseup", (e) => {
  if (!_gp) return;
  const gp = _gp; _gp = null; _gpHideLabel(); document.body.classList.remove("gp-dragging");
  if (!_gpMoved || !gp.cur) { gp.evEl.classList.remove("gp-active"); return; } // a plain click: editor opens via the click handler
  const ev = (state.events || []).find((x) => x.id === gp.id);
  document.querySelectorAll(".calz-rm-hi").forEach((x) => x.classList.remove("calz-rm-hi")); // v6.6.39
  if (ev && ev._calzPreview) { // v6.6.10: a calendarize preview block - log the edit, re-render the plan, NEVER persist
    gp.evEl.classList.remove("gp-removing");
    if (e.shiftKey) { // v6.6.34/.39/.40: a SHIFT-drag (move OR resize) NEVER changes the time (it was locked) - it only un-schedules onto Other Tasks
      const under = document.elementFromPoint(e.clientX, e.clientY);
      if (under && under.closest(".calz-tray.calz-other")) { gp.evEl.classList.remove("gp-active"); calzRemove(ev.id); return; }
      gp.evEl.classList.remove("gp-active"); _calzRerender(); return; // released anywhere else: keep it exactly where it was, change nothing
    }
    _calzSnapshot(); // v6.6.32: undo
    ev.allDay = false; ev.start = _minToHM(gp.cur.s); ev.end = _minToHM(gp.cur.en);
    _calzLog(gp.mode === "move" ? "move" : "resize", ev.taskId, { start: _minToHM(gp.origStart), end: _minToHM(gp.origEnd) }, { start: ev.start, end: ev.end });
    _calzRerender();
  } else if (ev) {
    const det = _detachOccurrence(ev); // v6.4.15: moving/resizing one occurrence detaches it (no silent series desync)
    ev.allDay = false; ev.start = _minToHM(gp.cur.s); ev.end = _minToHM(gp.cur.en);
    if (gp.mode === "move") { // in week view, releasing over another day column also moves the date
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const col = under && under.closest && under.closest(".wk-col[data-date],.day-grid[data-date]");
      if (col && col.dataset.date) ev.date = col.dataset.date;
    }
    scheduleSave(); renderCalendar(); toast("🕐 " + ev.start + " - " + ev.end + (det ? " (this one only)" : ""));
  }
  _gpSuppressClick = true; // swallow the click that fires right after a drag (it would reopen the editor)
});
// v6.6.39: while dragging a grid block (esp. SHIFT+drag), never let the browser start selecting text under the cursor.
document.addEventListener("selectstart", (e) => { if (_gp) e.preventDefault(); });
// ---- v6.4.3: recurring calendar events (a "Rhythm" = a repeating event, distinct from habit rhythms) ----
// Occurrences are concrete dated rows sharing a seriesId + rrule, generated over a horizon. Editing/deleting
// one asks the scope (this / this+future / all). Plain (non-series) events are untouched - no migration.
const RRULE_HORIZON = { daily: 60, weekly: 182, monthly: 365 }; // days ahead to materialise
// v6.6.27: is this ISO date inside any pause window? (inclusive)
function _inPause(ds, pauses) { return !!(pauses || []).some((p) => p && ds >= p.from && ds <= p.to); }
function _rruleDates(freq, anchorISO, weekdays, until, pauses, exdates) {
  const [y, m, d] = anchorISO.split("-").map(Number);
  const _today = new Date(); _today.setHours(0, 0, 0, 0); // v6.7.1: materialise from max(anchor, today)+horizon so an OLD series still extends into the future on rebuild/unpause (was anchor+horizon -> wiped its future)
  const end = new Date(Math.max(new Date(y, m - 1, d).getTime(), _today.getTime())); end.setDate(end.getDate() + (RRULE_HORIZON[freq] || 60));
  const untilD = until ? new Date(until + "T00:00:00") : null;
  const stop = (untilD && untilD < end) ? untilD : end; // v6.6.27: "repeat until" caps the horizon
  const out = [];
  if (freq === "monthly") {
    // build each month from the anchor (NOT setMonth, which drifts day 29-31 forward forever); skip months lacking the day
    for (let i = 0; ; i++) {
      const cand = new Date(y, m - 1 + i, d);
      if (cand > stop) break;
      if (cand.getDate() === d) out.push(_isod(cand));
    }
  } else if (freq === "weekly" && weekdays && weekdays.length) {
    // v6.6.2: repeat on the chosen weekday(s), e.g. every Monday (not just the anchor's own weekday)
    for (const c = new Date(y, m - 1, d); c <= stop; c.setDate(c.getDate() + 1)) if (weekdays.includes(c.getDay())) out.push(_isod(c));
  } else {
    const cur = new Date(y, m - 1, d), step = freq === "weekly" ? 7 : 1;
    while (cur <= stop) { out.push(_isod(cur)); cur.setDate(cur.getDate() + step); }
  }
  return out.filter((ds) => !_inPause(ds, pauses) && !(exdates || []).includes(ds)); // v6.6.27 pauses + v6.7.1 exdates: never re-materialise a pause window or a date the user detached as "only this event"
}
function _genSeries(base, freq, weekdays, until, pauses, exdates) {
  const seriesId = uid("ser"), anchor = base.date;
  return _rruleDates(freq, anchor, weekdays, until, pauses, exdates).map((ds) => Object.assign({}, base, { id: uid("ev"), date: ds, seriesId, rrule: { freq, anchor, weekdays: weekdays && weekdays.length ? weekdays : null, until: until || null, pauses: (pauses || []).slice(), exdates: (exdates || []).slice() } }));
}
// v6.6.27: pause a recurring series for [from..to] - skip + delete those occurrences (undoable), record the pause on
// the surviving occurrences' rrule so a later rebuild keeps respecting it. Resume re-materialises the window.
function pauseSeries(seriesId, from, to) {
  if (!from || !to || to < from) { toast("pick a valid from -> to range"); return false; }
  const p = { id: uid("pause"), from, to };
  const survivors = (state.events || []).filter((e) => e.seriesId === seriesId && !(e.date >= from && e.date <= to));
  const removed = (state.events || []).filter((e) => e.seriesId === seriesId && e.date >= from && e.date <= to);
  if (!removed.length) { toast("nothing to pause in that range"); return false; }
  survivors.forEach((e) => { e.rrule = e.rrule || {}; e.rrule.pauses = (e.rrule.pauses || []).concat([p]); });
  state.events = (state.events || []).filter((e) => !(e.seriesId === seriesId && e.date >= from && e.date <= to));
  scheduleSave(); renderCalendar();
  undoToast("Paused " + removed.length + " event" + (removed.length === 1 ? "" : "s") + " (" + from + " -> " + to + ")", () => {
    survivors.forEach((e) => { if (e.rrule) e.rrule.pauses = (e.rrule.pauses || []).filter((q) => q.id !== p.id); });
    removed.forEach((e) => state.events.push(e)); scheduleSave(); renderCalendar();
  });
  return true;
}
function unpauseSeries(seriesId, pauseId) { // v6.6.27: resume a paused window - rebuild the series from the anchor minus the lifted pause
  const sample = (state.events || []).find((e) => e.seriesId === seriesId && e.rrule); if (!sample) return;
  const r = sample.rrule, remaining = (r.pauses || []).filter((q) => q.id !== pauseId);
  const base = { scheduleId: sample.scheduleId, title: sample.title, allDay: sample.allDay, start: sample.start, end: sample.end, notes: sample.notes, date: r.anchor };
  state.events = (state.events || []).filter((e) => e.seriesId !== seriesId);
  _genSeries(base, r.freq, r.weekdays, r.until || null, remaining, r.exdates).forEach((o) => state.events.push(o)); // v6.7.1: carry exdates so detached occurrences stay excluded
  scheduleSave(); renderCalendar(); toast("Resumed");
}
function _pauseListHtml(e) {
  const pp = (e.rrule && e.rrule.pauses) || [];
  if (!pp.length) return `<div class="hist-note">no pauses</div>`;
  return pp.map((p) => `<div class="pause-chip">⏸ ${esc(p.from)} -> ${esc(p.to)} <button type="button" class="ghost-btn xs" data-act="ev-unpause" data-series="${esc(e.seriesId)}" data-pause="${esc(p.id)}" title="resume this window">✕</button></div>`).join("");
}
function seriesEvents(seriesId) { return (state.events || []).filter((e) => e.seriesId === seriesId); }
function _detachOccurrence(ev) { // v6.4.15: turn one occurrence into a standalone event
  if (ev && ev.seriesId) {
    const sid = ev.seriesId, exd = ev.date; // v6.7.1: record this date as a series exception so a later rebuild/unpause never re-creates a duplicate over the customized occurrence
    seriesEvents(sid).forEach((x) => { if (x !== ev && x.rrule) x.rrule.exdates = (x.rrule.exdates || []).concat([exd]); });
    ev.seriesId = undefined; ev.rrule = undefined; return true;
  }
  return false;
}
let _scopePick = null;
function openSeriesScope(mode, e, onPick) {
  _scopePick = (scope) => { _scopePick = null; onPick(scope); };
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card scope-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#b06bff">↻ recurring ${mode === "delete" ? "delete" : "edit"}</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="hist-note">This event repeats. Apply to:</div>
    <div class="drawer-actions scope-actions">
      <button class="glow-btn" data-act="scope-pick" data-scope="one">Only this event</button>
      <button class="ghost-btn" data-act="scope-pick" data-scope="future">This &amp; all future</button>
      <button class="ghost-btn" data-act="scope-pick" data-scope="all">All events</button>
    </div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}
function _applyEventEdit(e, rec, scope) {
  const patch = { scheduleId: rec.scheduleId, title: rec.title, allDay: rec.allDay, start: rec.start, end: rec.end, notes: rec.notes };
  const dateMoved = scope !== "one" && rec.date !== e.date; // v6.4.15: a new date can't shift every occurrence, so it only applies to "this one"
  if (scope === "one") { _detachOccurrence(e); Object.assign(e, patch, { date: rec.date }); } // detach this one (v6.7.1: _detachOccurrence records the exdate so the series won't recreate it)
  else { (scope === "all" ? seriesEvents(e.seriesId) : seriesEvents(e.seriesId).filter((x) => x.date >= e.date)).forEach((x) => Object.assign(x, patch)); }
  closePopup(); scheduleSave(); renderCalendar();
  toast("Series updated (" + scope + ")" + (dateMoved ? " - date change applies to this occurrence only" : ""));
}
function openEventEditor(id, dateStr, startHint) {
  const e = id ? (state.events || []).find((x) => x.id === id) : null;
  const schs = state.schedules || [];
  const p = byId("popup");
  const date = e ? e.date : (dateStr || _isod(new Date()));
  const startVal = e ? (e.start || "") : (startHint || "");
  p.innerHTML = `<div class="popup-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#4a8fff">${e ? (e.rrule ? "edit event ↻" : "edit event") : "＋ event"}</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <label class="fld"><span>Title</span><input id="ev-title" placeholder="what is it?" value="${e ? esc(e.title) : ""}"></label>
    <div class="fld-row">
      <label class="fld"><span>Schedule</span><select id="ev-sch">${schs.map((s) => `<option value="${s.id}" ${e && e.scheduleId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
      <label class="fld"><span>Date</span>${tdateField("ev-date", date)}</label>
    </div>
    <div class="fld-row">
      <label class="fld check-fld"><span>All day</span><input type="checkbox" id="ev-allday" ${e && e.allDay ? "checked" : ""}></label>
      <label class="fld"><span>Start</span><input type="time" id="ev-start" value="${startVal}"></label>
      <label class="fld"><span>End</span><input type="time" id="ev-end" value="${e && e.end ? e.end : ""}"></label>
    </div>
    <div class="fld-row">
      <label class="fld check-fld"><span>Repeat ↻</span><input type="checkbox" id="ev-rep" ${e && e.rrule ? "checked" : ""}></label>
      <label class="fld"><span>Frequency</span><select id="ev-freq">
        <option value="daily" ${e && e.rrule && e.rrule.freq === "daily" ? "selected" : ""}>Daily</option>
        <option value="weekly" ${e && e.rrule && e.rrule.freq === "weekly" ? "selected" : ""}>Weekly</option>
        <option value="monthly" ${e && e.rrule && e.rrule.freq === "monthly" ? "selected" : ""}>Monthly</option>
      </select></label>
    </div>
    <div class="fld ev-weekdays" id="ev-weekdays" ${e && e.rrule && e.rrule.freq === "weekly" ? "" : "hidden"}><span>Repeat on <small>(weekly)</small></span>
      <div class="wd-row">${["S", "M", "T", "W", "T", "F", "S"].map((lab, n) => {
        const sel = e && e.rrule && e.rrule.weekdays ? e.rrule.weekdays.includes(n) : (new Date(date + "T00:00:00").getDay() === n);
        return `<button type="button" class="wd-btn ${sel ? "on" : ""}" data-wd="${n}">${lab}</button>`;
      }).join("")}</div>
    </div>
    <div class="fld ev-until-wrap" id="ev-until-wrap" ${e && e.rrule ? "" : "hidden"}><span>Ends <small>(repeat until - blank = never)</small></span>
      ${tdateField("ev-until", (e && e.rrule && e.rrule.until) || "", { clearable: true, placeholder: "never" })}</div>
    ${e && e.seriesId ? `<div class="fld ev-pauses-wrap"><span>Pauses <small>(skip a date range, e.g. a 2-week break - it resumes after)</small></span>
      <div id="ev-pauses-list">${_pauseListHtml(e)}</div>
      <div class="fld-row ev-pause-add">${tdateField("ev-pause-from", "", { placeholder: "from" })}${tdateField("ev-pause-to", "", { placeholder: "to" })}<button type="button" class="ghost-btn sm" data-act="ev-add-pause" data-series="${esc(e.seriesId)}">＋ pause</button></div>
    </div>` : ""}
    <div class="fld">
      <div class="fld-head"><span>Description</span>
        <span class="ev-aibtns">
          <button type="button" class="ibx-btn meet" data-act="ev-meet" title="generate a Google Meet link into the description (needs Google connected)">🎥 Meet link</button>
          <button type="button" class="ibx-btn meet-paste" data-act="ev-meet-paste" title="paste an existing Meet link you already have (no Google setup needed)">🔗</button>
          <button type="button" class="ibx-btn aidesc" data-act="ev-aidesc" title="✦ draft a description from your life context">✦ describe</button>
        </span>
      </div>
      <textarea id="ev-notes" rows="3">${e ? esc(e.notes || "") : ""}</textarea>
    </div>
    <div class="drawer-actions"><button class="glow-btn" id="ev-save">${e ? "Save" : "Add event"}</button>${e ? `<button class="ghost-btn danger" data-act="cal-del-ev" data-id="${e.id}">Delete</button>` : ""}</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  setTimeout(() => { const t = byId("ev-title"); if (t) t.focus(); }, 30);
  const _updWd = () => { const rep = byId("ev-rep").checked; const wd = byId("ev-weekdays"); if (wd) wd.hidden = !(rep && byId("ev-freq").value === "weekly"); const uw = byId("ev-until-wrap"); if (uw) uw.hidden = !rep; }; // v6.6.2 + v6.6.27: the Ends/repeat-until row shows whenever Repeat is on
  byId("ev-rep").addEventListener("change", _updWd); byId("ev-freq").addEventListener("change", _updWd);
  p.querySelectorAll(".wd-btn").forEach((b) => b.addEventListener("click", () => b.classList.toggle("on")));
  byId("ev-save").addEventListener("click", () => {
    const title = byId("ev-title").value.trim(); if (!title) { toast("name the event"); return; }
    const allDay = byId("ev-allday").checked;
    const rec = { scheduleId: byId("ev-sch").value, title, date: byId("ev-date").value || date,
      allDay, start: allDay ? "" : byId("ev-start").value, end: allDay ? "" : byId("ev-end").value, notes: byId("ev-notes").value };
    if (!rec.allDay && !rec.start) { rec.allDay = true; rec.start = ""; rec.end = ""; } // v6.7.1: a timed event with no Start renders nowhere in day/week - coerce to all-day so it stays visible
    const wantRep = byId("ev-rep").checked, freq = byId("ev-freq").value; // v6.4.3
    const weekdays = (wantRep && freq === "weekly") ? [...p.querySelectorAll("#ev-weekdays .wd-btn.on")].map((b) => +b.dataset.wd) : null; // v6.6.2: which weekday(s) to repeat on
    const until = (wantRep && byId("ev-until") ? byId("ev-until").value : "") || null; // v6.6.27: repeat-until end date
    const anchor0 = (e && e.rrule && e.rrule.anchor) || (e && e.date) || rec.date;
    if (until && until < anchor0) { toast("the end date must be on or after the start"); return; }
    const sch = (state.schedules || []).find((x) => x.id === rec.scheduleId); if (sch && sch.hidden) { sch.hidden = false; } // v6.6.2: a new event on a hidden schedule would be invisible - reveal it
    if (!e) { // new event
      if (wantRep) _genSeries(rec, freq, weekdays, until).forEach((o) => state.events.push(o)); else state.events.push(Object.assign({ id: uid("ev") }, rec));
      closePopup(); scheduleSave(); renderCalendar();
      toast(wantRep ? `Recurring event added${weekdays && weekdays.length ? " (" + weekdays.length + " day/wk)" : ""}` : "Event added"); return;
    }
    if (e.seriesId && wantRep) { // edit a series
      const untilChanged = (until || null) !== ((e.rrule && e.rrule.until) || null); // v6.6.27
      if (untilChanged || freq !== (e.rrule && e.rrule.freq) || JSON.stringify(weekdays) !== JSON.stringify((e.rrule && e.rrule.weekdays) || null)) { // v6.6.2/.27: freq, weekdays OR repeat-until changed -> rebuild from the anchor (pauses preserved)
        const anchor = (e.rrule && e.rrule.anchor) || e.date;
        state.events = (state.events || []).filter((x) => x.seriesId !== e.seriesId);
        _genSeries(Object.assign({}, rec, { date: anchor }), freq, weekdays, until, (e.rrule && e.rrule.pauses) || [], (e.rrule && e.rrule.exdates) || []).forEach((o) => state.events.push(o)); // v6.7.1: preserve exdates across a recurrence rebuild
        closePopup(); scheduleSave(); renderCalendar(); toast("Recurrence updated"); return;
      }
      openSeriesScope("edit", e, (scope) => _applyEventEdit(e, rec, scope)); return; // else ask scope (this / future / all)
    }
    if (!e.seriesId && wantRep) { // single -> series: this becomes the anchor
      state.events = (state.events || []).filter((x) => x.id !== e.id);
      _genSeries(Object.assign({}, rec, { date: e.date }), freq, weekdays, until).forEach((o) => state.events.push(o));
      closePopup(); scheduleSave(); renderCalendar(); toast("Now recurring"); return;
    }
    if (e.seriesId && !wantRep) { Object.assign(e, rec); e.seriesId = undefined; e.rrule = undefined; closePopup(); scheduleSave(); renderCalendar(); toast("Event saved (no longer recurring)"); return; }
    Object.assign(e, rec); closePopup(); scheduleSave(); renderCalendar(); toast("Event saved"); // plain single edit
  });
}
function openScheduleEditor(id) {
  const s = id ? schedule(id) : null;
  const p = byId("popup");
  const palette = ["#4a8fff", "#b06bff", "#7cd99e", "#f5c46f", "#e068ff", "#62e3ff", "#ff6b6b", "#fb923c"];
  p.innerHTML = `<div class="popup-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#4a8fff">${s ? "edit schedule" : "＋ schedule"}</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <label class="fld"><span>Name</span><input id="sch-name" placeholder="e.g. University" value="${s ? esc(s.name) : ""}"></label>
    <label class="fld"><span>Colour</span><input type="color" id="sch-color" value="${s ? s.color : palette[(state.schedules || []).length % palette.length]}"></label>
    <div class="hist-note">schedules are their own thing - separate from your task categories &amp; rhythm categories.</div>
    <div class="drawer-actions"><button class="glow-btn" id="sch-save">${s ? "Save" : "Add schedule"}</button>${s ? `<button class="ghost-btn danger" data-act="cal-del-sch" data-id="${s.id}">Delete</button>` : ""}</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  byId("sch-save").addEventListener("click", () => {
    const name = byId("sch-name").value.trim(); if (!name) { toast("name the schedule"); return; }
    const color = byId("sch-color").value;
    if (s) { s.name = name; s.color = color; } else state.schedules.push({ id: uid("sch"), name, color, hidden: false });
    closePopup(); scheduleSave(); renderCalendar(); toast(s ? "Schedule saved" : "Schedule added");
  });
}
function calToggleSchedule(id) { const s = schedule(id); if (s) { s.hidden = !s.hidden; scheduleSave(); renderCalendar(); } }
function calDeleteEvent(id) {
  const e = (state.events || []).find((x) => x.id === id);
  if (e && e.seriesId) { // v6.4.3: recurring -> ask which to delete
    openSeriesScope("delete", e, (scope) => {
      let removed; // v6.5.7: capture for undo
      if (scope === "one") removed = (state.events || []).filter((x) => x.id === e.id);
      else if (scope === "all") removed = (state.events || []).filter((x) => x.seriesId === e.seriesId);
      else removed = (state.events || []).filter((x) => x.seriesId === e.seriesId && x.date >= e.date);
      state.events = (state.events || []).filter((x) => !removed.includes(x));
      closePopup(); scheduleSave(); renderCalendar();
      undoToast("Deleted series (" + scope + ", " + removed.length + ")", () => { removed.forEach((x) => state.events.push(x)); scheduleSave(); renderCalendar(); });
    });
    return;
  }
  const ev = (state.events || []).find((x) => x.id === id);
  state.events = (state.events || []).filter((x) => x.id !== id); if (!byId("popup").hidden) closePopup(); scheduleSave(); renderCalendar();
  if (ev) undoToast('Deleted "' + (ev.title || "event") + '"', () => { state.events.push(ev); scheduleSave(); renderCalendar(); });
}
function calDeleteSchedule(id) {
  const evs = (state.events || []).filter((e) => e.scheduleId === id).length;
  state.schedules = (state.schedules || []).filter((s) => s.id !== id);
  state.events = (state.events || []).filter((e) => e.scheduleId !== id); // events belong to a schedule
  if (!byId("popup").hidden) closePopup(); scheduleSave(); renderCalendar();
  toast(evs ? `schedule + ${evs} event${evs > 1 ? "s" : ""} removed` : "schedule removed");
}

// ---- Google iCal seeding (v6.1.2) - paste a calendar's "Secret address in iCal format" URL; the
// server fetches+parses it; the owner reviews events in an "interview" and picks what/where to import.
// No OAuth. Owner-asleep build: tested against the bundled sample; live import waits for the owner. ----
let _icsEvents = [], _icsCalName = "";
function openIcsImport() {
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card ics-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#4a8fff">⬇ import a calendar (.ics)</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="hist-note">In Google Calendar → the calendar's <b>Settings → Integrate calendar → Secret address in iCal format</b>, copy that URL and paste it below. No Google login needed - you choose exactly which calendars by which URLs you paste. After preview you can <b>bulk-pick Past vs Future</b> events.</div>
    <label class="fld"><span>iCal secret address (URL)</span><input id="ics-url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocomplete="off"></label>
    <div class="drawer-actions"><button class="glow-btn" id="ics-fetch">Fetch &amp; preview</button><button class="ghost-btn" id="ics-sample">Try the sample file</button></div>
    <div id="ics-result"></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  byId("ics-fetch").addEventListener("click", () => icsFetch({ url: byId("ics-url").value.trim() }));
  byId("ics-sample").addEventListener("click", () => icsFetch({ sample: true }));
}
async function icsFetch(payload) {
  const out = byId("ics-result"); out.innerHTML = `<div class="hist-note">fetching &amp; parsing…</div>`;
  let d;
  try { d = await (await fetch("/api/ics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).json(); }
  catch (e) { out.innerHTML = `<div class="hist-note err">network error - is the server running?</div>`; return; }
  if (!d || !d.ok) { out.innerHTML = `<div class="hist-note err">⚠ ${esc((d && d.error) || "couldn't import")}</div>`; return; }
  _icsEvents = d.events || []; _icsCalName = d.calendarName || "Imported";
  renderIcsInterview();
}
function renderIcsInterview() {
  const out = byId("ics-result");
  if (!_icsEvents.length) { out.innerHTML = `<div class="hist-note">No dated events found in this feed.</div>`; return; }
  const schs = state.schedules || [];
  const recN = _icsEvents.filter((e) => e.recurring).length;
  const todayStr = _isod(new Date());
  const isPast = (e) => e.date < todayStr;
  const pastN = _icsEvents.filter(isPast).length, futN = _icsEvents.length - pastN;
  // v6.1.9: Past/Future boxes drive which events import. Default: Future on, Past off.
  const rows = _icsEvents.map((e, ix) => { const past = isPast(e); return `<label class="ics-row ${e.recurring ? "rec" : ""}" data-when="${past ? "past" : "future"}">
      <input type="checkbox" ${past ? "" : "checked"} data-ics="${ix}">
      <span class="ics-ev"><b>${esc(e.title)}</b><small>${e.date}${past ? " · past" : ""}${e.allDay ? " · all-day" : (e.start ? " · " + e.start : "")}${e.recurring ? ` · <span class="ics-rec">↻ recurring</span>` : ""}</small></span>
    </label>`; }).join("");
  out.innerHTML = `
    <div class="ics-head"><b>${esc(_icsCalName)}</b> - ${_icsEvents.length} event${_icsEvents.length > 1 ? "s" : ""}${recN ? ` (${recN} recurring, flagged ↻)` : ""}. Choose which to import:</div>
    <div class="ics-when">
      <label class="ics-whenbox"><input type="checkbox" id="ics-past" ${pastN ? "" : "disabled"}> ⏪ Past <small>(${pastN})</small></label>
      <label class="ics-whenbox"><input type="checkbox" id="ics-fut" checked ${futN ? "" : "disabled"}> ⏩ Future <small>(${futN})</small></label>
      <span class="ics-into">into <select id="ics-sch">${schs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}<option value="__new">＋ new schedule…</option></select></span>
    </div>
    <div class="ics-controls">
      <button class="ghost-btn xs" id="ics-all">all</button><button class="ghost-btn xs" id="ics-none">none</button>
      ${recN ? `<button class="ghost-btn xs" id="ics-norec" title="untick the recurring ones">skip recurring</button>` : ""}
    </div>
    <div class="ics-list">${rows}</div>
    <div class="drawer-actions"><button class="glow-btn" id="ics-import">Import selected</button></div>`;
  const setWhen = (when, on) => out.querySelectorAll(`.ics-row[data-when="${when}"] [data-ics]`).forEach((c) => (c.checked = on));
  byId("ics-past").addEventListener("change", (e) => setWhen("past", e.target.checked));
  byId("ics-fut").addEventListener("change", (e) => setWhen("future", e.target.checked));
  byId("ics-all").addEventListener("click", () => { out.querySelectorAll("[data-ics]").forEach((c) => (c.checked = true)); byId("ics-past").checked = !!pastN; byId("ics-fut").checked = !!futN; });
  byId("ics-none").addEventListener("click", () => { out.querySelectorAll("[data-ics]").forEach((c) => (c.checked = false)); byId("ics-past").checked = false; byId("ics-fut").checked = false; });
  if (byId("ics-norec")) byId("ics-norec").addEventListener("click", () => out.querySelectorAll(".ics-row.rec [data-ics]").forEach((c) => (c.checked = false)));
  byId("ics-import").addEventListener("click", () => icsImport());
}
function icsImport() {
  const out = byId("ics-result");
  let schId = byId("ics-sch").value;
  if (schId === "__new") {
    const palette = ["#4a8fff", "#b06bff", "#7cd99e", "#f5c46f", "#e068ff", "#62e3ff", "#ff6b6b", "#fb923c"];
    const s = { id: uid("sch"), name: (_icsCalName || "Imported").slice(0, 24), color: palette[(state.schedules || []).length % palette.length], hidden: false };
    state.schedules.push(s); schId = s.id;
  }
  const picks = [...out.querySelectorAll("[data-ics]:checked")].map((c) => _icsEvents[+c.dataset.ics]).filter((e) => e && e.date);
  picks.forEach((e) => state.events.push({ id: uid("ev"), scheduleId: schId,
    title: e.title + (e.recurring ? " (recurring)" : ""), date: e.date,
    start: e.allDay ? "" : (e.start || ""), end: e.allDay ? "" : (e.end || ""), allDay: !!e.allDay,
    notes: e.recurring ? ("imported · " + (e.rrule || "recurring") + " · only the first date is shown (full recurrence = future upgrade)") : "imported from .ics",
    importedUid: e.uid || "" }));
  closePopup(); scheduleSave(); renderCalendar(); toast(`📅 imported ${picks.length} event${picks.length !== 1 ? "s" : ""}`);
}

// ---- Prayer-times calendar seeding (v6.1.4) - block out each daily prayer over the next week/month ----
// Data lives in data/prayer_times.json (the mosque's timetable, keyed "MM-DD"); loaded ON DEMAND so
// it can never affect app startup. Default block = 5 min before the adhan + 25 min after (30 min), per-prayer adjustable.
const PRAYERS = [{ key: "fajr", name: "Fajr" }, { key: "dhuhr", name: "Dhuhr" }, { key: "asr", name: "Asr" },
  { key: "maghrib", name: "Maghrib" }, { key: "isha", name: "Isha" }];
// v6.6.3: on Fridays the Dhuhr congregational prayer is Jumu'ah (display name only; the machine key stays "dhuhr").
function prayerLabel(prKey, prName, d) { return (prKey === "dhuhr" && d && d.getDay() === 5) ? "Jumu'ah" : prName; }
let _prayerData = null;
async function loadPrayerTimes() {
  if (_prayerData) return _prayerData;
  try { _prayerData = await (await fetch("/api/prayer_times")).json(); } catch (_) { _prayerData = { times: {} }; }
  return _prayerData || { times: {} };
}
function _mmdd(d) { return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function _minToHM(m) { m = Math.max(0, Math.min(24 * 60 - 1, Math.round(m))); return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
function _hmToMin(s) { const p = String(s || "").split(":"); return (+p[0] || 0) * 60 + (+p[1] || 0); }
async function openPrayerPopulate() {
  const data = await loadPrayerTimes();
  const have = data && data.times && Object.keys(data.times).length;
  const schs = state.schedules || [];
  const def = (state.meta.ui && state.meta.ui.prayerBlock) || {};
  const rows = PRAYERS.map((pr) => {
    const b = def[pr.key] && def[pr.key].before != null ? def[pr.key].before : 5;
    const a = def[pr.key] && def[pr.key].after != null ? def[pr.key].after : 25;
    return `<div class="pr-row"><label class="pr-on"><input type="checkbox" data-pr="${pr.key}" checked> ${pr.name}</label>
      <span class="pr-blk"><input type="number" class="pr-bef" data-pr="${pr.key}" min="0" max="120" value="${b}"><small>min before</small>
      <input type="number" class="pr-aft" data-pr="${pr.key}" min="0" max="180" value="${a}"><small>min after</small></span></div>`;
  }).join("");
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card pr-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#34d399">📿 populate prayer times</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    ${isTravel() ? `<div class="hist-note" style="border-left:3px solid #9aa4b5">✈ <b>Travel mode</b>: prayers will be <b>combined &amp; shortened</b> - Fajr, Dhuhr+Asr, Maghrib+Isha (~${(state.meta.travel || {}).mins || 40} min each). The per-prayer rows below are ignored (only Fajr's on/off applies). Change combine times in ✈ Travel.</div>` : ""}
    ${have ? `<div class="hist-note">${esc(data.mosque || "Prayer times")} - blocks out each prayer as a calendar event. Default: <b>5 min before the adhan + 25 min after</b> (a 30-min block). Adjust any prayer below.</div>`
      : `<div class="hist-note">No prayer times loaded yet - upload your mosque's PDF below to get started.</div>`}
    <div class="pr-upload-row"><button class="ghost-btn sm" data-act="cal-prayer-upload" title="upload a PDF of your mosque's timetable - it's read into prayer times automatically">⬆ Upload prayer times in your mosque (PDF)</button></div>
    <div class="fld-row">
      <label class="fld"><span>Range (from tomorrow)</span><select id="pr-range"><option value="7">Next 7 days</option><option value="30">Next 30 days</option></select></label>
      <label class="fld"><span>Into schedule</span><select id="pr-sch">${schs.map((s) => `<option value="${s.id}" ${/pray/i.test(s.name) ? "selected" : ""}>${esc(s.name)}</option>`).join("")}<option value="__new">＋ new "Prayer" schedule</option></select></label>
    </div>
    <div class="pr-list">${rows}</div>
    <div class="drawer-actions"><button class="glow-btn" id="pr-go" ${have ? "" : "disabled"}>Populate calendar</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  if (have) byId("pr-go").addEventListener("click", () => populatePrayers());
}
async function populatePrayers() {
  const data = await loadPrayerTimes();
  if (!data || !data.times || !Object.keys(data.times).length) { toast("no prayer-times data"); return; }
  const pop = byId("popup");
  const days = +byId("pr-range").value;
  let schId = byId("pr-sch").value;
  if (schId === "__new") { const s = { id: uid("sch"), name: "Prayer", color: "#34d399", hidden: false }; state.schedules.push(s); schId = s.id; }
  const cfg = {}, remember = {};
  PRAYERS.forEach((pr) => {
    cfg[pr.key] = {
      on: pop.querySelector(`.pr-on input[data-pr="${pr.key}"]`).checked,
      before: +pop.querySelector(`.pr-bef[data-pr="${pr.key}"]`).value || 0,
      after: +pop.querySelector(`.pr-aft[data-pr="${pr.key}"]`).value || 0,
    };
    remember[pr.key] = { before: cfg[pr.key].before, after: cfg[pr.key].after };
  });
  state.meta.ui = state.meta.ui || {}; state.meta.ui.prayerBlock = remember;
  const today = new Date(); let added = 0, missing = 0;
  const tv = isTravel() ? (state.meta.travel || {}) : null; // v6.3.1: combined + shortened prayers while travelling
  for (let off = 1; off <= days; off++) {
    const d = new Date(today); d.setDate(today.getDate() + off);
    const ds = _isod(d), times = data.times[_mmdd(d)];
    if (!times) { missing++; continue; }
    if (tv) { // 3 blocks: Fajr, Dhuhr+Asr (jam'), Maghrib+Isha (jam') - each shortened to ~40 min
      const mins = tv.mins || 40;
      const block = (title, t, len) => { if (!t) return; const b = _hmToMin(t); state.events.push({ id: uid("ev"), scheduleId: schId, title: "🕌 " + title, date: ds, start: t, end: _minToHM(b + len), allDay: false, notes: title + " · " + t + " · travelling (combined/shortened)", prayer: "travel" }); added++; };
      if (cfg.fajr.on) block("Fajr", times.fajr, Math.min(30, mins));
      block((d.getDay() === 5 ? "Jumu'ah + Asr" : "Dhuhr + Asr"), tv.dhuhrAsrAt === "asr" ? times.asr : times.dhuhr, mins); // v6.6.3: Jumu'ah on Fridays
      block("Maghrib + Isha", tv.maghribIshaAt === "isha" ? times.isha : times.maghrib, mins);
      continue;
    }
    PRAYERS.forEach((pr) => {
      if (!cfg[pr.key].on || !times[pr.key]) return;
      const base = _hmToMin(times[pr.key]);
      const _pn = prayerLabel(pr.key, pr.name, d); // v6.6.3: Jumu'ah on Fridays
      state.events.push({ id: uid("ev"), scheduleId: schId, title: "🕌 " + _pn, date: ds,
        start: _minToHM(base - cfg[pr.key].before), end: _minToHM(base + cfg[pr.key].after),
        allDay: false, notes: _pn + " adhan " + times[pr.key] + " · prayer block", prayer: pr.key });
      added++;
    });
  }
  let anchored = 0;
  if (tv) anchored = await travelAnchorSchedule(schId, days, cfg, data); // v6.4.10: habits after their anchor prayer
  closePopup(); scheduleSave(); renderCalendar();
  toast(`📿 added ${added} prayer block${added !== 1 ? "s" : ""}${tv ? " (travel: combined)" : ""}${anchored ? " + " + anchored + " habit block" + (anchored !== 1 ? "s" : "") : ""}${missing ? " · " + missing + " day(s) had no data" : ""}`);
}
// ---- v6.4.7b: AI "Calendarize tomorrow" - lay out tomorrow's active tasks as time blocks ----
// Importance-first, prayer/event aware (never overlaps fixed blocks). Each block is reviewed (accept/edit/reject);
// every decision logs the AI proposal + your correction + the reason + a FULL task-overview snapshot.
let _calzProposal = null; // { date, blocks:[{taskId,start,end,reason}], callId, snapshot }
function _fixedBlocksFor(ds, d) {
  const out = [];
  const def = (state.meta.ui && state.meta.ui.prayerBlock) || {};
  const times = (_prayerData && _prayerData.times && _prayerData.times[_mmdd(d)]) || null;
  if (times) PRAYERS.forEach((pr) => {
    if (!times[pr.key]) return;
    const base = _hmToMin(times[pr.key]);
    const bef = def[pr.key] && def[pr.key].before != null ? def[pr.key].before : 5;
    const aft = def[pr.key] && def[pr.key].after != null ? def[pr.key].after : 25;
    out.push({ label: prayerLabel(pr.key, pr.name, d) + " (prayer)", start: _minToHM(base - bef), end: _minToHM(base + aft) }); // v6.6.3: Jumu'ah on Fridays
  });
  eventsOn(ds).filter((e) => !e.allDay && e.start).forEach((e) => out.push({ label: e.title, start: e.start, end: e.end || _minToHM(_hmToMin(e.start) + 30) }));
  return out;
}
function _taskOverviewSnapshot() {
  const a = state.items.filter((i) => i.status === "active" && i.type !== "rhythm");
  return { at: nowIso(), counts: { active: a.length, inbox: state.items.filter((i) => i.status === "inbox").length, done: state.items.filter((i) => i.status === "done").length },
    active: a.map((i) => ({ id: i.id, title: i.title, importance: i.importance, eta: i.estimateMins || null, due: (i.urgency && i.urgency.due) || null, category: (cat(i.categoryId) || {}).name || null })) };
}
async function calendarizeNextDay() {
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1); const ds = _isod(tmr);
  const active = state.items.filter((i) => i.status === "active" && i.type !== "rhythm");
  if (!active.length) { toast("nothing active to calendarize"); return; }
  await loadPrayerTimes();
  const fixed = _fixedBlocksFor(ds, tmr);
  _calzHiddenCats.clear(); // v6.6.13: each new plan starts unfiltered
  let res, aiFailed = false;
  if (aiStatus.enabled) { // v6.7.8: only the AI path needs the key; the offline _deterministicCalz fallback below ALWAYS runs, so the keyless share still lays tomorrow out (and the tour's calendarize beat works without a key)
    showAiLoading("✦ planning tomorrow..."); // a visible loader while the model lays out the day (it takes a few seconds)
    try {
      res = await aiFetch("calendarize", { date: ds, weekday: CAL_FULLDOW[tmr.getDay()],
        tasks: active.map((i) => ({ id: i.id, title: i.title, importance: i.importance, eta_minutes: i.estimateMins || null, due: (i.urgency && i.urgency.due) || null, parallel: !!i.parallel })),
        fixed });
    } catch (e) { aiFailed = true; }
    finally { hideAiLoading(); }
  }
  let blocks = ((res && res.blocks) || []).filter((b) => b && b.taskId && b.start && b.end && item(b.taskId));
  let fellBack = false;
  if (!blocks.length) { blocks = _deterministicCalz(active, fixed); fellBack = true; } // v6.6.2: never leave the user empty-handed
  // v6.6.33: a task the owner marked "parallel" must ALWAYS be planned (overlapping) - if the AI/fallback skipped it, add it now
  const _sched = new Set(blocks.map((b) => b.taskId));
  active.filter((i) => i.parallel && !_sched.has(i.id)).forEach((i) => { const dur = Math.max(15, Math.min(240, i.estimateMins || 30));
    blocks.push({ taskId: i.id, start: "09:00", end: _minToHM(Math.min(22 * 60, 9 * 60 + dur)), reason: "runs in parallel with your other work" }); });
  if (!blocks.length) { toast(aiFailed ? "⚠ AI unavailable and no free time found" : "✦ no room to schedule tomorrow"); return; }
  // v6.6.10: render the proposal as transient preview events on a temp gold schedule, then open the editable day-view.
  const sch = { id: uid("calzsch"), name: "✦ proposed", color: "#f5c46f", hidden: false, _calzPreview: true };
  (state.schedules = state.schedules || []).push(sch); state.events = state.events || [];
  blocks.forEach((b) => { const it = item(b.taskId); if (it) state.events.push({ id: uid("calzev"), scheduleId: sch.id, title: it.title, date: ds, start: b.start, end: b.end, allDay: false, notes: "calendarize preview", taskId: it.id, _calzPreview: true }); });
  _calzProposal = { date: ds, callId: fellBack ? null : lastCallId(), fallback: fellBack, snapshot: _taskOverviewSnapshot(),
    schId: sch.id, original: blocks.map((b) => ({ taskId: b.taskId, start: b.start, end: b.end, reason: b.reason })), changeLog: [], fixed };
  openCalzDay();
  if (fellBack) toast(aiFailed ? "✦ AI was busy - laid it out by importance" : "✦ laid it out by importance");
}
// ---- v6.6.41: calendarize-preferences quiz - teaches the calendarizer HOW the owner likes their day laid out ----
// Answers are saved server-side (data/calz_prefs.json) and analyzed by the FLAGSHIP model into a profile that is then
// injected into the calendarize prompt. Each question is one answer OR "None / it depends" with a required reason.
const CALZ_QUIZ = [
  { id: "energy_peak", q: "When is your focus sharpest for hard, hands-on work?", opts: ["Morning - front-load critical work early", "Afternoon - I ramp up after midday", "Evening or night - I peak late"] },
  { id: "warmup_vs_hardest", q: "To start the day, ease in or hit the hardest thing first?", opts: ["Hardest / most important first", "Easy warm-ups, then the hard one", "Depends how I feel that morning"] },
  { id: "block_length", q: "How long can you stay locked into one task before a real break?", opts: ["Short sprints (~25-45 min)", "Medium (~60-90 min)", "Long deep dives (2+ hours)"] },
  { id: "buffers", q: "Between focused blocks, how much breathing room do you want?", opts: ["Tight - 5 min, keep momentum", "A real reset - 15-30 min", "Long recharge - 30+ min"] },
  { id: "protected_break", q: "Should a real meal / rest break be protected and never skipped?", yesno: true },
  { id: "batching", q: "Should small similar tasks (errands, replies, admin) be batched into one block?", yesno: true },
  { id: "deadline_vs_importance", q: "Two tasks want the best slot - one due soonest, one matters most. Which wins?", opts: ["Soonest deadline wins", "Most important wins", "Balance both, case by case"] },
  { id: "day_fullness", q: "How full should your day be packed?", opts: ["Lean - top priorities, lots of slack", "Balanced - busy but breathing room", "Maxed - fit as much as possible"] },
  { id: "parallel_aggressiveness", q: "How eagerly should background / waiting tasks stack onto focused work?", opts: ["Aggressively - overlap whenever plausible", "Only clearly hands-off tasks (downloads, builds)", "Sparingly - I dislike doing two at once"] },
  { id: "prayer_handling", q: "Beyond never overlapping the 5 prayers, how should they shape the day?", opts: ["Anchor work transitions to them", "Pad ~10-15 min before / after each", "Just don't overlap them, otherwise ignore"] },
  { id: "day_bounds", q: "What is your real working window for getting things done tomorrow?", opts: ["Early bird (~6-7am to ~6pm)", "Standard (~8am to ~10pm)", "Night owl - later start, past 10pm"] },
];
let _calzQuizState = null;
function openCalzQuiz() {
  const p = byId("popup"); _calzQuizState = { answers: {} };
  const items = CALZ_QUIZ.map((q, i) => {
    const opts = q.yesno ? ["Yes", "No"] : q.opts;
    const btns = opts.map((o) => `<button type="button" class="cq-opt" data-cq="${q.id}" data-val="${esc(o)}">${esc(o)}</button>`).join("");
    return `<div class="cq-item" data-cq-item="${q.id}">
      <div class="cq-q"><span class="cq-n">${i + 1}</span><span>${esc(q.q)}</span></div>
      <div class="cq-opts">${btns}<button type="button" class="cq-opt cq-none" data-cq="${q.id}" data-val="none">None / it depends</button></div>
      <textarea class="cq-reason" data-cq-reason="${q.id}" rows="2" placeholder="why? (required when you pick None / it depends)" hidden></textarea>
    </div>`;
  }).join("");
  p.innerHTML = `<div class="popup-card cq-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold,#f5c46f)">✦ how do you like your day planned?</span><button class="ghost-btn" id="cqDismiss">✕</button></div>
    <div class="cq-intro">Answer these so Himmah lays out tomorrow YOUR way. Pick one per question, or "None / it depends" with a reason. About 5 minutes. <span class="cq-prog" id="cqProg">0/${CALZ_QUIZ.length}</span><span class="cq-last" id="cqLast"></span></div>
    <div class="cq-list">${items}</div>
    <div class="drawer-actions"><button class="glow-btn" id="cqSave" disabled>✦ Save & tune my calendar</button></div>
  </div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  p.querySelectorAll(".cq-opt").forEach((b) => b.addEventListener("click", () => _cqPick(b.dataset.cq, b.dataset.val)));
  p.querySelectorAll(".cq-reason").forEach((t) => t.addEventListener("input", _cqUpd));
  byId("cqSave").addEventListener("click", _cqSubmit);
  byId("cqDismiss").addEventListener("click", () => closePopup());
  fetch("/api/calz_prefs").then((r) => r.json()).then((d) => { const el = byId("cqLast"); if (el && d && d.updated) el.textContent = " You last tuned this on " + String(d.updated).slice(0, 10) + "."; }).catch(() => {});
}
function _cqPick(id, val) {
  const a = (_calzQuizState.answers[id] = _calzQuizState.answers[id] || {}); a.choice = val;
  document.querySelectorAll('.cq-opt[data-cq="' + id + '"]').forEach((b) => b.classList.toggle("on", b.dataset.val === val));
  const rt = document.querySelector('.cq-reason[data-cq-reason="' + id + '"]');
  if (rt) { rt.hidden = val !== "none"; if (val === "none") rt.focus(); }
  _cqUpd();
}
function _cqUpd() {
  const a = _calzQuizState.answers;
  document.querySelectorAll(".cq-reason").forEach((t) => { const id = t.dataset.cqReason; if (a[id]) a[id].reason = t.value.trim(); });
  const answered = CALZ_QUIZ.filter((q) => { const x = a[q.id]; return x && x.choice && (x.choice !== "none" || (x.reason && x.reason.length)); }).length;
  const prog = byId("cqProg"); if (prog) prog.textContent = answered + "/" + CALZ_QUIZ.length;
  const save = byId("cqSave"); if (save) save.disabled = answered < CALZ_QUIZ.length;
}
async function _cqSubmit() {
  const a = _calzQuizState.answers;
  const answers = CALZ_QUIZ.map((q) => ({ id: q.id, q: q.q, choice: a[q.id].choice,
    reason: a[q.id].choice === "none" ? (a[q.id].reason || "") : (a[q.id].reason || null) }));
  const save = byId("cqSave"); if (save) { save.disabled = true; save.textContent = "✦ analyzing your style..."; }
  let res;
  try { res = await fetch("/api/calz_prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers }) }).then((r) => r.json()); }
  catch (e) { toast("⚠ could not save - " + e.message); if (save) { save.disabled = false; save.textContent = "✦ Save & tune my calendar"; } return; }
  if (res && res.status) { Object.assign(aiStatus, res.status); renderAiChip(); }
  _cqShowResult(res || {});
}
function _cqShowResult(res) {
  const p = byId("popup");
  const rules = (res.rules || []).map((r) => `<li>${esc(r)}</li>`).join("");
  const body = res.analyzed
    ? `<div class="cq-intro">Himmah will plan tomorrow like this from now on:</div>
       ${res.profile ? `<div class="eta-why" style="font-style:normal">${esc(res.profile)}</div>` : ""}
       ${rules ? `<ul class="cq-rules">${rules}</ul>` : ""}`
    : `<div class="cq-intro">Saved your answers. ${esc(res.ai_error || "The AI could not analyze them right now")} - they will still shape your next Calendarize once the AI is back.</div>`;
  p.innerHTML = `<div class="popup-card cq-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold,#f5c46f)">✦ your calendarize style</span><button class="ghost-btn" id="cqDismiss2">✕</button></div>
    ${body}
    <div class="drawer-actions"><button class="glow-btn" id="cqDone">✓ Done</button></div>`;
  byId("cqDone").addEventListener("click", () => closePopup());
  byId("cqDismiss2").addEventListener("click", () => closePopup());
  toast(res.analyzed ? "✦ Himmah learned your calendarize style" : "✦ answers saved");
}
// v6.6.2: deterministic day-plan - importance-first, packed into free gaps around fixed blocks (prayers/events).
function _deterministicCalz(active, fixed) {
  const busy = (fixed || []).map((f) => [_hmToMin(f.start), _hmToMin(f.end)]).sort((a, b) => a[0] - b[0]);
  // v6.6.33: PARALLEL tasks (i.parallel) run alongside other work, so they do not take an exclusive slot.
  const par = active.filter((i) => i.parallel), ser = active.filter((i) => !i.parallel);
  const ranked = ser.slice().sort((a, b) => (b.importance || 1) - (a.importance || 1)
    || (((a.urgency && a.urgency.due) || "9999") < ((b.urgency && b.urgency.due) || "9999") ? -1 : 1));
  const out = []; let cur = 9 * 60; const DAY_END = 21 * 60;
  for (const it of ranked) {
    const dur = Math.max(15, Math.min(180, it.estimateMins || 30));
    let scan = cur, guard = 0;
    while (scan + dur <= DAY_END && guard++ < 300) {
      const hit = busy.find(([bs, be]) => scan < be && scan + dur > bs);
      if (hit) { scan = hit[1]; continue; } // jump past the conflicting fixed block
      out.push({ taskId: it.id, start: _minToHM(scan), end: _minToHM(scan + dur) });
      busy.push([scan, scan + dur]); busy.sort((a, b) => a[0] - b[0]);
      cur = scan + dur + 10; break; // 10-min breather between hands-on tasks
    }
    // if it does not fit, skip THIS task (do not break - a later smaller task may still fit a gap)
  }
  // parallel tasks: overlap the day from the start (they run while the serial work happens). ALWAYS placed.
  par.forEach((it) => { const dur = Math.max(15, Math.min(240, it.estimateMins || 30)); out.push({ taskId: it.id, start: _minToHM(9 * 60), end: _minToHM(Math.min(DAY_END + 60, 9 * 60 + dur)) }); });
  return out;
}
// v6.6.10: Calendarize is now an EDITABLE day-view. Proposed blocks are transient _calzPreview events on a temp
// gold schedule, rendered by the existing _dayBody, drag/resized by the existing _gp engine. Every edit logs to a
// change-log; one "Commit to Calendar" turns them into real Tasks-schedule events and asks ONE reason-why.
function _calzPreviewEvents() { return (state.events || []).filter((e) => e._calzPreview); }
function _calzCleanup() { state.events = (state.events || []).filter((e) => !e._calzPreview); state.schedules = (state.schedules || []).filter((s) => !s._calzPreview); }
function _calzLog(action, taskId, from, to) { if (_calzProposal) _calzProposal.changeLog.push({ action, taskId, from, to, at: nowIso() }); }
function _calzDecorateBlocks() {
  const wrap = byId("calzDayWrap"); if (!wrap) return;
  // v6.6.19: number each block by start-time order so it keys to the readable left "Scheduled" list
  const order = _calzPreviewEvents().slice().sort((a, b) => _hmToMin(a.start) - _hmToMin(b.start));
  const idx = {}; order.forEach((e, i) => { idx[e.id] = i + 1; });
  wrap.querySelectorAll('.day-ev[data-id^="calzev"]').forEach((el) => {
    const id = el.dataset.id;
    let badge = el.querySelector(".calz-ev-n");
    if (!badge) { badge = document.createElement("span"); badge.className = "calz-ev-n"; el.insertBefore(badge, el.firstChild); }
    badge.textContent = idx[id] || "";
    if (el.querySelector(".calz-ev-tools")) return;
    const tools = document.createElement("span"); tools.className = "calz-ev-tools";
    tools.innerHTML = `<button class="calz-ev-btn" data-act="calz-eta" data-id="${id}" title="change duration">⏱</button><button class="calz-ev-btn" data-act="calz-replace" data-id="${id}" title="swap task">⇄</button><button class="calz-ev-btn" data-act="calz-remove" data-id="${id}" title="remove">✕</button>`;
    el.appendChild(tools);
  });
}
// v6.6.19: the LEFT panel - every SCHEDULED block, numbered to match its grid badge, with category colour + time.
// Click a row to jump to that block; the small swap button replaces it with another task. (Left scheduled + right
// unscheduled = every task is visible, and the numbers make each block identifiable without relying on tiny in-block text.)
function _calzRenderSchedList() {
  const list = byId("calzSchedList"); if (!list) return;
  const evs = _calzPreviewEvents().slice().sort((a, b) => _hmToMin(a.start) - _hmToMin(b.start));
  list.innerHTML = evs.map((e, i) => { const t = item(e.taskId), c = t && cat(t.categoryId), col = (c && c.color) || "#8a93a6";
    return `<div class="calz-chip calz-sched-row" draggable="true" data-calz-evchip data-act="calz-focus" data-id="${e.id}" style="--c:${col}" title="${esc(e.title)} - drag to the grid to move it, or to Other Tasks to un-schedule it"><span class="calz-ev-n sm">${i + 1}</span><span class="calz-chip-title">${esc(e.title)}</span><span class="calz-chip-eta">${esc(e.start)}</span><button class="calz-ev-btn calz-row-swap" data-act="calz-replace" data-id="${e.id}" title="swap this block for another task">⇄</button><button class="calz-ev-btn calz-row-rm" data-act="calz-remove" data-id="${e.id}" title="remove this block from the plan">✕</button></div>`; }).join("");
  const n = byId("calzSchedN"); if (n) n.textContent = evs.length;
  const empty = byId("calzSchedEmpty"); if (empty) empty.hidden = evs.length > 0;
}
function calzFocusBlock(evId) {
  const wrap = byId("calzDayWrap"); if (!wrap) return;
  const el = wrap.querySelector(`.day-ev[data-id="${evId}"]`); if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("calz-flash"); setTimeout(() => el.classList.remove("calz-flash"), 900);
}
// v6.6.26: the RIGHT panel is now "Other Tasks" - ALL active non-rhythm tasks (not just unplaced), grouped by
// category, sorted by urgency within each group, live-filtered by #calzOtherQ. Already-placed tasks are DIMMED
// (not hidden) and stay draggable, so you can add a second block. Every row keeps [data-calz-chip]+data-id, so the
// existing drag-to-grid (the delegated dragstart at ~1813) creates a preview block for any of them. Name kept so callers do not churn.
let _calzOtherQ = "";
function _calzUrgRank(i) { const d = i.urgency && i.urgency.due; return [d ? _dnum(d) : Infinity, i.urgency && i.urgency.soon ? 0 : 1, -(i.importance || 0)]; } // lower = more urgent: due date, then "soon", then importance
function _calzRenderTray() {
  const list = byId("calzTrayList"); if (!list) return;
  const placed = new Set(_calzPreviewEvents().map((e) => e.taskId));
  const q = _calzOtherQ.trim().toLowerCase();
  let all = state.items.filter((i) => i.status === "active" && i.type !== "rhythm" && !isMacro(i) && !isNestedUnderMacro(i) && !isWaiting(i) && !placed.has(i.id)); // v6.6.29: Other Tasks = only tasks NOT already proposed (the complement of the left Proposed list)
  if (q) all = all.filter((i) => { const c = cat(i.categoryId); return (i.title + " " + ((c && c.name) || "")).toLowerCase().includes(q); });
  const groups = new Map();
  all.forEach((i) => { const c = cat(i.categoryId), key = c ? c.id : "_none";
    if (!groups.has(key)) groups.set(key, { name: c ? c.name : "uncategorised", color: (c && c.color) || "#8a93a6", items: [] });
    groups.get(key).items.push(i); });
  const ordered = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  ordered.forEach((g) => g.items.sort((a, b) => { const ra = _calzUrgRank(a), rb = _calzUrgRank(b); return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.title.localeCompare(b.title); }));
  list.innerHTML = ordered.map((g) => {
    const rows = g.items.map((i) => { const im = IMP[i.importance] || IMP[1]; const due = i.urgency && i.urgency.due, dueTag = due ? `<span class="calz-chip-eta">⏰ ${esc(due.slice(5))}</span>` : "";
      return `<div class="calz-chip" draggable="true" data-calz-chip data-id="${i.id}" style="--c:${g.color}" title="${esc(i.title)} - drag onto the grid to schedule it"><span class="calz-chip-title">${esc(i.title)}</span><span class="calz-imp" style="color:${im.color}">${im.label}</span>${i.estimateMins ? `<span class="calz-chip-eta">${i.estimateMins}m</span>` : ""}${dueTag}</div>`; }).join("");
    return `<div class="calz-other-group"><div class="calz-other-ghead"><i style="background:${g.color}"></i>${esc(g.name)}</div>${rows}</div>`; }).join("");
  const n = byId("calzTrayN"); if (n) n.textContent = all.length;
  const empty = byId("calzTrayEmpty"); if (empty) { empty.hidden = all.length > 0; empty.textContent = _calzOtherQ.trim() ? "no matching tasks" : "every task is already proposed"; } // v6.6.29
}
function _calzRenderLegend() { // v6.6.13: a per-task-category legend that toggles blocks in/out of view (NOT delete)
  const el = byId("calzCatLegend"); if (!el) return;
  const ids = [...new Set(_calzPreviewEvents().map((e) => { const t = item(e.taskId); return t ? (t.categoryId || "_none") : "_none"; }))];
  el.innerHTML = ids.length > 1 ? ids.map((cid) => { const c = cat(cid === "_none" ? null : cid), col = (c && c.color) || "#8a93a6", nm = c ? c.name : "uncategorised";
    return `<button class="calz-cat-chip ${_calzHiddenCats.has(cid) ? "off" : ""}" data-act="calz-cat-toggle" data-cid="${cid}" style="--c:${col}"><i></i>${esc(nm)}</button>`; }).join("") : "";
}
function _calzRerender() {
  const P = _calzProposal, wrap = byId("calzDayWrap"); if (!P || !wrap) return;
  const sc = wrap.scrollTop; wrap.innerHTML = _dayBody(new Date(P.date + "T00:00:00")); _calzDecorateBlocks(); _calzRenderTray(); _calzRenderSchedList(); _calzRenderLegend(); wrap.scrollTop = sc;
}
function openCalzDay() {
  const P = _calzProposal; if (!P) return; const p = byId("popup"); const d = new Date(P.date + "T00:00:00");
  _calzOtherQ = ""; // v6.6.26: fresh search each open
  const lbl = CAL_FULLDOW[d.getDay()].slice(0, 3) + " " + d.getDate() + " " + CAL_MONTHS[d.getMonth()].slice(0, 3);
  p.innerHTML = `<div class="popup-card calz-day-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#f5c46f">✦ Calendarize <span id="calzDateLbl">${lbl}</span></span><button class="ghost-btn" data-act="calz-cancel">✕</button></div>
    <div class="hist-note">Drag a block to move it, drag its edges to resize, or use its tools (⏱ duration · ⇄ swap · ✕ remove). Drag tasks freely between Other Tasks, the grid and Proposed Tasks - drop on the grid to time it; hold SHIFT and drag a block onto Other Tasks to un-schedule it (SHIFT locks the time so you never move it by accident; the box lights up red), or drag a Proposed row there. Two tasks at the same time is fine (parallel work). ↩ Undo / ↪ Redo your edits. Nothing touches your calendar until you Commit.</div>
    <div class="calz-day-stage">
      <aside class="calz-tray calz-sched"><div class="calz-tray-head">Proposed Tasks <span class="calz-tray-n" id="calzSchedN">0</span></div><div class="calz-tray-list" id="calzSchedList"></div><div class="calz-tray-empty" id="calzSchedEmpty" hidden>nothing proposed yet</div></aside>
      <div class="calz-main">
        <div class="calz-cat-legend" id="calzCatLegend"></div>
        <div class="cal-day-wrap calz-day-grid" id="calzDayWrap">${_dayBody(d)}</div>
      </div>
      <aside class="calz-tray calz-other"><div class="calz-tray-head">Other Tasks <span class="calz-tray-n" id="calzTrayN">0</span></div>
        <div class="calz-other-search"><span class="calz-other-ico">⌕</span><input id="calzOtherQ" class="calz-other-input" type="text" autocomplete="off" spellcheck="false" placeholder="search tasks…"></div>
        <div class="calz-tray-list" id="calzTrayList"></div><div class="calz-tray-empty" id="calzTrayEmpty" hidden>no matching tasks</div></aside>
    </div>
    <div class="drawer-actions"><button class="glow-btn" data-act="calz-commit">Commit to Calendar</button><button class="ghost-btn" id="calzUndoBtn" data-act="calz-undo" disabled title="undo the last change to this plan">↩ Undo</button><button class="ghost-btn" id="calzRedoBtn" data-act="calz-redo" disabled title="redo - step forward again">↪ Redo</button><button class="ghost-btn" data-act="calz-cancel">Discard</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => { p.classList.add("open"); _calzDecorateBlocks(); _calzRenderTray(); _calzRenderSchedList(); _calzRenderLegend(); const w = byId("calzDayWrap"); if (w) w.scrollTop = 8 * DAY_HOUR_H; });
}
function calzEta(evId) {
  const ev = _calzPreviewEvents().find((e) => e.id === evId); if (!ev) return;
  const curDur = _hmToMin(ev.end) - _hmToMin(ev.start);
  const el = byId("calzDayWrap").querySelector(`.day-ev[data-id="${evId}"]`); const r = el ? el.getBoundingClientRect() : { left: 200, bottom: 200 };
  document.querySelectorAll(".calz-eta-pop").forEach((x) => x.remove());
  const pop = document.createElement("div"); pop.className = "calz-eta-pop"; pop.style.left = Math.min(window.innerWidth - 170, r.left) + "px"; pop.style.top = (r.bottom + 4) + "px";
  pop.innerHTML = `<input type="number" min="5" step="5" value="${curDur}" id="calzEtaIn"> <small>min</small> <button class="ibx-btn enhance" id="calzEtaGo">set</button>`;
  document.body.appendChild(pop); const inp = byId("calzEtaIn"); inp.focus(); inp.select();
  const commit = () => { _calzSnapshot(); const mins = Math.max(5, +inp.value || curDur); ev.end = _minToHM(Math.min(24 * 60, _hmToMin(ev.start) + mins)); _calzLog("eta", ev.taskId, { mins: curDur }, { mins }); pop.remove(); _calzRerender(); };
  byId("calzEtaGo").addEventListener("click", commit);
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { pop.remove(); } });
}
function calzReplace(evId) {
  const ev = _calzPreviewEvents().find((e) => e.id === evId); if (!ev) return;
  const placed = new Set(_calzPreviewEvents().map((e) => e.taskId));
  const cands = state.items.filter((i) => i.status === "active" && i.type !== "rhythm" && !isMacro(i) && (i.id === ev.taskId || !placed.has(i.id)));
  document.querySelectorAll(".calz-eta-pop").forEach((x) => x.remove());
  const sel = document.createElement("div"); sel.className = "calz-eta-pop calz-replace-pop"; sel.style.left = "50%"; sel.style.top = "120px"; sel.style.transform = "translateX(-50%)";
  sel.innerHTML = `<select id="calzRepSel">${cands.map((i) => `<option value="${i.id}" ${i.id === ev.taskId ? "selected" : ""}>${esc(i.title)}</option>`).join("")}</select> <button class="ibx-btn enhance" id="calzRepGo">swap</button>`;
  document.body.appendChild(sel);
  byId("calzRepGo").addEventListener("click", () => { const nid = byId("calzRepSel").value, ni = item(nid); if (ni && nid !== ev.taskId) { _calzSnapshot(); const oldId = ev.taskId, oldTitle = ev.title; ev.taskId = nid; ev.title = ni.title; _calzLog("replace", nid, { taskId: oldId, title: oldTitle }, { taskId: nid, title: ni.title }); } sel.remove(); _calzRerender(); });
}
function calzRemove(evId) {
  const ev = _calzPreviewEvents().find((e) => e.id === evId); if (!ev) return;
  _calzSnapshot();
  _calzLog("remove", ev.taskId, { start: ev.start, end: ev.end }, null);
  state.events = state.events.filter((x) => x.id !== evId); _calzRerender();
}
// v6.6.32/.34: undo + redo for the Calendarize day-view. Each mutating action snapshots the preview blocks first.
function _calzCapture() { const P = _calzProposal; return { evs: _calzPreviewEvents().map((e) => ({ id: e.id, scheduleId: e.scheduleId, title: e.title, date: e.date, start: e.start, end: e.end, taskId: e.taskId })), logLen: (P && P.changeLog ? P.changeLog.length : 0) }; }
function _calzApply(snap) {
  const P = _calzProposal; if (!P || !snap) return;
  state.events = (state.events || []).filter((e) => !e._calzPreview);
  snap.evs.forEach((s) => state.events.push(Object.assign({}, s, { allDay: false, notes: "calendarize preview", _calzPreview: true })));
  if (P.changeLog && snap.logLen != null) P.changeLog.length = snap.logLen;
  _calzRerender();
}
function _calzSnapshot() { const P = _calzProposal; if (!P) return; P.undo = P.undo || []; P.undo.push(_calzCapture()); if (P.undo.length > 60) P.undo.shift(); P.redo = []; _calzUpdUndoBtn(); } // a new change invalidates the redo stack
function calzUndo() { const P = _calzProposal; if (!P || !P.undo || !P.undo.length) { toast("nothing to undo"); return; } P.redo = P.redo || []; P.redo.push(_calzCapture()); _calzApply(P.undo.pop()); _calzUpdUndoBtn(); toast("↩ undone"); }
function calzRedo() { const P = _calzProposal; if (!P || !P.redo || !P.redo.length) { toast("nothing to redo"); return; } P.undo = P.undo || []; P.undo.push(_calzCapture()); _calzApply(P.redo.pop()); _calzUpdUndoBtn(); toast("↪ redone"); }
function _calzUpdUndoBtn() { const u = byId("calzUndoBtn"); if (u) u.disabled = !(_calzProposal && _calzProposal.undo && _calzProposal.undo.length); const r = byId("calzRedoBtn"); if (r) r.disabled = !(_calzProposal && _calzProposal.redo && _calzProposal.redo.length); }
function calzCancel() { closePopup(); }
function calzCommit() {
  const P = _calzProposal; if (!P) return; const prev = _calzPreviewEvents();
  for (const e of prev) { if (_hmToMin(e.end) <= _hmToMin(e.start)) { toast("a block has an invalid time - fix it first"); return; } }
  if (!prev.length) { toast("nothing to commit - the day is empty"); return; }
  const finalLayout = prev.map((e) => ({ taskId: e.taskId, start: e.start, end: e.end })).sort((a, b) => _hmToMin(a.start) - _hmToMin(b.start));
  askWhy("why these changes to tomorrow's plan? (helps Himmah learn how you shape a day)").then((reason) => {
    if (!_calzProposal) return;
    _calzCleanup();
    finalLayout.forEach((b) => _calzCreate(b.taskId, b.start, b.end));
    logOutcome({ call_id: P.callId, item_id: null, kind: "calendarize", decision: P.changeLog.length ? "edit" : "accept",
      ai_proposed: { date: P.date, blocks: P.original }, my_final: { date: P.date, blocks: finalLayout },
      change_log: P.changeLog, my_reason: reason || null, original_input: null, task_overview: P.snapshot });
    _calzProposal = null; closePopup(); scheduleSave(); renderCalendar(); render();
    toast("✦ tomorrow is on your calendar - " + finalLayout.length + " block" + (finalLayout.length !== 1 ? "s" : ""));
  });
}
function _calzCreate(taskId, start, end) {
  const it = item(taskId), P = _calzProposal; if (!it || !P) return;
  const sch = taskSchedule(); // v6.7.1: stable id, not name-matched
  state.events = state.events || [];
  state.events.push({ id: uid("ev"), scheduleId: sch.id, title: it.title, date: P.date, start, end, allDay: false, notes: "calendarized from a task", taskId: it.id });
}
// v6.6.30: unified day-view drag/drop. A drag is either a TASK (an Other Tasks chip) or a proposed EVENT (a Proposed
// Tasks row). Drop targets: the grid (task -> new block at the drop time; event -> reschedule), the Other Tasks box
// (event -> un-propose), the Proposed Tasks box (task -> propose at the next free slot). Grid blocks are moved by the
// pointer engine (_gp); releasing one over the Other box removes it (see the mouseup handler).
let _calzDrag = null; // { kind:"task"|"event", id }
function _calzAddTaskAt(taskId, mins) {
  const P = _calzProposal, t = item(taskId); if (!P || !t) return;
  _calzSnapshot();
  const dur = Math.max(15, t.estimateMins || 30), start = _minToHM(mins), end = _minToHM(Math.min(24 * 60, mins + dur));
  const sch = (state.schedules || []).find((s) => s.id === P.schId); if (!sch) return;
  state.events.push({ id: uid("calzev"), scheduleId: sch.id, title: t.title, date: P.date, start, end, allDay: false, notes: "calendarize preview", taskId, _calzPreview: true });
  _calzLog("add", taskId, null, { taskId, start, end }); _calzRerender();
}
function _calzAddTaskAuto(taskId) { // v6.6.33: propose without choosing a time. Parallel -> overlap from 09:00; else the next free slot.
  const t = item(taskId), prev = _calzPreviewEvents();
  if (prev.some((e) => e.taskId === taskId)) { toast("already proposed"); return; }
  let mins;
  if (t && t.parallel) { mins = 9 * 60; }
  else { const maxEnd = prev.length ? Math.max.apply(null, prev.map((e) => _hmToMin(e.end))) : 9 * 60; mins = Math.min(24 * 60 - 15, maxEnd); }
  _calzAddTaskAt(taskId, mins);
  const w = byId("calzDayWrap"); if (w) w.scrollTop = Math.max(0, mins / 60 * DAY_HOUR_H - 120); // bring the new block into view
  toast(t && t.parallel ? "scheduled in parallel" : "scheduled");
}
function _calzMoveEventTo(evId, mins) {
  const ev = _calzPreviewEvents().find((e) => e.id === evId); if (!ev) return;
  _calzSnapshot();
  const dur = Math.max(15, _hmToMin(ev.end) - _hmToMin(ev.start)), from = { start: ev.start, end: ev.end };
  const s = Math.max(0, Math.min(24 * 60 - dur, mins));
  ev.start = _minToHM(s); ev.end = _minToHM(Math.min(24 * 60, s + dur));
  _calzLog("move", ev.taskId, from, { start: ev.start, end: ev.end }); _calzRerender();
}
document.addEventListener("dragstart", (e) => {
  if (e.target.closest(".calz-ev-btn")) return; // a row's tool button, not a drag
  const chip = e.target.closest("[data-calz-chip]"), row = e.target.closest("[data-calz-evchip]");
  if (chip) { _calzDrag = { kind: "task", id: chip.dataset.id }; chip.classList.add("dragging"); }
  else if (row) { _calzDrag = { kind: "event", id: row.dataset.id }; row.classList.add("dragging"); }
}, true);
document.addEventListener("dragover", (e) => {
  if (!_calzDrag) return;
  const grid = e.target.closest(".calz-day-grid"), box = e.target.closest(".calz-tray");
  const ok = grid || (box && ((_calzDrag.kind === "task" && box.classList.contains("calz-sched")) || (_calzDrag.kind === "event" && box.classList.contains("calz-other"))));
  if (!ok) return;
  e.preventDefault();
  document.querySelectorAll(".calz-drop-hi").forEach((x) => x.classList.remove("calz-drop-hi"));
  (grid || box).classList.add("calz-drop-hi");
});
document.addEventListener("dragleave", (e) => { if (!_calzDrag) return; const z = e.target.closest(".calz-day-grid,.calz-tray"); if (z && !z.contains(e.relatedTarget)) z.classList.remove("calz-drop-hi"); });
document.addEventListener("drop", (e) => {
  if (!_calzDrag) return; const d = _calzDrag; _calzDrag = null;
  document.querySelectorAll(".calz-drop-hi").forEach((x) => x.classList.remove("calz-drop-hi"));
  if (!_calzProposal) return;
  const gridWrap = e.target.closest(".calz-day-grid");
  const otherBox = e.target.closest(".calz-tray.calz-other"), schedBox = e.target.closest(".calz-tray.calz-sched");
  if (gridWrap) {
    e.preventDefault();
    const grid = e.target.closest("[data-timegrid]") || gridWrap.querySelector("[data-timegrid]"); if (!grid) return;
    const rect = grid.getBoundingClientRect(); const mins = Math.max(0, Math.min(24 * 60 - 15, Math.round((e.clientY - rect.top) / DAY_HOUR_H * 60 / 15) * 15));
    if (d.kind === "task") _calzAddTaskAt(d.id, mins); else _calzMoveEventTo(d.id, mins);
  } else if (otherBox && d.kind === "event") { e.preventDefault(); calzRemove(d.id); } // proposed block -> Other Tasks = un-propose
  else if (schedBox && d.kind === "task") { e.preventDefault(); _calzAddTaskAuto(d.id); } // other task -> Proposed = schedule it
});
document.addEventListener("dragend", () => { document.querySelectorAll(".calz-chip.dragging,.calz-sched-row.dragging").forEach((x) => x.classList.remove("dragging")); document.querySelectorAll(".calz-drop-hi").forEach((x) => x.classList.remove("calz-drop-hi")); _calzDrag = null; });
document.addEventListener("input", (e) => { if (e.target && e.target.id === "calzOtherQ") { _calzOtherQ = e.target.value; _calzRenderTray(); } }); // v6.6.26: live-filter Other Tasks (repaints only the aside, so the search box keeps focus)
// ===================== Travelling Mode (v6.3.x) =====================
function isTravel() { return !!(state.meta && state.meta.travelMode); }
function updateTravelChip() { const b = byId("travelBtn"); if (b) b.classList.toggle("travel-on", isTravel()); }
function toggleTravel() {
  state.meta = state.meta || {};
  if (state.meta.travelMode) { // currently ON -> turn off immediately
    state.meta.travelMode = false;
    if (state.meta.travel) delete state.meta.travel.firstDay; // v6.4.11: reset day-one for the next trip
    if (state.meta.ui) delete state.meta.ui.travelNudgeShown; // v6.4.15: a fresh trip (even same day) shows the nudge again
    saveNow(); updateTravelChip(); applyTravelDust(); // v6.5.2: persist immediately so reopening remembers travel-off
    toast("✈ travelling mode off - back to your normal routine");
  } else { // v6.4.2: OFF -> open the setup; travel only ACTIVATES when you save in the popup (not on button press)
    openTravelHabits();
  }
}
// v6.4.2: called from the habits popup's Save - this is the moment travelling mode actually turns on.
function activateTravel() {
  state.meta = state.meta || {};
  state.meta.travelMode = true;
  state.meta.travel = state.meta.travel || { dhuhrAsrAt: "dhuhr", maghribIshaAt: "maghrib", mins: 40, witr: true };
  if (!state.meta.travel.firstDay) state.meta.travel.firstDay = _isod(new Date()); // v6.4.11: stamp the trip's day one
  saveNow(); updateTravelChip(); applyTravelDust(); // v6.5.2: persist immediately so reopening remembers travel-on
}
// v6.4.9: draft an "if [cue], then [habit]" for each KEPT habit while travelling. User picks how many; AI drafts;
// the user edits; both the draft and the edit (+ optional reason) log to ai_actions.jsonl. Resolves either way
// so the travel chain always continues to the prayer setup.
let _travelIfThenCallId = null, _travelIfThenProposed = {};
function travelIfThenForKept() {
  return new Promise((resolve) => {
    const kept = (state.items || []).filter((i) => i.type === "rhythm" && i.travel && (i.travel.keep || i.travel.reduce));
    if (!kept.length || !aiStatus.enabled) { resolve(); return; }
    const p = byId("popup"), max = Math.min(kept.length, 6), def = Math.min(kept.length, 3);
    const done = () => resolve();
    p.innerHTML = `<div class="popup-card ti-card">
      <div class="drawer-head"><span class="drawer-kicker" style="color:#c79bff">✦ pre-decide your if-then</span><button class="ghost-btn" id="ti-x1">✕</button></div>
      <div class="hist-note">Pre-deciding "if [cue], then [habit]" is the most proven follow-through tool there is (Gollwitzer &amp; Sheeran, 2006). Anchor each to a prayer and it survives any city. How many shall I draft?</div>
      <label class="fld"><span>Number of if-then rules</span><select id="ti-count">${Array.from({ length: max + 1 }, (_, n) => `<option value="${n}" ${n === def ? "selected" : ""}>${n === 0 ? "none, skip" : n}</option>`).join("")}</select></label>
      <div class="drawer-actions"><button class="glow-btn" id="ti-go">Draft them ✦</button><button class="ghost-btn" id="ti-x2">Skip</button></div></div>`;
    p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
    byId("ti-x1").addEventListener("click", done); byId("ti-x2").addEventListener("click", done);
    byId("ti-go").addEventListener("click", async () => {
      const n = +byId("ti-count").value; if (n <= 0) { done(); return; }
      const chosen = kept.slice(0, n);
      p.querySelector(".ti-card").innerHTML = `<div class="drawer-head"><span class="drawer-kicker" style="color:#c79bff">✦ drafting your if-then...</span></div><div class="hist-note">asking DeepSeek...</div>`;
      let res;
      try { res = await aiFetch("ifthen_batch", { habits: chosen.map((h) => ({ id: h.id, title: h.title, cadence: h.cadence || "" })), context: "travel" }); }
      catch (e) { toast("⚠ " + e.message); done(); return; }
      _travelIfThenCallId = lastCallId(); _travelIfThenProposed = {};
      ((res && res.rules) || []).forEach((r) => { if (r && r.id) _travelIfThenProposed[r.id] = { if: r.if || "", then: r.then || "" }; });
      const rows = chosen.map((h) => { const r = _travelIfThenProposed[h.id] || { if: "", then: "" };
        return `<div class="ti-rule" data-hid="${h.id}"><div class="ti-rule-name">${esc(h.title)}</div>
          <label class="fld"><span>If</span><input class="ti-if" value="${esc(r.if)}"></label>
          <label class="fld"><span>Then</span><input class="ti-then" value="${esc(r.then)}"></label></div>`; }).join("");
      p.innerHTML = `<div class="popup-card ti-card">
        <div class="drawer-head"><span class="drawer-kicker" style="color:#c79bff">✦ your travel if-then</span><button class="ghost-btn" id="ti-x3">✕</button></div>
        <div class="hist-note">Edit freely, then save. Both the draft and your edit are logged so Himmah learns your style.</div>
        <div class="ti-list">${rows}</div>
        <div class="drawer-actions"><button class="glow-btn" id="ti-save">Save &amp; continue →</button></div></div>`;
      byId("ti-x3").addEventListener("click", done);
      byId("ti-save").addEventListener("click", () => {
        const editedFns = [];
        p.querySelectorAll(".ti-rule").forEach((el) => {
          const h = item(el.dataset.hid); if (!h) return;
          const fi = el.querySelector(".ti-if").value.trim(), ft = el.querySelector(".ti-then").value.trim();
          const prop = _travelIfThenProposed[h.id] || { if: "", then: "" };
          h.nextAction = h.nextAction || { if: "", then: "" }; h.nextAction.if = fi; h.nextAction.then = ft; touch(h);
          if (fi === prop.if && ft === prop.then) logOutcome({ call_id: _travelIfThenCallId, item_id: h.id, kind: "ifthen", decision: "accept", ai_proposed: prop, my_final: { if: fi, then: ft }, my_reason: null });
          else editedFns.push((reason) => logOutcome({ call_id: _travelIfThenCallId, item_id: h.id, kind: "ifthen", decision: "edit", ai_proposed: prop, my_final: { if: fi, then: ft }, my_reason: reason }));
        });
        scheduleSave();
        if (editedFns.length) askWhy("travel if-then edits: why the change? (optional)").then((r) => editedFns.forEach((fn) => fn(r)));
        toast("✦ if-then saved"); done();
      });
    });
  });
}
// v6.4.10: while travelling, auto-schedule each KEPT habit right after its anchor prayer (the cue that finds you anywhere).
function _resolveAnchor(h) {
  if (h.travel && h.travel.anchor) return h.travel.anchor;
  const hay = ((h.nextAction && h.nextAction.if) || "") + " " + (h.title || "");
  const m = hay.match(/fajr|dhuhr|asr|maghrib|isha/i);
  return m ? m[0].toLowerCase() : null; // null = no explicit prayer in the text (AI / default decides)
}
function _habitTravelLen(h) { // v6.4.15: block length in MINUTES (honour the reduce slider when its unit is minutes)
  const tr = h.travel || {};
  if (!tr.reduce) return h.estimateMins || 20;
  if (/min/i.test(tr.unit || "") && tr.reduceTo) return Math.max(5, +tr.reduceTo); // slider is in minutes -> use it directly
  return Math.max(10, Math.round((h.estimateMins || 20) * 0.6)); // non-minute unit -> a shortened time block
}
async function travelAnchorSchedule(schId, days, cfg, data) {
  const kept = (state.items || []).filter((i) => i.type === "rhythm" && i.travel && (i.travel.keep || i.travel.reduce));
  if (!kept.length) return 0;
  const tv = state.meta.travel || {}, today = new Date(), anchorOf = {};
  kept.forEach((h) => (anchorOf[h.id] = _resolveAnchor(h)));
  // v6.4.15: habits with no prayer word in their text -> ask DeepSeek which prayer fits (was dead code); fall back to Fajr
  const needAI = kept.filter((h) => !anchorOf[h.id]);
  if (needAI.length && aiStatus.enabled) {
    try { const r = await aiFetch("anchor", { habits: needAI.map((h) => ({ id: h.id, title: h.title })) });
      ((r && r.anchors) || []).forEach((a) => { if (a && a.id && /^(fajr|dhuhr|asr|maghrib|isha)$/.test(a.prayer || "")) anchorOf[a.id] = a.prayer; }); } catch (_) {}
  }
  kept.forEach((h) => { if (!anchorOf[h.id]) anchorOf[h.id] = "fajr"; });
  const mins = tv.mins || 40;
  let added = 0;
  for (let off = 1; off <= days; off++) {
    const d = new Date(today); d.setDate(today.getDate() + off);
    const ds = _isod(d), times = data.times[_mmdd(d)]; if (!times) continue;
    kept.forEach((h) => {
      let key = anchorOf[h.id], t = times[key];
      if (key === "dhuhr" || key === "asr") t = times[tv.dhuhrAsrAt === "asr" ? "asr" : "dhuhr"]; // combined while travelling
      else if (key === "maghrib" || key === "isha") t = times[tv.maghribIshaAt === "isha" ? "isha" : "maghrib"];
      if (!t) return;
      const blockLen = (key === "fajr") ? Math.min(30, mins) : mins; // v6.4.15: sit AFTER the actual travel prayer block, not 15 min inside it
      const start = _hmToMin(t) + blockLen;
      const lenMin = _habitTravelLen(h);
      state.events.push({ id: uid("ev"), scheduleId: schId, title: "🌱 " + h.title, date: ds,
        start: _minToHM(start), end: _minToHM(start + lenMin), allDay: false,
        notes: h.title + " · anchored after " + key + " · travel routine", travelHabit: h.id, anchor: key });
      added++;
    });
  }
  kept.forEach((h) => logOutcome({ call_id: null, item_id: h.id, kind: "prayer_anchor", decision: "auto",
    ai_proposed: null, my_final: { anchor: anchorOf[h.id] }, my_reason: "anchored after " + anchorOf[h.id] + " so the cue survives any city" }));
  return added;
}
// v6.4.11: a one-time, dismissible "day one" banner on the first day of a trip (habit-discontinuity window).
function maybeTravelDayOneNudge() {
  const ex = byId("travelNudge"); if (ex) ex.remove();
  if (!isTravel()) return;
  const tv = state.meta.travel || {}, today = _isod(new Date());
  if (tv.firstDay !== today) return;
  state.meta.ui = state.meta.ui || {};
  if (state.meta.ui.travelNudgeShown === today) return;
  const bar = document.createElement("div"); bar.id = "travelNudge"; bar.className = "travel-nudge";
  bar.innerHTML = `<span>✈ <b>Day one writes the script</b> (Verplanken &amp; Roy, 2016). Lock today's routine and the good runs by itself.</span><button class="ghost-btn sm" data-act="travel-nudge-dismiss">got it</button>`;
  document.body.appendChild(bar);
}
// v6.3.2: an inspiring, evidence-grounded popup (>30 papers reviewed) + per-habit keep/reduce while travelling.
// v6.4: derive a habit's "current amount" for the reduce slider (a number in the title, else its ETA, else 30).
function habitAmount(h) {
  const m = String(h.title || "").match(/(\d+)\s*([A-Za-z]+)?/);
  if (m && +m[1] > 1) return { max: +m[1], unit: m[2] ? m[2].toLowerCase() : "" };
  if (h.estimateMins && h.estimateMins > 1) return { max: h.estimateMins, unit: "min" };
  return { max: 30, unit: "min" };
}
// v6.4.13: DeepSeek decides the slider's unit + amount per habit (Witr->rakah, video->minutes, Quran->pages).
// Starts as the regex fallback above; aiHabitUnits() patches labels in place when the AI returns.
let _habitUnits = {}; // id -> {amount, unit}
function habitUnit(h) {
  const a = _habitUnits[h.id];
  if (a && +a.amount > 1) return { max: +a.amount, unit: String(a.unit || "") };
  return habitAmount(h);
}
async function aiHabitUnits(habits) {
  if (!habits.length || !aiStatus.enabled) return; // best-effort; the regex slider already works
  let res;
  try { res = await aiFetch("habit_units", { habits: habits.map((h) => ({ id: h.id, title: h.title })) }); }
  catch (_) { return; }
  ((res && res.units) || []).forEach((u) => {
    if (!u || u.id == null || !(+u.amount > 1)) return;
    _habitUnits[u.id] = { amount: +u.amount, unit: String(u.unit || "") };
    const el = byId("popup").querySelector(`.th-habit[data-hid="${u.id}"]`); if (!el) return;
    const range = el.querySelector(".th-range"), lab = el.querySelector(".th-sllab"); if (!range || !lab) return;
    const chosen = el.querySelector(".th-mode:checked").value === "reduce"; // don't stomp a value the user is editing
    range.max = u.amount; if (!chosen) range.value = u.amount;
    lab.innerHTML = `reduce to <b class="th-rv">${range.value}</b> ${esc(u.unit || "")} <small>(was ${u.amount})</small>`;
  });
}
function openTravelHabits() {
  _habitUnits = {}; // re-query units each time the popup opens
  const habits = (state.items || []).filter((i) => i.type === "rhythm" && !i.queued);
  // v6.4: keep up / reduce / skip are mutually exclusive (radios); choosing "reduce" reveals a slider (1 .. current amount).
  const row = (h) => {
    const t = h.travel || {}, amt = habitUnit(h);
    const mode = t.reduce ? "reduce" : (t.keep === false ? "skip" : "keep");
    const rv = t.reduceTo != null ? t.reduceTo : amt.max;
    return `<div class="th-habit" data-hid="${h.id}">
      <div class="th-top"><span class="th-name">${esc(h.title)}</span>
        <div class="th-choices">
          <label class="th-opt"><input type="radio" name="thm-${h.id}" class="th-mode" value="keep" ${mode === "keep" ? "checked" : ""}> keep up</label>
          <label class="th-opt"><input type="radio" name="thm-${h.id}" class="th-mode" value="reduce" ${mode === "reduce" ? "checked" : ""}> reduce</label>
          <label class="th-opt"><input type="radio" name="thm-${h.id}" class="th-mode" value="skip" ${mode === "skip" ? "checked" : ""}> skip</label>
        </div></div>
      <div class="th-slider" ${mode === "reduce" ? "" : "hidden"}>
        <span class="th-sllab">reduce to <b class="th-rv">${rv}</b> ${esc(amt.unit)} <small>(was ${amt.max})</small></span>
        <input type="range" class="th-range" min="1" max="${amt.max}" value="${rv}">
      </div></div>`;
  };
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card th-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#9aa4b5">✈ keep your good while travelling</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="th-inspire">
      <p><b>A journey is a blank page - write your best self onto it.</b> Bismillah. Your good habits never ran on willpower alone; they ran on <i>cues</i> (Wood &amp; Rünger, 2016). Travel doesn't test your discipline - it removes your scaffolding. Rebuild one cue and the good runs by itself.</p>
      <p>When routine breaks, behaviour returns to your <i>values</i> (Verplanken &amp; Roy, 2016) - a fresh-start window opens, and <b>day one writes the script</b>. Three moves, decided now while your strength is full (Baumeister et al., 1998): <b>carry the cue</b> (pack the mat, keep a fixed time); <b>piggyback</b> every habit onto your five prayers - the one structure that finds you in any city (Gardner et al., 2012); and <b>pre-decide the if-then</b> - "<i>If</i> I check in, <i>then</i> I pray Maghrib before I unpack" - the most proven follow-through tool there is (Gollwitzer &amp; Sheeran, 2006, d≈0.65, 94 studies).</p>
      <p>You are <i>someone who prays</i> - not someone trying to (Verplanken &amp; Sui, 2019); identity-rooted habits survive any airport. Prayer doesn't drain your tired self - du'ā has been shown to <i>restore</i> self-control (Friese &amp; Wänke, 2014). And if a day slips, a single missed day barely dents a habit (Lally et al., 2010) - pick it up tomorrow. Islam already encodes the ease: <b>qaṣr and jamʿ lighten the journey so your worship continues unbroken.</b></p>
    </div>
    <div class="th-list-head">For each habit: keep it up, reduce it, or skip it this trip.</div>
    <div class="th-list">${habits.length ? habits.map(row).join("") : `<div class="empty mini">no active habits to review</div>`}</div>
    <details class="th-more"><summary>research-backed ideas we could add later (v6.3.4)</summary>
      <ul class="th-ideas"><li>auto if-then per habit (reuse the if-then suggester)</li><li>prayer-anchored auto-scheduling of habits</li><li>cue-carry pre-departure checklist</li><li>day-one "lock the routine" nudge</li><li>one-tap daily travel check-off (no-guilt)</li></ul></details>
    <div class="drawer-actions"><button class="glow-btn" id="th-save">Save &amp; continue to prayers →</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  // live: choosing "reduce" reveals its slider; sliding updates the readout
  p.querySelectorAll(".th-habit").forEach((el) => {
    el.querySelectorAll(".th-mode").forEach((r) => r.addEventListener("change", () => {
      el.querySelector(".th-slider").hidden = (el.querySelector(".th-mode:checked").value !== "reduce");
    }));
    const range = el.querySelector(".th-range");
    if (range) range.addEventListener("input", () => { const rvn = el.querySelector(".th-rv"); if (rvn) rvn.textContent = range.value; }); // re-query: AI may rewrite the label
  });
  aiHabitUnits(habits); // v6.4.13: fire-and-forget; patches each slider's unit/amount when DeepSeek answers
  byId("th-save").addEventListener("click", () => {
    p.querySelectorAll(".th-habit").forEach((el) => {
      const h = item(el.dataset.hid); if (!h) return;
      const mode = (el.querySelector(".th-mode:checked") || {}).value || "keep";
      if (mode === "reduce") {
        const to = +el.querySelector(".th-range").value;
        h.travel = { keep: false, reduce: true, reduceTo: to, unit: (_habitUnits[h.id] || {}).unit || "" }; h.queued = false;
        logOutcome({ call_id: lastCallId(), item_id: h.id, kind: "habit_units", decision: "accept",
          ai_proposed: _habitUnits[h.id] || null, my_final: { reduceTo: to }, my_reason: null }); // v6.4.13 training data
      } else if (mode === "skip") { h.travel = { keep: false, reduce: false }; h.queued = true; } // skip = park it (no load) for the trip
      else { h.travel = { keep: true, reduce: false }; h.queued = false; }
      touch(h);
    });
    render(); // v6.9.1 FIX: travel does NOT activate here anymore - completing only the habits step used to switch the mode on; it now activates at the FINAL "Apply & populate prayers" step (bail out anywhere before that = mode stays off)
    travelIfThenForKept().finally(openTravelSetup); // v6.4.9: optional if-then step, then on to prayer setup
  });
}
function openTravelSetup() {
  const t = state.meta.travel || (state.meta.travel = { dhuhrAsrAt: "dhuhr", maghribIshaAt: "maghrib", mins: 40, witr: true });
  const witr = (state.items || []).find((i) => i.type === "rhythm" && /witr/i.test(i.title));
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#9aa4b5">✈ travelling mode</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="hist-note">As a traveller you may <b>combine</b> (jam') and <b>shorten</b> (qasr) prayers. Set how you'll pray, then populate your calendar with the combined blocks (Fajr · Dhuhr+Asr · Maghrib+Isha).</div>
    <div class="fld-row">
      <label class="fld"><span>Dhuhr + Asr - pray at</span><select id="tv-da"><option value="dhuhr" ${t.dhuhrAsrAt === "dhuhr" ? "selected" : ""}>Dhuhr time (jam' taqdīm)</option><option value="asr" ${t.dhuhrAsrAt === "asr" ? "selected" : ""}>Asr time (jam' ta'khīr)</option></select></label>
      <label class="fld"><span>Maghrib + Isha - pray at</span><select id="tv-mi"><option value="maghrib" ${t.maghribIshaAt === "maghrib" ? "selected" : ""}>Maghrib time</option><option value="isha" ${t.maghribIshaAt === "isha" ? "selected" : ""}>Isha time</option></select></label>
    </div>
    <label class="fld"><span>Each block (shortened)</span><input type="number" id="tv-mins" min="10" max="120" value="${t.mins || 40}"> <small>minutes</small></label>
    ${witr ? `<label class="pop-row ai-toggle"><input type="checkbox" id="tv-witr" ${t.witr !== false ? "checked" : ""}> Keep <b>Witr</b> up while travelling <small>(recommended - a beloved sunnah that's light to maintain on the road)</small></label>` : ""}
    <div class="drawer-actions"><button class="glow-btn" id="tv-apply">Apply &amp; populate prayers</button><button class="ghost-btn" data-act="close-popup">Later</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  byId("tv-apply").addEventListener("click", () => {
    t.dhuhrAsrAt = byId("tv-da").value; t.maghribIshaAt = byId("tv-mi").value; t.mins = +byId("tv-mins").value || 40;
    if (byId("tv-witr")) t.witr = byId("tv-witr").checked;
    activateTravel(); // v6.9.1 FIX: the mode switches ON only HERE - the final Apply of the whole travel chain
    toast("✈ travelling mode on - prayers combined, habits adjusted");
    scheduleSave(); openCalendar(); openPrayerPopulate(); // openPrayerPopulate overwrites this same popup (no closePopup → no hide race)
  });
}
// ===================== Priorities Guardian (v6.6.9) =====================
// Protect a few high-importance, low-urgency goods (Quran, Arabic, gym, Origin long-term). When a paid/urgent
// DEAL lands and the owner starts stripping them, the Guardian does NOT block - it makes the trade-off CONSCIOUS
// and time-boxed: name the deal, set a return date, pick the smallest sustainable cut per good (AI-assisted),
// schedule the resume, and keep a quiet identity ledger. "Deal mode" = travel mode for your priorities.
let _guardAi = {}; // last AI 'guardian' proposal, keyed by item id (for outcome logging)
function guardData() { state.meta = state.meta || {}; return (state.meta.guardian = state.meta.guardian || { protectedIds: [], deal: null, ledger: [] }); }
function guardSyncIndex() { const g = guardData(); g.protectedIds = state.items.filter((i) => i.protected).map((i) => i.id); }
function guardProtectedLive() { return state.items.filter((i) => i.protected && (i.type === "rhythm" ? !i.queued : i.status === "active")); }
function guardProtectedActiveCount() { return guardProtectedLive().length; }
function guardActiveDeal() { return guardData().deal || null; }
function guardLedger(type, o) { if (!type) return; const g = guardData(); g.ledger.push(Object.assign({ ts: nowIso(), type, itemId: null, dealId: (g.deal ? g.deal.id : null), note: null, amount: null }, o || {})); } // append-only, never capped (identity/training data)
function guardAmount(i) { if (i.type === "rhythm" && typeof habitUnit === "function") { const u = habitUnit(i); return { max: Math.max(1, u.max || 1), unit: u.unit || "" }; } return { max: Math.max(1, i.estimateMins || 30), unit: "min" }; }
function guardSchedule() { let sch = (state.schedules || []).find((x) => x.name === "Guardian"); if (!sch) { sch = { id: uid("sch"), name: "Guardian", color: "#f5c46f", hidden: false }; (state.schedules = state.schedules || []).push(sch); } return sch; }
function guardScheduleResume(deal) {
  const sch = guardSchedule(); state.events = state.events || [];
  deal.plan.filter((p) => p.mode !== "keep").forEach((p) => {
    const it = item(p.id); if (!it) return;
    const ev = { id: uid("ev"), scheduleId: sch.id, date: deal.returnDate, start: "08:00", end: "08:30", allDay: false,
      title: "⛨ Resume: " + it.title, notes: "Priorities Guardian - bring " + it.title + " back to full after the " + (deal.title || "deal") + " window.", taskId: p.id, guardDealId: deal.id, guardResume: true };
    state.events.push(ev); p.resumeEventId = ev.id;
  });
}
async function guardAiSuggest(goods) {
  if (!goods.length || !aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - plan it by hand"); return; }
  const dealTitle = byId("gd-title") ? byId("gd-title").value : "", ret = byId("gd-return") ? byId("gd-return").value : "";
  const days = ret ? Math.max(1, Math.round((_dnum(ret) - _dnum(_isod(new Date()))) / 864e5)) : 0;
  toast("✦ finding the smallest sustainable cut…");
  let res; try { res = await aiFetch("guardian", { deal: dealTitle, return: ret, start: _isod(new Date()), days,
    goods: goods.map((g) => { const a = guardAmount(g); return { id: g.id, title: g.title, importance: g.importance, currentAmount: a.max, unit: a.unit, type: g.type }; }),
    history: (guardData().ledger || []).slice(-6) }); } catch (e) { toast("⚠ " + e.message); return; }
  _guardAi = {};
  ((res && res.plan) || []).forEach((pl) => {
    if (!pl || pl.id == null) return; _guardAi[pl.id] = pl;
    const el = [...byId("popup").querySelectorAll(".th-habit")].find((x) => x.dataset.hid === String(pl.id)); if (!el) return; // v6.7.1: match by value, never interpolate an AI-controlled id into a selector (a stray quote/bracket threw a DOMException)
    const mode = ["keep", "reduce", "pause"].includes(pl.mode) ? pl.mode : null; // validate against the known set
    const radio = mode ? [...el.querySelectorAll(".th-mode")].find((rb) => rb.value === mode) : null;
    if (radio) { radio.checked = true; const sl = el.querySelector(".th-slider"); if (sl) sl.hidden = mode !== "reduce"; }
    if (mode === "reduce" && +pl.reduceTo > 0) { const range = el.querySelector(".th-range"), lab = el.querySelector(".th-sllab"); if (range) { range.value = Math.min(+range.max, +pl.reduceTo); if (lab) lab.innerHTML = `reduce to <b class="th-rv">${range.value}</b> ${esc(pl.unit || "")} <small>(was ${range.max})</small>`; } }
  });
  const r = byId("gd-reflection"); if (r && res && res.reflection) r.textContent = "✦ " + res.reflection;
}
function openDealIntake(opts) {
  opts = opts || {}; _guardAi = {};
  const goods = (opts.seedIds && opts.seedIds.length) ? opts.seedIds.map(item).filter(Boolean) : guardProtectedLive();
  if (!goods.length) { toast("no protected goods to guard yet - shield one in its editor first"); if (opts.onLetGo) opts.onLetGo(); return; }
  const names = goods.map((g) => g.title).join(", ");
  const defRet = _isod(new Date(Date.now() + 14 * 864e5));
  const row = (g) => { const a = guardAmount(g);
    return `<div class="th-habit" data-hid="${g.id}">
      <div class="th-top"><span class="th-name">${esc(g.title)}</span>
        <div class="th-choices">
          <label class="th-opt"><input type="radio" name="gdm-${g.id}" class="th-mode" value="keep"> keep</label>
          <label class="th-opt"><input type="radio" name="gdm-${g.id}" class="th-mode" value="reduce" checked> reduce</label>
          <label class="th-opt"><input type="radio" name="gdm-${g.id}" class="th-mode" value="pause"> pause</label>
        </div></div>
      <div class="th-slider"><span class="th-sllab">reduce to <b class="th-rv">${Math.max(1, Math.round(a.max / 3))}</b> ${esc(a.unit)} <small>(was ${a.max})</small></span>
        <input type="range" class="th-range" min="1" max="${a.max}" value="${Math.max(1, Math.round(a.max / 3))}"></div></div>`; };
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card guard-card th-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">⛨ priorities guardian</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="th-inspire guard-intro">
      <p><b>A deal just landed. Good - chase it.</b> But you do not have to torch what makes you <i>you</i>. The plan is theory; this is the moment it is tested. Let us park, not bury.</p>
      <p>You are about to pull time from <b>${esc(names)}</b>${opts.dealTitle ? " for <b>" + esc(opts.dealTitle) + "</b>" : ""}. Choose the <b>smallest</b> cut that still moves the deal, and pick the day it all comes back. A protected good kept at one page is still alive; eliminated, it has to be reborn.</p>
    </div>
    <label class="fld"><span>What is the deal? <small>(name the thing worth the trade)</small></span><input id="gd-title" placeholder="e.g. the Q3 client contract" value="${esc(opts.dealTitle || (opts.trigger ? opts.trigger.title : ""))}"></label>
    <label class="fld"><span>Bring it all back on <small>(your return date - the deal window ends here)</small></span>${tdateField("gd-return", defRet, { clearable: false })}</label>
    <div class="th-list-head">For each protected good: keep it, shrink it, or pause it for the window.</div>
    <div class="th-list">${goods.map(row).join("")}</div>
    <div class="guard-ai-row"><button class="ghost-btn sm" id="gd-ai" title="Ask Himmah for the smallest sustainable cut">✦ suggest the smallest sustainable reduction</button><span class="guard-ai-hint" id="gd-reflection">you approve or edit every number - nothing changes until you save</span></div>
    <div class="drawer-actions"><button class="glow-btn" id="gd-save">Park consciously → schedule the return</button><button class="ghost-btn" id="gd-letgo" data-act="close-popup">${opts.sacrificeItem ? "Let " + esc(opts.sacrificeItem.title) + " go on purpose" : "Cancel - change nothing"}</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  p.querySelectorAll(".th-habit").forEach((el) => {
    el.querySelectorAll(".th-mode").forEach((r) => r.addEventListener("change", () => { el.querySelector(".th-slider").hidden = el.querySelector(".th-mode:checked").value !== "reduce"; }));
    const range = el.querySelector(".th-range"); if (range) range.addEventListener("input", () => { const rv = el.querySelector(".th-rv"); if (rv) rv.textContent = range.value; });
  });
  byId("gd-ai").addEventListener("click", () => guardAiSuggest(goods));
  if (opts.onLetGo) byId("gd-letgo").addEventListener("click", () => { guardLedger("kept-anyway", { itemId: opts.sacrificeItem ? opts.sacrificeItem.id : null, note: "let go on purpose: " + (opts.sacrificeItem ? opts.sacrificeItem.title : "") }); closePopup(); opts.onLetGo(); });
  byId("gd-save").addEventListener("click", () => {
    const title = byId("gd-title").value.trim(), ret = byId("gd-return").value;
    if (!ret || _dnum(ret) <= _dnum(_isod(new Date()))) { toast("pick a return date in the future"); return; }
    const deal = { id: uid("deal"), title, triggerItemId: opts.trigger ? opts.trigger.id : null, startDate: _isod(new Date()), returnDate: ret, plan: [], aiCallId: lastCallId(), armedAt: nowIso() };
    let touched = 0, reasoned = false;
    p.querySelectorAll(".th-habit").forEach((el) => {
      const g = item(el.dataset.hid); if (!g) return;
      const mode = (el.querySelector(".th-mode:checked") || {}).value || "keep";
      const snap = { status: g.status, importance: g.importance, queued: g.queued, estimateMins: g.estimateMins };
      const entry = { id: g.id, mode, reduceTo: null, unit: guardAmount(g).unit, wasAmount: guardAmount(g).max, resumeEventId: null, snapshot: snap };
      if (mode === "reduce") { const to = +el.querySelector(".th-range").value; entry.reduceTo = to;
        if (g.type === "rhythm" && (guardAmount(g).unit === "min" || /min/i.test(guardAmount(g).unit))) g.estimateMins = to;
        else g.guardReducedNote = "↓ " + to + " " + guardAmount(g).unit + " (deal window)";
        touch(g); guardLedger("reduce", { itemId: g.id, dealId: deal.id, note: g.title + " -> " + to + " " + guardAmount(g).unit, amount: to }); touched++;
      } else if (mode === "pause") {
        if (g.type === "rhythm") g.queued = true; else { clearFutureTaskEvents(g.id); g.guardPaused = true; } // v6.6.10: a paused TASK also leaves NOW for the window (restored on resume)
        touch(g); guardLedger("pause", { itemId: g.id, dealId: deal.id, note: "paused " + g.title }); touched++;
      } else { guardLedger("keep", { itemId: g.id, dealId: deal.id, note: "kept " + g.title }); }
      const proposed = _guardAi[g.id] || null;
      if (proposed && (proposed.mode !== mode || (mode === "reduce" && +proposed.reduceTo !== entry.reduceTo))) reasoned = true;
      logOutcome({ call_id: deal.aiCallId, item_id: g.id, kind: "guardian", decision: proposed ? "edit" : "accept", ai_proposed: proposed, my_final: { mode, reduceTo: entry.reduceTo, unit: entry.unit }, my_reason: null, original_input: g.title });
      deal.plan.push(entry);
    });
    guardData().deal = deal; guardLedger("deal-start", { dealId: deal.id, note: title || "deal" });
    guardScheduleResume(deal);
    saveNow(); render(); renderCalendar(); applyGuardianAmbient();
    const finish = () => { closePopup(); toast("⛨ parked " + touched + " good" + (touched !== 1 ? "s" : "") + " - they return " + ret); };
    if (reasoned && typeof askWhy === "function") askWhy("guardian: you changed a cut - why a different number? (helps Himmah learn)").then(() => finish()); else finish();
  });
}
function guardFoldIntoDeal(it, verb) { const g = guardActiveDeal(); if (!g) return;
  let e = g.plan.find((x) => x.id === it.id);
  if (!e) { e = { id: it.id, mode: "pause", reduceTo: null, unit: guardAmount(it).unit, wasAmount: guardAmount(it).max, resumeEventId: null, snapshot: { status: it.status, importance: it.importance, queued: it.queued, estimateMins: it.estimateMins } }; g.plan.push(e); }
  e.mode = "pause"; if (it.type === "rhythm") it.queued = true; else { clearFutureTaskEvents(it.id); it.guardPaused = true; } // v6.6.10: paused task leaves NOW too
  if (!e.resumeEventId) { const sch = guardSchedule(); const ev = { id: uid("ev"), scheduleId: sch.id, date: g.returnDate, start: "08:00", end: "08:30", allDay: false, title: "⛨ Resume: " + it.title, notes: "Priorities Guardian resume.", taskId: it.id, guardDealId: g.id, guardResume: true }; (state.events = state.events || []).push(ev); e.resumeEventId = ev.id; }
  touch(it); guardLedger("pause", { itemId: it.id, dealId: g.id, note: "folded " + it.title + " into the deal (" + verb + ")" }); saveNow(); render();
  toast("⛨ added to the deal window - returns " + g.returnDate);
}
function guardConfirmSacrifice(it, verb, proceed) {
  if (!it || !it.protected) { proceed(); return; }                 // not protected -> original behaviour, zero change
  if (guardActiveDeal()) { guardFoldIntoDeal(it, verb); return; }   // a deal is on: fold in quietly (do NOT also run the raw delete)
  openDealIntake({ trigger: null, seedIds: [it.id], dealTitle: "", sacrificeItem: it, sacrificeVerb: verb, onLetGo: proceed });
}
function guardCheckResume() { const g = state.meta && state.meta.guardian; if (!g || !g.deal) return; if (g.deal.returnDate <= _isod(new Date())) openGuardianResume(g.deal); }
function guardRestore(deal, e) {
  if (e._restored) return; e._restored = true; // v6.6.10: idempotent - restore-one then restore-all must not double-log
  const it = item(e.id);
  if (it && e.snapshot) { it.status = e.snapshot.status; it.queued = e.snapshot.queued; it.estimateMins = e.snapshot.estimateMins; delete it.guardReducedNote; delete it.guardPaused; touch(it); }
  const ev = (state.events || []).find((x) => x.id === e.resumeEventId); if (ev) state.events = state.events.filter((x) => x.id !== e.resumeEventId);
  guardLedger("resume", { itemId: e.id, dealId: deal.id, note: "restored " + (it ? it.title : "") });
}
function guardEndDeal(deal) { (deal.plan || []).forEach((e) => guardRestore(deal, e)); guardLedger("deal-end", { dealId: deal.id, note: "deal window closed" }); guardData().deal = null; saveNow(); render(); renderCalendar(); applyGuardianAmbient(); }
function openGuardianResume(deal) {
  const p = byId("popup"); const rows = (deal.plan || []).filter((e) => e.mode !== "keep" && !e._restored).map((e) => { const it = item(e.id); return `<div class="hist-row"><span>${it ? esc(it.title) : "(gone)"}</span><button class="ghost-btn sm" data-act="guard-restore-one" data-id="${e.id}">restore</button></div>`; }).join(""); // v6.7.1: drop already-restored goods so they don't re-list with a live restore button
  p.innerHTML = `<div class="popup-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">⛨ welcome back</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="hist-note">The <b>${esc(deal.title || "deal")}</b> window has reached its return date (${esc(deal.returnDate)}). Bring your protected goods home?</div>
    <div class="hist-list">${rows || '<div class="empty mini">nothing to restore</div>'}</div>
    <div class="drawer-actions"><button class="glow-btn" data-act="guard-restore-all">Restore all - close the deal</button><button class="ghost-btn" data-act="guard-extend">Extend the window</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}
function applyGuardianAmbient() {
  const on = !!guardActiveDeal(); let layer = byId("guardAmbient");
  if (on && !layer) { layer = document.createElement("div"); layer.id = "guardAmbient"; layer.className = "guard-ambient"; document.body.appendChild(layer); }
  if (!on && layer) layer.remove();
  const btn = document.querySelector("#guardianBtn"); if (btn) btn.classList.toggle("deal-on", on);
  const pill = byId("guardDealPill");
  if (pill) { const d = guardActiveDeal(); if (d) { const left = Math.max(0, Math.round((_dnum(d.returnDate) - _dnum(_isod(new Date()))) / 864e5)); pill.textContent = "deal window - " + left + "d left"; pill.hidden = false; } else pill.hidden = true; }
}
function renderGuardianPanel() {
  const p = byId("guardianPanel"); const g = guardData(); const prot = state.items.filter((i) => i.protected);
  const protRows = prot.length ? prot.map((i) => `<div class="hist-row"><span>⛨ ${esc(i.title)}${i.guardReducedNote ? ` <small class="guard-red">${esc(i.guardReducedNote)}</small>` : ""}</span><button class="ghost-btn sm" data-act="guard-unprotect" data-id="${i.id}" title="stop protecting">✕</button></div>`).join("") : '<div class="empty mini">nothing protected yet - shield a good in its editor</div>';
  const d = g.deal;
  const dealCard = d ? `<div class="guard-deal-card"><div class="kicker" style="color:var(--gold)">active deal</div>
      <div class="guard-deal-title">${esc(d.title || "the deal")}</div>
      <div class="hist-note">${esc(d.startDate)} -> ${esc(d.returnDate)} · ${d.plan.filter((x) => x.mode === "reduce").length} reduced · ${d.plan.filter((x) => x.mode === "pause").length} paused · ${d.plan.filter((x) => x.mode === "keep").length} kept</div>
      <div class="drawer-actions"><button class="glow-btn sm" data-act="guard-end-deal">Bring them all back now</button></div></div>` : '<div class="hist-note">No deal running. Your protected goods are safe.</div>';
  const ledger = (g.ledger || []).slice(-12).reverse().map((l) => `<div class="hist-row"><span class="hist-when">${esc((l.ts || "").slice(0, 10))}</span><span>${esc(l.note || l.type)}</span></div>`).join("") || '<div class="empty mini">no history yet</div>';
  p.innerHTML = `<div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">⛨ priorities guardian</span><span class="dh-btns"><button class="ghost-btn" data-act="guard-help" title="What is the Guardian, and how do I use it?">?</button><button class="ghost-btn" data-act="close-guardian">✕</button></span></div>
    <div class="hist-note">Protect your high-importance, low-urgency goods (faith, learning, health, long-term). When a deal lands, the Guardian makes the trade-off conscious and time-boxed - never silent.</div>
    <div class="guard-sec"><div class="kicker">protected goods (${prot.length})</div>${protRows}</div>
    <div class="guard-sec">${dealCard}</div>
    <div class="guard-sec"><div class="kicker">your guard log</div><div class="hist-list">${ledger}</div></div>
    ${d ? "" : `<div class="drawer-actions"><button class="ghost-btn" data-act="guard-arm" ${prot.length ? "" : "disabled"}>⛨ a deal is here - plan the trade-off</button></div>`}`;
}
function openGuardian() { const p = byId("guardianPanel"); p.hidden = false; renderGuardianPanel(); requestAnimationFrame(() => p.classList.add("open")); byId("scrim").hidden = false; if (!(state.meta && state.meta.guardianIntroSeen)) guardIntro(false); } // v6.6.22: explain it the first time it opens
function closeGuardian() { const p = byId("guardianPanel"); p.classList.remove("open"); byId("scrim").hidden = true; setTimeout(() => { if (!p.classList.contains("open")) p.hidden = true; }, 220); } // v6.7.1: a close-then-reopen within 220ms re-adds .open - don't let the stale timer hide the reopened panel
// v6.6.22: a plain-language explainer for the Priorities Guardian (the "?" in the panel opens it any time;
// it also auto-shows once). force=true (the ? button) does not touch the seen flag, so re-reading never re-arms the auto-show.
function guardIntro(force) {
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card guard-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">⛨ what the guardian does</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="th-inspire guard-intro">
      <p><b>It guards the goods you drop first when life gets busy</b> - faith, learning, health, the slow long-term work. Those are the things a sudden paid deal quietly eats.</p>
      <p><b>1. Shield a good.</b> Open a habit or a long-term project and tap <b>⛨ protect this</b> in its editor. That marks it as one to defend. (Plain one-off tasks come and go, so they cannot be shielded.)</p>
      <p><b>2. When a deal lands</b> (a paid or urgent push), the Guardian does not block you - it asks you to name the deal, set a return date, and for each shielded good choose <b>keep, reduce, or pause</b>. Himmah can suggest the smallest cut that keeps each one alive.</p>
      <p><b>3. It schedules the comeback.</b> Resume reminders land on your return date; that day it offers to bring everything back to full. Think of it as travel mode for your priorities - parked, never buried.</p>
    </div>
    <div class="drawer-actions"><button class="glow-btn" data-act="close-popup">Got it</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  if (!force) { state.meta = state.meta || {}; state.meta.guardianIntroSeen = true; scheduleSave(); }
}
// v6.6.25: one reusable panel explainer (generalises guardIntro - the owner loved that "?"). Each side-panel gets a
// "?" that opens its intro any time (force=true, never re-arms), and the intro auto-shows once on first open via maybeIntro.
const HELP_COPY = {
  habits: { kicker: "🌱 what habits are", html: `
    <p><b>Habits are routines you commit to and protect time for.</b> Each one has a small daily-minute cost, and the budget meter keeps your total load honest so you do not overcommit.</p>
    <p><b>Park or activate.</b> New habits land in the Habit Parking Lot with zero daily load - park ideas guilt-free. Hit activate when you are ready to actually do one; it then counts toward your min/day budget.</p>
    <p><b>Tap the circle</b> to mark a habit done today. Streaks build from there. Over budget? Park one - that is the meter doing its job.</p>` },
  rhythms: { kicker: "🔁 what rhythms are", html: `
    <p><b>Rhythms are light, parallel routines with no time budget.</b> Think small daily anchors like adhkar after a prayer. Unlike habits, they do not compete for your daily minutes.</p>
    <p><b>You log misses, not streaks.</b> When you slip, tap missed today - no shame, just data. The count is the signal.</p>
    <p><b>It nudges, then suggests a fix.</b> Miss a daily rhythm too often and Himmah gently flags it; if it keeps slipping it offers to make it a Habit, somewhere it gets dedicated time.</p>` },
  tidy: { kicker: "🧹 what tidy is", html: `
    <p><b>Tidy gathers short-term tasks that have gone quiet</b> - the ones untouched for about ten days or more. They are not urgent; they are just clutter waiting for a decision.</p>
    <p><b>Three calm choices per task.</b> Keep if it still matters. Snooze 7d to be asked again next week. Archive to file it away - you can always find it again in History.</p>
    <p>No pressure and no deletions - tidy when you feel like it.</p>` },
  waiting: { kicker: "⏳ what waiting is", html: `
    <p><b>Waiting holds tasks that are parked because something is in the way.</b> They stay out of your NOW focus so they cannot nag you while you can do nothing about them.</p>
    <p><b>Two kinds of parked.</b> Blocked means another task has to finish first. Reply means you are waiting on someone outside the app.</p>
    <p><b>Hit unblock</b> the moment it is free again - the task drops straight back into your focus pool.</p>` },
  inbox: { kicker: "📥 what the inbox is", html: `
    <p><b>The inbox is your fast-capture pile.</b> Anything you jot lands here uncategorised so you never lose a thought mid-flow. Nothing reaches your board until you triage it.</p>
    <p><b>Triage = give it a category and an importance.</b> Once a task has a category it graduates onto the board. ✦ Triage all lets Himmah propose those - you approve or edit every one.</p>
    <p><b>The ✦ buttons are optional helpers.</b> Enhance tidies the wording, Enrich adds detail, Apply all runs the lot. AI never fires on its own.</p>` },
};
function helpIntro(key, kicker, html, force) {
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card guard-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">${kicker}</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="th-inspire guard-intro">${html}</div>
    <div class="drawer-actions"><button class="glow-btn" data-act="close-popup">Got it</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  if (!force) { state.meta = state.meta || {}; state.meta[key + "IntroSeen"] = true; scheduleSave(); }
}
function panelHelp(key, force) { const h = HELP_COPY[key]; if (h) helpIntro(key, h.kicker, h.html, force); }
function maybeIntro(key) { if ((typeof _tourOv !== "undefined" && _tourOv) || (typeof _onbOv !== "undefined" && _onbOv)) return; if (!(state.meta && state.meta[key + "IntroSeen"])) panelHelp(key, false); } // auto-show once on first open; v6.9: suppressed during the guided tour AND the onboarding chat so a first-open help popup never blocks a tour/onboarding card
// v6.3.3: a faint "dusty" ambient - greyish particles drift over the UI while ✈ travelling,
// a persistent, can't-miss reminder the toggle is ON. Kept subtle (≈95% of the design is untouched).
function applyTravelDust() {
  maybeTravelDayOneNudge(); // v6.4.11: handles show/clear of the day-one banner (runs on toggle + on load)
  const ID = "travelDust";
  let layer = byId(ID);
  if (!isTravel()) { if (layer) layer.remove(); return; }
  if (layer) return; // already drifting
  layer = document.createElement("div");
  layer.id = ID; layer.className = "travel-dust"; layer.setAttribute("aria-hidden", "true");
  let html = "";
  for (let i = 0; i < 24; i++) {
    const x = (Math.random() * 100).toFixed(2);
    const y = (Math.random() * 100).toFixed(2);
    const s = (2 + Math.random() * 5).toFixed(1);        // 2–7px specks
    const dur = (14 + Math.random() * 16).toFixed(1);     // 14–30s slow drift
    const delay = (-Math.random() * 30).toFixed(1);       // negative → desync the field
    const dx = (Math.random() * 60 - 30).toFixed(0);      // sideways sway
    const op = (0.12 + Math.random() * 0.22).toFixed(2);  // faint
    html += `<i style="left:${x}%;top:${y}%;width:${s}px;height:${s}px;--dx:${dx}px;--op:${op};animation-duration:${dur}s;animation-delay:${delay}s"></i>`;
  }
  layer.innerHTML = html;
  document.body.appendChild(layer);
}
// ---- v6.1.6: upload a mosque PDF -> server extracts text -> DeepSeek structures it -> review -> save ----
let _pdfEntries = [];
function openPrayerUpload() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "application/pdf,.pdf"; inp.style.display = "none";
  inp.addEventListener("change", () => {
    const file = inp.files && inp.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => uploadPrayerPdf(String(rd.result).split(",")[1] || "", file.name);
    rd.readAsDataURL(file);
  });
  document.body.appendChild(inp); inp.click(); setTimeout(() => inp.remove(), 1000);
}
// ---- v6.6.16: import files -> server extracts text -> one inbox item per file (mirrors the prayer-PDF upload) ----
const IMPORT_ACCEPT = ".pdf,.txt,.md,.markdown,.csv,.log,.docx,application/pdf,text/plain,text/markdown,text/csv";
function openFileImport() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = IMPORT_ACCEPT; inp.multiple = true; inp.style.display = "none";
  inp.addEventListener("change", async () => {
    const files = Array.from(inp.files || []); if (!files.length) return;
    const payload = [];
    for (const file of files) {
      const b64 = await _fileToB64(file); // FileReader -> base64 (same trick as uploadPrayerPdf)
      if (b64) payload.push({ name: file.name, b64 });
    }
    if (payload.length) importFiles(payload);
  });
  document.body.appendChild(inp); inp.click(); setTimeout(() => inp.remove(), 1000);
}
function _fileToB64(file) {
  return new Promise((res) => {
    const rd = new FileReader();
    rd.onload = () => res(String(rd.result).split(",")[1] || ""); // strip the data: prefix
    rd.onerror = () => res("");
    rd.readAsDataURL(file);
  });
}
async function importFiles(files) {
  const btn = byId("importBtn"); if (btn) btn.classList.add("busy");
  toast("⬆ reading " + files.length + " file" + (files.length > 1 ? "s" : "") + "…");
  let d;
  try { d = await (await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files }) })).json(); }
  catch (e) { if (btn) btn.classList.remove("busy"); toast("⚠ import failed - is the server running?"); return; }
  if (btn) btn.classList.remove("busy");
  if (!d || !d.ok) { toast("⚠ " + ((d && d.error) || "couldn't import")); return; }
  const items = (d.items || []).filter((x) => x && (x.text || "").trim());
  items.forEach((x) => addImportedItem(x));
  if (items.length) { normalizeOrders(); scheduleSave(); render(); refreshInboxCount(); }
  const skn = (d.skipped || []).length;
  if (!items.length && skn) toast("⚠ nothing imported (" + skn + " skipped: " + esc(d.skipped[0].reason) + ")");
  else toast("📎 added " + items.length + " to Inbox" + (skn ? " (" + skn + " skipped)" : ""));
}
function addImportedItem(x) {
  const raw = String(x.title || "file");
  const title = (raw.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || raw).slice(0, 120);
  const it = {
    id: uid("t"), type: "task", title, notes: String(x.text || ""),
    categoryId: null, importance: 1, urgency: { due: null, soon: false },
    status: "inbox", nextAction: { if: "", then: "" }, estimateMins: null,
    projectId: null, subtaskIds: [], nextActionId: null,
    cadence: null, everyNDays: null, streak: 0, lastDone: null, history: [],
    inFocus: false, order: -1, createdAt: nowIso(), updatedAt: nowIso(), completedAt: null,
    source: "import", sourceFile: raw,
  };
  state.items.push(it);
}
async function uploadPrayerPdf(b64, name) {
  if (!b64) { toast("couldn't read the file"); return; }
  toast("⬆ reading " + (name || "PDF") + " - the AI is structuring it…");
  let d;
  try { d = await (await fetch("/api/prayer_pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdf_base64: b64 }) })).json(); }
  catch (e) { toast("⚠ upload failed - is the server running?"); return; }
  if (!d || !d.ok) { toast("⚠ " + ((d && d.error) || "couldn't parse the PDF")); return; }
  _pdfEntries = (d.entries || []).filter((e) => e && e.date);
  renderPrayerReview(d);
}
function renderPrayerReview(d) {
  const ents = _pdfEntries;
  const rows = ents.slice(0, 50).map((e) => `<label class="ics-row"><span class="ics-ev"><b>${esc(e.date)}</b><small>Fajr ${esc(e.fajr || "-")} · Dhuhr ${esc(e.dhuhr || "-")} · Asr ${esc(e.asr || "-")} · Maghrib ${esc(e.maghrib || "-")} · Isha ${esc(e.isha || "-")}</small></span></label>`).join("");
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card pr-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#34d399">📿 review uploaded prayer times</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    ${ents.length ? `<div class="hist-note">Read <b>${ents.length}</b> day(s) from your PDF (${d.chars || 0} chars of text). Check them, then import - they'll merge into your prayer times for the calendar, and a Markdown copy is saved to <b>data/prayer_times.md</b>.</div>`
      : `<div class="hist-note err">⚠ couldn't find a clear timetable in this PDF. If it's a scanned image, a text-based PDF works better.</div>`}
    <label class="fld"><span>Mosque name</span><input id="pdf-mosque" value="${esc(d.mosque || "My mosque")}"></label>
    <div class="ics-list">${rows}${ents.length > 50 ? `<div class="hist-note">…and ${ents.length - 50} more</div>` : ""}</div>
    <div class="drawer-actions"><button class="glow-btn" id="pdf-save" ${ents.length ? "" : "disabled"}>Import &amp; save</button><button class="ghost-btn" data-act="cal-prayers">← back</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  if (ents.length) byId("pdf-save").addEventListener("click", () => savePrayerPdf());
}
async function savePrayerPdf() {
  const mosque = byId("pdf-mosque").value.trim() || "My mosque";
  let d;
  try { d = await (await fetch("/api/prayer_save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mosque, entries: _pdfEntries }) })).json(); }
  catch (e) { toast("⚠ save failed"); return; }
  if (!d || !d.ok) { toast("⚠ " + ((d && d.error) || "save failed")); return; }
  _prayerData = null; // force reload from the new file next populate
  closePopup(); toast(`📿 saved ${d.saved} day(s) (${d.total} total) - now available in 📿 prayer times`);
}

function heatBar(i) {
  return `<button class="heat" data-act="cycle-imp" data-id="${i.id}"
            title="importance: ${IMP[i.importance].label} - click to change"></button>`;
}
function dueChip(i) {
  const u = i.urgency || {};
  if (i.type === "rhythm") { if (!u.due && !u.soon) return ""; const lab = u.due ? fmtDue(u.due) : "soon"; return `<span class="chip due" title="deadline">🕑 ${esc(lab)}</span>`; }
  if (!u.due && !u.soon) return `<span class="chip due add" data-act="card-due" data-id="${i.id}" title="set a due date">🕑 +due</span>`; // v6.5.11
  let label = u.due ? fmtDue(u.due) : "soon";
  const over = u.due && u.due < new Date().toISOString().slice(0, 10);
  return `<span class="chip due ${over ? "over" : ""}" data-act="card-due" data-id="${i.id}" title="click to clear this due date">🕑 ${esc(label)}</span>`;
}
// B3 (v6.6.6): a one-gesture "park this" chip on the card. Hidden until hover when not waiting (mirrors +due).
function waitChip(i) {
  if (isWaiting(i)) {
    const w = i.waitingOn; const lab = w.type === "task" ? "⛓ blocked" : "⏳ waiting";
    return `<span class="chip wait on" data-act="wait-open" data-id="${i.id}" title="why it is parked - click to change or unblock">${lab}</span>`;
  }
  return `<span class="chip wait add" data-act="wait-open" data-id="${i.id}" title="park this - waiting on a task or a reply">⏳ +wait</span>`;
}
// B3: the editor block for waiting-on (a blocked-by-task select + a free-text reply-from input). Habits never wait.
function waitEditor(i) {
  if (i.type === "rhythm") return "";
  const w = i.waitingOn || {};
  return `<div class="fld wait-fld"><span>Waiting on <small>(parks it out of NOW until released)</small></span>
    <div class="fld-row">
      ${taskPickField(i.id, "e-wait-task", w.type === "task" ? w.taskId : "", "blocked by task")}
      <label class="fld"><span>or reply from</span><input id="e-wait-note" placeholder="who / what" value="${esc(w.type === "note" ? w.note : "")}"></label>
    </div></div>`;
}
function fmtDue(d) {
  const today = new Date().toISOString().slice(0, 10);
  if (d === today) return "today";
  const dt = new Date(d + "T00:00:00"), diff = Math.round((dt - new Date(today + "T00:00:00")) / 864e5);
  if (diff === 1) return "tomorrow";
  if (diff > 1 && diff < 7) return dt.toLocaleDateString(undefined, { weekday: "short" });
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function naChip(i) {
  if (!i.nextAction || !i.nextAction.then) return "";
  const ifp = i.nextAction.if ? `if ${esc(i.nextAction.if)} → ` : "→ ";
  return `<span class="chip na" title="next action">${ifp}${esc(i.nextAction.then)}</span>`;
}
function projProgress(i) {
  if (i.type !== "project") return "";
  const subs = isMacro(i) ? leafTasks(i.id) : state.items.filter((s) => s.projectId === i.id); // v6.6.8: macros roll up deep
  const done = subs.filter((s) => s.status === "done").length;
  const pct = subs.length ? Math.round((done / subs.length) * 100) : 0;
  return `<div class="prog"><div class="prog-bar" style="width:${pct}%"></div></div>
          <span class="prog-txt">${done}/${subs.length}</span>`;
}
// ---- v6.6.8: Macro Project (3-level hierarchy: Macro -> Projects -> Tasks). Reuses projectId as the parent
// pointer at both levels; isMacro flags the top container. Backward compatible (no isMacro == a normal project). ----
function isMacro(i) { return !!(i && i.type === "project" && i.isMacro); }
function childrenOf(id) { return state.items.filter((s) => s.projectId === id); } // one level down
function isUnderMacro(i) { const p = i && i.projectId ? item(i.projectId) : null; return !!(p && p.type === "project"); }
function leafTasks(id) { const out = []; (function walk(pid) { childrenOf(pid).forEach((c) => { if (c.type === "project") walk(c.id); else out.push(c); }); })(id); return out; }
function descendantIds(id) { const ids = []; (function walk(pid) { state.items.forEach((s) => { if (s.projectId === pid) { ids.push(s.id); walk(s.id); } }); })(id); return ids; }
// an item is hidden from the loose lanes if it is a level-2 project under a macro, or a grandchild task whose project sits under a macro.
function isNestedUnderMacro(i) {
  if (!i.projectId) return false;
  const p = item(i.projectId); if (!p) return false;
  if (isMacro(p)) return true;
  return isMacro(item(p.projectId));
}
function macroChildBars(i) {
  const kids = childrenOf(i.id).filter((k) => k.type === "project").sort((a, b) => a.order - b.order);
  if (!kids.length) return `<div class="macro-kids empty-kids">no sub-projects yet</div>`;
  return `<div class="macro-kids">` + kids.map((k) => {
    const subs = leafTasks(k.id), done = subs.filter((s) => s.status === "done").length;
    const pct = subs.length ? Math.round(done / subs.length * 100) : 0; const c = cat(k.categoryId);
    return `<div class="macro-kid" title="${esc(k.title)} ${done}/${subs.length}"><span class="macro-kid-name">${esc(k.title)}</span><span class="prog"><i class="prog-bar" style="width:${pct}%; background:${c ? c.color : "var(--blue)"}"></i></span><span class="prog-txt">${done}/${subs.length}</span></div>`;
  }).join("") + `</div>`;
}
function makeChildProject(parentMacro, title) {
  return { id: uid("t"), type: "project", isMacro: false, title, notes: "", categoryId: parentMacro.categoryId, importance: parentMacro.importance,
    urgency: { due: null, soon: false }, status: "active", nextAction: { if: "", then: "" }, estimateMins: null, projectId: parentMacro.id, subtaskIds: [], nextActionId: null,
    cadence: null, everyNDays: null, streak: 0, lastDone: null, history: [], inFocus: false, waitingOn: null, order: state.items.length + 1, createdAt: nowIso(), updatedAt: nowIso(), completedAt: null };
}

function card(i, opts = {}) {
  const c = cat(i.categoryId);
  const done = i.status === "done";
  const checked = done ? "✓" : (i.type === "rhythm" ? "↻" : "");
  const rhythmInfo = i.type === "rhythm"
    ? `<span class="chip rhythm">↻ ${esc(i.cadence || "daily")}${i.streak ? " · 🔥" + i.streak : ""}</span>` : "";
  const nextActionItem = i.type === "project" && i.nextActionId ? item(i.nextActionId) : null;
  const naLine = nextActionItem ? `<span class="chip na">→ ${esc(nextActionItem.title)}</span>` : naChip(i);
  // one color per card = its category (matches the category heading). done = green. uncategorised falls back to importance hue.
  const barColor = done ? DONE_COLOR : (c ? c.color : IMP[i.importance].color);
  return `
  <article class="card imp${i.importance} ${done ? "done" : ""} ${isWaiting(i) ? "is-waiting" : ""} type-${i.type}" data-id="${i.id}" draggable="true"
           style="--imp:${done ? DONE_COLOR : IMP[i.importance].color}; --cat:${c ? c.color : "#475569"}; --bar:${barColor}">
    ${heatBar(i)}
    <button class="check" data-act="toggle-done" data-id="${i.id}" title="${i.type === "rhythm" ? "done today" : "mark done"}">${checked}</button>
    <div class="card-body" data-act="edit" data-id="${i.id}">
      <div class="card-title" data-title-id="${i.id}" title="double-click to rename">${i.type === "project" ? (isMacro(i) ? "🗂 " : "📁 ") : ""}${esc(i.title)}</div>
      <div class="card-meta">
        ${(c && !opts.hideCat) ? `<span class="chip cat"><i style="background:${c.color}"></i>${esc(c.name)}</span>` : (i.status === "inbox" ? `<span class="chip inboxchip">inbox</span>` : "")}
        ${dueChip(i)} ${rhythmInfo} ${naLine}
        ${i.estimateMins ? `<span class="chip est">~${i.estimateMins}m</span>` : ""}
        ${(i.type === "task" || i.type === "project") ? waitChip(i) : ""}
        ${i.protected ? `<span class="card-shield" title="protected by the Priorities Guardian">⛨</span>` : ""}
        ${opts.metaRight || ""}
      </div>
      ${i.type === "project" ? `<div class="proj-row">${projProgress(i)}</div>${isMacro(i) ? macroChildBars(i) : ""}` : ""}
    </div>
    <button class="star ${i.inFocus ? "on" : ""}" data-act="pin" data-id="${i.id}" title="pin to Focus">${i.inFocus ? "★" : "☆"}</button>
  </article>`;
}

function renderFocus() {
  const f = computeFocus();
  const el = byId("focus");
  if (f.totalActive === 0) {
    el.innerHTML = `<div class="focus-head"><h2>Now</h2></div>
      <div class="empty">Nothing active yet. Capture a thought above ⤴</div>`;
    return;
  }
  const protect = f.list.find(isImportantNotUrgent);
  const cards = f.list.map((i) => card(i)).join("");
  const over = f.totalActive > f.list.length;
  el.innerHTML = `
    <div class="focus-head">
      <span class="kicker">01 / NOW</span>
      <h2 style="margin:0"><span class="count">${f.list.length}</span></h2>
      <span class="focus-hint">${f.ai ? "✦ AI-picked quick wins · " : (protect ? "shielding 1 important-but-not-urgent · " : "")}~${FOCUS_CAP} keeps focus sharp</span>
      <button class="ghost-btn sm focus-ai ${f.ai ? "on" : ""}" data-act="focus-ai" title="✦ pick my best ~5 small wins (10-min tasks) with AI">✦ ${f.ai ? "re-pick" : "pick my 5"}</button>
    </div>
    <div class="focus-cards">${cards}</div>
    ${over ? `<button class="expand" data-act="toggle-focus-expand">${focusExpanded ? "↑ collapse" : "↓ show all " + f.totalActive + " active"}</button>` : ""}
    ${focusExpanded && over ? `<div class="focus-cards more">${state.items.filter(i=>i.status==="active"&&i.type!=="rhythm"&&!isWaiting(i)&&!isMacro(i)&&!isNestedUnderMacro(i)&&!i.guardPaused&&!f.list.includes(i)).sort((a,b)=>b.importance-a.importance).map((i)=>card(i)).join("")}</div>` : ""}`;
}
// ---- B5 (v6.6.7): "what should I drop?" overcommit helper. Deterministic ($0, offline). Protect the top,
// park the rest to "someday". Refusing a suggestion captures a reason (training data, kind "overcommit"). ----
let _dropPlan = null, _dropWhyChain = Promise.resolve();
// v6.6.20: a realistic WEEK of focused work (tune via meta.ui.weeklyDayMins). The whole "what to drop?" flow is now a 7-day-deadline prioritiser, not a "how much time right now?" helper.
function _weekBudgetMins() { const perDay = (state.meta.ui && state.meta.ui.weeklyDayMins) || 180; const f = (state.meta.ui && state.meta.ui.overcommitFactor) || 0.85; return Math.round(perDay * 7 * f); }
function dayOvercommitted() { // v6.6.20: name kept (selftest) but now WEEK-based - lights the canvas/calendar "what to drop?" gold when the next 7 days are over budget
  const weekEnd = _dayShift(7);
  const due = state.items.filter((i) => i.status === "active" && i.type !== "rhythm" && !isWaiting(i) && !isMacro(i) && !isNestedUnderMacro(i) && !i.guardPaused && !i.parkedAt && i.urgency && i.urgency.due && i.urgency.due <= weekEnd); // v6.7.1: a pushed-out (parked) task leaves the week budget so the gold "what to drop?" can actually clear
  return due.reduce((s, i) => s + (i.estimateMins || 0), 0) > _weekBudgetMins();
}
function _dueRank(i) { const d = i.urgency && i.urgency.due; return d ? _dnum(d) : Infinity; } // later/no-due = most parkable
function computeOvercommit() { // v6.6.20: WEEK horizon - look 7 days out and decide what to push so next week's top is protected (no time prompt)
  const weekEnd = _dayShift(7);
  const active = state.items.filter((i) => i.status === "active" && i.type !== "rhythm" && !isWaiting(i) && !isMacro(i) && !isNestedUnderMacro(i) && !i.guardPaused);
  const dueSoon = active.filter((i) => !i.parkedAt && i.urgency && i.urgency.due && i.urgency.due <= weekEnd); // deadline within the next 7 days (v6.7.1: exclude already-pushed-out tasks so they aren't re-suggested forever)
  if (!dueSoon.length) return null;
  const dueMins = dueSoon.reduce((s, i) => s + (i.estimateMins || 0), 0);
  const budget = _weekBudgetMins();
  const noEst = dueSoon.filter((i) => !i.estimateMins).length;
  if (dueMins <= budget) return { over: false, weekEnd, budget, dueMins, dueCount: dueSoon.length, noEst };
  // defer the FARTHEST-deadline, LOWEST-importance items first; critical (3) is NEVER auto-parked
  const rankPark = (a, b) => (_dueRank(b) - _dueRank(a)) || (a.importance - b.importance) || ((b.estimateMins || 0) - (a.estimateMins || 0)) || (a.order - b.order);
  const parkable = dueSoon.filter((i) => i.importance < 3 && i.estimateMins).sort(rankPark); // v6.7.1: only estimate-bearing tasks reduce the budget; no-estimate ones are surfaced via noEst instead
  const park = []; let running = dueMins;
  for (const i of parkable) { if (running <= budget) break; park.push(i); running -= (i.estimateMins || 0); }
  const keep = dueSoon.filter((i) => !park.includes(i)).sort((a, b) => b.importance - a.importance || _dueRank(a) - _dueRank(b) || a.order - b.order);
  return { over: true, weekEnd, budget, dueMins, dueCount: dueSoon.length, overBy: dueMins - budget, park, keep, noEst, snapshot: _taskOverviewSnapshot(), at: nowIso() };
}
async function startOvercommitCheck() {
  const plan = computeOvercommit();
  if (!plan) { toast("nothing due in the next 7 days to balance"); return; }
  if (!plan.over) { toast("✓ next week looks doable - " + fmtMins(plan.dueMins) + " due across " + plan.dueCount + " task" + (plan.dueCount === 1 ? "" : "s") + (plan.noEst ? " (" + plan.noEst + " with no estimate)" : "")); return; }
  _dropPlan = plan; openDropReview();
}
function openDropReview() {
  const P = _dropPlan; if (!P) return; const p = byId("popup");
  const keepRows = P.keep.map((it) => { const im = IMP[it.importance] || IMP[0];
    return `<div class="drop-keep-row"><span class="drop-dot" style="background:${im.color}"></span><span class="drop-title">${esc(it.title)}</span><span class="drop-imp" style="color:${im.color}">${im.label}</span>${it.estimateMins ? `<span class="drop-eta">~${it.estimateMins}m</span>` : ""}</div>`; }).join("");
  const parkRows = P.park.map((it) => { const im = IMP[it.importance] || IMP[0]; const due = it.urgency && it.urgency.due;
    return `<div class="drop-row" data-id="${it.id}"><div class="drop-task">${esc(it.title)} <span class="drop-imp" style="color:${im.color}">${im.label}</span></div>
      <div class="drop-meta">${it.estimateMins ? "~" + it.estimateMins + "m" : "no estimate"}${due ? " · due " + esc(due) : " · no deadline"}</div>
      <div class="drop-acts"><button class="ibx-btn enhance" data-act="drop-accept" data-id="${it.id}" title="push to someday - it stays on the board, just out of next week's plan">✓ push out</button>
      <button class="ghost-btn sm" data-act="drop-refuse" data-id="${it.id}" title="keep it in next week - tell me why (helps Himmah learn your priorities)">keep</button></div></div>`; }).join("");
  const allCrit = P.park.length === 0;
  p.innerHTML = `<div class="popup-card drop-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">⚖ Protect next week, push the rest</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="drop-budget hist-note">Next 7 days: <b>${P.dueCount}</b> task${P.dueCount === 1 ? "" : "s"} due, ${fmtMins(P.dueMins)} of work vs a realistic ${fmtMins(P.budget)} week (${fmtMins(P.overBy)} over). Push the lowest-priority, farthest-deadline ones to "someday" so next week's top is protected. Nothing is deleted - they stay on the board, ready when you are.${P.noEst ? ` <b>${P.noEst}</b> due task${P.noEst > 1 ? "s have" : " has"} no estimate (invisible load - add one or use ✦ AI ETA).` : ""}</div>
    <div class="drop-keep"><div class="kicker" style="color:var(--green)">keeping next week (${P.keep.length})</div><div class="drop-keep-list">${keepRows || `<div class="hist-note">nothing protected yet</div>`}</div></div>
    ${allCrit ? `<div class="drop-park"><div class="hist-note">Everything due next week is Critical - none should be pushed. Consider splitting a task into smaller steps, or extending a deadline.</div></div>`
      : `<div class="drop-park"><div class="kicker" style="color:var(--gold)">suggested to push out (${P.park.length})</div><div class="drop-park-list">${parkRows}</div></div>
    <div class="drawer-actions"><button class="glow-btn" data-act="drop-accept-all">Push all suggested</button></div>`}</div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}
function dropAccept(id) {
  const i = item(id); if (!i || !_dropPlan) return;
  i.parkedFrom = i.importance; i.parkedAt = nowIso(); i.importance = 0; // -> someday (reversible: raise importance)
  touch(i); scheduleSave();
  logOutcome({ call_id: null, item_id: id, kind: "overcommit", decision: "accept", ai_proposed: { action: "defer", from: i.parkedFrom, weekEnd: _dropPlan.weekEnd, weekBudget: _dropPlan.budget, dueMins: _dropPlan.dueMins }, my_final: { importance: 0 }, my_reason: null, original_input: i.title, task_overview: _dropPlan.snapshot });
  _dropPlan.park = _dropPlan.park.filter((x) => x.id !== id);
  const row = document.querySelector(`.drop-row[data-id="${id}"]`); if (row) row.remove();
  render();
  if (!_dropPlan.park.length) { _dropPlan = null; closePopup(); toast("✓ next week protected"); }
  else toast("pushed to someday · " + (i.title.length > 30 ? i.title.slice(0, 30) + "…" : i.title));
}
function dropRefuse(id) {
  const i = item(id); if (!i || !_dropPlan) return;
  const log = { snapshot: _dropPlan.snapshot, weekEnd: _dropPlan.weekEnd, budget: _dropPlan.budget, title: i.title, importance: i.importance };
  _dropPlan.park = _dropPlan.park.filter((x) => x.id !== id);
  const row = document.querySelector(`.drop-row[data-id="${id}"]`); if (row) row.remove();
  _dropWhyChain = _dropWhyChain.then(() => askWhy(`keeping "${log.title}" in next week instead of pushing it - why does it matter? (helps Himmah learn your priorities)`).then((reason) => logOutcome({ call_id: null, item_id: id, kind: "overcommit", decision: "reject", ai_proposed: { action: "defer", weekEnd: log.weekEnd, weekBudget: log.budget }, my_final: { kept: true, importance: log.importance }, my_reason: reason, original_input: log.title, task_overview: log.snapshot })));
  if (!_dropPlan.park.length) { _dropPlan = null; closePopup(); }
}
function dropAcceptAll() { (_dropPlan ? _dropPlan.park.map((x) => x.id) : []).forEach(dropAccept); }
// v6.2.2: DeepSeek picks ~5 short, high-impact "small wins" for the NOW bar (a 10-min-gap shortlist).
// v6.5.1: ask how much time is free, then focus5 picks ~5 tasks that FIT (importance-first, urgency-aware). Resolves minutes or null.
function askAvailableMinutes() {
  return new Promise((resolve) => {
    const prior = document.querySelector(".timebox-overlay"); if (prior && prior._tbDone) prior._tbDone();
    const ov = document.createElement("div"); ov.className = "popup timebox-overlay"; ov.hidden = false;
    ov.innerHTML = `<div class="popup-card timebox-card">
      <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">how much time do you have right now?</span><button class="ghost-btn" data-tb="cancel" title="cancel">✕</button></div>
      <div class="tb-quick">
        <button class="ghost-btn tb-opt" data-mins="10">10 min</button>
        <button class="ghost-btn tb-opt" data-mins="30">30 min</button>
        <button class="ghost-btn tb-opt" data-mins="60">1 hour</button>
        <button class="ghost-btn tb-opt" data-mins="120">2 hours+</button>
      </div>
      <label class="tb-custom">or a number <input type="number" class="tb-input" min="1" max="600" step="5" placeholder="min" autocomplete="off"></label>
      <div class="drawer-actions"><button class="glow-btn" data-tb="go">✦ pick my 5</button></div>
      <div class="hist-note">Enter to use the number, Esc to cancel</div></div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add("open"));
    const inp = ov.querySelector(".tb-input");
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; ov._tbDone = null; ov.classList.remove("open"); setTimeout(() => ov.remove(), 180); resolve(val == null ? null : val); };
    ov._tbDone = () => done(null);
    setTimeout(() => { if (inp) inp.focus(); }, 30);
    const fromInput = () => { const n = parseInt(inp.value, 10); return n > 0 ? Math.min(600, n) : null; };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(fromInput()); } if (e.key === "Escape") { e.preventDefault(); done(null); } });
    ov.addEventListener("click", (e) => {
      const opt = e.target.closest(".tb-opt"); if (opt) { done(+opt.dataset.mins); return; }
      const b = e.target.closest("[data-tb]"); if (!b) return;
      if (b.dataset.tb === "go") done(fromInput() || 30); else done(null);
    });
  });
}
function _focusAISetBusy(on) {   // v6.9.3 R6: lock/unlock the pick-my-5 button so concurrent taps can't each fire a real AI call
  try { const b = document.querySelector('[data-act="focus-ai"]'); if (!b) return;
    b.classList.toggle("busy", !!on); b.disabled = !!on;
    if (on) { if (b.dataset.lbl == null) b.dataset.lbl = b.textContent; b.textContent = "✦ picking..."; }
    else if (b.dataset.lbl != null) { b.textContent = b.dataset.lbl; delete b.dataset.lbl; }
  } catch (e) {}
}
async function refreshFocusAI() {
  if (_focusAIBusy) return;   // v6.9.3 R6: a pick is already in flight - ignore the extra tap (each press was firing a REAL /api/ai call)
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  const active = state.items.filter((i) => i.status === "active" && i.type !== "rhythm" && !isWaiting(i) && !isMacro(i) && !isNestedUnderMacro(i) && !i.guardPaused); // B3 + v6.6.8 + v6.6.9: never propose a blocked task, a macro, a macro descendant, or a guardian-paused task
  if (!active.length) { toast("nothing active to pick from"); return; }
  _focusAIBusy = true; _focusAISetBusy(true);   // v6.9.3 R6: lock BEFORE the time prompt so every extra tap (prompt OR in-flight AI) is ignored; released in finally
  try {
    const mins = await askAvailableMinutes();
    if (mins == null) return; // cancelled - no AI spend
    toast("✦ picking 5 that fit…");
    let res;
    try { res = await aiFetch("focus5", { availableMinutes: mins, tasks: active.map((i) => ({ id: i.id, title: i.title, importance: IMP[i.importance].label, eta: i.estimateMins || null, due: (i.urgency && i.urgency.due) || null, soon: !!(i.urgency && i.urgency.soon) })) }); }
    catch (e) { toast("⚠ " + e.message); return; }
    const ids = ((res && res.ids) || []).filter((id) => active.some((x) => x.id === id)).slice(0, FOCUS_CAP);
    if (!ids.length) { toast("✦ no clear quick wins right now"); return; }
    _aiFocus = ids; _aiFocusGen++; render();
    toast(`✦ ${ids.length} task${ids.length > 1 ? "s" : ""} that fit ~${mins} min - knock one out`);
  } finally { _focusAIBusy = false; _focusAISetBusy(false); }
}

function inboxCard(i) {
  // v6.1.5: small colour-coded buttons sit to the RIGHT of the "inbox" label (in the card meta row).
  // Enhance (cyan) sharpens the wording; Enrich (purple) expands via life context. Nothing runs until pressed.
  const etaTxt = i.estimateMins ? `~${i.estimateMins}m` : "Est. min"; // v6.6.5: AI ETA in the inbox (where tasks are prepared)
  const actions = `<span class="ibx-actions">
      <button class="ibx-btn applyall" data-act="apply-ai-all" data-id="${i.id}" title="✦ Apply all - walk this task through enhance, enrich, estimate, triage (and a calendar slot only if it reads like a today/tomorrow task), approving each step in order">✦ Apply all</button>
      <button class="ibx-btn eta" data-act="ai-eta" data-id="${i.id}" title="✦ AI estimate - guesses how long this takes, with a reason">✦ ${etaTxt}</button>
      <button class="ibx-btn enhance" data-act="inbox-enhance" data-id="${i.id}" title="✦ Enhance - sharpen the wording (preview first; never adds meaning)">✦ Enhance</button>
      <button class="ibx-btn enrich" data-act="inbox-enrich" data-id="${i.id}" title="✦ Enrich - expand this fragment using your life context (preview first)">✦ Enrich</button>
    </span>`;
  const base = card(i, { metaRight: actions });
  return `<div class="inbox-item">${base}${inboxSuggestBlocks(i)}</div>`;
}
// v6.6.14: the schedule / ETA / triage-axes suggestion markup, extracted so BOTH the side-panel inbox card
// AND the full-screen inbox row render the same approval UI (the full-screen row used to drop it - Bug #2).
// The <select id="tri-*-${id}"> / input id="eta-sg-${id}" ids are global, so the existing resolvers work in either surface.
function etaSuggestRow(i) {
  const s = i.etaSuggest; if (!s) return "";
  return `<div class="eta-sug">
    <div class="eta-sug-line"><span class="eta-sug-when">⏱ ~${s.minutes}m
      <input class="eta-sg-edit" id="eta-sg-${i.id}" type="number" min="5" step="5" value="${s.minutes}" title="tweak the estimate"></span>
      <span class="eta-sug-acts"><button class="mini accept" data-act="eta-ok" data-id="${i.id}" title="use this estimate">✓</button><button class="mini" data-act="eta-no" data-id="${i.id}" title="reject - tell me why">✕</button></span></div>
    ${s.reason ? `<div class="eta-sug-why">${esc(s.reason)}</div>` : ""}</div>`;
}
function inboxSuggestBlocks(i) {
  // v6.2.1: /cal scheduling suggestion (accept → calendar event; deny → why, both logged as training data)
  const ss = i.schedSuggest;
  const sched = ss ? `<div class="sched-sug">
      <div class="sched-line"><span class="sched-when">📅 ${esc(ss.date)} · ${esc(ss.start)}–${esc(ss.end)}${ss.eta ? " · ~" + ss.eta + "m" : ""}</span>
        <span class="sched-acts"><button class="mini accept" data-act="sched-yes" data-id="${i.id}" title="add this block to the calendar">✓ schedule</button><button class="mini" data-act="sched-no" data-id="${i.id}" title="no - tell me why">✗</button></span></div>
      ${ss.reason ? `<div class="sched-why">${esc(ss.reason)}</div>` : ""}</div>` : "";
  const eta = etaSuggestRow(i); // v6.6.14: the ETA proposal chip (accept/reject in the row)
  if (!i.suggest) {
    return `${sched}${eta}`;
  }
  // per-axis suggestion (from the on-demand ✦ Triage): category, urgency, and (optional) cleaned title
  // are accepted/changed/rejected INDEPENDENTLY. Each pending axis is its own row with a <select> + ✓/✗.
  const s = i.suggest;
  const imp = s.importance == null ? 1 : s.importance;
  const catPending = !s.catDone, urgPending = !s.urgDone;
  const titlePending = s.cleaned && s.cleaned !== i.title && !s.titleDone;
  const catOpts = `<option value="">- none -</option>` +
    state.categories.map((c) => `<option value="${c.id}" ${s.categoryId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const urgOpts = [3, 2, 1, 0].map((n) => `<option value="${n}" ${imp === n ? "selected" : ""}>${IMP[n].label}</option>`).join("");
  const catRow = catPending ? `
    <div class="sx-row"><span class="sx-axis">category</span>
      <select class="sx-sel" id="tri-cat-${i.id}">${catOpts}</select>
      <button class="mini accept" data-act="tri-cat-ok" data-id="${i.id}" title="apply the selected category">✓</button>
      <button class="mini" data-act="tri-cat-no" data-id="${i.id}" title="reject - leave uncategorised">✕</button></div>` : "";
  const urgRow = urgPending ? `
    <div class="sx-row"><span class="sx-axis">urgency</span>
      <select class="sx-sel" id="tri-urg-${i.id}">${urgOpts}</select>
      <button class="mini accept" data-act="tri-urg-ok" data-id="${i.id}" title="apply the selected importance">✓</button>
      <button class="mini" data-act="tri-urg-no" data-id="${i.id}" title="reject - keep current importance">✕</button></div>` : "";
  const titleRow = titlePending ? `
    <div class="sx-row"><span class="sx-axis">title</span>
      <span class="sx-cleaned" title="cleaned title">“${esc(s.cleaned)}”</span>
      <button class="mini accept" data-act="tri-title-ok" data-id="${i.id}" title="use the cleaned title">✓</button>
      <button class="mini" data-act="tri-title-no" data-id="${i.id}" title="keep the original title">✕</button></div>` : "";
  return `${sched}${eta}
    <div class="suggest suggest-axes">
      <div class="sx-head"><span class="suggest-label ${s.src === "ai" ? "ai" : ""}">${s.src === "ai" ? "✦ AI" : "≈ local"}</span></div>
      ${catRow}${urgRow}${titleRow}
    </div>`;
}
function renderInbox() {
  const inbox = state.items.filter((i) => i.status === "inbox");
  const el = byId("inbox");
  if (!inbox.length) { el.innerHTML = ""; el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="lane-head inbox-head">
      <h3>📥 Inbox <span class="count">${inbox.length}</span></h3>
      <span class="lane-sub">untriaged - set a category &amp; importance</span>
      <button class="ghost-btn triage-btn" data-act="triage-inbox" title="auto-suggest category + importance from your own categories (optional LLM if a key is set)">✦ Triage</button>
    </div>
    <div class="lane-cards">${inbox.map(inboxCard).join("")}</div>`;
}

// heuristic classifier trained on the user's own categorized tasks (no dependencies)
const STOP = new Set(["the", "and", "for", "with", "you", "your", "this", "that", "get", "make", "from", "into", "new", "all", "not", "are", "via", "per", "out", "how", "can", "but", "our", "use"]);
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9']{3,}/g) || []).filter((w) => !STOP.has(w));
function classifyHeuristic(titleText) {
  const tw = words(titleText);
  const scores = {}, impSum = {}, impCount = {};
  state.items.forEach((i) => {
    if (!i.categoryId || i.type === "rhythm") return;
    const iw = new Set(words(i.title));
    let overlap = 0; tw.forEach((w) => { if (iw.has(w)) overlap++; });
    scores[i.categoryId] = (scores[i.categoryId] || 0) + overlap;
    impSum[i.categoryId] = (impSum[i.categoryId] || 0) + i.importance; impCount[i.categoryId] = (impCount[i.categoryId] || 0) + 1;
  });
  state.categories.forEach((c) => { const cn = c.name.toLowerCase(); tw.forEach((w) => { if (cn.includes(w)) scores[c.id] = (scores[c.id] || 0) + 3; }); });
  let best = null, bestScore = 0;
  Object.entries(scores).forEach(([cid, s]) => { if (s > bestScore) { bestScore = s; best = cid; } });
  const importance = best && impCount[best] ? Math.round(impSum[best] / impCount[best]) : 1;
  return { categoryId: best, importance, cleaned: null };
}
// ---------- AI (v5.2) ----------
// ALL AI goes through OUR server (/api/ai → DeepSeek). The browser never talks to the internet
// and never sees a key (README §3.7 spirit). Server enforces the hard daily budget cap.
let aiStatus = { hasKey: false, enabled: false, mock: false, spentToday: 0, cap: 0.1, callsToday: 0, model: "" };
async function refreshAiStatus() {
  try { aiStatus = await (await fetch("/api/ai/status")).json(); } catch (_) {}
  renderAiChip();
}
function renderAiChip() {
  const b = byId("aiBtn"); if (!b) return;
  b.classList.toggle("ai-on", !!aiStatus.enabled);
  b.title = aiStatus.enabled
    ? `AI on (${aiStatus.mock ? "mock" : aiStatus.model}) · ${(aiStatus.spentToday * 100).toFixed(2)}¢ of ${(aiStatus.cap * 100).toFixed(0)}¢ today`
    : (aiStatus.hasKey ? "AI paused - daily budget reached, resets at midnight" : "AI off - add a key (Setup Guides)");
}
// The server returns a unique call_id per AI call. We stash the most-recent one here;
// each caller reads lastCallId() on the line right after its own `await` (no other JS can run
// between an await resolving and the next synchronous line, so this is race-safe even if
// two AI calls overlap). The id ties a proposal to the owner's later accept/edit/reject.
let _lastCallId = null;
function lastCallId() { return _lastCallId; }
async function aiFetch(kind, payload) {
  const r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ kind }, payload)) });
  const d = await r.json().catch(() => ({}));
  if (d.status) { Object.assign(aiStatus, d.status); renderAiChip(); }
  if (!d.ok) throw new Error(d.error || "AI call failed");
  _lastCallId = d.call_id || null;
  return d.result;
}
// durable decision logging (training data). Fire-and-forget; never blocks or breaks the UI.
// The server stamps ts + tag and appends ONE line to data/ai_actions.jsonl.
function logOutcome(o) {
  try {
    fetch("/api/ai_outcome", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(o) }).catch(() => {});
  } catch (_) {}
}
// optional, skippable one-line "Why?" - resolves to the reason string, or null if skipped/closed.
// Renders its OWN overlay (appended to body, z above #popup) so it never destroys an underlying
// popup that holds other pending decisions (e.g. the multi-group project picker).
function askWhy(context) {
  return new Promise((resolve) => {
    // singleton: settle any already-open Why? box (as skipped) so boxes never stack / steal focus
    const prior = document.querySelector(".why-overlay");
    if (prior && prior._whyDone) prior._whyDone(null);
    const ov = document.createElement("div");
    ov.className = "popup why-overlay";
    ov.hidden = false;
    ov.innerHTML = `<div class="popup-card why-card">
      <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">why? <small>(optional)</small></span>
        <button class="ghost-btn" data-w="skip" title="skip">✕</button></div>
      <div class="why-ctx">${esc(context)}</div>
      <input class="why-input" placeholder="one line - helps Himmah learn your taste" autocomplete="off" maxlength="280">
      <div class="drawer-actions"><button class="glow-btn" data-w="save">Save reason</button>
        <button class="ghost-btn" data-w="skip">Skip</button></div>
      <div class="hist-note">optional - Enter to save, Esc or Skip to leave it blank</div></div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add("open"));
    const inp = ov.querySelector(".why-input");
    let settled = false;
    const done = (val) => { if (settled) return; settled = true; ov._whyDone = null; ov.classList.remove("open"); setTimeout(() => ov.remove(), 180); resolve(val || null); };
    ov._whyDone = done; // lets a later askWhy() settle this box before opening its own
    setTimeout(() => { if (inp) inp.focus(); }, 30);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(inp.value.trim()); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); } // v6.6.10: don't let Esc bubble to the global closePopup (would abort a calendarize commit while the why-box is open)
    });
    ov.addEventListener("click", (e) => {
      const w = e.target.closest("[data-w]"); if (!w) return;
      done(w.dataset.w === "save" ? inp.value.trim() : null);
    });
  });
}
// triage = propose a category + importance (+ optional cleaned title) for inbox notes.
// `onlyItems` lets us triage just the freshly-captured notes (cheaper) instead of the whole inbox.
async function triageInbox(silent, onlyItems) {
  const inbox = onlyItems || state.items.filter((i) => i.status === "inbox");
  if (!inbox.length) { if (!silent) toast("Inbox is empty"); return; }
  if (aiStatus.enabled) {
    if (!silent) toast("✦ AI triaging…");
    try {
      const res = await aiFetch("triage", {
        items: inbox.map((i) => ({ id: i.id, title: i.title })),
        categories: state.categories.map((c) => c.name),
      });
      const callId = lastCallId();
      (res.results || []).forEach((s) => {
        const it = item(s.id); if (!it || it.status !== "inbox") return;
        const c = state.categories.find((c) => c.name.toLowerCase() === String(s.category || "").toLowerCase());
        it.suggest = { categoryId: c ? c.id : null, importance: Math.max(0, Math.min(3, s.importance == null ? 1 : +s.importance)),
          cleaned: s.title && s.title !== it.title ? s.title : null, src: "ai", callId: callId };
      });
      render(); refreshInboxCount();
      if (!silent) toast("✦ suggestions ready - approve each in the Inbox"); else if (res.results && res.results.length) toast("✦ suggestion ready in the Inbox");
      return;
    } catch (e) { if (!silent) toast("⚠ " + e.message); }
  }
  // free, offline fallback - the app never depends on AI
  inbox.forEach((it) => { const s = classifyHeuristic(it.title);
    it.suggest = { categoryId: s.categoryId || null, importance: s.importance == null ? 1 : s.importance, cleaned: null, src: "heur" }; });
  render();
  if (!silent) toast("≈ local suggestions ready (AI is off)");
}
// v5.4.1: triage is on-demand only (the ✦ Triage button) - no auto-firing on capture or app-open.
// ✦ enhance straight from an inbox row (preview + approve, on demand)
async function enhanceInboxItem(id) {
  const i = item(id); if (!i) return;
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  toast("✦ enhancing…");
  let res;
  try { res = await aiFetch("enhance", { text: i.title }); }
  catch (e) { toast("⚠ " + e.message); return; }
  if (!res || res.changed === false || !res.enhanced || res.enhanced === i.title) { toast("✦ already clean - kept as-is"); return; }
  const callId = lastCallId();
  openEnhancePreview(i.title, res.enhanced, res.guard || "", { callId, itemId: i.id, kind: "enhance" }, (r) => {
    if (r.decision === "accept" || r.decision === "edit") {
      const before = { title: i.title };
      i.title = r.finalText; logAi(i.id, before, { title: r.finalText, via: "enhance" });
      touch(i); scheduleSave(); render(); toast("✦ wording updated");
    }
  });
}
// ✦ enrich an inbox fragment using the owner's life context (v5.4.2). Approval-gated; the outcome line
// captures original_input + context_used for training (how the owner turns fragments into tasks).
let _enrichGen = 0;  // v6.9: bumped whenever Enrich RUNS (changed or already-clean) - mirrors _enhanceGen so the tour's enrich_mine do-step can detect a clean no-op (AI ran, popup never opened) vs an accepted change
async function enrichInboxItem(id) {
  const i = item(id); if (!i) return;
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  toast("✦ enriching…");
  let res;
  try { res = await aiFetch("enrich", { text: i.title }); }
  catch (e) { toast("⚠ " + e.message); return; }
  _enrichGen++;
  if (!res || res.changed === false || !res.enriched || res.enriched === i.title) { toast("✦ no relevant life-context - kept as-is"); return; }
  const callId = lastCallId();
  const note = res.context_used ? ("✦ used your context: " + res.context_used) : "";
  openEnhancePreview(i.title, res.enriched, note,
    { callId, itemId: i.id, kind: "enrich", extra: { original_input: i.title, context_used: res.context_used || "" } },
    (r) => {
      if (r.decision === "accept" || r.decision === "edit") {
        const before = { title: i.title };
        i.title = r.finalText; logAi(i.id, before, { title: r.finalText, via: "enrich" });
        touch(i); scheduleSave(); render(); toast("✦ enriched");
      }
    });
}

// ---- enhance/enrich preview: editable suggestion + approve, never silently applied ----
// The suggestion side is EDITABLE: keep as-is (accept), tweak it (edit), or keep original (reject).
// ctx = {callId, itemId, kind?:"enhance"|"enrich", extra?:{...}}. onDone({decision, finalText}).
// edit/reject ask an optional Why?; every non-dismiss decision is logged to ai_actions.jsonl.
let _enhClose = null; // called when the preview closes without a button (treated as dismiss)
function openEnhancePreview(original, enhanced, note, ctx, onDone) {
  ctx = ctx || {}; let settled = false;
  const kind = ctx.kind || "enhance";
  const word = kind === "enrich" ? "enriched" : "enhanced";
  const finish = async (decision, finalText) => {
    if (settled) return; settled = true; _enhClose = null;
    closePopup(); // hide the preview first; askWhy floats its own overlay
    let reason = null;
    if (decision === "edit" || decision === "reject") {
      reason = await askWhy(decision === "reject"
        ? `kept the original instead of:\n“${enhanced}”`
        : `edited the ${word} suggestion for:\n“${original}”`);
    }
    if (decision !== "dismiss") {
      logOutcome(Object.assign({ call_id: ctx.callId || null, item_id: ctx.itemId || null, kind: kind,
        decision, ai_proposed: enhanced, my_final: finalText, my_reason: reason }, ctx.extra || {}));
    }
    onDone({ decision, finalText });
  };
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card enh-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">✦ ${word} - approve or tweak?</span><button class="ghost-btn" id="enhDismiss">✕</button></div>
    <div class="enh-compare">
      <div class="enh-block"><span class="kicker">original</span><div class="enh-text">${esc(original)}</div></div>
      <div class="enh-block to"><span class="kicker" style="color:var(--purple)">${word} <small>(editable)</small></span>
        <textarea class="enh-edit" id="enhEdit" rows="3">${esc(enhanced)}</textarea></div>
    </div>
    ${note ? `<div class="hist-note">${esc(note)}</div>` : ""}
    <div class="drawer-actions">
      <button class="glow-btn" id="enhAccept">✓ Use this</button>
      <button class="ghost-btn" id="enhKeep">✗ Keep original</button>
    </div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  _enhClose = () => finish("dismiss", original);
  byId("enhAccept").addEventListener("click", () => {
    const base = enhanced.trim(); // v6.7.1: trim the FALLBACK too, so a cleared box applies the clean suggestion and is classified "accept", not "edit"
    const finalText = byId("enhEdit").value.trim() || base;
    finish(finalText === base ? "accept" : "edit", finalText);
  });
  byId("enhKeep").addEventListener("click", () => finish("reject", original));
  byId("enhDismiss").addEventListener("click", () => finish("dismiss", original));
}
async function runEnhanceQueue(ids) {
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ /ench needs AI - see Setup Guides"); return; }
  for (const id of ids) {
    const i = item(id); if (!i) continue;
    let res;
    try { res = await aiFetch("enhance", { text: i.title }); }
    catch (e) { toast("⚠ " + e.message); return; }
    if (!res || res.changed === false || !res.enhanced || res.enhanced === i.title) { toast("✦ already clean - kept as-is"); continue; }
    const callId = lastCallId();
    const accepted = await new Promise((resolve) => {
      openEnhancePreview(i.title, res.enhanced, res.guard || "", { callId, itemId: i.id }, (r) => {
        if (r.decision === "accept" || r.decision === "edit") {
          const before = { title: i.title };
          i.title = r.finalText; logAi(i.id, before, { title: r.finalText });
          touch(i); scheduleSave(); render(); resolve(true);
        } else { resolve(false); }
      });
    });
    if (!accepted && ids.length > 1) { /* user dismissed/kept original - stop nagging through the rest */ break; }
  }
}
let _enhanceGen = 0;  // v6.7.20 #6: bumped whenever Enhance RUNS (changed or already-clean), so the Part A enhance_mine step advances even when a tidy typist's title needs no fix
async function enhanceField(fieldId) { // drawer ✦ buttons: enhance an input in place; Save = final approval
  const el = byId(fieldId); if (!el) return;
  const text = el.value.trim();
  if (!text) { toast("nothing to enhance"); return; }
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  toast("✦ enhancing…");
  let res;
  try { res = await aiFetch("enhance", { text }); }
  catch (e) { toast("⚠ " + e.message); return; }
  _enhanceGen++;
  if (!res || res.changed === false || !res.enhanced || res.enhanced === text) { toast("✦ already clean - kept as-is"); return; }
  const callId = lastCallId();
  openEnhancePreview(text, res.enhanced, res.guard || "", { callId, itemId: editingId }, (r) => {
    if (r.decision === "accept" || r.decision === "edit") { el.value = r.finalText; toast("filled - Save to keep it"); }
  });
}

// ---- AI project builder: suggest sub-steps for the open task / find groups across the board ----
async function suggestSubsteps() {
  const i = item(editingId); if (!i) return;
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  toast("✦ thinking in steps…");
  let res;
  try { res = await aiFetch("substeps", { title: byId("e-title") ? byId("e-title").value : i.title, notes: byId("e-notes") ? byId("e-notes").value : i.notes }); }
  catch (e) { toast("⚠ " + e.message); return; }
  const steps = (res && res.steps || []).map((s) => String(s)).filter(Boolean).slice(0, 7);
  if (!steps.length) { toast("✦ no steps proposed"); return; }
  const callId = lastCallId();
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">✦ proposed sub-steps - approve?</span><button class="ghost-btn" id="subDismiss">✕</button></div>
    <div class="pop-list">${steps.map((s, ix) => `<label class="pop-row substep-row"><input type="checkbox" checked data-step="${ix}"><span class="pop-title">${esc(s)}</span></label>`).join("")}</div>
    <div class="hist-note">checked steps become sub-tasks · the task becomes a <b>project</b> · the first checked one becomes its next action</div>
    <div class="drawer-actions"><button class="glow-btn" id="subAccept">✓ Create project</button><button class="ghost-btn" id="subCancel">✗ Cancel</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  byId("subDismiss").addEventListener("click", () => closePopup()); // ✕ = silent dismiss (no log)
  byId("subCancel").addEventListener("click", () => {
    closePopup();
    askWhy(`cancelled the ${steps.length} proposed sub-steps`).then((reason) =>
      logOutcome({ call_id: callId, item_id: i.id, kind: "substeps", decision: "reject", ai_proposed: steps, my_final: [], my_reason: reason }));
  });
  byId("subAccept").addEventListener("click", () => {
    const keep = [...p.querySelectorAll("[data-step]:checked")].map((cb) => steps[+cb.dataset.step]);
    const decision = !keep.length ? "reject" : (keep.length === steps.length ? "accept" : "edit");
    const emit = (reason) => logOutcome({ call_id: callId, item_id: i.id, kind: "substeps",
      decision, ai_proposed: steps, my_final: keep, my_reason: reason });
    closePopup();
    if (!keep.length) { askWhy(`unchecked every proposed sub-step`).then(emit); return; } // nothing to create
    const before = { type: i.type, subtaskIds: [...(i.subtaskIds || [])] };
    i.type = "project";
    keep.forEach((title) => {
      const sub = { id: uid("t"), type: "task", title, notes: "", categoryId: i.categoryId, importance: i.importance,
        urgency: { due: null, soon: false }, status: "active", nextAction: { if: "", then: "" }, estimateMins: null,
        projectId: i.id, subtaskIds: [], nextActionId: null, cadence: null, everyNDays: null, streak: 0,
        lastDone: null, history: [], inFocus: false, order: state.items.length + 1, createdAt: nowIso(), updatedAt: nowIso(), completedAt: null };
      state.items.push(sub);
      if (!i.nextActionId) i.nextActionId = sub.id;
    });
    logAi(i.id, before, { type: "project", added: keep.length });
    touch(i); scheduleSave(); render();
    if (decision === "accept") emit(null);
    else askWhy(`kept ${keep.length}/${steps.length} proposed sub-steps`).then(emit);
    if (editingId === i.id) openEditor(i.id); // refresh the drawer to show the sub-task list
    toast(`📁 project created - ${keep.length} sub-task${keep.length > 1 ? "s" : ""}`);
  });
}
async function aiFindGroups() {
  const loose = state.items.filter((i) => i.status === "active" && i.type === "task" && !i.projectId);
  if (loose.length < 4) { toast("✦ not enough loose tasks to group"); return; }
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  toast("✦ looking for project groups…");
  let res;
  try { res = await aiFetch("group", { tasks: loose.map((t) => ({ id: t.id, title: t.title, category: (cat(t.categoryId) || {}).name || "" })) }); }
  catch (e) { toast("⚠ " + e.message); return; }
  const groups = (res && res.groups || []).filter((g) => Array.isArray(g.taskIds) && g.taskIds.map(item).filter(Boolean).length >= 2);
  if (!groups.length) { toast("✦ no obvious project groups - your tasks look independent"); return; }
  const callId = lastCallId();
  const titlesOf = (ids) => ids.map(item).filter(Boolean).map((t) => t.title); // for ai_proposed
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">✦ proposed projects - approve each?</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="pop-list">${groups.map((g, gi) => `
      <div class="group-card" data-group="${gi}">
        <div class="group-head"><b>📁 ${esc(g.name || "Project")}</b>
          <span><button class="glow-btn sm" data-mkgroup="${gi}">✓ Create</button>
          <button class="ghost-btn sm" data-grpno="${gi}" title="reject this group">✗</button></span></div>
        ${g.why ? `<div class="group-why">${esc(g.why)}</div>` : ""}
        <ul class="group-list">${g.taskIds.map(item).filter(Boolean).map((t) => `<li><label><input type="checkbox" checked data-gm="${gi}" data-tid="${t.id}"> ${esc(t.title)}</label></li>`).join("")}</ul>
      </div>`).join("")}</div>
    <div class="hist-note">tick/untick members, then ✓ Create - or ✗ to reject a group. Nothing happens without it.</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  p.querySelectorAll("[data-grpno]").forEach((b) => b.addEventListener("click", () => {
    const gi = +b.dataset.grpno, g = groups[gi];
    const card = p.querySelector(`.group-card[data-group="${gi}"]`); if (card) { card.style.opacity = ".4"; card.querySelectorAll("button,input").forEach((x) => x.disabled = true); }
    askWhy(`rejected the project “${g.name || "Project"}”`).then((reason) =>
      logOutcome({ call_id: callId, item_id: null, kind: "group", decision: "reject",
        ai_proposed: { name: g.name, members: titlesOf(g.taskIds) }, my_final: null, my_reason: reason }));
  }));
  p.querySelectorAll("[data-mkgroup]").forEach((b) => b.addEventListener("click", () => {
    const gi = +b.dataset.mkgroup, g = groups[gi];
    const checkedIds = [...p.querySelectorAll(`[data-gm="${gi}"]:checked`)].map((cb) => cb.dataset.tid);
    const members = checkedIds.map(item).filter((t) => t && !t.projectId);
    if (members.length < 2) { toast("pick at least 2 members"); return; }
    const proposedIds = g.taskIds.map(item).filter(Boolean).map((t) => t.id);
    const sameSet = members.length === proposedIds.length && members.every((t) => proposedIds.includes(t.id));
    const decision = sameSet ? "accept" : "edit";
    const counts = {};
    members.forEach((t) => { if (t.categoryId) counts[t.categoryId] = (counts[t.categoryId] || 0) + 1; });
    const topCat = Object.entries(counts).sort((a, b) => b[1] - a[1]).map((e) => e[0])[0] || null;
    const proj = { id: uid("t"), type: "project", title: g.name || "Project", notes: g.why || "", categoryId: topCat,
      importance: Math.max(...members.map((t) => t.importance)), urgency: { due: null, soon: false }, status: "active",
      nextAction: { if: "", then: "" }, estimateMins: null, projectId: null, subtaskIds: [], nextActionId: members[0].id,
      cadence: null, everyNDays: null, streak: 0, lastDone: null, history: [], inFocus: false, order: -1,
      createdAt: nowIso(), updatedAt: nowIso(), completedAt: null };
    state.items.push(proj);
    members.forEach((t) => { t.projectId = proj.id; touch(t); });
    logAi(proj.id, { created: "ai-group" }, { title: proj.title, members: members.length });
    normalizeOrders(); scheduleSave(); render();
    b.textContent = "✓ created"; b.disabled = true;
    const emit = (reason) => logOutcome({ call_id: callId, item_id: proj.id, kind: "group", decision,
      ai_proposed: { name: g.name, members: titlesOf(g.taskIds) }, my_final: { name: proj.title, members: members.map((t) => t.title) }, my_reason: reason });
    if (decision === "edit") askWhy(`created “${proj.title}” with ${members.length}/${proposedIds.length} proposed members`).then(emit);
    else emit(null);
    toast(`📁 “${proj.title}” created with ${members.length} sub-tasks`);
  }));
}

// ---- AI if-then suggester (drawer) + weekly review digest ----
async function suggestIfThen() {
  const i = item(editingId); if (!i) return;
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  toast("✦ suggesting an if-then…");
  let res;
  try { res = await aiFetch("ifthen", { title: byId("e-title") ? byId("e-title").value : i.title, notes: i.notes || "", cadence: i.cadence || "" }); }
  catch (e) { toast("⚠ " + e.message); return; }
  if (!res || !res.then) { toast("✦ nothing suggested"); return; }
  if (byId("e-if")) byId("e-if").value = res.if || "";
  if (byId("e-then")) byId("e-then").value = res.then || "";
  i.nextAction = i.nextAction || { if: "", then: "" };                                   // v6.9.3 R5: persist the suggestion to STATE immediately (mirror saveDrawer's i.nextAction write) so it survives even if the tour/card advances before the owner hits Save - it used to only fill the DOM inputs and was lost
  i.nextAction.if = (res.if || "").trim(); i.nextAction.then = (res.then || "").trim(); touch(i); scheduleSave();
  // remember what the AI proposed so saveDrawer can log accept-vs-edit when the owner saves
  _ifthenProposal = { callId: lastCallId(), itemId: editingId, if: res.if || "", then: res.then || "" };
  toast("✦ filled - edit freely, Save to keep");
}
// v6.6.2: AI-estimated ETA for a task, with the reason logged as training data.
async function estimateEta(id) {
  const i = item(id || editingId); if (!i) return;
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  toast("✦ estimating how long this takes…");
  let res; const c = cat(i.categoryId);
  try { res = await aiFetch("eta", { title: byId("e-title") ? byId("e-title").value : i.title, notes: (byId("e-notes") ? byId("e-notes").value : i.notes) || "", category: (c && c.name) || "" }); }
  catch (e) { toast("⚠ " + e.message); return; }
  const mins = res && +res.minutes;
  if (!mins) { toast("✦ no estimate"); return; }
  const callId = lastCallId();
  if (byId("e-est")) {
    // v6.6.14: drawer open -> ASK PERMISSION via a proposal popover. Accept fills #e-est (Save still keeps it); Reject asks why. Both logged.
    openEtaProposal(i, mins, res.reason || "", { callId }, (finalMins) => { const el = byId("e-est"); if (el) el.value = finalMins; }); // guard: drawer may have closed
  } else {
    // v6.6.14: no drawer (inbox / full-screen) -> PROPOSE in the row (etaSuggest), never auto-apply. Owner accepts/rejects via etaResolve.
    i.etaSuggest = { minutes: mins, reason: res.reason || "", callId, src: "ai" };
    touch(i); scheduleSave(); render(); refreshInboxCount();
    toast("✦ ~" + mins + " min proposed - approve it in the inbox");
  }
}
// v6.6.14: AI ETA must ASK PERMISSION (it used to auto-apply). In the editor drawer the proposal floats
// above the open drawer; Accept fills #e-est (number editable; Save keeps it), Reject asks why. Every
// decision (accept / edit / reject) is archived to ai_actions.jsonl; a dismiss does nothing and is not logged.
// v6.6.36: AI suggests turning the "Parallel" flag ON (with permission). Accept / reject (with a reason) and any manual
// toggle are all archived to ai_actions.jsonl - training data so a future agent can make this call itself.
let _lastParallelSuggest = null, _parClose = null, _parallelGen = 0;  // v6.9: _parallelGen bumped whenever the AI-parallel check RUNS, like _enhanceGen/_enrichGen
async function suggestParallel(id) {
  const i = item(id || editingId); if (!i) return;
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  toast("✦ checking if this can run in parallel...");
  let res; const c = cat(i.categoryId);
  try { res = await aiFetch("parallel", { title: byId("e-title") ? byId("e-title").value : i.title, notes: (byId("e-notes") ? byId("e-notes").value : i.notes) || "", category: (c && c.name) || "", eta: i.estimateMins || null }); }
  catch (e) { toast("⚠ " + e.message); return; }
  _parallelGen++;
  const callId = lastCallId(), par = !!(res && res.parallel), reason = (res && res.reason) || "";
  _lastParallelSuggest = { parallel: par, reason, callId };
  openParallelProposal(i, par, reason, callId); // v6.6.37: ALWAYS a readable popover (yes OR no), with an optional reason on either choice - never a flash toast
}
// v6.6.37: the popover shows the AI verdict (parallel yes OR no) and lets you AGREE or OVERRIDE, with an optional
// reason on either choice. Agree => decision "accept" (my_final matches the AI); Override => "reject" (my_final is the opposite).
function openParallelProposal(i, aiPar, reason, callId) {
  const p = byId("popup"); let settled = false;
  const finish = (decision) => { // decision: "agree" | "override" | "dismiss"
    if (settled) return; settled = true; _parClose = null;
    if (decision === "dismiss") { closePopup(); return; }
    const why = (byId("parWhy") && byId("parWhy").value.trim()) || null; // optional reason, captured for BOTH approve and override
    const finalPar = decision === "agree" ? aiPar : !aiPar;
    closePopup();
    logOutcome({ call_id: callId, item_id: i.id, kind: "parallel", decision: decision === "agree" ? "accept" : "reject",
      ai_proposed: { parallel: aiPar, reason }, my_final: { parallel: finalPar }, my_reason: why, original_input: i.title });
    i.parallel = finalPar; if (_editorSnap) _editorSnap.parallel = finalPar;
    const cb = byId("e-parallel"); if (cb) cb.checked = finalPar; touch(i); scheduleSave();
    toast(finalPar ? "↔ Parallel on - Calendarize will overlap it with your other work" : "→ kept as focused work");
  };
  const verdict = aiPar
    ? "Himmah thinks this <b>can run in parallel</b> with your other work."
    : "Himmah thinks this is <b>focused work</b> - better with its own slot.";
  const agreeLabel = aiPar ? "✓ Turn Parallel on" : "✓ Keep it focused";
  const overrideLabel = aiPar ? "✗ No, keep it focused" : "↔ No, it runs in parallel";
  p.innerHTML = `<div class="popup-card eta-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--blue)">↔ runs in parallel?</span><button class="ghost-btn" id="parDismiss">✕</button></div>
    <div class="eta-why" style="font-style:normal">${verdict}</div>
    ${reason ? `<div class="hist-note">${esc(reason)}</div>` : ""}
    <label class="par-why-l">your take <span class="par-why-opt">(optional - this is what trains the agent)</span>
      <textarea id="parWhy" class="par-why" rows="2" placeholder="why do you agree, or disagree?"></textarea></label>
    <div class="drawer-actions"><button class="glow-btn" id="parAccept">${agreeLabel}</button><button class="ghost-btn" id="parReject">${overrideLabel}</button></div>
  </div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  _parClose = () => finish("dismiss");
  byId("parAccept").addEventListener("click", () => finish("agree"));
  byId("parReject").addEventListener("click", () => finish("override"));
  byId("parDismiss").addEventListener("click", () => finish("dismiss"));
}
let _etaClose = null;
function openEtaProposal(i, mins, reason, opts, onApply) {
  opts = opts || {}; let settled = false;
  const finish = async (decision) => {
    if (settled) return; settled = true; _etaClose = null;
    const inp = byId("etaMinsIn");
    const final = inp && +inp.value > 0 ? +inp.value : mins;
    closePopup(); // hide the proposal first; askWhy floats its own overlay above
    if (decision === "dismiss") { if (opts.onDone) opts.onDone("dismiss"); return; } // closed without a choice - no log, no apply (matches enhance dismiss)
    const dec = decision === "reject" ? "reject" : (final === mins ? "accept" : "edit");
    let why = null;
    if (dec === "reject") why = await askWhy(`not ~${mins}m for "${i.title}"? (helps Himmah learn how long things take)`);
    else if (dec === "edit") why = await askWhy(`set ~${final}m instead of ~${mins}m for "${i.title}"`);
    logOutcome({ call_id: opts.callId || null, item_id: i.id, kind: "eta", decision: dec,
      ai_proposed: { minutes: mins, reason }, my_final: dec === "reject" ? null : { minutes: final }, my_reason: why, original_input: i.title });
    if (dec !== "reject") onApply(final);
    if (opts.onDone) opts.onDone(dec, final); // v6.6.15: lets the Apply-all walkthrough await this step
  };
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card eta-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">✦ time estimate</span><button class="ghost-btn" id="etaDismiss">✕</button></div>
    <div class="eta-prop"><span class="eta-mins">~<input type="number" id="etaMinsIn" min="0" step="5" value="${mins}"> min</span></div>
    ${reason ? `<div class="eta-why">${esc(reason)}</div>` : ""}
    <div class="hist-note">edit the number if it is off, then accept - Himmah learns from your correction</div>
    <div class="drawer-actions"><button class="glow-btn" id="etaAccept">✓ Use this</button><button class="ghost-btn" id="etaReject">✗ No</button></div>
  </div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  _etaClose = () => finish("dismiss"); // closePopup (✕/Esc/scrim) settles the proposal as a dismiss
  byId("etaAccept").addEventListener("click", () => finish("accept"));
  byId("etaReject").addEventListener("click", () => finish("reject"));
  byId("etaDismiss").addEventListener("click", () => finish("dismiss"));
}
// v6.6.14: the inbox/full-screen ETA proposal lives in the row (etaSuggest). Accept (uses the edited number)
// applies estimateMins; Reject asks why. Both are archived; the chip clears either way.
function etaResolve(id, apply) {
  const i = item(id), s = i && i.etaSuggest; if (!s) return;
  const callId = s.callId || null, proposed = s.minutes;
  const before = { estimateMins: i.estimateMins };
  let decision, finalMins;
  if (apply) {
    const inp = byId("eta-sg-" + id);
    finalMins = inp && +inp.value > 0 ? +inp.value : proposed;
    decision = finalMins === proposed ? "accept" : "edit";
    i.estimateMins = finalMins;
  } else { decision = "reject"; finalMins = i.estimateMins; }
  delete i.etaSuggest;
  logAi(i.id, before, { estimateMins: i.estimateMins, via: "eta", decision });
  const emit = (reason) => logOutcome({ call_id: callId, item_id: id, kind: "eta",
    decision, ai_proposed: { minutes: proposed, reason: s.reason }, my_final: decision === "reject" ? null : { minutes: finalMins }, my_reason: reason, original_input: i.title });
  touch(i); scheduleSave(); render(); refreshInboxCount();
  if (decision === "accept") emit(null);
  else askWhy(decision === "reject" ? `not ~${proposed}m for "${i.title}"? (helps Himmah learn timing)` : `set ~${finalMins}m instead of ~${proposed}m for "${i.title}"`).then(emit);
}
// ---------- v6.6.15: per-card "✦ Apply all" orchestrator ----------
// One button walks a SINGLE inbox task through the AI pipeline in fixed order, pausing for approval at
// each step (each step is its own popup): enhance -> enrich -> eta -> triage(category+urgency+title) ->
// calendar (only when the task reads as today/tomorrow - usually skipped). Every step reuses the existing
// approval + logging so there is one source of truth; the orchestrator only sequences and shows progress.
let _applyAllActive = false; // one walkthrough at a time (the button no-ops while one is running)
// the calendar step is intentionally conservative - never spend an AI call to decide whether to schedule.
function looksTimeSensitive(i) {
  if (i.urgency && i.urgency.due) { // already has a due date within ~2 days
    const d = new Date(i.urgency.due + "T00:00:00"), now = new Date();
    const days = Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
    if (days >= 0 && days <= 2) return true;
  }
  return /\b(today|tonight|tomorrow|this morning|this afternoon|this evening|asap|in an hour|by (noon|tonight|tomorrow|eod))\b/i.test(i.title || "");
}
async function applyAiAll(id) {
  const i = item(id); if (!i) return;
  if (_applyAllActive) { toast("✦ already walking a task through - finish that first"); return; }
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  _applyAllActive = true;
  try {
    await stepEnhance(i); if (!item(id)) return;          // re-fetch each step - the item could graduate/delete mid-flow
    await stepEnrich(i); if (!item(id)) return;
    await stepEta(i); if (!item(id)) return;
    await stepTriage(i);                                  // may finalise + graduate the task out of the inbox (item still exists)
    const j = item(id); if (!j) return;
    if (looksTimeSensitive(j)) await stepSchedule(j);     // rare - only today/tomorrow tasks
    toast("✦ done - " + esc((j.title || "").slice(0, 40)));
  } finally {
    _applyAllActive = false;
    render(); refreshInboxCount();
  }
}
// enhance + enrich share one body (preview popup, await the decision, advance on any outcome).
function _inboxRewriteStep(i, kind, label) {
  return new Promise(async (resolve) => {
    if (!aiStatus.enabled) return resolve();
    toast(label);
    let res;
    try { res = await aiFetch(kind, { text: i.title }); } catch (e) { toast("⚠ " + e.message); return resolve(); }
    const field = kind === "enrich" ? "enriched" : "enhanced";
    if (!res || res.changed === false || !res[field] || res[field] === i.title) { return resolve(); } // nothing to change - advance silently
    const callId = lastCallId();
    const note = kind === "enrich" ? (res.context_used ? "✦ used your context: " + res.context_used : "") : (res.guard || "");
    const ctx = { callId, itemId: i.id, kind };
    if (kind === "enrich") ctx.extra = { original_input: i.title, context_used: res.context_used || "" };
    openEnhancePreview(i.title, res[field], note, ctx, (r) => {
      if (r.decision === "accept" || r.decision === "edit") {
        const before = { title: i.title };
        i.title = r.finalText; logAi(i.id, before, { title: r.finalText, via: kind });
        touch(i); scheduleSave(); render();
      }
      resolve(); // accept / edit / reject / dismiss all advance the walkthrough
    });
  });
}
function stepEnhance(i) { return _inboxRewriteStep(i, "enhance", "✦ 1/5 sharpening the wording…"); }
function stepEnrich(i) { return _inboxRewriteStep(i, "enrich", "✦ 2/5 enriching with your context…"); }
function stepEta(i) {
  return new Promise(async (resolve) => {
    if (!aiStatus.enabled) return resolve();
    toast("✦ 3/5 estimating how long this takes…");
    let res; const c = cat(i.categoryId);
    try { res = await aiFetch("eta", { title: i.title, notes: i.notes || "", category: (c && c.name) || "" }); } catch (e) { toast("⚠ " + e.message); return resolve(); }
    const mins = res && +res.minutes; if (!mins) return resolve();
    const callId = lastCallId();
    openEtaProposal(i, mins, res.reason || "", { callId, onDone: () => resolve() }, (finalMins) => {
      const before = { estimateMins: i.estimateMins };
      i.estimateMins = finalMins; logAi(i.id, before, { estimateMins: finalMins, via: "eta" });
      touch(i); scheduleSave(); render();
    });
  });
}
function stepTriage(i) {
  return new Promise(async (resolve) => {
    if (!aiStatus.enabled) return resolve();
    toast("✦ 4/5 categorising + setting urgency…");
    let res;
    try { res = await aiFetch("triage", { items: [{ id: i.id, title: i.title }], categories: state.categories.map((c) => c.name) }); }
    catch (e) { toast("⚠ " + e.message); return resolve(); }
    const r0 = ((res && res.results) || [])[0]; if (!r0) return resolve();
    const callId = lastCallId();
    const c = state.categories.find((c) => c.name.toLowerCase() === String(r0.category || "").toLowerCase());
    i.suggest = { categoryId: c ? c.id : null, importance: Math.max(0, Math.min(3, r0.importance == null ? 1 : +r0.importance)),
      cleaned: r0.title && r0.title !== i.title ? r0.title : null, src: "ai", callId };
    openTriagePreview(i, () => resolve());
  });
}
function stepSchedule(i) {
  return new Promise(async (resolve) => {
    if (!aiStatus.enabled) return resolve();
    toast("✦ 5/5 this looks time-sensitive - finding a slot…");
    await scheduleSuggest(i.id);
    openSchedPreview(i, () => resolve());
  });
}
// triage approval popup for the walkthrough. Popup-scoped ids (tw-*) avoid colliding with the inbox row's tri-* ids.
let _triClose = null;
function openTriagePreview(i, onDone) {
  const s = i.suggest; if (!s) { if (onDone) onDone(); return; }
  let settled = false;
  const imp = s.importance == null ? 1 : s.importance;
  const catOpts = `<option value="">- none -</option>` +
    state.categories.map((c) => `<option value="${c.id}" ${s.categoryId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const urgOpts = [3, 2, 1, 0].map((n) => `<option value="${n}" ${imp === n ? "selected" : ""}>${IMP[n].label}</option>`).join("");
  const finish = (apply) => {
    if (settled) return; settled = true; _triClose = null;
    const csel = byId("tw-cat-" + i.id), usel = byId("tw-urg-" + i.id), tchk = byId("tw-title-" + i.id);
    const before = { categoryId: i.categoryId, importance: i.importance, title: i.title };
    const propCat = (cat(s.categoryId) || {}).name || "(none)", propImp = IMP[imp].label;
    if (apply) {
      const finalCat = csel ? (csel.value || null) : (s.categoryId || null);
      const finalImp = usel ? +usel.value : imp;
      const useTitle = !!(tchk && tchk.checked && s.cleaned);
      i.categoryId = finalCat; i.importance = finalImp; if (useTitle) i.title = s.cleaned;
      const finalCatName = (cat(finalCat) || {}).name || "(none)";
      logAi(i.id, before, { categoryId: finalCat, importance: finalImp, title: i.title, via: "triage" });
      logOutcome({ call_id: s.callId || null, item_id: i.id, kind: "triage_category", decision: finalCat === (s.categoryId || null) ? "accept" : (finalCat ? "edit" : "reject"), ai_proposed: propCat, my_final: finalCat ? finalCatName : null, my_reason: null });
      logOutcome({ call_id: s.callId || null, item_id: i.id, kind: "triage_urgency", decision: finalImp === imp ? "accept" : "edit", ai_proposed: propImp, my_final: IMP[finalImp].label, my_reason: null });
      if (s.cleaned) logOutcome({ call_id: s.callId || null, item_id: i.id, kind: "triage_title", decision: useTitle ? "accept" : "reject", ai_proposed: s.cleaned, my_final: i.title, my_reason: null });
    } else {
      logOutcome({ call_id: s.callId || null, item_id: i.id, kind: "triage_category", decision: "reject", ai_proposed: propCat, my_final: null, my_reason: null });
      logOutcome({ call_id: s.callId || null, item_id: i.id, kind: "triage_urgency", decision: "reject", ai_proposed: propImp, my_final: IMP[i.importance].label, my_reason: null });
    }
    delete i.suggest;
    i.status = i.categoryId ? "active" : "inbox"; // graduates iff it ended up with a category
    normalizeOrders(); touch(i); scheduleSave(); render(); refreshInboxCount();
    closePopup();
    if (onDone) onDone();
  };
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card tw-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--blue)">✦ categorise + urgency <small>(4/5)</small></span><button class="ghost-btn" id="twDismiss">✕</button></div>
    <div class="tw-for">${esc(i.title)}</div>
    <div class="tw-row"><span class="tw-axis">category</span><select class="sx-sel" id="tw-cat-${i.id}">${catOpts}</select></div>
    <div class="tw-row"><span class="tw-axis">urgency</span><select class="sx-sel" id="tw-urg-${i.id}">${urgOpts}</select></div>
    ${s.cleaned ? `<label class="tw-title-row"><input type="checkbox" id="tw-title-${i.id}"> use cleaned title: <span class="sx-cleaned">"${esc(s.cleaned)}"</span></label>` : ""}
    <div class="hist-note">tweak the dropdowns if needed, then apply - or skip to leave this untriaged</div>
    <div class="drawer-actions"><button class="glow-btn" id="twApply">✓ Apply</button><button class="ghost-btn" id="twSkip">✗ Skip</button></div>
  </div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  _triClose = () => finish(false); // dismiss = skip (keeps the walkthrough moving)
  byId("twApply").addEventListener("click", () => finish(true));
  byId("twSkip").addEventListener("click", () => finish(false));
  byId("twDismiss").addEventListener("click", () => finish(false));
}
// calendar approval popup for the walkthrough (self-contained so it works even after triage graduated the task).
let _schClose = null;
function openSchedPreview(i, onDone) {
  const s = i.schedSuggest; if (!s) { if (onDone) onDone(); return; }
  let settled = false;
  const finish = (accept) => {
    if (settled) return; settled = true; _schClose = null;
    closePopup();
    if (accept) { acceptSchedule(i.id); if (onDone) onDone(); return; }
    logOutcome({ call_id: s.callId || null, item_id: i.id, kind: "schedule", decision: "reject", ai_proposed: { date: s.date, start: s.start, end: s.end, eta: s.eta }, my_final: null, my_reason: null, original_input: i.title });
    delete i.schedSuggest; touch(i); scheduleSave(); render(); refreshInboxCount();
    if (onDone) onDone();
  };
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card eta-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">✦ a calendar slot <small>(5/5)</small></span><button class="ghost-btn" id="schDismiss">✕</button></div>
    <div class="tw-for">${esc(i.title)}</div>
    <div class="sched-when" style="margin:6px 0">📅 ${esc(s.date)} · ${esc(s.start)} to ${esc(s.end)}${s.eta ? " · ~" + s.eta + "m" : ""}</div>
    ${s.reason ? `<div class="eta-why">${esc(s.reason)}</div>` : ""}
    <div class="hist-note">only offered when a task reads as today/tomorrow - skip if it can wait</div>
    <div class="drawer-actions"><button class="glow-btn" id="schAccept">✓ Add to calendar</button><button class="ghost-btn" id="schSkip">✗ Skip</button></div>
  </div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  _schClose = () => finish(false);
  byId("schAccept").addEventListener("click", () => finish(true));
  byId("schSkip").addEventListener("click", () => finish(false));
  byId("schDismiss").addEventListener("click", () => finish(false));
}
// v6.6.2: render the digest's light markdown (**bold**, - bullets, blank lines) instead of showing raw ** **.
function mdLite(s) {
  let t = esc(s);
  t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|\n)\s*[-*]\s+/g, "$1• ");
  t = t.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  return t;
}
async function aiDigest() {
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ AI is off - see Setup Guides"); return; }
  // TODO(v6 calendar): capture a "why" on the weekly review once the calendar lands (digest hook deferred per v5.3 brief)
  const today = _todayStr(), day7 = isoDay(new Date(Date.now() - 7 * 864e5)), day14 = isoDay(new Date(Date.now() - 14 * 864e5));
  const tasks = state.items.filter((i) => i.type !== "rhythm");
  const data = {
    doneThisWeek: tasks.filter((i) => i.status === "done" && (i.completedAt || "") >= day7).map((i) => i.title).slice(0, 30),
    overdue: tasks.filter((i) => i.status === "active" && i.urgency && i.urgency.due && i.urgency.due < today)
      .map((i) => ({ title: i.title, due: i.urgency.due, importance: IMP[i.importance].label })).slice(0, 15),
    importantGoingStale: tasks.filter((i) => i.status === "active" && i.importance >= 2 && !(i.urgency && i.urgency.due) && (i.updatedAt || "") < day14)
      .map((i) => ({ title: i.title, importance: IMP[i.importance].label, lastTouched: (i.updatedAt || "").slice(0, 10) })).slice(0, 15),
    inboxWaiting: state.items.filter((i) => i.status === "inbox").length,
    habits: state.items.filter((i) => i.type === "rhythm" && !i.queued)
      .map((r) => ({ title: r.title, streak: (r.streak || 0) + streakUnit(r), frequency: freqLabel(r) })),
  };
  toast("✦ writing your weekly review…");
  let res;
  try { res = await aiFetch("digest", { data }); }
  catch (e) { toast("⚠ " + e.message); return; }
  const text = (res && res.digest) || "";
  if (!text) { toast("✦ no digest returned"); return; }
  state.meta.ui = state.meta.ui || {}; state.meta.ui.lastDigest = { at: nowIso(), text }; scheduleSave();
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card digest-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">✦ weekly review</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="digest-text">${mdLite(text)}</div>
    <div class="hist-note">generated on demand only - never automatic, never guilt-tripping</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}

// ---- the ✦ AI menu (topbar) ----
function openAiMenu() {
  const st = aiStatus;
  const pct = st.cap ? Math.min(100, Math.round((st.spentToday / st.cap) * 100)) : 0;
  const last = state.meta && state.meta.ui && state.meta.ui.lastDigest;
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">✦ AI</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="ai-stat">
      <div class="ai-stat-row"><span class="ai-dot ${st.enabled ? "on" : ""}"></span>
        ${st.enabled ? `on · ${st.mock ? "mock mode (no cost)" : esc(st.model)}` : (st.hasKey ? "paused - daily budget reached, resets at midnight" : "off - no key yet")}</div>
      <div class="prog"><div class="prog-bar" style="width:${pct}%; background:var(--purple); box-shadow:0 0 10px var(--purple)"></div></div>
      <div class="ai-stat-sub">${(st.spentToday * 100).toFixed(2)}¢ of ${(st.cap * 100).toFixed(0)}¢ today · ${st.callsToday || 0} call${st.callsToday === 1 ? "" : "s"} · hard cap, enforced by the server</div>
    </div>
    <div class="pop-list">
      <button class="ghost-btn ai-row" data-act="ai-triage">📥 Triage the inbox now</button>
      <button class="ghost-btn ai-row" data-act="ai-groups">📁 Find project groups in my tasks</button>
      <button class="ghost-btn ai-row" data-act="ai-digest">🗓 Weekly review${last ? ` <small>(last: ${fmtTime(last.at)})</small>` : ""}</button>
      <button class="ghost-btn ai-row" data-act="life-setup">🌙 Make it yours <small>(clear the demo, build your life with AI)</small></button>
      <button class="ghost-btn ai-row" data-act="ai-nuclear">\u2622 Make it yours <small>(clear the demo, build YOUR life with AI - the tour\u2019s Nuclear option)</small></button>
      <button class="ghost-btn ai-row" data-act="start-tour">🧭 Take the guided tour</button>
    </div>
    <div class="hist-note">AI never runs on its own - Enhance, Enrich &amp; Triage are on-demand buttons in the Inbox.</div>
    ${st.hasKey ? "" : `<div class="hist-note">to switch AI on: put your DeepSeek API key in <b>data/deepseek_key.txt</b> and restart Himmah - full steps in <b>Setup Guides</b>. Everything works without it.</div>`}
  </div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  refreshAiStatus();
}
function logAi(itemId, before, after) {
  state.meta = state.meta || {}; state.meta.aiLog = state.meta.aiLog || [];
  state.meta.aiLog.push({ at: nowIso(), itemId, before, after });
  if (state.meta.aiLog.length > 200) state.meta.aiLog = state.meta.aiLog.slice(-200);
}
// ---- per-axis triage resolution (CHANGE 1) ----
// category, urgency, and cleaned-title are resolved independently. An item stays in the inbox
// (showing only its unresolved axes) until ALL present axes are dealt with; then it is finalised
// (leaves the inbox iff it ended up with a category). Each decision is logged to ai_actions.jsonl.
function triageFinalizeIfDone(i) {
  const s = i.suggest; if (!s) return;
  const titlePending = s.cleaned && s.cleaned !== i.title && !s.titleDone;
  if (s.catDone && s.urgDone && !titlePending) {
    delete i.suggest;
    i.status = i.categoryId ? "active" : "inbox"; // category set → graduates to the board
    normalizeOrders();
  }
}
function afterAxis(i) { triageFinalizeIfDone(i); touch(i); scheduleSave(); render(); refreshInboxCount(); }

function triageResolveCat(id, apply) {
  const i = item(id), s = i && i.suggest; if (!s) return;
  const callId = s.callId || null;
  const proposed = s.categoryId || null;
  const proposedName = (cat(proposed) || {}).name || "(none)";
  const before = { categoryId: i.categoryId };
  let decision, finalId, finalName;
  if (apply) {
    const sel = byId("tri-cat-" + id);
    finalId = sel ? (sel.value || null) : proposed;
    finalName = (cat(finalId) || {}).name || "(none)";
    decision = finalId === proposed ? "accept" : (finalId ? "edit" : "reject");
    i.categoryId = finalId; // accept/edit set it; "reject via none" also clears to null
  } else { decision = "reject"; finalId = null; finalName = "(none)"; } // ✗ leaves it uncategorised
  s.catDone = true;
  logAi(i.id, before, { categoryId: i.categoryId, via: "triage_category", decision });
  const emit = (reason) => logOutcome({ call_id: callId, item_id: id, kind: "triage_category",
    decision, ai_proposed: proposedName, my_final: decision === "reject" ? null : finalName, my_reason: reason });
  if (decision === "accept") { emit(null); afterAxis(i); }
  else { afterAxis(i); askWhy(`category - AI: “${proposedName}” · you: “${decision === "reject" ? "(none)" : finalName}”`).then(emit); }
}
function triageResolveUrg(id, apply) {
  const i = item(id), s = i && i.suggest; if (!s) return;
  const callId = s.callId || null;
  const proposed = s.importance == null ? 1 : s.importance;
  const proposedName = IMP[proposed].label;
  const before = { importance: i.importance };
  let decision, finalImp;
  if (apply) {
    const sel = byId("tri-urg-" + id);
    finalImp = sel ? +sel.value : proposed;
    decision = finalImp === proposed ? "accept" : "edit";
    i.importance = finalImp;
  } else { decision = "reject"; finalImp = i.importance; } // keep whatever it already had
  s.urgDone = true;
  const finalName = IMP[finalImp] ? IMP[finalImp].label : String(finalImp);
  logAi(i.id, before, { importance: i.importance, via: "triage_urgency", decision });
  const emit = (reason) => logOutcome({ call_id: callId, item_id: id, kind: "triage_urgency",
    decision, ai_proposed: proposedName, my_final: finalName, my_reason: reason });
  if (decision === "accept") { emit(null); afterAxis(i); }
  else { afterAxis(i); askWhy(`urgency - AI: “${proposedName}” · you: “${finalName}”`).then(emit); }
}
function triageResolveTitle(id, apply) {
  const i = item(id), s = i && i.suggest; if (!s) return;
  const callId = s.callId || null;
  const proposed = s.cleaned || "";
  const decision = apply ? "accept" : "reject";
  const before = { title: i.title };
  if (apply) i.title = proposed;
  s.titleDone = true;
  logAi(i.id, before, { title: i.title, via: "triage_title", decision });
  logOutcome({ call_id: callId, item_id: id, kind: "triage_title", decision, ai_proposed: proposed, my_final: i.title, my_reason: null });
  afterAxis(i); // cleaned-title is low-stakes for the taste model → no Why? prompt
}
function triageAcceptAll(id) { // convenience fast-path: accept every remaining axis as proposed
  const i = item(id), s = i && i.suggest; if (!s) return;
  const callId = s.callId || null;
  if (!s.catDone) {
    const nm = (cat(s.categoryId) || {}).name || "(none)";
    if (s.categoryId) i.categoryId = s.categoryId; s.catDone = true;
    logOutcome({ call_id: callId, item_id: id, kind: "triage_category", decision: "accept", ai_proposed: nm, my_final: nm, my_reason: null });
  }
  if (!s.urgDone) {
    const imp = s.importance == null ? 1 : s.importance;
    i.importance = imp; s.urgDone = true;
    logOutcome({ call_id: callId, item_id: id, kind: "triage_urgency", decision: "accept", ai_proposed: IMP[imp].label, my_final: IMP[imp].label, my_reason: null });
  }
  if (s.cleaned && s.cleaned !== i.title && !s.titleDone) {
    const prop = s.cleaned; i.title = prop; s.titleDone = true;
    logOutcome({ call_id: callId, item_id: id, kind: "triage_title", decision: "accept", ai_proposed: prop, my_final: prop, my_reason: null });
  }
  logAi(i.id, { via: "triage_all" }, { categoryId: i.categoryId, importance: i.importance, title: i.title });
  afterAxis(i);
}

function renderRecent() {
  const el = byId("recent");
  const done = state.items.filter((i) => i.status === "done" && isToday(i.completedAt));
  if (!done.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="recent-head"><span class="kicker">✓ done today</span><span class="count">${done.length}</span></div>
    <div class="recent-cards">${done.map((i) => `
      <div class="rcard" data-id="${i.id}">
        <span class="rcard-dot"></span>
        <span class="rcard-title">${esc(i.title)}</span>
        <button class="rcard-restore" data-act="restore-item" data-id="${i.id}" title="bring it back">↺</button>
      </div>`).join("")}</div>`;
}

function persistUi() {
  state.meta = state.meta || {}; state.meta.ui = state.meta.ui || {};
  state.meta.ui.viewMode = viewMode; scheduleSave();
}
function renderControls() {
  const el = byId("controls");
  const urg = [3, 2, 1, 0].map((n) =>
    `<button class="fchip urg ${filterUrg.has(n) ? "on" : ""}" data-act="filter-urg" data-n="${n}" style="--imp:${IMP[n].color}">${IMP[n].label}</button>`).join("");
  const cats = [...state.categories].sort((a, b) => a.order - b.order).map((c) =>
    `<button class="fchip cat ${filterCat.has(c.id) ? "on" : ""}" data-act="filter-cat" data-id="${c.id}" style="--c:${c.color}"><i></i>${esc(c.name)}</button>`).join("");
  const anyFilter = filterUrg.size || filterCat.size;
  el.innerHTML = `
    <div class="controls-row">
      <div class="seg">
        <button class="seg-btn ${viewMode === "category" ? "on" : ""}" data-act="view" data-mode="category">By category</button>
        <button class="seg-btn ${viewMode === "urgency" ? "on" : ""}" data-act="view" data-mode="urgency">By urgency</button>
        <button class="seg-btn ${viewMode === "canvas" ? "on" : ""}" data-act="view" data-mode="canvas">Canvas</button>
      </div>
      ${anyFilter ? `<button class="clearf" data-act="clear-filters">clear filters ✕</button>` : ""}
    </div>
    <div class="fchips">
      <span class="fchips-label">urgency</span>${urg}
      <span class="fchips-label">category</span>${cats}
    </div>`;
}

function renderBoard() {
  const el = byId("board");
  if (viewMode === "urgency") return renderByUrgency(el);
  if (viewMode === "canvas") return renderCanvas(el);
  const filtering = filterUrg.size || filterCat.size;
  const cats = [...state.categories].sort((a, b) => a.order - b.order);
  let html = "";
  for (const c of cats) {
    if (filterCat.size && !filterCat.has(c.id)) continue; // category filter hides other lanes
    const items = state.items.filter((i) => i.categoryId === c.id && i.status === "active" && i.type !== "rhythm" && !isNestedUnderMacro(i) && passFilter(i))
      .sort((a, b) => a.order - b.order);
    if (filtering && !items.length) continue;
    const inCat = state.items.filter((i) => i.categoryId === c.id && i.type !== "rhythm");
    const doneInCat = inCat.filter((i) => i.status === "done").length;
    const pct = inCat.length ? Math.round((doneInCat / inCat.length) * 100) : 0;
    const remMins = inCat.filter((i) => i.status === "active").reduce((s, i) => s + (i.estimateMins || 0), 0);
    html += `
    <section class="lane ${c.collapsed ? "collapsed" : ""}" data-cat="${c.id}" style="--cat:${c.color}">
      <div class="lane-head">
        <button class="caret" data-act="collapse-cat" data-id="${c.id}">${c.collapsed ? "▸" : "▾"}</button>
        <span class="dot" style="background:${c.color}"></span>
        <h3 class="lane-name" data-rename="${c.id}">${esc(c.name)}</h3>
        <span class="count">${items.length}</span>
        ${remMins ? `<span class="rem" title="estimated time remaining">~${fmtMins(remMins)}</span>` : ""}
        <div class="lane-tools">
          <button class="mini" data-act="recolor-cat" data-id="${c.id}" title="recolor">◑</button>
          <button class="mini" data-act="rename-cat" data-id="${c.id}" title="rename">✎</button>
          <button class="mini danger" data-act="del-cat" data-id="${c.id}" title="delete">🗑</button>
        </div>
      </div>
      ${inCat.length ? `<div class="lane-prog" title="${doneInCat}/${inCat.length} done"><i style="width:${pct}%; background:${c.color}"></i></div>` : ""}
      ${c.collapsed ? "" : `<div class="lane-cards">${items.map((i) => card(i, { hideCat: true })).join("") || `<div class="empty mini">empty</div>`}</div>`}
    </section>`;
  }
  html += `<button class="add-cat" data-act="add-cat">＋ category</button>`;
  el.innerHTML = html;
}

function renderByUrgency(el) {
  const filtering = filterUrg.size || filterCat.size;
  let html = "";
  for (const n of [3, 2, 1, 0]) {
    if (filterUrg.size && !filterUrg.has(n)) continue;
    const items = state.items.filter((i) => i.status === "active" && i.importance === n && i.type !== "rhythm" && !isNestedUnderMacro(i) && passFilter(i))
      .sort((a, b) => { const ca = cat(a.categoryId), cb = cat(b.categoryId); return (ca ? ca.order : 99) - (cb ? cb.order : 99) || a.order - b.order; });
    if (filtering && !items.length) continue;
    html += `
    <section class="lane urg-lane" data-urg="${n}" style="--cat:${IMP[n].color}">
      <div class="lane-head">
        <span class="dot" style="background:${IMP[n].color}"></span>
        <h3>${IMP[n].label}</h3>
        <span class="count">${items.length}</span>
        <span class="lane-sub">grouped by category - drag a card here to set its urgency</span>
      </div>
      <div class="lane-cards">${items.map((i) => card(i)).join("") || `<div class="empty mini">none</div>`}</div>
    </section>`;
  }
  el.innerHTML = html || `<div class="empty">No tasks match these filters.</div>`;
}

// ---------- the canvas (the only board: zones grouped By category OR By urgency, with nested dropdowns) ----------
let panX = 0, panY = 0, zoom = 1;
let canvasDrag = null;
const toggled = new Set(); // explicit open/closed flips vs the smart defaults
function applyCanvasTransform() {
  const s = document.querySelector(".canvas-surface");
  if (s) s.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
}
function persistCanvas() {
  state.meta = state.meta || {}; state.meta.ui = state.meta.ui || {};
  state.meta.ui.canvas = { panX, panY, zoom };
  state.meta.ui.toggled = [...toggled];
  scheduleSave();
}
function zoneKeys() {
  if (viewMode === "urgency") return [3, 2, 1, 0].map((n) => "urg" + n);
  return [...state.categories].sort((a, b) => a.order - b.order).map((c) => c.id);
}
function autoLayoutCanvas() {
  state.meta.ui = state.meta.ui || {};
  if (!state.meta.ui.v4relayout) { state.meta.ui.zonePos = {}; state.meta.ui.v4relayout = true; } // one-time compact re-layout
  const zp = state.meta.ui.zonePos = state.meta.ui.zonePos || {};
  const cols = 4, zw = 332, rowH = 150;
  zoneKeys().forEach((k, idx) => { if (!zp[k]) zp[k] = { x: 20 + (idx % cols) * (zw + 22), y: 20 + Math.floor(idx / cols) * rowH }; });
  return zp;
}
// smart defaults: categories CLOSED; urgency critical+high open; inside, critical+high groups open, rest closed.
function defaultZoneOpen(key) { return viewMode === "urgency" ? (key === "urg3" || key === "urg2") : false; }
function defaultGroupOpen(gkey) { return gkey === "imp3" || gkey === "imp2"; }
function zoneOpen(key) { return defaultZoneOpen(key) !== toggled.has("Z:" + key); }
function groupOpen(zoneKey, gkey) { return defaultGroupOpen(gkey) !== toggled.has("G:" + zoneKey + "|" + gkey); }
function zgroup(zoneKey, gkey, label, color, items) {
  if (!items.length) return "";
  const open = groupOpen(zoneKey, gkey);
  return `<div class="zgroup ${open ? "" : "col"}">
    <div class="zgroup-head" data-act="toggle-group" data-zk="${zoneKey}" data-gk="${gkey}">
      <span class="zcaret">${open ? "▾" : "▸"}</span><span class="zgroup-dot" style="background:${color}"></span>
      <span class="zgroup-name">${esc(label)}</span><span class="zgroup-count">${items.length}</span>
    </div>
    ${open ? `<div class="zgroup-cards">${items.map((i) => card(i, { hideCat: true })).join("")}</div>` : ""}
  </div>`;
}
function zoneHtml(zoneKey, name, color, pos, groupsHtml, total, isCat) {
  const open = zoneOpen(zoneKey);
  const tools = isCat ? `<span class="zone-tools">
      <button class="mini" data-act="recolor-cat" data-id="${zoneKey}" title="recolor">◑</button>
      <button class="mini" data-act="rename-cat" data-id="${zoneKey}" title="rename">✎</button>
      <button class="mini danger" data-act="del-cat" data-id="${zoneKey}" title="delete">🗑</button>
    </span>` : "";
  return `<div class="zone ${open ? "" : "zcol"}" data-zonekey="${zoneKey}" ${isCat ? `data-cat="${zoneKey}"` : ""} style="left:${pos.x}px; top:${pos.y}px; --cat:${color}; --bar:${color}">
    <div class="zone-header" data-zone="${zoneKey}">
      <button class="ztoggle" data-act="toggle-zone" data-zk="${zoneKey}">${open ? "▾" : "▸"}</button>
      <span class="dot" style="background:${color}"></span>
      <span class="zone-name" ${isCat ? `data-rename="${zoneKey}"` : ""}>${esc(name)}</span>
      <span class="count">${total}</span>${tools}
      <span class="zone-grip" title="drag to move">⠿</span>
    </div>
    ${open ? `<div class="zone-cards">${groupsHtml || `<div class="empty mini">empty</div>`}</div>` : ""}
  </div>`;
}
function renderCanvas() {
  const el = byId("canvasview");
  const zp = autoLayoutCanvas();
  let zones = "";
  if (viewMode === "urgency") {
    for (const n of [3, 2, 1, 0]) {
      const key = "urg" + n;
      const tasks = state.items.filter((i) => i.status === "active" && i.type !== "rhythm" && i.importance === n && !isNestedUnderMacro(i));
      const groups = [...state.categories].sort((a, b) => a.order - b.order)
        .map((c) => zgroup(key, c.id, c.name, c.color, tasks.filter((t) => t.categoryId === c.id).sort((a, b) => a.order - b.order))).join("");
      zones += zoneHtml(key, IMP[n].label, IMP[n].color, zp[key], groups, tasks.length, false);
    }
  } else {
    for (const c of [...state.categories].sort((a, b) => a.order - b.order)) {
      const tasks = state.items.filter((i) => i.categoryId === c.id && i.status === "active" && i.type !== "rhythm" && !isNestedUnderMacro(i));
      const groups = [3, 2, 1, 0].map((n) => zgroup(c.id, "imp" + n, IMP[n].label, IMP[n].color, tasks.filter((t) => t.importance === n).sort((a, b) => a.order - b.order))).join("");
      zones += zoneHtml(c.id, c.name, c.color, zp[c.id], groups, tasks.length, true);
    }
  }
  const cc = (state.meta.ui && state.meta.ui.canvasCal) || {};
  const calOpen = !!cc.open, railDate = cc.date || _isod(new Date());
  const _prevRailScroll = (() => { const w = el.querySelector(".canvas-cal-rail .cal-day-wrap"); return w ? w.scrollTop : null; })(); // v6.6.1: keep scroll across re-renders
  el.innerHTML = `
    <div class="canvas-toolbar">
      <div class="seg">
        <button class="seg-btn ${viewMode === "category" ? "on" : ""}" data-act="view" data-mode="category">By category</button>
        <button class="seg-btn ${viewMode === "urgency" ? "on" : ""}" data-act="view" data-mode="urgency">By urgency</button>
      </div>
      ${viewMode === "category" ? `<button class="ghost-btn add" data-act="add-cat">＋ category</button>` : ""}
      <button class="ghost-btn ${calOpen ? "on" : ""}" data-act="canvas-cal-toggle" title="drag tasks onto a calendar to time-block them">📅 Calendar</button>
      <span class="tb-spacer"></span>
      <button class="mini" data-act="zoom-out">−</button>
      <button class="mini wide" data-act="zoom-reset">${Math.round(zoom * 100)}%</button>
      <button class="mini" data-act="zoom-in">+</button>
      <button class="ghost-btn focus-drop ${dayOvercommitted() ? "over" : ""}" data-act="focus-drop" title="⚖ when next week is too full: protect your top priorities and push the farthest-deadline, lowest-priority tasks to someday">⚖ what to drop?</button>
      <button class="ghost-btn" data-act="urg-colors" title="change the colour of each urgency level">◑ colors</button>
      <button class="ghost-btn" data-act="reset-layout">reset layout</button>
    </div>
    <div class="canvas-main ${calOpen ? "cal-open" : ""}">
      <div class="canvas-wrap">
        <div class="canvas-surface" style="transform:translate(${panX}px,${panY}px) scale(${zoom})">${zones}</div>
      </div>
      ${calOpen ? `<aside class="canvas-cal-rail">${_canvasCalRail(railDate)}</aside>` : ""}
    </div>`;
  if (calOpen) { const g = byId("dayGrid"); if (g) g.parentElement.scrollTop = (_prevRailScroll != null ? _prevRailScroll : 8 * DAY_HOUR_H); } // v6.6.1: keep scroll on re-render, default 08:00 on first open
}
// v6.6: a day-view calendar rail docked in the canvas; drop a task on a slot to time-block it (the task stays on the board).
function _canvasCalRail(ds) {
  const d = new Date(ds + "T00:00:00");
  return `<div class="ccal-head">
      <button class="ghost-btn sm" data-act="ccal-prev" title="previous day">‹</button>
      <span class="ccal-title">${CAL_FULLDOW[d.getDay()]} ${d.getDate()} ${CAL_MONTHS[d.getMonth()].slice(0, 3)}</span>
      <button class="ghost-btn sm" data-act="ccal-next" title="next day">›</button>
      <button class="ghost-btn sm" data-act="ccal-today" title="today">today</button>
    </div>
    <div class="ccal-hint">drag a task here to time-block it (it stays on the board)</div>
    <div class="calz-combo ccal-combo">
      <button class="calz-trigger calz-main ccal-calz" data-act="cal-calendarize" title="✦ AI lays out tomorrow's tasks for you">✦ Calendarize tomorrow</button>
      <span class="calz-combo-sep" aria-hidden="true"></span>
      <button class="calz-quiz-btn" data-act="cal-prefs-quiz" title="✦ Tune how Himmah calendarizes - a quick preferences quiz (~5 min)">⚙</button>
    </div>
    <div class="cal-day-wrap ccal-grid">${_dayBody(d)}</div>`;
}
function _canvasCalShift(days) {
  state.meta.ui = state.meta.ui || {}; const cc = state.meta.ui.canvasCal = state.meta.ui.canvasCal || { open: true };
  const base = days === 0 ? new Date() : new Date((cc.date || _isod(new Date())) + "T00:00:00");
  if (days !== 0) base.setDate(base.getDate() + days);
  cc.date = _isod(base); scheduleSave(); render();
}
// v6.6.2: confirm a canvas-dropped time-block (start at the drop time, end = start + the task ETA, both editable).
function confirmCanvasBlock(i, ds, startMin) {
  if (_calzProposal && _calzProposal.schId) _calzCleanup(); _calzProposal = null; // not a calz review - clear any stray preview + don't let closePopup log spurious rejects
  const dur = Math.max(15, i.estimateMins || 30), d = new Date(ds + "T00:00:00");
  const start = _minToHM(startMin), end = _minToHM(Math.min(24 * 60, startMin + dur));
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card ccb-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:#f5c46f">📅 schedule this task?</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="ccb-task">${esc(i.title)}</div>
    <div class="hist-note">${CAL_FULLDOW[d.getDay()]} ${d.getDate()} ${CAL_MONTHS[d.getMonth()].slice(0, 3)} - it stays on your board; this just blocks the time.</div>
    <div class="fld-row">
      <label class="fld"><span>Start</span><input type="time" id="ccb-start" value="${start}"></label>
      <label class="fld"><span>End <small>(= start + ${dur}m ETA)</small></span><input type="time" id="ccb-end" value="${end}"></label>
    </div>
    <div class="drawer-actions"><button class="glow-btn" id="ccb-go">Schedule it</button><button class="ghost-btn" data-act="close-popup">Cancel</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  let endTouched = false;
  byId("ccb-end").addEventListener("input", () => (endTouched = true));
  byId("ccb-start").addEventListener("input", () => { if (!endTouched) byId("ccb-end").value = _minToHM(Math.min(24 * 60, _hmToMin(byId("ccb-start").value) + dur)); });
  byId("ccb-go").addEventListener("click", () => {
    const s = byId("ccb-start").value, en = byId("ccb-end").value;
    if (!s || !en || _hmToMin(en) <= _hmToMin(s)) { toast("set a valid start and end"); return; }
    const sch = taskSchedule(); // v6.7.1: stable id, not name-matched
    state.events = state.events || [];
    state.events.push({ id: uid("ev"), scheduleId: sch.id, title: i.title, date: ds, start: s, end: en, allDay: false, notes: "time-blocked from the canvas", taskId: i.id });
    if (i.status === "inbox") i.status = "active"; touch(i); // surface on the board, never mark done
    closePopup(); scheduleSave(); render();
    toast("📅 blocked " + (i.title.length > 28 ? i.title.slice(0, 28) + "…" : i.title) + " at " + s);
  });
}
// ===== v6.6.2: themed date picker - replaces the OS-native type=date popup so it matches the design.
// Renders a hidden input (so existing byId(id).value reads keep working) + a themed trigger + an inline month grid.
const _TD_DOW = ["S", "M", "T", "W", "T", "F", "S"];
function tdateField(id, iso, opts) {
  opts = opts || {}; const v = iso || "";
  return `<span class="tdate" data-tdate>
    <button type="button" class="tdate-btn" data-tdate-btn aria-haspopup="true"><span class="tdate-ico">📅</span><span class="tdate-lbl">${esc(_tdLabel(v, opts.placeholder))}</span></button>
    ${opts.clearable ? `<button type="button" class="tdate-clear" data-tdate-clear title="clear the date">✕</button>` : ""}
    <input type="hidden" id="${id}" value="${esc(v)}" data-ph="${esc(opts.placeholder || "")}">
    <span class="tdate-pop" data-tdate-pop hidden></span></span>`;
}
function _tdLabel(iso, ph) {
  if (!iso) return ph || "pick a date";
  const d = new Date(iso + "T00:00:00"); if (isNaN(d.getTime())) return ph || "pick a date";
  return `${CAL_FULLDOW[d.getDay()].slice(0, 3)} ${d.getDate()} ${CAL_MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}
function _tdRenderPop(wrap, viewISO) {
  const pop = wrap.querySelector("[data-tdate-pop]"), cur = wrap.querySelector("input").value;
  const view = new Date((viewISO || cur || _isod(new Date())) + "T00:00:00");
  const y = view.getFullYear(), m = view.getMonth();
  const start = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate(), today = _isod(new Date());
  let cells = "";
  for (let i = 0; i < start; i++) cells += `<span class="tdate-day empty"></span>`;
  for (let dd = 1; dd <= days; dd++) {
    const di = _isod(new Date(y, m, dd)), cls = ["tdate-day"];
    if (di === cur) cls.push("sel"); if (di === today) cls.push("today");
    cells += `<button type="button" class="${cls.join(" ")}" data-tdate-day="${di}">${dd}</button>`;
  }
  pop.innerHTML = `<div class="tdate-head">
      <button type="button" class="tdate-nav" data-tdate-nav="-1" title="previous month">‹</button>
      <span class="tdate-mon">${CAL_MONTHS[m]} ${y}</span>
      <button type="button" class="tdate-nav" data-tdate-nav="1" title="next month">›</button></div>
    <div class="tdate-dow">${_TD_DOW.map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="tdate-grid">${cells}</div>
    <div class="tdate-foot"><button type="button" class="tdate-mini" data-tdate-day="${today}">Today</button></div>`;
  pop.dataset.view = _isod(new Date(y, m, 1)); // anchor nav on the 1st to avoid month-overflow drift
}
function _tdClose() { document.querySelectorAll("[data-tdate-pop]:not([hidden])").forEach((p) => { p.hidden = true; const w = p.closest("[data-tdate]"); if (w) w.classList.remove("open"); }); }
function _tdFire(inp) { inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); }
document.addEventListener("click", (e) => {
  const clr = e.target.closest("[data-tdate-clear]");
  if (clr) { const w = clr.closest("[data-tdate]"), inp = w.querySelector("input"); inp.value = ""; w.querySelector(".tdate-lbl").textContent = _tdLabel("", inp.dataset.ph); _tdClose(); _tdFire(inp); return; }
  const btn = e.target.closest("[data-tdate-btn]");
  if (btn) { const w = btn.closest("[data-tdate]"), pop = w.querySelector("[data-tdate-pop]"), wasOpen = !pop.hidden; _tdClose(); if (!wasOpen) { _tdRenderPop(w); pop.hidden = false; w.classList.add("open"); } return; }
  const nav = e.target.closest("[data-tdate-nav]");
  if (nav) { const w = nav.closest("[data-tdate]"), pop = w.querySelector("[data-tdate-pop]"), v = new Date(pop.dataset.view + "T00:00:00"); v.setMonth(v.getMonth() + +nav.dataset.tdateNav); _tdRenderPop(w, _isod(v)); return; }
  const day = e.target.closest("[data-tdate-day]");
  if (day && day.dataset.tdateDay) { const w = day.closest("[data-tdate]"), inp = w.querySelector("input"); inp.value = day.dataset.tdateDay; w.querySelector(".tdate-lbl").textContent = _tdLabel(inp.value, inp.dataset.ph); _tdClose(); _tdFire(inp); return; }
  if (!e.target.closest("[data-tdate]")) _tdClose(); // click outside closes any open picker
});
// pan + zone-move via pointer events (HTML5 drag still handles cards)
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return; // v6.5.13: only LEFT-button starts a canvas pan / zone drag
  if (e.target.isContentEditable) return; // v6.7.1: a pointerdown inside the contenteditable zone-name (during rename) must not hijack into a zone-drag - let text select normally
  if (!e.target.closest(".canvas-wrap")) return;
  const header = e.target.closest(".zone-header");
  if (header && !e.target.closest("[data-act]")) {
    const k = header.dataset.zone; const zp = (state.meta.ui && state.meta.ui.zonePos) || {}; const p = zp[k]; if (!p) return;
    canvasDrag = { type: "zone", key: k, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y };
  } else if (!e.target.closest(".zone") && !e.target.closest(".card")) {
    canvasDrag = { type: "pan", sx: e.clientX, sy: e.clientY, opx: panX, opy: panY };
  }
});
window.addEventListener("pointermove", (e) => {
  if (!canvasDrag) return;
  const dx = e.clientX - canvasDrag.sx, dy = e.clientY - canvasDrag.sy;
  if (canvasDrag.type === "pan") { document.body.classList.add("canvas-panning"); panX = canvasDrag.opx + dx; panY = canvasDrag.opy + dy; applyCanvasTransform(); } // v6.5.5: grabbing cursor
  else if (canvasDrag.type === "zone") {
    const p = state.meta.ui.zonePos[canvasDrag.key]; if (!p) return;
    p.x = canvasDrag.ox + dx / zoom; p.y = canvasDrag.oy + dy / zoom;
    const z = document.querySelector(`.zone[data-zonekey="${canvasDrag.key}"]`); if (z) { z.style.left = p.x + "px"; z.style.top = p.y + "px"; }
  }
});
window.addEventListener("pointerup", () => { if (!canvasDrag) return; canvasDrag = null; document.body.classList.remove("canvas-panning"); persistCanvas(); });
// v6.4.14: a touchpad PINCH and a Ctrl+wheel both arrive as a wheel event with e.ctrlKey set, so we
// zoom on e.ctrlKey directly (plain two-finger scroll has no ctrlKey and pans). (v6.4.15: removed the
// old physical-Ctrl tracking - it was dead code once pinch-zoom was enabled.)
document.addEventListener("wheel", (e) => {
  if (!e.target.closest(".canvas-wrap")) { if (e.ctrlKey) e.preventDefault(); return; } // kill browser pinch-zoom elsewhere
  if (e.ctrlKey) {                                  // v6.4.14: touchpad PINCH (sends ctrlKey) OR Ctrl+wheel = zoom the canvas
    e.preventDefault();
    zoom = Math.min(1.8, Math.max(0.3, zoom * Math.exp(-e.deltaY * 0.0015))); // proportional = smooth for pinch + wheel
    applyCanvasTransform();
    const lbl = document.querySelector('[data-act="zoom-reset"]'); if (lbl) lbl.textContent = Math.round(zoom * 100) + "%";
    persistCanvas();
    return;
  }
  // v6.5.5: plain 2-finger / wheel scroll NO LONGER pans (panning is left-drag only). Do not preventDefault -
  // a .zone-cards list scrolls natively; the bare canvas has no native scroll so it simply stays put.
}, { passive: false });

// v6.6.3: a 2-finger horizontal touchpad swipe over the calendar grid pages prev/next period
// (month/week/day), reusing calShift(). Debounced so one gesture = one step; never fights vertical
// scroll (acts only when |deltaX| clearly dominates |deltaY|).
let _calWheelLock = 0, _calWheelAcc = 0;
document.addEventListener("wheel", (e) => {
  const view = document.getElementById("calendarview");
  if (!view || view.hidden) return;                 // calendar drawer closed
  if (!e.target.closest("#calendarview")) return;    // wheel not over the calendar
  if (e.ctrlKey) return;                              // pinch/zoom - leave to the canvas handler
  const ax = Math.abs(e.deltaX), ay = Math.abs(e.deltaY);
  if (ax <= ay * 1.3 || ax < 12) { _calWheelAcc = 0; return; } // vertical or tiny -> let it scroll natively
  e.preventDefault();                                // we own this horizontal gesture (also stops browser back/forward swipe)
  const now = Date.now();
  if (now < _calWheelLock) return;                   // still inside the cooldown of the last page-turn
  _calWheelAcc += e.deltaX;
  if (Math.abs(_calWheelAcc) < 60) return;           // require a deliberate swipe, not a nudge
  calShift(_calWheelAcc > 0 ? 1 : -1);               // +deltaX = swipe content left = go NEXT period
  _calWheelAcc = 0;
  _calWheelLock = now + 520;                          // ~0.5s cooldown -> momentum tail can't double-fire
}, { passive: false });

// ---------- v6.5.6: Ctrl/Cmd+K glowing-bubble search (pure client, no AI) ----------
let _searchSel = 0, _searchHits = [];
function searchOpen() {
  const ov = byId("searchOverlay"); if (!ov || !ov.hidden) return;
  ov.hidden = false; ov.setAttribute("aria-hidden", "false");
  const inp = byId("searchInput"); inp.value = ""; _searchHits = []; _searchSel = 0;
  renderSearch(""); requestAnimationFrame(() => inp.focus());
}
function searchClose() { const ov = byId("searchOverlay"); if (!ov || ov.hidden) return; ov.hidden = true; ov.setAttribute("aria-hidden", "true"); _searchHits = []; _searchSel = 0; }
function searchMatches(q) {
  q = q.trim().toLowerCase(); if (!q) return [];
  return state.items.map((i) => {
    const c = cat(i.categoryId);
    const hay = (i.title + " " + (i.notes || "") + " " + ((c && c.name) || "")).toLowerCase();
    return hay.includes(q) ? i : null;
  }).filter(Boolean).sort((a, b) => b.importance - a.importance || a.title.localeCompare(b.title)).slice(0, 8);
}
function renderSearch(q) {
  _searchHits = searchMatches(q);
  if (_searchSel >= _searchHits.length) _searchSel = Math.max(0, _searchHits.length - 1);
  const ul = byId("searchResults");
  if (!q.trim()) { ul.innerHTML = ""; return; }
  if (!_searchHits.length) { ul.innerHTML = `<li class="sr-empty">no matches</li>`; return; }
  ul.innerHTML = _searchHits.map((i, ix) => {
    const c = cat(i.categoryId), color = c ? c.color : (IMP[i.importance] || {}).color || "#475569";
    const doneT = i.status === "done"; // v6.6.11: tick a task done straight from search
    return `<li class="sr-item ${ix === _searchSel ? "sel" : ""} ${doneT ? "sr-doneitem" : ""}" data-search-pick="${i.id}" data-ix="${ix}">
      <button class="sr-check" data-search-done="${i.id}" title="${doneT ? "mark active" : "mark done"}">${doneT ? "✓" : "○"}</button>
      <span class="sr-dot" style="background:${color}"></span>
      <span class="sr-title">${esc(i.title)}</span>
      <span class="sr-cat">${esc((c && c.name) || (i.status === "inbox" ? "inbox" : doneT ? "done" : ""))}</span></li>`;
  }).join("");
}
function searchPick(id) { const i = item(id); searchClose(); if (!i) return; openEditor(id); panToItemZone(i); }
// v6.6.12: a reusable DARK, scroll-bounded, searchable task picker (replaces native <select> whose OPEN listbox
// is OS-owned -> white + off-screen on Windows). Reuses the Ctrl+K .sr-* look. Stores the chosen id in a hidden input.
const _taskPick = {}; // idBase -> { q, expanded, selId }
const TASKPICK_VISIBLE = 8; // ~7-10 rows before the "show N more" scroll toggle
function blockerCandidates(selfId) { return state.items.filter((t) => (t.type === "task" || t.type === "project") && t.id !== selfId && t.status !== "done"); }
function taskPickFilter(selfId, q) {
  q = (q || "").trim().toLowerCase();
  let list = blockerCandidates(selfId);
  if (q) list = list.filter((t) => { const c = cat(t.categoryId); return (t.title + " " + ((c && c.name) || "")).toLowerCase().includes(q); });
  const groups = new Map();
  list.forEach((t) => { const c = cat(t.categoryId), key = c ? c.id : "_none";
    if (!groups.has(key)) groups.set(key, { name: c ? c.name : "uncategorized", color: c ? c.color : ((IMP[t.importance] || {}).color || "#475569"), items: [] });
    groups.get(key).items.push(t); });
  groups.forEach((g) => g.items.sort((a, b) => b.importance - a.importance || a.title.localeCompare(b.title)));
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function taskPickField(selfId, idBase, currentId, label) {
  const st = _taskPick[idBase] || (_taskPick[idBase] = { q: "", expanded: false, selId: currentId || "" });
  st.selId = currentId || ""; // v6.7.1: the field's REAL current value is authoritative on mount (was falling back to a prior task's selection -> silently parked the next item as "waiting on" an unrelated task)
  return `<div class="fld tp-fld" data-tp="${idBase}" data-self="${esc(selfId)}"><span>${esc(label)}</span>
    <input type="hidden" id="${idBase}-val" value="${esc(st.selId)}">
    <div class="tp-box"><div class="tp-input-wrap"><span class="tp-ico">⌕</span><input id="${idBase}-q" class="tp-input" type="text" autocomplete="off" spellcheck="false" placeholder="search tasks…" value="${esc(st.q)}"></div>
      <div id="${idBase}-list" class="tp-results"></div></div></div>`;
}
function renderTaskPick(idBase) {
  const wrap = byId(idBase + "-list"); if (!wrap) return;
  const st = _taskPick[idBase]; const host = wrap.closest("[data-self]"); if (!host) return; const selfId = host.dataset.self;
  const groups = taskPickFilter(selfId, st.q);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  let shown = 0; const collapsed = !st.expanded;
  const rowsHtml = groups.map((g) => {
    const items = g.items.map((t) => { if (collapsed && shown >= TASKPICK_VISIBLE) return ""; shown++;
      const sel = t.id === st.selId ? " sel" : "";
      return `<div class="sr-item tp-item${sel}" data-tp-pick="${t.id}"><span class="sr-dot" style="background:${g.color}"></span><span class="sr-title">${esc(t.title)}</span></div>`; }).join("");
    return items ? `<div class="tp-group"><div class="tp-group-head">${esc(g.name)}</div>${items}</div>` : "";
  }).join("");
  const more = total - shown;
  const noneRow = `<div class="sr-item tp-item tp-none${st.selId ? "" : " sel"}" data-tp-pick=""><span class="sr-dot" style="background:#475569"></span><span class="sr-title">- none -</span></div>`;
  wrap.innerHTML = total ? noneRow + rowsHtml + (collapsed && more > 0 ? `<button type="button" class="tp-more" data-tp-more="${idBase}">show ${more} more…</button>` : "") : `<div class="sr-empty">no matching tasks</div>`;
}
document.addEventListener("input", (e) => {
  if (e.target.classList && e.target.classList.contains("tp-input")) { const idBase = e.target.id.replace(/-q$/, ""); if (_taskPick[idBase]) { _taskPick[idBase].q = e.target.value; _taskPick[idBase].expanded = false; renderTaskPick(idBase); } }
});
document.addEventListener("click", (e) => {
  const pick = e.target.closest("[data-tp-pick]");
  if (pick) { const host = pick.closest("[data-tp]"); if (host) { const idBase = host.dataset.tp; _taskPick[idBase].selId = pick.dataset.tpPick; const v = byId(idBase + "-val"); if (v) v.value = pick.dataset.tpPick; renderTaskPick(idBase); } return; }
  const more = e.target.closest("[data-tp-more]");
  if (more) { _taskPick[more.dataset.tpMore].expanded = true; renderTaskPick(more.dataset.tpMore); }
});
function panToItemZone(i) {
  const key = viewMode === "urgency" ? ("urg" + i.importance) : (i.categoryId || null);
  if (!key) return;
  const zp = (state.meta.ui && state.meta.ui.zonePos) || {}, p = zp[key]; if (!p) return;
  const wrap = document.querySelector(".canvas-wrap"); if (!wrap) return;
  panX = wrap.clientWidth / 2 - (p.x + 150) * zoom; panY = wrap.clientHeight / 2 - (p.y + 60) * zoom;
  applyCanvasTransform(); persistCanvas();
}
document.addEventListener("keydown", (e) => { // Ctrl/Cmd+K opens search anywhere (guard: not while typing elsewhere)
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (typing && t.id !== "searchInput") return;
    e.preventDefault(); searchOpen();
  }
});
byId("searchInput") && byId("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); _searchSel = Math.min(_searchSel + 1, _searchHits.length - 1); renderSearch(e.target.value); }
  else if (e.key === "ArrowUp") { e.preventDefault(); _searchSel = Math.max(_searchSel - 1, 0); renderSearch(e.target.value); }
  else if (e.key === "Enter") { e.preventDefault(); const h = _searchHits[_searchSel]; if (h) searchPick(h.id); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); searchClose(); }
});
byId("searchInput") && byId("searchInput").addEventListener("input", (e) => { _searchSel = 0; renderSearch(e.target.value); });
byId("searchResults") && byId("searchResults").addEventListener("click", (e) => {
  const ck = e.target.closest("[data-search-done]"); // v6.6.11: tick done without leaving search
  if (ck) { e.stopPropagation(); const it = item(ck.dataset.searchDone); if (it && it.type !== "rhythm") { it.status = it.status === "done" ? "active" : "done"; it.completedAt = it.status === "done" ? nowIso() : null; if (it.status === "done") { it.inFocus = false; clearFutureTaskEvents(it.id); releaseDependents(it.id); } touch(it); scheduleSave(); render(); renderSearch(byId("searchInput").value); toast(it.status === "done" ? "✓ done" : "↩ active"); } return; }
  const li = e.target.closest("[data-search-pick]"); if (li) searchPick(li.dataset.searchPick);
});
byId("searchOverlay") && byId("searchOverlay").addEventListener("click", (e) => { if (e.target.id === "searchOverlay") searchClose(); });

// ---------- v6.5.11: inline quick-edit (double-click title to rename; click the due chip to set/clear) ----------
let _renaming = null, _titleOpenTimer = null;
document.addEventListener("dblclick", (e) => {
  const t = e.target.closest(".card-title"); if (!t) return;
  e.preventDefault(); e.stopPropagation();
  clearTimeout(_titleOpenTimer); // v6.6.35: a double-click renames - cancel the pending single-click "open editor"
  const id = t.dataset.titleId, i = item(id); if (!i || _renaming) return;
  _renaming = id; t.textContent = i.title; t.setAttribute("contenteditable", "true"); t.classList.add("editing");
  t.focus(); const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  const commit = (save) => {
    t.removeEventListener("keydown", onKey); t.removeEventListener("blur", onBlur);
    t.removeAttribute("contenteditable"); t.classList.remove("editing"); _renaming = null;
    if (save) { const v = t.textContent.trim(); if (v && v !== i.title) { i.title = v; touch(i); scheduleSave(); } }
    render();
  };
  const onKey = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); commit(true); } else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); commit(false); } };
  const onBlur = () => commit(true);
  t.addEventListener("keydown", onKey); t.addEventListener("blur", onBlur);
});
function openCardDue(id, anchor) {
  const i = item(id); if (!i) return;
  if (i.urgency && i.urgency.due) { i.urgency = { due: null, soon: i.urgency.soon }; touch(i); scheduleSave(); render(); toast("due cleared"); return; } // toggle: set -> clear
  let inp = byId("cardDueInput"); if (inp) inp.remove();
  inp = document.createElement("input"); inp.type = "date"; inp.id = "cardDueInput"; inp.value = "";
  inp.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  const r = anchor.getBoundingClientRect(); inp.style.left = r.left + "px"; inp.style.top = (r.bottom + 2) + "px";
  document.body.appendChild(inp);
  inp.addEventListener("change", () => { i.urgency = { due: inp.value || null, soon: !!(i.urgency && i.urgency.soon) }; touch(i); scheduleSave(); render(); inp.remove(); });
  inp.addEventListener("blur", () => setTimeout(() => { if (byId("cardDueInput")) inp.remove(); }, 200));
  const reveal = () => { inp.style.cssText = "position:fixed;z-index:200;left:" + r.left + "px;top:" + (r.bottom + 2) + "px"; inp.focus(); }; // v6.5.13
  if (inp.showPicker) { try { inp.showPicker(); } catch (_) { reveal(); } } else reveal();
}

// ---------- v6.9.1: topbar "⋯ More" dropdown (Travel, Guardian, Habits, Rhythms, Waiting, Tidy, Archive, History) ----------
function openMoreMenu() { const m = byId("moreMenu"); if (!m || !m.hidden) return; m.hidden = false; const b = byId("moreBtn"); if (b) b.setAttribute("aria-expanded", "true"); }
function closeMoreMenu() { const m = byId("moreMenu"); if (!m || m.hidden) return; m.hidden = true; const b = byId("moreBtn"); if (b) b.setAttribute("aria-expanded", "false"); }
function toggleMoreMenu() { const m = byId("moreMenu"); if (!m) return; m.hidden ? openMoreMenu() : closeMoreMenu(); }
document.addEventListener("click", (e) => { // closes on any click elsewhere (the button itself toggles via the "more-menu" dispatch)
  const m = byId("moreMenu"); if (!m || m.hidden) return;
  if (typeof _tourOv !== "undefined" && _tourOv) return;   // v6.9.2 E3a: NEVER self-close the More menu during the guided tour (a click on the tour pop/ring must not tear down the menu the ring is pointing at)
  if (e.target.closest("#moreMenu") || e.target.closest("#moreBtn")) return;
  closeMoreMenu();
});

// ---------- v6.5.8: Shift-prefixed global shortcuts (only when NOT typing) ----------
let _chordG = false, _chordTimer = null;
function _typingTarget(t) { return t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable); }
function closeAllPanels() { closeCalendar(); closeHabits(); closeRhythms(); closeInbox(); closeTidy(); closeWaiting(); closeGuardian(); closeIdeasFull();
  try { closeMoreMenu(); } catch (e) {}  // v6.9.2 E3b: the "⋯ More" dropdown is a panel too - close it on any full-panel reset so a step transition never leaves it dangling over the next card
  try { const p = byId("popup"); if (p && !p.hidden) { p.classList.remove("open"); p.hidden = true; p.innerHTML = ""; } } catch (e) {}  // v6.7.11: also force-hide #popup (the calz day-card etc.) so an orphaned popup never cascades into later tour steps (cards 26->29->30)
}
// v6.7.12: closeAllPanels no longer flips state.meta.ui.canvasCal.open - doing so in this shared helper (called by the "b" nav shortcut + every top-bar button) closed the rail in STATE without a repaint/save -> a stale-but-visible rail + a toggle that needed two clicks. The tour closes the rail explicitly in its per-card before hooks (canvas_cal / view_category) with renderNow()+scheduleSave().
const _navMap = { b: closeAllPanels, c: openCalendar, h: openHabits, r: openRhythms, i: openInbox, t: openTidy };
function openCheatsheet() {
  const rows = [["shift + c", "focus the capture box"], ["shift + g, then b", "board (main page)"],
    ["shift + g, then c / h / r / i", "calendar / habits / rhythms / inbox"], ["ctrl + k", "search anything"],
    ["shift + ?", "this cheatsheet"], ["double-click a card title", "rename inline"],
    ["click the +due chip on a card", "set / clear a due date"], ["Esc", "close any panel / popup"]]
    .map(([k, d]) => `<div class="cheat-row"><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join("");
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card cheat-card"><div class="drawer-head"><span class="drawer-kicker">keyboard</span><button class="ghost-btn" data-act="close-popup">✕</button></div><div class="cheat-list">${rows}</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}
document.addEventListener("keydown", (e) => {
  if (_typingTarget(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!byId("popup").hidden) return; // v6.5.13: don't fire shortcuts behind an open popup/cheatsheet
  if (_chordG) { const k = e.key.toLowerCase(); if (["shift", "control", "alt", "meta"].includes(k)) return; clearTimeout(_chordTimer); _chordG = false; if (_navMap[k]) { e.preventDefault(); if (k !== "b") closeAllPanels(); _navMap[k](); } return; }
  if (!e.shiftKey) return;
  if (e.key === "C") { e.preventDefault(); const ci = byId("captureInput"); if (ci) ci.focus(); }
  else if (e.key === "G") { e.preventDefault(); _chordG = true; _chordTimer = setTimeout(() => (_chordG = false), 1200); toast("go to? b/c/h/r/i"); }
  else if (e.key === "?") { e.preventDefault(); openCheatsheet(); }
});

// ---------- editor drawer ----------
// v6.6.24: the Guardian shield only renders for items that can be protected (habits + projects), not plain tasks.
// Kept as a slot (#e-guard-slot) so the Type dropdown can re-render it live when the owner switches type.
function guardFieldHtml(i) {
  if (!canProtect(i)) return "";
  return `<label class="fld guard-fld" title="Protect this from being silently dropped when a deal lands">
      <span>Priorities Guardian <small>(shield a high-value good)</small></span>
      <button type="button" class="guard-shield ${i.protected ? "on" : ""}" id="e-protect" data-act="toggle-protect" data-on="${i.protected ? "1" : "0"}"><span class="shield-ico">${i.protected ? "⛨" : "⛊"}</span> ${i.protected ? "protected" : "protect this"}</button>
    </label>`;
}
function openEditor(id) {
  const i = item(id); if (!i) return;
  clearTimeout(_titleOpenTimer); // v6.7.1: cancel any pending single-click title-open so it can't re-fire openEditor over this one
  delete _taskPick["e-wait-task"]; // v6.7.1: a fresh editor session must NOT inherit the previous task's blocker selection / search query
  editingId = id;
  _editorSnap = { categoryId: i.categoryId || null, type: i.type, importance: i.importance, parallel: !!i.parallel }; // baseline for manual-edit logging (v6.6.36: + parallel; v6.7.1: + type so an auto importance-remap during a Type switch isn't logged as a manual edit)
  _lastParallelSuggest = null; // v6.6.36: reset the per-edit AI parallel suggestion
  _ifthenProposal = null; // a fresh editor session has no pending AI if-then proposal yet
  const tintCat = isHabit(i.type) ? habitCat(i.categoryId) : cat(i.categoryId);
  setTint((tintCat || {}).color || (impMap(i.type)[i.importance] || {}).color || "#4a8fff"); // tint to what's open on top
  const opts = catList(i.type).map((c) => `<option value="${c.id}" ${i.categoryId === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  const impBtns = impScale(i.type).map((n) =>
    `<button class="imp-btn ${i.importance === n ? "sel" : ""}" data-imp="${n}" style="--imp:${impMap(i.type)[n].color}">${impMap(i.type)[n].label}</button>`).join("");
  const d = byId("drawer");
  d.innerHTML = `
    <div class="drawer-head">
      <span class="drawer-kicker">edit</span>
      <button class="ghost-btn" data-act="close-drawer">✕</button>
    </div>
    <label class="fld"><span>Title <button type="button" class="mini ai-mini" data-enh="e-title" title="✦ enhance - preview first, never changes meaning">✦</button></span>
      <textarea id="e-title" rows="2">${esc(i.title)}</textarea></label>

    <div class="fld-row">
      <label class="fld"><span>Type</span>
        <select id="e-type">
          ${[["task", "task"], ["project", "project"], ["macro", "macro project"], ["rhythm", "habit"]].map(([v, lbl]) => `<option value="${v}" ${(isMacro(i) ? "macro" : i.type) === v ? "selected" : ""}>${lbl}</option>`).join("")}
        </select></label>
      <label class="fld"><span>Category</span>
        <select id="e-cat"><option value="">- none (inbox) -</option>${opts}</select></label>
    </div>

    <div class="fld"><span>Importance <small>${isHabit(i.type) ? "(how essential this habit is)" : "(primary - shown as glow)"}</small></span>
      <div class="imp-row" id="e-imp-row">${impBtns}</div></div>

    <div id="e-guard-slot">${guardFieldHtml(i)}</div>

    <div class="fld-row urgency" id="e-urg-row">${urgencyRow(i.type, i)}</div>

    <div class="fld na-box"><span>Next action <small>(if-then plan - research-backed, d=.65)</small> <button type="button" class="mini ai-mini" data-act="suggest-ifthen" title="✦ suggest an if-then - you can edit it; Save makes it real">✦ suggest</button></span>
      <div class="na-row">
        <input id="e-if" placeholder="if … (when / where)" value="${esc(i.nextAction ? i.nextAction.if : "")}">
        <span class="arr">→</span>
        <input id="e-then" placeholder="then I'll … (one concrete step)" value="${esc(i.nextAction ? i.nextAction.then : "")}">
      </div>
    </div>

    <div id="e-wait">${waitEditor(i)}</div>

    <label class="fld"><span>Notes <button type="button" class="mini ai-mini" data-enh="e-notes" title="✦ enhance - preview first, never changes meaning">✦</button></span>
      <textarea id="e-notes" rows="4">${esc(i.notes)}</textarea></label>

    <div id="e-extra">${extraEditor(i)}</div>

    <div class="drawer-actions">
      <button class="glow-btn" data-act="save-drawer">Save</button>
      <button class="ghost-btn danger" data-act="del-item" data-id="${i.id}">Delete</button>
    </div>`;
  d.hidden = false; byId("scrim").hidden = false;
  requestAnimationFrame(() => { d.classList.add("open"); });
  bindImpButtons();
  // changing the Type swaps the category set + importance scale + the type-specific fields, live
  byId("e-type").addEventListener("change", (e) => {
    const t = e.target.value;
    // v6.7.1: do NOT mutate the live item's type/isMacro here - every rebuild below takes the dropdown value `t`,
    // and saveDrawer is the ONLY place that commits type/isMacro. (Was: an i.type/isMacro flip that silently persisted if you abandoned the drawer.)
    const curCat = byId("e-cat").value;
    byId("e-cat").innerHTML = `<option value="">- none${isHabit(t) ? "" : " (inbox)"} -</option>` +
      catList(t).map((c) => `<option value="${c.id}" ${curCat === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    const scale = impScale(t);
    const selBtn = byId("e-imp-row").querySelector(".imp-btn.sel");
    let curImp = selBtn ? +selBtn.dataset.imp : i.importance;
    if (!scale.includes(curImp)) curImp = scale[Math.floor(scale.length / 2)];
    byId("e-imp-row").innerHTML = scale.map((n) =>
      `<button class="imp-btn ${n === curImp ? "sel" : ""}" data-imp="${n}" style="--imp:${impMap(t)[n].color}">${impMap(t)[n].label}</button>`).join("");
    bindImpButtons();
    // rebuild the urgency row (habits drop "Soon" + show "Expire date") - preserve current due/est
    const curDue = byId("e-due") ? byId("e-due").value : "";
    const curEst = byId("e-est") ? byId("e-est").value : "";
    i.urgency = i.urgency || {}; i.urgency.due = curDue || null;
    i.estimateMins = curEst ? +curEst : null;
    byId("e-urg-row").innerHTML = urgencyRow(t, i);
    byId("e-extra").innerHTML = extraEditor(i, t);
    if (byId("e-wait")) { byId("e-wait").innerHTML = t === "rhythm" ? "" : waitEditor(i); if (byId("e-wait-task-q")) renderTaskPick("e-wait-task"); } // B3: habits never wait; v6.6.12: mount the picker list
    const gslot = byId("e-guard-slot"); if (gslot) gslot.innerHTML = guardFieldHtml({ type: t === "macro" ? "project" : t, protected: i.protected }); // v6.6.24: show/hide the shield live when Type changes (macro counts as project)
  });
  byId("e-title").focus();
  if (byId("e-wait-task-q")) renderTaskPick("e-wait-task"); // v6.6.12: mount the searchable blocked-by picker
}
function bindImpButtons() {
  const row = byId("e-imp-row"); if (!row) return;
  row.querySelectorAll(".imp-btn").forEach((b) => b.addEventListener("click", () => {
    row.querySelectorAll(".imp-btn").forEach((x) => { x.classList.remove("sel"); delete x.dataset.sel; });
    b.classList.add("sel"); b.dataset.sel = "1";
  }));
}
function urgencyRow(type, i) {
  const isH = isHabit(type);
  const due = i.urgency && i.urgency.due ? i.urgency.due : "";
  return `
    <label class="fld"><span>${isH ? "Expire date" : "Deadline"} <small>(${isH ? "optional - when to retire this habit" : "secondary"})</small></span>
      ${tdateField("e-due", due, { clearable: true, placeholder: isH ? "no expiry" : "no deadline" })}</label>
    ${isH ? "" : `<label class="fld check-fld"><span>Soon</span>
      <input type="checkbox" id="e-soon" ${i.urgency && i.urgency.soon ? "checked" : ""}></label>
    <label class="fld check-fld" title="Can run ALONGSIDE other tasks (e.g. a second app building, browsing while on a call). Calendarize overlaps it with your other work instead of giving it an exclusive slot."><span>↔ Parallel <button type="button" class="mini ai-mini" data-act="ai-parallel" data-id="${i.id}" title="✦ AI: does this run in parallel?">✦</button></span>
      <input type="checkbox" id="e-parallel" ${i.parallel ? "checked" : ""}></label>`}
    <label class="fld"><span>Est. min <button type="button" class="mini ai-mini" data-act="ai-eta" data-id="${i.id}" title="✦ AI estimate - guesses how long this takes, with a reason">✦</button></span>
      <input type="number" id="e-est" min="0" step="5" value="${i.estimateMins || ""}"></label>`;
}
function macroEditor(i) { // v6.6.8: the sub-project tree for a macro project
  const kids = childrenOf(i.id).filter((k) => k.type === "project").sort((a, b) => a.order - b.order);
  const nodes = kids.map((k) => {
    const subs = leafTasks(k.id), done = subs.filter((s) => s.status === "done").length, pct = subs.length ? Math.round(done / subs.length * 100) : 0;
    const leaves = childrenOf(k.id).map((s) => `<li><button class="sub-check" data-sub-done="${s.id}">${s.status === "done" ? "✓" : "○"}</button><span>${esc(s.title)}</span></li>`).join("");
    return `<li class="macro-node ${pct === 100 && subs.length ? "done" : ""}"><button class="caret macro-caret" data-macro-toggle="${k.id}">▸</button>
        <span class="macro-node-name" data-open-sub="${k.id}" title="open this sub-project">📁 ${esc(k.title)}</span>
        <span class="prog mini-prog"><i class="prog-bar" style="width:${pct}%"></i></span><span class="prog-txt">${done}/${subs.length}</span>
        <button class="sub-del" data-sub-del="${k.id}" title="delete this sub-project and its tasks">✕</button></li>
      <ul class="sub-list macro-leaves" data-leaves="${k.id}" hidden>${leaves || '<li class="muted">no tasks yet</li>'}</ul>`;
  }).join("");
  return `<div class="fld proj-sub macro-sub"><span>Sub-projects <small>(each is its own project with its own tasks)</small></span>
    <ul class="sub-list macro-tree">${nodes || '<li class="muted">no sub-projects yet</li>'}</ul>
    <div class="sub-add"><input id="e-macnew" placeholder="add a sub-project… (Enter)"></div></div>`;
}
function extraEditor(i, typeOverride) {
  const t = typeOverride || i.type;
  if ((t === "macro") || (typeOverride == null && isMacro(i))) return macroEditor(i); // v6.6.8
  if (t === "rhythm") {
    const cad = i.cadence || "daily";
    return `<div class="fld-row freq-row">
      <label class="fld"><span>Frequency</span>
        <select id="e-cadence">
          <option value="daily" ${cad === "daily" ? "selected" : ""}>daily</option>
          <option value="weekly" ${cad === "weekly" ? "selected" : ""}>X times per week</option>
          <option value="monthly" ${cad === "monthly" ? "selected" : ""}>Y times per month</option>
        </select></label>
      <label class="fld" id="e-freq-x" ${cad === "weekly" ? "" : "hidden"}><span>X - per week</span>
        <input type="number" id="e-perweek" min="1" max="7" value="${i.perWeek || 3}"></label>
      <label class="fld" id="e-freq-y" ${cad === "monthly" ? "" : "hidden"}><span>Y - per month</span>
        <input type="number" id="e-permonth" min="1" max="31" value="${i.perMonth || 4}"></label>
      <div class="fld"><span>Streak</span><div class="streak">🔥 ${i.streak || 0}</div></div>
    </div>`;
  }
  if (t === "project") {
    const subs = state.items.filter((s) => s.projectId === i.id);
    const list = subs.map((s) => `<li class="${s.status === "done" ? "done" : ""}">
        <input type="radio" name="nextact" ${i.nextActionId === s.id ? "checked" : ""} data-next="${s.id}" title="next action">
        <button class="sub-check" data-sub-done="${s.id}">${s.status === "done" ? "✓" : "○"}</button>
        <span>${esc(s.title)}</span>
        <button class="sub-del" data-sub-del="${s.id}">✕</button></li>`).join("");
    return `<div class="fld proj-sub"><span>Sub-tasks <small>(pick one ● as the next action)</small> <button type="button" class="mini ai-mini" data-act="suggest-substeps" title="✦ propose more sub-steps - approve before anything is added">✦ suggest</button></span>
      <ul class="sub-list">${list || '<li class="muted">no sub-tasks yet</li>'}</ul>
      <div class="sub-add"><input id="e-subnew" placeholder="add a sub-task… (Enter)"></div>
      <button type="button" class="ghost-btn sm" data-act="add-subproject" title="make this a macro project (a project of projects)">＋ sub-project</button></div>`;
  }
  return `<div class="fld ai-projhint"><span>Project tools</span>
    <button type="button" class="ghost-btn sm" data-act="suggest-substeps" title="if this task is secretly a project, let AI propose sub-steps - you approve before anything changes">✦ suggest sub-steps (turn into a project)</button></div>`;
}
function saveDrawer() {
  const i = item(editingId); if (!i) return;
  const _newType = byId("e-type").value; // v6.7.1: "task" | "project" | "macro" | "rhythm"
  if (i.type === "project" && _newType !== "project" && _newType !== "macro" && childrenOf(i.id).length) { toast("⚠ this project has sub-tasks - move or delete them first"); return; } // v6.7.1: block demoting a container that still has children (would orphan them with a dangling projectId)
  const snap = _editorSnap || { categoryId: i.categoryId || null, type: i.type, importance: i.importance };
  const ifp = (_ifthenProposal && _ifthenProposal.itemId === editingId) ? _ifthenProposal : null;
  i.title = byId("e-title").value.trim() || i.title;
  i.type = _newType;
  i.isMacro = (i.type === "macro"); // v6.6.8: "macro project" is a project with isMacro
  if (i.type === "macro") i.type = "project";
  i.categoryId = byId("e-cat").value || null;
  if (!isHabit(i.type)) { // habits are never "inbox" - they live in the Habits section regardless
    if (i.categoryId && i.status === "inbox") i.status = "active";
    if (!i.categoryId && i.status === "active") i.status = "inbox";
  } else if (i.status === "inbox") i.status = "active";
  const sel = byId("drawer").querySelector(".imp-btn.sel");
  if (sel) i.importance = +sel.dataset.imp;
  const wantProtect = byId("e-protect") && byId("e-protect").dataset.on === "1"; // v6.6.9: Guardian shield
  if (!!i.protected !== !!wantProtect) { i.protected = !!wantProtect; guardSyncIndex(); guardLedger(i.protected ? "protect" : null, { itemId: i.id, note: i.protected ? "protected " + i.title : null }); }
  i.urgency = { due: byId("e-due").value || null, soon: byId("e-soon") ? byId("e-soon").checked : false };
  // v6.6.33/.36: the parallel flag. If the owner toggled it THEMSELVES (the AI-accept path syncs _editorSnap so it does not double-log here), archive that as training data for the future agent.
  const _newPar = byId("e-parallel") ? byId("e-parallel").checked : !!i.parallel;
  if (_newPar !== (_editorSnap ? !!_editorSnap.parallel : !!i.parallel)) {
    logOutcome({ call_id: (_lastParallelSuggest && _lastParallelSuggest.callId) || null, item_id: i.id, kind: "parallel",
      decision: "manual", ai_proposed: _lastParallelSuggest ? { parallel: _lastParallelSuggest.parallel, reason: _lastParallelSuggest.reason } : null,
      my_final: { parallel: _newPar }, my_reason: null, original_input: i.title });
  }
  i.parallel = _newPar;
  i.estimateMins = byId("e-est").value ? +byId("e-est").value : null;
  i.nextAction = { if: byId("e-if").value.trim(), then: byId("e-then").value.trim() };
  // B3: waiting-on (a task dependency wins over a free-text note; both empty -> not waiting; habits have no fields -> null)
  const wTask = byId("e-wait-task-val") ? byId("e-wait-task-val").value : ""; // v6.6.12: searchable picker's hidden input
  const wNote = byId("e-wait-note") ? byId("e-wait-note").value.trim() : "";
  if (wTask) { i.waitingOn = { type: "task", taskId: wTask }; i.inFocus = false; }
  else if (wNote) { i.waitingOn = { type: "note", note: wNote }; i.inFocus = false; }
  else i.waitingOn = null;
  i.notes = byId("e-notes").value;
  if (i.type === "rhythm") {
    if (byId("e-cadence")) i.cadence = byId("e-cadence").value;
    i.perWeek = i.cadence === "weekly" && byId("e-perweek") ? (+byId("e-perweek").value || null) : null; // v6.7.1: only keep the field the chosen cadence actually uses
    i.perMonth = i.cadence === "monthly" && byId("e-permonth") ? (+byId("e-permonth").value || null) : null;
    i.everyNDays = null; // dropped in v4.4
  }
  // ---- durable decision logging (CHANGE 2): manual category/urgency edits + if-then accept/edit ----
  const itemId = i.id;
  const catName = (cat(i.categoryId) || {}).name || null;
  const impName = impMap(i.type)[i.importance] ? impMap(i.type)[i.importance].label : String(i.importance);
  const finalIf = i.nextAction.if, finalThen = i.nextAction.then;
  const catChanged = (snap.categoryId || null) !== (i.categoryId || null);
  const urgChanged = snap.importance != null && i.type === snap.type && snap.importance !== i.importance; // v6.7.1: an importance auto-remap during a Type switch is not a manual edit (don't log it)
  const ifthenUsed = !!(ifp && (ifp.if || ifp.then));
  const ifthenEdited = ifthenUsed && (finalIf !== ifp.if || finalThen !== ifp.then);
  _ifthenProposal = null;
  touch(i); scheduleSave(); closeEditor(); render(); toast("Saved");
  if (ifthenUsed && !ifthenEdited) // used the suggestion verbatim → positive example, no reason needed
    logOutcome({ call_id: ifp.callId, item_id: itemId, kind: "ifthen", decision: "accept",
      ai_proposed: { if: ifp.if, then: ifp.then }, my_final: { if: finalIf, then: finalThen }, my_reason: null });
  const reasoned = []; // edits that share ONE optional Why? box
  if (catChanged) reasoned.push((r) => logOutcome({ call_id: null, item_id: itemId, kind: "manual_category", decision: "edit", ai_proposed: null, my_final: catName, my_reason: r }));
  if (urgChanged) reasoned.push((r) => logOutcome({ call_id: null, item_id: itemId, kind: "manual_urgency", decision: "edit", ai_proposed: null, my_final: impName, my_reason: r }));
  if (ifthenEdited) reasoned.push((r) => logOutcome({ call_id: ifp.callId, item_id: itemId, kind: "ifthen", decision: "edit", ai_proposed: { if: ifp.if, then: ifp.then }, my_final: { if: finalIf, then: finalThen }, my_reason: r }));
  if (reasoned.length) {
    const bits = [];
    if (catChanged) bits.push(`category → ${catName || "(none)"}`);
    if (urgChanged) bits.push(`urgency → ${impName}`);
    if (ifthenEdited) bits.push("edited the if-then");
    askWhy(`changed by hand: ${bits.join(" · ")}`).then((r) => reasoned.forEach((fn) => fn(r)));
  }
}
function closeEditor() {
  const d = byId("drawer"); d.classList.remove("open");
  byId("scrim").hidden = true;
  setTimeout(() => { d.hidden = true; d.innerHTML = ""; editingId = null; }, 220);
}

// ---------- history panel ----------
async function openHistory() {
  const p = byId("historyPanel");
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  byId("scrim").hidden = false;
  p.innerHTML = `<div class="drawer-head"><span class="drawer-kicker">version history</span>
     <button class="ghost-btn" data-act="close-history">✕</button></div>
     <div class="hist-note">Every save keeps a version. Restore any one - restoring is itself undoable.</div>
     <div class="hist-list">loading…</div>`;
  try {
    const snaps = await (await fetch("/api/snapshots")).json();
    const list = snaps.length ? snaps.map((s) => `
      <div class="hist-row">
        <div><div class="hist-time">${fmtTime(s.time)}</div>
        <div class="hist-sub">${s.items != null ? s.items + " items" : ""}</div></div>
        <button class="ghost-btn" data-act="restore" data-id="${esc(s.id)}">restore</button>
      </div>`).join("") : `<div class="empty">No versions yet - they appear as you edit.</div>`;
    p.querySelector(".hist-list").innerHTML = list;
  } catch (e) { p.querySelector(".hist-list").innerHTML = `<div class="empty">⚠ couldn't load</div>`; }
}
function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso), now = new Date();
  const same = d.toDateString() === now.toDateString();
  return (same ? "Today" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" })) +
    " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
// v6.6.21: show WHAT a restore will change before applying it. Direction: "restore" makes the snapshot the new
// current, so framing is "what this does to your board now" - added = in the snapshot but not now (comes back),
// removed = on the board now but not in the snapshot (disappears), changed = same id, a visible field differs.
function _catNameIn(stateObj, id) { const c = (stateObj.categories || []).find((x) => x.id === id); return c ? c.name : "(none)"; }
function _itemFacets(stateObj, i) {
  return { title: i.title || "", status: i.status || "", category: _catNameIn(stateObj, i.categoryId),
    importance: ((IMP[i.importance] || {}).label) || String(i.importance), due: (i.urgency && i.urgency.due) || "(none)" };
}
function diffStates(current, snapshot) {
  const curMap = new Map((current.items || []).map((i) => [i.id, i]));
  const snapMap = new Map((snapshot.items || []).map((i) => [i.id, i]));
  const added = [], removed = [], changed = [];
  snapMap.forEach((si, id) => { if (!curMap.has(id)) added.push(si); });
  curMap.forEach((ci, id) => { if (!snapMap.has(id)) removed.push(ci); });
  curMap.forEach((ci, id) => {
    const si = snapMap.get(id); if (!si) return;
    const a = _itemFacets(current, ci), b = _itemFacets(snapshot, si), fields = [];
    ["title", "status", "category", "importance", "due"].forEach((k) => { if (String(a[k]) !== String(b[k])) fields.push({ name: k, from: a[k], to: b[k] }); });
    if (fields.length) changed.push({ id, title: ci.title || si.title || id, fields });
  });
  return { added, removed, changed, summary: { added: added.length, removed: removed.length, changed: changed.length } };
}
async function openRestorePreview(id) {
  try {
    const snap = await (await fetch("/api/snapshot?id=" + encodeURIComponent(id))).json();
    if (!snap || snap.error) { toast("⚠ couldn't load that version"); return; }
    openRestoreDiff(id, snap);
  } catch (e) { toast("⚠ couldn't load that version"); }
}
function openRestoreDiff(id, snap) {
  const d = diffStates(state, snap), s = d.summary;
  const cap = (s.added || s.removed || s.changed)
    ? `Restoring this version will: <b style="color:var(--green)">+${s.added}</b> task${s.added === 1 ? "" : "s"}, <b style="color:#ff6b6b">-${s.removed}</b> task${s.removed === 1 ? "" : "s"}, <b style="color:var(--gold)">~${s.changed}</b> changed. Your current board is snapshotted first, so this is undoable.`
    : "No differences - this version matches your current board.";
  const addRows = d.added.map((i) => `<div class="hist-row diffrow"><span class="diff-pm add">+</span><span class="drop-title">${esc(i.title || i.id)}</span></div>`).join("");
  const remRows = d.removed.map((i) => `<div class="hist-row diffrow"><span class="diff-pm rem">-</span><span class="drop-title">${esc(i.title || i.id)}</span></div>`).join("");
  const chgRows = d.changed.map((c) => { const parts = c.fields.map((f) => `${esc(f.name)}: ${esc(f.from)} -> ${esc(f.to)}`).join(", ");
    return `<div class="hist-row diffrow"><span class="diff-pm chg">~</span><span class="drop-title">${esc(c.title)}<span class="hist-sub diff-fields">${parts}</span></span></div>`; }).join("");
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card diff-card">
    <div class="drawer-head"><span class="drawer-kicker">confirm restore</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="hist-note">${cap}</div>
    <div class="diff-list">${addRows}${remRows}${chgRows || (s.added || s.removed ? "" : `<div class="hist-note">nothing to change</div>`)}</div>
    <div class="drawer-actions"><button class="glow-btn" data-act="restore-confirm" data-id="${esc(id)}">Restore this version</button><button class="ghost-btn" data-act="close-popup">Cancel</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}
async function restore(id) {
  try {
    const r = await fetch("/api/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    if (!r.ok) { toast("⚠ restore failed"); return; } // v6.7.1: a 404 (snapshot gone) used to overwrite the live state with the error body
    const next = await r.json();
    if (!next || next.error || !Array.isArray(next.items) || !Array.isArray(next.categories)) { toast("⚠ restore failed"); return; } // validate shape before adopting
    state = next; normalize(); closePopup(); closeHistory(); render(); toast("Restored ✓");
  } catch (e) { toast("⚠ restore failed"); }
}
function closeHistory() {
  const p = byId("historyPanel"); p.classList.remove("open");
  byId("scrim").hidden = true;
  setTimeout(() => { if (!p.classList.contains("open")) p.hidden = true; }, 220); // v6.7.1: a close-then-reopen within 220ms re-adds .open - don't let the stale timer hide the reopened panel
}

function openArchive() {
  const p = byId("archivePanel");
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  byId("scrim").hidden = false;
  const done = state.items.filter((i) => i.status === "done")
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
  const rows = done.length ? done.map((i) => `
    <div class="hist-row">
      <div><div class="hist-time">${esc(i.title)}</div>
      <div class="hist-sub">${i.completedAt ? fmtTime(i.completedAt) : ""}</div></div>
      <button class="ghost-btn" data-act="restore-item" data-id="${i.id}">restore</button>
    </div>`).join("") : `<div class="empty">No completed tasks yet - finish one and watch it go up in smoke. ✦</div>`;
  p.innerHTML = `<div class="drawer-head"><span class="drawer-kicker">archive · ${done.length} done</span>
     <button class="ghost-btn" data-act="close-archive">✕</button></div>
     <div class="hist-note">Completed tasks live here. Restore any one to bring it back to the board.</div>
     <div class="hist-list">${rows}</div>`;
}
function closeArchive() {
  const p = byId("archivePanel"); p.classList.remove("open");
  byId("scrim").hidden = true;
  setTimeout(() => { if (!p.classList.contains("open")) p.hidden = true; }, 220); // v6.7.1: a close-then-reopen within 220ms re-adds .open - don't let the stale timer hide the reopened panel
}

// ---------- inbox panel + done-today popup ----------
function renderInboxPanel() {
  const p = byId("inboxPanel");
  const inbox = state.items.filter((i) => i.status === "inbox");
  p.innerHTML = `<div class="drawer-head"><span class="drawer-kicker">inbox · ${inbox.length}</span>
     <span class="ibx-head-btns"><button class="ghost-btn sm" data-act="inbox-help" title="What is the inbox?">?</button><button class="ghost-btn sm" data-act="open-inbox-full" title="open the spacious full-screen inbox">⤢ Expand</button>
     <button class="ghost-btn" data-act="close-inbox">✕</button></span></div>
     <div class="inbox-actions">
       <button class="glow-btn" data-act="triage-inbox" ${inbox.length ? "" : "disabled"}>✦ Triage all</button>
       <span class="hist-note">untriaged - set a category &amp; importance, or accept a suggestion</span>
     </div>
     <div class="inbox-cards">${inbox.length ? inbox.map(inboxCard).join("") : `<div class="empty">Inbox is clear ✦</div>`}</div>`;
}
function openInbox() { const p = byId("inboxPanel"); p.hidden = false; renderInboxPanel(); requestAnimationFrame(() => p.classList.add("open")); byId("scrim").hidden = false; maybeIntro("inbox"); }
function closeInbox() { const p = byId("inboxPanel"); p.classList.remove("open"); byId("scrim").hidden = true; setTimeout(() => { if (!p.classList.contains("open")) { p.hidden = true; p.innerHTML = ""; } }, 220); } // v6.6.14: clear the panel so its tri-*/eta-sg-* ids cannot shadow the full-screen inbox's. v6.7.1: skip if reopened within 220ms
// ---- v6.6.5: full-screen inbox (spacious triage surface; the owner preps tasks mostly here) ----
let _ibxSel = new Set();   // ids selected in the full-screen inbox (transient; cleared on close)
let _ibxFocus = null;      // id of the keyboard-focused row
let _ibxDrag = null;       // id of the row being drag-reordered
function openInboxFull() {
  closeInbox();
  const el = byId("inboxFull"); el.hidden = false;
  _ibxSel.clear(); _ibxFocus = null;
  renderInboxFull();
  requestAnimationFrame(() => el.classList.add("open"));
}
function closeInboxFull() {
  const el = byId("inboxFull"); el.classList.remove("open");
  _ibxSel.clear(); _ibxFocus = null;
  setTimeout(() => (el.hidden = true), 220);
}
function ibxCatChips(i) {
  return state.categories.slice().sort((a, b) => a.order - b.order).map((c) =>
    `<button class="ibx-cat-chip ${i.categoryId === c.id ? "on" : ""}" data-act="ibx-quickcat" data-id="${i.id}" data-cat="${c.id}" style="--cc:${c.color}" title="file under ${esc(c.name)}"><i style="background:${c.color}"></i>${esc(c.name)}</button>`
  ).join("");
}
function inboxFullRow(i) {
  const sel = _ibxSel.has(i.id), foc = _ibxFocus === i.id;
  const etaTxt = i.estimateMins ? `~${i.estimateMins}m` : "Est. min";
  return `<article class="ibxf-row ${sel ? "sel" : ""} ${foc ? "foc" : ""}" data-row="${i.id}" draggable="true">
    <button class="ibxf-check ${sel ? "on" : ""}" data-act="ibx-sel" data-id="${i.id}" title="select">${sel ? "✓" : ""}</button>
    <div class="ibxf-main">
      <div class="ibxf-title" data-act="edit" data-id="${i.id}" title="open editor">${esc(i.title)}</div>
      <div class="ibxf-chips">${ibxCatChips(i)}</div>
    </div>
    <div class="ibxf-actions">
      <button class="ibx-btn applyall" data-act="apply-ai-all" data-id="${i.id}" title="✦ Apply all - enhance, enrich, estimate, triage (and a calendar slot only if it reads like a today/tomorrow task), approving each step">✦ Apply all</button>
      <button class="ibx-btn eta" data-act="ai-eta" data-id="${i.id}" title="✦ AI estimate">✦ ${etaTxt}</button>
      <button class="ibx-btn enhance" data-act="inbox-enhance" data-id="${i.id}" title="✦ Enhance">✦ Enhance</button>
      <button class="ibx-btn enrich" data-act="inbox-enrich" data-id="${i.id}" title="✦ Enrich">✦ Enrich</button>
    </div>
    ${inboxSuggestBlocks(i)}
  </article>`;
}
function renderInboxFull() {
  const el = byId("inboxFull"); if (el.hidden) return;
  const inbox = state.items.filter((i) => i.status === "inbox").sort((a, b) => a.order - b.order);
  const n = _ibxSel.size;
  const catOpts = `<option value="">file under…</option>` +
    state.categories.slice().sort((a, b) => a.order - b.order).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
  const impChips = [3, 2, 1, 0].map((k) => `<button class="ibxf-imp" data-act="ibx-bulk-imp" data-n="${k}" style="--imp:${IMP[k].color}">${IMP[k].label}</button>`).join("");
  el.innerHTML = `
    <div class="ibxf-head">
      <span class="drawer-kicker" style="color:var(--gold)">📥 inbox · ${inbox.length}</span>
      <div class="ibxf-head-actions">
        <button class="glow-btn" data-act="triage-inbox" ${inbox.length ? "" : "disabled"}>✦ Triage all</button>
        <button class="ghost-btn" data-act="close-inbox-full" title="back to compact panel">✕ Close</button>
      </div>
    </div>
    <div class="ibxf-bulkbar ${n ? "active" : ""}">
      <span class="ibxf-selcount">${n} selected</span>
      <select class="ibxf-catsel" id="ibxf-catsel">${catOpts}</select>
      <button class="ghost-btn sm" data-act="ibx-bulk-cat">file selected</button>
      <span class="ibxf-impwrap">${impChips}</span>
      <button class="ghost-btn sm danger" data-act="ibx-bulk-del">delete</button>
      <button class="ghost-btn sm" data-act="ibx-sel-clear">clear</button>
    </div>
    <div class="ibxf-list">${inbox.length ? inbox.map(inboxFullRow).join("") : `<div class="empty">Inbox is clear ✦</div>`}</div>
    <div class="hist-note ibxf-foot">↑/↓ move · x select · e estimate · Enter open · Esc close · drag a row to reorder</div>`;
}
function _ibxScroll() { const r = document.querySelector("#inboxFull .ibxf-row.foc"); if (r) r.scrollIntoView({ block: "nearest" }); }
// v6.6.5: keyboard nav for the full-screen inbox (j/k or arrows, x select, e estimate, Enter open). Esc is in the main chain.
document.addEventListener("keydown", (e) => {
  const fs = byId("inboxFull"); if (!fs || fs.hidden) return;
  if (!byId("popup").hidden) return; // v6.6.10: don't run inbox shortcuts (e.g. 'e' -> estimateEta -> scheduleSave) while a popup is open - would persist a transient calendarize preview
  const t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; // don't hijack typing
  const ids = state.items.filter((i) => i.status === "inbox").sort((a, b) => a.order - b.order).map((i) => i.id);
  if (!ids.length) return;
  let idx = ids.indexOf(_ibxFocus); if (idx < 0) idx = 0;
  const k = e.key;
  if (k === "ArrowDown" || k === "j") { e.preventDefault(); _ibxFocus = ids[Math.min(ids.length - 1, idx + 1)]; renderInboxFull(); _ibxScroll(); }
  else if (k === "ArrowUp" || k === "k") { e.preventDefault(); _ibxFocus = ids[Math.max(0, idx - 1)]; renderInboxFull(); _ibxScroll(); }
  else if (k === "x") { e.preventDefault(); const id = _ibxFocus || ids[0]; _ibxSel.has(id) ? _ibxSel.delete(id) : _ibxSel.add(id); renderInboxFull(); }
  else if (k === "e") { e.preventDefault(); if (_ibxFocus) estimateEta(_ibxFocus); }
  else if (k === "Enter") { e.preventDefault(); if (_ibxFocus) openEditor(_ibxFocus); }
});
// v6.6.5: drag-reorder scoped to the full-screen inbox list. Isolated from the canvas drag (a .ibxf-row is not a .card,
// so the canvas dragstart leaves dragId null and its dragover/drop bail; our handlers gate on _ibxDrag).
document.addEventListener("dragstart", (e) => { const r = e.target.closest(".ibxf-row"); if (r) { _ibxDrag = r.dataset.row; r.classList.add("dragging"); } }, true);
document.addEventListener("dragover", (e) => { if (!_ibxDrag) return; const list = e.target.closest(".ibxf-list"); if (!list) return; e.preventDefault(); const r = e.target.closest(".ibxf-row"); document.querySelectorAll(".ibxf-row.drag-over").forEach((x) => x.classList.remove("drag-over")); if (r && r.dataset.row !== _ibxDrag) r.classList.add("drag-over"); });
document.addEventListener("drop", (e) => { if (!_ibxDrag) return; const list = e.target.closest(".ibxf-list"); if (!list) return; e.preventDefault(); const i = item(_ibxDrag); const tr = e.target.closest(".ibxf-row"); if (i && tr && tr.dataset.row !== _ibxDrag) { const tg = item(tr.dataset.row); const rect = tr.getBoundingClientRect(); i.order = tg.order + (e.clientY > rect.top + rect.height / 2 ? 0.5 : -0.5); touch(i); normalizeOrders(); scheduleSave(); render(); } });
document.addEventListener("dragend", () => { if (!_ibxDrag) return; _ibxDrag = null; document.querySelectorAll(".ibxf-row.dragging,.ibxf-row.drag-over").forEach((x) => x.classList.remove("dragging", "drag-over")); });
// =================== v7.1.1: IDEA PARKING LOT ===================
// A home for RANDOM thoughts/ideas that are NOT tasks (gift ideas, a packing list, a business spark).
// Completely separate from tasks: own capture, own inbox, grouped into "topics" (NOT "categories", to avoid
// confusion with task categories). AI sorts ideas into topics with a reason-why; a Tidy pass suggests
// edits / merges / removals / promotion-to-a-task. Every AI decision is logged (training data).
const IDEA_TOPIC_COLORS = ["#7cd0f5", "#b06bff", "#f5c46f", "#7cd99e", "#ff8fb0", "#4a8fff", "#e068ff", "#9aa4b5"];
let _ideaTidyProposal = null;
function ideasInit() { state.ideas = state.ideas || []; state.ideaTopics = state.ideaTopics || []; return state; }
function ideaById(id) { ideasInit(); return state.ideas.find((x) => x.id === id) || null; }
function ideaTopic(id) { ideasInit(); return state.ideaTopics.find((t) => t.id === id) || null; }
function ensureTopic(name) {
  ideasInit();
  const nm = String(name || "").trim(); if (!nm) return null;
  let t = state.ideaTopics.find((x) => x.name.toLowerCase() === nm.toLowerCase());
  if (!t) { t = { id: uid("itp"), name: nm.slice(0, 40), color: IDEA_TOPIC_COLORS[state.ideaTopics.length % IDEA_TOPIC_COLORS.length], order: state.ideaTopics.length }; state.ideaTopics.push(t); }
  return t;
}
function addIdea(text, topicId) {
  ideasInit();
  text = String(text || "").trim(); if (!text) return null;
  const idea = { id: uid("idea"), text, topicId: topicId || null, reason: "", status: topicId ? "parked" : "inbox",
    linkedTaskId: null, createdAt: nowIso(), updatedAt: nowIso() };
  state.ideas.push(idea); scheduleSave(); renderIdeasFull(); refreshIdeaCount();
  if (byId("ideasFull").hidden) toast("\u{1F4A1} parked · open Ideas to sort");
  return idea;
}
function parkIdeas(text) {   // v7.3: drop MANY ideas at once - one per line
  const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let n = 0; lines.forEach((l) => { if (addIdea(l)) n++; });
  if (n > 1) toast("\u{1F4A1} parked " + n + " ideas");
  return n;
}
function refreshIdeaCount() {
  ideasInit();
  const n = state.ideas.filter((i) => i.status !== "done").length;
  const el = byId("ideaCount"); if (el) { el.textContent = n || ""; el.style.display = n ? "" : "none"; }
  const inboxN = state.ideas.filter((i) => i.status === "inbox").length;
  const nudge = byId("ideaSortNudge"); if (nudge) nudge.hidden = inboxN < 4;   // gentle periodic nudge to sort when unsorted ideas pile up
}
function openIdeas() { ideasInit(); const el = byId("ideasFull"); el.hidden = false; renderIdeasFull(); requestAnimationFrame(() => el.classList.add("open")); maybeIntro("ideas"); }
function closeIdeasFull() { const el = byId("ideasFull"); if (!el) return; el.classList.remove("open"); setTimeout(() => { if (!el.classList.contains("open")) el.hidden = true; }, 220); }
function ideaCard(i) {
  const t = i.topicId ? ideaTopic(i.topicId) : null;
  const chip = t ? `<span class="idea-chip" style="--tc:${t.color}"><i style="background:${t.color}"></i>${esc(t.name)}</span>` : `<span class="idea-chip unsorted">unsorted</span>`;
  const why = i.reason ? `<div class="idea-why" title="why Himmah filed it here">✦ ${esc(i.reason)}</div>` : "";
  const linked = i.linkedTaskId ? `<span class="idea-linked" title="already promoted to a task">→ task</span>` : "";
  return `<article class="idea-card" data-idea="${i.id}">
    <div class="idea-text" data-act="idea-edit" data-id="${i.id}" title="click to edit">${esc(i.text)}</div>
    <div class="idea-meta">${chip}${linked}
      <span class="idea-btns">
        <button class="ghost-btn sm" data-act="idea-activate" data-id="${i.id}" title="promote this idea into a real task (lands in your Inbox)">→ Task</button>
        <button class="ghost-btn sm" data-act="idea-edit" data-id="${i.id}" title="edit the wording">✎</button>
        <button class="ghost-btn sm danger" data-act="idea-del" data-id="${i.id}" title="delete">✕</button>
      </span></div>${why}</article>`;
}
function renderIdeasFull() {
  const el = byId("ideasFull"); if (!el || el.hidden) return;
  ideasInit();
  const inbox = state.ideas.filter((i) => i.status === "inbox");
  const parked = state.ideas.filter((i) => i.status === "parked");
  const topics = state.ideaTopics.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const lanes = topics.map((t) => {
    const items = parked.filter((i) => i.topicId === t.id);
    if (!items.length) return "";
    return `<section class="idea-lane" style="--tc:${t.color}">
      <div class="idea-lane-head"><span class="idea-topic-dot" style="background:${t.color}"></span>${esc(t.name)} <span class="count">${items.length}</span></div>
      <div class="idea-lane-cards">${items.map(ideaCard).join("")}</div></section>`;
  }).join("");
  const orphan = parked.filter((i) => !ideaTopic(i.topicId));   // parked but topic was deleted -> show as unsorted
  el.innerHTML = `
    <div class="ibxf-head">
      <span class="drawer-kicker" style="color:var(--purple)">\u{1F4A1} Idea Parking Lot <small>random thoughts, not tasks</small></span>
      <div class="ibxf-head-actions">
        <button class="glow-btn" data-act="idea-sort" ${state.ideas.length ? "" : "disabled"} title="✦ Let Himmah sort your loose ideas into topics, with a reason for each">✦ Sort into topics</button>
        <button class="ghost-btn" data-act="idea-enrich" ${state.ideas.length ? "" : "disabled"} title="✦ Enhance + enrich each idea, one at a time (old → new, with a reason) - approve, edit, or skip each">✦ Enhance each</button>
        <button class="ghost-btn" data-act="idea-tidy" ${state.ideas.length >= 2 ? "" : "disabled"} title="✦ Himmah reviews ALL ideas together: merge overlaps, drop dead ones, or promote one to a task">✦ Tidy</button>
        <button class="ghost-btn" data-act="close-ideas-full" title="close">✕ Close</button>
      </div>
    </div>
    <div class="idea-capture">
      <span class="capture-bolt">\u{1F4A1}</span>
      <textarea id="ideaInput" rows="1" autocomplete="off" spellcheck="false" placeholder="park any random thought - a gift idea, a business spark, a packing item…  (Enter to park · Shift+Enter for a new line · one per line = many at once)"></textarea>
      <button class="glow-btn" data-act="idea-park">Park it</button>
    </div>
    <div id="ideaSortNudge" class="idea-nudge" hidden>✦ A few unsorted ideas are piling up - hit <b>Sort into topics</b> to file them.</div>
    ${(inbox.length || orphan.length) ? `<section class="idea-lane unsorted-lane"><div class="idea-lane-head"><span class="idea-topic-dot" style="background:#5a6373"></span>Unsorted <span class="count">${inbox.length + orphan.length}</span></div><div class="idea-lane-cards">${inbox.concat(orphan).map(ideaCard).join("")}</div></section>` : ""}
    ${lanes}
    ${(!inbox.length && !parked.length) ? `<div class="empty big">\u{1F4A1} Nothing parked yet.<br>Dump a random idea above - Himmah keeps it safe, away from your tasks, and sorts it for you.</div>` : ""}
    <div class="hist-note ibxf-foot">ideas live here, separate from your tasks · tip: type <code>/idea &lt;thought&gt;</code> in the main capture bar to park from anywhere · → Task promotes one</div>`;
  refreshIdeaCount();
}
function editIdea(id) {   // v7.3: a themed in-design editor (replaces the ugly native prompt())
  const i = ideaById(id); if (!i) return;
  const prior = document.querySelector(".idea-edit-overlay"); if (prior) prior.remove();
  const ov = document.createElement("div"); ov.className = "popup idea-edit-overlay"; ov.hidden = false;
  ov.innerHTML = `<div class="popup-card idea-edit-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">✎ edit idea</span><button class="ghost-btn" data-ie="cancel" title="close (Esc)">✕</button></div>
    <textarea class="idea-edit-ta" rows="3" maxlength="280">${esc(i.text)}</textarea>
    <div class="drawer-actions"><button class="glow-btn" data-ie="save">Save</button><button class="ghost-btn" data-ie="cancel">Cancel</button></div>
    <div class="hist-note">Enter to save · Shift+Enter for a new line · Esc to cancel</div></div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("open"));
  const ta = ov.querySelector(".idea-edit-ta");
  setTimeout(() => { if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 30);
  const close = () => { ov.classList.remove("open"); setTimeout(() => ov.remove(), 160); };
  const save = () => { const nv = ta.value.trim(); if (nv && nv !== i.text) { i.text = nv; i.updatedAt = nowIso(); scheduleSave(); renderIdeasFull(); } close(); };
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } else if (e.key === "Escape") { e.preventDefault(); close(); } });
  ov.addEventListener("click", (e) => { const b = e.target.closest("[data-ie]"); if (!b) return; b.dataset.ie === "save" ? save() : close(); });
}
function delIdea(id) {
  ideasInit();
  const i = ideaById(id); if (!i) return;
  state.ideas = state.ideas.filter((x) => x.id !== id);
  scheduleSave(); renderIdeasFull(); refreshIdeaCount(); toast("idea removed");
}
function activateIdea(id) {
  ideasInit();
  const i = ideaById(id); if (!i) return;
  const it = { id: uid("t"), type: "task", title: i.text, notes: i.reason ? ("from an idea · " + i.reason) : "from an idea",
    categoryId: null, importance: 1, urgency: { due: null, soon: false }, status: "inbox",
    nextAction: { if: "", then: "" }, estimateMins: null, projectId: null, subtaskIds: [], nextActionId: null,
    cadence: null, everyNDays: null, streak: 0, lastDone: null, history: [], inFocus: false, order: -1,
    createdAt: nowIso(), updatedAt: nowIso(), completedAt: null, fromIdeaId: i.id };
  state.items.push(it); normalizeOrders();
  i.linkedTaskId = it.id; i.status = "done"; i.updatedAt = nowIso();
  logOutcome({ kind: "idea_activate", item_id: it.id, decision: "accept", ai_proposed: null,
    my_final: { title: i.text }, my_reason: null, original_input: i.text });
  scheduleSave(); render(); renderIdeasFull(); refreshIdeaCount();
  toast("→ promoted to a task · it's in your Inbox");
}
async function sortIdeas() {
  ideasInit();
  const pool = state.ideas.filter((i) => i.status === "inbox" || i.status === "parked");
  if (!pool.length) { toast("No ideas to sort"); return; }
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ sorting needs AI - see Setup Guides"); return; }
  toast("✦ sorting your ideas…");
  let res;
  try { res = await aiFetch("idea_sort", { ideas: pool.map((i) => ({ id: i.id, text: i.text })), topics: state.ideaTopics.map((t) => t.name) }); }
  catch (e) { toast("⚠ " + e.message); return; }
  const results = (res && res.results) || [];
  let n = 0;
  results.forEach((r) => {
    const i = ideaById(r.id); if (!i) return;
    const t = ensureTopic(r.topic); if (!t) return;
    i.topicId = t.id; i.reason = String(r.reason || "").slice(0, 160); i.status = "parked"; i.updatedAt = nowIso(); n++;
  });
  logOutcome({ kind: "idea_sort", decision: "accept", call_id: lastCallId(),
    ai_proposed: { results }, my_final: { sorted: n }, my_reason: null, original_input: pool.map((i) => i.text).join(" | ") });
  scheduleSave(); renderIdeasFull(); refreshIdeaCount();
  toast(n ? `✦ sorted ${n} idea${n > 1 ? "s" : ""} into topics` : "✦ nothing to sort");
}
async function tidyIdeas() {
  ideasInit();
  const pool = state.ideas.filter((i) => i.status === "inbox" || i.status === "parked");
  if (pool.length < 2) { toast("Park a few more ideas first"); return; }
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ Tidy needs AI - see Setup Guides"); return; }
  toast("✦ reviewing your ideas…");
  let res;
  try { res = await aiFetch("idea_tidy", { ideas: pool.map((i) => ({ id: i.id, text: i.text, topic: (ideaTopic(i.topicId) || {}).name || "" })) }); }
  catch (e) { toast("⚠ " + e.message); return; }
  const sugg = ((res && res.suggestions) || []).filter((s) => s && s.action && Array.isArray(s.ids) && s.ids.length);
  if (!sugg.length) { toast("✦ your ideas look tidy already"); return; }
  _ideaTidyProposal = sugg;
  openIdeaTidyReview(sugg);
}
function _ideaTidyLabel(s) {
  const txt = (id) => { const i = ideaById(id); return i ? (i.text.length > 48 ? i.text.slice(0, 48) + "…" : i.text) : "(gone)"; };
  if (s.action === "edit") return `<b>Sharpen:</b> “${esc(txt(s.ids[0]))}” → “${esc(s.newText || "")}”`;
  if (s.action === "remove") return `<b>Drop:</b> “${esc(txt(s.ids[0]))}”`;
  if (s.action === "merge") return `<b>Merge ${s.ids.length}:</b> ${esc(s.ids.map(txt).join(" + "))} → “${esc(s.newText || "")}”`;
  if (s.action === "activate") return `<b>Promote to a task:</b> “${esc(txt(s.ids[0]))}”`;
  return esc(s.action);
}
function openIdeaTidyReview(sugg) {
  const prior = document.querySelector(".idea-tidy-overlay"); if (prior) prior.remove();
  const ov = document.createElement("div"); ov.className = "popup idea-tidy-overlay"; ov.hidden = false;
  ov.innerHTML = `<div class="popup-card idea-tidy-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">✦ Tidy your ideas <small>review each · nothing changes until you apply</small></span>
      <button class="ghost-btn" data-tidy="close">✕</button></div>
    <div class="idea-tidy-list">${sugg.map((s, k) => `<div class="idea-tidy-row" data-k="${k}">
      <div class="idea-tidy-what">${_ideaTidyLabel(s)}<div class="idea-why">✦ ${esc(s.reason || "")}</div></div>
      <div class="idea-tidy-acts"><button class="glow-btn sm" data-tidy="apply" data-k="${k}">Apply</button>
        <button class="ghost-btn sm" data-tidy="skip" data-k="${k}">Skip</button></div></div>`).join("")}</div>
    <div class="drawer-actions"><button class="glow-btn" data-tidy="apply-all">Apply all</button>
      <button class="ghost-btn" data-tidy="close">Done</button></div></div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("open"));
  const handled = new Set();   // v7.4 FIX: Apply-all used to RE-apply rows already applied (duplicate tasks from 'activate') and rows explicitly skipped
  const pendingSkips = new Map();   // v6.9.2: k -> suggestion; a Skip defers its reject log until the row's why-input blurs/Enters or the overlay closes (any path)
  const flushSkip = (kk) => {
    if (!pendingSkips.has(kk)) return;
    const s2 = pendingSkips.get(kk); pendingSkips.delete(kk);
    const inp = ov.querySelector(`.tidy-why[data-k="${kk}"]`);
    const val = inp ? inp.value.trim() : "";
    logOutcome({ kind: "idea_tidy", decision: "reject", ai_proposed: s2, my_final: null, my_reason: val || null });
    if (inp) inp.disabled = true;
  };
  ov._flushPending = () => { Array.from(pendingSkips.keys()).forEach(flushSkip); };   // v6.9.2: hook for the close button, apply-all, AND the global Esc handler
  const close = () => { ov._flushPending(); ov.classList.remove("open"); setTimeout(() => ov.remove(), 180); _ideaTidyProposal = null; };
  ov.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tidy]"); if (!b) return;
    const act = b.dataset.tidy;
    if (act === "close") { close(); return; }
    if (act === "apply-all") { (sugg || []).forEach((s, k) => { if (!handled.has(k)) { applyIdeaTidy(s); handled.add(k); } }); close(); toast("✦ ideas tidied"); return; }
    const k = +b.dataset.k; const s = sugg[k]; const row = ov.querySelector(`.idea-tidy-row[data-k="${k}"]`);
    if (handled.has(k)) return;
    if (act === "apply") { applyIdeaTidy(s); handled.add(k); if (row) { row.classList.add("done"); row.querySelector(".idea-tidy-acts").innerHTML = '<span class="idea-tidy-ok">✓ applied</span>'; } }
    if (act === "skip") {
      handled.add(k); pendingSkips.set(k, s);
      if (row) {
        row.classList.add("skipped");
        row.querySelector(".idea-tidy-acts").innerHTML = `<span class="idea-tidy-ok">skipped</span> <input class="tidy-why" data-k="${k}" placeholder="why not? (optional)" maxlength="160">`;
        const inp = row.querySelector(".tidy-why");
        if (inp) { setTimeout(() => inp.focus(), 20); inp.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); flushSkip(k); } }); inp.addEventListener("blur", () => flushSkip(k)); }
      }
    }
  });
}
function applyIdeaTidy(s) {
  ideasInit();
  const ids = s.ids || [];
  if (s.action === "edit") { const i = ideaById(ids[0]); if (i && s.newText) { i.text = String(s.newText).slice(0, 280); i.updatedAt = nowIso(); } }
  else if (s.action === "remove") { state.ideas = state.ideas.filter((x) => !ids.includes(x.id)); }
  else if (s.action === "merge") {
    const keep = ideaById(ids[0]);
    if (keep) { keep.text = String(s.newText || keep.text).slice(0, 280); keep.updatedAt = nowIso(); state.ideas = state.ideas.filter((x) => x.id === ids[0] || !ids.includes(x.id)); }
  } else if (s.action === "activate") { activateIdea(ids[0]); }
  logOutcome({ kind: "idea_tidy", decision: "accept", ai_proposed: s, my_final: s, my_reason: null });
  scheduleSave(); renderIdeasFull(); refreshIdeaCount();
}
// ---- v7.3: Enhance + Enrich EACH idea (separate from Tidy) - one at a time, numbered old->new, approve/edit/skip ----
let _ideaEnrichProps = null;
async function enrichIdeas() {
  ideasInit();
  const pool = state.ideas.filter((i) => i.status === "inbox" || i.status === "parked");
  if (!pool.length) { toast("Park an idea first"); return; }
  if (!aiStatus.enabled) { toast(aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ Enhance needs AI - see Setup Guides"); return; }
  toast("✦ enhancing your ideas…");
  let res;
  try { res = await aiFetch("idea_enrich", { ideas: pool.map((i) => ({ id: i.id, text: i.text, topic: (ideaTopic(i.topicId) || {}).name || "" })) }); }
  catch (e) { toast("⚠ " + e.message); return; }
  const byId2 = {}; ((res && res.suggestions) || []).forEach((s) => { if (s && s.id) byId2[s.id] = s; });
  const props = pool.map((i) => { const s = byId2[i.id]; return { id: i.id, old: i.text, next: (s && String(s.newText || "").trim()) || i.text, reason: (s && s.reason) || "" }; })
    .filter((p) => p.next && p.next !== p.old);   // only ideas the AI actually changed
  if (!props.length) { toast("✦ your ideas already read sharp"); return; }
  _ideaEnrichProps = props;
  openIdeaEnrichReview(0);
}
function openIdeaEnrichReview(k) {
  const props = _ideaEnrichProps; if (!props || !props.length) return;
  if (k >= props.length) { const prior = document.querySelector(".idea-enrich-overlay"); if (prior) { prior.classList.remove("open"); setTimeout(() => prior.remove(), 180); } _ideaEnrichProps = null; renderIdeasFull(); refreshIdeaCount(); toast("✦ done enhancing"); return; }
  const p = props[k];
  let ov = document.querySelector(".idea-enrich-overlay");
  if (!ov) { ov = document.createElement("div"); ov.className = "popup idea-enrich-overlay"; ov.hidden = false; document.body.appendChild(ov); requestAnimationFrame(() => ov.classList.add("open")); }
  ov.innerHTML = `<div class="popup-card idea-enrich-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--purple)">✦ Enhance &amp; enrich <small>${k + 1} / ${props.length} · nothing changes unless you approve</small></span>
      <button class="ghost-btn" data-en="close" title="close (Esc)">✕</button></div>
    <div class="ienr-body">
      <div class="ienr-old"><span class="ienr-tag">now</span><div class="ienr-txt">${esc(p.old)}</div></div>
      <div class="ienr-arrow">↓</div>
      <div class="ienr-new"><span class="ienr-tag new">enhanced</span><textarea class="ienr-ta" rows="3" maxlength="360">${esc(p.next)}</textarea></div>
      ${p.reason ? `<div class="idea-why ienr-why">✦ ${esc(p.reason)}</div>` : ""}
      <input class="ienr-reason" id="ienrReason" placeholder="why? (optional - teaches the AI your taste)" maxlength="200">
    </div>
    <div class="drawer-actions ienr-acts">
      <button class="glow-btn" data-en="approve">Approve ✓</button>
      <button class="ghost-btn" data-en="skip">Not now</button>
      <button class="ghost-btn" data-en="skip-all">Skip the rest</button>
    </div>
    <div class="hist-note">edit the text above before approving if you want · Enter to approve · Esc closes</div></div>`;
  const ta = ov.querySelector(".ienr-ta");
  setTimeout(() => { if (ta) ta.focus(); }, 30);
  const reasonVal = () => { const r = ov.querySelector("#ienrReason"); return r ? r.value.trim() : ""; };   // v6.9.2: the human's why, teaches taste
  const closeAll = () => { ov.classList.remove("open"); setTimeout(() => ov.remove(), 180); _ideaEnrichProps = null; renderIdeasFull(); refreshIdeaCount(); };
  const approve = () => {
    const i = ideaById(p.id); const finalText = (ta ? ta.value.trim() : p.next) || p.next;
    const edited = finalText !== p.next;
    if (i && finalText && finalText !== p.old) { i.text = finalText.slice(0, 360); i.updatedAt = nowIso(); }
    const reason = reasonVal(); const my_reason = reason ? (edited ? reason + " (hand-edited)" : reason) : (edited ? "hand-edited the enhancement" : null);
    logOutcome({ kind: "idea_enrich", decision: edited ? "edit" : "accept", ai_proposed: { old: p.old, newText: p.next, reason: p.reason }, my_final: { text: finalText }, my_reason });
    scheduleSave(); openIdeaEnrichReview(k + 1);
  };
  ov.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && e.target && e.target.classList.contains("ienr-ta")) { e.preventDefault(); approve(); } else if (e.key === "Enter" && e.target && e.target.classList.contains("ienr-reason")) { e.preventDefault(); } else if (e.key === "Escape") { e.preventDefault(); closeAll(); } };
  ov.onclick = (e) => {
    const b = e.target.closest("[data-en]"); if (!b) return;
    const act = b.dataset.en;
    if (act === "close") { closeAll(); return; }
    if (act === "skip-all") { const reason = reasonVal(); logOutcome({ kind: "idea_enrich", decision: "reject", ai_proposed: { old: p.old, newText: p.next }, my_final: null, my_reason: reason ? reason + " (skipped the rest)" : "skipped the rest" }); closeAll(); return; }
    if (act === "approve") { approve(); return; }
    if (act === "skip") { const reason = reasonVal(); logOutcome({ kind: "idea_enrich", decision: "reject", ai_proposed: { old: p.old, newText: p.next }, my_final: null, my_reason: reason || null }); openIdeaEnrichReview(k + 1); return; }
  };
}
// v6.4.12: Habits + Rhythms moved off the main page into topbar side-panels (main page = stats + focus + canvas).
function openHabits() { const p = byId("habitsPanel"); p.hidden = false; renderRhythms(); requestAnimationFrame(() => p.classList.add("open")); byId("scrim").hidden = false; maybeIntro("habits"); }
function closeHabits() { const p = byId("habitsPanel"); p.classList.remove("open"); byId("scrim").hidden = true; setTimeout(() => { if (!p.classList.contains("open")) p.hidden = true; }, 220); } // v6.7.1: a close-then-reopen within 220ms re-adds .open - don't let the stale timer hide the reopened panel
function openRhythms() { const p = byId("rhythmsPanel"); p.hidden = false; renderRituals(); requestAnimationFrame(() => p.classList.add("open")); byId("scrim").hidden = false; maybeIntro("rhythms"); }
function closeRhythms() { const p = byId("rhythmsPanel"); p.classList.remove("open"); byId("scrim").hidden = true; setTimeout(() => { if (!p.classList.contains("open")) p.hidden = true; }, 220); } // v6.7.1: a close-then-reopen within 220ms re-adds .open - don't let the stale timer hide the reopened panel
// v6.6.4: the stale-prune nudge moved off the main page into a topbar side-panel (main page = stats + focus + canvas/calendar).
function openTidy() { const p = byId("tidyPanel"); p.hidden = false; renderPruneNudge(); requestAnimationFrame(() => p.classList.add("open")); byId("scrim").hidden = false; maybeIntro("tidy"); }
function closeTidy() { const p = byId("tidyPanel"); p.classList.remove("open"); byId("scrim").hidden = true; setTimeout(() => { if (!p.classList.contains("open")) p.hidden = true; }, 220); } // v6.7.1: a close-then-reopen within 220ms re-adds .open - don't let the stale timer hide the reopened panel
// ---- B3 (v6.6.6): the Waiting tray (parked/blocked tasks live here, off the decluttered main screen) ----
function renderWaitingPanel() {
  const p = byId("waitingPanel"); const list = waitingList();
  const rows = list.map((i) => {
    const w = i.waitingOn || {}; const blk = w.type === "task" ? item(w.taskId) : null;
    const reason = w.type === "task" ? `blocked by <b>${esc(blk ? blk.title : "(missing task)")}</b>` : `waiting for <b>${esc(w.note)}</b>`;
    return `<div class="inbox-item wait-row">
      ${card(i, { metaRight: `<span class="chip wait on" title="why this is parked">${w.type === "task" ? "⛓ blocked" : "⏳ reply"}</span>` })}
      <div class="wait-why">${reason}
        <button class="ghost-btn sm" data-act="wait-clear" data-id="${i.id}" title="unblock now - return it to the focus pool">unblock</button></div>
    </div>`;
  }).join("");
  p.innerHTML = `<div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">waiting · ${list.length}</span>
     <span class="dh-btns"><button class="ghost-btn" data-act="waiting-help" title="What is the Waiting tray?">?</button><button class="ghost-btn" data-act="close-waiting">✕</button></span></div>
     <div class="hist-note">Parked tasks - blocked by another task or an external reply. They stay out of NOW until released.</div>
     <div class="inbox-cards">${list.length ? rows : `<div class="empty">Nothing waiting ✦</div>`}</div>`;
}
function openWaiting() { const p = byId("waitingPanel"); p.hidden = false; renderWaitingPanel(); requestAnimationFrame(() => p.classList.add("open")); byId("scrim").hidden = false; maybeIntro("waiting"); }
function closeWaiting() { const p = byId("waitingPanel"); p.classList.remove("open"); byId("scrim").hidden = true; setTimeout(() => { if (!p.classList.contains("open")) p.hidden = true; }, 220); } // v6.7.1: a close-then-reopen within 220ms re-adds .open - don't let the stale timer hide the reopened panel
function openWaitPicker(id) {
  const i = item(id); if (!i) return;
  if (i.status === "inbox") { toast("triage it first - give it a category"); return; } // v6.7.1: don't park an un-triaged inbox task (it would disappear from the Waiting tray)
  const curNote = i.waitingOn && i.waitingOn.type === "note" ? i.waitingOn.note : "";
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card wait-pop">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold)">park this task</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    ${taskPickField(id, "wait-task", (i.waitingOn && i.waitingOn.type === "task") ? i.waitingOn.taskId : "", "Blocked by another task")}
    <div class="wait-or">or</div>
    <label class="fld"><span>Waiting for a reply from...</span><input id="wait-note" placeholder="e.g. reply from Dr Ahmed" value="${esc(curNote)}" autocomplete="off"></label>
    <div class="drawer-actions"><button class="glow-btn" data-act="wait-save" data-id="${id}">Park it</button>${isWaiting(i) ? `<button class="ghost-btn" data-act="wait-clear" data-id="${id}">Unblock</button>` : ""}</div></div>`;
  p.hidden = false; requestAnimationFrame(() => { p.classList.add("open"); renderTaskPick("wait-task"); });
}
function applyWait(id) {
  const i = item(id); if (!i) return;
  if (i.status === "inbox") { toast("triage it first - give it a category"); return; } // v6.7.1: a parked inbox task has no board home and would vanish from the Waiting tray
  const tId = (byId("wait-task-val") || {}).value || ""; // v6.6.12: searchable picker's hidden input
  const note = ((byId("wait-note") || {}).value || "").trim();
  if (tId) i.waitingOn = { type: "task", taskId: tId };
  else if (note) i.waitingOn = { type: "note", note };
  else { toast("pick a task or type who you are waiting on"); return; }
  i.inFocus = false; touch(i); scheduleSave(); closePopup(); render();
  toast("⏳ parked - it will return when ready");
}
function clearWait(id) {
  const i = item(id); if (!i) return;
  i.waitingOn = null; touch(i); scheduleSave();
  if (!byId("popup").hidden) closePopup();
  render(); toast("✓ unblocked - back in the pool");
}
function openDoneToday() {
  const done = state.items.filter((i) => i.status === "done" && isToday(i.completedAt)).sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
  const rows = done.length ? done.map((i) => `<div class="pop-row"><span class="rcard-dot"></span><span class="pop-title">${esc(i.title)}</span><button class="ghost-btn sm" data-act="restore-item" data-id="${i.id}">restore</button></div>`).join("") : `<div class="empty">Nothing done yet today - go clear one ✦</div>`;
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card"><div class="drawer-head"><span class="drawer-kicker" style="color:#7cd99e">done today · ${done.length}</span><button class="ghost-btn" data-act="close-popup">✕</button></div><div class="pop-list">${rows}</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}
function closePopup() {
  const p = byId("popup"); p.classList.remove("open"); setTimeout(() => (p.hidden = true), 200);
  _scopePick = null; // v6.4.3: drop any pending series-scope callback
  if (_calzProposal && _calzProposal.schId) { // v6.6.10: dismissing the day-view = discard the whole plan (logged once; transient previews removed)
    const P = _calzProposal;
    logOutcome({ call_id: P.callId, item_id: null, kind: "calendarize", decision: "cancel", ai_proposed: { date: P.date, blocks: P.original }, my_final: null, change_log: P.changeLog, my_reason: "dismissed the day plan", task_overview: P.snapshot });
    document.querySelectorAll(".calz-eta-pop").forEach((x) => x.remove()); // v6.7.1: remove any body-appended duration/swap pops orphaned by the close (.calz-replace-pop also carries this class)
    _calzCleanup(); _calzProposal = null;
  }
  if (_dropPlan && _dropPlan.park && _dropPlan.park.length) { // B5: dismissing the review = implicit keep of the rest (logged as training data)
    const P = _dropPlan;
    P.park.forEach((it) => logOutcome({ call_id: null, item_id: it.id, kind: "overcommit", decision: "reject",
      ai_proposed: { action: "defer", weekEnd: P.weekEnd, weekBudget: P.budget }, my_final: { kept: true }, my_reason: "dismissed without deciding", original_input: it.title, task_overview: P.snapshot }));
    _dropPlan = null;
  }
  if (_enhClose) { const f = _enhClose; _enhClose = null; f(); } // keep enhance queues moving on dismiss
  if (_etaClose) { const f = _etaClose; _etaClose = null; f(); } // v6.6.14: settle a dismissed ETA proposal (no log, no apply)
  if (_parClose) { const f = _parClose; _parClose = null; f(); } // v6.6.36: settle a dismissed parallel proposal
  if (_triClose) { const f = _triClose; _triClose = null; f(); } // v6.6.15: a dismissed walkthrough triage = skip (advance)
  if (_schClose) { const f = _schClose; _schClose = null; f(); } // v6.6.15: a dismissed walkthrough calendar = skip (advance)
}

// urgency colour picker - change the hue of each level; applies everywhere live.
function openUrgColors() {
  applyUrgencyColors();
  const u = (state.meta.ui && state.meta.ui.urgencyColors) || {};
  const rows = [3, 2, 1, 0].map((n) => `
    <div class="pop-row urgcolor-row">
      <span class="urgcolor-sw" style="background:${IMP[n].color}; box-shadow:0 0 12px ${IMP[n].color}"></span>
      <span class="pop-title">${IMP[n].label}</span>
      <label class="urgcolor-pick" style="--c:${IMP[n].color}"><input type="color" data-urgcolor="${n}" value="${IMP[n].color}"></label>
      ${u[n] ? `<button class="ghost-btn sm" data-act="urg-color-reset" data-n="${n}" title="back to default">reset</button>` : `<span class="urgcolor-default">default</span>`}
    </div>`).join("");
  const p = byId("popup");
  p.innerHTML = `<div class="popup-card"><div class="drawer-head"><span class="drawer-kicker">urgency colors</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="pop-list">${rows}</div>
    <div class="hist-note">applies everywhere - cards, canvas zones, filters &amp; the stats bar.</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}
function setUrgColor(n, hex) {
  state.meta.ui = state.meta.ui || {};
  (state.meta.ui.urgencyColors = state.meta.ui.urgencyColors || {})[n] = hex;
  applyUrgencyColors(); scheduleSave(); render(); openUrgColors();
}
function resetUrgColor(n) {
  if (state.meta.ui && state.meta.ui.urgencyColors) delete state.meta.ui.urgencyColors[n];
  applyUrgencyColors(); scheduleSave(); render(); openUrgColors();
}

// ---------- events ----------
function ripple(e) {
  const b = e.target.closest(".glow-btn"); if (!b) return;
  const r = document.createElement("span"); r.className = "ripple";
  const rect = b.getBoundingClientRect();
  r.style.left = (e.clientX - rect.left) + "px"; r.style.top = (e.clientY - rect.top) + "px";
  b.appendChild(r); setTimeout(() => r.remove(), 600);
}
document.addEventListener("click", (e) => {
  if (_gpSuppressClick) { _gpSuppressClick = false; return; } // a drag just ended - don't treat its click as "open editor"
  ripple(e);
  if (e.target.closest(".card-title.editing")) return; // v6.5.11: don't dispatch while inline-renaming
  const a = e.target.closest("[data-act]"); if (!a) return;
  if (e.ctrlKey && a.dataset.act === "cal-ev" && !(_calzProposal && _calzProposal.schId)) { e.preventDefault(); calSelToggle(a.dataset.id); return; } // v6.4.4: ctrl+click selects, never opens. v6.7.1: never multi-select transient calendarize preview blocks (a later Delete would persist the rest)
  if (a.dataset.act === "edit" && e.target.closest(".card-title")) { // v6.6.35: a single click on the title now OPENS the editor (canvas + NOW bar); a double-click still renames (it cancels this timer). Clicking the card body opens instantly.
    const tid = a.dataset.id; clearTimeout(_titleOpenTimer); _titleOpenTimer = setTimeout(() => { if (!_renaming) openEditor(tid); }, 230); return;
  }
  const act = a.dataset.act, id = a.dataset.id;
  if (_calzProposal && _calzProposal.schId && (act === "cal-ev" || act === "cal-day-slot")) return; // v6.6.10: in the calendarize day-view, grid/block clicks must not open the event editor (it would discard the plan + could leak previews)
  const map = {
    "more-menu": () => toggleMoreMenu(), // v6.9.1: topbar "⋯ More" dropdown
    "capture": () => { addCapture(byId("captureInput").value); byId("captureInput").value = ""; },
    "toggle-done": () => toggleDone(id),
    "cycle-imp": () => cycleImp(id),
    "pin": () => togglePin(id),
    "edit": () => openEditor(id),
    "collapse-cat": () => toggleCollapse(id),
    "add-cat": () => addCategory(),
    "rename-cat": () => startRename(id),
    "recolor-cat": () => recolorCategory(id),
    "del-cat": () => delCategory(id),
    "close-drawer": () => closeEditor(),
    "save-drawer": () => saveDrawer(),
    "del-item": () => { const it = item(id); guardConfirmSacrifice(it, "delete", () => { if (confirm("Delete this item?")) { delItem(id); closeEditor(); } }); }, // v6.6.9: protected -> conscious trade-off first
    "open-history": () => openHistory(),
    "close-history": () => closeHistory(),
    "restore": () => openRestorePreview(id), // v6.6.21: preview the diff first
    "restore-confirm": () => restore(id), // v6.6.21: apply only after the owner sees what changes
    "open-archive": () => openArchive(),
    "open-calendar": () => { closeAllPanels(); openCalendar(); }, // v6.7.1: single-panel - close others first
    "close-calendar": () => closeCalendar(),
    "cal-prev": () => calShift(-1),
    "cal-next": () => calShift(1),
    "cal-today": () => calToday(),
    "cal-view-month": () => calSetView("month"),
    "cal-view-week": () => calSetView("week"),
    "cal-view-day": () => calSetView("day"),
    "cal-toggle-recur": () => { state.meta.ui = state.meta.ui || {}; state.meta.ui.calShowRecurInMonth = !state.meta.ui.calShowRecurInMonth; scheduleSave(); renderCalendar(); }, // v6.7.8: month-view only - show/hide repeating-series occurrences (week/day always show them)
    "cal-day-slot": () => openEventEditor(null, a.dataset.date, String(a.dataset.hour || "9").padStart(2, "0") + ":00"),
    "cal-add-ev": () => openEventEditor(null, null),
    "cal-day": () => openEventEditor(null, a.dataset.date),
    "cal-ev": () => openEventEditor(id),
    "ev-add-pause": () => { if (pauseSeries(a.dataset.series, byId("ev-pause-from").value, byId("ev-pause-to").value)) closePopup(); }, // v6.6.27
    "ev-unpause": () => { unpauseSeries(a.dataset.series, a.dataset.pause); closePopup(); }, // v6.6.27: resume a paused window
    "cal-sel-del": () => calSelDelete(),
    "cal-sel-clear": () => calSelClear(),
    "undo-restore": () => { const t = byId("undoToast"), fn = t._restore; if (fn) fn(); hideUndoToast(); }, // v6.5.7
    "mic": () => toggleVoiceCapture(), // v6.5.10
    "brain-dump": () => openBrainDump(), // v6.6.4 (A4)
    "import-file": () => openFileImport(), // v6.6.16: import PDF/txt/md/Word/csv into the Inbox
    "bd-add-all": () => brainDumpAddAll(),
    "prune-keep": () => { const i = item(id); if (i) { touch(i); scheduleSave(); render(); toast("kept - it's fresh again"); } }, // v6.5.9
    "prune-snooze": () => { const i = item(id); if (i) { i.pruneSnoozed = _dayShift(7); touch(i); scheduleSave(); render(); toast("snoozed 7 days"); } },
    "prune-archive": () => { const i = item(id); if (i) { i.status = "done"; i.completedAt = nowIso(); i.inFocus = false; clearFutureTaskEvents(i.id); const freed = releaseDependents(i.id); touch(i); scheduleSave(); render(); toast(freed.length ? `archived - freed ${freed.length} waiting task${freed.length > 1 ? "s" : ""}` : "archived - it's in History"); } }, // v6.7.1: archiving a blocker frees its dependents (matches toggleDone's one-way contract)
    "card-due": () => openCardDue(id, a), // v6.5.11
    "scope-pick": () => { if (_scopePick) _scopePick(a.dataset.scope); },
    "travel-nudge-dismiss": () => { state.meta.ui = state.meta.ui || {}; state.meta.ui.travelNudgeShown = _isod(new Date()); scheduleSave(); const b = byId("travelNudge"); if (b) b.remove(); },
    "cal-del-ev": () => calDeleteEvent(id),
    "cal-toggle-sch": () => calToggleSchedule(id),
    "cal-edit-sch": () => openScheduleEditor(id),
    "cal-add-sch": () => openScheduleEditor(null),
    "cal-del-sch": () => calDeleteSchedule(id),
    "cal-import": () => openIcsImport(),
    "cal-calendarize": () => calendarizeNextDay(),
    "cal-prefs-quiz": () => openCalzQuiz(), // v6.6.41: the calendarize-preferences quiz
    "calz-commit": () => calzCommit(), // v6.6.10: editable day-view
    "calz-cancel": () => calzCancel(),
    "calz-eta": () => calzEta(a.dataset.id),
    "calz-replace": () => calzReplace(a.dataset.id),
    "calz-undo": () => calzUndo(), // v6.6.32
    "calz-redo": () => calzRedo(), // v6.6.34
    "calz-focus": () => calzFocusBlock(a.dataset.id), // v6.6.19: jump the grid to a block from the left Scheduled list
    "calz-remove": () => calzRemove(a.dataset.id),
    "calz-cat-toggle": () => { const cid = a.dataset.cid; _calzHiddenCats.has(cid) ? _calzHiddenCats.delete(cid) : _calzHiddenCats.add(cid); _calzRerender(); }, // v6.6.13: show/hide a category in the day-view
    "cal-prayers": () => openPrayerPopulate(),
    "cal-prayer-upload": () => openPrayerUpload(),
    "ev-meet": () => genMeetLink(),
    "ev-meet-paste": () => pasteExistingMeet(), // v6.6.4: paste an existing Meet link (no setup)
    "ev-aidesc": () => genEventDescription(),
    "close-archive": () => closeArchive(),
    "restore-item": () => { restoreItem(id); if (!byId("popup").hidden) openDoneToday(); },
    "toggle-focus-expand": () => { focusExpanded = !focusExpanded; renderFocus(); },
    "focus-ai": () => refreshFocusAI(),
    "focus-drop": () => startOvercommitCheck(), // B5 (v6.6.7)
    "drop-accept": () => dropAccept(id),
    "drop-refuse": () => dropRefuse(id),
    "drop-accept-all": () => dropAcceptAll(),
    "view": () => { viewMode = a.dataset.mode; persistUi(); render(); },
    "filter-urg": () => { toggleSet(filterUrg, +a.dataset.n); render(); },
    "filter-cat": () => { toggleSet(filterCat, id); render(); },
    "clear-filters": () => { filterUrg.clear(); filterCat.clear(); render(); },
    "zoom-in": () => { zoom = Math.min(1.6, zoom * 1.1); persistCanvas(); render(); },
    "zoom-out": () => { zoom = Math.max(0.4, zoom * 0.9); persistCanvas(); render(); },
    "zoom-reset": () => { zoom = 1; panX = 0; panY = 0; persistCanvas(); render(); },
    "reset-layout": () => { if (state.meta.ui) state.meta.ui.zonePos = {}; panX = 0; panY = 0; zoom = 1; persistCanvas(); render(); },
    "canvas-cal-toggle": () => { state.meta.ui = state.meta.ui || {}; const cc = state.meta.ui.canvasCal = state.meta.ui.canvasCal || {}; cc.open = !cc.open; if (cc.open && !cc.date) cc.date = _isod(new Date()); scheduleSave(); render(); }, // v6.6
    "ccal-prev": () => _canvasCalShift(-1),
    "ccal-next": () => _canvasCalShift(1),
    "ccal-today": () => _canvasCalShift(0),
    "rhythm-done": () => markRhythmToday(id),
    "rhythm-queue": () => { const r = item(id); if (!r) return; if (!r.queued && r.protected) { guardConfirmSacrifice(r, "park", () => { r.queued = true; touch(r); scheduleSave(); render(); }); return; } r.queued = !r.queued; touch(r); scheduleSave(); render(); }, // v6.6.9: parking a protected habit is a conscious trade-off
    "toggle-protect": () => { const b = byId("e-protect"); if (!b) return; const on = b.dataset.on === "1" ? "0" : "1"; b.dataset.on = on; b.classList.toggle("on", on === "1"); b.querySelector(".shield-ico").textContent = on === "1" ? "⛨" : "⛊"; b.lastChild.textContent = on === "1" ? " protected" : " protect this"; },
    "open-guardian": () => { closeAllPanels(); openGuardian(); }, // v6.6.9; v6.7.1: single-panel - close others first
    "close-guardian": () => closeGuardian(),
    "guard-help": () => guardIntro(true), // v6.6.22: re-open the explainer any time (does not re-arm the one-time auto-show)
    "habits-help": () => panelHelp("habits", true), // v6.6.25: per-panel "?" explainers (reusable helpIntro)
    "rhythms-help": () => panelHelp("rhythms", true),
    "tidy-help": () => panelHelp("tidy", true),
    "waiting-help": () => panelHelp("waiting", true),
    "inbox-help": () => panelHelp("inbox", true),
    "guard-arm": () => openDealIntake({ trigger: null }),
    "guard-unprotect": () => { const it = item(id); if (it) { it.protected = false; guardSyncIndex(); touch(it); scheduleSave(); render(); renderGuardianPanel(); } },
    "guard-end-deal": () => { const d = guardActiveDeal(); if (d) { guardEndDeal(d); renderGuardianPanel(); toast("⛨ welcome back - all goods restored"); } },
    "guard-restore-one": () => { const d = guardActiveDeal(); if (d) { const e = d.plan.find((x) => x.id === id); if (e) { guardRestore(d, e); if (d.plan.filter((x) => x.mode !== "keep").every((x) => !item(x.id) || !x.resumeEventId || !(state.events || []).find((ev) => ev.id === x.resumeEventId))) { guardEndDeal(d); closePopup(); } else { saveNow(); render(); openGuardianResume(d); } } } },
    "guard-restore-all": () => { const d = guardActiveDeal(); if (d) { guardEndDeal(d); closePopup(); toast("⛨ welcome back - all goods restored"); } },
    "guard-extend": () => { const d = guardActiveDeal(); if (!d) return; const nd = _isod(new Date(Date.now() + 7 * 864e5)); d.returnDate = nd; (state.events || []).filter((ev) => ev.guardDealId === d.id).forEach((ev) => ev.date = nd); guardLedger("deal-start", { dealId: d.id, note: "extended to " + nd }); saveNow(); render(); renderCalendar(); applyGuardianAmbient(); closePopup(); toast("⛨ window extended to " + nd); },
    "add-rhythm": () => addRhythm(),
    "add-ritual": () => openRitualEditor(null),
    "ritual-edit": () => openRitualEditor(id),
    "ritual-missed": () => ritualMissToday(id, true),
    "ritual-unmiss": () => ritualMissToday(id, false),
    "ritual-downgrade": () => ritualDowngrade(id),
    "ritual-del": () => ritualDelete(id),
    "triage-inbox": () => triageInbox(),
    "open-inbox-full": () => openInboxFull(), // v6.6.5: full-screen inbox
    "close-inbox-full": () => closeInboxFull(),
    "open-ideas": () => { closeAllPanels(); openIdeas(); },              // v7.1.1: Idea Parking Lot
    "close-ideas-full": () => closeIdeasFull(),
    "ai-ideas": () => { closePopup(); openIdeas(); },
    "idea-park": () => { const inp = byId("ideaInput"); if (inp) { parkIdeas(inp.value); const ni = byId("ideaInput"); if (ni) { ni.value = ""; ni.focus(); } } },   // v7.4 FIX: re-query after the re-render - the old node is detached, so focus() was a no-op
    "idea-sort": () => sortIdeas(),
    "idea-tidy": () => tidyIdeas(),
    "idea-enrich": () => enrichIdeas(),   // v7.3: enhance+enrich each idea, numbered old->new review
    "idea-edit": () => editIdea(id),
    "idea-del": () => delIdea(id),
    "idea-activate": () => activateIdea(id),
    "ibx-sel": () => { _ibxSel.has(id) ? _ibxSel.delete(id) : _ibxSel.add(id); renderInboxFull(); },
    "ibx-sel-clear": () => { _ibxSel.clear(); renderInboxFull(); },
    "ibx-quickcat": () => { const it = item(id); if (it) { it.categoryId = a.dataset.cat; it.status = "active"; touch(it); normalizeOrders(); scheduleSave(); render(); refreshInboxCount(); toast("filed under " + (cat(a.dataset.cat) || {}).name); } },
    "ibx-bulk-cat": () => { const sel = byId("ibxf-catsel"); const cid = sel && sel.value; if (!cid) { toast("pick a category first"); return; } let k = 0; _ibxSel.forEach((sid) => { const it = item(sid); if (it) { it.categoryId = cid; it.status = "active"; touch(it); k++; } }); _ibxSel.clear(); normalizeOrders(); scheduleSave(); render(); refreshInboxCount(); toast(k + " filed under " + (cat(cid) || {}).name); },
    "ibx-bulk-imp": () => { const n2 = +a.dataset.n; let k = 0; _ibxSel.forEach((sid) => { const it = item(sid); if (it) { it.importance = n2; touch(it); k++; } }); scheduleSave(); render(); toast(k + " set to " + IMP[n2].label); },
    "ibx-bulk-del": () => { if (!_ibxSel.size || !confirm("Delete " + _ibxSel.size + " selected item(s)?")) return; const ids = [..._ibxSel]; _ibxSel.clear(); ids.forEach((sid) => delItem(sid)); normalizeOrders(); scheduleSave(); render(); refreshInboxCount(); toast(ids.length + " deleted"); },
    "tri-cat-ok": () => triageResolveCat(id, true),
    "tri-cat-no": () => triageResolveCat(id, false),
    "tri-urg-ok": () => triageResolveUrg(id, true),
    "tri-urg-no": () => triageResolveUrg(id, false),
    "tri-title-ok": () => triageResolveTitle(id, true),
    "tri-title-no": () => triageResolveTitle(id, false),
    "tri-all": () => triageAcceptAll(id),
    "inbox-enhance": () => enhanceInboxItem(id),
    "inbox-enrich": () => enrichInboxItem(id),
    "sched-yes": () => acceptSchedule(id),
    "sched-no": () => denySchedule(id),
    "toggle-group": () => { const k = "G:" + a.dataset.zk + "|" + a.dataset.gk; toggled.has(k) ? toggled.delete(k) : toggled.add(k); persistCanvas(); render(); },
    "toggle-zone": () => { const k = "Z:" + a.dataset.zk; toggled.has(k) ? toggled.delete(k) : toggled.add(k); persistCanvas(); render(); },
    "open-inbox": () => { closeAllPanels(); openInbox(); }, // v6.7.1: close any other open panel first so panels never stack (which left the shared scrim stuck)
    "close-inbox": () => closeInbox(),
    "open-habits": () => { closeAllPanels(); openHabits(); },
    "close-habits": () => closeHabits(),
    "open-rhythms": () => { closeAllPanels(); openRhythms(); },
    "close-rhythms": () => closeRhythms(),
    "open-tidy": () => { closeAllPanels(); openTidy(); }, // v6.6.4
    "close-tidy": () => closeTidy(),
    "open-waiting": () => { closeAllPanels(); openWaiting(); }, // B3 (v6.6.6)
    "close-waiting": () => closeWaiting(),
    "wait-open": () => openWaitPicker(id),
    "wait-save": () => applyWait(id),
    "wait-clear": () => clearWait(id),
    "open-donetoday": () => openDoneToday(),
    "close-popup": () => closePopup(),
    "urg-colors": () => openUrgColors(),
    "urg-color-reset": () => resetUrgColor(+a.dataset.n),
    "ai-menu": () => openAiMenu(),
    "naseer-toggle": () => naseerToggle(),                            // v7.1.4: the in-app assistant
    "naseer-close": () => naseerClose(),
    "naseer-send": () => naseerSend(),
    "naseer-mode": () => naseerToggleMode(),
    "naseer-do": () => naseerDoAction(+a.dataset.i),
    "naseer-skip": () => naseerSkipAction(+a.dataset.i),
    "voice-toggle": () => voiceToggle(),                              // v7.1.5: talk to Naseer
    "voice-mute": () => voiceMuteToggle(),
    "voice-stop": () => voiceStop(),
    "voice-detailed": () => voiceDetailedToggle(),                    // v7.3: detailed-thinking (no mid-sentence cutoff)
    "naseer-chats": () => naseerChatsMenu(),                          // v7.3: saved & temporary chats
    "naseer-newchat": () => naseerNewChat(),
    "naseer-newchat-go": () => naseerNewChatGo(),                     // v7.4: the themed confirm's Start-fresh
    "naseer-savechat": () => naseerSaveChat(),
    "naseer-loadchat": () => naseerLoadChat(a.dataset.id),
    "naseer-delchat": () => naseerDelChat(a.dataset.id),
    "naseer-log": () => naseerStartLog(),                             // v7.3: walk habits/rhythms/tasks + log them
    "naseer-log-ans": () => naseerLogAnswer(+a.dataset.i, a.dataset.v),
    "naseer-brief": () => naseerQuick("Brief me on today - what matters most, anything time-sensitive, and one suggestion to start. Keep it short."),
    "naseer-quick": () => naseerQuick(a.dataset.q || ""),
    "naseer-open-ai": () => { closePopup(); naseerOpen(); },
    "tour-next": () => tourNext(), // v6.7.3/.6: guided tour nav
    "tour-prev": () => tourPrev(),
    "tour-skip": () => tourEnd(false),
    "tour-skip-ch": () => { if (!_tourOv) return; const cur = _tourChapterAt(_tourI); let j = -1; for (let k = _tourI + 1; k < STEPS.length; k++) { if (STEPS[k].chIntro && STEPS[k].chIntro > cur) { j = k; break; } } _tourDetach(); _tourI = j < 0 ? STEPS.length - 1 : j; _tourPaint(); },   // v6.8: jump to the next chapter intro (or the finale)
    "tour-keep-demo": () => tourEnd(true),               // v6.7.8: finale "Keep exploring the demo" - keep the demo but mark tourDone so it does not re-launch
    "tour-nuclear": () => { tourEnd(true); nukeAndOnboard(); },
    "ai-nuclear": () => { if (a.dataset.armed) { closePopup(); nukeAndOnboard(); return; } a.dataset.armed = "1"; const t = a.querySelector("small"); if (t) t.textContent = "(sure? this wipes the demo to a clean page - tap again. Yusuf stays safe in History)"; a.classList.add("danger-armed"); setTimeout(() => { try { if (a && a.isConnected) { delete a.dataset.armed; const t2 = a.querySelector("small"); if (t2) t2.textContent = "(clear the demo, build YOUR life with AI - the tour\u2019s Nuclear option)"; a.classList.remove("danger-armed"); } } catch (e) {} }, 3200); },   // v6.10.0: the Nuclear/make-it-yours flow was ONLY reachable from the tour finale - a friend who skipped it was stranded with the demo forever   // v6.7.13: the finale Nuclear button - wipe Yusuf's life + everything you added, then build YOUR own via the onboarding chat
    "onb-send": () => _onbSend(),                         // v6.7.13 onboarding chat
    "onb-apply": () => _onbApply(),
    "onb-wrapup": () => { const ta = byId("onbInput"); if (ta) { ta.value = "That is everything for this part - please wrap up with what we have."; } _onbSend(); },   // v6.9: "I have enough - wrap this up" - sends the literal wrap-up phrase through the normal chat path
    "onb-skip": () => { const w = byId("onbStopWarn"); if (w) w.hidden = false; },   // v6.9: the X is now a two-step - first click shows an inline confirm strip instead of closing immediately
    "onb-skip-keep": () => { const w = byId("onbStopWarn"); if (w) w.hidden = true; },
    "onb-skip-confirm": () => _onbSkip(),
    "onb-guide-skip": () => { _onbGuideStop(); if (_onbOv) _onbOv.classList.remove("onb-mini"); _onbAdvance(); },   // v6.7.16 onboarding guide phase
    "onb-guide-next": () => { _onbGuideStop(); if (_onbOv) _onbOv.classList.remove("onb-mini"); _onbAdvance(); },   // v6.7.18 read-recap "got it"
    "onb-guide-do": () => { const st = ONBOARD[_onbI]; const g = st && st.guide; _onbGuideStop(); if (g && g.fb) { try { g.fb(); } catch (e) {} } if (_onbOv) _onbOv.classList.remove("onb-mini"); _onbAdvance(); },
    "onb-done": () => { try { state.meta = state.meta || {}; state.meta.onboardingDone = true; scheduleSave(); } catch (e) {} _onbDetach(); try { searchOpen(); toast("✦ This is Ctrl+K - your launchpad. Press Esc to dive in."); } catch (e) {} },   // v6.7.17: finale -> reveal the Ctrl+K aura
    "onb-stage-skip": () => { _onbAdvance(); },   // v6.7.20 #5: skip the current chat stage (so a budget-capped / offline friend is never wedged - the promised "or skip" is real)
    "tour-do": () => tourDo(), // v6.7.6: a "click" step's fallback (skip this / Next when target missing)
    "tour-make-yours": () => { tourEnd(true); openMakeYours(); }, // v6.7.6: tour -> AI-guided setup (kept; the standalone wizard still opens from the AI menu)
    "tour-ask-add":  () => _tourAskAdd(),                 // v6.7.8: inline make-it-yours round (posts to /api/life_add)
    "tour-chat-send": () => _tourChatSend(),              // v6.7.22: a turn of the inline AI conversation
    "tour-chat-add":  () => _tourChatAdd(),               // v6.7.22: apply the agreed items the chat drew out
    "tour-ask-skip": () => tourNext(),
    "tour-chat-skip": () => { if (a.dataset.armed) { tourNext(); return; } a.dataset.armed = "1"; a.textContent = "sure? tap again to skip"; setTimeout(() => { try { if (a && a.isConnected) { delete a.dataset.armed; a.textContent = "Skip this"; } } catch (e) {} }, 2600); },   // v6.9.3/v7.7.2 HARDENING: a chat card can only be skipped by a DELIBERATE double-tap (and never mid-request) - a stray click/Enter used to silently jump the whole conversation
    "tour-ask-eg":   () => { const ta = byId("tourAsk"); if (ta && a) { ta.value = a.dataset.eg || a.textContent; ta.focus(); } }, // a = the clicked .tour-eg chip
    "tour-clear-keep": () => { tourEnd(true); try { purgeDemoKeepMine(); } catch(e){ toast("⚠ " + e.message); } toast("✨ Yusuf's demo cleared - your Himmah is yours now. Bismillah."); },
    "my-next": () => _myNext(), // v6.7.6: "make it yours" wizard nav
    "my-prev": () => _myPrev(),
    "my-clear": () => _myClear(),
    "my-add": () => _myAddRound(),
    "my-skip": () => _myAdvance(),
    "my-finish": () => location.reload(),
    "my-close": () => { if (_myStep === 0 || confirm("Leave setup? Anything you've added so far is kept - you can finish from the ✦ menu later.")) closePopup(); },
    "start-tour": () => { closePopup(); startTour(); },
    "life-setup": () => { closePopup(); openMakeYours(); }, // v6.7.4/.6: AI onboarding (now the guided flow)
    "travel-toggle": () => toggleTravel(),
    "ai-triage": () => { closePopup(); openInbox(); triageInbox(); },
    "ai-groups": () => { closePopup(); aiFindGroups(); },
    "ai-digest": () => { closePopup(); aiDigest(); },
    "suggest-substeps": () => suggestSubsteps(),
    "add-subproject": () => { const p = item(editingId); if (!p) return; p.isMacro = true; if (byId("e-type")) byId("e-type").value = "macro"; const k = makeChildProject(p, "New sub-project"); state.items.push(k); touch(p); scheduleSave(); byId("e-extra").innerHTML = extraEditor(item(editingId)); toast("📂 now a macro project - add its sub-projects"); }, // v6.6.8
    "suggest-ifthen": () => suggestIfThen(),
    "ai-eta": () => estimateEta(id), // v6.6.2
    "ai-parallel": () => suggestParallel(id), // v6.6.36: AI suggests turning Parallel on (logged for training)
    "eta-ok": () => etaResolve(id, true), // v6.6.14: accept the in-row ETA proposal (uses the edited number)
    "eta-no": () => etaResolve(id, false), // v6.6.14: reject -> askWhy + log
    "apply-ai-all": () => applyAiAll(id), // v6.6.15: walk one task through the whole AI pipeline, approving each step
  };
  if (map[act]) { e.preventDefault(); map[act](); }
  if (act !== "more-menu" && a.closest("#moreMenu") && !(typeof _tourOv !== "undefined" && _tourOv)) closeMoreMenu(); // v6.9.1: picking a menu row closes the dropdown, like any other menu; v6.9.2 E3a: but not during the tour - _tourPaint closes it on the next card so the ring never sits over a half-closed menu
});
// drawer ✦ enhance buttons (delegated)
document.addEventListener("click", (e) => {
  const en = e.target.closest("[data-enh]");
  if (en) { e.preventDefault(); enhanceField(en.dataset.enh); }
});
// drawer sub-task interactions (delegated)
document.addEventListener("click", (e) => {
  const sd = e.target.closest("[data-sub-done]"); if (sd) { const s = item(sd.dataset.subDone); if (s) { s.status = s.status === "done" ? "active" : "done"; touch(s); scheduleSave(); byId("e-extra").innerHTML = extraEditor(item(editingId)); } }
  const sx = e.target.closest("[data-sub-del]"); if (sx) { delItem(sx.dataset.subDel); byId("e-extra").innerHTML = extraEditor(item(editingId)); }
  const nx = e.target.closest("[data-next]"); if (nx) { const p = item(editingId); if (p) { p.nextActionId = nx.dataset.next; scheduleSave(); } }
  const mt = e.target.closest("[data-macro-toggle]"); if (mt) { const lv = document.querySelector(`[data-leaves="${mt.dataset.macroToggle}"]`); if (lv) { lv.hidden = !lv.hidden; mt.textContent = lv.hidden ? "▸" : "▾"; } } // v6.6.8
  const os = e.target.closest("[data-open-sub]"); if (os) { openEditor(os.dataset.openSub); } // v6.6.8: drill into a sub-project
});
document.addEventListener("change", (e) => {
  if (e.target.id === "rhythm-budget") { state.meta = state.meta || {}; state.meta.rhythmBudget = Math.max(0, +e.target.value || 0); scheduleSave(); render(); }
  if (e.target.dataset && e.target.dataset.urgcolor != null) setUrgColor(+e.target.dataset.urgcolor, e.target.value);
  if (e.target.id === "e-cadence") { // show the per-week / per-month box only for that frequency
    const x = byId("e-freq-x"), y = byId("e-freq-y");
    if (x) x.hidden = e.target.value !== "weekly";
    if (y) y.hidden = e.target.value !== "monthly";
  }
});
// live swatch preview while dragging the native colour picker (before it commits on `change`)
document.addEventListener("input", (e) => {
  if (e.target.dataset && e.target.dataset.urgcolor != null) {
    const row = e.target.closest(".urgcolor-row"); if (!row) return;
    const sw = row.querySelector(".urgcolor-sw"); const pick = row.querySelector(".urgcolor-pick");
    if (sw) { sw.style.background = e.target.value; sw.style.boxShadow = "0 0 12px " + e.target.value; }
    if (pick) pick.style.setProperty("--c", e.target.value);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "captureInput") { addCapture(e.target.value); e.target.value = ""; }
  if (e.key === "Enter" && !e.shiftKey && e.target.id === "ideaInput") { e.preventDefault(); parkIdeas(e.target.value); const ni = byId("ideaInput"); if (ni) { ni.value = ""; ni.focus(); } } // v7.1.1 / v7.3 multi-drop; v7.4 FIX: re-query after re-render so typing can continue
  if (e.key === "Enter" && e.target.id === "e-subnew") {
    const p = item(editingId), v = e.target.value.trim(); if (p && v) {
      const sub = { id: uid("t"), type: "task", title: v, notes: "", categoryId: p.categoryId, importance: 1,
        urgency: { due: null, soon: false }, status: "active", nextAction: { if: "", then: "" }, estimateMins: null,
        projectId: p.id, subtaskIds: [], nextActionId: null, cadence: null, everyNDays: null, streak: 0,
        lastDone: null, history: [], inFocus: false, order: state.items.length + 1, createdAt: nowIso(), updatedAt: nowIso(), completedAt: null };
      state.items.push(sub); if (!p.nextActionId) p.nextActionId = sub.id;
      e.target.value = ""; scheduleSave(); byId("e-extra").innerHTML = extraEditor(p);
    }
  }
  if (e.key === "Enter" && e.target.id === "e-macnew") { // v6.6.8: add a sub-project under a macro
    const p = item(editingId), v = e.target.value.trim(); if (p && v) {
      p.isMacro = true; const k = makeChildProject(p, v); state.items.push(k);
      e.target.value = ""; touch(p); scheduleSave(); byId("e-extra").innerHTML = extraEditor(p);
    }
  }
  if (e.key === "Escape") { const mm = byId("moreMenu"); if (mm && !mm.hidden) { closeMoreMenu(); return; } if (!byId("inboxFull").hidden) { closeInboxFull(); return; } if (!byId("drawer").hidden) closeEditor(); if (!byId("historyPanel").hidden) closeHistory(); if (!byId("archivePanel").hidden) closeArchive(); if (!byId("inboxPanel").hidden) closeInbox(); if (!byId("habitsPanel").hidden) closeHabits(); if (!byId("rhythmsPanel").hidden) closeRhythms(); if (!byId("tidyPanel").hidden) closeTidy(); if (!byId("waitingPanel").hidden) closeWaiting(); if (!byId("guardianPanel").hidden) closeGuardian(); if (!byId("popup").hidden) closePopup(); }
});
byId("scrim") && byId("scrim").addEventListener("click", () => { closeEditor(); closeHistory(); closeArchive(); closeInbox(); closeHabits(); closeRhythms(); closeTidy(); closeWaiting(); closeGuardian(); });
byId("popup") && byId("popup").addEventListener("click", (e) => { if (e.target === byId("popup")) closePopup(); });

// ---------- drag to move + reorder (within a category, or across) ----------
let dragId = null;
function normalizeOrders() {
  // order is the source of truth inside a lane (drag-defined). Renumber per category.
  const groups = {};
  state.items.forEach((i) => { (groups[i.categoryId || "_"] = groups[i.categoryId || "_"] || []).push(i); });
  Object.values(groups).forEach((arr) => {
    arr.sort((a, b) => a.order - b.order);
    arr.forEach((it, ix) => (it.order = ix + 1));
  });
}
const clearDrag = () => document.querySelectorAll(".drop-hi,.drag-over,.ccal-drop-hi").forEach((x) => x.classList.remove("drop-hi", "drag-over", "ccal-drop-hi")); // v6.6.1: also clear the rail drop highlight on cancel
document.addEventListener("dragstart", (e) => {
  const c = e.target.closest(".card"); if (!c) return;
  dragId = c.dataset.id; e.dataTransfer.effectAllowed = "move";
  try { e.dataTransfer.setData("text/plain", dragId); } catch (_) {}
  c.classList.add("dragging");
});
document.addEventListener("dragend", (e) => {
  const c = e.target.closest(".card"); if (c) c.classList.remove("dragging");
  clearDrag(); dragId = null;
});
document.addEventListener("dragover", (e) => {
  if (!dragId) return;
  const rail = e.target.closest(".canvas-cal-rail"); // v6.6.2: allow dropping a task anywhere on the calendar rail
  if (rail) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; /* v6.6.3: must match effectAllowed="move" or the browser cancels the drop (no drop event fires) */ const g = e.target.closest("[data-timegrid]"); document.querySelectorAll(".ccal-drop-hi").forEach((x) => x.classList.remove("ccal-drop-hi")); if (g) g.classList.add("ccal-drop-hi"); return; }
  document.querySelectorAll(".ccal-drop-hi").forEach((x) => x.classList.remove("ccal-drop-hi"));
  const zone = e.target.closest(".focus,.zone"); if (!zone) return;
  e.preventDefault(); e.dataTransfer.dropEffect = "move";
  const tcard = e.target.closest(".card");
  document.querySelectorAll(".card.drag-over").forEach((x) => x.classList.remove("drag-over"));
  if (tcard && tcard.dataset.id !== dragId) tcard.classList.add("drag-over");
});
document.addEventListener("dragenter", (e) => {
  if (!dragId) return;
  const zone = e.target.closest(".focus,.zone"); if (!zone) return;
  document.querySelectorAll(".drop-hi").forEach((x) => x.classList.remove("drop-hi"));
  zone.classList.add("drop-hi");
});
document.addEventListener("drop", (e) => {
  if (!dragId) return;
  const rail = e.target.closest(".canvas-cal-rail"); // v6.6.2: drop a task onto the canvas calendar -> confirm a time block
  if (rail) {
    e.preventDefault(); const i = item(dragId); dragId = null;
    document.querySelectorAll(".ccal-drop-hi").forEach((x) => x.classList.remove("ccal-drop-hi"));
    if (!i) return;
    const onGrid = e.target.closest(".canvas-cal-rail [data-timegrid]");
    let mins = 9 * 60; // dropped off the grid (e.g. the header) -> default 09:00
    if (onGrid) { const rect = onGrid.getBoundingClientRect(); mins = Math.max(0, Math.min(24 * 60 - 15, Math.round((e.clientY - rect.top) / DAY_HOUR_H * 60 / 15) * 15)); }
    const ds = (onGrid && onGrid.dataset.date) || (state.meta.ui && state.meta.ui.canvasCal && state.meta.ui.canvasCal.date) || _isod(new Date());
    confirmCanvasBlock(i, ds, mins);
    return;
  }
  const zone = e.target.closest(".focus,.zone"); if (!zone) return;
  e.preventDefault();
  const i = item(dragId); if (!i) { dragId = null; return; }
  if (zone.classList.contains("focus")) {
    i.inFocus = true; if (i.status === "inbox") i.status = "active";
  } else {
    const zk = zone.dataset.zonekey || "";
    const grp = e.target.closest(".zgroup");
    let gkey = null;
    if (grp) { const head = grp.querySelector(".zgroup-head"); if (head && head.dataset.gk) gkey = head.dataset.gk; } // v6.7.1: the template emits data-gk (the bare group key) - was reading a non-existent data-grp, so dropping into a nested group never set the category/importance
    if (viewMode === "urgency") {
      if (zk.startsWith("urg")) i.importance = +zk.slice(3);          // zone = urgency level
      if (gkey) { const c = cat(gkey); if (c) i.categoryId = c.id; }  // nested group = category
    } else {
      if (zk) i.categoryId = zk;                                       // zone = category
      if (gkey && gkey.startsWith("imp")) i.importance = +gkey.slice(3); // nested group = urgency
    }
    if (i.status !== "active") i.status = "active";
    const tcard = e.target.closest(".card");
    if (tcard && tcard.dataset.id !== dragId) {
      const tg = item(tcard.dataset.id);
      if (tg) { const r = tcard.getBoundingClientRect(); i.order = tg.order + (e.clientY > r.top + r.height / 2 ? 0.5 : -0.5); }
    } else { i.order = -1; }
  }
  touch(i); normalizeOrders(); scheduleSave(); render();
  if (!prefersReduced()) setTimeout(() => { const el = document.querySelector(`.card[data-id="${i.id}"]`); if (el) el.classList.add("materialize"); }, 20);
  dragId = null;
});

// new-day check: "done today" auto-clears when the date rolls over - no timer, just
// a re-render whenever you return to the app (zero CPU when idle).
let _lastDay = new Date().toISOString().slice(0, 10);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _lastDay) { _lastDay = today; }
  render(); // cheap; refreshes "done today", due chips, etc.
});

// ---------- ambient glow follows the cursor; changes color on click ----------
const TINTS = ["#4a8fff", "#b06bff", "#e068ff", "#62e3ff", "#7cd99e", "#f5c46f"];
let _tintIdx = 1, _ptrRAF = 0, _ptrX = 50, _ptrY = 30;
function setTint(color) { // v6.6.17 (perf): no-op when unchanged - --tint has a 0.6s INHERITED transition, so a redundant set restarts a style-recalc storm across the whole subtree on every editor open / empty click
  if (!color) return; const r = document.documentElement.style;
  if (r.getPropertyValue("--tint") === color) return; // compare the inline value, not getComputedStyle (which is the mid-transition colour)
  r.setProperty("--tint", color);
}
function applyCursor() { _ptrRAF = 0; const r = document.documentElement.style; r.setProperty("--mx", _ptrX + "%"); r.setProperty("--my", _ptrY + "%"); }
window.addEventListener("pointermove", (e) => {
  _ptrX = (e.clientX / window.innerWidth) * 100; _ptrY = (e.clientY / window.innerHeight) * 100;
  if (!_ptrRAF) _ptrRAF = requestAnimationFrame(applyCursor); // rAF-throttled → cheap, idle = 0
}, { passive: true });
window.addEventListener("pointerdown", (e) => {
  const d = document.createElement("div"); d.className = "click-pulse";  // satisfying click pulse (rapid clicks ok)
  d.style.left = e.clientX + "px"; d.style.top = e.clientY + "px";
  document.body.appendChild(d); setTimeout(() => d.remove(), 460);
  if (e.target.closest("button, input, textarea, select, a, .card, .zone, .stat, .rhythm-card, .chip, .seg, .topbar, .capture, .popup-card, .drawer, .side-panel")) return; // recolor only on empty space
  _tintIdx = (_tintIdx + 1) % TINTS.length; setTint(TINTS[_tintIdx]);
});

// ===== v6.7.4: AI onboarding - interview the new user, then the flagship model builds + classifies their starting life =====
const LIFE_Q = [
  { id: "who", q: "First - who are you? Your studies, your work, what fills your days." },
  { id: "goals", q: "What are you working toward right now? Any projects or goals on your mind?" },
  { id: "day", q: "Walk me through a normal day for you, roughly." },
  { id: "routines", q: "Which routines do you keep? For each, do you have to PUSH yourself - or does it just happen on its own?" },
  { id: "faith", q: "Your faith practice - any daily or weekly acts of worship? (leave blank if that's not for you)" },
  { id: "you", q: "Last one: morning person or night owl? More structured, or go-with-the-flow?" },
];
function openLifeSetup() {
  const p = byId("popup");
  const items = LIFE_Q.map((q, i) => `<div class="ls-item">
    <label class="ls-q"><span class="ls-n">${i + 1}</span><span>${esc(q.q)}</span></label>
    <textarea class="ls-a" data-ls="${q.id}" rows="2" placeholder="type as much or as little as you like…"></textarea></div>`).join("");
  const aiOff = !(aiStatus && aiStatus.enabled);
  p.innerHTML = `<div class="popup-card ls-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold,#f5c46f)">✨ set up my life</span><button class="ghost-btn" id="lsDismiss">✕</button></div>
    <div class="cq-intro">Tell me about your life and I'll build your starting tasks, habits and rhythms - sorting what takes willpower (a <b>habit</b>) from what just happens (a <b>rhythm</b>), and worship done with intention (an <b>islamic rhythm</b>). This replaces the demo (it stays in History).${aiOff ? " <b>Needs your DeepSeek key</b> - see the setup guide in the folder." : ""}</div>
    <div class="ls-list">${items}</div>
    <div class="drawer-actions"><button class="glow-btn" id="lsGo">✨ Build my Himmah</button></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  byId("lsDismiss").addEventListener("click", () => closePopup());
  byId("lsGo").addEventListener("click", _lifeSubmit);
}
async function _lifeSubmit() {
  if (!(aiStatus && aiStatus.enabled)) { toast(aiStatus && aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ this needs your DeepSeek key - see the setup guide"); return; }
  const answers = LIFE_Q.map((q) => ({ q: q.q, a: ((document.querySelector('.ls-a[data-ls="' + q.id + '"]') || {}).value || "").trim() })).filter((x) => x.a);
  if (answers.length < 2) { toast("tell me a little more first - a couple of answers is enough"); return; }
  const go = byId("lsGo"); if (go) { go.disabled = true; go.textContent = "✨ building your Himmah…"; }
  const now = new Date();
  let res;
  try { res = await fetch("/api/life_setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers, today: _isod(now), weekday: CAL_FULLDOW[now.getDay()] }) }).then((r) => r.json()); }
  catch (e) { toast("⚠ " + e.message); if (go) { go.disabled = false; go.textContent = "✨ Build my Himmah"; } return; }
  if (res && res.status) { Object.assign(aiStatus, res.status); renderAiChip(); }
  if (!res || !res.ok) { toast("⚠ " + ((res && res.error) || "setup failed - try again")); if (go) { go.disabled = false; go.textContent = "✨ Build my Himmah"; } return; }
  _lifeResult(res);
}
function _lifeResult(res) {
  const c = res.counts || {}, p = byId("popup");
  p.innerHTML = `<div class="popup-card ls-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold,#f5c46f)">✨ your Himmah is ready</span></div>
    ${res.persona ? `<div class="eta-why" style="font-style:normal">${esc(res.persona)}</div>` : ""}
    <ul class="cq-rules">
      <li><b>${c.tasks || 0}</b> tasks${c.projects ? ` + <b>${c.projects}</b> project${c.projects > 1 ? "s" : ""}` : ""} across <b>${c.categories || 0}</b> categories</li>
      <li><b>${c.habits || 0}</b> habits - the things you push yourself to keep</li>
      <li><b>${c.rhythms || 0}</b> rhythms + <b>${c.islamic_rhythms || 0}</b> islamic rhythms - what flows on its own</li>
    </ul>
    <div class="cq-intro">Edit, add or delete anything - it's yours now. The demo is safe in History if you ever want it back.</div>
    <div class="drawer-actions"><button class="glow-btn" id="lsDone">✓ Take me in</button></div>`;
  byId("lsDone").addEventListener("click", () => location.reload());
  toast("✨ welcome to your Himmah");
}
// ===== v6.7.6: AI-GUIDED "make it yours". After the tour, gently clear Yusuf's demo, then build the user's
// OWN life one warm question at a time - each answer POSTs to /api/life_add and the AI turns it into real
// items for that round (tasks -> habits -> rhythms -> repeating events). Beginner-paced; every round is skippable. =====
const MAKE_YOURS = {
  intro: `Beautiful - you've seen how Himmah works. Now we'll make it <i>yours</i>. I'll ask a handful of gentle questions, and after each one the AI turns your words into real items you can keep or change. You don't need to be organised or have it all figured out - just answer like you're talking to a friend. There are no wrong answers here.`,
  clear: `First, let's clear Yusuf's demo so you're starting on a clean, calm page. Tap <b>Clear the demo</b> and his sample tasks disappear from view - don't worry, nothing is truly lost, it all stays in your <b>History</b> if you ever want to peek back. A blank page can feel a little daunting, but we're about to fill it with <i>your</i> life, one easy answer at a time.`,
  rounds: [
    { key: "tasks", label: "what's on your plate",
      q: `What's actually on your plate right now? Just brain-dump everything bouncing around in YOUR head - errands, deadlines, that thing you keep meaning to do, the big project you're chipping away at. Don't sort it, don't filter it, just let it pour out.`,
      helper: `A <b>task</b> is a single doable thing ("book the dentist"); a <b>project</b> is a bigger goal made of many tasks ("launch my app"). Mention both and I'll split the big ones into steps. Nothing comes to mind? That's completely fine - skip it and add things whenever they occur to you.` },
    { key: "habits", label: "what you're building",
      q: `Now, what are you trying to build into your daily life - things you have to push yourself to do? Maybe reading Quran each morning, the gym, or studying Arabic. What do YOU want to become more consistent at?`,
      helper: `A <b>habit</b> takes willpower, and Himmah tracks your streak so you can watch it grow. Not sure if something's a habit or a rhythm? Just say it - I'll sort it, and you can move anything later. Nothing comes to mind? That's completely fine - skip it.` },
    { key: "rhythms", label: "what flows on its own",
      q: `And what flows almost on its own - the gentle background rhythms of your day and your worship? Think sunlight, sleeping on time, your morning and evening adhkar, Surah al-Kahf on Friday. The things you'd like to simply notice in YOUR week.`,
      helper: `A <b>rhythm</b> runs nearly automatically; an <b>islamic rhythm</b> is worship woven naturally into your day. Himmah only quietly notices a miss, it never nags. Not sure where something belongs? Just say it and I'll sort it. Nothing comes to mind? Skip it.` },
    { key: "events", label: "the shape of your week",
      q: `Last one - what repeats on your calendar each week? Your prayer times, work shifts, classes, your halaqa, family time. Anything in YOUR week that happens again and again.`,
      helper: `These become <b>repeating calendar events</b> - the fixed walls your week gets planned around. Don't know exact times, or your week's a bit messy? Rough is fine - "work mornings, class Tuesday evenings" - and you can pin down the details later. Nothing comes to mind? Skip it.` },
  ],
  final: `That's it - your Himmah is alive with <i>your</i> tasks, habits, rhythms, and the shape of your week. It won't be perfect yet, and that's completely okay; you'll nudge and tweak it as you go, and Himmah learns your style the more you use it. Start small - just look at your NOW bar and pick one thing. You've got this, and Himmah's got your back. Bismillah.`,
};
let _myStep = 0, _myBusy = false;       // 0=intro, 1=clear, 2..(2+rounds-1)=rounds, last=final
function openMakeYours() { _myStep = 0; _myBusy = false; _myRender(); }
function _myRoundIdx() { return _myStep - 2; }
function _myRender() {
  const p = byId("popup"), total = MAKE_YOURS.rounds.length + 3, last = total - 1;
  const aiOff = !(aiStatus && aiStatus.enabled);
  const aiNote = `<div class="my-ainote">✦ This part is guided by AI, so it needs your DeepSeek key. The <b>setup guide</b> in your Himmah folder gets you running in about 2 minutes - then run this any time from the ✦ menu (<i>"Make it yours"</i>).</div>`;
  let head = "🌙 make it yours", body;
  if (_myStep === 0) {
    body = `<div class="cq-intro">${MAKE_YOURS.intro}</div>${aiOff ? aiNote : ""}
      <div class="drawer-actions"><button class="ghost-btn" data-act="my-close">Maybe later</button><span class="tour-spacer"></span><button class="glow-btn" data-act="my-next">Let's begin →</button></div>`;
  } else if (_myStep === 1) {
    body = `<div class="cq-intro">${MAKE_YOURS.clear}</div>
      <div class="drawer-actions"><button class="ghost-btn" data-act="my-prev">← Back</button><span class="tour-spacer"></span><button class="glow-btn" data-act="my-clear">Clear the demo ✦</button></div>`;
  } else if (_myStep >= 2 && _myStep < 2 + MAKE_YOURS.rounds.length) {
    const ri = _myRoundIdx(), rnd = MAKE_YOURS.rounds[ri];
    body = `<div class="my-round-n"><span class="my-dots">${MAKE_YOURS.rounds.map((_, k) => `<i class="${k < ri ? "done" : (k === ri ? "now" : "")}"></i>`).join("")}</span> ${esc(rnd.label)}</div>
      <div class="my-q">${rnd.q}</div>
      <textarea id="myAnswer" class="ls-a my-ta" rows="4" placeholder="type as much or as little as you like - or leave it blank to skip"></textarea>
      <div class="my-helper">${rnd.helper}</div>${aiOff ? aiNote : ""}
      <div class="drawer-actions"><button class="ghost-btn" data-act="my-skip">Skip this</button><span class="tour-spacer"></span><button class="glow-btn" data-act="my-add" id="myAddBtn">Add these →</button></div>`;
  } else {
    head = "🌙 your Himmah is alive";
    body = `<div class="cq-intro">${MAKE_YOURS.final}</div>
      <div class="drawer-actions"><span class="tour-spacer"></span><button class="glow-btn" data-act="my-finish">Enter my Himmah ✓</button></div>`;
  }
  p.innerHTML = `<div class="popup-card my-card">
    <div class="drawer-head"><span class="drawer-kicker" style="color:var(--gold,#f5c46f)">${head}</span>${_myStep === last ? "" : `<button class="ghost-btn" data-act="my-close">✕</button>`}</div>
    ${body}</div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
  const ta = byId("myAnswer"); if (ta) ta.focus();
}
function _myNext() { _myStep++; _myRender(); }
function _myPrev() { if (_myStep > 0) { _myStep--; _myRender(); } }
async function _myClear() {
  const b = document.querySelector('[data-act="my-clear"]'); if (b) { b.disabled = true; b.textContent = "clearing…"; }
  try { await clearAll(); } catch (e) { toast("⚠ couldn't clear - is the server running?"); if (b) { b.disabled = false; b.textContent = "Clear the demo ✦"; } return; }
  _myStep = 2; _myRender();
  toast("✨ clean slate - now let's fill it with your life");
}
function _myAdvance() { _myStep++; _myRender(); }
async function _myAddRound() {
  if (_myBusy) return;
  const rnd = MAKE_YOURS.rounds[_myRoundIdx()];
  const ans = ((byId("myAnswer") || {}).value || "").trim();
  if (!ans) { _myAdvance(); return; }                       // empty = a gentle skip
  if (!(aiStatus && aiStatus.enabled)) { toast(aiStatus && aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ this needs your DeepSeek key - see the setup guide, or press Skip"); return; }
  const btn = byId("myAddBtn"); if (btn) { btn.disabled = true; btn.textContent = "✦ reading your answer…"; }
  _myBusy = true;
  const now = new Date();
  let res;
  try { res = await fetch("/api/life_add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ round: rnd.key, answer: ans, today: _isod(now), weekday: CAL_FULLDOW[now.getDay()] }) }).then((r) => r.json()); }
  catch (e) { _myBusy = false; toast("⚠ " + e.message); if (btn) { btn.disabled = false; btn.textContent = "Add these →"; } return; }
  _myBusy = false;
  if (res && res.status) { Object.assign(aiStatus, res.status); renderAiChip(); }
  if (!res || !res.ok) { toast("⚠ " + ((res && res.error) || "couldn't add that - try again, or Skip")); if (btn) { btn.disabled = false; btn.textContent = "Add these →"; } return; }
  const a = res.added || {}, bits = [];
  const add = (n, one, many) => { if (n) bits.push(n + " " + (n > 1 ? (many || one + "s") : one)); };
  add(a.tasks, "task"); add(a.projects, "project"); add(a.habits, "habit");
  add(a.rhythms, "rhythm"); add(a.islamic_rhythms, "islamic rhythm"); add(a.events, "repeating event");
  toast(bits.length ? "✓ added " + bits.join(", ") : "✓ noted");
  _myAdvance();
}
// v6.7.6: wipe the demo to a clean, neutral starting page (snapshotted server-side, so it's undoable from History).
async function clearAll() {
  state.items = [];
  state.rhythms = [];
  state.events = (state.events || []).filter((e) => false); // empty, fresh calendar
  state.categories = [
    { id: "c_work", name: "Work", color: "#4a8fff", order: 0, collapsed: false },
    { id: "c_personal", name: "Personal", color: "#22C55E", order: 1, collapsed: false },
    { id: "c_learning", name: "Learning", color: "#A855F7", order: 2, collapsed: false },
    { id: "c_health", name: "Health", color: "#F472B6", order: 3, collapsed: false },
  ];
  state.schedules = [
    { id: "sch_tasks", name: "Tasks", color: "#f5c46f", hidden: false },
    { id: "sch_prayer", name: "Prayer", color: "#FACC15", hidden: false },
  ];
  state.meta = state.meta || {};
  state.meta.demo = false;        // no longer the shipped demo
  state.meta.tourDone = true;     // the tour brought them here
  state.meta.guardian = { protectedIds: [], deal: null, ledger: [] };
  state.meta.ui = state.meta.ui || {};
  if (state.meta.ui.canvasCal) state.meta.ui.canvasCal.open = false;
  if (typeof toggled !== "undefined" && toggled.clear) toggled.clear();
  await saveNow();                // PUT /api/state -> server snapshots the demo FIRST, then writes the clean state
  renderNow();
}
// ===== v6.7.6: ACTION-DRIVEN guided tour. "click" steps highlight ONE real button (every other click blocked) and
// advance only when the user clicks it - so they learn where things are and actually DO each thing. "read" steps block
// all clicks and advance with Next. Copy can be overridden by TOUR_COPY (designed for total beginners). =====
const _q = (s) => { try { return typeof s === "function" ? s() : document.querySelector(s); } catch (e) { return null; } };
const _cctoggle = () => { state.meta.ui = state.meta.ui || {}; const cc = state.meta.ui.canvasCal = state.meta.ui.canvasCal || {}; cc.open = !cc.open; if (cc.open && !cc.date) cc.date = _isod(new Date()); scheduleSave(); render(); };
// v6.9: force every category lane + importance group OPEN so the canvas is never seen empty (the card-25 break). NOTE: a plain
// toggled.clear() does NOT do this - zoneOpen()/groupOpen() are an XOR against a DEFAULT that is CLOSED for every category zone
// (defaultZoneOpen only defaults urg2/urg3 open) and for imp0/imp1 groups (defaultGroupOpen only defaults imp2/imp3 open), so
// clearing toggled actually COLLAPSES a category board with no prior manual opens - verified empirically against the live app.
// The correct fix is to ADD the "open" keys (a default-false zone/group is open exactly when its key IS in `toggled`).
function _tourExpandLanes() {
  try {
    (state.categories || []).forEach((c) => {
      toggled.add("Z:" + c.id);              // category-view zone (default CLOSED)
      toggled.add("G:" + c.id + "|imp1");     // category-view importance group (default CLOSED except imp2/imp3)
      toggled.add("G:" + c.id + "|imp0");
      toggled.add("G:urg0|" + c.id);          // urgency-view per-category sub-group (gkey is a category id here, so defaultGroupOpen's imp2/imp3 check never matches - ALL urgency sub-groups default CLOSED)
      toggled.add("G:urg1|" + c.id);
      toggled.add("G:urg2|" + c.id);
      toggled.add("G:urg3|" + c.id);
    });
    toggled.add("Z:urg0");                    // urgency-view zone (default CLOSED - only urg2/urg3 default open)
    toggled.add("Z:urg1");
    persistCanvas();
  } catch (e) {}
}
// ===== v6.8: CHAPTERED TOUR - the proven cards are unchanged; chapter-intro cards carry a visible
// JOURNEY MAP (done / current / upcoming + skip-a-chapter), so the tour reads as 7 small stories instead of
// one overwhelming wall. A step's chapter = how many intro markers precede it (no per-card edits needed).
// ===== v6.9: HANDS-ON RESTRUCTURE - enrich/if-then/parallel are now real do-steps, the board lenses go canvas-first
// (with an observe card after each lens), a card can be dragged onto the day rail for real, the Ideas chapter seeds
// + sorts + enhances hands-on, and Naseer/Ctrl+K/the AI menu are all interactive tries. See v6.10-notes.html. =====
const TOUR_CHAPTERS = ["Capture", "Shape a task", "Your board", "Calendar & planning", "Habits & Guardian", "Idea Parking Lot", "Naseer & the helpers"];
function _tourChapterAt(i) { let n = 0; for (let k = 0; k <= i && k < STEPS.length; k++) if (STEPS[k].chIntro) n = STEPS[k].chIntro; return n; }
function _tourMapHtml(cur) {
  const rows = TOUR_CHAPTERS.map((t, k) => {
    const n = k + 1;
    const st = n < cur ? "done" : (n === cur ? "now" : "next");
    return `<div class="tmap-row ${st}"><span class="tmap-dot">${st === "done" ? "\u2713" : (st === "now" ? "\u25B8" : "\u00B7")}</span>${t}</div>`;
  }).join("");
  return `<div class="tmap"><div class="tmap-h">Chapter ${cur} of ${TOUR_CHAPTERS.length}</div>${rows}</div>
    <div class="tmap-skip"><button class="ghost-btn sm" data-act="tour-skip-ch">skip this chapter &rarr;</button></div>`;
}
function _tourEnsureMineRow() {   // v6.9.2 C13: keep _tourMineId pointing at a real Inbox note and scroll that row into view, so enrich_mine rings the row's Enrich button (never the whole panel)
  try {
    if (!(_tourMineId && item(_tourMineId))) { const n = (state.items || []).filter((i) => i && i.status === "inbox").slice(-1)[0]; if (n) _tourMineId = n.id; }
    const btn = document.querySelector('#inboxPanel .ibx-btn.enrich[data-id="' + (_tourMineId || "") + '"]');
    const row = (btn && btn.closest('.inbox-item')) || document.querySelector('#inboxPanel .inbox-item');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "center", inline: "nearest" });
  } catch (e) {}
}
const STEPS = [
  // ---------- WELCOME ----------
  { id: "welcome", center: true, before: () => closeAllPanels(), title: "Welcome to Himmah \u{1F44B}",
    html: "This is a <b>living demo</b> of one real week - Yusuf's: a junior data analyst who is also building an app, studying his deen, tutoring his cousin, and getting his dad ready for Umrah.<br><br>Here is the deal: I will show you each feature, <b>you will actually try it</b>, and as we go you will quietly start building <i>your own</i> Himmah right alongside his. Nothing here can break. Leave any time with <b>Skip</b>." },

  // ---------- CAPTURE (appreciate -> DO it -> see it land -> add YOUR own) ----------
  { id: "ch1_intro", center: true, chIntro: 1, before: () => closeAllPanels(),
    title: "Chapter 1: Capture - empty your head",
    html: "Here is the whole journey - seven short chapters, each one small. First: getting every stray thought OUT of your head and into a safe pile, fast." },
  { id: "capture", sel: ".capture", act: "read", before: () => closeAllPanels(), title: "Your head is not a to-do list",
    html: "Got a thought? Type it here and press Enter and it lands in your <b>Inbox</b> to sort later - so nothing rattles around in your head all day. <span class='tour-why'>Why it works: writing a thought down measurably lowers the load of holding it. You think clearer because you are carrying less.</span>" },
  { id: "capture_hint", sel: ".capture-hint", act: "read", title: "Tiny shortcuts (optional - never required)",
    html: "Plain words always work. But if you like speed: <code>/crit</code> marks it critical, <code>/eta 30m</code> guesses the time, <code>/cal</code> asks for a slot, and just writing <i>“by friday”</i> sets the deadline. Don't memorize anything." },
  { id: "capture_do", sel: () => document.querySelector("#captureInput"), act: "do",
    before: () => { _tourCapDup = false; closeAllPanels(); const ci = byId("captureInput"); if (ci) ci.focus(); },   // v6.9.2 E4: reset the reuse flag on (re)entry so a Back-and-return never insta-advances
    snap: () => state.items.filter((i) => i.status === "inbox").length,
    done: (n) => state.items.filter((i) => i.status === "inbox").length > n || _tourCapDup,   // v6.9.2 E4: count grew OR we reused an existing "emale the profesor" item (do-it-for-me re-run) - never hang, never duplicate
    fb: () => { try { const dupe = (state.items || []).find((i) => i && i.status === "inbox" && /emale the profesor/i.test(i.title || "")); if (dupe) { _tourMineId = dupe.id; _tourCapDup = true; return; } } catch (e) {} addCapture("emale the profesor about my survey reprot by thursday"); try { const m = state.items.filter((i) => i.status === "inbox").slice(-1)[0]; _tourMineId = m ? m.id : null; } catch (e) {} },   // v6.7.22: the user's OWN first capture is deliberately MESSY - we shape + Enhance it later; v6.9.2 E4: dedupe - reuse the existing demo capture on any re-run instead of piling up six copies
    holdAfter: 650, hint: "type, then press Enter", capture: true,
    title: "\u{1F449} Your turn - drop a real thought",
    html: "Type something genuinely on your mind and press <b>Enter</b>. <b>Don't fuss the spelling</b> - the AI cleans it later. Try your own, or <i>emale the profesor about my survey reprot by thursday</i> (notice “by thursday” becomes a real deadline). Watch it leave your head and land somewhere safe." },
  { id: "capture_landed", sel: () => document.querySelector("#inboxCount"), act: "read",
    title: "There it is - safely parked",
    html: "See the number on your <b>Inbox</b> tick up? Your thought is captured and out of your head - it did not interrupt anything, it just waits. We will come back and sort the Inbox near the end. The loop is simple: <b>think it, drop it, trust it is there.</b>" },
  { id: "ask_tasks", center: true, act: "chat", round: "tasks",
    examples: ["finish the quarterly report", "by friday: pay rent", "book the dentist"],
    placeholder: "brain-dump everything on your plate - errands, deadlines, that thing you keep putting off",
    title: "\u{1F319} Now drop a few of YOUR own",
    html: "While we are here, empty your head a little. What is actually on <b>your</b> plate right now? Don't sort it, just let it pour - the AI turns your words into real tasks (and splits big projects into steps). These get added <i>alongside</i> Yusuf's demo, and you keep them at the end. Nothing comes to mind? Press <b>Skip this</b>." },
  { id: "tasks_landed", sel: '[data-act="open-inbox"]', act: "read",
    title: "Your answers just became real tasks",
    html: "Everything you told me a moment ago landed in your <b>Inbox</b> - see the count on the button. Nothing is lost; we will sort that pile together soon (Chapter 7)." },

  // ---------- SHAPE THE USER'S OWN task fully: one editor, every field, each AI result ACCEPTED (v6.7.22; v6.9: enrich/if-then/parallel are now real do-steps) ----------
  { id: "ch2_intro", center: true, chIntro: 2, before: () => closeAllPanels(),
    title: "Chapter 2: Shape a task - the editor + every ✦",
    html: "You captured a messy thought. Now watch one task get fully shaped: the AI fixes the wording, estimates the time, enriches the context - and <b>you approve every step</b>." },
  { id: "open_mine", sel: () => document.querySelector("#drawer"), act: "read", corner: true, fullRing: true, holeSel: "#drawer",
    before: () => { closeAllPanels(); try { const mine = (_tourMineId && item(_tourMineId)) || (state.items || []).filter((i) => i && i.status === "inbox").slice(-1)[0]; if (mine) openEditor(mine.id); } catch (e) {} },
    title: "Let's shape the task you wrote",
    html: "Here's your messy thought, open in its editor - one quiet place where a vague note becomes a clear move: its <b>category</b>, <b>importance</b>, a <b>deadline</b>, a rough <b>time</b>. <i>(Tapping any card on your board opens it exactly like this.)</i> Every <b>✦</b> is the AI offering to do a field - you approve each one. No Save button to hunt for either." },
  { id: "enhance_mine", sel: () => document.querySelector('#drawer [data-enh="e-title"]'), act: "do", popup: true,
    before: () => { const t = byId("e-title"); if (t && !/profesor|reprot|tursday|thursday|emale/i.test(t.value)) t.value = "emale the profesor about my survey reprot by thursday"; },  // v6.7.22: guarantee a messy title so Enhance opens a real preview to accept
    snap: () => ({ title: (byId("e-title") && byId("e-title").value) || "", gen: _enhanceGen }),
    done: (was) => { const e = byId("e-title"); const changed = !!(e && e.value && e.value !== was.title); const cleanNoOp = _enhanceGen > was.gen && byId("popup") && byId("popup").hidden; return changed || cleanNoOp; },  // v6.7.22 RACE-FIX: advance when the cleaned title is ACCEPTED (e-title changes), OR the rare clean-title no-op (gen bumped, no popup). The old _enhanceGen-only check fired on the AI's RETURN, before the preview was accepted, so the next card tore it down and nothing saved.
    fb: () => { const b = document.querySelector('#drawer [data-enh="e-title"]'); if (b) b.click(); _tourAutoClick("#enhAccept"); },  // v6.9.1 fix: also auto-accept the preview so "do it for me" actually finishes the step
    armWhenFalse: true, poll: 250, minShow: 900, holdAfter: 300, hint: "tap the ✦ by the Title, then ✓ keep it",
    title: "✦ Watch it fix your spelling",
    html: "See the messy title? Tap the <b>✦</b> next to <b>Title</b>. A preview shows the cleaned wording - press <b>✓ Use this</b> to keep it. The AI fixes spelling and phrasing, <i>never</i> your meaning - and it works on every field." },
  { id: "eta_mine", sel: () => document.querySelector('#drawer [data-act="ai-eta"]'), act: "do", popup: true, poll: 200, minShow: 900, holdAfter: 300, armWhenFalse: true, hint: "tap the ✦, then ✓ keep it",
    snap: () => (byId("e-est") && byId("e-est").value) || "",                                            // v6.7.22 RACE-FIX: watch the SAVED estimate, not the popup appearing
    done: (was) => { const e = byId("e-est"); return !!(e && e.value && String(e.value) !== String(was) && +e.value > 0); },  // advance ONLY once the user ACCEPTS (e-est filled) - not when the .eta-card appears
    fb: () => { const b = document.querySelector('#drawer [data-act="ai-eta"]'); if (b) b.click(); _tourAutoClick("#etaAccept"); },  // v6.9.1 fix: also auto-accept so "do it for me" actually saves an estimate
    title: "✦ How long will it really take?",
    html: "Tap the <b>✦</b> by <b>Est. min</b> and the AI estimates the real time - the antidote to “this'll only take 5 minutes.” A window opens: press <b>✓ Use this</b> to keep it (or type your own). It only moves on once you've kept a number." },
  { id: "enrich_mine", sel: () => document.querySelector('#inboxPanel .ibx-btn.enrich[data-id="' + (_tourMineId || "") + '"]') || document.querySelector('#inboxPanel .inbox-item') || document.querySelector("#inboxPanel"), act: "do", popup: true,   // v6.9.2 C13: ring the Enrich button, else the row, else the panel
    before: () => { try { closeEditor(); } catch (e) {} closeAllPanels(); try { openInbox(); } catch (e) {} _tourEnsureMineRow(); },   // v6.9 C13: hop to the Inbox row; adopt a live id + scroll it in
    snap: () => { const it = _tourMineId && item(_tourMineId); return { t: (it && it.title) || "", g: _enrichGen }; },
    done: (was) => { const it = _tourMineId && item(_tourMineId); const changed = !!(it && it.title && it.title !== was.t); const cleanNoOp = _enrichGen > was.g && byId("popup") && byId("popup").hidden; return changed || cleanNoOp; },
    fb: () => { const b = document.querySelector('#inboxPanel .ibx-btn.enrich[data-id="' + (_tourMineId || "") + '"]'); if (b) b.click(); _tourAutoClick("#enhAccept"); },  // v6.9.1 fix: Enrich reuses the enhance preview (#enhAccept) - auto-accept it
    armWhenFalse: true, poll: 250, minShow: 900, holdAfter: 300, hint: "tap ✦ Enrich on your note, then ✓ keep it",
    title: "✦ Enrich - it reads what Himmah knows about your life",
    html: "This is <b>Enrich</b>, not Enhance - a deeper ✦ that lives on your Inbox row (your note is still parked here). It reads a short <b>life-context file</b> and fleshes out a terse note using it. Tap <b>✦ Enrich</b>, then <b>✓ Use this</b> to keep it. Right now it knows demo-Yusuf's life; the moment you finish the real setup (Chapter 8's interview), that file becomes <i>yours</i> and Enrich starts using your actual life instead." },
  { id: "ifthen_mine", sel: () => document.querySelector('#drawer [data-act="suggest-ifthen"]'), act: "do", corner: true, holeSel: "#drawer",   // v6.9.2 C14: ring the ✦ suggest button but expose the WHOLE editor drawer so the user can also type in the if/then fields

    before: () => { closeAllPanels(); try { const mine = (_tourMineId && item(_tourMineId)) || (state.items || []).filter((i) => i && i.status === "inbox").slice(-1)[0]; if (mine) openEditor(mine.id); } catch (e) {} },   // v6.9: back into the same editor session for the last two fields
    snap: () => (byId("e-if") && byId("e-if").value) || "",
    done: (was) => { const e = byId("e-if"); return !!(e && e.value && e.value !== was); },
    fb: () => { const b = document.querySelector('#drawer [data-act="suggest-ifthen"]'); if (b) b.click(); },
    armWhenFalse: true, poll: 250, minShow: 1500, holdAfter: 1600, hint: "tap ✦ suggest by Next action",   // v6.9.3 R5: raise minShow/holdAfter so the filled if-then stays on screen long enough to SEE before the card advances (it used to jump the instant the field filled)
    title: "An if-then makes it actually start",
    html: "A tiny <i>“when X, I'll do Y”</i> (“after Asr, at my desk”) is the single best trick for things you keep avoiding. Tap <b>✦ suggest</b> next to <b>Next action</b> - the AI drafts one, no preview to approve. It fills straight in - edit it if you like; Save (2 cards ahead) makes it permanent. <span class='tour-why'>Pre-deciding the first move is one of the most evidence-backed ways to actually begin (d=.65).</span>" },
  { id: "parallel_mine", sel: () => document.querySelector('#drawer [data-act="ai-parallel"]'), act: "do", popup: true,
    before: () => { closeAllPanels(); try { const mine = (_tourMineId && item(_tourMineId)) || (state.items || []).filter((i) => i && i.status === "inbox").slice(-1)[0]; if (mine) openEditor(mine.id); } catch (e) {} },
    snap: () => ({ c: !!(byId("e-parallel") && byId("e-parallel").checked), g: _parallelGen }),
    done: (was) => { const cb = byId("e-parallel"); const changed = !!(cb && cb.checked !== was.c); const cleanNoOp = _parallelGen > was.g && byId("popup") && byId("popup").hidden; return changed || cleanNoOp; },
    fb: () => { const b = document.querySelector('#drawer [data-act="ai-parallel"]'); if (b) b.click(); _tourAutoClick("#parAccept"); },  // v6.9.1 fix: also auto-agree so "do it for me" actually settles the verdict
    armWhenFalse: true, poll: 250, minShow: 900, holdAfter: 300, hint: "tap the ✦ by Parallel, then Agree/Override",
    title: "Parallel - flag work that runs in the background",
    html: "Tap the <b>✦</b> by <b>↔ Parallel</b>. The AI decides whether this can run alongside other work (a wash, a build, a reply you're awaiting) - Agree or Override in the popup either way. Calendarize then overlaps it with other blocks instead of giving it an exclusive slot. <b>Waiting</b> is its quiet cousin - parked on someone else, its own tray, which you'll meet soon." },
  { id: "save_mine", sel: '[data-act="save-drawer"]', act: "click", wait: 260,
    before: () => { const p = byId("popup"); if (p && !p.hidden) { p.classList.remove("open"); p.hidden = true; p.innerHTML = ""; } },
    fb: () => saveDrawer(),
    title: "\u{1F449} Save it - lock in every ✦",
    html: "Press <b>Save</b> to keep everything you approved. <span class='tour-why'>Two buttons worth knowing: <b>🗑 Delete</b> is the only dangerous one (and History can undo even that), and <b>⛨ Protect</b> shields a task from being quietly dropped when life gets busy.</span> You just shaped a task that's truly <i>yours</i>." },

  // ---------- YOUR BOARD (v6.9: canvas FIRST, lenses after with observe beats, pick-5 after the lenses) ----------
  { id: "ch3_intro", center: true, chIntro: 3, before: () => closeAllPanels(),
    title: "Chapter 3: Your board - three lenses, one desk",
    html: "Your tasks live on one calm board you can re-lens in a click - by life area, by urgency, or free-form. This chapter is about <i>seeing</i> your week clearly." },
  { id: "now", sel: ".focus-cards", act: "read", title: "NOW - the five that matter",
    html: "Remember a break when you had 18329 tasks and no idea which one to pick? Outsource your thinking to Himmah. Out of everything you captured, this bar keeps the <b>~5</b> that matter most in front of you, so you never freeze in front of a giant list. Your job: just complete the task. Enjoy!" },
  { id: "stats", sel: ".stats", act: "read", title: "Your week at a glance",
    html: "Critical cleared, hours of work due in the next 7 days, what's active, and what your Guardian is protecting - a calm pulse-check of the week. <span class='tour-why'>Why it matters: seeing your real weekly load up front closes the gap between what we <i>intend</i> to do and what we actually do. You plan against reality, not a hunch.</span>" },
  { id: "canvas", center: true, title: "The Canvas - chaos or discipline, your call",   // v6.9.2 C20: a pure centered read card - the height-clamped ring rendered as an ugly band, and the copy carries this beat on its own
    before: () => { closeAllPanels(); viewMode = "category"; persistUi(); _tourExpandLanes(); renderNow(); },   // v6.9: reset to category + force every lane/group OPEN, so the canvas is never seen empty (the old card-25 break)
    html: "This board is not a list - it is a canvas. A big quiet desk where every task is a card you move with your hands. The same tasks can be <b>chaos and mess</b> or <b>order and discipline</b> - it depends entirely on how <i>you</i> arrange them. Cluster a project in a corner, push noise to the edges, give today the center. <span class='tour-why'>Spatial layout uses your visual memory: you remember <i>where</i> a thing is, so the board itself becomes a map of your week.</span>" },
  { id: "canvas_do", sel: () => document.querySelector("#canvasview .card[data-id]") || document.querySelector(".canvas-wrap"), act: "do", holeSel: ".canvas-main", poll: 200,
    before: () => { closeAllPanels(); viewMode = "category"; persistUi(); _tourExpandLanes(); renderNow(); try { const c = document.querySelector("#canvasview .card[data-id]"); if (c && c.scrollIntoView) c.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) {} },   // same expand-lanes reset as `canvas`; v6.9.3 R3: land looking at the card to drag (the centralized re-measure re-centres it too)
    snap: () => { const c = document.querySelector("#canvasview .card[data-id]"), surf = document.querySelector("#canvasview .canvas-surface") || document.querySelector(".canvas-wrap"); if (!c || !surf) return null; const cr = c.getBoundingClientRect(), sr = surf.getBoundingClientRect(); return { id: c.dataset.id, x: cr.left - sr.left, y: cr.top - sr.top }; },   // v6.9.2 C21: remember the SAME card's position RELATIVE TO THE BOARD surface, not the viewport
    done: (snap) => { if (!snap) return false; const c = document.querySelector('#canvasview .card[data-id="' + snap.id + '"]'), surf = document.querySelector("#canvasview .canvas-surface") || document.querySelector(".canvas-wrap"); if (!c || !surf) return false; const cr = c.getBoundingClientRect(), sr = surf.getBoundingClientRect(); return Math.hypot((cr.left - sr.left) - snap.x, (cr.top - sr.top) - snap.y) > 40; },   // v6.9.2 C21: fire only on a REAL drag (> 40px) WITHIN the board - a global reflow (lanes/stats settling) moves the card AND the surface together, so their relative offset is unchanged and the tour never auto-advances by itself
    fb: () => {}, holdAfter: 450, minShow: 1200, armWhenFalse: true, hint: "drag any card",
    title: "\u{1F449} Move a card - make it yours",
    html: "Grab the highlighted card and slide it somewhere that feels right. Notice it stays exactly where you drop it - the canvas remembers your arrangement. Make a tiny mess, then a tiny bit of order. That small act is the whole idea: <i>you</i> impose the order. (No card to drag? press <i>do it for me</i>.)" },
  { id: "canvas_axis", sel: () => document.querySelector("#canvasview .seg") || document.querySelector('[data-act="view"][data-mode="urgency"]'), act: "read",
    title: "Arrange by how you FEEL",
    html: "Here is the quiet genius: lay the canvas out <b>by category</b> when you want each area of life in its lane, or <b>by urgency</b> when the week is on fire - whichever matches your headspace right now. Same tasks, two completely different maps, one click apart. The board bends to your mood, not the other way around. Let's flip through both lenses." },
  { id: "view_category", sel: () => { const bs = document.querySelectorAll('[data-act="view"][data-mode="category"]'); for (let i = 0; i < bs.length; i++) { const r = bs[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0) return bs[i]; } return bs[0] || null; }, act: "click",
    before: () => { closeAllPanels(); },
    fb: () => { viewMode = "category"; persistUi(); render(); }, wait: 300,
    title: "\u{1F449} Your board's home lens: by category",
    html: "Click <b>By category</b>. Your board opens like this by default - each area of your life in its own lane, calm and grouped. It's home base." },
  { id: "category_observe", sel: ".canvas-main", holeSel: ".canvas-main", noRing: true, corner: true, act: "read", title: "See what just happened",   // v6.9.3 R2: no ring (a clipped yellow band read as broken) - a pure centered read card, per the owner "just give up that yellow thing"
    html: "Same tasks, new map: every life area got its own lane. This is home base - calm, grouped, no noise." },
  { id: "view_urgency", sel: '[data-act="view"][data-mode="urgency"]', act: "click", fb: () => { viewMode = "urgency"; persistUi(); render(); }, wait: 260,
    title: "\u{1F449} Now “By urgency”", html: "Click it. Same tasks, instantly re-sorted by what's due soonest - the lens for a deadline-heavy day." },
  { id: "urgency_observe", sel: ".canvas-main", holeSel: ".canvas-main", noRing: true, corner: true, act: "read", title: "And now - by fire",   // v6.9.3 R2: no ring (clipped band) - pure centered read card
    html: "The same cards re-sorted by what is due soonest. Use this lens on deadline-heavy days, then flip back home." },
  { id: "pick5", sel: '[data-act="focus-ai"]', act: "do", popup: true, poll: 250, minShow: 900, holdAfter: 700, hint: "press ✦ pick my 5",
    snap: () => _aiFocusGen,
    done: (was) => _aiFocusGen !== was && Array.isArray(_aiFocus) && _aiFocus.length > 0,  // v6.7.12: advance on a real pick GENERATION change (not id-equality), so a Back-then-repick that returns identical ids still advances
    fb: () => {},  // v6.7.12: "do it for me" just skips; _tourDetach (run by tourDo before fb) already dismisses any open time prompt
    title: "✦ Pick my 5",
    html: "Stuck on what to do in a spare 10 minutes? Press this, tell it how long you have, and the AI picks your best handful of quick wins - so you stop deciding and start doing. This is the whole point of Himmah: <i>you</i> do the doing, <i>it</i> does the choosing. <b>One tap - then give it a few seconds.</b>" },
  { id: "pick5_result", sel: ".focus-cards", act: "read", title: "There they are - your 5",   // v6.7.22: PAUSE on the AI result so the user actually SEES it
    html: "The AI just reshuffled your <b>NOW bar</b> to its best picks for the time you had. Look them over - this is what it chose so you didn't have to. Take it in, then continue when you're ready." },
  { id: "canvas_cal", sel: '[data-act="canvas-cal-toggle"]', act: "do",
    before: () => { state.meta.ui = state.meta.ui || {}; const cc = state.meta.ui.canvasCal; if (cc && cc.open) { cc.open = false; scheduleSave(); renderNow(); } try { const t = document.querySelector('[data-act="canvas-cal-toggle"]'); if (t && t.scrollIntoView) t.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) {} },  // v6.7.11: start with the rail CLOSED so the user really opens it; renderNow = synchronous so the ring measures a settled layout; v6.9.3 R2: land looking at the Calendar toggle
    armWhenFalse: true, minShow: 800,
    snap: () => !!document.querySelector(".canvas-cal-rail"),
    done: () => !!document.querySelector(".canvas-cal-rail"),
    fb: _cctoggle, holdAfter: 500, hint: "click \u{1F4C5} Calendar",
    title: "\u{1F449} Drop the calendar INTO your canvas",
    html: "Now the part that deserves a drumroll. Click <b>\u{1F4C5} Calendar</b> and a real day-strip slides in right beside your board. Your loose task cards and your <i>hours</i>, on one screen. No other planner lets your messy thinking and your clock live together like this. This is the move people fall in love with." },
  { id: "canvas_cal_drop", sel: ".canvas-cal-rail", act: "do", poll: 250, minShow: 900, armWhenFalse: true, hint: "drag any card onto a time", holeSel: ".canvas-main",   // v6.9.2 C30: ring the rail, but cut the spotlight hole over the WHOLE canvas-main (board cards + rail) so the drag can actually START on a card instead of being blocked by the dim

    before: () => { state.meta.ui = state.meta.ui || {}; const cc = state.meta.ui.canvasCal = state.meta.ui.canvasCal || {}; if (!cc.open) { cc.open = true; if (!cc.date) cc.date = _isod(new Date()); scheduleSave(); } _tourExpandLanes(); renderNow(); try { const rail = document.querySelector(".canvas-cal-rail"); if (rail && rail.scrollIntoView) rail.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) {} },  // robust to Back re-entry - rail open AND a card visible to drag/fb regardless of lens; v6.9.3 R2: land looking at the rail
    snap: () => (state.events || []).filter((e) => e && e.taskId && e.notes === "time-blocked from the canvas").length,   // v6.9: the exact marker confirmCanvasBlock's #ccb-go writes (a plain !e.seriesId && e.taskId check also matches Guardian-resume/accept-schedule/calendarize events - too loose)
    done: (was) => (state.events || []).filter((e) => e && e.taskId && e.notes === "time-blocked from the canvas").length > was,
    fb: () => {
      try {
        const c = document.querySelector("#canvasview .card[data-id]");
        const i = c && item(c.dataset.id);
        if (!i) return;
        const sch = taskSchedule();
        const ds = (state.meta.ui && state.meta.ui.canvasCal && state.meta.ui.canvasCal.date) || _isod(new Date());
        state.events = state.events || [];
        state.events.push({ id: uid("ev"), scheduleId: sch.id, title: i.title, date: ds, start: "15:00", end: "15:30", allDay: false, notes: "time-blocked from the canvas", taskId: i.id });
        if (i.status === "inbox") i.status = "active";
        touch(i); scheduleSave(); render();
      } catch (e) {}
    },
    title: "\u{1F449} Drop a card onto the rail",
    html: "Drag any card onto the rail - it becomes a real block in your day. This is the bridge between your board and your calendar." },
  { id: "views_seam", center: true, act: "read",
    before: () => { state.meta.ui = state.meta.ui || {}; if (state.meta.ui.canvasCal && state.meta.ui.canvasCal.open) { state.meta.ui.canvasCal.open = false; scheduleSave(); } viewMode = "category"; persistUi(); renderNow(); },  // v6.7.22: close the canvas-cal rail + return to the calm category board, synchronously, so we leave the canvas cleanly before opening the full calendar
    title: "One board, three lenses - flip anytime",
    html: "Category for calm, urgency when the week's on fire, canvas to think with your hands - all one click apart, on the same tasks. That day-rail you just opened was a <i>peek</i> at your day. Next, let's open the <b>full calendar</b>, where your whole week lives." },

  // ---------- FULL CALENDAR (forced WEEK view) ----------
  { id: "ch4_intro", center: true, chIntro: 4, before: () => closeAllPanels(),
    title: "Chapter 4: Calendar & planning - your week, prayer-aware",
    html: "Now the calendar: prayer times as fixed anchors, your events imported, and the AI laying a whole day out at the hour - which you commit with one tap." },
  { id: "open_cal", sel: '[data-act="open-calendar"]', act: "click", fb: () => { closeAllPanels(); openCalendar(); calSetView("week"); }, wait: 360,
    title: "\u{1F449} Open the Calendar", html: "Click <b>Calendar</b> in the top bar to see your whole week." },
  { id: "calendar", sel: () => document.querySelector("#calendarview .wk-col.today .wk-ev") || document.querySelector("#calendarview .wk-ev") || document.querySelector("#calendarview .cal-title") || document.querySelector("#calendarview"), act: "read",
    before: () => { openCalendar(); calSetView("week"); },
    title: "A prayer-aware calendar",
    html: "Your prayers, classes, work standups and Jumu'ah already sit here as real time-blocks on colored schedules. Himmah always plans <i>around</i> your prayers - it may be the only planner that treats <b>salah as fixed</b>, not optional. Your worship is the frame, not the leftover." },
  { id: "prayers", sel: () => document.querySelector('#calendarview [data-act="cal-prayers"]') || document.querySelector('[data-act="cal-prayers"]'), act: "read",   // v6.7.22: the named gap - "you don't show how to import prayer times"
    before: () => { openCalendar(); if (_calView !== "week") calSetView("week"); },
    title: "\u{1F4FF} Bring your prayers in",
    html: "Click <b>📿 prayer times</b> to anchor your days in salah. Upload your mosque's timetable (a PDF) and Himmah reads the exact times - or just take the sensible defaults - then choose the next 7 or 30 days, with minutes before/after each adhan. Five daily prayers drop in as fixed blocks your week is built around." },
  { id: "ics_import", sel: () => document.querySelector('#calendarview [data-act="cal-import"]') || document.querySelector('[data-act="cal-import"]'), act: "read",
    title: "\u{2B07} Pull in a calendar you already use",
    html: "Already live in Google or Outlook Calendar? <b>⬇ import (.ics)</b> pulls it straight in - preview first, choose past vs future events, skip repeating ones if you like, and pick which schedule they land on. Your existing week, here in minutes." },
  { id: "calendarize", sel: '#calendarview [data-act="cal-calendarize"]', act: "do", poll: 300, minShow: 900, holdAfter: 500, hint: "tap it, then be patient - minutes, not seconds",
    before: () => { if (_calView !== "week") calSetView("week"); _tourClearCalz(); },  // v6.7.11: clear any stale proposal so the do-poll observes a FRESH open
    snap: () => !!document.querySelector(".calz-day-card"),
    done: () => !!document.querySelector(".calz-day-card"),                            // v6.7.11: ONE ACTIVITY AT A TIME - wait for the calz day-card to actually open (the AI can take seconds), never a blind wait:1300 that loses the race and overlaps card 25
    fb: () => calendarizeNextDay(),
    title: "\u{1F449} Try “✦ Calendarize tomorrow”",
    html: "Remember that 18329-tasks paralysis? Outsource it. Click it - the AI (or a smart offline fallback) lays tomorrow out as time-blocks, importance-first and prayer-aware. Give it a couple of seconds. It will not be perfect, and that is the point: a starting draft you bend, not a test you pass. <b>Heads up:</b> with the real AI this step can take <b>several minutes</b> (it reasons deeply about your whole day) - the offline fallback is instant. Leave it thinking; the plan appears by itself." },
  { id: "dayview", sel: () => document.querySelector(".calz-day-card"), act: "read", popup: true,
    before: () => { if (document.querySelector(".calz-day-card")) return; if (_calzProposal) { try { openCalzDay(); } catch (e) {} } },
    ready: () => !!document.querySelector(".calz-day-card"),
    title: "Tomorrow, drafted for you",
    html: "Your whole day, drafted in seconds. Drag any block to move or resize it; two things can share a slot (parallel work); Undo/Redo your tweaks freely. <b>Nothing touches your real calendar until you press Commit</b> - so play with it." },
  { id: "calz_commit", sel: () => document.querySelector("#popup .calz-day-card [data-act='calz-commit']"), act: "do", popup: true, armWhenFalse: true, poll: 250, minShow: 900, holdAfter: 300,
    before: () => { if (document.querySelector(".calz-day-card")) return; if (_calzProposal) { try { openCalzDay(); } catch (e) {} } },   // re-open the day-card if a stale teardown closed it
    snap: () => { const d = _calzProposal && _calzProposal.date; return { d: d || "", n: (state.events || []).filter((e) => e.taskId && !e._calzPreview && e.date === d).length }; },
    done: (was) => { if (!was || !was.d) return false; const n = (state.events || []).filter((e) => e.taskId && !e._calzPreview && e.date === was.d).length; return n > was.n; },   // v6.7.22 RACE-FIX: advance only when the plan is actually COMMITTED (real events land). The OLD tour clicked "✕ discard" here, throwing the whole plan away so NOTHING saved - the exact "nothing is saved" bug.
    fb: () => { try { calzCommit(); } catch (e) {} _tourAutoClick('.why-overlay [data-w="skip"]'); },  // v6.9.1 fix: calzCommit() opens an optional "why?" box first - without skipping it, "do it for me" left it stuck open and nothing ever committed
    title: "\u{1F449} Commit it - make it real",
    html: "Happy with the draft? Press <b>Commit to Calendar</b> and tomorrow's plan lands on your real calendar as proper blocks. <i>This</i> is the save - the old peek-and-toss is gone, your plan actually sticks." },
  { id: "quiz", sel: '#calendarview [data-act="cal-prefs-quiz"]', act: "read", before: () => { const p = byId("popup"); if (p && !p.hidden) { p.classList.remove("open"); p.hidden = true; p.innerHTML = ""; } if (_calView !== "week") calSetView("week"); },
    title: "Tune it to how YOU plan",
    html: "This little gear is a 5-minute quiz - when you focus best, how long your blocks run, how you treat prayers and breaks. Its answers reshape every future Calendarize, so the plan fits the way <i>you</i> actually work, not a generic template." },
  { id: "ask_events", center: true, act: "chat", round: "events",
    examples: ["work mornings mon to fri", "Arabic class tuesday 6pm", "halaqa thursday evening"],
    placeholder: "what repeats every week? prayers, shifts, classes, halaqa, family time - rough is fine",
    title: "\u{1F319} Now add YOUR weekly shape",
    html: "This calendar is most useful once it knows <b>your</b> week. What repeats - prayer times, work shifts, classes, your halaqa, family time? Rough is fine (“work mornings, class Tuesday evenings”) and you pin down times later. These become the fixed walls your week gets planned around. Nothing fixed yet? Press <b>Skip this</b>." },
  { id: "close_cal", sel: '#calendarview [data-act="close-calendar"]', act: "click", before: () => { _tourClearCalz(); const p = byId("popup"); if (p && !p.hidden) { p.classList.remove("open"); p.hidden = true; p.innerHTML = ""; } }, fb: () => closeCalendar(), wait: 340,
    title: "\u{1F449} Close the calendar", html: "Click the <b>✕</b> to head back to your board. You are about halfway - the gentle, caring features are next." },

  // ---------- HABITS (deeper + DO tick + add YOUR habit) ----------
  { id: "ch5_intro", center: true, chIntro: 5, before: () => closeAllPanels(),
    title: "Chapter 5: Habits & Guardian - keep the quiet goods alive",
    html: "Habits build with streaks; rhythms just flow; and the Guardian protects the quiet important things (faith, health, learning) from loud deadlines." },
  { id: "open_habits", sel: '[data-act="open-habits"]', act: "click", holeSel: "#moreMenu", before: () => { const p = byId("popup"); if (p && !p.hidden) { p.classList.remove("open"); p.hidden = true; p.innerHTML = ""; } openMoreMenu(); }, ready: () => { const p = byId("habitsPanel"); return !!(p && !p.hidden); }, fb: () => { closeAllPanels(); openHabits(); }, wait: 360, // v6.9.1: Habits now lives in the "⋯ More" menu - open it first so the ring has a visible target; v6.9.2 E3c: advance on the PANEL opening, not a blind timer
    title: "\u{1F449} Open Habits", html: "Click <b>Habits</b> in the top bar - the things you are building <i>into yourself</i>, one day at a time." },
  { id: "habit_card", sel: () => document.querySelector("#habitsPanel .rhythm-card"), act: "read",
    before: () => { try { const p = byId("habitsPanel"); if (p) { if (p.hidden) openHabits(); p.hidden = false; p.classList.add("open"); } } catch(e){} },
    title: "Habits - what you push yourself to keep",
    html: "A <b>habit</b> takes willpower: Yusuf's daily Quran memorization (a 5-day \u{1F525} streak), gym 3×/week. Himmah tracks the <b>streak</b> so you watch the chain grow. <span class='tour-why'>Why streaks work: an unbroken chain becomes something you do not want to lose, so the count itself pulls you forward.</span> Miss a day? It just resets - a cheerleader, never a judge." },
  { id: "habit_done", sel: () => document.querySelector("#habitsPanel [data-act='rhythm-done']"), act: "do", poll: 200,
    snap: () => { const b = document.querySelector("#habitsPanel [data-act='rhythm-done']"); return b ? b.textContent.trim() : null; },
    done: (was) => { const b = document.querySelector("#habitsPanel [data-act='rhythm-done']"); return !!b && b.textContent.trim() !== was; },
    fb: () => { const b = document.querySelector("#habitsPanel [data-act='rhythm-done']"); if (b) markRhythmToday(b.dataset.id); },
    holdAfter: 700, hint: "tap the circle",
    title: "\u{1F449} Tick today's habit",
    html: "Click the highlighted <b>○</b> to mark it done for today, and watch the streak tick up. That tiny dopamine hit is the engine of consistency. (Click again to undo; nothing is permanent.)" },
  { id: "habit_park", sel: () => document.querySelector("#habitsPanel .habit-lot") || document.querySelector("#habitsPanel .rhythm-card"), act: "read",
    before: () => { try { const p = byId("habitsPanel"); if (p) { if (p.hidden) openHabits(); p.hidden = false; p.classList.add("open"); } } catch(e){} },
    title: "\u{1F17F} The Habit Parking Lot",
    html: "Got a habit you are not ready for yet? Park the <i>idea</i> here - guilt-free, zero daily load - and start it the day you are ready. <span class='tour-why'>Why this is kind: over-committing on day one is the top reason habits die. Park the dream, protect today.</span>" },
  { id: "ask_habits", center: true, act: "chat", round: "habits",
    examples: ["read Quran every morning", "gym 3x a week", "study Arabic 20 min daily"],
    placeholder: "what do you want to become more consistent at? things that take a push",
    title: "\u{1F319} Now add a habit of YOUR own",
    html: "What are <b>you</b> trying to build into your days - something that takes a little push? Quran each morning, the gym, Arabic. Say it and the AI sets it up with streak tracking, ready to tick tomorrow. Not now? Press <b>Skip this</b>." },
  { id: "close_habits", sel: '[data-act="close-habits"]', act: "click", fb: () => closeHabits(), wait: 240,
    title: "\u{1F449} Close Habits", html: "Click the <b>✕</b>. Next we meet habits' easygoing cousin." },

  // ---------- RHYTHMS (deeper + add YOUR rhythm) ----------
  { id: "open_rhythms", sel: '[data-act="open-rhythms"]', act: "click", holeSel: "#moreMenu", ready: () => { const p = byId("rhythmsPanel"); return !!(p && !p.hidden); }, before: () => openMoreMenu(), fb: () => { closeAllPanels(); openRhythms(); }, wait: 360, // v6.9.1: Rhythms moved into the "⋯ More" menu; v6.9.2 E3c: advance on the panel opening
    title: "\u{1F449} Open Rhythms", html: "Click <b>Rhythms</b> in the top bar - the things that mostly take care of themselves." },
  { id: "rhythm_card", sel: () => document.querySelector("#rhythmsPanel .ritual-card"), act: "read",
    before: () => { try { const p = byId("rhythmsPanel"); if (p) { if (p.hidden) openRhythms(); p.hidden = false; p.classList.add("open"); } } catch(e){} },
    title: "Rhythms - what just flows",
    html: "A <b>rhythm</b> needs no willpower (morning sunlight, sleeping early). An <b>islamic rhythm</b> is worship woven naturally into your day with the right intention - adhkar after prayer, Surah al-Kahf on Friday. <span class='tour-why'>Why separate them from habits: things that flow do not need a streak nagging you - they just need to be <i>noticed</i>.</span> Himmah only quietly notices a miss; it never scolds." },
  { id: "ask_rhythms", center: true, act: "chat", round: "rhythms",
    examples: ["morning and evening adhkar", "Surah al-Kahf on Friday", "sleep by 11pm"],
    placeholder: "what flows almost on its own? sunlight, adhkar, sleep, al-Kahf on Friday",
    title: "\u{1F319} Now add a rhythm of YOUR own",
    html: "What flows almost on its own in <b>your</b> day - the gentle background rhythms of your life and worship? Name a few you would like Himmah to simply <i>notice</i> in your week. Nothing comes to mind? Press <b>Skip this</b>." },
  { id: "close_rhythms", sel: '[data-act="close-rhythms"]', act: "click", fb: () => closeRhythms(), wait: 240,
    title: "\u{1F449} Close Rhythms", html: "Click the <b>✕</b>. Now one of the most caring features in Himmah." },

  // ---------- GUARDIAN (deeper + the why) ----------
  { id: "guardian", sel: '#guardianBtn', act: "click", holeSel: "#moreMenu", ready: () => { const p = byId("guardianPanel"); return !!(p && !p.hidden); }, before: () => openMoreMenu(), fb: () => { closeAllPanels(); openGuardian(); }, wait: 360, // v6.9.1: Guardian moved into the "⋯ More" menu; v6.9.2 E3c: advance on the panel opening
    title: "\u{1F449} Open Guardian", html: "Click <b>Guardian</b> in the top bar. This one quietly defends the parts of your life that matter most but shout least." },
  { id: "guardian_explain", sel: () => document.querySelector("#guardianPanel .drawer-head") || document.querySelector("#guardianPanel"), act: "read",
    before: () => { try { const p = byId("guardianPanel"); if (p) { if (p.hidden) openGuardian(); p.hidden = false; p.classList.add("open"); } } catch(e){} },  // v6.7.8: ensure the panel is open + visible so the spotlight has a real target (robust to a fast close->open)
    title: "Guardian - protect what matters",
    html: "When life floods in, the important-but-quiet goods go first: your <b>faith</b>, your <b>health</b>, your <b>learning</b> - not because they matter least but because they shout least. Guardian shields them so a loud deadline can never silently crowd out your salah, your sleep, or your studying. <span class='tour-why'>In a heavy week you choose to pause them <i>on purpose</i>, with a clear-eyed deal, instead of losing them by accident.</span>" },
  { id: "close_guardian", sel: '[data-act="close-guardian"]', act: "click", fb: () => closeGuardian(), wait: 240,
    title: "\u{1F449} Close Guardian", html: "Click the <b>✕</b>. A few quieter helpers are next." },
  { id: "ch6_intro", center: true, chIntro: 6, before: () => closeAllPanels(),
    title: "Chapter 6: The Idea Parking Lot - sparks, not tasks",
    html: "Not everything is a task. Random sparks - a gift idea, a business thought - get parked HERE, away from your to-dos, sorted and sharpened by AI when you ask." },
  { id: "open_ideas", sel: '[data-act="open-ideas"]', act: "click", fb: () => { closeAllPanels(); openIdeas(); }, wait: 360,
    title: "\u{1F449} Open the Idea Parking Lot", html: "Click <b>\u{1F4A1} Ideas</b> in the top bar." },
  { id: "ideas_seeded", sel: "#ideasFull", act: "read",
    before: () => { try { if ((state.ideas || []).filter((i) => i.status !== "done").length < 3) { ["ask the imam about Dad's Umrah wheelchair access", "a tiny app that tracks Quran review pages", "surprise gift for Amina - she loved the calligraphy set", "sell the old monitor before the move"].forEach((t) => addIdea(t)); } } catch (e) {} },
    title: "Yusuf already parked a few sparks",
    html: "See them? Loose, unsorted, safe. Let's put the three ✦ powers on them - you approve everything." },
  { id: "idea_park", sel: "#ideaInput", act: "do", poll: 200, minShow: 900, armWhenFalse: true,
    snap: () => (state.ideas || []).length,
    done: (was) => (state.ideas || []).length > was,
    fb: () => { try { parkIdeas("gift idea for mom - something with roses"); } catch (e) {} },
    hint: "type a spark, press Enter",
    title: "\u{1F4A1} Park a spark of YOUR own",
    html: "Type any random idea - a gift, a trip, an app thought - and press <b>Enter</b>. One per line parks many at once. <span class='tour-why'>Why a separate lot: ideas stored WITH tasks either nag you or get lost. Here they are safe, out of the way, and never forgotten.</span> (Or press <i>do it for me</i>.)" },
  { id: "idea_sort", sel: '[data-act="idea-sort"]', act: "do", popup: true, armWhenFalse: true, poll: 300, minShow: 1200,
    snap: () => (state.ideas || []).filter((i) => i.topicId).length,
    done: (was) => (state.ideas || []).filter((i) => i.topicId).length > was,
    fb: () => { try { sortIdeas(); } catch (e) {} },
    hint: "tap \u2726 Sort into topics",
    title: "\u2726 Sort into topics",
    html: "Tap it - the AI files each spark into a topic lane WITH a reason. Watch your pile become a map." },
  { id: "idea_enrich_do", sel: '[data-act="idea-enrich"]', act: "do", popup: true, armWhenFalse: true, poll: 250, minShow: 900,
    snap: () => !!document.querySelector(".idea-enrich-overlay"),
    done: () => !!document.querySelector(".idea-enrich-overlay"),   // v6.9: watching the review overlay APPEAR is intentional here - the next card holds while the user reviews it
    fb: () => { try { enrichIdeas(); } catch (e) {} },
    hint: "tap \u2726 Enhance each",
    title: "\u2726 Enhance each - one at a time",
    html: "This one walks your ideas ONE AT A TIME - old wording above, sharpened version below, numbered (1/4), with the why. Approve, edit, or skip each." },
  { id: "idea_review_hold", act: "read", popup: true, corner: true, center: false,
    sel: () => document.querySelector(".idea-enrich-overlay .idea-enrich-card") || document.querySelector(".idea-enrich-overlay") || document.querySelector("#ideasFull"),   // v6.9.2 E1: ring the INNER card, not the full-screen overlay (which drew a ring around the whole screen)
    title: "Take your time in there",
    html: "Approve, edit or skip each suggestion - the window closes when you finish (Esc skips the rest). Then hit Next. <b>\u2726 Tidy</b> works the same way but across ALL ideas at once: merging overlaps, dropping dead ones, promoting the ripe ones to real tasks." },
  { id: "close_ideas", sel: '[data-act="close-ideas-full"]', act: "click", fb: () => closeIdeasFull(), wait: 260,
    title: "\u{1F449} Close the lot", html: "Click <b>\u2715 Close</b>. Your sparks stay parked." },
  { id: "ch7_intro", center: true, chIntro: 7, before: () => closeAllPanels(),
    title: "Chapter 7: Naseer & the quiet helpers",
    html: "Meet <b>Naseer</b> - the assistant living inside the app - plus the quiet helpers: Waiting, Tidy, History and search. Then you are done. One chapter left." },
  { id: "naseer_open", sel: "#naseerLauncher", act: "click", fb: () => naseerOpen(), wait: 400,
    title: "\u{1F449} Meet Naseer", html: "Click the glowing orb in the corner (or press <b>Ctrl+I</b> anytime)." },
  { id: "naseer_chat", sel: "#naseerPanel", act: "do", popup: true, poll: 300, minShow: 1200, holdAfter: 500, armWhenFalse: true,
    before: () => { try { if (byId("naseerPanel").hidden) naseerOpen(); } catch (e) {} },
    snap: () => (state.naseerHistory || []).length,
    done: (was) => (state.naseerHistory || []).length >= was + 2,
    fb: () => { try { naseerQuick("What should I focus on right now?"); } catch (e) {} },
    hint: "ask him anything - or tap a chip",
    title: "\u{1F4AC} Ask him something real",
    html: "Type a question (like <i>what should I focus on?</i>) or tap a quick chip. Naseer knows your whole app - he finds things, explains features, and can even <i>do</i> small things for you (you always confirm first). <span class='tour-why'>He answers from YOUR real board, not generic advice.</span>" },
  { id: "naseer_reply", act: "read", popup: true, sel: "#naseerPanel",
    title: "He answered - and you can keep going",
    html: "Chat as long as you like - he remembers the conversation. Up top: <b>⚡ Flash</b> is the fast light model for everyday questions; tap it to switch to <b>✦ Pro</b> - deeper reasoning for planning-grade asks (a touch slower, a touch pricier). The ☰ menu keeps saved chats; \u{1F5D2} Log my day walks your habits and tasks one by one." },
  { id: "naseer_voice", act: "read", sel: () => document.querySelector("#naseerPanel .naseer-head") || document.querySelector("#naseerPanel"),
    title: "\u{1F399} He also talks - hands-free",
    html: "Tap <b>\u{1F399}</b> (or <b>Ctrl+Shift+V</b>) and just speak - he waits for your pause, or say <i>send it</i>. You can talk over him to interrupt. The <b>\u2630</b> menu keeps saved chats (temporary by default), and <b>\u{1F5D2} Log my day</b> walks your habits and tasks one by one and logs them for you." },
  { id: "naseer_close", sel: '[data-act="naseer-close"]', act: "click", fb: () => naseerClose(), wait: 300,
    title: "\u{1F449} Close Naseer", html: "Click the <b>\u2715</b>. He is one keypress away, always." },
  { id: "travel", sel: '#travelBtn', act: "read", holeSel: "#moreMenu", before: () => { closeAllPanels(); openMoreMenu(); },   // v6.7.22 coverage: travel mode; v6.9.1: Travel moved into the "⋯ More" menu
    title: "\u{2708} Travelling? Himmah adapts with you",
    html: "Tap <b>✈ Travel</b> when you're on the road. Himmah eases the week: it combines and shortens your prayers per your madhab, and lets you <b>keep / reduce / pause</b> each habit so your deen survives the trip instead of collapsing. A gentle drifting-dust reminder shows it's on - tap again when you're home." },

  // ---------- WAITING (deeper) - v6.9: corner:true so the card never covers the panel it's explaining ----------
  { id: "open_waiting", sel: '[data-act="open-waiting"]', act: "click", holeSel: "#moreMenu", corner: true, ready: () => { const p = byId("waitingPanel"); return !!(p && !p.hidden); }, before: () => openMoreMenu(), fb: () => { closeAllPanels(); openWaiting(); }, wait: 360, // v6.9.1: Waiting moved into the "⋯ More" menu; v6.9.2 E3c: advance on the panel opening
    title: "\u{1F449} Open Waiting", html: "Click <b>Waiting</b> in the top bar - the home for everything that is not really up to you right now." },
  { id: "waiting_explain", sel: () => document.querySelector("#waitingPanel .drawer-head") || document.querySelector("#waitingPanel"), act: "read", corner: true,
    before: () => { try { const p = byId("waitingPanel"); if (p) { if (p.hidden) openWaiting(); p.hidden = false; p.classList.add("open"); } } catch(e){} },
    title: "Waiting - parked, not forgotten",
    html: "When a task is blocked on someone else - Yusuf's beta build waiting on Apple, a reply, a delivery - it parks here so it stops cluttering your active list and stops nagging your mind. <span class='tour-why'>A task you cannot act on is pure noise on your main board; here, your NOW bar only shows what you can <i>actually do</i>.</span> The moment it is unblocked, it quietly returns." },
  { id: "close_waiting", sel: '[data-act="close-waiting"]', act: "click", corner: true, fb: () => closeWaiting(), wait: 240,
    title: "\u{1F449} Close Waiting", html: "Click the <b>✕</b>." },

  // ---------- INBOX (deeper; closes the capture loop opened at the start) - v6.9: corner:true ----------
  { id: "open_inbox", sel: '[data-act="open-inbox"]', act: "click", corner: true, fb: () => { closeAllPanels(); openInbox(); }, wait: 360,
    title: "\u{1F449} Open the Inbox", html: "Click <b>Inbox</b> in the top bar. Remember the thought you dropped at the very start, and the ones you brain-dumped? Let us go find them." },
  { id: "inbox_explain", sel: () => document.querySelector("#inboxPanel .inbox-item") || document.querySelector("#inboxPanel .drawer-head") || document.querySelector("#inboxPanel"), act: "read", corner: true,
    before: () => { try { const p = byId("inboxPanel"); if (p) { if (p.hidden) openInbox(); p.hidden = false; p.classList.add("open"); } } catch(e){} },
    title: "There it is - your capture, waiting safely",
    html: "This is the pile everything you capture flows into. Give each one a <b>category</b> and an <b>importance</b> and it joins your board - or hit <b>✦ Triage all</b> and let the AI propose a category, importance and cleaned title for the whole batch; you just approve each. Need room? <b>⤢ Expand</b> opens a full-screen Inbox with keyboard nav and bulk filing. <span class='tour-why'>Capturing and sorting are different jobs: dump fast now, decide calmly later.</span>" },
  { id: "close_inbox", sel: '[data-act="close-inbox"]', act: "click", corner: true, fb: () => closeInbox(), wait: 240,
    title: "\u{1F449} Close the Inbox", html: "Click the <b>✕</b>." },

  // ---------- TIDY (deeper) - v6.9: corner:true ----------
  { id: "open_tidy", sel: '[data-act="open-tidy"]', act: "click", holeSel: "#moreMenu", corner: true, ready: () => { const p = byId("tidyPanel"); return !!(p && !p.hidden); }, before: () => openMoreMenu(), fb: () => { closeAllPanels(); openTidy(); }, wait: 360, // v6.9.1: Tidy moved into the "⋯ More" menu; v6.9.2 E3c: advance on the panel opening
    title: "\u{1F449} Open Tidy", html: "Click <b>Tidy</b> in the top bar - how your list keeps itself honest over months." },
  { id: "tidy_explain", sel: () => document.querySelector("#tidyPanel .drawer-head") || document.querySelector("#tidyPanel"), act: "read", corner: true,
    before: () => { try { const p = byId("tidyPanel"); if (p) { if (p.hidden) openTidy(); p.hidden = false; p.classList.add("open"); } } catch(e){} },
    title: "Tidy - so your list never rots",
    html: "Short-term tasks that went quiet drift up here, so nothing slips through the cracks and nothing silently piles up. <span class='tour-why'>A list you never prune becomes a list you stop trusting - and an untrusted list gets ignored. Tidy keeps yours believable.</span> Glance through whenever you like and prune what no longer matters - no guilt." },
  { id: "close_tidy", sel: '[data-act="close-tidy"]', act: "click", corner: true, fb: () => closeTidy(), wait: 240,
    title: "\u{1F449} Close Tidy", html: "Click the <b>✕</b>. Two quick things, then you're done." },

  // ---------- HISTORY + SEARCH + AI (v6.9: search + the AI menu are now interactive tries) ----------
  { id: "history", sel: '[data-act="open-history"]', act: "read", holeSel: "#moreMenu", corner: true, before: () => { closeAllPanels(); openMoreMenu(); }, // v6.9.1: History moved into the "⋯ More" menu
    title: "\u{27F2} Nothing is ever truly lost",
    html: "Himmah snapshots your whole state on every change. Click <b>⟲ History</b> to browse those snapshots and <b>restore</b> any one - it previews the change first, you confirm, and you can even undo a restore. <span class='tour-why'>This is why deleting a task, or the Nuclear wipe you're about to see, is completely safe: the past is always one click back.</span>" },
  { id: "search_do", act: "do", center: false, popup: true,
    sel: () => { const ov = byId("searchOverlay"); return (ov && !ov.hidden) ? (ov.querySelector(".search-bubble") || ov) : document.body; },   // v6.9.2 E1: ring the search BUBBLE, not the full-screen overlay
    snap: () => !!(byId("searchOverlay") && !byId("searchOverlay").hidden),
    done: () => !!(byId("searchOverlay") && !byId("searchOverlay").hidden),
    armWhenFalse: true, poll: 200, minShow: 900,
    fb: () => { try { searchOpen(); } catch (e) {} },
    hint: "press Ctrl+K",
    title: "\u{1F50D} Press Ctrl+K - search everything",
    html: "Press <b>Ctrl+K</b> right now. One box finds any task, idea, or event as you type." },
  { id: "search_try", act: "read", popup: true,
    sel: () => { const ov = byId("searchOverlay"); return (ov && ov.querySelector(".search-bubble")) || ov || document.body; },   // v6.9.2 E1: ring the search BUBBLE, not the full-screen overlay
    title: "Try it, then Esc",
    html: "Type <i>umrah</i> or anything from your board - results filter live. <b>Esc</b> closes it. This works from anywhere, always." },

  // ---------- AI (v6.9: an interactive try, not just a read) ----------
  { id: "ai_menu_do", sel: '#aiBtn', act: "do", popup: true, armWhenFalse: true, poll: 200, minShow: 900,
    before: () => { try { searchClose(); } catch (e) {} closeAllPanels(); },   // v6.9: close the Ctrl+K overlay from the previous beat before opening the AI menu
    snap: () => !!(byId("popup") && !byId("popup").hidden && /ai-row|✦/.test(byId("popup").innerHTML)),
    done: () => !!(byId("popup") && !byId("popup").hidden && /ai-row|✦/.test(byId("popup").innerHTML)),
    fb: () => { try { openAiMenu(); } catch (e) {} },
    hint: "tap ✦ AI",
    title: "\u{1F449} Open the ✦ AI menu",
    html: "Every AI power lives behind ONE button - triage, find-groups, the weekly review. Tap it." },
  { id: "ai_menu_read", act: "read", popup: true, corner: true, sel: () => document.querySelector("#popup .popup-card") || byId("popup"),   // v6.9.2 E1: ring the popup CARD, not the full-screen #popup backdrop
    title: "Your AI toolbox",
    html: "All of it runs through your own key, capped near 10 cents a day, on your machine. The AI only ever suggests; you always decide. Close it with ✕ when ready." },

  // ---------- FINALE: keep mine, clear the demo (never a stuck build) ----------
  { id: "finish", center: true, before: () => { try { _tourClearCalz(); } catch(e){} closeAllPanels(); try { closePopup(); } catch(e){} },
    title: "Your Himmah is alive \u{1F319}",
    html: "You did it. You have seen every corner of Yusuf's week and tried the core moves. Now the real part: <b>make Himmah yours.</b><br><br>The <b>Nuclear</b> option wipes Yusuf's life from your computer - and everything you touched during the tour - to a clean page, then I guide you <i>chat by chat</i> to build your OWN habits, rhythms, categories and tasks. Yusuf's demo stays safe in <b>History</b>, so nothing is ever truly lost. Ready? Bismillah.",
    cta: "☢ Nuclear - start MY journey", ctaAct: "tour-nuclear",
    cta2: "Keep exploring the demo", cta2Act: "tour-keep-demo" },
];
const TOUR_COPY = {}; // v6.7.8: copy now lives inline in STEPS (warm + interactive); kept empty so it never shadows the new copy
let _tourI = 0, _tourOv = null, _tourTarget = null, _tourOnClick = null, _tourMineId = null;   // v6.7.22: _tourMineId = the user's OWN first messy capture, shaped later in one full editor walkthrough
let _tourCapDup = false;   // v6.9.2 E4: set when capture_do REUSES an existing demo capture instead of adding a duplicate (so DONE can still fire without inbox growth)
let _tourPoll = null, _tourSnap = null;                 // v6.7.8: do-step poller + entry snapshot
let _tourRaf = null;                                    // v6.7.8: pending place() frame, cancelled on teardown (no stale render into a null overlay)
let _tourReadActive = false;                            // read-step click shield active
let _tourAskBusy = false;                               // ask-step POST guard
let _tourStartTs = null;                                // ISO at tour start (informational)
let _tourDemoIds = null;                                // v6.7.8: demo item/rhythm ids + event seriesIds snapshotted at tour start - the ONLY reliable demo/user discriminator (createdAt is identical T09:00:00 for both)
let _tourShownAt = 0;                                   // v6.7.11: timestamp of the current step's render - the minShow gate so an async open / instant predicate can never flash past before the user reads it
function _tourReadGuard(e){
  if (!_tourReadActive) return;
  if (e.target.closest(".tour-pop")) return;            // let the tour card's own buttons work
  e.preventDefault(); e.stopImmediatePropagation();     // swallow stray clicks on the lit read target
}
function _tourClearCalz(){
  try { document.querySelectorAll(".calz-eta-pop").forEach((x) => x.remove()); } catch(e){}
  try { if (typeof _calzCleanup === "function") _calzCleanup(); } catch(e){}  // always strip any _calzPreview events/schedules (no bogus "cancel" log)
  _calzProposal = null;
  try { const p = byId("popup"); if (p && !p.hidden) { p.classList.remove("open"); p.hidden = true; p.innerHTML = ""; } } catch(e){}
}
function _tourStopPoll(){ if (_tourPoll){ clearInterval(_tourPoll); _tourPoll = null; } if (_tourRaf){ cancelAnimationFrame(_tourRaf); _tourRaf = null; } _tourSnap = null; }
// v6.9.1 fix: several "do it for me" fallbacks only pressed the FIRST half of an AI action (open a preview /
// agree-or-override / commit) and left its follow-up confirm popup (Use this / Agree / the optional why-box)
// sitting open while the tour silently moved on regardless - so "do it for me" never actually finished the
// step. This polls for that follow-up control and clicks it once it appears (bounded, so it can never hang).
function _tourAutoClick(sel, maxMs){
  const t0 = Date.now();
  const tick = () => {
    let el = null; try { el = document.querySelector(sel); } catch (e) { el = null; }
    if (el) { try { el.click(); } catch (e) {} return; }
    if (Date.now() - t0 > (maxMs || 6000)) return;                // safety: never hang if the popup never opens
    setTimeout(tick, 150);
  };
  tick();
}
// v6.7.8: fold the server's items into the client state by id WITHOUT clobbering unsaved client changes (a fresh capture, a habit tick).
function _tourMergeState(fr){
  if (!fr || typeof fr !== "object") return;
  const m = (c, sv) => { if (!Array.isArray(sv)) return Array.isArray(c) ? c : []; const a = Array.isArray(c) ? c : []; const h = new Set(a.map((x) => x && x.id)); sv.forEach((x) => { if (x && !h.has(x.id)) a.push(x); }); return a; };
  state.items = m(state.items, fr.items);
  state.rhythms = m(state.rhythms, fr.rhythms);
  state.events = m(state.events, fr.events);
  state.categories = m(state.categories, fr.categories);
  state.schedules = m(state.schedules, fr.schedules);
}
// v6.7.8: the INLINE make-it-yours round - same POST as _myAddRound, but woven into the tour as an "ask" card.
// ===== v6.7.22: act:"chat" - an inline AI CONVERSATION in the tour (reuses onboard_chat). The guide PROBES
// (handling "idk") until it has 3-4 of the user's OWN real items, then applies them via /api/life_add - replacing
// the old one-shot "brain-dump into a blank box" rounds. The owner: "I want AI to GUIDE the user, not just read." =====
let _tourChat = null;        // { card, round, history:[{role,content}], agreed, proposal, busy }
function _tourChatReset(s) { _tourChat = { card: s.id, round: s.round, history: [], agreed: false, proposal: null, busy: false }; }
async function _tourChatSend() {
  const s = _tourStep(); if (!s || s.act !== "chat" || !_tourChat || _tourChat.busy || _tourChat.agreed) return;
  const ta = byId("tourAsk"); const msg = ((ta || {}).value || "").trim();
  if (!msg) { if (ta) ta.focus(); return; }
  if (!(aiStatus && aiStatus.enabled)) { toast(aiStatus && aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ this needs your DeepSeek key - see the setup guide, or press Skip this"); return; }
  const i0 = _tourI, ov0 = _tourOv;                              // one-activity-at-a-time identity guard
  _tourChat.history.push({ role: "user", content: msg });
  _tourChat.busy = true; if (ta) ta.value = "";
  _tourRender(s);
  let res;
  try { res = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "onboard_chat", stage: _tourChat.round, answer: msg, history: _tourChat.history.slice(0, -1) }) }).then((r) => r.json()); }
  catch (e) { res = null; }
  if (_tourOv !== ov0 || _tourI !== i0) return;                  // quit/moved during the await
  if (res && res.status) { Object.assign(aiStatus, res.status); renderAiChip(); }
  _tourChat.busy = false;
  const r = (res && res.ok && res.result) || null;
  if (!r) { _tourChat.history.push({ role: "assistant", content: "Sorry, I didn't catch that - say it once more, or press Skip." }); _tourRender(s); return; }
  _tourChat.history.push({ role: "assistant", content: r.reply || "..." });
  _tourChat.agreed = !!r.agreed; _tourChat.proposal = r.proposal || null;     // agreed only once the guide has drawn out enough
  _tourRender(s);
}
async function _tourChatAdd() {
  const s = _tourStep(); if (!s || s.act !== "chat" || !_tourChat || _tourChat.busy) return;
  const i0 = _tourI, ov0 = _tourOv;
  const userText = _tourChat.history.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  if (!userText.trim()) return tourNext();
  _tourChat.busy = true; _tourRender(s);
  const now = new Date();
  let res;
  try { res = await fetch("/api/life_add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ round: _tourChat.round, answer: userText, spec: _tourChat.proposal || undefined, today: _isod(now), weekday: CAL_FULLDOW[now.getDay()] }) }).then((r) => r.json()); }
  catch (e) { res = null; }
  if (_tourOv !== ov0 || _tourI !== i0) return;
  if (res && res.status) { Object.assign(aiStatus, res.status); renderAiChip(); }
  if (!res || !res.ok) { _tourChat.busy = false; toast("⚠ " + ((res && res.error) || "couldn't add that - try again, or Skip")); _tourRender(s); return; }
  const a = res.added || {}, bits = [];
  const addb = (k, one, many) => { if (k) bits.push(k + " " + (k > 1 ? (many || one + "s") : one)); };
  addb(a.tasks, "task"); addb(a.projects, "project"); addb(a.habits, "habit"); addb(a.rhythms, "rhythm"); addb(a.islamic_rhythms, "islamic rhythm"); addb(a.events, "repeating event");
  toast(bits.length ? "✓ added " + bits.join(", ") : "✓ noted");
  try { const r2 = await fetch("/api/state"); _tourMergeState(await r2.json()); } catch (e) {}   // merge server items so they're live AND survive the Nuclear purge
  if (_tourOv !== ov0 || _tourI !== i0) return;
  try { render(); if (_tourChat.round === "events" && typeof renderCalendar === "function") renderCalendar(); } catch (e) {}
  _tourChat = null;
  setTimeout(() => { if (_tourOv === ov0 && _tourI === i0) tourNext(); }, 300);
}
document.addEventListener("keydown", (e) => {   // Enter sends in the tour chat (Shift+Enter = newline)
  if (e.target && e.target.id === "tourAsk" && e.key === "Enter" && !e.shiftKey) { const s = _tourStep(); if (s && s.act === "chat") { e.preventDefault(); _tourChatSend(); } }
});
async function _tourAskAdd(){
  if (_tourAskBusy) return;
  const s = _tourStep(); if (!s) return;
  const i0 = _tourI, ov0 = _tourOv;                              // v6.7.11: snapshot identity - if the user quits/Backs/Skips mid-POST, never advance or render into a DIFFERENT step (one activity at a time)
  const ta = byId("tourAsk"); const ans = ((ta || {}).value || "").trim();
  if (!ans) return tourNext();                                   // empty = gentle skip, never a trap
  if (!(aiStatus && aiStatus.enabled)) {                         // no key -> tell them, let them Skip
    toast(aiStatus && aiStatus.hasKey ? "✦ AI paused - daily budget reached" : "✦ this needs your DeepSeek key - see the setup guide, or press Skip this");
    return;
  }
  const btn = byId("tourAskBtn"); if (btn) { btn.disabled = true; btn.textContent = "✦ reading your answer…"; }
  const skipBtn = _tourOv && _tourOv.querySelector('[data-act="tour-ask-skip"]'); if (skipBtn) skipBtn.disabled = true;  // v6.7.11: no Skip while a POST is in flight (it would double-advance)
  _tourAskBusy = true;
  const now = new Date();
  let res;
  try { res = await fetch("/api/life_add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ round: s.round, answer: ans, today: _isod(now), weekday: CAL_FULLDOW[now.getDay()] }) }).then((r) => r.json()); }
  catch (e) { _tourAskBusy = false; toast("⚠ " + e.message); if (btn) { btn.disabled = false; btn.textContent = "Add these →"; } if (skipBtn) skipBtn.disabled = false; return; }
  _tourAskBusy = false;
  if (res && res.status) { Object.assign(aiStatus, res.status); renderAiChip(); }
  if (!res || !res.ok) { toast("⚠ " + ((res && res.error) || "couldn't add that - try again, or Skip")); if (btn) { btn.disabled = false; btn.textContent = "Add these →"; } if (skipBtn) skipBtn.disabled = false; return; }
  const a = res.added || {}, bits = [];
  const add = (k, one, many) => { if (k) bits.push(k + " " + (k > 1 ? (many || one + "s") : one)); };
  add(a.tasks, "task"); add(a.projects, "project"); add(a.habits, "habit"); add(a.rhythms, "rhythm"); add(a.islamic_rhythms, "islamic rhythm"); add(a.events, "repeating event");
  toast(bits.length ? "✓ added " + bits.join(", ") : "✓ noted");
  if (skipBtn) skipBtn.disabled = false;
  if (_tourOv !== ov0 || _tourI !== i0) return;                  // v6.7.11: quit/moved during the POST -> stop (the nav guard already blocks a stale tourNext; this also blocks the stray render + a double advance)
  // v6.7.8: MERGE the server-added items into the client state so they are live AND survive purgeDemoKeepMine
  // (the POST only changed the server copy). Merge - not replace - so unsaved client changes are never clobbered.
  try { const r2 = await fetch("/api/state"); _tourMergeState(await r2.json()); } catch(e){}
  if (_tourOv !== ov0 || _tourI !== i0) return;                  // v6.7.11: re-check after the 2nd await
  try { render(); if (s.round === "events" && typeof renderCalendar === "function") renderCalendar(); } catch(e){}
  setTimeout(() => { if (_tourOv === ov0 && _tourI === i0) tourNext(); }, 300);  // v6.7.11: advance only if still on this exact step
}
// v6.7.8: end-of-tour selective clear - keep what the user added this session, drop Yusuf's demo (undoable from History).
async function purgeDemoKeepMine(){
  _tourClearCalz();
  try { const r = await fetch("/api/state"); _tourMergeState(await r.json()); } catch(e){}  // fold in every ask item, keep client captures
  // v6.7.8: keep everything NOT in the demo snapshot (id/seriesId based - timezone-proof; createdAt can't tell demo from user, both are T09:00:00).
  const D = _tourDemoIds || { items: new Set(), rhythms: new Set(), series: new Set() };     // null snapshot fails SAFE toward keep (never wipes a board with no baseline)
  state.items   = (state.items   || []).filter((x) => x && x.id && !D.items.has(x.id));
  state.rhythms = (state.rhythms || []).filter((x) => x && x.id && !D.rhythms.has(x.id));
  state.events  = (state.events  || []).filter((x) => x && !D.series.has(x.seriesId));        // ask-round events (fresh seriesId) survive; demo series drop
  // v6.7.8: keep the stable defaults BUT preserve any schedule/category the user's ask rounds minted,
  // else a kept event orphans on a deleted schedule and eventsOn() silently hides it.
  const DEF_CATS = [
    { id: "c_work", name: "Work", color: "#4a8fff", order: 0, collapsed: false },
    { id: "c_personal", name: "Personal", color: "#22C55E", order: 1, collapsed: false },
    { id: "c_learning", name: "Learning", color: "#A855F7", order: 2, collapsed: false },
    { id: "c_health", name: "Health", color: "#F472B6", order: 3, collapsed: false },
  ];
  const DEF_SCH = [
    { id: "sch_tasks", name: "Tasks", color: "#f5c46f", hidden: false },
    { id: "sch_prayer", name: "Prayer", color: "#FACC15", hidden: false },
  ];
  const usedCat = new Set(state.items.map((i) => i.categoryId).filter(Boolean));
  const usedSch = new Set(state.events.map((e) => e.scheduleId).filter(Boolean));
  const defCatIds = new Set(DEF_CATS.map((c) => c.id)), defSchIds = new Set(DEF_SCH.map((s) => s.id));
  state.categories = DEF_CATS.concat((state.categories || []).filter((c) => c && usedCat.has(c.id) && !defCatIds.has(c.id)));
  state.schedules  = DEF_SCH.concat((state.schedules  || []).filter((s) => s && usedSch.has(s.id) && !defSchIds.has(s.id) && !s._calzPreview));
  state.meta = state.meta || {};
  state.meta.demo = false; state.meta.tourDone = true;
  state.meta.guardian = { protectedIds: [], deal: null, ledger: [] };
  state.meta.ui = state.meta.ui || {}; if (state.meta.ui.canvasCal) state.meta.ui.canvasCal.open = false;
  if (typeof toggled !== "undefined" && toggled.clear) toggled.clear();
  saveNow().then(() => { render(); renderNow(); });
}
function startTour() {
  _tourI = 0;
  _tourStartTs = (typeof nowIso === "function" ? nowIso() : new Date().toISOString());
  const ids = (arr) => new Set((arr || []).map((x) => x && x.id).filter(Boolean));
  _tourDemoIds = { items: ids(state.items), rhythms: ids(state.rhythms), series: new Set((state.events || []).filter((e) => e && e.seriesId).map((e) => e.seriesId)) };
  _tourPaint();
}
function _tourStep() { return STEPS[_tourI]; }
function _tourDetach() { if (_tourTarget && _tourOnClick) { try { _tourTarget.removeEventListener("click", _tourOnClick, true); } catch (e) {} } _tourTarget = null; _tourOnClick = null; _tourStopPoll(); _tourReadActive = false; document.removeEventListener("click", _tourReadGuard, true); try { document.body.classList.remove("tour-popup"); } catch (e) {} try { const _tb = document.querySelector(".timebox-overlay"); if (_tb && _tb._tbDone) _tb._tbDone(); } catch (e) {} }  // v6.7.12: any tour transition (next/prev/skip/quit/do-it-for-me) dismisses a left-open pick-5 time prompt - it must never outlive the tour
function tourEnd(done) { _tourDetach(); if (_tourOv) { _tourOv.remove(); _tourOv = null; } _tourClearCalz(); closeAllPanels(); if (done && state && state.meta) { state.meta.tourDone = true; scheduleSave(); } }   // v6.9.3 R1: page scroll is free again (the v6.9.2 page scroll-lock + scrollTop pins were reverted - they broke the owner's live walk); targets are centred via scrollIntoView on render + re-measure instead
function tourNext() { if (!_tourOv) return; _tourDetach(); if (_tourI >= STEPS.length - 1) return tourEnd(true); _tourI++; _tourPaint(); }
function tourPrev() { if (!_tourOv) return; _tourDetach(); if (_tourI <= 0) return; _tourI--; _tourPaint(); }
function tourDo() { const s = _tourStep(); _tourDetach(); if (s && s.fb) { try { s.fb(); } catch (e) {} } if (s && s.ready) _tourAdvanceWhenReady(s.ready, (s && s.wait) || 0); else _tourAdvanceSoon((s && s.wait) || 300); }
function _tourAdvanceSoon(delay) {      // v6.7.12: a deferred advance that NO-OPS if the user has since moved/quit (Back, do-it-for-me, Skip) so two pending advances can never double-skip a card (and orphan its popup). Mirrors _tourAskAdd's i0/ov0 snapshot.
  const i0 = _tourI, ov0 = _tourOv;
  setTimeout(() => { if (_tourOv === ov0 && _tourI === i0) tourNext(); }, delay);
}
function _tourAdvanceWhenReady(readyFn, floorMs) {      // v6.7.11: ONE-ACTIVITY-AT-A-TIME gate. An async click/do step advances ONLY when the next thing is actually ready (the AI/calendarize result has landed), never on a blind timer that can lose the latency race. 8s safety cap so the tour can never hang.
  const t0 = Date.now(), i0 = _tourI, ov0 = _tourOv;    // v6.7.12: identity-checked so a Back/skip during the up-to-8s wait can't double-advance
  const step = () => {
    if (_tourOv !== ov0 || _tourI !== i0) return;        // quit or moved during the wait
    let ok = true; try { ok = !readyFn || !!readyFn(); } catch (e) { ok = false; }
    if (ok && Date.now() - t0 >= (floorMs || 0)) return tourNext();
    if (Date.now() - t0 > 8000) return tourNext();       // safety: never hang the tour
    setTimeout(step, 200);
  };
  step();
}
function _tourPaint() {
  const s = _tourStep(); if (!s) return tourEnd(true);
  try { closeMoreMenu(); } catch (e) {}   // v6.9.2 E3b: guaranteed cleanup - every card transition closes any dangling More menu FIRST; menu-row steps re-open it in their own before() below
  if (s.before) { try { s.before(); } catch (e) {} }
  if (!_tourOv) {
    _tourOv = document.createElement("div"); _tourOv.id = "tourOverlay";
    _tourOv.innerHTML = `<div class="tb tb-top"></div><div class="tb tb-bottom"></div><div class="tb tb-left"></div><div class="tb tb-right"></div><div class="tour-ring" hidden></div><div class="tour-pop"></div>`;
    document.body.appendChild(_tourOv);
  }
  const go = () => _tourRender(s);
  if (s.wait && s.act === "read") requestAnimationFrame(go); else if (s.wait) setTimeout(go, s.wait); else requestAnimationFrame(go);
}
function _tourRender(s) {
  _tourDetach();
  if (!_tourOv || !s) return;                                // v6.7.8: a deferred go() after teardown must not render into a null overlay
  _tourShownAt = Date.now();                                 // v6.7.11: minShow gate baseline (one timestamp per render - ask/read/action alike)
  if (s.popup) { try { document.body.classList.add("tour-popup"); } catch (e) {} }  // v6.7.11: raise a tour-opened proposal popover (ETA card, pick-5 time prompt) above the dark overlay; removed in _tourDetach
  const ring = _tourOv.querySelector(".tour-ring"), pop = _tourOv.querySelector(".tour-pop");
  if (!ring || !pop) return;
  const c = TOUR_COPY[s.id] || s, n = _tourI + 1, total = STEPS.length;

  // ---- ASK: a self-contained centered make-it-yours card (textarea + example chips) ----
  if (s.act === "ask") {
    _tourBlockers(null, false); ring.hidden = true;
    pop.classList.add("tour-center"); pop.style.left = ""; pop.style.top = "";
    const egs = (s.examples || []).map((x) => `<button class="tour-eg" data-act="tour-ask-eg" data-eg="${esc(x)}">${esc(x)}</button>`).join("");
    pop.innerHTML = `<div class="tour-step">${n} / ${total} &middot; ${esc(TOUR_CHAPTERS[Math.max(0, _tourChapterAt(_tourI) - 1)] || "")} &middot; <span class="tour-do-tag">your turn</span></div>
      <h3 class="tour-title">${c.title || ""}</h3><div class="tour-body">${(c.html || "") + (s.chIntro ? _tourMapHtml(s.chIntro) : "")}</div>
      <div class="tour-egs">${egs}</div>
      <textarea id="tourAsk" class="my-ta" rows="3" placeholder="${esc(s.placeholder || "type as much or as little as you like - or Skip")}"></textarea>
      <div class="tour-nav"><button class="ghost-btn sm" data-act="tour-ask-skip">Skip this</button><span class="tour-spacer"></span><button class="glow-btn sm" id="tourAskBtn" data-act="tour-ask-add">Add these &rarr;</button></div>`;
    pop.style.visibility = "visible";
    const ta = byId("tourAsk"); if (ta) requestAnimationFrame(() => { try { ta.focus(); } catch(e){} });
    return;
  }

  // ---- CHAT: an inline AI conversation (probing onboard_chat) that draws out the user's OWN items, then applies them ----
  if (s.act === "chat") {
    _tourBlockers(null, false); ring.hidden = true;
    pop.classList.add("tour-center"); pop.style.left = ""; pop.style.top = "";
    if (!_tourChat || _tourChat.card !== s.id) _tourChatReset(s);
    const ch = _tourChat;
    const bubbles = ch.history.map((m) => `<div class="tchat-msg ${m.role === "user" ? "u" : "a"}">${esc(m.content)}</div>`).join("");
    const opener = ch.history.length ? "" : `<div class="tchat-msg a">${(c.html || "") + (s.chIntro ? _tourMapHtml(s.chIntro) : "")}</div>`;
    const typing = ch.busy ? `<div class="tchat-msg a tchat-typing"><span></span><span></span><span></span></div>` : "";
    const right = ch.agreed
      ? `<button class="glow-btn sm" data-act="tour-chat-add" ${ch.busy ? "disabled" : ""}>✨ Add these &rarr;</button>`
      : `<button class="glow-btn sm" data-act="tour-chat-send" ${ch.busy ? "disabled" : ""}>Send</button>`;
    pop.innerHTML = `<div class="tour-step">${n} / ${total} &middot; ${esc(TOUR_CHAPTERS[Math.max(0, _tourChapterAt(_tourI) - 1)] || "")} &middot; <span class="tour-do-tag">let's talk</span></div>
      <h3 class="tour-title">${c.title || ""}</h3>
      <div class="tchat-log" id="tchatLog">${opener}${bubbles}${typing}</div>
      <textarea id="tourAsk" class="my-ta tchat-input" rows="2" placeholder="${esc(s.placeholder || "type your answer - or Skip")}" ${ch.agreed || ch.busy ? "disabled" : ""}></textarea>
      <div class="tour-nav"><button class="ghost-btn sm" data-act="tour-chat-skip" ${ch.busy ? "disabled" : ""}>Skip this</button><span class="tour-spacer"></span>${right}</div>`;
    pop.style.visibility = "visible";
    const log = byId("tchatLog"); if (log) log.scrollTop = log.scrollHeight;
    const cta = byId("tourAsk"); if (cta && !ch.agreed && !ch.busy) requestAnimationFrame(() => { try { cta.focus(); } catch (e) {} });
    return;
  }

  const el = s.center ? null : _q(s.sel);
  const isClick = s.act === "click";
  const isDo = s.act === "do";
  const isAction = isClick || isDo;
  const clickable = isAction && !!el;          // both cut the hole + light the ring; only click attaches a single-shot listener

  let nav;
  if (s.center) {
    nav = `${_tourI > 0 ? '<button class="ghost-btn sm" data-act="tour-prev">&larr; Back</button>' : '<button class="ghost-btn sm" data-act="tour-skip">Skip</button>'}<span class="tour-spacer"></span>` +
          (s.cta2 ? `<button class="ghost-btn sm" data-act="${s.cta2Act || "tour-skip"}">${s.cta2}</button>` : "") +
          `<button class="glow-btn sm" data-act="${s.ctaAct || "tour-next"}">${s.cta || (_tourI === total - 1 ? "Done &check;" : "Next &rarr;")}</button>`;
  } else if (isAction) {
    const skipTxt = clickable ? (isDo ? "do it for me &rarr;" : "skip this &rarr;") : "Next &rarr;";
    nav = `<button class="ghost-btn sm" data-act="tour-skip">Skip tour</button><span class="tour-spacer"></span>${_tourI > 0 ? '<button class="ghost-btn sm" data-act="tour-prev">&larr;</button>' : ""}<button class="ghost-btn sm tour-skipstep" data-act="tour-do">${skipTxt}</button>`;
  } else {
    nav = `<button class="ghost-btn sm" data-act="tour-skip">Skip tour</button><span class="tour-spacer"></span>${_tourI > 0 ? '<button class="ghost-btn sm" data-act="tour-prev">&larr; Back</button>' : ""}<button class="glow-btn sm" data-act="tour-next">${_tourI === total - 1 ? "Done &check;" : "Next &rarr;"}</button>`;
  }
  const turnTag = clickable ? ' &middot; <span class="tour-do-tag">your turn</span>' : "";
  pop.innerHTML = `<div class="tour-step">${n} / ${total}${turnTag}${_tourChapterAt(_tourI) ? " &middot; " + esc(TOUR_CHAPTERS[_tourChapterAt(_tourI) - 1]) : ""}</div>
    <h3 class="tour-title">${c.title || ""}</h3><div class="tour-body">${(c.html || "") + (s.chIntro ? _tourMapHtml(s.chIntro) : "")}</div>${s.hint ? `<div class="tour-hint">${s.hint}</div>` : ""}<div class="tour-nav">${nav}</div>`;

  if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) {} }   // v6.9.3 R1: one-time centre-scroll the sel target into view when the step renders, so every ringed step lands looking at the right place (replaces the reverted scroll-lock/scrollTop pins); the 320ms re-measure below re-runs it for slide-in targets

  // v6.7.8 fix: attach the click listener / do-poll SYNCHRONOUSLY and EXACTLY ONCE here (it needs only `el`, not layout).
  // The old code attached inside the double-rAF measure, which (a) ran twice -> leaked a second setInterval whose orphaned
  // poller raced through every card, and (b) could be lost/delayed by a slow frame. Doing it once, synchronously, fixes both.
  if (isClick && el) { _tourTarget = el; _tourOnClick = () => { _tourDetach();
    if (s.ready) _tourAdvanceWhenReady(s.ready, s.wait || 0);                       // v6.7.11: async click step (e.g. calendarize) waits for its result, not a blind timeout
    else _tourAdvanceSoon(Math.max(s.wait || 360, (s.minShow || 0) - (Date.now() - _tourShownAt))); };  // v6.7.11: respect minShow; v6.7.12: identity-checked so a Back/do-it-for-me tap can't double-advance
    el.addEventListener("click", _tourOnClick, true); }
  if (isDo) {                                                 // v6.7.8: the do-poll watches a STATE predicate, not the target, so attach it even if `el` is briefly null (the capture bar can vanish for a frame mid-render) - that was leaving the step un-advanceable
    _tourSnap = s.snap ? ((() => { try { return s.snap(); } catch(e){ return null; } })()) : null;
    let armed = !s.armWhenFalse;                              // v6.7.11: armWhenFalse steps must observe the predicate go FALSE first, so an already-true state (Back re-entry / already-open rail) can't insta-advance - card 19 "disappeared in <1s"
    if (s.armWhenFalse) { let cur = false; try { cur = !!s.done(_tourSnap); } catch(e){} armed = !cur; }
    const tick = () => {                                      // no _tourPoll guard: _tourDetach clearInterval()s it, and a 0 timer-id (valid) must not read as "stopped"
      let ok = false; try { ok = !!s.done(_tourSnap); } catch(e){ ok = false; }
      if (!armed) { if (!ok) armed = true; return; }          // v6.7.11: wait for false, THEN watch for true
      if (ok && (Date.now() - _tourShownAt) >= (s.minShow || 0)) { _tourDetach(); _tourAdvanceSoon(s.holdAfter || 600); }  // v6.7.11: minShow so a fast/instant predicate never flashes past; v6.7.12: identity-checked advance (no double-skip if the user taps Back/do-it-for-me in the holdAfter window)
    };
    if (s.auto) tick();                                       // already-satisfied guard (only advances if armed)
    _tourPoll = setInterval(tick, s.poll || 250);
  }
  const position = () => {                                    // re-measures + repositions the ring/pop; idempotent, safe to run every frame
    if (!_tourOv) return;                                     // a stale frame after teardown must not paint into a null overlay
    const ringEl = s.ringSel ? (_q(s.ringSel) || el) : el;   // v6.7.11: a step can ring a sub-region (s.ringSel) instead of the whole target
    const r = ringEl ? ringEl.getBoundingClientRect() : null;
    const tooBig = r && (r.width > innerWidth * 0.85 && r.height > innerHeight * 0.85);   // v6.9.2 E1: a target that fills > 85% of BOTH viewport dims is a full-screen overlay (search/idea-enrich/popup fallbacks) - a ring around the whole screen communicates nothing, so never draw one
    if (s.popup) {                                           // v6.7.11: this step works WITH a raised #popup (calz day-card / ETA / pick-5 prompt). The popup is its OWN full-screen modal+backdrop, so don't double-dim - just ring the target on top and park the instruction card in a corner so it never covers the popup or its buttons
      _tourHideBlockers();                                   // v6.7.12 MUST-FIX: TRULY collapse all four blockers (not _tourBlockers(null,false), whose else-branch makes .tb-top full-screen + clickable above the raised popup, eating clicks on the calz X / ETA / pick-5 button)
      if (r && r.width && r.height && !tooBig) {             // v6.9.2 E1: honour the full-screen guard here too (popup steps skip the normal branch entirely)
        const pad = 6; ring.hidden = !!s.noRing /* v6.9.4: noRing = lit hole, no yellow border */; ring.classList.toggle("clickable", clickable); ring.classList.toggle("readlit", !clickable);
        ring.style.left = (r.left - pad) + "px"; ring.style.top = (r.top - pad) + "px"; ring.style.width = (r.width + pad * 2) + "px"; ring.style.height = (r.height + pad * 2) + "px";
      } else { ring.hidden = true; }
      _tourPlacePopCorner(pop); return;
    }
    if (r && r.width && r.height && !tooBig) {
      let rr = r;                                             // v6.7.21: clamp only an oversized HEIGHT (a tall day column) - NEVER the width. A wide-but-thin target (the capture bar, the command-hint row) must keep its full width, or a centered box cuts off half its content (the card-3 "commands outside the yellow box" bug). A full-width thin ring is correct.
      if (!s.fullRing && r.height > innerHeight * 0.7) {   // v6.10.0: fullRing = ring the WHOLE tall target (owner: highlight the entire right drawer)
        const cy = r.top + r.height / 2, h = Math.min(r.height, 420);
        rr = { left: r.left, top: cy - h / 2, right: r.right, bottom: cy + h / 2, width: r.width, height: h };
      }
      let holeR = rr, holeExplicit = false;                                         // v6.9.2 (C14/C30 holeSel): the RING stays on `sel`, but a step can expose a LARGER interactive region for the spotlight hole (e.g. the whole drawer, or the canvas board+rail) so the user can actually reach it
      if (s.holeSel) { const he = _q(s.holeSel), hr = he && he.getBoundingClientRect(); if (hr && hr.width && hr.height) { holeR = hr; holeExplicit = true; } }
      _tourBlockers(holeR, true, holeExplicit);                             // ALWAYS cut the spotlight hole (read steps too)
      const pad = 6;
      ring.hidden = !!s.noRing /* v6.9.4: noRing = lit hole, no yellow border */;
      ring.classList.toggle("clickable", clickable);
      ring.classList.toggle("readlit", !clickable);           // read steps get the soft fill glow
      ring.style.left = (rr.left - pad) + "px"; ring.style.top = (rr.top - pad) + "px"; ring.style.width = (rr.width + pad * 2) + "px"; ring.style.height = (rr.height + pad * 2) + "px";
      if (s.corner) _tourPlacePopCorner(pop); else _tourPlacePop(pop, rr);  // v6.9: a side-panel step can force the corner-park placement so the instruction card never covers the panel it's explaining
      if (!isAction) { _tourReadActive = true; document.addEventListener("click", _tourReadGuard, true); }  // shield the lit read target (same fn+capture -> the browser dedups, never stacks)
    } else if (s.holeSel) {                                    // v6.9.2 C14: the ring target briefly missing (e.g. a drawer button not yet rendered) must NOT drop a full-screen dim over the interactive region - keep the holeSel hole open so the user can always reach the drawer
      const he = _q(s.holeSel), hr = he && he.getBoundingClientRect();
      if (hr && hr.width && hr.height) { _tourBlockers(hr, true, true); ring.hidden = true; if (s.corner) _tourPlacePopCorner(pop); else _tourPlacePop(pop, hr); }
      else { _tourBlockers(null, false); ring.hidden = true; pop.classList.add("tour-center"); pop.style.left = ""; pop.style.top = ""; pop.style.visibility = "visible"; }
    } else {
      _tourBlockers(null, false); ring.hidden = true; pop.classList.add("tour-center"); pop.style.left = ""; pop.style.top = ""; pop.style.visibility = "visible";
    }
  };
  const _i0 = _tourI, _ov0 = _tourOv;
  // v6.9.3 R1: run the place() pass EVERY frame while this same card is up (identity-guarded; cancelled on teardown via _tourStopPoll -> cancelAnimationFrame(_tourRaf)) so the ring/hole/pop FOLLOW the target through free page scroll, a drawer/panel slide-in, or any reflow. The page scrolls freely now that the scroll-lock is reverted, so a static ring would drift off its target. position() has no advance/poll side effects (the do-poll + click listener are armed once, above) - it only re-measures, so looping it is safe.
  const _placeLoop = () => { if (_tourOv !== _ov0 || _tourI !== _i0) return; position(); _tourRaf = requestAnimationFrame(_placeLoop); };
  _tourRaf = requestAnimationFrame(_placeLoop);
  setTimeout(() => { if (_tourOv === _ov0 && _tourI === _i0) try { if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" }); position(); } catch (e) {} }, 320);   // v6.9.3 R1: re-centre-scroll the sel target once more AFTER a slide-in settles (ALL sel steps, not only holeSel), identity-guarded
}
function _tourBlockers(r, hole, explicit) {   // v6.9.4b: explicit = a deliberate holeSel hole - the heuristics below must never shrink it
  const vw = innerWidth, vh = innerHeight, b = _tourOv, pad = 6;
  if (!b) return;                                            // v6.7.8: guard against a torn-down overlay (stale frame)
  const set = (cls, x, y, w, h) => { const e = b.querySelector(cls); if (!e) return; e.style.cssText = "left:" + x + "px;top:" + y + "px;width:" + Math.max(0, w) + "px;height:" + Math.max(0, h) + "px"; };
  if (hole && r) {
    const cb = document.querySelector(".capture");           // v6.7.11: never let the spotlight hole rise above the sticky capture bar - it would bleed through and look like it floats over the content (card 20)
    const minTop = cb ? cb.getBoundingClientRect().bottom : 0;
    const clampTop = !explicit && r.bottom > minTop + 4;   // v6.9.4b: the capture-bar clamp was silently covering the More menu's top rows (Travel/Guardian unclickable)                   // only when the target extends BELOW the bar (don't hide a target that IS the capture bar, e.g. the capture step)
    const l = r.left - pad, t = clampTop ? Math.max(minTop, r.top - pad) : (r.top - pad), rr = r.right + pad, bb = r.bottom + pad;
    set(".tb-top", 0, 0, vw, t); set(".tb-bottom", 0, bb, vw, vh - bb); set(".tb-left", 0, t, l, bb - t); set(".tb-right", rr, t, vw - rr, bb - t);
  } else { set(".tb-top", 0, 0, vw, vh); set(".tb-bottom", 0, 0, 0, 0); set(".tb-left", 0, 0, 0, 0); set(".tb-right", 0, 0, 0, 0); }
}
function _tourHideBlockers() {                             // v6.7.12: collapse ALL four dim panels to 0x0 (used by popup steps - the popup supplies its own backdrop, and a sized .tb above the raised popup would eat clicks)
  if (!_tourOv) return;
  ["top", "bottom", "left", "right"].forEach((p) => { const e = _tourOv.querySelector(".tb-" + p); if (e) e.style.cssText = "left:0;top:0;width:0;height:0"; });
}
function _tourPlacePopCorner(pop) {                        // v6.7.11: park the instruction card in a safe bottom-left corner so it never covers a raised popup/modal (the calz day-card etc.)
  pop.classList.remove("tour-center");
  const ph = pop.offsetHeight || 220, vh = innerHeight;
  pop.style.left = "18px"; pop.style.top = Math.max(12, vh - ph - 18) + "px"; pop.style.visibility = "visible";
}
function _tourPlacePop(pop, r) {
  pop.style.visibility = "hidden"; pop.classList.remove("tour-center"); pop.style.left = "0"; pop.style.top = "0";
  const ph = pop.offsetHeight || 200, pw = pop.offsetWidth || 360, vw = innerWidth, vh = innerHeight;
  let left = Math.min(Math.max(12, r.left + r.width / 2 - pw / 2), vw - pw - 12), top;
  if (r.bottom + 16 + ph < vh) top = r.bottom + 16;
  else if (r.top - 16 - ph > 0) top = r.top - 16 - ph;
  else if (r.right + 16 + pw < vw) { left = r.right + 16; top = Math.min(Math.max(12, r.top), vh - ph - 12); }
  else if (r.left - 16 - pw > 0) { left = r.left - 16 - pw; top = Math.min(Math.max(12, r.top), vh - ph - 12); }
  else top = Math.max(12, vh / 2 - ph / 2);
  pop.style.left = left + "px"; pop.style.top = top + "px"; pop.style.visibility = "visible";
}
// ===== v6.7.13: AI chatbot+guide ONBOARDING ("make it yours" redesign). After the demo, the Nuclear button wipes
// everything and walks the user through building THEIR OWN life - a back-and-forth chat per area (habits, rhythms, ...),
// then the agreed answer becomes real items via the existing /api/life_add. Cyberpunk chat window; anti-runaway teardown
// mirrors the tour (every async tail is identity-checked; _onbDetach removes the overlay + clears state). =====
let _onbOv = null, _onbI = 0, _onbHistory = [], _onbAnswers = [], _onbAgreed = false, _onbBusy = false, _onbProposal = null, _onbGuidePoll = null;
const ONBOARD = [
  { id: "habits", round: "habits", title: "Your habits",
    opener: "Let's build YOUR Himmah. First, your <b>habits</b> - the things you push yourself to do (willpower, streaks). What do you want to build, and roughly how many minutes a day? Name a few." },
  { id: "rhythms", round: "rhythms", title: "Your rhythms",
    opener: "Now your <b>rhythms</b> - the gentle automatic ones (sleep on time, sunlight) and the worship you do naturally (adhkar after salah, sunnah, Surah al-Kahf on Friday). What comes to mind?" },
  { id: "categories", apply: "categories", title: "Your life areas",
    opener: "Now the <b>areas of your life</b> - the categories your tasks live in (e.g. Work, Deen, Health, Family, Study). What are the few that matter most to you?" },
  { id: "tasks", round: "tasks", title: "What's on your plate",
    opener: "Time to empty your head. What's actually <b>on your plate</b> right now - errands, deadlines, that thing you keep putting off? Don't sort it, just let it pour. I'll turn it into real tasks (and split big ones into steps)." },
  { id: "interview", apply: "interview", title: "A quick interview",
    opener: "Now let me get to know your life - the latest. Tell me about your <b>work or study, your family, your deen goals, any big projects</b> - whatever is filling your days this season. I'll remember it, so later I can sharpen even your vaguest notes." },
  { id: "dump", title: "Dump a few rough notes", guide: {
    html: "Now the fun part - <b>do it for real.</b> Use the <b>dump-a-thought box</b> at the very top: type a few rough, vague notes and hit Enter, like you'd jot to yourself - <i>\"that email thing\", \"fix the bug\", \"call mum\"</i>. Don't polish them; we'll sharpen them with AI next.",
    hint: "type in the capture box + Enter, a few times",
    snap: () => state.items.filter((i) => i.status === "inbox").length,
    done: (n) => state.items.filter((i) => i.status === "inbox").length >= (n || 0) + 3,
    progress: (n) => {                                                   // v6.9: live feedback so the person knows when to stop adding tasks
      const got = state.items.filter((i) => i.status === "inbox").length - (n || 0);
      if (got <= 0) return "";
      return got >= 3 ? ("✓ " + got + " notes in - that is a good pile, ready when you are") : (got + " note" + (got === 1 ? "" : "s") + " in - keep going or move on when ready");
    },
    fb: () => { ["that email thing", "fix the login bug", "call mum about the weekend"].forEach((t) => { try { addCapture(t); } catch (e) {} }); } } },
  { id: "triage", title: "Sort your inbox with AI", guide: {
    html: "See those rough notes pile up in your <b>Inbox</b>? Open it (top bar), pick one, and hit <b>✦ Apply all</b> - watch the AI fix the wording, expand it using what you just told me about your life, estimate it, and suggest a category. Accept or reject each one - it's your call.",
    hint: "open Inbox -> ✦ Apply all on a note -> accept the suggestions",
    snap: () => state.items.filter((i) => i.status === "inbox").length,
    done: (n) => state.items.filter((i) => i.status === "inbox").length < (n || 0),
    fb: () => { try { closeAllPanels(); openInbox(); } catch (e) {} } } },
  { id: "prayers", title: "Block out your prayers", guide: {
    html: "Open <b>Calendar</b> (top bar), then <b>📿 prayer times</b>, and block out this week's prayers - Himmah plans your whole week <i>around</i> your salah, not the leftover. (Paste your own masjid's timetable - any format works.)",
    hint: "Calendar -> 📿 prayer times -> populate this week",
    snap: () => (state.events || []).filter((e) => e && (e.prayer || e.scheduleId === "sch_prayer")).length,
    done: (n) => (state.events || []).filter((e) => e && (e.prayer || e.scheduleId === "sch_prayer")).length > (n || 0),
    fb: () => { try { closeAllPanels(); openCalendar(); if (typeof calSetView === "function") calSetView("week"); } catch (e) {} } } },
  { id: "lesson", title: "Add a weekly lesson", guide: {
    html: "Got a weekly class or halaqa? Add it as a <b>repeating event</b>: Calendar -> <b>＋ event</b>, give it a day + time, tick <b>Repeat</b>. It becomes a fixed wall your week gets planned around.",
    hint: "Calendar -> ＋ event -> set a weekday + Repeat",
    snap: () => (state.events || []).length,
    done: (n) => (state.events || []).length > (n || 0),
    fb: () => { try { closeAllPanels(); openCalendar(); } catch (e) {} } } },
  { id: "events", title: "Your weekly shape", guide: {
    html: "Build out your week: add a <b>schedule</b> (a colored lane like Work or Study), then a couple of <b>events</b> on it. Open an event to see everything - recurrence, an AI-drafted description, prayer-aware timing, even a Meet link.",
    hint: "Calendar -> ＋ schedule, then ＋ event",
    snap: () => (state.schedules || []).length + (state.events || []).length,
    done: (n) => (state.schedules || []).length + (state.events || []).length > (n || 0),
    fb: () => { try { closeAllPanels(); openCalendar(); } catch (e) {} } } },
  { id: "calendarize", title: "Let AI plan tomorrow", guide: {
    html: "The magic: in <b>Calendar</b>, tap the <b>gear</b> for the quick preferences quiz (how YOU work), then hit <b>✦ Calendarize tomorrow</b> - the AI lays your day out as time-blocks, importance-first and prayer-aware. Bend it, then it's yours.",
    hint: "Calendar -> quiz (gear) -> ✦ Calendarize tomorrow",
    snap: () => !!document.querySelector(".calz-day-card"),
    done: () => !!document.querySelector(".calz-day-card"),
    fb: () => { try { closeAllPanels(); openCalendar(); if (typeof calSetView === "function") calSetView("week"); if (typeof calendarizeNextDay === "function") calendarizeNextDay(); } catch (e) {} } } },
  { id: "guardian", title: "Protect what slips", guide: {
    html: "When life speeds up, what's the first good thing to slip - your wird, the gym, sleep? Open <b>Guardian</b> (top bar) and put a shield on <b>one religious habit</b>, so Himmah protects it and warns you before it quietly vanishes.",
    hint: "Guardian -> shield one habit",
    snap: () => ((state.meta && state.meta.guardian && state.meta.guardian.protectedIds) || []).length,
    done: (n) => ((state.meta && state.meta.guardian && state.meta.guardian.protectedIds) || []).length > (n || 0),
    fb: () => { try { closeAllPanels(); openGuardian(); } catch (e) {} } } },
  { id: "waiting", title: "Track what you're waiting on", guide: {
    html: "Something stuck on someone ELSE - a reply, an approval? Open <b>Waiting</b> (top bar) and add it (or flag a task as waiting). It leaves your active list but is never forgotten - it returns the moment it's unblocked.",
    hint: "Waiting -> add what you're blocked on",
    snap: () => (state.items || []).filter((i) => i && (typeof isWaiting === "function" ? isWaiting(i) : (i.waitingOn || i.status === "waiting"))).length,
    done: (n) => (state.items || []).filter((i) => i && (typeof isWaiting === "function" ? isWaiting(i) : (i.waitingOn || i.status === "waiting"))).length > (n || 0),
    fb: () => { try { closeAllPanels(); openWaiting(); } catch (e) {} } } },
  { id: "travel", title: "Travelling? Keep your good", guide: {
    read: true,
    html: "Heading away soon? Tap <b>✈ Travel</b> (top bar). Himmah helps you keep your prayers (combine/shorten) and your habits alive on the road, instead of dropping everything. Have a look - you can switch it off again." } },
  { id: "voice", title: "Capture with your voice", guide: {
    html: "Hands full? Tap the <b>🎙 mic</b> in the capture bar and just say a task out loud - it lands in your Inbox like any other thought. Try one now.",
    hint: "tap the 🎙 mic and speak a task",
    snap: () => (state.items || []).length,
    done: (n) => (state.items || []).length > (n || 0),
    fb: () => { try { addCapture("a task I said out loud"); } catch (e) {} } } },
  { id: "ctrlk", title: "Ctrl+K - your launchpad", guide: {
    html: "Press <b>Ctrl + K</b> (or Cmd+K). A glowing search opens - type any task and jump straight to it, tick it done, or act on it without hunting. The fastest way around Himmah.",
    hint: "press Ctrl + K, then search a task",
    snap: () => false,
    done: () => { const ov = byId("searchOverlay"); return !!(ov && !ov.hidden); },
    fb: () => { try { searchOpen(); } catch (e) {} } } },
  { id: "canvas", title: "Play on the canvas", guide: {
    html: "Switch to <b>Canvas</b> (bottom bar) and play - drag your task cards around, cluster a project in a corner, flip between <i>by category</i> and <i>by urgency</i>. Some minds finally think clearly in space.",
    hint: "Canvas -> drag your cards around",
    snap: () => viewMode,
    done: () => viewMode === "canvas",
    fb: () => { try { viewMode = "canvas"; persistUi(); render(); } catch (e) {} } } },
  { id: "complete", title: "Complete, archive, history", guide: {
    html: "Knock something out: <b>check off</b> any task (the circle on its card). Done tasks slide into <b>Archive</b> (top bar) - nothing's lost - and <b>History</b> lets you rewind your whole board to any moment. Tick one to feel the loop close.",
    hint: "check a task done, then peek at Archive + History",
    snap: () => (state.items || []).filter((i) => i && i.status === "done").length,
    done: (n) => (state.items || []).filter((i) => i && i.status === "done").length > (n || 0),
    fb: () => { try { const t = (state.items || []).find((i) => i && i.status === "active"); if (t) { t.status = "done"; t.doneAt = (typeof nowIso === "function" ? nowIso() : new Date().toISOString()); scheduleSave(); render(); } } catch (e) {} } } },
  { id: "tidy", title: "Tidy - your weekly broom", guide: {
    read: true,
    html: "Last thing: <b>Tidy</b> (top bar) is your gentle weekly broom - it surfaces stale tasks and asks <i>keep, snooze, or archive?</i> A quick sweep keeps your board honest. That's everything - you're ready." } },
];
function startOnboarding() {
  if (_onbOv) return;                                          // already running - never stack
  _onbI = 0;
  _onbOv = document.createElement("div"); _onbOv.id = "onbChat";
  _onbOv.innerHTML = `<div class="onb-card">
    <div class="onb-head"><span class="onb-kicker">✦ Make it yours</span><span class="onb-stage" id="onbStage"></span><button class="onb-x" data-act="onb-skip" title="leave setup">✕</button></div>
    <div class="onb-stopwarn" id="onbStopWarn" hidden><span>Your Himmah works best when I know your life - stop anyway? Progress so far is <b>KEPT</b>.</span><span class="onb-stopwarn-btns"><button class="ghost-btn sm" data-act="onb-skip-keep">Keep going</button><button class="ghost-btn sm danger" data-act="onb-skip-confirm">Stop here</button></span></div>
    <div class="onb-msgs" id="onbMsgs"></div>
    <div class="onb-foot">
      <div class="onb-input-row" id="onbInputRow"><textarea id="onbInput" class="onb-input" rows="2" placeholder="type your answer, then Send (or Enter)"></textarea><button class="glow-btn sm" data-act="onb-send">Send</button><button class="ghost-btn sm" id="onbWrapupBtn" data-act="onb-wrapup" title="wrap up this part with what you've told me so far" hidden>I have enough - wrap this up &rarr;</button></div>
      <div class="onb-actions" id="onbActions" hidden><button class="glow-btn" data-act="onb-apply">✨ Add these &amp; continue →</button></div>
      <div class="onb-actions" id="onbGuideActions" hidden></div>
      <div class="onb-skiprow" id="onbSkipRow" hidden><button class="onb-skip-link" data-act="onb-stage-skip">skip this part →</button></div>
    </div></div>`;
  document.body.appendChild(_onbOv);
  const ta = byId("onbInput");
  if (ta) ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _onbSend(); } });
  _onbStartStage();
}
function _onbStartStage() {
  const st = ONBOARD[_onbI]; if (!st) return _onbFinale();
  _onbHistory = []; _onbAnswers = []; _onbAgreed = false; _onbProposal = null;
  _onbGuideStop();
  if (_onbOv) _onbOv.classList.remove("onb-mini");                       // v6.7.16: leave guide mode if we were in it
  const stg = byId("onbStage"); if (stg) stg.textContent = (_onbI + 1) + " / " + ONBOARD.length + " · " + st.title;
  const acts = byId("onbActions"); if (acts) acts.hidden = true;
  const gacts = byId("onbGuideActions"); if (gacts) { gacts.hidden = true; gacts.innerHTML = ""; }
  const irow = byId("onbInputRow"); if (irow) irow.hidden = false;
  const sk = byId("onbSkipRow"); if (sk) sk.hidden = false;              // v6.7.20 #5: chat stages always offer a per-stage skip
  const ab = _onbOv && _onbOv.querySelector('[data-act="onb-apply"]'); if (ab) { ab.disabled = false; ab.innerHTML = "✨ Add these &amp; continue →"; }  // v6.7.13: reset the Apply button (a prior stage left it disabled/"adding...")
  const m = byId("onbMsgs"); if (m) m.innerHTML = "";
  _onbUpdateWrapupBtn();                                                  // v6.9: a fresh stage has 0 messages yet - hide the wrap-up-early button until the user speaks once
  if (!st.opener && st.guide) { _onbGuide(st.guide); return; }           // v6.7.16: a pure-guide stage (no chat) - straight to the guided real-UI action
  _onbPush("ai", st.opener || "");
  const ta = byId("onbInput"); if (ta) { ta.value = ""; ta.disabled = false; requestAnimationFrame(() => { try { ta.focus(); } catch (e) {} }); }
}
// v6.9: "I have enough - wrap this up" is offered once the user has said at least one thing this stage and the AI hasn't yet agreed - a way to stop a probing round early once enough is on the table.
function _onbUpdateWrapupBtn() {
  const b = byId("onbWrapupBtn"); if (!b) return;
  const userTurns = _onbHistory.filter((m) => m && m.role === "user").length;
  b.hidden = !(userTurns >= 1 && !_onbAgreed);
}
function _onbPush(role, html) {
  const m = byId("onbMsgs"); if (!m) return null;
  const b = document.createElement("div"); b.className = "onb-msg onb-" + role; b.innerHTML = html;
  m.appendChild(b); m.scrollTop = m.scrollHeight; return b;
}
async function _onbSend() {
  if (_onbBusy || !_onbOv) return;
  const st = ONBOARD[_onbI]; if (!st) return;
  const ta = byId("onbInput"); const ans = ((ta || {}).value || "").trim();
  if (!ans) return;
  _onbPush("user", esc(ans)); _onbHistory.push({ role: "user", text: ans }); _onbAnswers.push(ans);
  if (ta) ta.value = "";
  _onbUpdateWrapupBtn();                                                  // v6.9: at least one message sent this stage - the wrap-up-early button can now appear
  const i0 = _onbI, ov0 = _onbOv;
  _onbBusy = true; const typing = _onbPush("ai", "<i class='onb-typing'>thinking…</i>");
  let res;
  try { res = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "onboard_chat", stage: st.chatStage || st.id, history: _onbHistory.slice(-12), answer: ans }) }).then((r) => r.json()); }
  catch (e) { _onbBusy = false; if (typing) typing.innerHTML = "⚠ " + esc(e.message) + " - try again"; return; }
  _onbBusy = false;
  if (_onbOv !== ov0 || _onbI !== i0) return;                  // user left / advanced during the call
  if (res && res.status) { Object.assign(aiStatus, res.status); renderAiChip(); }
  if (!res || !res.ok || res.error) {                          // v6.7.20 #1: surface AI errors (budget cap 429 / no key 503 / outage 502) instead of looping the friendly fallback forever
    if (typing) typing.remove();
    _onbPush("ai", "⚠ " + esc((res && res.error) || "the AI is unavailable right now - give it a moment and try again, or skip this part below") + ".");
    return;
  }
  const r = (res && res.result) || {};
  if (typing) typing.remove();
  _onbPush("ai", esc(r.reply || "Tell me a little more?"));
  _onbHistory.push({ role: "ai", text: r.reply || "" });
  if (r.agreed) { _onbAgreed = true; _onbProposal = r.proposal || null; const acts = byId("onbActions"); if (acts) acts.hidden = false; }
  else { _onbAgreed = false; _onbProposal = null; const acts = byId("onbActions"); if (acts) acts.hidden = true; }  // v6.7.20 #3: re-chatting after agreement resets the stale proposal + hides Apply (else categories Apply consumes a stale proposal = data loss)
  _onbUpdateWrapupBtn();                                                  // v6.9: hide the wrap-up button once the AI has agreed (Add these & continue takes over)
}
// v6.7.14: create the agreed categories directly from the chat proposal (the categories don't fit /api/life_add's round set)
function _onbApplyCategories() {
  const cats = (_onbProposal && _onbProposal.categories) || [];
  const PAL = ["#4a8fff", "#22C55E", "#A855F7", "#F472B6", "#62e3ff", "#f5c46f", "#e068ff", "#7cd99e"];
  let added = 0;
  state.categories = state.categories || [];
  cats.forEach((c) => {
    const name = ((c && (c.name || c)) || "").toString().trim(); if (!name) return;
    if (state.categories.some((x) => (x.name || "").toLowerCase() === name.toLowerCase())) return;  // dedupe by name
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 18) || "cat";
    state.categories.push({ id: "c_" + slug + "_" + state.categories.length, name: name, color: PAL[state.categories.length % PAL.length], order: state.categories.length, collapsed: false });
    added++;
  });
  return added;
}
async function _onbApply() {
  if (_onbBusy || !_onbOv) return;
  const st = ONBOARD[_onbI]; if (!st) return;
  if (!st.apply && !st.round) { if (st.guide) _onbGuide(st.guide); else _onbAdvance(); return; }  // v6.9 FIX: a pure-guide stage (e.g. "prayers") has no apply-kind and no round - the OLD code fell into the generic branch below and POSTed /api/life_add with round:undefined, which the server rejects, so the green "Add these & continue" button silently dead-ended (it's also hidden during guide phase, making the whole thing look like a dead click). Pressing it must ALWAYS visibly move the flow forward, so hand off straight to the guide phase (or just advance if there's truly nothing to do).
  const i0 = _onbI, ov0 = _onbOv;
  const btn = _onbOv.querySelector('[data-act="onb-apply"]'); if (btn) { btn.disabled = true; btn.textContent = "✨ adding…"; }
  _onbBusy = true;
  if (st.apply === "categories") {                              // v6.7.14: client-side application (no AI re-run)
    const n = _onbApplyCategories();
    _onbBusy = false;
    if (_onbOv !== ov0 || _onbI !== i0) return;
    if (n === 0) { if (btn) { btn.disabled = false; btn.textContent = "✨ Add these & continue →"; } _onbPush("ai", "I didn't catch any concrete areas there - tell me a bit more, or skip this part."); return; }  // v6.7.20 #7: don't claim "added 0" + advance past an empty stage
    try { await saveNow(); render(); } catch (e) {}
    _onbPush("ai", "✓ added " + n + " life area" + (n === 1 ? "" : "s") + " - your categories are set.");
    setTimeout(() => { if (_onbOv === ov0 && _onbI === i0) _onbAfterApply(); }, 700);
    return;
  }
  if (st.apply === "interview") {                               // v6.7.15: synthesize the interview -> write data/life_context.md (the file enrich reads)
    let r;
    try { r = await fetch("/api/life_context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: _onbAnswers }) }).then((x) => x.json()); }
    catch (e) { _onbBusy = false; if (btn) { btn.disabled = false; btn.textContent = "✨ Add these & continue →"; } _onbPush("ai", "⚠ " + esc(e.message)); return; }
    _onbBusy = false;
    if (_onbOv !== ov0 || _onbI !== i0) return;
    if (r && r.status) { Object.assign(aiStatus, r.status); renderAiChip(); }
    if (!r || !r.ok) { if (btn) { btn.disabled = false; btn.textContent = "✨ Add these & continue →"; } _onbPush("ai", "⚠ " + esc((r && r.error) || "couldn't save - try again or skip")); return; }
    _onbPush("ai", "✓ saved your life context - I'll use it to enrich your notes (" + (r.chars || 0) + " chars).");
    setTimeout(() => { if (_onbOv === ov0 && _onbI === i0) _onbAfterApply(); }, 700);
    return;
  }
  const now = new Date();
  let res;
  try { res = await fetch("/api/life_add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ round: st.round, answer: _onbAnswers.join(". "), spec: _onbProposal || undefined, today: _isod(now), weekday: CAL_FULLDOW[now.getDay()] }) }).then((r) => r.json()); }
  catch (e) { _onbBusy = false; if (btn) { btn.disabled = false; btn.textContent = "✨ Add these & continue →"; } _onbPush("ai", "⚠ " + esc(e.message)); return; }
  _onbBusy = false;
  if (_onbOv !== ov0 || _onbI !== i0) return;                  // left/moved during the POST - never act on a stale stage
  if (res && res.status) { Object.assign(aiStatus, res.status); renderAiChip(); }
  if (!res || !res.ok) { if (btn) { btn.disabled = false; btn.textContent = "✨ Add these & continue →"; } _onbPush("ai", "⚠ " + esc((res && res.error) || "couldn't add - try again or skip")); return; }
  const a = res.added || {}; const n = (a.tasks || 0) + (a.projects || 0) + (a.habits || 0) + (a.rhythms || 0) + (a.islamic_rhythms || 0) + (a.events || 0);
  if (n === 0) { if (btn) { btn.disabled = false; btn.textContent = "✨ Add these & continue →"; } _onbPush("ai", "Hmm, I didn't catch anything concrete to add there - tell me a bit more, or skip this part."); return; }  // v6.7.20 #7: don't claim "added 0" + advance past an empty stage
  try { const r2 = await fetch("/api/state"); _tourMergeState(await r2.json()); render(); } catch (e) {}
  _onbPush("ai", "✓ added " + n + " - they're on your board now.");
  setTimeout(() => { if (_onbOv === ov0 && _onbI === i0) _onbAfterApply(); }, 700);
}
function _onbAfterApply() {   // v6.7.16: a chat stage finished applying - if it also has a guided real-UI action, run it; else advance
  const st = ONBOARD[_onbI];
  if (st && st.guide) _onbGuide(st.guide); else _onbAdvance();
}
function _onbGuideStop() { if (_onbGuidePoll) { clearInterval(_onbGuidePoll); _onbGuidePoll = null; } }
function _onbGuide(g) {       // v6.7.16: the GUIDE phase - shrink the chat to a corner (non-blocking) + watch a real-UI predicate; the user does the real action, then we advance
  if (!_onbOv) return;
  _onbGuideStop();
  _onbOv.classList.add("onb-mini");
  const irow = byId("onbInputRow"); if (irow) irow.hidden = true;
  const acts = byId("onbActions"); if (acts) acts.hidden = true;
  const sk = byId("onbSkipRow"); if (sk) sk.hidden = true;               // v6.7.20: guide stages have their own skip
  const m = byId("onbMsgs"); if (m) m.innerHTML = "";
  _onbPush("ai", (g.html || "") + (g.hint ? "<div class='onb-hint'>" + g.hint + "</div>" : ""));
  const gacts = byId("onbGuideActions");
  if (g.read) { if (gacts) { gacts.hidden = false; gacts.innerHTML = '<button class="glow-btn sm" data-act="onb-guide-next">got it →</button>'; } return; }  // v6.7.18: a read-recap stage - no predicate, just "got it"
  _onbPush("ai", "<i class='onb-typing'>⏳ I'm watching - do it whenever you're ready.</i><span class=\"onb-guide-progress\" id=\"onbGuideProgress\"></span>");   // v6.9: onbGuideProgress is a live line a guide step can update in the poll (e.g. "2 notes in - keep going...")
  if (gacts) { gacts.hidden = false; gacts.innerHTML = (g.fb ? '<button class="ghost-btn sm" data-act="onb-guide-do">do it for me →</button>' : "") + '<button class="ghost-btn sm" data-act="onb-guide-skip">skip this →</button>'; }
  const i0 = _onbI, ov0 = _onbOv;
  const snap = g.snap ? ((() => { try { return g.snap(); } catch (e) { return null; } })()) : null;
  let armed = true;                                                      // v6.7.20 #4: if the predicate is ALREADY true on entry (viewMode already 'canvas', Ctrl+K already open, a stale calz card), wait for a false->true transition instead of firing "you did it" for something they never did
  try { if (!!g.done(snap)) armed = false; } catch (e) {}
  const tick = () => {
    let ok = false; try { ok = !!g.done(snap); } catch (e) { ok = false; }
    if (g.progress) { try { const txt = g.progress(snap); const pel = byId("onbGuideProgress"); if (pel) pel.textContent = txt || ""; } catch (e) {} }  // v6.9: live progress feedback (e.g. dump stage's capture count) so the user knows when to stop/move on
    if (!armed) { if (!ok) armed = true; return; }
    if (ok) _onbGuideDone(i0, ov0);
  };
  if (g.auto && armed) tick();
  _onbGuidePoll = setInterval(tick, g.poll || 350);
}
function _onbGuideDone(i0, ov0) {
  _onbGuideStop();
  if (!_onbOv || _onbOv !== ov0 || _onbI !== i0) return;        // user left / advanced / skipped - never double-advance
  _onbOv.classList.remove("onb-mini");
  const gacts = byId("onbGuideActions"); if (gacts) { gacts.hidden = true; gacts.innerHTML = ""; }
  _onbPush("ai", "✓ beautifully done - you just did it for real.");
  setTimeout(() => { if (_onbOv === ov0 && _onbI === i0) _onbAdvance(); }, 800);
}
function _onbAdvance() { _onbGuideStop(); _onbI++; if (_onbI >= ONBOARD.length) return _onbFinale(); _onbStartStage(); }
function _confettiBurst() {   // v6.7.17: self-contained cyberpunk confetti (no external lib - keyless-clean); ~2.8s then removes itself
  let cv;
  try { cv = document.createElement("canvas"); } catch (e) { return; }
  cv.className = "onb-confetti"; cv.style.cssText = "position:fixed;inset:0;z-index:100060;pointer-events:none";
  document.body.appendChild(cv);
  const ctx = cv.getContext("2d"); if (!ctx) { cv.remove(); return; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const resize = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  resize();
  const COLORS = ["#7c6bff", "#4a8fff", "#62e3ff", "#22C55E", "#f5c46f", "#e068ff"];
  const parts = [];
  for (let i = 0; i < 170; i++) parts.push({ x: innerWidth * (0.2 + 0.6 * Math.random()), y: -20 - Math.random() * innerHeight * 0.4, vx: (Math.random() - 0.5) * 7, vy: 2 + Math.random() * 5, r: 3 + Math.random() * 5, c: COLORS[(Math.random() * COLORS.length) | 0], rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.32 });
  let t0 = null;
  const frame = (t) => { if (t0 === null) t0 = t; const el = t - t0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) { p.vy += 0.12; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.99;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.max(0, 1 - el / 2700); ctx.fillStyle = p.c; ctx.shadowColor = p.c; ctx.shadowBlur = 8; ctx.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r); ctx.restore(); }
    if (el < 2800 && cv.parentNode) requestAnimationFrame(frame); else if (cv.parentNode) cv.remove();
  };
  requestAnimationFrame(frame);
}
function _onbFinale() {
  const m = byId("onbMsgs"); if (m) m.innerHTML = "";
  const stg = byId("onbStage"); if (stg) stg.textContent = "complete";
  if (_onbOv) _onbOv.classList.remove("onb-mini");
  const foot = _onbOv && _onbOv.querySelector(".onb-foot"); if (foot) foot.hidden = true;
  try { _confettiBurst(); } catch (e) {}
  const cats = (state.categories || []).length, hab = (state.rhythms || []).length;
  const tasks = (state.items || []).filter((i) => i && i.type !== "rhythm").length, evs = (state.events || []).length;
  _onbPush("ai", "🎉 <b>It's yours now.</b><br><br>You built <b>" + tasks + "</b> tasks, <b>" + hab + "</b> habits &amp; rhythms, <b>" + cats + "</b> life areas" + (evs ? ", and <b>" + evs + "</b> calendar blocks" : "") + ", and you taught me about your life. Himmah is no longer a demo - it's <i>your</i> week.<br><br>One last gift: press <b>Ctrl + K</b> any time to search, jump to, or act on anything - your launchpad. I'll show you now.<br><br><button class='glow-btn' data-act='onb-done'>Begin my week →</button>");
}
function _onbSkip() { _onbDetach(); }
function _onbDetach() { _onbGuideStop(); if (_onbOv) { _onbOv.remove(); _onbOv = null; } _onbHistory = []; _onbAnswers = []; _onbAgreed = false; _onbBusy = false; }
async function nukeAndOnboard() {
  try { await clearAll(); } catch (e) { toast("⚠ " + e.message); }   // full wipe - clearAll snapshots the demo server-side first, so History is the undo
  startOnboarding();
}
function maybeStartTour() { if (state && state.meta && state.meta.demo && !state.meta.tourDone) setTimeout(startTour, 650); }
document.addEventListener("keydown", (e) => {
  if (!_tourOv) return;
  const s = _tourStep();
  if (e.key === "Escape") { e.preventDefault(); tourEnd(false); }
  else if ((e.key === "ArrowRight" || e.key === "Enter") && (!s || (s.act !== "click" && s.act !== "do" && s.act !== "ask" && s.act !== "chat"))) { e.preventDefault(); tourNext(); }   // v6.9.4 FIX: this is a CAPTURE-phase listener so it ran BEFORE the "chat" card's own Enter-sends handler ever saw the keydown - Enter in the #tourAsk chat textarea silently skipped straight to the next card (no /api/ai call, ever) because "chat" was missing from this exclusion list (added for "ask" cards long before act:"chat" existed)
  else if (e.key === "ArrowLeft") { e.preventDefault(); tourPrev(); }
}, true);
window.addEventListener("resize", () => { if (_tourOv) _tourRender(_tourStep()); });

// =================== v7.1.4: NASEER - the in-app assistant ===================
// A normal-LLM chat that knows every corner of Himmah, lives in a SIDE panel (slides in from the right like an
// old Messenger window, background stays fully usable - no blocking scrim), opens with Ctrl+I, and can ACT on the
// app: it proposes ONE action, you confirm, it runs + logs the reason (training data). Flash/Pro toggle in-panel.
const ASSISTANT_NAME = "Naseer";
const ASSISTANT_AR = "نصير";   // نصير - "helper / supporter / one who has your back"
function naseerInit() { state.naseerHistory = state.naseerHistory || []; return state; }
function naseerToggle() { const p = byId("naseerPanel"); if (p && !p.hidden && p.classList.contains("open")) naseerClose(); else naseerOpen(); }
function naseerOpen() {
  naseerInit(); const p = byId("naseerPanel"); if (!p) return;
  p.hidden = false; renderNaseer();
  requestAnimationFrame(() => p.classList.add("open"));
  _naseerAuraFlash();
  const l = byId("naseerLauncher"); if (l) l.classList.add("hide");
  setTimeout(() => { const i = byId("naseerInput"); if (i) i.focus(); }, 120);
}
function naseerClose() {
  const p = byId("naseerPanel"); if (!p) return;
  p.classList.remove("open");
  const l = byId("naseerLauncher"); if (l) l.classList.remove("hide");
  setTimeout(() => { if (!p.classList.contains("open")) p.hidden = true; }, 300);
}
function _naseerAuraFlash() {
  const a = byId("naseerAura"); if (!a) return;
  a.hidden = false; a.classList.remove("flash"); void a.offsetWidth; a.classList.add("flash");
  setTimeout(() => { a.hidden = true; }, 900);
}
function naseerNavigate(to) {
  closeAllPanels();
  const m = { calendar: openCalendar, inbox: openInbox, ideas: openIdeas, habits: openHabits, rhythms: openRhythms, waiting: openWaiting, tidy: openTidy, archive: openArchive, history: openHistory, board: function () {} };
  (m[to] || function () {})();
  naseerClose();
}
function _naseerFindTask(match) {
  const q = String(match || "").toLowerCase().split(/\s+/).filter(Boolean); if (!q.length) return null;
  const pool = state.items.filter((i) => i.type !== "rhythm" && i.status !== "done");
  let best = null, bs = 0;
  pool.forEach((it) => { const t = (it.title || "").toLowerCase(); let s = 0; q.forEach((w) => { if (t.includes(w)) s++; }); if (s > bs) { bs = s; best = it; } });
  return bs > 0 ? best : null;
}
const NASEER_ACTIONS = {
  navigate: { label: (a) => "Open " + (a.to || "the app"), run: (a) => { naseerNavigate(a.to); return "Opened " + (a.to || "it") + "."; } },
  add_task: { label: (a) => 'Add task: "' + (a.title || "") + '"', run: (a) => { if (!a.title) return "no title given"; let t = a.title; if (a.importance != null) t += " /urg" + Math.max(0, Math.min(3, +a.importance)); if (a.due) t += " by " + a.due; addCapture(t); return 'Captured "' + a.title + '".'; } },
  complete_task: { label: (a) => 'Complete the task matching "' + (a.match || "") + '"', run: (a) => { const it = _naseerFindTask(a.match); if (!it) return "couldn't find that task"; if (it.status !== "done") toggleDone(it.id); return 'Marked "' + it.title + '" done.'; } },
  recategorize_task: { label: (a) => 'Move "' + (a.match || "") + '" to ' + (a.category || "?"), run: (a) => { const it = _naseerFindTask(a.match); if (!it) return "couldn't find that task"; const c = (state.categories || []).find((c) => (c.name || "").toLowerCase() === String(a.category || "").toLowerCase()); if (!c) return "no category called " + a.category; it.categoryId = c.id; if (it.status === "inbox") it.status = "active"; touch(it); scheduleSave(); render(); return 'Moved "' + it.title + '" to ' + c.name + "."; } },
  set_importance: { label: (a) => "Set importance of \"" + (a.match || "") + "\"", run: (a) => { const it = _naseerFindTask(a.match); if (!it) return "couldn't find that task"; it.importance = Math.max(0, Math.min(3, +a.importance || 1)); touch(it); scheduleSave(); render(); return 'Set "' + it.title + '" to ' + IMP[it.importance].label + "."; } },
  add_idea: { label: (a) => 'Park idea: "' + (a.text || "") + '"', run: (a) => { if (!a.text) return "nothing to park"; addIdea(a.text); return "Parked it in your Idea Parking Lot."; } },
  calendarize_tomorrow: { label: () => "Calendarize tomorrow", run: () => { naseerClose(); closeAllPanels(); openCalendar(); if (typeof calSetView === "function") calSetView("week"); calendarizeNextDay(); return "Laying tomorrow out..."; } },
  // v6.9.4: calendarize_week / start_mission actions removed - those are v7-only features; proposing them here showed a cryptic "not defined" toast
};
function _naseerContext() {
  const now = new Date();
  const active = state.items.filter((i) => i.status === "active" && i.type !== "rhythm");
  const inbox = state.items.filter((i) => i.status === "inbox");
  const cats = (state.categories || []).map((c) => c.name).slice(0, 12);
  const view = byId("calendarview") && !byId("calendarview").hidden ? "calendar" : (!byId("ideasFull").hidden ? "ideas" : (!byId("inboxFull").hidden ? "inbox" : "board"));
  const top = active.slice().sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 12)
    .map((i) => "  - " + i.title + " [imp " + i.importance + (i.estimateMins ? ", ~" + i.estimateMins + "m" : "") + (i.urgency && i.urgency.due ? ", due " + i.urgency.due : "") + "]").join("\n");
  return "Today is " + _isod(now) + " (" + CAL_FULLDOW[now.getDay()] + "). Current view: " + view + ".\n"
    + "Counts: " + active.length + " active, " + inbox.length + " in inbox, " + (state.ideas ? state.ideas.length : 0) + " ideas"
    + (state.weekPlan ? ", a week plan exists" : "") + (state.mission && state.mission.status === "active" ? ", a mission is running" : "") + ".\n"
    + "Categories: " + (cats.join(", ") || "(none)") + ".\n"
    + "Top active tasks:\n" + (top || "  (none)");
}
function naseerBubble(m, i) {
  if (m.role === "user") return `<div class="nmsg nuser"><div class="nbub">${esc(m.text)}</div></div>`;
  if (m.pending) return `<div class="nmsg nbot"><span class="naseer-mark xs"></span><div class="nbub ntyping"><span></span><span></span><span></span></div></div>`;
  if (m.logStep) {   // v7.3: "log my day" walkthrough - one habit/task at a time
    const q = m.logStep, verb = q.kind === "habit" ? "keep up" : "finish";
    const head = "(" + (q.i + 1) + "/" + q.total + ") Did you " + verb + " ";
    if (q.answered) return `<div class="nmsg nbot"><span class="naseer-mark xs"></span><div class="nbub nlog-ans">${esc(head)}<b>${esc(q.title)}</b>? · ${q.answered === "yes" ? "✓ logged" : (q.answered === "no" ? "- not today" : "skipped")}</div></div>`;
    return `<div class="nmsg nbot"><span class="naseer-mark xs"></span><div class="nbub nlog"><div class="nlog-q">${esc(head)}<b>${esc(q.title)}</b>?${q.already ? ` <span class="nlog-already">(already ticked today)</span>` : ""}</div><div class="nlog-btns"><button class="glow-btn sm" data-act="naseer-log-ans" data-i="${i}" data-v="yes">Yes ✓</button><button class="ghost-btn sm" data-act="naseer-log-ans" data-i="${i}" data-v="no">No</button><button class="ghost-btn sm" data-act="naseer-log-ans" data-i="${i}" data-v="skip">Skip</button></div></div></div>`;
  }
  let card = "";
  if (m.action && m.actionState === "pending") {
    const def = NASEER_ACTIONS[m.action.type];
    card = `<div class="naseer-act"><div class="naseer-act-what">▸ ${esc(def ? def.label(m.action.args || {}) : m.action.type)}</div>${m.action.reason ? `<div class="naseer-act-why">${esc(m.action.reason)}</div>` : ""}<div class="naseer-act-btns"><button class="glow-btn sm" data-act="naseer-do" data-i="${i}">Do it</button><button class="ghost-btn sm" data-act="naseer-skip" data-i="${i}">Not now</button></div></div>`;
  } else if (m.action && m.actionState === "done") { card = `<div class="naseer-act done">✓ ${esc(m.actionResult || "done")}</div>`; }
  else if (m.action && m.actionState === "skipped") { card = `<div class="naseer-act skipped">left it</div>`; }
  return `<div class="nmsg nbot"><span class="naseer-mark xs"></span><div class="nbub">${esc(m.text)}${card}</div></div>`;
}
function naseerWelcome() {
  return `<div class="nmsg nbot"><span class="naseer-mark xs"></span><div class="nbub">Assalamu alaikum. I'm <b>${ASSISTANT_NAME}</b> - I live inside Himmah and know every corner of it. Ask me to find something, explain a feature, plan your day, or just tell me what to do and I'll handle it (you confirm first).<div class="naseer-hint">tip: <b>Ctrl+I</b> opens me anywhere · tap <b>🎙</b> (or <b>Ctrl+Shift+V</b>) to talk out loud.</div></div></div>`;
}
function renderNaseer() {
  const p = byId("naseerPanel"); if (!p || p.hidden) return;
  naseerInit();
  const pro = !!(state.meta && state.meta.naseerPro);
  const msgs = state.naseerHistory.length ? state.naseerHistory.map((m, i) => naseerBubble(m, i)).join("") : naseerWelcome();
  // v7.4 FIX: a re-render fired by the VOICE path (mic silence timer / reply landing) used to wipe whatever was
  // half-typed in the composer - capture the draft + focus and restore them after the rebuild
  const prevIn = byId("naseerInput");
  const draft = prevIn ? prevIn.value : "";
  const hadFocus = prevIn && document.activeElement === prevIn;
  const selStart = prevIn ? prevIn.selectionStart : 0, selEnd = prevIn ? prevIn.selectionEnd : 0;
  p.innerHTML = `
    <div class="naseer-head">
      <div class="naseer-id"><span class="naseer-mark"></span><div class="naseer-idtext"><div class="naseer-name">${ASSISTANT_NAME} <span class="naseer-ar">${ASSISTANT_AR}</span></div><div class="naseer-sub">your in-app guide</div></div></div>
      <div class="naseer-head-btns">
        <button class="naseer-voice ${voiceState.on ? "on" : ""}" data-act="voice-toggle" title="Talk to ${ASSISTANT_NAME} out loud (Ctrl+Shift+V)">🎙</button>
        <button class="naseer-chats" data-act="naseer-chats" title="saved & temporary chats">☰</button>
        <button class="naseer-mode ${pro ? "pro" : ""}" data-act="naseer-mode" title="${pro ? "Pro - deeper reasoning, slower" : "Flash - fast, light"} · tap to switch">${pro ? "✦ Pro" : "⚡ Flash"}</button>
        <button class="ghost-btn naseer-x" data-act="naseer-close" title="close (Ctrl+I)">✕</button>
      </div>
    </div>
    <div class="naseer-msgs" id="naseerMsgs">${msgs}
      <div class="nmsg nbot naseer-live" id="naseerLive" hidden><span class="naseer-mark xs" aria-hidden="true"></span><div class="nbub nbub-live" id="naseerLiveText"></div></div>
    </div>
    <div class="naseer-quick">
      <button class="nq-chip" data-act="naseer-brief" title="a quick brief of your day">✦ Brief me</button>
      <button class="nq-chip" data-act="naseer-log" title="walk your habits, rhythms &amp; today's tasks one by one and log them">🗒 Log my day</button>
      <button class="nq-chip" data-act="naseer-quick" data-q="What should I focus on right now?">What now?</button>
      <button class="nq-chip" data-act="naseer-quick" data-q="Plan my whole week for me.">Plan my week</button>
    </div>
    <div class="naseer-input-row">
      <textarea id="naseerInput" class="naseer-input" rows="1" placeholder="Ask ${ASSISTANT_NAME}, or tell me what to do..."></textarea>
      <button class="naseer-send" data-act="naseer-send" title="send (Enter)">➤</button>
    </div>`;
  const ml = byId("naseerMsgs"); if (ml) ml.scrollTop = ml.scrollHeight;
  if (draft) { const ni = byId("naseerInput"); if (ni) { ni.value = draft; if (hadFocus) { try { ni.focus(); ni.setSelectionRange(selStart, selEnd); } catch (e) {} } } }
}
async function naseerSend() {
  const inp = byId("naseerInput"); if (!inp) return; const text = inp.value.trim(); if (!text) return;
  naseerInit(); state.naseerHistory.push({ role: "user", text }); inp.value = ""; renderNaseer(); scheduleSave();
  if (!aiStatus.enabled) { state.naseerHistory.push({ role: "assistant", text: aiStatus.hasKey ? "AI is paused - the daily budget is used up. I'll be back at midnight." : "I need the AI switched on to talk - see Setup Guides." }); renderNaseer(); scheduleSave(); return; }
  state.naseerHistory.push({ role: "assistant", text: "", pending: true }); renderNaseer();
  let res, failed = false;
  try { res = await aiFetch("chat", { message: text, history: state.naseerHistory.filter((m) => !m.pending && m.role).slice(-12).map((m) => ({ role: m.role, content: m.text })), context: _naseerContext(), pro: !!(state.meta && state.meta.naseerPro) }); }
  catch (e) { failed = true; res = { reply: "⚠ " + e.message }; }
  state.naseerHistory = state.naseerHistory.filter((m) => !m.pending);
  const reply = (res && res.reply) || "(no reply)";
  const action = (!failed && res && res.action && res.action.type && NASEER_ACTIONS[res.action.type]) ? res.action : null;
  state.naseerHistory.push({ role: "assistant", text: reply, action, actionState: action ? "pending" : null, callId: failed ? null : lastCallId() });
  if (state.naseerHistory.length > 80) state.naseerHistory = state.naseerHistory.slice(-80);
  scheduleSave(); renderNaseer();
}
function naseerDoAction(i) {
  const m = state.naseerHistory[i]; if (!m || !m.action || m.actionState !== "pending") return;
  const def = NASEER_ACTIONS[m.action.type]; let result = "done";
  try { result = (def && def.run(m.action.args || {})) || "done"; } catch (e) { result = "⚠ " + e.message; }
  m.actionState = "done"; m.actionResult = result;
  logOutcome({ kind: "chat_action", decision: "accept", call_id: m.callId, ai_proposed: m.action, my_final: { result }, my_reason: m.action.reason || null, original_input: m.action.type });
  scheduleSave(); renderNaseer();
}
function naseerSkipAction(i) {
  const m = state.naseerHistory[i]; if (!m || !m.action) return; m.actionState = "skipped";
  logOutcome({ kind: "chat_action", decision: "reject", call_id: m.callId, ai_proposed: m.action, my_final: null, my_reason: null, original_input: m.action.type });
  scheduleSave(); renderNaseer();
}
function naseerToggleMode() {
  state.meta = state.meta || {}; state.meta.naseerPro = !state.meta.naseerPro; scheduleSave(); renderNaseer();
  toast(state.meta.naseerPro ? "✦ Naseer: Pro (deeper reasoning)" : "⚡ Naseer: Flash (fast)");
}
// ---- v7.3: "Log my day" - Naseer walks habits + today's tasks one by one and logs each ----
let _naseerLog = null;   // transient: { q:[...], yes:0 }
function naseerStartLog() {
  naseerOpen(); naseerInit();
  const today = _todayStr();
  const habits = state.items.filter((i) => i.type === "rhythm" && !i.queued);
  const tasks = state.items.filter((i) => i.status === "active" && i.type !== "rhythm").sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 12);
  const q = [
    ...habits.map((h) => ({ id: h.id, title: h.title, kind: "habit", already: (h.history || []).includes(today) })),
    ...tasks.map((t) => ({ id: t.id, title: t.title, kind: "task", already: false })),
  ];
  if (!q.length) { state.naseerHistory.push({ role: "assistant", text: "Nothing to log yet - add a habit or a task first, then tap 🗒 Log my day." }); renderNaseer(); scheduleSave(); return; }
  _naseerLog = { q, yes: 0 };
  const nh = habits.length, nt = tasks.length;
  state.naseerHistory.push({ role: "assistant", text: "Let's log your day. I'll walk your " + nh + " habit" + (nh === 1 ? "" : "s") + " and top " + nt + " task" + (nt === 1 ? "" : "s") + " one by one - just tell me yes or no." });
  _naseerLogNext(0);
}
function _naseerLogNext(idx) {
  if (!_naseerLog || idx >= _naseerLog.q.length) return _naseerLogFinish();
  const s = _naseerLog.q[idx];
  state.naseerHistory.push({ role: "assistant", logStep: { i: idx, id: s.id, kind: s.kind, total: _naseerLog.q.length, title: s.title, already: !!s.already } });
  renderNaseer(); scheduleSave();
}
function _naseerLogRehydrate() {   // v7.4 FIX: after a reload, the queue driver is null but the question bubbles (with live buttons) persisted - rebuild it from history so answering resumes the walkthrough instead of posting a false "0 of 0" summary
  if (_naseerLog) return;
  const asked = (state.naseerHistory || []).filter((m) => m.logStep).map((m) => m.logStep);
  if (!asked.length) return;
  const total = asked[asked.length - 1].total;
  const run = asked.filter((s) => s.total === total);                  // the most recent walkthrough's asked steps (bubble objects - shared refs)
  if (!run.length || run.every((s) => s.answered)) return;             // nothing live to resume
  const today = _todayStr(), seen = new Set(run.map((s) => s.id));
  const habits = state.items.filter((i) => i.type === "rhythm" && !i.queued);
  const tasks = state.items.filter((i) => i.status === "active" && i.type !== "rhythm").sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 12);
  const tail = [
    ...habits.map((h) => ({ id: h.id, title: h.title, kind: "habit", already: (h.history || []).includes(today) })),
    ...tasks.map((t) => ({ id: t.id, title: t.title, kind: "task", already: false })),
  ].filter((f) => !seen.has(f.id));                                    // the never-asked remainder, re-derived
  _naseerLog = { q: run.concat(tail.map((f, k) => ({ ...f, i: run.length + k, total }))), yes: run.filter((s) => s.answered === "yes").length };
}
function naseerLogAnswer(histIdx, val) {
  _naseerLogRehydrate();
  const m = state.naseerHistory[histIdx]; if (!m || !m.logStep || m.logStep.answered) return;
  const q = m.logStep; q.answered = val;
  if (val === "yes") {
    const it = item(q.id);
    if (q.kind === "habit") { if (it && !(it.history || []).includes(_todayStr())) markRhythmToday(q.id); }
    else { if (it && it.status !== "done") toggleDone(q.id); }
    if (_naseerLog) _naseerLog.yes++;
  }
  logOutcome({ kind: "day_log", decision: val, call_id: null, ai_proposed: { item: q.title, kind: q.kind }, my_final: { done: val === "yes" }, my_reason: null });
  renderNaseer(); scheduleSave();
  _naseerLogNext(q.i + 1);
}
function _naseerLogFinish() {
  const L = _naseerLog; _naseerLog = null;
  const total = L ? L.q.length : 0, yes = L ? L.yes : 0;
  const tail = total && yes === total ? "Every one - baarak Allahu feek." : (yes * 2 >= total ? "Solid day. Streaks are updated." : "Logged honestly - tomorrow's a fresh run.");
  state.naseerHistory.push({ role: "assistant", text: "Logged - " + yes + " of " + total + " done today. " + tail });
  renderNaseer(); scheduleSave();
}
// ---- v7.3: saved & temporary chats (default = temporary) ----
function naseerChatsMenu() {
  naseerInit(); state.savedChats = state.savedChats || [];
  const p = byId("popup"); if (!p) return;
  const list = state.savedChats.length
    ? state.savedChats.slice().reverse().map((c) => `<div class="ncmenu-item"><button class="ncmenu-load" data-act="naseer-loadchat" data-id="${c.id}"><span class="ncmenu-t">${esc(c.title || "chat")}</span><span class="ncmenu-n">${(c.history || []).length} msgs</span></button><button class="ncmenu-x" data-act="naseer-delchat" data-id="${c.id}" title="delete">✕</button></div>`).join("")
    : `<div class="ncmenu-empty">No saved chats yet. This chat is temporary until you save it.</div>`;
  p.innerHTML = `<div class="popup-card ncmenu"><div class="drawer-head"><span class="drawer-kicker" style="color:#b79cff">${ASSISTANT_NAME} · chats <span class="ncmenu-mode">temporary by default</span></span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="ncmenu-actions"><button class="glow-btn sm" data-act="naseer-newchat">＋ New (clears)</button><button class="ghost-btn sm" data-act="naseer-savechat">💾 Save this chat</button></div>
    <div class="ncmenu-list">${list}</div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}
function naseerNewChat() {   // v7.4: themed in-design confirm (no native confirm() dialogs anywhere)
  naseerInit();
  if (!state.naseerHistory.length) { closePopup(); renderNaseer(); toast("✦ new chat"); return; }
  const p = byId("popup"); if (!p) return;
  p.innerHTML = `<div class="popup-card ncmenu"><div class="drawer-head"><span class="drawer-kicker" style="color:#b79cff">＋ new chat</span><button class="ghost-btn" data-act="close-popup">✕</button></div>
    <div class="ncmenu-empty">This chat is temporary and will be cleared. Save it first if you want to keep it.</div>
    <div class="drawer-actions"><button class="glow-btn" data-act="naseer-newchat-go">Start fresh</button><button class="ghost-btn" data-act="naseer-savechat">💾 Save first</button><button class="ghost-btn" data-act="naseer-chats">Back</button></div></div>`;
  p.hidden = false; requestAnimationFrame(() => p.classList.add("open"));
}
function naseerNewChatGo() {
  state.naseerHistory = []; _naseerLog = null; scheduleSave(); closePopup(); renderNaseer();
  toast("✦ new chat");
}
function naseerSaveChat() {
  naseerInit(); state.savedChats = state.savedChats || [];
  if (!state.naseerHistory.length) { toast("nothing to save yet"); return; }
  const firstUser = state.naseerHistory.find((m) => m.role === "user");
  const title = ((firstUser && firstUser.text) || "chat").slice(0, 40);
  const flat = state.naseerHistory.map((m) => {   // v7.4 FIX: log-day Q&A + action results used to be silently DROPPED (they carry no .text) - flatten them to text so a saved chat replays whole
    let t = m.text || "";
    if (m.logStep) { const q = m.logStep; t = "(" + (q.i + 1) + "/" + q.total + ") Did you " + (q.kind === "habit" ? "keep up" : "finish") + " " + q.title + "? · " + (q.answered === "yes" ? "✓ logged" : (q.answered === "no" ? "not today" : (q.answered ? "skipped" : "(unanswered)"))); }
    if (m.action && m.actionState === "done" && m.actionResult) t = (t ? t + "\n" : "") + "✓ " + m.actionResult;
    return { role: m.role, text: t };
  }).filter((m) => m.text && !m.pending);
  state.savedChats.push({ id: uid("chat"), title, ts: _todayStr(), history: flat });
  if (state.savedChats.length > 40) state.savedChats = state.savedChats.slice(-40);
  scheduleSave(); closePopup(); toast("💾 chat saved");
}
function naseerLoadChat(id) {
  naseerInit(); const c = (state.savedChats || []).find((x) => x.id === id); if (!c) return;
  state.naseerHistory = (c.history || []).map((m) => ({ role: m.role, text: m.text }));
  _naseerLog = null; scheduleSave(); closePopup(); renderNaseer();
}
function naseerDelChat(id) {
  state.savedChats = (state.savedChats || []).filter((x) => x.id !== id); scheduleSave(); naseerChatsMenu();
}
// hotkey Ctrl+I (toggle) + Enter-to-send in the composer
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "i" || e.key === "I")) { e.preventDefault(); naseerToggle(); return; }
  if (e.target && e.target.id === "naseerInput" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); naseerSend(); }
});

// =================== v7.1.5: VOICE - talk to Naseer hands-free ===================
// FREE tier (no key): the browser Web Speech API - continuous SpeechRecognition in, a natural MALE voice out
// (speechSynthesis; Edge has the most lifelike "Online (Natural)" voices). Hotkey Ctrl+Shift+V toggles it; a
// mute button sits in a corner dock; it listens until you toggle off. Voice mode is CONVERSATION ONLY - Naseer
// never acts on the app while you're talking. An optional cheap "lifelike upgrade" (Google Gemini Live) is
// documented in Setup Guides; this tier needs nothing. "Screen awareness" here = the live app-state Naseer is fed.
const _SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let voiceState = { on: false, muted: false, listening: false, speaking: false, recog: null, voice: null, interim: "", pending: "", silenceTimer: null, speakWords: "", echoUntil: 0 };
const _VOICE_SEND_KW = /\b(send it|send that|go ahead|that'?s it|over and out|i'?m done|okay send|send now)\s*[.!?]*$/i;   // v7.3: say a keyword to send immediately
// v7.4 ECHO-GUARD: with the mic hot while Naseer speaks (for talk-over), the mic HEARS Naseer through the speakers -
// without a guard he interrupts HIMSELF and re-prompts himself with the first words of his own answer. Any recognized
// chunk whose words mostly appear in the utterance currently being spoken (or within a short tail after it ends) is
// echo -> discarded entirely. Only clearly-human speech (non-echo, 2+ words) counts as a talk-over interrupt.
function _voiceNorm(t) { return String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim(); }
function _voiceIsEcho(heard) {
  const h = _voiceNorm(heard);
  const spoken = voiceState.speakWords;
  const inWindow = voiceState.speaking || Date.now() <= voiceState.echoUntil;
  if (!h) return inWindow;                                                 // empty noise only eaten during speech/tail
  const hw = h.split(" ");
  if (inWindow && hw.length === 1 && h.length <= 3) return true;             // v6.9.4b: a lone grunt ("hm", "uh", "ok") while he talks is noise, never an interrupt
  if (!spoken) return false;
  let hits = 0;
  for (const w of hw) { if (w.length < 2 || spoken.indexOf(w) >= 0) hits++; }
  const ratio = hits / hw.length;
  if (inWindow) return ratio >= 0.6;                                       // most heard words are Naseer's own = echo
  return hw.length >= 3 && ratio >= 0.75;                                  // v6.9.4/v7.7.4: recognition can FINALIZE his own sentence many seconds LATE (the owner saw his reply pop into the transcript while closing the panel) - a strong match vs the LAST utterance is echo no matter when it arrives
}
const MALE_VOICE_PREFS = [/Guy Online \(Natural\)/i, /Christopher Online \(Natural\)/i, /Andrew Online \(Natural\)/i, /Brian Online \(Natural\)/i, /Ryan Online \(Natural\)/i, /\(Natural\).*Male/i, /Google US English/i, /David|Mark|Guy/i];
function pickMaleVoice() {
  const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
  for (const rx of MALE_VOICE_PREFS) { const v = vs.find((x) => rx.test(x.name) && /^en/i.test(x.lang)); if (v) return v; }
  return vs.find((x) => /^en/i.test(x.lang)) || vs[0] || null;
}
if (window.speechSynthesis) { try { speechSynthesis.onvoiceschanged = () => { voiceState.voice = pickMaleVoice(); }; } catch (e) {} }
function voiceSupported() { return !!_SR && !!window.speechSynthesis; }
function voiceToggle() {
  if (!voiceSupported()) { toast("Voice needs Chrome or Edge (Edge has the most natural male voices)"); return; }
  if (voiceState.on) voiceStop(); else voiceStart();
}
function voiceStart() {
  if (!voiceSupported()) { toast("Voice needs Chrome or Edge"); return; }
  if (!byId("naseerPanel") || byId("naseerPanel").hidden) naseerOpen();   // voice IS Naseer, talking
  voiceState.voice = voiceState.voice || pickMaleVoice();
  let r;
  try { r = new _SR(); } catch (e) { toast("couldn't start the microphone"); return; }
  voiceState.recog = r; r.continuous = true; r.interimResults = true; r.lang = "en-US";
  r.onresult = (e) => {
    let interim = "", final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) final += t + " "; else interim += t; }
    // v7.4 ECHO-GUARD: drop anything that is Naseer hearing HIMSELF (during speech + a short tail after) -
    // it must never interrupt him, never enter the transcript, never be sent back to him as a prompt.
    const finEcho = _voiceIsEcho(final), intEcho = _voiceIsEcho(interim);
    if (finEcho) final = "";
    if (intEcho) interim = "";
    const humanWords = _voiceNorm(final + " " + interim).split(" ").filter(Boolean);
    if (voiceState.speaking && humanWords.length >= 2) {   // v7.3/7.4: a real human talk-over -> Naseer stops and listens
      try { speechSynthesis.cancel(); } catch (er) {}
      voiceState.speaking = false; voiceState.echoUntil = Date.now() + 700; _naseerSpeakingAura(false); renderVoiceDock();
    }
    if (!final && !interim.trim()) { if (finEcho || intEcho) return; }     // pure echo chunk - nothing else to do
    if (final.trim()) voiceState.pending = (voiceState.pending + " " + final).replace(/\s+/g, " ").trim();
    voiceState.interim = interim.trim();
    _voiceLiveText();   // v7.3: live GREY transcript INSIDE the chat (turns white when sent), not the corner
    const combined = (voiceState.pending + " " + voiceState.interim).trim();
    if (!combined) return;
    if (_VOICE_SEND_KW.test(combined)) {   // keyword -> send now
      const msg = combined.replace(_VOICE_SEND_KW, "").trim();
      clearTimeout(voiceState.silenceTimer); voiceState.pending = ""; voiceState.interim = ""; _voiceLiveText();
      if (msg) voiceHandleUtterance(msg); return;
    }
    clearTimeout(voiceState.silenceTimer);   // v7.3: send after a pause (longer in detailed-thinking mode, so stutters don't cut off)
    voiceState.silenceTimer = setTimeout(() => {
      const m = voiceState.pending.trim(); voiceState.pending = ""; voiceState.interim = ""; _voiceLiveText();
      if (m) voiceHandleUtterance(m);
    }, (state.meta && state.meta.naseerDetailed) ? 4200 : 1500);
  };
  r.onend = () => { if (voiceState.on && voiceState.listening) { try { r.start(); } catch (e) {} } };  // keep listening (auto-restart)
  r.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { toast("Mic blocked - allow the microphone to talk to Naseer"); voiceStop(); } };
  voiceState.on = true; voiceState.muted = false; voiceState.listening = true; voiceState.pending = ""; voiceState.interim = "";
  try { r.start(); } catch (e) {}
  renderVoiceDock();
  voiceSpeak("Voice on. Just talk - I'll wait for your pause, or say 'send it'.");
}
function voiceDetailedToggle() {   // v7.3: detailed thinking -> waits longer so it never cuts you off mid-sentence
  state.meta = state.meta || {}; state.meta.naseerDetailed = !state.meta.naseerDetailed; scheduleSave(); renderVoiceDock();
  toast(state.meta.naseerDetailed ? "🧠 detailed thinking on - take your time, I'll wait for you to finish" : "⚡ quick mode - fast replies (default)");
}
function _naseerSpeakingAura(on) { const p = byId("naseerPanel"); if (p) p.classList.toggle("naseer-speaking", !!on); const l = byId("voiceDock"); if (l) l.classList.toggle("dock-speaking", !!on); }
function _voiceLiveText() {   // v7.3: render the in-progress voice transcript as a grey pending bubble in the chat
  const l = byId("naseerLive"), t = byId("naseerLiveText"); if (!l || !t) return;
  const txt = (voiceState.pending + " " + (voiceState.interim || "")).replace(/\s+/g, " ").trim();
  if (voiceState.on && txt) { t.textContent = txt; l.hidden = false; const ml = byId("naseerMsgs"); if (ml) ml.scrollTop = ml.scrollHeight; }
  else l.hidden = true;
}
function voiceStop() {
  const wasOn = voiceState.on;
  voiceState.on = false; voiceState.listening = false; voiceState.interim = ""; voiceState.pending = "";
  voiceState.speakWords = ""; voiceState.echoUntil = 0;
  clearTimeout(voiceState.silenceTimer);
  if (voiceState.recog) { try { voiceState.recog.onend = null; voiceState.recog.stop(); } catch (e) {} voiceState.recog = null; }
  if (window.speechSynthesis) { try { speechSynthesis.cancel(); } catch (e) {} }
  voiceState.speaking = false; _naseerSpeakingAura(false); _voiceLiveText(); renderVoiceDock();
  if (wasOn && byId("naseerPanel")) renderNaseer();
}
function voiceMuteToggle() {
  if (!voiceState.on) return;
  voiceState.muted = !voiceState.muted;
  if (voiceState.muted) { voiceState.listening = false; if (voiceState.recog) { try { voiceState.recog.stop(); } catch (e) {} } }
  else { voiceState.listening = true; if (voiceState.recog) { try { voiceState.recog.start(); } catch (e) {} } }
  renderVoiceDock();
}
async function voiceHandleUtterance(text) {
  naseerInit(); state.naseerHistory.push({ role: "user", text }); _voiceLiveText(); renderNaseer(); scheduleSave();
  renderVoiceDock();   // v7.3: keep the mic ON while thinking/speaking so you can talk over Naseer
  if (!aiStatus.enabled) { voiceSpeak("I need the A.I. switched on to talk."); return; }
  let res;
  try { res = await aiFetch("chat", { message: text, history: state.naseerHistory.filter((m) => !m.pending && m.role).slice(-12).map((m) => ({ role: m.role, content: m.text })), context: _naseerContext(), pro: !!(state.meta && state.meta.naseerPro), voice: true }); }
  catch (e) { voiceSpeak("Sorry, something went wrong."); return; }
  const reply = (res && res.reply) || "Sorry, I didn't catch that.";
  state.naseerHistory.push({ role: "assistant", text: reply, action: null });   // VOICE = conversation only, never acts
  scheduleSave(); renderNaseer();
  voiceSpeak(reply);
}
function voiceSpeak(text) {
  if (!window.speechSynthesis) return;
  try { speechSynthesis.cancel(); } catch (e) {}
  const u = new SpeechSynthesisUtterance(String(text || ""));
  const v = voiceState.voice || pickMaleVoice(); if (v) u.voice = v;
  u.rate = 1.02; u.pitch = 0.98;
  voiceState.speakWords = _voiceNorm(text);                                    // v7.4: the echo-guard reference - what he is saying right now
  voiceState.pending = ""; voiceState.interim = ""; _voiceLiveText();          // v7.4: no stale scraps can ride along into the next send
  voiceState.speaking = true; _naseerSpeakingAura(true); renderVoiceDock();    // v7.3: moving aura while he talks
  const done = () => { voiceState.speaking = false; voiceState.echoUntil = Date.now() + 700; _naseerSpeakingAura(false); _voiceResume(); };  // v7.4: swallow the recognition tail of his own voice
  u.onend = done;
  u.onerror = done;
  try { speechSynthesis.speak(u); } catch (e) { done(); }
}
function _voiceResume() {   // v7.3: mic stays on through speech; this just refreshes the dock + ensures recog is running
  if (voiceState.on && !voiceState.muted) { voiceState.listening = true; if (voiceState.recog) { try { voiceState.recog.start(); } catch (e) {} } }
  renderVoiceDock();
}
function renderVoiceDock() {
  const d = byId("voiceDock"); if (!d) return;
  if (!voiceState.on) { d.hidden = true; d.innerHTML = ""; return; }
  d.hidden = false;
  const status = voiceState.speaking ? "speaking" : (voiceState.muted ? "muted" : "listening");
  const detailed = !!(state.meta && state.meta.naseerDetailed);
  d.className = "voice-dock " + status + (voiceState.speaking ? " dock-speaking" : "");
  d.innerHTML = `
    <button class="vd-mic ${status}" data-act="voice-mute" title="${voiceState.muted ? "unmute - resume listening" : "mute - stop listening"}">
      <span class="vd-ico">${voiceState.muted ? "🔇" : (voiceState.speaking ? "🔊" : "🎙")}</span><span class="vd-rings" aria-hidden="true"></span></button>
    <div class="vd-body">
      <div class="vd-status">${ASSISTANT_NAME} · ${status === "speaking" ? "speaking - talk to interrupt" : (status === "muted" ? "muted" : "listening")}</div>
      <div class="vd-transcript">${esc(voiceState.muted ? "tap the mic to resume" : "just talk - pause or say “send it”")}</div>
    </div>
    <button class="vd-detailed ${detailed ? "on" : ""}" data-act="voice-detailed" title="${detailed ? "detailed thinking ON - I wait longer so I never cut you off" : "quick mode - tap for detailed thinking (wait longer)"}">🧠</button>
    <button class="vd-end" data-act="voice-stop" title="end voice (Ctrl+Shift+V)">✕</button>`;
}
// hotkey Ctrl+Shift+V toggles voice
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "v" || e.key === "V")) { e.preventDefault(); voiceToggle(); }
});
function naseerQuick(text) { const inp = byId("naseerInput"); if (!inp) { naseerOpen(); setTimeout(() => naseerQuick(text), 160); return; } inp.value = text; naseerSend(); }   // v7.2.0 helper (needed by the naseer-brief / naseer-quick dispatch entries)

// ---------- go ----------
loadState()
  .then(() => refreshAiStatus())          // one local call; tells the chip whether AI is on (no auto-triage)
  .then(() => { updateTravelChip(); applyTravelDust(); setupVoiceCapture(); guardSyncIndex(); applyGuardianAmbient(); guardCheckResume(); maybeStartTour(); }) // restore travel chrome + voice mic + Guardian chrome/resume; v6.7.3 offer the tour on the demo
  .catch(() => { byId("app").innerHTML = `<div class="empty big">⚠ Can't reach the server.<br>Start it with <code>py app/server.py</code> and refresh.</div>`; });
