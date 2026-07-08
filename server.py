#!/usr/bin/env python3
# Himmah. Copyright (c) 2026 Enis Lucas Ziadin. All rights reserved.
"""
Himmah - local to-do dashboard server.
Pure Python 3 standard library. No dependencies, no build step.

Run:   py app/server.py            (PC only, http://127.0.0.1:7777)
       py app/server.py --lan      (also reachable from your phone on the same wifi)

Idle cost is ~0: the server blocks on the socket until a request arrives.
TO DO.txt is only ever READ (to seed first run). It is never written.
"""
import json
import os
import re
import shutil
import sys
import ipaddress  # v6.7.1: SSRF guard for the iCal fetch
import socket
import threading
import urllib.request
import urllib.error
import uuid
from datetime import datetime, date, timezone, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, urlencode, quote, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, "data")
SNAP_DIR = os.path.join(DATA_DIR, "snapshots")
STATE_FILE = os.path.join(DATA_DIR, "tasks.json")
TODO_TXT = os.path.join(os.path.dirname(ROOT), "TO DO.txt")  # parent folder; READ-ONLY
MAX_SNAPSHOTS = 100
PORT = 7777
ALLOWED_EXT = {".html", ".css", ".js", ".json", ".svg", ".png", ".ico", ".webmanifest", ".woff", ".woff2", ".map"}
# v6.6.16: file-import (PDF/txt/md/Word/csv -> extracted text -> Inbox). Offline, in-memory only.
IMPORT_EXT = {".txt", ".md", ".markdown", ".csv", ".log", ".pdf", ".docx"}
IMPORT_MAX_BYTES = 12 * 1024 * 1024   # 12 MB per file, decoded - refuse larger (keeps it snappy + offline)

# ---------------------------------------------------------------- seeding ----
DISPLAY = {
    "URGENT": "Urgent", "LENGTHY BUT URGENT": "Lengthy but Urgent", "STARTUP": "Startup",
    "DAYJOB": "Day job", "OTHERS": "Others", "SUMMER": "Summer", "GITHUB": "GitHub",
    "LONG TERM PLAN THINGS": "Long Term",
}
CAT_COLOR = {
    "URGENT": "#FB7185", "LENGTHY BUT URGENT": "#FB923C", "STARTUP": "#8B5CF6",
    "DAYJOB": "#38BDF8", "OTHERS": "#94A3B8", "SUMMER": "#FACC15",
    "GITHUB": "#A78BFA", "LONG TERM PLAN THINGS": "#34D399",
}
PALETTE = ["#8B5CF6", "#3B82F6", "#FACC15", "#22C55E", "#F472B6",
           "#38BDF8", "#A78BFA", "#FB923C", "#4ADE80", "#60A5FA"]
IMPORTANCE_BY_CAT = {
    "URGENT": 3, "LENGTHY BUT URGENT": 2, "STARTUP": 2, "DAYJOB": 1,
    "OTHERS": 1, "SUMMER": 1, "GITHUB": 2, "LONG TERM PLAN THINGS": 1,
}
COLLAPSED_CATS = {"OTHERS", "SUMMER", "GITHUB", "LONG TERM PLAN THINGS"}


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def norm_header(line):
    s = line.strip().rstrip(":").strip()
    return re.sub(r"[^A-Za-z &]", "", s).strip().upper()


def parse_todo(text):
    """Heuristically turn the WhatsApp-style TO DO.txt into categories + task items."""
    cats, items, by_norm = [], [], {}
    cur_cat_id, cur_item = None, None
    ci = ii = 0

    def base_item(title, cat_id, importance, done):
        nonlocal ii
        ii += 1
        return {
            "id": "t_%d" % ii, "type": "task", "title": title, "notes": "",
            "categoryId": cat_id, "importance": importance,
            "urgency": {"due": None, "soon": False},
            "status": "done" if done else "active",
            "nextAction": {"if": "", "then": ""},
            "estimateMins": None, "projectId": None, "subtaskIds": [], "nextActionId": None,
            "cadence": None, "everyNDays": None, "streak": 0, "lastDone": None, "history": [],
            "inFocus": False, "order": ii, "createdAt": now_iso(), "updatedAt": now_iso(),
            "completedAt": now_iso() if done else None,
        }

    for raw in text.splitlines():
        line = raw.replace("\t", "    ")
        s = line.strip()
        if not s:
            continue
        if re.match(r"^[\W_]+$", s):          # pure separators / emoji-only lines
            continue
        first = s[0]
        is_bullet = first in ("*", "✅")  # * or check-mark

        # ---- category header ----
        if not is_bullet and not s.startswith("-"):
            up = norm_header(line)
            if up.startswith("TASKS"):
                continue
            looks_caps = bool(re.sub(r"[^A-Za-z &]", "", s).strip()) and s == s.upper() and len(up) >= 3
            if up in DISPLAY or looks_caps:
                if up not in by_norm:
                    ci += 1
                    cid = "c_%d" % ci
                    name = DISPLAY.get(up) or s.rstrip(":").strip().title()
                    color = CAT_COLOR.get(up) or PALETTE[(ci - 1) % len(PALETTE)]
                    cats.append({"id": cid, "name": name, "color": color,
                                 "order": ci - 1, "collapsed": up in COLLAPSED_CATS})
                    by_norm[up] = cid
                cur_cat_id, cur_item = by_norm[up], None
                continue
            # non-header prose under an item -> note
            if cur_item is not None:
                cur_item["notes"] = (cur_item["notes"] + "\n" + s).strip()
            continue

        # ---- sub-bullet "-" -> note on current item ----
        if s.startswith("-"):
            if cur_item is not None:
                note = s.lstrip("-").strip()
                sep = "\n• " if cur_item["notes"] else "• "
                cur_item["notes"] += sep + note
            continue

        # ---- task bullet ----
        done = first == "✅"
        title = re.sub(r"^[\s@#%!*•·]+", "", s[1:].strip()).strip()
        if not title:
            continue
        if cur_cat_id is None:
            ci += 1
            cur_cat_id = "c_%d" % ci
            cats.append({"id": cur_cat_id, "name": "Inbox", "color": "#8B5CF6",
                         "order": ci - 1, "collapsed": False})
            by_norm["__INBOX__"] = cur_cat_id
        cat_norm = next((k for k, v in by_norm.items() if v == cur_cat_id), "")
        imp = IMPORTANCE_BY_CAT.get(cat_norm, 1)
        if "MASSIVE" in title.upper() or "\U0001f6a8" in title:
            imp = 3
        it = base_item(title, cur_cat_id, imp, done)
        items.append(it)
        cur_item = it

    return cats, items


def seed_from_todo():
    text = ""
    if os.path.isfile(TODO_TXT):
        with open(TODO_TXT, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    cats, items = parse_todo(text)
    if not cats:
        cats = [{"id": "c_1", "name": "Inbox", "color": "#8B5CF6", "order": 0, "collapsed": False}]
    return {"version": 1, "categories": cats, "items": items,
            "meta": {"seededFrom": "TO DO.txt", "seededAt": now_iso()}}


# ---------------------------------------------------------------- storage ----
def ensure_dirs():
    os.makedirs(SNAP_DIR, exist_ok=True)


def atomic_write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)  # atomic rename on the same filesystem


def load_state():
    ensure_dirs()
    if not os.path.isfile(STATE_FILE):
        st = seed_from_todo()
        atomic_write(STATE_FILE, st)
        return st
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (ValueError, OSError):  # v6.7.1: a corrupt/unreadable live file recovers from the newest parseable snapshot instead of 500-ing the whole board
        for fn in sorted((f for f in os.listdir(SNAP_DIR) if f.endswith(".json")), reverse=True):
            try:
                with open(os.path.join(SNAP_DIR, fn), encoding="utf-8") as f:
                    st = json.load(f)
                atomic_write(STATE_FILE, st)  # heal the live file from the snapshot
                return st
            except Exception:
                continue
        st = seed_from_todo(); atomic_write(STATE_FILE, st); return st  # last resort: fresh seed


def make_snapshot():
    if not os.path.isfile(STATE_FILE):
        return
    # v6.7.1: full microseconds + a random suffix so two saves in the same millisecond can never overwrite (lose) an undo snapshot
    ts = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    try:
        shutil.copy2(STATE_FILE, os.path.join(SNAP_DIR, "tasks-%s-%s.json" % (ts, uuid.uuid4().hex[:6])))
    except Exception:
        pass


def prune_snapshots():
    files = sorted(f for f in os.listdir(SNAP_DIR) if f.endswith(".json"))
    while len(files) > MAX_SNAPSHOTS:
        name = files.pop(0)  # v6.7.1: pop exactly once per iteration (the old except double-popped, leaving over-cap files undeleted)
        try:
            os.remove(os.path.join(SNAP_DIR, name))
        except Exception:
            pass


def save_state(state):
    ensure_dirs()
    with _state_lock:  # v6.7.1: snapshot + write + prune happen atomically w.r.t. other writers
        make_snapshot()                   # version the previous state first
        state.setdefault("meta", {})["savedAt"] = now_iso()
        atomic_write(STATE_FILE, state)
        prune_snapshots()


def parse_ts(fn):
    m = re.search(r"(\d{8})-(\d{6})", fn)  # v6.7.1: anchor on date+time only; tolerate the longer microsecond + uuid suffix
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").isoformat()
    except Exception:
        return None


def list_snapshots():
    ensure_dirs()
    out = []
    for fn in sorted((f for f in os.listdir(SNAP_DIR) if f.endswith(".json")), reverse=True):
        count = None
        try:
            with open(os.path.join(SNAP_DIR, fn), encoding="utf-8") as f:
                count = len(json.load(f).get("items", []))
        except Exception:
            pass
        out.append({"id": fn[:-5], "time": parse_ts(fn), "items": count})
    return out


