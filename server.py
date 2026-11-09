#!/usr/bin/env python3
"""ORV Reader server.

Serves the reader, keeps reading position in state/state.json, searches only the
chapters you've read, and answers recap / lookup questions through headless
`claude -p`. The text sent to Claude is always built here from chapters up to
the reader's place, so the page cannot widen the spoiler gate.

Usage:  python3 server.py            # this Mac only
        python3 server.py --lan      # also reachable from your phone (token required)
"""
import argparse, hashlib, json, os, re, secrets, socket, subprocess, tempfile, threading, time
from concurrent.futures import ThreadPoolExecutor
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
APP, DATA, STATE_DIR = ROOT / "app", ROOT / "data", ROOT / "state"
STATE_DIR.mkdir(exist_ok=True)
STATE_FILE, CACHE_FILE, TOKEN_FILE = STATE_DIR / "state.json", STATE_DIR / "cache.json", STATE_DIR / "token.txt"

INDEX = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
CHAPTERS = [json.loads((DATA / "ch" / f"{e['i']:04d}.json").read_text(encoding="utf-8")) for e in INDEX]
N = len(CHAPTERS)
ENTITIES = [{"n": e["name"], "c": e["cat"]} for e in json.loads((DATA / "entities.json").read_text(encoding="utf-8"))] if (DATA / "entities.json").exists() else []

lock = threading.Lock()

def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default

def write_json(path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)

# ---------- spoiler-gated Claude calls ----------

SYSTEM = (
    "You are a reading companion for the web novel Omniscient Reader's Viewpoint. "
    "You know ONLY the passages given in the user message. You must not use any other knowledge of this novel, "
    "its webtoon, its wiki, or its fandom, even if you recognize the story. If the passages do not establish "
    "something, say that it has not been shown yet. Never hint at, predict, or foreshadow anything beyond the passages. "
    "Write plain prose with no markdown headings, no bullet lists unless asked, and no preamble. Be accurate before clever."
)

def chapter_label(c):
    return f"Ch. {c['n']}" if c.get("n") else f"#{c['i']}"

def run_claude(prompt, model="haiku", timeout=300):
    with tempfile.TemporaryDirectory() as td:  # empty cwd: nothing else to read
        r = subprocess.run(
            ["claude", "-p", "--model", model, "--tools", "", "--no-session-persistence", "--system-prompt", SYSTEM],
            input=prompt, capture_output=True, text=True, cwd=td, timeout=timeout,
        )
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "claude failed").strip()[:500])
    return r.stdout.strip()

BAD = re.compile(
    r"(you pasted|paste the|paste it|attached passages|message doesn't include|message does not include|"
    r"doesn't include the text|does not include the text|I can only summarize what|I can't summarize|"
    r"I cannot summarize|I'm not able to produce|no passages were|didn't receive|did not receive)", re.I)

def run_checked(prompt, model="haiku", min_words=60):
    """Run Claude and reject refusal-shaped or too-short answers. Retries, then falls back to sonnet."""
    last = ""
    for attempt, m in enumerate([model, model, "sonnet"]):
        out = run_claude(prompt, m)
        last = out
        if len(out.split()) >= min_words and not BAD.search(out):
            return out
    raise RuntimeError("Claude gave an unusable answer three times. Try again. Last reply began: " + last[:120])

def wrap(passages, task):
    """Passages first, task last, so a long context never buries the instruction."""
    return f"<passages>\n{passages}\n</passages>\n\n{task}"

def cached(key, fn):
    with lock:
        cache = read_json(CACHE_FILE, {})
    if key in cache:
        return cache[key], True
    val = fn()
    with lock:
        cache = read_json(CACHE_FILE, {})
        cache[key] = val
        write_json(CACHE_FILE, cache)
    return val, False

def chapters_text(lo, hi):
    return "\n\n".join(f"=== {chapter_label(CHAPTERS[i])}: {CHAPTERS[i]['title']} ===\n" + "\n".join(CHAPTERS[i]["p"]) for i in range(lo, hi))

def recap_recent(read_to, count):
    hi = max(0, read_to)                 # finished chapters only (strictly before the current one)
    lo = max(0, hi - count)
    if hi <= lo:
        return "There is nothing before this chapter to recap yet."
    prompt = wrap(chapters_text(lo, hi), (
        f"The passages above are chapters {chapter_label(CHAPTERS[lo])} to {chapter_label(CHAPTERS[hi-1])}. "
        "The reader took a long break and is about to continue. Recap what happened in a few short paragraphs: "
        "where things stand, who is involved (use the names and modifiers as written), what each side wants, and the "
        "loose threads that are still open. Do not go past the last chapter given."
    ))
    key = "recent:" + hashlib.sha1(f"{lo}-{hi}".encode()).hexdigest()
    return cached(key, lambda: run_checked(prompt, "sonnet", 80))[0]

CHUNK = 20
def chunk_summary(c):
    lo, hi = c * CHUNK, min(N, (c + 1) * CHUNK)
    prompt = wrap(chapters_text(lo, hi), (
        f"Summarize the passages above (chapters {chapter_label(CHAPTERS[lo])} to {chapter_label(CHAPTERS[hi-1])}) in 150 to 220 words. "
        "Keep character names, constellation modifiers, scenario names, and the key events and reveals in order."
    ))
    return cached(f"chunk{CHUNK}:{c}", lambda: run_checked(prompt, "haiku", 100))[0]

def story_so_far(read_to):
    hi = max(0, read_to)
    if hi == 0:
        return "You haven't finished a chapter yet, so there is no story so far."
    full, partial_lo = hi // CHUNK, (hi // CHUNK) * CHUNK
    with ThreadPoolExecutor(max_workers=4) as ex:
        parts = list(ex.map(chunk_summary, range(full)))
    tail = ""
    if hi > partial_lo:
        tail_prompt = wrap(chapters_text(partial_lo, hi), (
            f"Summarize the passages above (chapters {chapter_label(CHAPTERS[partial_lo])} to {chapter_label(CHAPTERS[hi-1])}) in 100 to 180 words, "
            "keeping names, modifiers and key events in order."
        ))
        tail = cached(f"tail:{partial_lo}-{hi}", lambda: run_checked(tail_prompt, "haiku", 70))[0]
    notes = "\n\n".join(f"[{chapter_label(CHAPTERS[i*CHUNK])} to {chapter_label(CHAPTERS[min(N,(i+1)*CHUNK)-1])}] {p}" for i, p in enumerate(parts))
    if tail:
        notes += f"\n\n[{chapter_label(CHAPTERS[partial_lo])} to {chapter_label(CHAPTERS[hi-1])}] {tail}"
    prompt = wrap(notes, (
        "The notes above are summaries of the story so far, in order. Write a 'story so far' refresher a reader can absorb in two "
        "minutes: the arc structure, the main players and who is allied or opposed, and what is unresolved right now. "
        "Use names and modifiers as written. About 350 to 450 words, in short paragraphs. Do not add anything not in the notes."
    ))
    return cached("sofar:" + hashlib.sha1(f"{hi}".encode()).hexdigest(), lambda: run_checked(prompt, "sonnet", 200))[0]

def lookup(term, read_to):
    term = re.sub(r"\s+", " ", term).strip()[:80]
    if len(term) < 2:
        return "Select a name or a modifier first."
    pat = re.compile(re.escape(term), re.I)
    hits = []
    for i in range(0, min(read_to, N - 1) + 1):
        ps = CHAPTERS[i]["p"]
        for j, p in enumerate(ps):
            if pat.search(p):
                hits.append((i, j))
    if not hits:
        return f"“{term}” hasn't appeared in the chapters you've read."
    if len(hits) > 22:
        hits = hits[:6] + hits[-16:]
    blocks = []
    for i, j in hits:
        ps = CHAPTERS[i]["p"]
        blocks.append(f"[{chapter_label(CHAPTERS[i])}] " + " ".join(ps[max(0, j - 1): j + 2]))
    prompt = wrap("\n\n".join(blocks), (
        f"The reader highlighted “{term}”. Using ONLY the passages above (all from chapters they have already read), say who or "
        "what it is and what it has done or been shown to do so far, in 2 to 5 sentences. If it is a constellation "
        "modifier, say whether the passages ever tie it to a name; if they do not, say it has not been tied to anyone yet. "
        "If it is a person, mention how they connect to the narrator. Mention the first chapter it appears in."
    ))
    key = "lookup:" + hashlib.sha1(f"{term.lower()}|{read_to}".encode()).hexdigest()
    return cached(key, lambda: run_checked(prompt, "haiku", 15))[0]