def restore_snapshot(sid):
    if not sid or "/" in sid or "\\" in sid:
        return None
    fp = os.path.join(SNAP_DIR, sid + ".json")
    if not os.path.isfile(fp):
        return None
    try:
        with open(fp, encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        return None  # v6.7.1: a corrupt snapshot must not crash the request
    if not isinstance(st, dict) or not isinstance(st.get("items"), list) or not isinstance(st.get("categories"), list):
        return None  # v6.7.1: never overwrite good live state with a malformed snapshot
    with _state_lock:  # v6.7.1: serialize with other writers
        make_snapshot()                   # restoring is itself undoable (after validation, so a bad snapshot doesn't churn history)
        atomic_write(STATE_FILE, st)
        prune_snapshots()
    return st


# ---------------------------------------------------------------- AI (v5.2) --
# All AI goes through THIS server (the browser never talks to the internet):
#   - the key lives in data/deepseek_key.txt (data/ is blocked from static serving)
#   - a HARD daily budget cap (DAILY_CAP_USD) is enforced BEFORE every call
#   - key file containing exactly "MOCK" = offline mock mode (canned replies, $0)
#   - no key file = AI off; the app stays fully functional (heuristic fallback)
KEY_FILE = os.path.join(DATA_DIR, "deepseek_key.txt")
AI_USAGE_FILE = os.path.join(DATA_DIR, "ai_usage.json")
AI_ACTIONS_FILE = os.path.join(DATA_DIR, "ai_actions.jsonl")  # durable AI decision log (training data)
LIFE_CONTEXT_FILE = os.path.join(DATA_DIR, "life_context.md")  # the owner's life context (enrich source)
PRAYER_FILE = os.path.join(DATA_DIR, "prayer_times.json")      # mosque prayer times (calendar seeding, v6.1.4)
CALZ_PREFS_FILE = os.path.join(DATA_DIR, "calz_prefs.json")    # v6.6.41: the owner's calendarize-preferences quiz answers + synthesized profile
AI_MODEL = "deepseek-v4-flash"          # default tier for cheap / high-volume kinds (deepseek-chat alias dies 2026-07-24)
# v6.6.38/.41: the HARDEST reasoning kinds use DeepSeek's FLAGSHIP model - calendarize (lay out a whole day:
# importance-first, prayer-aware, parallel-aware) and calz_profile (analyze the owner's calendarize-quiz answers into
# a planning profile). ~3x the flash price but ~$0.003/call and run rarely -> well inside the 10c/day cap. v4-pro
# supports response_format json_object and silently IGNORES temperature; the answer still arrives in message.content.
CALENDARIZE_MODEL = "deepseek-v4-pro"
FLAGSHIP_KINDS = ("calendarize", "calz_profile", "life_setup", "life_round", "onboard_chat")   # these kinds use CALENDARIZE_MODEL + extra reasoning headroom + a longer timeout (onboard_chat = the v6.7.13 onboarding conversation)

# v7.1.4: NASEER - the in-app assistant (Arabic for "helper / supporter / one who has your back";
# deliberately NOT Samir or Sadiq). Knows every corner of Himmah, can answer + PROPOSE one action.
ASSISTANT_NAME = "Naseer"
HIMMAH_FEATURE_BRIEF = (
    "- Capture bar (top): type any task and press Enter; a line starting /idea routes to the Idea Parking Lot instead. "
    "- Inbox: untriaged captures wait here; Triage files them into the owner's categories. "
    "- Board / NOW focus: active tasks grouped by category, with importance 0=someday 1=normal 2=high 3=critical; a NOW focus pool holds the chosen few. "
    "- Calendar: 'Calendarize tomorrow' lays tomorrow out at the hour (prayer-aware); 'Calendarize my week' plans the whole week, looser the further out. "
    "- Idea Parking Lot (separate from tasks): random ideas grouped into TOPICS; Sort + Tidy with reasons. "
    "- Mission: a gamified focus sprint - a countdown + a roadmap of checkpoints toward a goal. "
    "- Habits (daily, load-budgeted) + Rhythms (lighter routines), both prayer-aware. "
    "- Waiting (blocked tasks), Tidy (gone-quiet tasks), Guardian (protect high-value priorities from being silently dropped), Archive (done), History (versioned undo). "
    "- Travelling mode eases prayers/habits. Ctrl+K is the search launchpad. Ctrl+I opens you, Naseer.")
CHAT_ACTIONS_BRIEF = (
    "navigate {to:'calendar'|'inbox'|'ideas'|'mission'|'habits'|'rhythms'|'waiting'|'tidy'|'archive'|'history'|'board'} - open a part of the app. "
    "add_task {title, importance?:0-3, due?:'YYYY-MM-DD'} - capture a new task. "
    "complete_task {match} - mark a task done (match = a few distinctive words from its title). "
    "recategorize_task {match, category} - move a task into a category by name. "
    "set_importance {match, importance:0-3}. "
    "add_idea {text} - park a random non-task idea. "
    "calendarize_tomorrow {} / calendarize_week {} - run the planners. "
    "start_mission {minutes?:int, goal?:string} - launch a focus mission.")
AI_URL = "https://api.deepseek.com/chat/completions"
# deepseek-v4-flash is a REASONING model: it spends hidden 'reasoning_content' tokens BEFORE the answer,
# and max_tokens caps reasoning + answer COMBINED. With a small max_tokens it burns the whole budget
# thinking and returns empty content (finish_reason 'length') -> the old "non-JSON" error. So every kind
# gets this headroom ON TOP of its answer budget. (Diagnosed live 2026-06-24: 300 tokens -> 300 reasoning, 0 answer.)
REASONING_HEADROOM = 2500               # flash-tier headroom on top of each kind's answer budget
CALENDARIZE_HEADROOM = 14000            # v6.6.38: v4-pro thinks longer; give the day-plan ample room so the CoT never starves the answer
DAILY_CAP_USD = 0.10                    # the user's hard ceiling: ten cents per day
PRICE_IN_USD = 0.14 / 1e6               # per input token (cache miss - worst case)
PRICE_OUT_USD = 0.28 / 1e6              # per output token
_ai_lock = threading.Lock()
_log_lock = threading.Lock()
_state_lock = threading.Lock()  # v6.7.1: serialize state writes (snapshot + atomic_write + prune) so concurrent PUT/restore can't interleave a lost update
MAX_BODY = 64 * 1024 * 1024     # v6.7.1: hard cap on a request body read (generous for PDF/ICS uploads) so a bogus Content-Length can't exhaust memory


def now_iso():
    """Absolute, timezone-aware ISO timestamp (UTC)."""
    return datetime.now(timezone.utc).isoformat()


def ai_log(record):
    """Append ONE JSON line to data/ai_actions.jsonl - the durable AI-decision log
    (training data for a future taste model). APPEND-ONLY: never rewritten, never capped,
    never redacted (local data). Must never break an AI call, so swallow all errors."""
    try:
        line = json.dumps(record, ensure_ascii=False)
        with _log_lock:
            with open(AI_ACTIONS_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        pass


def ai_key():
    try:
        with open(KEY_FILE, encoding="utf-8") as f:
            k = f.read().strip()
        return k or None
    except OSError:
        return None


def ai_usage():
    today = date.today().isoformat()
    try:
        with open(AI_USAGE_FILE, encoding="utf-8") as f:
            u = json.load(f)
    except Exception:
        u = {}
    if u.get("date") != today:  # new day → fresh budget
        u = {"date": today, "spentUSD": 0.0, "calls": 0, "tokensIn": 0, "tokensOut": 0}
    return u


def ai_record(tokens_in, tokens_out):
    with _ai_lock:
        u = ai_usage()
        u["spentUSD"] = round(u["spentUSD"] + tokens_in * PRICE_IN_USD + tokens_out * PRICE_OUT_USD, 6)
        u["calls"] += 1
        u["tokensIn"] += tokens_in
        u["tokensOut"] += tokens_out
        atomic_write(AI_USAGE_FILE, u)
        return u


def ai_status():
    key = ai_key()
    u = ai_usage()
    return {"hasKey": bool(key), "mock": key == "MOCK", "model": AI_MODEL,
            "enabled": bool(key) and u["spentUSD"] < DAILY_CAP_USD,
            "spentToday": u["spentUSD"], "cap": DAILY_CAP_USD, "callsToday": u["calls"]}


# enrich's context source - the ONE swappable seam. Today it reads a local file; later this single
# function can be repointed to a network of specialised agents WITHOUT touching the enrich feature.
def load_life_context():
    try:
        with open(LIFE_CONTEXT_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:  # v6.7.20 #9: also swallow a UnicodeDecodeError (ValueError, not OSError) from a hand-edited non-utf-8 file, so enrich degrades to empty-context instead of crashing
        return ""


def load_ai_actions_digest(n=24):
    """v7.1.4: a compact digest of the owner's RECENT decisions on AI suggestions (accept/edit/reject + why),
    so Naseer understands his taste and why he changes things. Reads the tail of ai_actions.jsonl."""
    try:
        with open(AI_ACTIONS_FILE, encoding="utf-8") as f:
            lines = f.readlines()[-(n * 4):]   # over-read: most lines are raw AI calls with no decision
    except Exception:
        return ""
    out = []
    for ln in lines:
        try:
            r = json.loads(ln)
        except Exception:
            continue
        dec, reason = r.get("decision"), (r.get("my_reason") or "")
        if not dec and not reason:
            continue
        kind = r.get("kind") or r.get("tag") or "?"
        out.append("- " + str(kind) + ": " + str(dec or "noted") + ((" - " + str(reason)[:120]) if reason else ""))
    return "\n".join(out[-n:])


def load_calz_prefs():
    """v6.6.41: the owner's calendarize-preferences quiz state, or a fresh shell."""
    try:
        with open(CALZ_PREFS_FILE, encoding="utf-8") as f:
            d = json.load(f)
            if isinstance(d, dict):
                return d
    except Exception:
        pass
    return {"sessions": [], "profile": "", "rules": [], "updated": None}


def load_calz_profile():
    """v6.6.41: (profile_paragraph, rules_list) the calendarize prompt should follow, or ('', []) if not set yet."""
    d = load_calz_prefs()
    return (d.get("profile") or "").strip(), (d.get("rules") or [])


# v6.7.4: turn a 'life_setup' spec (from the onboarding interview) into a valid Himmah state. Mirrors the demo assembler.
_HC_MAP = {"religion": "hc_religion", "faith": "hc_religion", "deen": "hc_religion", "finances": "hc_finances",
           "money": "hc_finances", "education": "hc_education", "study": "hc_education", "learning": "hc_education",
           "self-improvement": "hc_self", "self": "hc_self", "health": "hc_self", "social": "hc_social", "family": "hc_social"}


def _slug(s):
    return "".join(c if (c.isalnum()) else "_" for c in str(s).lower()).strip("_")[:24] or "x"


def assemble_setup(spec):
    """Build a fresh user state from a life_setup spec. Never raises on a messy spec (coerces/skips)."""
    if not isinstance(spec, dict):
        spec = {}
    today = date.today()
    NOW = today.isoformat() + "T09:00:00"

    def d_off(off):
        try:
            return (today + timedelta(days=int(off))).isoformat()
        except Exception:
            return None
    cats, cat_by_name = [], {}
    for n, c in enumerate(spec.get("task_categories") or []):
        if not isinstance(c, dict) or not c.get("name"):
            continue
        cid = "c_" + _slug(c["name"])
        cats.append({"id": cid, "name": str(c["name"])[:40], "color": c.get("color") or "#4a8fff", "order": n, "collapsed": False})
        cat_by_name[c["name"]] = cid
    if not cats:  # always have at least one bucket
        cats = [{"id": "c_tasks", "name": "Tasks", "color": "#4a8fff", "order": 0, "collapsed": False}]
        cat_by_name = {"Tasks": "c_tasks"}
    default_cat = cats[0]["id"]
    items, ordn = [], [0]

    def mk(**kw):
        base = dict(id=None, type="task", title="", notes="", categoryId=None, importance=1,
                    urgency={"due": None, "soon": False}, status="active", nextAction={"if": "", "then": ""},
                    estimateMins=None, projectId=None, subtaskIds=[], nextActionId=None, cadence=None,
                    everyNDays=None, perWeek=None, perMonth=None, streak=0, lastDone=None, history=[],
                    inFocus=False, order=ordn[0], createdAt=NOW, updatedAt=NOW, completedAt=None,
                    waitingOn=None, protected=False)
        ordn[0] += 1
        base.update(kw)
        return base
    n = [0]

    def nid(pfx="t"):
        n[0] += 1
        return "%s%d" % (pfx, n[0])
    for t in (spec.get("tasks") or []):
        if not isinstance(t, dict) or not t.get("title"):
            continue
        imp = t.get("importance"); imp = imp if isinstance(imp, int) and 0 <= imp <= 3 else 1
        due = d_off(t["due_in_days"]) if t.get("due_in_days") not in (None, "") else None
        items.append(mk(id=nid("t"), title=str(t["title"])[:200], categoryId=cat_by_name.get(t.get("category"), default_cat),
                        importance=imp, estimateMins=(t.get("eta_minutes") if isinstance(t.get("eta_minutes"), int) else None),
                        urgency={"due": due, "soon": False}, nextAction={"if": "", "then": str(t.get("next_then") or "")}))
    for pj in (spec.get("projects") or []):
        if not isinstance(pj, dict) or not pj.get("title"):
            continue
        pid = nid("p")
        items.append(mk(id=pid, type="project", title=str(pj["title"])[:200], categoryId=cat_by_name.get(pj.get("category"), default_cat), importance=2, isMacro=False))
        for st in (pj.get("subtasks") or []):
            if not isinstance(st, dict) or not st.get("title"):
                continue
            simp = st.get("importance"); simp = simp if isinstance(simp, int) and 0 <= simp <= 3 else 1
            items.append(mk(id=nid("t"), title=str(st["title"])[:200], categoryId=cat_by_name.get(pj.get("category"), default_cat),
                            importance=simp, estimateMins=(st.get("eta_minutes") if isinstance(st.get("eta_minutes"), int) else None), projectId=pid))
    for h in (spec.get("habits") or []):
        if not isinstance(h, dict) or not h.get("title"):
            continue
        cad = h.get("cadence") if h.get("cadence") in ("daily", "weekly", "monthly") else "daily"
        items.append(mk(id=nid("h"), type="rhythm", title=str(h["title"])[:200], categoryId=_HC_MAP.get(str(h.get("category", "")).lower().strip(), "hc_self"),
                        importance=2, cadence=cad, perWeek=(h.get("per_week") if isinstance(h.get("per_week"), int) else None),
                        perMonth=(h.get("per_month") if isinstance(h.get("per_month"), int) else None), history=[], lastDone=None,
                        queued=False, travel={"keep": True, "reduce": False}))
    rhythms = []
    for cat_key, lst in (("religious", spec.get("islamic_rhythms")), ("natural", spec.get("rhythms"))):
        for i, r in enumerate(lst or []):
            title = r.get("title") if isinstance(r, dict) else r
            if not title:
                continue
            rhythms.append({"id": "ry_%s_%d" % (cat_key[:3], i), "title": str(title)[:200], "cat": cat_key,
                            "cadence": "daily", "missDates": [], "createdAt": NOW, "updatedAt": NOW})
    meta = {"savedAt": NOW, "revertedAutoRhythms": True, "rhythmsAutoDetected": True, "ui": {"viewMode": "category"},
            "guardian": {"protectedIds": [], "deal": None, "ledger": []},
            "guardianIntroSeen": True, "habitsIntroSeen": True, "rhythmsIntroSeen": True, "inboxIntroSeen": True,
            "demo": False, "tourDone": True, "onboarded": True}
    return {"version": 1, "categories": cats, "items": items, "meta": meta, "rhythms": rhythms,
            "schedules": [{"id": "sch_tasks", "name": "Tasks", "color": "#f5c46f", "hidden": False},
                          {"id": "sch_prayer", "name": "Prayer", "color": "#FACC15", "hidden": False}], "events": []}


def _life_add(state, rnd, spec):
    """v6.7.6: APPEND one guided-setup round's items into the live state (never raises on a messy spec)."""
    if not isinstance(spec, dict):
        spec = {}
    today = date.today(); NOW = today.isoformat() + "T09:00:00"
    def d_off(o):
        try:
            return (today + timedelta(days=int(o))).isoformat()
        except Exception:
            return None
    cats = state.setdefault("categories", []); PAL = ["#4a8fff", "#22C55E", "#FACC15", "#F472B6", "#A855F7", "#38bdf8", "#fb923c"]
    by_name = {(c.get("name") or "").lower(): c["id"] for c in cats}
    def cat_id(name):
        if not name:
            return cats[0]["id"] if cats else cat_id("Tasks")
        k = str(name).lower().strip()
        if k in by_name:
            return by_name[k]
        cid = "c_" + _slug(name) + "_" + uuid.uuid4().hex[:4]
        cats.append({"id": cid, "name": str(name)[:40], "color": PAL[len(cats) % len(PAL)], "order": len(cats), "collapsed": False})
        by_name[k] = cid; return cid
    items = state.setdefault("items", []); ordn = [max([i.get("order", 0) for i in items], default=0) + 1]
    def mk(**kw):
        b = dict(id="t_" + uuid.uuid4().hex[:10], type="task", title="", notes="", categoryId=None, importance=1,
                 urgency={"due": None, "soon": False}, status="active", nextAction={"if": "", "then": ""}, estimateMins=None,
                 projectId=None, subtaskIds=[], nextActionId=None, cadence=None, everyNDays=None, perWeek=None, perMonth=None,
                 streak=0, lastDone=None, history=[], inFocus=False, order=ordn[0], createdAt=NOW, updatedAt=NOW,
                 completedAt=None, waitingOn=None, protected=False)
        ordn[0] += 1; b.update(kw); return b
    n = {"tasks": 0, "projects": 0, "habits": 0, "rhythms": 0, "islamic_rhythms": 0, "events": 0}
    if rnd == "tasks":
        for t in (spec.get("tasks") or []):
            if not isinstance(t, dict) or not t.get("title"):
                continue
            imp = t.get("importance"); imp = imp if isinstance(imp, int) and 0 <= imp <= 3 else 1
            due = d_off(t["due_in_days"]) if t.get("due_in_days") not in (None, "") else None
            items.append(mk(title=str(t["title"])[:200], categoryId=cat_id(t.get("category")), importance=imp,
                            estimateMins=(t.get("eta_minutes") if isinstance(t.get("eta_minutes"), int) else None),
                            urgency={"due": due, "soon": False}, nextAction={"if": "", "then": str(t.get("next_then") or "")})); n["tasks"] += 1
        for pj in (spec.get("projects") or []):
            if not isinstance(pj, dict) or not pj.get("title"):
                continue
            pid = "p_" + uuid.uuid4().hex[:10]; cc = cat_id(pj.get("category"))
            items.append(mk(id=pid, type="project", title=str(pj["title"])[:200], categoryId=cc, importance=2, isMacro=False)); n["projects"] += 1
            for st in (pj.get("subtasks") or []):
                if not isinstance(st, dict) or not st.get("title"):
                    continue
                si = st.get("importance"); si = si if isinstance(si, int) and 0 <= si <= 3 else 1
                items.append(mk(title=str(st["title"])[:200], categoryId=cc, importance=si, projectId=pid,
                                estimateMins=(st.get("eta_minutes") if isinstance(st.get("eta_minutes"), int) else None)))
    elif rnd == "habits":
        for h in (spec.get("habits") or []):
            if not isinstance(h, dict) or not h.get("title"):
                continue
            cad = h.get("cadence") if h.get("cadence") in ("daily", "weekly", "monthly") else "daily"
            items.append(mk(id="h_" + uuid.uuid4().hex[:10], type="rhythm", title=str(h["title"])[:200],
                            categoryId=_HC_MAP.get(str(h.get("category", "")).lower().strip(), "hc_self"), importance=2, cadence=cad,
                            perWeek=(h.get("per_week") if isinstance(h.get("per_week"), int) else None),
                            history=[], lastDone=None, queued=False, travel={"keep": True, "reduce": False})); n["habits"] += 1
    elif rnd == "rhythms":
        rh = state.setdefault("rhythms", [])
        for ck, lst in (("religious", spec.get("islamic_rhythms")), ("natural", spec.get("rhythms"))):
            for r in (lst or []):
                title = r.get("title") if isinstance(r, dict) else r
                if not title:
                    continue
                rh.append({"id": "ry_" + uuid.uuid4().hex[:8], "title": str(title)[:200], "cat": ck, "cadence": "daily",
                           "missDates": [], "createdAt": NOW, "updatedAt": NOW}); n["islamic_rhythms" if ck == "religious" else "rhythms"] += 1
    elif rnd == "events":
        schs = state.setdefault("schedules", []); sch_by = {(s.get("name") or "").lower(): s["id"] for s in schs}
        def sch_id(name):
            k = (name or "tasks").lower()
            if k in sch_by:
                return sch_by[k]
            sid = "sch_" + _slug(name or "tasks") + "_" + uuid.uuid4().hex[:4]
            schs.append({"id": sid, "name": str(name or "Tasks")[:40], "color": ("#FACC15" if k == "prayer" else "#4a8fff"), "hidden": False})
            sch_by[k] = sid; return sid
        ev = state.setdefault("events", []); HOR = {"daily": 14, "weekly": 42}; STEP = {"daily": 1, "weekly": 7}
        for e in (spec.get("events") or []):
            if not isinstance(e, dict) or not e.get("title"):
                continue
            recur = "daily" if (e.get("daily") or e.get("recur") == "daily") else "weekly"
            sid = sch_id(e.get("schedule")); start = e.get("start") or "18:00"; end = e.get("end") or start
            if recur == "daily":
                anchor = today
            else:
                wd = e.get("weekday"); wd = wd if isinstance(wd, int) and 0 <= wd <= 6 else 1
                anchor = today
                for k in range(0, 7):
                    cand = today + timedelta(days=k)
                    if cand.isoweekday() % 7 == wd:
                        anchor = cand; break
            series = "ser_" + uuid.uuid4().hex[:8]; off = 0; made = 0
            while off <= HOR[recur] and made < 60:
                dt = anchor + timedelta(days=off)
                ev.append({"id": "ev_" + uuid.uuid4().hex[:8], "scheduleId": sid, "title": str(e["title"])[:120],
                           "date": dt.isoformat(), "start": start, "end": end, "allDay": False, "notes": "",
                           "seriesId": series, "rrule": {"freq": recur, "anchor": anchor.isoformat()}}); made += 1; off += STEP[recur]
            n["events"] += 1
    return n


# Every prompt states the guardrail it needs and demands strict JSON.
# v5.4.1: enhance now SHARPENS a raw capture into a crystal-clear task title - it may SHORTEN by
# stripping slang/filler, but must never ADD information or change the subject (that is enrich's job).
ENHANCE_RULES = (
    "You turn ANY raw, messily-typed to-do thought into a CRYSTAL-CLEAR task title - generalise to every "
    "kind of input, not only the examples below. "
    "DO: fix spelling, grammar, punctuation and capitalisation; expand ANY shorthand/abbreviation to its "
    "full word; and STRIP ANY informal slang, filler, or chat-noise that is not part of the task, plus "
    "lead-ins like 'remind me to' / 'i need to' / 'gotta'. You MAY SHORTEN the text by removing that noise. "
    "ABSOLUTE RULES: never ADD information, never change the SUBJECT of the task, never invent or infer "
    "context (adding context is a separate 'enrich' step). If it is too vague to clean confidently, return "
    "it UNCHANGED. Never translate; keep the user's language(s) including Arabic/religious terms. "
    "The following are ILLUSTRATIVE examples of the transformation, NOT an exhaustive list - apply the same "
    "judgement to any shorthand/slang you encounter: 'gtta'->'go to', 'tmrw'->'tomorrow', 'abt'->'about', "
    "'appt'->'appointment'; filler like 'fr','idk','tbh','ngl','lol','lowkey' -> removed. "
    "Worked examples: 'gtta go supermarkt fr' -> 'Go to supermarket'; "
    "'remind me abt the bike thing tmrw idk' -> 'Bike thing - tomorrow'; 'fr' alone -> ''.")


def ai_prompt(kind, p):
    """Returns (system, user, max_tokens) or None for an unknown kind."""
    if kind == "enhance":
        return (ENHANCE_RULES + ' Reply ONLY JSON: {"enhanced":"...","changed":true|false}. '
                'Set changed=false (and echo the original) when you left it unchanged.',
                json.dumps({"text": p.get("text", "")}, ensure_ascii=False), 700)
    if kind == "triage":
        return ("You file raw to-do captures into the user's OWN categories. Categories: %s. Importance: "
                "0=someday 1=normal 2=high 3=critical (importance = how much it matters, NOT how urgent). "
                "For the title use the original text cleaned per these rules: %s "
                'Reply ONLY JSON: {"results":[{"id":"...","category":"<exact name or empty string>",'
                '"importance":0-3,"title":"..."}]} - one result per input item, same ids.'
                % (json.dumps(p.get("categories", []), ensure_ascii=False), ENHANCE_RULES),
                json.dumps({"items": p.get("items", [])}, ensure_ascii=False), 1600)
    if kind == "substeps":
        return ("A task may really be a project. Propose 3-7 concrete sub-steps, each a single actionable "
                "to-do starting with a verb, in doing-order. Stay strictly within what the task says - do not "
                'invent scope the user never mentioned. Reply ONLY JSON: {"steps":["...", "..."]}.',
                json.dumps({"task": p.get("title", ""), "notes": p.get("notes", "")}, ensure_ascii=False), 600)
    if kind == "group":
        return ("Find groups of tasks that clearly belong to one outcome (a project). Only group when the "
                "connection is obvious from the titles; 2+ tasks per group; a task appears in at most one "
                'group; it is FINE to return no groups. Reply ONLY JSON: {"groups":[{"name":"...",'
                '"taskIds":["..."],"why":"one short sentence"}]}.',
                json.dumps({"tasks": p.get("tasks", [])}, ensure_ascii=False), 900)
    if kind == "idea_sort":  # v7.1.1: file the owner's RANDOM IDEAS (not tasks) into broad TOPICS, with a reason each
        return ("You sort a person's RANDOM IDEAS and stray thoughts (NOT tasks) into broad TOPICS - loose, "
                "human buckets like 'Business ideas', 'Gifts', 'Travel & packing', 'Things to buy', 'Learning', "
                "'Home', 'Content ideas', 'People to contact'. Reuse an existing topic whenever it fits; invent a "
                "NEW short topic name only when none fit. Topic names: 1-3 words, Title Case. For EACH idea give a "
                "short reason WHY it belongs there (the owner is teaching a future assistant his taste, so the "
                "reason matters). Existing topics: %s. "
                'Reply ONLY JSON: {"results":[{"id":"...","topic":"<topic name>","reason":"one short line"}]} - '
                "one result per input idea, same ids."
                % json.dumps(p.get("topics", []), ensure_ascii=False),
                json.dumps({"ideas": p.get("ideas", [])}, ensure_ascii=False), 1600)
    if kind == "idea_tidy":  # v7.1.1: review ALL parked ideas and propose conservative cleanups (training data)
        return ("You help a person keep their IDEA PARKING LOT tidy. These are random ideas, NOT tasks. Review "
                "ALL of them and propose only CLEAR-WIN cleanups. Allowed actions: "
                "'edit' (sharpen the wording, keep the meaning) -> set newText and ids=[the one id]; "
                "'remove' (a duplicate, trivial, or clearly dead idea) -> ids=[the one id]; "
                "'merge' (2+ ideas that clearly overlap fold into one) -> ids=[all the ids], newText=the merged idea; "
                "'activate' (this idea is really ready to become a real TASK/project, e.g. it strongly connects to "
                "ongoing work) -> ids=[the one id]. Be conservative - it is FINE to return few or no suggestions. "
                "Give a short reason for each. "
                'Reply ONLY JSON: {"suggestions":[{"action":"edit|remove|merge|activate","ids":["..."],'
                '"newText":"...","reason":"one short line"}]}.',
                json.dumps({"ideas": p.get("ideas", [])}, ensure_ascii=False), 1800)
    if kind == "idea_enrich":  # v7.3: ENHANCE + ENRICH each parked idea (sharpen wording + add a concrete angle), old->new numbered review
        ctx = load_life_context()
        return ("You ENHANCE and ENRICH a person's PARKED IDEAS one by one. These are raw sparks, NOT tasks - keep "
                "them as ideas (do NOT turn them into to-dos or add deadlines). For EACH idea: (1) ENHANCE - sharpen "
                "the wording so it is vivid and clear; (2) ENRICH - add ONE concrete angle, example, or next-thought "
                "that makes the spark more useful, drawing on the OWNER'S LIFE CONTEXT below when clearly relevant "
                "(his people, projects, concerns). PRESERVE his original intent and voice; never invent facts, people, "
                "or scope not in the idea or the context. Keep each to one or two crisp sentences. If an idea is "
                "already sharp and nothing in the context helps, return it essentially unchanged with a note saying so. "
                "Return ONE entry PER input idea, same ids.\n\nLIFE CONTEXT:\n%s\n\n"
                'Reply ONLY JSON: {"suggestions":[{"id":"<the idea id>","newText":"<enhanced+enriched idea>",'
                '"reason":"<one short line: what you sharpened/added and why>"}]}.' % (ctx or "(none provided)"),
                json.dumps({"ideas": p.get("ideas", [])}, ensure_ascii=False), 2200)
    if kind == "ifthen":
        return ("Suggest ONE implementation intention for this habit/task: a cue ('if' = a concrete time/place/"
                "existing routine) and a tiny first action ('then', one concrete step). Respect religious "
                "anchors the user already uses (e.g. 'after Fajr'). "
                'Reply ONLY JSON: {"if":"...","then":"..."}.',
                json.dumps({"title": p.get("title", ""), "notes": p.get("notes", ""),
                            "cadence": p.get("cadence", "")}, ensure_ascii=False), 200)
    if kind == "enrich":
        ctx = load_life_context()
        return ("You ENRICH a terse to-do fragment into a clear, complete task by applying the OWNER'S LIFE "
                "CONTEXT below - his people, projects and ongoing concerns. Use ONLY this context. If nothing "
                "in it is clearly relevant to the fragment, return the fragment essentially UNCHANGED and set "
                "changed=false. NEVER invent people, facts, or scope that are not in the context. Keep it a "
                "concise task title.\n\nLIFE CONTEXT:\n%s\n\n"
                'Reply ONLY JSON: {"enriched":"...","context_used":"<the exact context line(s) you relied on, '
                'or empty string>","changed":true|false}.' % (ctx or "(none provided)"),
                json.dumps({"fragment": p.get("text", "")}, ensure_ascii=False), 400)
    if kind == "focus5":
        mins = p.get("availableMinutes") or 10
        return ("The user has about %d MINUTES free right now and wants a shortlist of UP TO 5 active tasks to do "
                "in that window. Choose tasks whose time cost plausibly FITS %d minutes (use each task's eta when "
                "given; if no eta, assume a small task is ~10-15 min). Order by IMPORTANCE first, but pull anything "
                "URGENT (due soon / overdue) forward. ALWAYS return 5 ids when 5 or more tasks reasonably fit - if "
                "the obvious wins run out, FILL the list with the most important SHORT tasks so the user always gets "
                "a full ~5. Never pad with big/all-day tasks that cannot fit the window. "
                'Reply ONLY JSON: {"ids":["..."],"reason":"one short sentence"} - ids from the input, best first.'
                % (mins, mins),
                json.dumps({"availableMinutes": mins, "tasks": p.get("tasks", [])}, ensure_ascii=False), 360)
    if kind == "schedule":
        return ("Suggest WHEN to schedule this task as a calendar time-block, and estimate how long it takes. "
                "Today is %s (%s). Pick a sensible near-term slot - default within the next ~3 days, during waking "
                "daytime/evening hours, never the middle of the night. Give a realistic ETA (don't lowball). "
                "If the task text (or the travel_min field) implies COMMUTE/TRAVEL time, EXTEND the block to cover it: "
                "for one-way travel of N minutes, start N minutes earlier AND end N minutes later (leave early, get back "
                "late); for a round-trip total of N, add N/2 to each side. Apply the same idea to any setup/buffer the "
                "text implies. "
                'Reply ONLY JSON: {"date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","eta_minutes":<int>,'
                '"reason":"one short sentence: why this slot and size"}.'
                % (p.get("today", ""), p.get("weekday", "")),
                json.dumps({"task": p.get("title", ""), "travel_min": p.get("travel_min", 0)}, ensure_ascii=False), 220)
    if kind == "event_desc":
        ctx = load_life_context()
        return ("Write a brief, practical calendar-event DESCRIPTION (2-4 sentences) for the event titled below, "
                "drawing on the owner's LIFE CONTEXT where relevant (his people, projects, ongoing concerns). "
                "Use ONLY this context; never invent specifics not implied by it. If nothing in the context is "
                "relevant, write a neutral, helpful description (purpose / what to prepare). Plain text, no markdown.\n\n"
                "LIFE CONTEXT:\n%s\n\n"
                'Reply ONLY JSON: {"description":"..."}.' % (ctx or "(none provided)"),
                json.dumps({"title": p.get("title", ""), "date": p.get("date", ""), "notes": p.get("notes", "")}, ensure_ascii=False), 400)
    if kind == "prayer_parse":
        return ("You are given raw TEXT extracted from a mosque PRAYER-TIMETABLE PDF. The layout is often "
                "flattened or jumbled (one value per line). Reconstruct the daily timetable. For each dated row "
                "give the five obligatory prayers Fajr, Dhuhr, Asr, Maghrib, Isha, plus Shuruq (sunrise) if present. "
                "Infer the month/year from the document. Read column HEADERS to map values correctly (orders vary). "
                'Reply ONLY JSON: {"mosque":"<name if shown else empty>","year":<4-digit year or null>,'
                '"entries":[{"date":"MM-DD","fajr":"HH:MM","shuruq":"HH:MM","dhuhr":"HH:MM","asr":"HH:MM","maghrib":"HH:MM","isha":"HH:MM"}]}. '
                "Times in 24-hour HH:MM; date is zero-padded month-day. If there is no clear timetable, return entries:[].",
                json.dumps({"text": p.get("text", "")[:14000]}, ensure_ascii=False), 4000)
    if kind == "digest":
        return ("Write the user's weekly review from their task data: 1) what got DONE (celebrate briefly, no "
                "flattery), 2) what is SLIPPING (important-but-not-urgent items going stale - these matter "
                "most), 3) a suggested focus for next week (3 bullets max). Warm, concise, no guilt-tripping. "
                'Plain text with the three headings, ~150 words. Reply ONLY JSON: {"digest":"..."}.',
                json.dumps(p.get("data", {}), ensure_ascii=False), 800)
    if kind == "habit_units":  # v6.4.13: infer the slider unit + amount per habit (Witr->rakah, video->minutes, ...)
        return ("For EACH habit title, infer the natural UNIT of measure and the current AMOUNT the person does, "
                "so a 'reduce while travelling' slider can run 1..amount. Generalise from the wording: a count in "
                "the title sets the amount and its noun the unit ('Quran 5 pages' -> 5 'pages'; 'memorise 10 lines' "
                "-> 10 'lines'); rakah-based prayers (Witr, Duha, Tahajjud) use 'rakah' with the usual amount; a "
                "media/study/exercise habit with no number gets a sensible time amount in 'minutes' (e.g. "
                "'Taymiyyah Institute video' -> 30 'minutes', 'run' -> 'minutes'). unit = a short lowercase noun. "
                "amount = a positive integer >= 2 where a meaningful reduction exists, else the natural amount. "
                'Reply ONLY JSON: {"units":[{"id":"...","amount":<int>,"unit":"..."}]} - one per input habit, same ids.',
                json.dumps({"habits": p.get("habits", [])}, ensure_ascii=False), 400)
    if kind == "ifthen_batch":  # v6.4.9: one if-then per kept habit while travelling (batch of the 'ifthen' kind)
        return ("For EACH habit below, suggest ONE implementation intention while the user is TRAVELLING: a cue "
                "('if' = a concrete time/place/existing routine, prefer anchoring to one of the five daily prayers "
                "since prayer is the one structure that finds the traveller in any city) and a tiny first action "
                "('then', one concrete step). Respect anchors the user already uses. "
                'Reply ONLY JSON: {"rules":[{"id":"<same id>","if":"...","then":"..."}]} - one per input habit, same ids.',
                json.dumps({"habits": p.get("habits", []), "context": p.get("context", "")}, ensure_ascii=False),
                90 * max(1, len(p.get("habits", []))) + 120)
    if kind == "anchor":  # v6.4.10 fallback: which prayer to anchor each habit after (only when local parse fails)
        return ("Pick which of the five daily prayers each habit should be anchored RIGHT AFTER while travelling, "
                "so the prayer becomes its cue. Choose the most natural fit. "
                'Reply ONLY JSON: {"anchors":[{"id":"<same id>","prayer":"fajr|dhuhr|asr|maghrib|isha"}]}.',
                json.dumps({"habits": p.get("habits", [])}, ensure_ascii=False),
                40 * max(1, len(p.get("habits", []))) + 80)
    if kind == "calendarize":  # v6.4.7b: lay out tomorrow's active tasks as time blocks (importance-first, prayer-aware). v6.6.31: parallel may overlap. v6.6.41: honor the owner's quiz profile.
        _prof, _rules = load_calz_profile()
        pref = ""
        if _prof or _rules:  # built WITHOUT %-formatting so a user reason containing '%' can never break the prompt
            pref = (" THE OWNER'S OWN CALENDARIZE PREFERENCES (from a short quiz - FOLLOW THESE closely; they OVERRIDE the "
                    "generic defaults above wherever they conflict, EXCEPT you still NEVER overlap a prayer or FIXED block and "
                    "never schedule into the night): " + _prof
                    + ((" Specific rules: " + " | ".join(str(r) for r in _rules)) if _rules else "") + " ")
        return ("You lay out a CALENDAR for the user's next day. Given TOMORROW'S active tasks (importance 0=someday "
                "1=normal 2=high 3=critical) and the day's FIXED blocks (prayers + existing events you must NOT "
                "overlap), propose a time-block for as many tasks as sensibly fit. Rules: importance-first "
                "(critical/high get the best focused slots); use waking daytime/evening hours only (default 08:00-22:00), "
                "never the middle of the night; respect each task's eta_minutes when given (else estimate); leave short "
                "gaps, do not stack HANDS-ON work back-to-back all day; NEVER overlap a FIXED block. "
                "PARALLEL WORK (important): each task has a 'parallel' flag. If parallel:true the user has marked it as "
                "something that can run ALONGSIDE other work - this is BROADER than background pipelines (e.g. a second app "
                "building, browsing for headphones while on a call, a download, a render, anything that does not need their "
                "full exclusive attention). ALWAYS schedule a parallel:true task, OVERLAPPING active blocks (do not skip it "
                "and do not give it an exclusive slot); start it early so it runs while the user does other things. Also "
                "INFER parallelizable tasks from the wording even when the flag is false, and overlap those too. Overlaps "
                "between parallel tasks and active work are GOOD; only a FIXED block must never be overlapped. It is fine to "
                "skip low-value NON-parallel tasks if the day is full." + pref
                + " Tomorrow is " + str(p.get("date", "")) + " (" + str(p.get("weekday", "")) + "). "
                'Reply ONLY JSON: {"blocks":[{"taskId":"<id from input>","start":"HH:MM","end":"HH:MM",'
                '"reason":"one short sentence: why this slot and size (say if it runs in parallel)"}]} - ordered by start time.',
                json.dumps({"tasks": p.get("tasks", []), "fixed": p.get("fixed", [])}, ensure_ascii=False), 1500)
    if kind == "eta":  # v6.6.2: estimate how long a task realistically takes, with a one-line reason
        return ("Estimate how many MINUTES this task realistically takes start-to-finish (do not lowball - include "
                "the boring parts). Use the title + notes. Round to a sensible 5/10/15. Give ONE short reason. "
                'Reply ONLY JSON: {"minutes":<int>,"reason":"one short sentence: why that long"}.',
                json.dumps({"title": p.get("title", ""), "notes": p.get("notes", ""), "category": p.get("category", "")}, ensure_ascii=False), 150)
    if kind == "parallel":  # v6.6.36: can this task run IN PARALLEL with other work (not needing full exclusive attention)?
        return ("Decide if this task can run IN PARALLEL with the user's other work - i.e. it does NOT need their full "
                "exclusive attention for its whole duration. Parallel examples: a build / CI / deploy, a long download, a "
                "render or training run, anything that mostly WAITS, or a light task they can do alongside another (browsing "
                "while on a call). NOT parallel: deep focus work (writing, studying, designing, a meeting). Use title + notes. "
                'Reply ONLY JSON: {"parallel":true|false,"reason":"one short sentence: why"}.',
                json.dumps({"title": p.get("title", ""), "notes": p.get("notes", ""), "category": p.get("category", ""), "eta": p.get("eta")}, ensure_ascii=False), 120)
    if kind == "chat":  # v7.1.4: Naseer - the in-app assistant. Answers questions + may PROPOSE one action (client confirms + logs).
        life = load_life_context()
        digest = load_ai_actions_digest(24)
        extra = ""
        if life:
            # v7.4: the owner's full life-context file (data/life_context.md) - Naseer should genuinely KNOW him
            # (his people, projects, deen goals, constraints), not a 2.5k teaser. Cap generously, not stingily.
            extra += ("\n\nThe owner's LIFE CONTEXT - who he is, his people, projects and season of life. Know this "
                      "like a good friend would; use names and specifics naturally when they are relevant:\n" + life[:9000])
        if digest:
            extra += ("\n\nRECENT decisions the owner made on AI suggestions (kind / accept|edit|reject / his reason - "
                      "learn his taste and WHY he changes things):\n" + digest)
        voice = bool(p.get("voice"))
        system = ("You are " + ASSISTANT_NAME + ", the calm, sharp assistant living INSIDE the owner's personal productivity "
                  "app 'Himmah'. You know every corner of the app; you help him navigate it, find and solve things, and - "
                  "only when he clearly wants something DONE - act on it. Be concise, warm and practical; never flatter; "
                  "speak in the second person; a few sentences at most unless he asks for depth.\n\n"
                  "WHAT HIMMAH IS (so you guide precisely):\n" + HIMMAH_FEATURE_BRIEF + extra + "\n\n"
                  + ("VOICE MODE: the owner is SPEAKING with you out loud. Reply in short, natural SPOKEN sentences - no "
                     "lists, no markdown, no emoji, no headings - just talk. Keep it brief. Do NOT propose any action (voice "
                     "is conversation only); set action to null always.\n"
                     if voice else
                     "You may PROPOSE AT MOST ONE action - only when he wants something done, NOT for a plain question. The app "
                     "shows him a confirm box before anything happens, so NEVER claim it is already done and never say 'opening "
                     "it now' / 'here it is'. Phrase it as an OFFER he confirms: 'I can open the calendar - confirm below' or "
                     "'Want me to add that task?'. Say what you WILL do, in the future/conditional, never the present-completed. "
                     "Allowed actions (type -> args):\n" + CHAT_ACTIONS_BRIEF + "\n")
                  + 'Reply ONLY JSON: {"reply":"<your message to the owner>","action":null OR '
                  '{"type":"<one allowed type>","args":{...},"reason":"<one line: why you suggest this>"}}.')
        user = json.dumps({"app_context": p.get("context", ""), "history": (p.get("history") or [])[-10:],
                           "message": p.get("message", "")}, ensure_ascii=False)
        return (system, user, 1300)
    if kind == "calz_profile":  # v6.6.41: turn the owner's calendarize-preferences quiz answers into a planning PROFILE (flagship model)
        return ("You convert a person's day-planning quiz answers into a compact 'calendarization profile' injected into a "
                "separate day-planner. The planner already lays out tomorrow's tasks importance-first (0=someday..3=critical), "
                "prayer-aware (the 5 daily prayers + events are FIXED blocks NEVER overlapped), eta-aware, default window "
                "08:00-22:00, leaves short gaps, and overlaps 'parallel'/background tasks onto focused work. Your job is to "
                "capture HOW THIS PERSON wants those decisions made. INPUT: answers as {id, q (the question), choice, reason}; each "
                "choice is an option, Yes/No, or 'none' with a free-text reason. ALWAYS read the reason - for 'none' the reason "
                "IS the preference, and a reason on a normal answer OVERRIDES/refines it (your strongest signal). Do NOT invent "
                "preferences the answers do not express; omit a rule rather than guess. Convert vague answers into CONCRETE, "
                "quantified instructions where possible (name times, durations, buffers, ordering, target fullness). NEVER write "
                "a rule that overlaps a prayer or FIXED block or schedules into the night - prayer rules may only set buffers, "
                "anchoring, or sequencing AROUND them. Keep the rules mutually consistent; reconcile conflicts toward the "
                "free-text reason. Be terse and operational. "
                'Reply ONLY with strict minified JSON, nothing else (start with { and end with }): {"profile":"<one paragraph, '
                '2-4 sentences, second person>","rules":["<5-8 short imperative rules, each starting with a verb>"]}. If the '
                'answers show no usable preference, return {"profile":"No clear preferences; use sensible defaults.","rules":[]}.',
                json.dumps({"answers": p.get("answers", []), "history": p.get("history", [])}, ensure_ascii=False), 700)
    if kind == "life_setup":  # v6.7.4: turn a short onboarding interview into a STARTING setup, classifying habit vs rhythm vs islamic-rhythm
        return ("You set up a personal task+calendar app (Himmah) for a NEW user from a short interview. Read their answers, "
                "infer who they are and how they actually live, and produce a MODEST, REAL starting setup - only what their "
                "answers support; never invent a busy life. CLASSIFY their routines precisely: a HABIT is something they must "
                "PUSH themselves to do (willpower; streak-tracked) e.g. gym, memorizing Quran; a RHYTHM already happens "
                "NATURALLY with no willpower (miss-tracked) e.g. morning sunlight, sleeping early; an ISLAMIC-RHYTHM is an act "
                "of worship done naturally with the right intention e.g. adhkar after prayer, sunnah rawatib, Surah al-Kahf on "
                "Friday. Rule of thumb from the user's own words: if they 'force themselves' -> habit; if it 'just happens "
                "because they are there' -> rhythm; if it is worship done with intention -> islamic rhythm. Habit categories "
                "MUST be one of: Religion, Finances, Education, Self-Improvement, Social. Importance: 0 someday, 1 normal, "
                "2 high, 3 critical. Titles concise and human. "
                'Reply ONLY with strict JSON (start with { end with }): {"persona":"<1-2 sentences about them>",'
                '"task_categories":[{"name":"...","color":"#RRGGBB"}],'
                '"tasks":[{"title":"...","category":"<a task_categories name>","importance":0,"eta_minutes":30,"due_in_days":2,"next_then":"<optional one concrete next step>"}],'
                '"projects":[{"title":"...","category":"...","subtasks":[{"title":"...","eta_minutes":30,"importance":1}]}],'
                '"habits":[{"title":"...","cadence":"daily|weekly|monthly","category":"<one of the 5 above>","per_week":null}],'
                '"rhythms":[{"title":"..."}],"islamic_rhythms":[{"title":"..."}]}. '
                "Scale to what they shared: ~3-5 categories, ~6-12 tasks, 0-2 projects, ~2-5 habits, ~1-4 rhythms, ~0-4 "
                "islamic_rhythms. If they mention no faith practice, return an empty islamic_rhythms array.",
                json.dumps({"answers": p.get("answers", []), "today": p.get("today", ""), "weekday": p.get("weekday", "")}, ensure_ascii=False), 2600)
    if kind == "life_round":  # v6.7.6: ONE round of the guided "make it yours" setup - turn a beginner's free-text answer into items for that round only
        rnd = p.get("round", "tasks")
        common = ("You gently set up a personal task+calendar app from a beginner's free-text answer. Be modest and REAL - "
                  "only what they actually said, never invent; if the answer is empty or says 'skip/nothing', return empty arrays. "
                  "Keep titles short and human. ")
        if rnd == "tasks":
            return (common + "Turn their brain-dump into TASKS (single doable things) and PROJECTS (a bigger goal = several "
                    "subtasks; split big ones into 2-5 steps). Prefer one of these existing categories, else a short new one: %s. "
                    "Importance 0 someday..3 critical. Reply ONLY JSON: {\"tasks\":[{\"title\":\"...\",\"category\":\"...\","
                    "\"importance\":1,\"eta_minutes\":30,\"due_in_days\":null,\"next_then\":\"\"}],\"projects\":[{\"title\":\"...\","
                    "\"category\":\"...\",\"subtasks\":[{\"title\":\"...\",\"eta_minutes\":30,\"importance\":1}]}]}."
                    % json.dumps(p.get("categories", []), ensure_ascii=False),
                    json.dumps({"answer": p.get("answer", "")}, ensure_ascii=False), 1600)
        if rnd == "habits":
            return (common + "Turn their answer into HABITS - things they must PUSH themselves to do (willpower; streak-tracked). "
                    "cadence is daily|weekly|monthly; category is one of: Religion, Finances, Education, Self-Improvement, Social. "
                    'Reply ONLY JSON: {"habits":[{"title":"...","cadence":"daily","category":"Self-Improvement","per_week":null}]}.',
                    json.dumps({"answer": p.get("answer", "")}, ensure_ascii=False), 800)
        if rnd == "rhythms":
            return (common + "Split their answer into RHYTHMS (automatic, no willpower - sunlight, sleeping on time) and "
                    "ISLAMIC-RHYTHMS (worship done naturally with intention - adhkar after prayer, sunnah, Surah al-Kahf on Friday). "
                    'Reply ONLY JSON: {"rhythms":[{"title":"..."}],"islamic_rhythms":[{"title":"..."}]}.',
                    json.dumps({"answer": p.get("answer", "")}, ensure_ascii=False), 700)
        return (common + "Turn their answer into REPEATING CALENDAR EVENTS - the fixed walls their week is planned around. Give each "
                "a weekday (0=Sunday..6=Saturday) OR set daily true, a rough start/end as HH:MM (24h), and recur daily|weekly. "
                "If times are vague, estimate sensibly. Put prayers/worship on schedule 'Prayer', else 'Tasks'. Reply ONLY JSON: "
                '{"events":[{"title":"...","schedule":"Tasks","weekday":1,"daily":false,"start":"18:00","end":"19:00","recur":"weekly"}]}.',
                json.dumps({"answer": p.get("answer", "")}, ensure_ascii=False), 900)
    if kind == "guardian":  # v6.6.9: smallest SUSTAINABLE reduction of protected goods for a deal window
        return ("The owner protects a few high-importance, low-urgency goods (faith, learning, health, long-term "
                "ventures). A paid/urgent DEAL has landed and he is tempted to drop them to free time - his known "
                "failure mode is ELIMINATING them, not shrinking them. For EACH protected good, propose the "
                "SMALLEST sustainable reduction that keeps it ALIVE through the deal window, never zero unless "
                "truly unavoidable: prefer 'reduce' (e.g. Quran 5 pages -> 1 page; gym 60 -> 20 min) over 'pause'; "
                "choose 'keep' for anything cheap enough to hold; reserve 'pause' for the heaviest only. A kept "
                "thread is far easier to regrow than a killed one. Generalise from the wording; the examples are "
                "illustrative. Window is %s to %s (%d days). "
                'Reply ONLY JSON: {"plan":[{"id":"<same id>","mode":"keep|reduce|pause","reduceTo":<int|null>,'
                '"unit":"<short noun|min>","reason":"one short sentence"}],'
                '"reflection":"one warm, no-guilt sentence naming the trade-off and the return date"}.'
                % (p.get("start", ""), p.get("return", ""), p.get("days", 0)),
                json.dumps({"deal": p.get("deal", ""), "goods": p.get("goods", []), "history": p.get("history", [])}, ensure_ascii=False), 700)
    if kind == "onboard_chat":  # v6.7.13: ONE back-and-forth turn of the chatbot+guide onboarding. The model converses until it has enough to propose a concrete, stage-shaped result.
        stage = p.get("stage", "")
        hist = p.get("history") or []
        if not isinstance(hist, list):  # v6.7.20 #8: a crafted non-list history must not crash the request (TypeError out of do_POST = no HTTP response)
            hist = []
        common = ("You are Himmah's warm, concise onboarding guide - a faith-aware (Muslim) personal task+calendar coach. "
                  "You and the user are having a SHORT back-and-forth to set up ONE part of THEIR real life. Ask at most one "
                  "focused question at a time, reflect back what you heard, and converge in a few turns. "
                  "GUIDE them - do NOT just accept whatever they type. If the user says 'idk', 'not sure', 'nothing', or gives a "
                  "thin / one-word / vague answer, do NOT set agreed=true: instead ask ONE concrete, EASIER probing question and "
                  "OFFER 2-3 specific examples they can simply react to (e.g. for tasks: 'an email or message you owe someone? a "
                  "bill, errand or appointment? something for your studies or your deen you keep pushing back?'). Keep gently "
                  "drawing them out until you have 3-4 CONCRETE, specific items; ONLY THEN set agreed=true and return the proposal. "
                  "Never lecture; warm and brief (under 55 words). Generalise from what they say; never invent items for them. "
                  "EARLY WRAP-UP - the ONLY exception to the 3-4 item rule: if the user EXPLICITLY asks to stop or move on "
                  "(phrases like 'wrap it up', 'that's everything', 'enough, move on', 'skip ahead') AND they have already "
                  "given at least one concrete item, set agreed=true with the best proposal from what they gave and warmly "
                  "note they can add more later inside the app. 'idk', 'not sure', 'nothing', or any vague/thin answer is "
                  "NEVER a wrap-up request - those ALWAYS get the probing question with examples, per the rule above. If "
                  "they ask to stop having given NOTHING concrete, keep agreed=false and gently point them to the Skip "
                  "button instead. ")
        shapes = {
            "habits": "Deciding their HABITS (willpower/streak things), the TOTAL minutes/day for habits, and which to PARK for now. proposal {\"habits\":[{\"title\":\"...\",\"cadence\":\"daily|weekly\",\"minutes\":15}],\"total_minutes\":60,\"parked\":[\"...\"]}",
            "rhythms": "Deciding their RHYTHMS (automatic, no willpower - sleep, sunlight) and ISLAMIC-RHYTHMS (worship done naturally - adhkar, sunnah). proposal {\"rhythms\":[{\"title\":\"...\"}],\"islamic_rhythms\":[{\"title\":\"...\"}]}",
            "categories": "Naming the CATEGORIES (areas) of their life - e.g. Work, Deen, Health, Family, Study. proposal {\"categories\":[{\"name\":\"...\"}]}",
            "tasks": "Surfacing real TASKS on their plate right now (errands, deadlines, that thing they keep putting off). proposal {\"tasks\":[{\"title\":\"...\"}]}",
            "events": "Designing their weekly SCHEDULES + repeating EVENTS (prayers, shifts, classes, halaqa, family). proposal {\"events\":[{\"title\":\"...\",\"weekday\":1,\"start\":\"18:00\"}]}",
            "guardian": "Naming what SLIPS when life gets busy, to protect ONE religious habit with the Guardian. proposal {\"protect\":\"<the habit>\",\"why\":\"...\"}",
            "waiting": "Surfacing something they are BLOCKED on / WAITING for someone else. proposal {\"waiting\":[{\"title\":\"...\",\"who\":\"...\"}]}",
            "interview": "A short LIFE-CONTEXT interview - draw out the CURRENT, latest things filling their life (work/study, family + responsibilities, deen goals, active projects, health, what is consuming their attention this season) so vague task-notes can be enriched later. Ask 2-3 focused questions, then agree. proposal {\"summary\":\"<2-3 sentence recap of their life right now>\"}",
        }
        shape = shapes.get(stage, "Setting up part of their life. proposal {\"items\":[]}")
        return (common + "This stage: " + shape + ". Reply ONLY JSON: {\"reply\":\"<your message to the user>\",\"agreed\":false,\"proposal\":null}.",
                json.dumps({"stage": stage, "history": hist[-12:], "answer": p.get("answer", "")}, ensure_ascii=False), 900)
    if kind == "field_coach":  # v6.7.13 Part A: coach the user through ONE editor field as they build their OWN first task
        field = p.get("field", "name")
        cats = p.get("categories", [])
        messy = bool(p.get("messy"))
        base = ("You help a beginner fill ONE field of a task editor for a task THEY are creating. Be brief and concrete - "
                "propose ONE short value plus a one-line why. ")
        flds = {
            "name": ("Propose a SHORT task title from their intent. "
                     + ("For this guided demo ONLY, deliberately MISSPELL one word (e.g. 'goceries', 'tomorow') so they can later watch the Enhance feature fix it. " if messy else "")),
            "category": "Pick the best-fitting category from: %s (or one short new one). " % json.dumps(cats, ensure_ascii=False),
            "importance": "Suggest importance 0 (someday) to 3 (critical), with a one-line why. ",
            "deadline": "Suggest a sensible due date in plain words (e.g. 'tomorrow', 'Friday'). ",
            "ifthen": "Suggest a tiny if-then trigger (e.g. 'after Asr, at my desk'). ",
        }
        return (base + flds.get(field, "Propose a short value. ") + 'Reply ONLY JSON: {"value":"...","why":"...","field":"%s"}.' % field,
                json.dumps({"field": field, "title": p.get("title", ""), "intent": p.get("intent", "")}, ensure_ascii=False), 300)
    if kind == "life_context":  # v6.7.15: synthesize the onboarding interview answers into a life-context document the enrich kind reads (written to data/life_context.md)
        return ("Synthesize the user's interview answers into a concise FIRST-PERSON life-context document (~120-220 words) that an "
                "assistant can use to ENRICH vague task notes later. Capture the CURRENT, latest things: their work/study, family and "
                "responsibilities, deen goals, active projects, health, and what is consuming their attention this season. Warm, specific, "
                "plain prose - no headers, no lists. Reply ONLY JSON: {\"context\":\"...\"}.",
                json.dumps({"answers": p.get("answers", [])}, ensure_ascii=False), 700)
    return None


# A deterministic, offline stand-in for the enhance LLM - lets us test the flow at $0 AND doubles as a
# real (if simpler) implementation so enhance degrades gracefully without a key. Approximate, not the LLM.
_ENH_SHORTHAND = {"gtta": "go to", "gtto": "go to", "gotta": "go", "tmrw": "tomorrow", "tmr": "tomorrow",
                  "tomorow": "tomorrow", "abt": "about", "w/": "with", "pls": "please", "appt": "appointment",
                  "supermarkt": "supermarket", "doctr": "doctor", "msg": "message"}
_ENH_FILLER = {"fr", "idk", "tbh", "ngl", "lol", "lowkey", "rn", "ig", "imo", "fr."}
_ENH_LEADIN = ("remind me to ", "remind me about ", "remind me ", "i need to ", "i have to ", "gotta ")


def _mock_enhance(text):
    s = (text or "").strip()
    low = s.lower()
    for lead in _ENH_LEADIN:
        if low.startswith(lead):
            s = s[len(lead):].strip()
            break
    out = []
    for w in s.split():
        bare = w.strip(".,!?;:").lower()
        if bare in _ENH_FILLER:
            continue
        out.append(_ENH_SHORTHAND.get(bare, w))
    cleaned = " ".join(out).strip()
    cleaned = (cleaned[:1].upper() + cleaned[1:]) if cleaned else (s[:1].upper() + s[1:] if s else "")
    return {"enhanced": cleaned, "changed": cleaned != (text or "").strip()}


# Offline stand-in for enrich: keyword-match the fragment against the life-context lines and reframe the
# best match into a task. The REAL feature is the DeepSeek 'enrich' prompt (generalises); this only exists
# for $0 flow-testing and graceful offline behaviour. Returns the same shape as the live call.
def _enrich_compose(frag, ctx_line):
    line = ctx_line.strip().rstrip(".")
    if ":" in line:
        subj, rest = line.split(":", 1)
        rest = re.sub(r"\s+for (them|him|her|us|me)$", "", rest.strip(), flags=re.I)
        out = "%s for %s" % (rest, subj.strip().lower())
    else:
        out = line
    return (out[:1].upper() + out[1:]) if out else frag


def _mock_enrich(text):
    frag = (text or "").strip()
    if not frag:
        return {"enriched": "", "context_used": "", "changed": False}
    lines = [ln.strip("-*# ").strip() for ln in load_life_context().splitlines() if ln.strip() and not ln.strip().startswith("#")]
    words = [w for w in re.findall(r"[a-z]{3,}", frag.lower())]
    best, best_score = None, 0
    for ln in lines:
        low = ln.lower()
        score = sum(1 for w in words if w in low)
        if score > best_score:
            best_score, best = score, ln
    if not best:  # nothing relevant in context → never invent; leave it alone
        return {"enriched": frag[:1].upper() + frag[1:], "context_used": "", "changed": False}
    enriched = _enrich_compose(frag, best)
    return {"enriched": enriched, "context_used": best, "changed": enriched.strip().lower() != frag.lower()}


# offline stand-in for prayer_parse: regex-pair a "Mon D" (or D-M) date token with the next six HH:MM times.
# The REAL feature is the DeepSeek 'prayer_parse' prompt (reads headers, any layout); this is the $0 fallback.
_PMON = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}


def _mock_prayer_parse(text):
    toks = [t.strip() for t in (text or "").splitlines() if t.strip()]
    ents, i = [], 0
    while i < len(toks):
        mo = day = None
        m = re.match(r"([A-Za-z]{3})[a-z]*\.?\s*(\d{1,2})$", toks[i])
        if m:
            mo = _PMON.get(m.group(1).lower()); day = int(m.group(2))
        else:
            m2 = re.match(r"(\d{1,2})[-/](\d{1,2})$", toks[i])
            if m2:
                mo, day = int(m2.group(2)), int(m2.group(1))  # assume D/M
        if mo and day and i + 6 < len(toks) and all(re.match(r"^\d{1,2}:\d{2}$", toks[i + 1 + k]) for k in range(6)):
            t = [toks[i + 1 + k] for k in range(6)]  # assume column order Fajr,Shuruq,Dhuhr,Asr,Maghrib,Isha
            ents.append({"date": "%02d-%02d" % (mo, day), "fajr": t[0], "shuruq": t[1], "dhuhr": t[2], "asr": t[3], "maghrib": t[4], "isha": t[5]})
            i += 7; continue
        i += 1
    return {"mosque": "", "year": None, "entries": ents}


def _mock_habit_units(habits):  # offline stand-in for the habit_units kind (mirrors the client regex)
    out = []
    for h in (habits or []):
        title = str(h.get("title", ""))
        m = re.search(r"(\d+)\s*([A-Za-z]+)?", title)
        if m and int(m.group(1)) > 1:
            out.append({"id": h.get("id"), "amount": int(m.group(1)), "unit": (m.group(2) or "").lower()})
        elif re.search(r"witr|rak|duha|tahajjud", title, re.I):
            out.append({"id": h.get("id"), "amount": 3, "unit": "rakah"})
        else:
            out.append({"id": h.get("id"), "amount": 30, "unit": "minutes"})
    return {"units": out}


def _mock_focus5(tasks, mins):  # v6.5.1: offline picker that honours the time window + always pads to ~5
    fits = [t for t in tasks if (t.get("eta") or 15) <= mins]
    chosen = list(fits[:5])
    if len(chosen) < 5:  # v6.5.13: fill-to-5 with the SHORTEST remaining first (never pad oversized into a small window)
        for t in sorted(tasks, key=lambda x: (x.get("eta") or 15)):
            if t in chosen:
                continue
            chosen.append(t)
            if len(chosen) >= 5:
                break
    return {"ids": [t.get("id") for t in chosen[:5]], "reason": "tasks that fit ~%d min (mock - add a real key for smart picks)" % mins}


def _mock_cal_slot(i):  # deterministic non-overlapping 45-min slots from 09:00 for the calendarize mock
    base = 9 * 60 + i * 60
    return ("%02d:%02d" % (base // 60, base % 60), "%02d:%02d" % ((base + 45) // 60, (base + 45) % 60))


def _mock_eta(p):  # v6.6.2 offline ETA: rough guess from the title length + a couple of keywords
    t = (p.get("title", "") or "").lower()
    base = 30
    if any(w in t for w in ("email", "call", "reply", "text", "quick", "buy")):
        base = 15
    elif any(w in t for w in ("write", "report", "design", "build", "plan", "research", "thesis", "pipeline")):
        base = 90
    return {"minutes": base, "reason": "a rough offline guess (add a real key for a smarter estimate)"}


def _mock_parallel(p):  # v6.6.36: keyword-based offline guess for the parallel suggestion
    t = (p.get("title", "") + " " + p.get("notes", "")).lower()
    par = any(w in t for w in ("build", "ci", "deploy", "download", "render", "pipeline", "compile", "sync", "backup", "upload", "install", "training", "while"))
    return {"parallel": par, "reason": ("looks like it mostly runs/waits in the background (mock)" if par else "looks like focused, hands-on work (mock)")}


def _mock_life_round(p):  # v6.7.6: offline echo of one guided-setup round
    rnd = p.get("round", "tasks"); a = (p.get("answer", "") or "").strip()
    if not a:
        return {"tasks": [], "projects": [], "habits": [], "rhythms": [], "islamic_rhythms": [], "events": []}
    if rnd == "tasks":
        return {"tasks": [{"title": a[:80], "category": "Personal", "importance": 1, "eta_minutes": 30, "due_in_days": None, "next_then": ""}], "projects": []}
    if rnd == "habits":
        return {"habits": [{"title": a[:80], "cadence": "daily", "category": "Self-Improvement", "per_week": None}]}
    if rnd == "rhythms":
        return {"rhythms": [{"title": a[:80]}], "islamic_rhythms": []}
    return {"events": [{"title": a[:80], "schedule": "Tasks", "weekday": 1, "daily": False, "start": "18:00", "end": "19:00", "recur": "weekly"}]}


def _mock_life_setup(p):  # v6.7.4: offline starter setup (no model) - a small neutral skeleton
    return {"persona": "A clean starting setup (offline mock - add a real DeepSeek key for a setup tailored to your answers).",
            "task_categories": [{"name": "Work", "color": "#4a8fff"}, {"name": "Personal", "color": "#f472b6"}, {"name": "Growth", "color": "#34d399"}],
            "tasks": [{"title": "Write down your top 3 priorities this month", "category": "Personal", "importance": 2, "eta_minutes": 15, "due_in_days": 2, "next_then": "Open a note and list three"},
                      {"title": "Plan the week ahead", "category": "Work", "importance": 1, "eta_minutes": 20, "due_in_days": 1}],
            "projects": [], "habits": [{"title": "10 minutes of reading", "cadence": "daily", "category": "Self-Improvement", "per_week": None}],
            "rhythms": [{"title": "Get some morning sunlight"}], "islamic_rhythms": []}


def _mock_calz_profile(p):  # v6.6.41: offline echo of the quiz answers into a plain profile (no model)
    picks = []
    for a in (p.get("answers") or []):
        c = a.get("choice")
        picks.append((a.get("q") or a.get("id") or "pref") + ": " + (str(c) if c and c != "none" else ("none - " + str(a.get("reason") or ""))))
    return {"profile": "Plan the day around the owner's stated preferences (offline mock - add a real key for a synthesized profile).",
            "rules": picks[:8] or ["No answers yet."]}


def _mock_split(answer):  # v6.7.13: split a free-text answer into rough items without a regex import
    a = (answer or "").strip()
    for ch in (";", "\n", " and ", " & "):
        a = a.replace(ch, ",")
    return [x.strip() for x in a.split(",") if x.strip()][:8]


_MOCK_CHAT_EX = {  # v6.7.22: stage-specific scaffolding examples the offline guide offers when the user is stuck
    "tasks": "an email you owe someone? a bill or errand? something for your studies or your deen you keep pushing?",
    "events": "your prayer times, a work shift, a class, your weekly halaqa, family time?",
    "habits": "Qur'an reading, the gym, journaling, a language - what do you keep meaning to do?",
    "rhythms": "earlier sleep, morning sunlight, adhkar after Fajr - small things that need no willpower?",
    "categories": "Work, Deen, Health, Family, Study - which areas fill your life?",
    "guardian": "your dhikr, the gym, Qur'an time - what's first to vanish when you get busy?",
    "waiting": "a reply you're waiting on, an approval, a delivery, something someone owes you?",
    "interview": "your work or study, your family, your deen goals, a project you're on?",
}
_MOCK_THIN = ("idk", "dunno", "i dont know", "i don't know", "not sure", "no", "nope", "nothing", "none", "n/a", "")


def _mock_onboard_chat(p):  # v6.7.22: offline GUIDED back-and-forth - probes on "idk"/thin answers, only agrees once 3+ concrete items are gathered
    stage = p.get("stage", "")
    answer = p.get("answer", "") or ""
    _WRAP_PHRASES = ("wrap up", "wrap it up", "wrap this up", "that's everything", "thats everything",
                      "enough, move on", "enough move on", "skip ahead")   # v6.9.1 fix: match every early-wrap-up
                      # phrase the real AI prompt itself lists (was only "wrap up" literally, so "wrap it up" fell
                      # through AND got harvested as a fake task item instead of ending the round)
    wrap = any(ph in answer.lower() for ph in _WRAP_PHRASES)      # v6.9: "I have enough - wrap this up" (onb-wrapup) - agree NOW with whatever was gathered, even 0-2 items
    items, seen = [], set()
    for h in (p.get("history") or []):
        if (h.get("role") == "user"):
            for x in _mock_split(h.get("content") or h.get("text") or ""):
                xl = x.lower().strip()
                if xl in _MOCK_THIN or len(xl) < 3 or xl in seen:
                    continue
                seen.add(xl); items.append(x)
    if not wrap:                                                  # v6.9: the wrap-up phrase itself is an instruction, not content - never harvest it as an "item"
        for x in _mock_split(answer):
            xl = x.lower().strip()
            if xl in _MOCK_THIN or len(xl) < 3 or xl in seen:
                continue
            seen.add(xl); items.append(x)
    probe = _MOCK_CHAT_EX.get(stage, "what comes to mind?")
    if wrap and not items:                                       # v6.9.1: wrapping up with NOTHING given -> never agree on emptiness; point at Skip
        return {"reply": "Nothing to lock in yet - give me even one, or use the Skip button below and we move on.", "agreed": False, "proposal": None}
    if len(items) < 3 and not wrap:                              # keep gently drawing them out
        if not items:
            return {"reply": "No rush - let me make it easy. For example: " + probe + " Just say whatever fits.", "agreed": False, "proposal": None}
        return {"reply": "Good - so far I have: " + ", ".join(items) + ". One or two more? Maybe " + probe, "agreed": False, "proposal": None}
    items = items[:6]
    wrapNote = " We can add more later inside the app." if (wrap and len(items) < 3) else ""
    if stage == "habits":
        return {"reply": ("Locked in - %d habit(s)." % len(items)) + wrapNote, "agreed": True,
                "proposal": {"habits": [{"title": t, "cadence": "daily", "minutes": 15} for t in items], "total_minutes": 15 * len(items), "parked": []}}
    if stage == "rhythms":
        return {"reply": "Lovely - set as rhythms." + wrapNote, "agreed": True, "proposal": {"rhythms": [{"title": t} for t in items], "islamic_rhythms": []}}
    if stage == "categories":
        return {"reply": "Your life areas, set." + wrapNote, "agreed": True, "proposal": {"categories": [{"name": t} for t in items]}}
    if stage == "tasks":
        return {"reply": ("Captured all %d - they're in your inbox." % len(items)) + wrapNote, "agreed": True, "proposal": {"tasks": [{"title": t} for t in items]}}
    if stage == "events":
        return {"reply": "Your weekly shape, set." + wrapNote, "agreed": True, "proposal": {"events": [{"title": t, "weekday": 1, "start": "18:00"} for t in items]}}
    if stage == "guardian":
        return {"reply": ("We will protect that one." if items else "Noted - you can shield one later from the Guardian panel.") + wrapNote, "agreed": True, "proposal": {"protect": (items[0] if items else ""), "why": "it slips first when you get busy"}}
    if stage == "waiting":
        return {"reply": "Tracked as waiting." + wrapNote, "agreed": True, "proposal": {"waiting": [{"title": t, "who": ""} for t in items]}}
    if stage == "interview":
        summary = ("Currently focused on: " + ", ".join(items) + ".") if items else "A general picture shared during setup."
        return {"reply": "That's a good picture - thank you." + wrapNote, "agreed": True, "proposal": {"summary": summary}}
    return {"reply": "Done." + wrapNote, "agreed": True, "proposal": {"items": items}}


def _mock_field_coach(p):  # v6.7.13: offline editor-field suggestion (mimics a messy title so Enhance has something to fix)
    field = p.get("field", "name")
    intent = (p.get("intent") or p.get("title") or "").strip()
    if field == "name":
        v = intent or "buy groceries tomorrow"
        if p.get("messy"):
            v = v.replace("groceries", "goceries").replace("tomorrow", "tomorow") or "buy goceries tomorow"
        return {"value": v[:60], "why": "short and concrete (we will polish the spelling with Enhance)", "field": "name"}
    if field == "category":
        cats = p.get("categories", [])
        return {"value": (cats[0] if cats else "Personal"), "why": "best fit from your areas", "field": "category"}
    if field == "importance":
        return {"value": "2", "why": "matters this week but not on fire", "field": "importance"}
    if field == "deadline":
        return {"value": "tomorrow", "why": "you said tomorrow", "field": "deadline"}
    if field == "ifthen":
        return {"value": "after Asr, at my desk", "why": "anchors it to a prayer you already keep", "field": "ifthen"}
    return {"value": "", "why": "", "field": field}


def _mock_chat(p):  # v7.1.4: offline Naseer - keyword-routed canned replies + a sample action so the UI/flow is testable
    msg = (p.get("message") or "").lower()
    if "tomorrow" in msg or "calendari" in msg:
        return {"reply": "I can lay tomorrow out for you at the hour. Shall I open the calendar and calendarize it?",
                "action": {"type": "calendarize_tomorrow", "args": {}, "reason": "you asked about tomorrow (mock)"}}
    if "week" in msg:
        return {"reply": "Let's plan the whole week - tighter early, looser toward the weekend.",
                "action": {"type": "calendarize_week", "args": {}, "reason": "you mentioned the week (mock)"}}
    if "mission" in msg or "focus" in msg:
        return {"reply": "Let's run a focused sprint with a countdown.",
                "action": {"type": "start_mission", "args": {"minutes": 120}, "reason": "you want to focus (mock)"}}
    if "idea" in msg:
        return {"reply": "Parked that thought in your Idea Parking Lot.",
                "action": {"type": "add_idea", "args": {"text": p.get("message", "")}, "reason": "looked like a stray idea (mock)"}}
    if "inbox" in msg:
        return {"reply": "Opening your inbox.", "action": {"type": "navigate", "args": {"to": "inbox"}, "reason": "(mock)"}}
    return {"reply": "I'm " + ASSISTANT_NAME + " (mock). I know every corner of Himmah - ask me to find, explain, or do "
            "something, and I'll propose it for your OK first.", "action": None}


def _mock_idea_sort(p):  # v7.1.1: offline idea sorter - groups by a couple of keywords, else into the first/Misc topic
    topics = list(p.get("topics") or [])
    def pick(text):
        t = (text or "").lower()
        for key, name in (("gift", "Gifts"), ("buy", "Things to buy"), ("pack", "Travel & packing"),
                          ("trip", "Travel & packing"), ("learn", "Learning"), ("read", "Learning"),
                          ("business", "Business ideas"), ("startup", "Business ideas"), ("app", "Business ideas")):
            if key in t:
                return name
        return topics[0] if topics else "Misc"
    out = [{"id": it.get("id"), "topic": pick(it.get("text", "")), "reason": "grouped by its main theme (mock)"}
           for it in p.get("ideas", [])]
    return {"results": out}


def _mock_idea_tidy(p):  # v7.1.1: offline tidy - if two ideas look alike, propose a merge; else nothing
    ideas = list(p.get("ideas", []))
    sugg = []
    if len(ideas) >= 2:
        a, b = ideas[0], ideas[1]
        wa = set((a.get("text", "") or "").lower().split())
        wb = set((b.get("text", "") or "").lower().split())
        if wa & wb:
            sugg.append({"action": "merge", "ids": [a.get("id"), b.get("id")],
                         "newText": (a.get("text", "") or "")[:80], "reason": "these two overlap (mock)"})
    return {"suggestions": sugg}


def _mock_idea_enrich(p):  # v7.3: offline enhance+enrich - lightly sharpens each idea, one entry per input
    out = []
    for it in p.get("ideas", []):
        t = (it.get("text", "") or "").strip()
        nt = t[:1].upper() + t[1:] if t else t
        if nt and not nt.endswith((".", "!", "?")):
            nt = nt + " - worth a concrete first angle when you revisit it"
        out.append({"id": it.get("id"), "newText": nt or t, "reason": "tidied the wording + nudged toward a next thought (mock)"})
    return {"suggestions": out}


def _mock_life_context(p):  # v6.7.15: offline synthesis of the interview into a life-context blurb
    ans = " ".join(str(a) for a in (p.get("answers") or [])).strip()[:800]
    return {"context": "Right now my life is full: " + (ans or "the things I shared in the interview") + ". (Mock life-context - add a real key for a richer summary the Enrich feature can use.)"}


MOCK_REPLIES = {
    "enhance": lambda p: _mock_enhance(p.get("text", "")),
    "onboard_chat": lambda p: _mock_onboard_chat(p),
    "field_coach": lambda p: _mock_field_coach(p),
    "life_context": lambda p: _mock_life_context(p),
    "eta": lambda p: _mock_eta(p),
    "parallel": lambda p: _mock_parallel(p),
    "calz_profile": lambda p: _mock_calz_profile(p),
    "life_setup": lambda p: _mock_life_setup(p),
    "life_round": lambda p: _mock_life_round(p),
    "chat": lambda p: _mock_chat(p),
    "habit_units": lambda p: _mock_habit_units(p.get("habits", [])),
    "calendarize": lambda p: {"blocks": [
        {"taskId": t.get("id"), "start": _mock_cal_slot(i)[0], "end": _mock_cal_slot(i)[1],
         "reason": "sequential morning block (mock)"}
        for i, t in enumerate(sorted(p.get("tasks", []), key=lambda x: -(x.get("importance") or 0))[:6])]},
    "ifthen_batch": lambda p: {"rules": [{"id": h.get("id"), "if": "after Fajr",
                               "then": "do the first 5 minutes of " + (h.get("title", "") or "it")} for h in p.get("habits", [])]},
    "anchor": lambda p: {"anchors": [{"id": h.get("id"), "prayer": "fajr"} for h in p.get("habits", [])]},
    "enrich": lambda p: _mock_enrich(p.get("text", "")),
    "idea_sort": lambda p: _mock_idea_sort(p),
    "idea_tidy": lambda p: _mock_idea_tidy(p),
    "idea_enrich": lambda p: _mock_idea_enrich(p),
    "prayer_parse": lambda p: _mock_prayer_parse(p.get("text", "")),
    "event_desc": lambda p: {"description": "Purpose: " + (p.get("title", "") or "the event") + ". Prepare the agenda and any docs beforehand. (mock - add a real key for context-aware drafts.)"},
    "schedule": lambda p: (lambda b=int(p.get("travel_min", 0) or 0), e=min(645 + int(p.get("travel_min", 0) or 0), 24 * 60 - 1): {"date": p.get("today", ""),
        "start": "%02d:%02d" % (max(0, 600 - b) // 60, max(0, 600 - b) % 60), "end": "%02d:%02d" % (e // 60, e % 60),  # v6.7.1: clamp end to 23:59 so a huge travel_min can't emit an out-of-range 24h+ time
        "eta_minutes": 45 + 2 * b, "reason": "a focused morning slot" + (" with %d min travel each side" % b if b else "") + " (mock)"})(),
    "focus5": lambda p: _mock_focus5(p.get("tasks", []), p.get("availableMinutes") or 10),
    "triage": lambda p: {"results": [{"id": it.get("id"), "category": (p.get("categories") or [""])[0],
                                      "importance": 1, "title": it.get("title", "")} for it in p.get("items", [])]},
    "substeps": lambda p: {"steps": ["Define what done looks like", "List what is needed", "Do the first concrete piece"]},
    "group": lambda p: {"groups": []},
    "ifthen": lambda p: {"if": "after Fajr", "then": "do the first 10 minutes at my desk"},
    "digest": lambda p: {"digest": "DONE\nMock digest - add a real key to data/deepseek_key.txt.\n\nSLIPPING\n-\n\nNEXT WEEK\n-"},
    "guardian": lambda p: {"plan": [
        {"id": g.get("id"),
         "mode": "reduce" if (g.get("currentAmount") or 0) > 1 else "keep",
         "reduceTo": max(1, int((g.get("currentAmount") or 2) // 4)) if (g.get("currentAmount") or 0) > 1 else None,
         "unit": g.get("unit") or "min", "reason": "shrink, do not drop (mock)"} for g in p.get("goods", [])],
        "reflection": "Keep the threads alive through the window - they return on " + (p.get("return") or "your date") + ". (mock)"},
}


def _extract_json(msg):
    """Pull a JSON value out of a chat message, tolerating code fences, prose wrappers, and
    'thinking' models that leave content empty and put the answer in reasoning_content.
    Returns the parsed object/array, or None if nothing parseable is found."""
    content = (msg.get("content") or "").strip()
    if not content:
        content = (msg.get("reasoning_content") or "").strip()
    if not content:
        return None
    if content.startswith("```"):                      # ```json ... ``` or ``` ... ```
        content = content[3:]
        nl = content.find("\n")
        if nl != -1 and content[:nl].strip().lower() in ("json", ""):
            content = content[nl + 1:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()
    try:
        return json.loads(content)
    except Exception:
        pass
    for op, cl in (("{", "}"), ("[", "]")):            # last resort: outermost object/array
        a, b = content.find(op), content.rfind(cl)
        if a != -1 and b > a:
            try:
                return json.loads(content[a:b + 1])
            except Exception:
                continue
    return None


def ai_call(kind, payload):
    """Returns (http_code, dict). Enforces the budget; never raises."""
    key = ai_key()
    if not key:
        return 503, {"error": "AI is off - no key in data/deepseek_key.txt (see the Setup Guides folder)"}
    spec = ai_prompt(kind, payload)
    if not spec:
        return 400, {"error": "unknown AI kind: %r" % kind}
    call_id = uuid.uuid4().hex
    if key == "MOCK":
        result = MOCK_REPLIES[kind](payload)
        ai_log({"call_id": call_id, "ts": now_iso(), "kind": kind, "model": "MOCK",
                "payload": payload, "raw_result": result})
        return 200, {"ok": True, "mock": True, "call_id": call_id, "result": result, "status": ai_status()}
    with _ai_lock:  # v6.7.1: re-check the cap under the lock so a burst of concurrent calls can't all pass a stale read and overshoot the daily ceiling
        if ai_usage()["spentUSD"] >= DAILY_CAP_USD:
            return 429, {"error": "daily AI budget (%.0f¢) reached - resets at midnight" % (DAILY_CAP_USD * 100),
                         "status": ai_status()}
    system, user, max_tokens = spec
    flagship = kind in FLAGSHIP_KINDS or (kind == "chat" and bool(payload.get("pro")))   # v7.1.4: Naseer's in-app flash/pro toggle
    model = CALENDARIZE_MODEL if flagship else AI_MODEL   # v6.6.38/.41: flagship for the hardest reasoning kinds; flash otherwise
    max_tokens = max_tokens + (CALENDARIZE_HEADROOM if flagship else REASONING_HEADROOM)  # reserve room for hidden reasoning (see note above)
    body = json.dumps({
        "model": model, "max_tokens": max_tokens, "temperature": 0.2,  # temperature is silently ignored by v4-pro thinking mode (harmless)
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }).encode("utf-8")
    req = urllib.request.Request(AI_URL, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + key})
    # DeepSeek occasionally returns fenced/prose/empty content; one retry + a tolerant parser fixes it.
    result, st, raw_snippet = None, None, ""
    req_timeout = 120 if kind in FLAGSHIP_KINDS else 90   # v6.6.38/.41: the flagship model thinks longer; give it more time
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=req_timeout) as r:
                d = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:300]
            except Exception:
                pass
            if e.code in (429, 500, 502, 503, 504) and attempt == 0:
                continue  # transient server-side error - retry once
            return 502, {"error": "DeepSeek HTTP %d - %s" % (e.code, detail or "no detail")}
        except Exception as e:
            if attempt == 0:
                continue  # network blip - retry once
            return 502, {"error": "DeepSeek unreachable (%s) - offline? AI needs internet; the rest of the app doesn't." % e.__class__.__name__}
        usage = d.get("usage", {})
        st = ai_record(usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0))
        msg = (d.get("choices") or [{}])[0].get("message", {}) or {}
        raw_snippet = (msg.get("content") or msg.get("reasoning_content") or "")[:200]
        result = _extract_json(msg)
        if result is not None:
            break
    if result is None:
        return 502, {"error": "DeepSeek returned unreadable JSON - try again", "raw": raw_snippet}
    if not isinstance(result, dict):  # v6.7.1: the tolerant parser can yield a JSON array; every kind's post-processing expects an object (else .get crashes the request)
        return 502, {"error": "DeepSeek returned unreadable JSON - try again", "raw": raw_snippet}
    if st is None:
        st = ai_usage()
    # server-side guardrail backstop for enhance: huge growth = invented content → keep the original
    if kind == "enhance":
        orig = payload.get("text", "")
        enh = str(result.get("enhanced", "") or "")
        if not enh or len(enh) > max(80, int(len(orig) * 1.8)):
            result = {"enhanced": orig, "changed": False, "guard": "rejected: enhancement grew the text too much"}
    ai_log({"call_id": call_id, "ts": now_iso(), "kind": kind, "model": model,
            "payload": payload, "raw_result": result})
    return 200, {"ok": True, "call_id": call_id, "result": result,
                 "status": {"spentToday": st["spentUSD"], "cap": DAILY_CAP_USD, "callsToday": st["calls"],
                            "hasKey": True, "mock": False, "enabled": st["spentUSD"] < DAILY_CAP_USD,
                            "model": model}}  # v6.7.20 #10: report the model actually used (flagship for onboard_chat/calendarize), not always the flash name


# v6.7.1: SSRF guard - the iCal fetch hits a user-supplied URL server-side, so it must never reach a private/internal address.
def _public_url_ok(url):
    """True only if EVERY resolved address of the URL's host is a public IP (not private/loopback/link-local/reserved)."""
    try:
        host = urlparse(url).hostname
        if not host:
            return False
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                return False
        return True
    except Exception:
        return False


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _public_url_ok(newurl):
            return None  # refuse a redirect that bounces to a private/internal address
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# ---- iCal (.ics) parsing for calendar seeding (v6.1.2) - best-effort, no external libs ----
# Parses VEVENTs from a Google "Secret address in iCal format" feed (or the bundled sample). No OAuth.
def _ics_dt(raw):
    """raw = (key_with_params, value) -> (date 'YYYY-MM-DD', time 'HH:MM' or '', allDay bool)."""
    key, val = raw
    val = val.strip()
    is_date = "VALUE=DATE" in key.upper() or (len(val) == 8 and val.isdigit())
    if is_date and len(val) >= 8:
        return "%s-%s-%s" % (val[0:4], val[4:6], val[6:8]), "", True
    if "T" in val:  # YYYYMMDDTHHMMSS(Z) - wall-clock kept as-is (TZID/UTC not converted; owner verifies)
        dpart, tpart = val.split("T", 1)
        if len(dpart) >= 8:
            date = "%s-%s-%s" % (dpart[0:4], dpart[4:6], dpart[6:8])
            tm = "%s:%s" % (tpart[0:2], tpart[2:4]) if len(tpart) >= 4 else ""
            return date, tm, False
    return "", "", True


def parse_ics(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = []
    for ln in text.split("\n"):  # RFC5545 line unfolding (continuations start with space/tab)
        if ln[:1] in (" ", "\t") and lines:
            lines[-1] += ln[1:]
        else:
            lines.append(ln)
    events, calname, cur = [], "", None
    for ln in lines:
        up = ln.rstrip().upper()  # v6.7.1: rstrip so BEGIN/END:VEVENT still match when an unfolded line has trailing whitespace (else the event silently drops)
        if up.startswith("X-WR-CALNAME") and ":" in ln:
            calname = ln.split(":", 1)[1].strip()
        elif up == "BEGIN:VEVENT":
            cur = {}
        elif up == "END:VEVENT":
            if cur is not None:
                title = (cur.get("SUMMARY", ("", ""))[1] or "(no title)").strip()
                date, start, allday = _ics_dt(cur["DTSTART"]) if "DTSTART" in cur else ("", "", True)
                _, end, _e = _ics_dt(cur["DTEND"]) if "DTEND" in cur else ("", "", True)
                events.append({"uid": (cur.get("UID", ("", ""))[1] or "").strip(), "title": title,
                               "date": date, "start": start, "end": end, "allDay": allday,
                               "recurring": "RRULE" in cur,
                               "rrule": (cur.get("RRULE", ("", ""))[1] or "").strip()})
                cur = None
        elif cur is not None and ":" in ln:
            key, val = ln.split(":", 1)
            cur[key.split(";", 1)[0].upper()] = (key, val)
    return calname, [e for e in events if e["date"]]


# ---- Google Meet link generation (v6.1.11) - real Meet links need the Google Calendar API + OAuth.
# Config lives in data/google_meet.json: {access_token?, refresh_token, client_id, client_secret, calendar_id?}.
# Until the owner connects Google (see GOOGLE-MEET-SETUP-GUIDE.html), /api/meet returns needsSetup. ----
GOOGLE_MEET_FILE = os.path.join(DATA_DIR, "google_meet.json")


def _google_refresh(cfg):
    try:
        body = urlencode({"client_id": cfg["client_id"], "client_secret": cfg["client_secret"],
                          "refresh_token": cfg["refresh_token"], "grant_type": "refresh_token"}).encode()
        with urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=body, method="POST"), timeout=20) as r:
            return json.loads(r.read().decode("utf-8")).get("access_token")
    except Exception:
        return None


def _google_create_meet(token, cal, data):
    date = data.get("date") or now_iso()[:10]
    st = (data.get("startTime") or "09:00")[:5]
    en = (data.get("endTime") or "09:30")[:5]
    tz = data.get("tz") or "Europe/Amsterdam"
    body = json.dumps({
        "summary": data.get("summary") or "Meeting",
        "start": {"dateTime": "%sT%s:00" % (date, st), "timeZone": tz},
        "end": {"dateTime": "%sT%s:00" % (date, en), "timeZone": tz},
        "conferenceData": {"createRequest": {"requestId": uuid.uuid4().hex, "conferenceSolutionKey": {"type": "hangoutsMeet"}}},
    }).encode()
    url = "https://www.googleapis.com/calendar/v3/calendars/%s/events?conferenceDataVersion=1" % quote(cal)
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.loads(r.read().decode("utf-8"))
    link = d.get("hangoutLink")
    if not link:
        for ep in d.get("conferenceData", {}).get("entryPoints", []):
            if ep.get("uri", "").startswith("https://meet.google.com"):
                link = ep["uri"]; break
    return link


# ---------------------------------------------------------------- file import (v6.6.16) -------
# bytes -> plain text, per file type. Each returns (text, reason): reason is set (and text empty) on failure,
# so one bad/scanned file is skipped without aborting the rest. All extraction is in-memory + offline.
def _extract_pdf(raw):
    try:
        import io
        from pypdf import PdfReader
    except ImportError:
        return "", "PDF support needs 'pypdf' - run: py -m pip install pypdf"
    try:
        text = "\n".join((pg.extract_text() or "") for pg in PdfReader(io.BytesIO(raw)).pages)
    except Exception as e:
        return "", "couldn't read the PDF (%s)" % e.__class__.__name__
    if not text.strip():
        return "", "no selectable text (looks like a scanned/image PDF)"
    return text, None


def _extract_docx(raw):
    # preferred: python-docx if installed; otherwise a dependency-free zip+xml read of word/document.xml.
    try:
        import io
        import docx  # the 'python-docx' package imports as 'docx'
        d = docx.Document(io.BytesIO(raw))
        text = "\n".join(p.text for p in d.paragraphs)
        if text.strip():
            return text, None
    except ImportError:
        pass
    except Exception:
        pass
    try:
        import io, zipfile, re as _re
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
        xml = _re.sub(r"</w:p>", "\n", xml)            # paragraph breaks -> newlines
        xml = _re.sub(r"<w:tab[ /][^>]*>", "\t", xml)  # tabs
        text = _re.sub(r"<[^>]+>", "", xml)            # strip all remaining tags
        text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'")
        if text.strip():
            return text.strip(), None
    except Exception as e:
        return "", "couldn't read the Word file (%s)" % e.__class__.__name__
    return "", "no readable text in the Word file"


def _extract_text_file(raw):
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return raw.decode("latin-1", "replace"), None


# ---------------------------------------------------------------- http -------
class Handler(BaseHTTPRequestHandler):
    server_version = "Himmah/1.0"

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _read_body(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(min(n, MAX_BODY)) if n > 0 else b""  # v6.7.1: cap the read - an oversized Content-Length truncates (-> normal 400) instead of allocating gigabytes
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return None

    def _origin_ok(self):
        # v6.7.1: CSRF guard for mutating routes. Allow a missing Origin (non-browser tools like curl), a same-origin
        # request (Origin host == the Host we were asked on - covers 127.0.0.1 AND the LAN IP on a phone), or loopback.
        o = self.headers.get("Origin") or self.headers.get("Referer") or ""
        if not o:
            return True
        oh = urlparse(o).hostname
        hh = (self.headers.get("Host") or "").split(":")[0]
        return oh == hh or oh in ("127.0.0.1", "localhost")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/state":
            return self._json(load_state())
        if path == "/api/snapshots":
            return self._json(list_snapshots())
        if path == "/api/snapshot":
            # v6.6.21: read ONE full snapshot body (for the diff-before-restore preview). Read-only: does NOT
            # snapshot or prune, so it cannot disturb history. Traversal-guarded on the id.
            sid = parse_qs(urlparse(self.path).query).get("id", [""])[0]
            if not sid or "/" in sid or "\\" in sid or ".." in sid:
                return self._json({"error": "bad id"}, 400)
            fp = os.path.join(SNAP_DIR, sid + ".json")
            if not os.path.isfile(fp):
                return self._json({"error": "not found"}, 404)
            try:
                with open(fp, encoding="utf-8") as f:
                    return self._json(json.load(f))
            except Exception:
                return self._json({"error": "snapshot is unreadable/corrupt"}, 422)  # v6.7.1: a corrupt snapshot returns JSON, not an aborted connection
        if path == "/api/ai/status":
            return self._json(ai_status())
        if path == "/api/calz_prefs":  # v6.6.41: current calendarize-preferences profile (for the quiz button's "last tuned" + re-take)
            d = load_calz_prefs()
            return self._json({"profile": d.get("profile", ""), "rules": d.get("rules", []),
                               "updated": d.get("updated"), "sessions": len(d.get("sessions", []))})
        if path == "/api/prayer_times":
            # mosque prayer times for the calendar's "populate" feature. Defensive: never throws.
            try:
                with open(PRAYER_FILE, encoding="utf-8") as f:
                    return self._json(json.load(f))
            except Exception:
                return self._json({"ok": False, "mosque": "", "times": {}})
        return self.serve_static(path)

    def do_PUT(self):
        if not self._origin_ok():
            return self._json({"error": "bad origin"}, 403)  # v6.7.1: block cross-site writes
        if urlparse(self.path).path == "/api/state":
            data = self._read_body()
            # reject anything that isn't a real state, so a bad/empty write can never blank the tasks
            if not isinstance(data, dict) or not isinstance(data.get("items"), list) or not isinstance(data.get("categories"), list):
                return self._json({"error": "invalid state - must include items[] and categories[]"}, 400)
            save_state(data)
            return self._json({"ok": True, "savedAt": data.get("meta", {}).get("savedAt")})
        self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        if not self._origin_ok():
            return self._json({"error": "bad origin"}, 403)  # v6.7.1: block cross-site POST (AI spend / SSRF / state changes)
        path = urlparse(self.path).path
        if path == "/api/state":
            # v6.9.4 FIX: the beforeunload flush uses navigator.sendBeacon, which can ONLY send POST - this route
            # previously existed only as PUT, so the last debounced save was silently 404-dropped on every tab close.
            data = self._read_body()
            if not isinstance(data, dict) or not isinstance(data.get("items"), list) or not isinstance(data.get("categories"), list):
                return self._json({"error": "invalid state - must include items[] and categories[]"}, 400)
            save_state(data)
            return self._json({"ok": True, "savedAt": data.get("meta", {}).get("savedAt")})
        if path == "/api/restore":
            data = self._read_body() or {}
            st = restore_snapshot(data.get("id"))
            if st is None:
                return self._json({"error": "not found"}, 404)
            return self._json(st)
        if path == "/api/life_setup":
            # v6.7.4: onboarding interview -> flagship model builds a starting setup -> assemble + REPLACE the (demo) state.
            data = self._read_body()
            if not isinstance(data, dict) or not isinstance(data.get("answers"), list) or not data["answers"]:
                return self._json({"error": "body must be JSON with a non-empty 'answers' array"}, 400)
            code, out = ai_call("life_setup", {"answers": data["answers"], "today": data.get("today", ""), "weekday": data.get("weekday", "")})
            if code != 200 or not isinstance(out, dict) or not isinstance(out.get("result"), dict):
                return self._json({"error": (out.get("error") if isinstance(out, dict) else "AI setup failed"), "status": (out.get("status") if isinstance(out, dict) else None)}, 502)
            try:
                state = assemble_setup(out["result"])
            except Exception as e:
                return self._json({"error": "could not assemble the setup (%s)" % e.__class__.__name__}, 500)
            if not state.get("items") and not state.get("rhythms"):
                return self._json({"error": "the AI returned an empty setup - try sharing a bit more"}, 502)
            save_state(state)  # snapshots the demo first, so it is undoable from History
            from collections import Counter as _C
            tc = _C(i.get("type") for i in state["items"])
            return self._json({"ok": True, "persona": out["result"].get("persona", ""),
                               "counts": {"tasks": tc.get("task", 0), "projects": tc.get("project", 0), "habits": tc.get("rhythm", 0),
                                          "rhythms": sum(1 for r in state["rhythms"] if r.get("cat") == "natural"),
                                          "islamic_rhythms": sum(1 for r in state["rhythms"] if r.get("cat") == "religious"),
                                          "categories": len(state["categories"])},
                               "status": (out.get("status") if isinstance(out, dict) else None)})
        if path == "/api/life_add":
            # v6.7.6: guided "make it yours" - one round at a time. The AI turns a free-text answer into
            # items for that round (tasks / habits / rhythms / events) and APPENDS them to the live state.
            data = self._read_body()
            if not isinstance(data, dict) or data.get("round") not in ("tasks", "habits", "rhythms", "events"):
                return self._json({"error": "body must be JSON with round = tasks|habits|rhythms|events"}, 400)
            rnd = data["round"]; answer = (data.get("answer") or "").strip()
            if not answer:  # the user skipped this round - nothing to do, not an error
                return self._json({"ok": True, "skipped": True, "added": {}})
            state = load_state()
            # v6.10.0 FIX: when the chat already AGREED on a proposal, apply THAT spec directly - the old path
            # re-extracted items from the raw text with a second AI call, so what landed could differ from what
            # the user approved (and in mock mode it collapsed 3 approved habits into 1). Fallback: no spec ->
            # the original extraction path, unchanged.
            spec = data.get("spec")
            if isinstance(spec, dict) and any(isinstance(v, list) and v for v in spec.values()):
                out = {"result": spec}
            else:
                cats = [c.get("name") for c in state.get("categories", []) if c.get("name")]
                code, out = ai_call("life_round", {"round": rnd, "answer": answer[:2000], "categories": cats,
                                                   "today": data.get("today", ""), "weekday": data.get("weekday", "")})
                if code != 200 or not isinstance(out, dict) or not isinstance(out.get("result"), dict):
                    return self._json({"error": (out.get("error") if isinstance(out, dict) else "AI failed"),
                                       "status": (out.get("status") if isinstance(out, dict) else None)}, 502)
            try:
                added = _life_add(state, rnd, out["result"])
            except Exception as e:
                return self._json({"error": "could not add (%s)" % e.__class__.__name__}, 500)
            state.setdefault("meta", {})["demo"] = False
            save_state(state)
            return self._json({"ok": True, "round": rnd, "added": added,
                               "status": (out.get("status") if isinstance(out, dict) else None)})
        if path == "/api/life_context":
            # v6.7.15: the onboarding interview -> synthesize -> write data/life_context.md (the SAME file the enrich kind reads via load_life_context)
            data = self._read_body()
            if not isinstance(data, dict) or not isinstance(data.get("answers"), list) or not data["answers"]:
                return self._json({"error": "body must be JSON with a non-empty 'answers' array"}, 400)
            code, out = ai_call("life_context", {"answers": [str(a)[:1500] for a in data["answers"]][:30]})
            if code != 200 or not isinstance(out, dict) or not isinstance(out.get("result"), dict):
                return self._json({"error": (out.get("error") if isinstance(out, dict) else "AI failed"), "status": (out.get("status") if isinstance(out, dict) else None)}, 502)
            ctx = (out["result"].get("context") or "").strip()
            if not ctx:
                return self._json({"error": "the AI returned an empty context - try sharing a bit more"}, 502)
            try:
                with open(LIFE_CONTEXT_FILE, "w", encoding="utf-8") as f:
                    f.write(ctx)
            except Exception as e:
                return self._json({"error": "could not write life context (%s)" % e.__class__.__name__}, 500)
            return self._json({"ok": True, "chars": len(ctx), "status": (out.get("status") if isinstance(out, dict) else None)})
        if path == "/api/ai":
            data = self._read_body()
            if not isinstance(data, dict) or not data.get("kind"):
                return self._json({"error": "body must be JSON with a 'kind'"}, 400)
            code, out = ai_call(data["kind"], data)
            # v6.9.3 BACKSTOP: onboard_chat may NEVER agree when the user has given nothing concrete -
            # deterministic guard on top of the prompt, so a compliant-but-lazy model can't lock in on "idk".
            if data["kind"] == "onboard_chat" and code == 200 and isinstance(out, dict):
                r = out.get("result")
                if isinstance(r, dict) and r.get("agreed"):
                    texts = [h.get("content") or h.get("text") or "" for h in (data.get("history") or []) if isinstance(h, dict) and h.get("role") == "user"]
                    texts.append(str(data.get("answer", "")))
                    concrete = []
                    for t in texts:
                        for x in _mock_split(t):
                            xl = x.lower().strip()
                            if xl not in _MOCK_THIN and len(xl) >= 3:
                                concrete.append(x)
                    if not concrete:
                        r["agreed"] = False
                        r["proposal"] = None
                        r["reply"] = "No rush - let me make it easier. " + _MOCK_CHAT_EX.get(data.get("stage", ""), "What comes to mind first?") + " Even one is a great start."
            return self._json(out, code)
        if path == "/api/ai_outcome":
            # the owner accepted / edited / rejected an AI proposal - append ONE durable line.
            # tag: per the v5.3 brief, every line is tagged "test" FOR NOW (the client sends no tag yet);
            # data.get(..,"test") keeps that default while leaving room to pass "real" later without a server change.
            data = self._read_body()
            if not isinstance(data, dict):
                return self._json({"error": "bad outcome"}, 400)
            rec = {"call_id": data.get("call_id"), "item_id": data.get("item_id"), "ts": now_iso(),
                   "kind": data.get("kind"), "decision": data.get("decision"),
                   "ai_proposed": data.get("ai_proposed"), "my_final": data.get("my_final"),
                   "my_reason": data.get("my_reason"), "tag": data.get("tag", "test")}
            # enrich carries extra training signal: the raw fragment + which context the model leaned on
            if data.get("original_input") is not None:
                rec["original_input"] = data.get("original_input")
            if data.get("context_used") is not None:
                rec["context_used"] = data.get("context_used")
            if data.get("task_overview") is not None:  # v6.4.7b: full task snapshot at accept/reject time
                rec["task_overview"] = data.get("task_overview")
            ai_log(rec)
            return self._json({"ok": True})
        if path == "/api/calz_prefs":
            # v6.6.41: save the calendarize-preferences quiz answers, synthesize a profile with the FLAGSHIP model, persist both.
            # The answers are saved even if the AI call fails (they are training data + can be re-analyzed later).
            data = self._read_body()
            if not isinstance(data, dict) or not isinstance(data.get("answers"), list) or not data["answers"]:
                return self._json({"error": "body must be JSON with a non-empty 'answers' array"}, 400)
            prefs = load_calz_prefs()
            prefs.setdefault("sessions", []).append({"ts": now_iso(), "answers": data["answers"]})
            prefs["sessions"] = prefs["sessions"][-20:]  # keep the last 20 quiz sessions
            atomic_write(CALZ_PREFS_FILE, prefs)  # v6.6.41: persist the answers FIRST - they survive ANY analysis failure (training data)
            code, out = ai_call("calz_profile", {"answers": data["answers"], "history": prefs["sessions"][:-1][-3:]})
            profile, rules = prefs.get("profile", "") or "", prefs.get("rules", []) or []
            if code == 200 and isinstance(out, dict) and isinstance(out.get("result"), dict):
                r = out["result"]
                if isinstance(r.get("profile"), str) and r["profile"].strip():  # type-checked (the model could return a non-string)
                    profile = r["profile"].strip()
                if isinstance(r.get("rules"), list):
                    rules = [str(x) for x in r["rules"] if str(x).strip()]
            prefs["profile"], prefs["rules"], prefs["updated"] = profile, rules, now_iso()
            atomic_write(CALZ_PREFS_FILE, prefs)
            return self._json({"ok": True, "profile": profile, "rules": rules, "analyzed": code == 200,
                               "ai_error": (out.get("error") if (code != 200 and isinstance(out, dict)) else None),
                               "status": (out.get("status") if isinstance(out, dict) else None)})
        if path == "/api/ics":
            # fetch + parse an iCal feed (or the bundled sample) for the calendar import "interview".
            data = self._read_body() or {}
            try:
                if data.get("sample"):
                    with open(os.path.join(DATA_DIR, "sample.ics"), encoding="utf-8") as f:
                        text = f.read()
                    src = "sample.ics"
                else:
                    url = (data.get("url") or "").strip().replace("webcal://", "https://")
                    if not (url.startswith("https://") or url.startswith("http://")):
                        return self._json({"error": "paste a valid https:// iCal URL (or use the sample)"}, 400)
                    if not _public_url_ok(url):  # v6.7.1: SSRF guard - refuse private/loopback/link-local/reserved targets
                        return self._json({"error": "that URL points to a private/local address - paste the public iCal secret-address URL"}, 400)
                    req = urllib.request.Request(url, headers={"User-Agent": "Himmah/1.0"})
                    opener = urllib.request.build_opener(_SafeRedirect())  # v6.7.1: follow redirects only to public addresses
                    with opener.open(req, timeout=20) as r:
                        text = r.read(5000000).decode("utf-8", "replace")
                    src = url
                calname, events = parse_ics(text)
                return self._json({"ok": True, "calendarName": calname or src, "count": len(events), "events": events[:500]})
            except urllib.error.HTTPError as e:
                return self._json({"error": "feed returned HTTP %d - check the URL is the iCal secret address" % e.code}, 502)
            except Exception as e:
                return self._json({"error": "couldn't fetch/parse (%s)" % e.__class__.__name__}, 502)
        if path == "/api/prayer_pdf":
            # v6.1.6: upload a mosque prayer-times PDF -> extract text (pypdf) -> AI structures it.
            data = self._read_body() or {}
            try:
                import base64
                import io
                pdf = base64.b64decode(data.get("pdf_base64", "") or "")
            except Exception:
                return self._json({"error": "bad upload"}, 400)
            try:
                from pypdf import PdfReader
                text = "\n".join((pg.extract_text() or "") for pg in PdfReader(io.BytesIO(pdf)).pages)
            except ImportError:
                return self._json({"error": "PDF support needs the 'pypdf' package - run: py -m pip install pypdf"}, 501)
            except Exception as e:
                return self._json({"error": "couldn't read the PDF (%s)" % e.__class__.__name__}, 502)
            if not text.strip():
                return self._json({"error": "no selectable text - this looks like a scanned/image PDF; a text-based PDF is needed"}, 422)
            code, out = ai_call("prayer_parse", {"text": text})
            if code != 200:
                return self._json(out, code)
            res = out.get("result", {}) or {}
            return self._json({"ok": True, "mosque": res.get("mosque", ""), "year": res.get("year"),
                               "entries": res.get("entries", []), "chars": len(text)})
        if path == "/api/prayer_save":
            # persist reviewed prayer times: MERGE into existing (back up first) + (re)write an MD copy.
            data = self._read_body() or {}
            entries = data.get("entries", [])
            if not isinstance(entries, list) or not entries:
                return self._json({"error": "no entries to save"}, 400)
            times = {}
            for e in entries:
                d = str(e.get("date", "")).strip()
                if re.match(r"^\d{2}-\d{2}$", d) and all(e.get(k) for k in ("fajr", "dhuhr", "asr", "maghrib", "isha")):
                    times[d] = {k: e[k] for k in ("fajr", "shuruq", "dhuhr", "asr", "maghrib", "isha") if e.get(k)}
            if not times:
                return self._json({"error": "no valid dated rows (need MM-DD + the 5 prayers)"}, 400)
            existing = {"mosque": "", "times": {}}
            try:
                with open(PRAYER_FILE, encoding="utf-8") as f:
                    existing = json.load(f)
            except Exception:
                pass
            try:
                if os.path.exists(PRAYER_FILE):
                    shutil.copy(PRAYER_FILE, PRAYER_FILE + ".bak")
            except Exception:
                pass
            merged = dict(existing.get("times", {}))
            merged.update(times)
            mosque = data.get("mosque") or existing.get("mosque") or "My mosque"
            atomic_write(PRAYER_FILE, {"mosque": mosque, "source": "uploaded PDF (merged with prior)", "times": merged})
            try:  # the "PDF -> MD" the owner asked for
                md = ["# %s - prayer times" % mosque, "", "Source: uploaded PDF. Local clock time, keyed by month-day (MM-DD).", "",
                      "| Date | Fajr | Shuruq | Dhuhr | Asr | Maghrib | Isha |", "|---|---|---|---|---|---|---|"]
                for k in sorted(merged):
                    c = merged[k]
                    md.append("| %s | %s | %s | %s | %s | %s | %s |" % (k, c.get("fajr", "-"), c.get("shuruq", "-"), c.get("dhuhr", "-"), c.get("asr", "-"), c.get("maghrib", "-"), c.get("isha", "-")))
                with open(os.path.join(DATA_DIR, "prayer_times.md"), "w", encoding="utf-8") as f:
                    f.write("\n".join(md))
            except Exception:
                pass
            return self._json({"ok": True, "saved": len(times), "total": len(merged)})
        if path == "/api/import":
            # v6.6.16: import files (PDF/txt/md/docx/csv) -> extract text server-side -> client adds one inbox item
            # per file. Mirrors /api/prayer_pdf (base64-in-JSON). Offline only; defensive; partial success allowed.
            data = self._read_body() or {}
            files = data.get("files")
            if not isinstance(files, list) or not files:
                return self._json({"error": "no files in the upload"}, 400)
            import base64
            items, skipped = [], []
            for f in files[:50]:                       # hard cap: never more than 50 files in one go
                name = str((f or {}).get("name", "") or "file")
                ext = os.path.splitext(name)[1].lower()
                if ext not in IMPORT_EXT:
                    skipped.append({"name": name, "reason": "unsupported type (%s)" % (ext or "no extension")})
                    continue
                try:
                    raw = base64.b64decode((f or {}).get("b64", "") or "")
                except Exception:
                    skipped.append({"name": name, "reason": "couldn't decode the upload"}); continue
                if not raw:
                    skipped.append({"name": name, "reason": "empty file"}); continue
                if len(raw) > IMPORT_MAX_BYTES:
                    skipped.append({"name": name, "reason": "too big (over %d MB)" % (IMPORT_MAX_BYTES // (1024 * 1024))}); continue
                if ext == ".pdf":
                    text, reason = _extract_pdf(raw)
                elif ext == ".docx":
                    text, reason = _extract_docx(raw)
                else:
                    text, reason = _extract_text_file(raw)
                if reason:
                    skipped.append({"name": name, "reason": reason}); continue
                items.append({"title": name, "text": text, "chars": len(text), "ext": ext})
            return self._json({"ok": True, "items": items, "skipped": skipped})
        if path == "/api/meet":
            # generate a real Google Meet link (needs the owner's Google OAuth in data/google_meet.json)
            data = self._read_body() or {}
            cfg = {}
            try:
                with open(GOOGLE_MEET_FILE, encoding="utf-8") as f:
                    cfg = json.load(f)
            except Exception:
                pass
            token = cfg.get("access_token")
            if not token and all(cfg.get(k) for k in ("refresh_token", "client_id", "client_secret")):
                token = _google_refresh(cfg)
            if not token:
                return self._json({"ok": False, "needsSetup": True,
                                   "error": "Google isn't connected yet - open GOOGLE-MEET-SETUP-GUIDE.html to connect it."})
            try:
                link = _google_create_meet(token, cfg.get("calendar_id", "primary"), data)
                if not link:
                    return self._json({"ok": False, "error": "Google made the event but returned no Meet link"})
                return self._json({"ok": True, "link": link})
            except urllib.error.HTTPError as e:
                return self._json({"ok": False, "error": "Google API HTTP %d - token may be expired; reconnect." % e.code})
            except Exception as e:
                return self._json({"ok": False, "error": "Google API error (%s)" % e.__class__.__name__})
        self._send(404, b'{"error":"not found"}')

    def serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        root = os.path.realpath(ROOT)
        fp = os.path.realpath(os.path.join(root, path.lstrip("/")))
        try:
            inside = os.path.commonpath([fp, root]) == root  # blocks ../ and drive-absolute traversal
        except ValueError:
            inside = False
        data_dir = os.path.realpath(DATA_DIR)
        in_data = fp == data_dir or fp.startswith(data_dir + os.sep)
        ext = os.path.splitext(fp)[1].lower()
        if (not inside) or in_data or ext not in ALLOWED_EXT or not os.path.isfile(fp):
            return self._send(404, b"not found", "text/plain")
        ctype = {".html": "text/html", ".css": "text/css", ".js": "application/javascript",
                 ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
                 ".webmanifest": "application/manifest+json",
                 ".ico": "image/x-icon"}.get(ext, "application/octet-stream")
        with open(fp, "rb") as f:
            body = f.read()
        if ext == ".html":  # inline local css/js so there are no separate files to cache (no stale builds, ever)
            try:
                text = body.decode("utf-8")

                def _inroot(rel):  # v6.7.1: resolve + confirm the inlined asset stays under the app root (no ../ traversal)
                    ap = os.path.realpath(os.path.join(root, rel))
                    ok = (ap == root or ap.startswith(root + os.sep)) and os.path.isfile(ap)
                    return ok, ap

                def _css(m):
                    ok, ap = _inroot(m.group(1))
                    if ok:
                        with open(ap, encoding="utf-8") as g:
                            return "<style>" + g.read() + "</style>"
                    return m.group(0)

                def _js(m):
                    ok, ap = _inroot(m.group(1))
                    if ok:
                        with open(ap, encoding="utf-8") as g:
                            return "<script>" + g.read().replace("</script>", "<\\/script>") + "</script>"
                    return m.group(0)

                text = re.sub(r'<link rel="stylesheet" href="([^":?]+\.css)"\s*/?>', _css, text)
                text = re.sub(r'<script src="([^":?]+\.js)"></script>', _js, text)
                body = text.encode("utf-8")
            except Exception:
                pass
        self._send(200, body, ctype + "; charset=utf-8")

    def log_message(self, *args):
        pass  # stay quiet / cheap


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    ensure_dirs()
    load_state()  # seed on first run
    lan = "--lan" in sys.argv
    host = "0.0.0.0" if lan else "127.0.0.1"
    port = PORT
    if "--port" in sys.argv:  # dev/testing: run a second instance without touching the live one
        try:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        except (IndexError, ValueError):
            pass
    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError:
        print("\n  Himmah is already running at http://127.0.0.1:%d\n" % port)
        return
    httpd.daemon_threads = True
    print("\n  Himmah is running.")
    print("  On this PC:   http://127.0.0.1:%d" % port)
    if lan:
        print("  On your phone (same wifi):   http://%s:%d" % (lan_ip(), port))
    else:
        print("  (run with  --lan  to also open it on your phone)")
    print("\n  Press Ctrl+C to stop (then it uses zero resources).\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped. Bye.\n")
        httpd.server_close()


if __name__ == "__main__":
    main()