def search(q, read_to, limit=40):
    q = q.strip()
    if len(q) < 2:
        return []
    pat = re.compile(re.escape(q), re.I)
    out = []
    for i in range(0, min(read_to, N - 1) + 1):
        c = CHAPTERS[i]
        for p in c["p"]:
            m = pat.search(p)
            if m:
                a, b = max(0, m.start() - 70), min(len(p), m.end() + 90)
                out.append({"i": i, "n": c["n"], "t": c["title"], "snip": ("…" if a else "") + p[a:b] + ("…" if b < len(p) else "")})
                break
        if len(out) >= limit:
            break
    return out

# ---------- http ----------

TOKEN = None

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(APP), **k)

    def log_message(self, *a):
        pass

    def _authed(self):
        if TOKEN is None:
            return True
        q = parse_qs(urlparse(self.path).query)
        if q.get("k", [""])[0] == TOKEN:
            return "set"
        c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        return c.get("orvk") is not None and c["orvk"].value == TOKEN

    def _send(self, code, obj, extra=None):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _state(self):
        return read_json(STATE_FILE, {"readTo": None})

    def do_GET(self):
        a = self._authed()
        if not a:
            return self._send(401, {"error": "Open the full link that includes ?k= from the terminal."})
        u = urlparse(self.path)
        if u.path == "/api/state":
            return self._send(200, self._state())
        if u.path == "/api/index":
            return self._send(200, INDEX)
        if u.path == "/api/entities":
            return self._send(200, ENTITIES)
        if u.path.startswith("/api/chapter/"):
            try:
                return self._send(200, CHAPTERS[int(u.path.rsplit("/", 1)[1])])
            except Exception:
                return self._send(404, {"error": "no such chapter"})
        if u.path == "/api/search":
            st = self._state()
            if st.get("readTo") is None:
                return self._send(200, [])
            q = parse_qs(u.query).get("q", [""])[0]
            return self._send(200, search(q, st["readTo"]))
        if a == "set":  # first visit with ?k=, plant the cookie and drop it from the URL
            self.send_response(302)
            self.send_header("Set-Cookie", f"orvk={TOKEN}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax")
            self.send_header("Location", u.path)
            self.end_headers()
            return
        return super().do_GET()

    def do_PUT(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        if urlparse(self.path).path != "/api/state":
            return self._send(404, {"error": "not found"})
        incoming = self._body()
        with lock:
            st = self._state()
            for k in ("readTo", "pos", "device", "ts", "settings"):
                if k in incoming:
                    st[k] = incoming[k]
            if isinstance(st.get("readTo"), int):
                st["readTo"] = max(0, min(N - 1, st["readTo"]))
            write_json(STATE_FILE, st)
        return self._send(200, st)

    def do_POST(self):
        if not self._authed():
            return self._send(401, {"error": "unauthorized"})
        if urlparse(self.path).path != "/api/ask":
            return self._send(404, {"error": "not found"})
        st = self._state()
        read_to = st.get("readTo")
        if read_to is None:
            return self._send(400, {"error": "Set your place first."})
        b = self._body()
        try:
            kind = b.get("kind")
            if kind == "recap":
                text = recap_recent(read_to, max(1, min(8, int(b.get("count", 3)))))
            elif kind == "sofar":
                text = story_so_far(read_to)
            elif kind == "lookup":
                text = lookup(str(b.get("term", "")), read_to)
            else:
                return self._send(400, {"error": "unknown kind"})
            return self._send(200, {"text": text, "readTo": read_to})
        except subprocess.TimeoutExpired:
            return self._send(504, {"error": "Claude took too long. Try again."})
        except Exception as e:
            return self._send(500, {"error": str(e)})

def main():
    global TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--lan", action="store_true", help="listen on your network so your phone can open it")
    ap.add_argument("--port", type=int, default=8787)
    a = ap.parse_args()
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    if a.lan:
        TOKEN = TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else secrets.token_urlsafe(12)
        TOKEN_FILE.write_text(TOKEN)
    srv = ThreadingHTTPServer((host, a.port), H)
    print(f"ORV Reader: http://127.0.0.1:{a.port}/", flush=True)
    if a.lan:
        try:
            ip = subprocess.run(["ipconfig", "getifaddr", "en0"], capture_output=True, text=True).stdout.strip() or socket.gethostbyname(socket.gethostname())
        except Exception:
            ip = "your-mac-ip"
        print(f"Phone (same Wi-Fi): http://{ip}:{a.port}/?k={TOKEN}", flush=True)
    print(f"{N} chapters loaded. Ctrl+C to stop.", flush=True)
    srv.serve_forever()

if __name__ == "__main__":
    main()
