/* Reader Soundtrack: floating song card + Spotify playback at scene cues.
   Cues come from /api/st/cues for the chapter on screen only. A cue fires once, when its paragraph
   reaches the upper 60% of the screen. Spoiler-sensitive cues keep the card folded until you read past them. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const BEAT_PARAS = 3;          // a held card opens once you are this many paragraphs past its cue

  let ST = null;                 // status from the server (settings, presets, axes)
  let chapter = null, cues = [], tries = 0, pollTimer = null;
  let active = null;             // the cue whose card is showing
  let held = null;               // spoiler-sensitive cue waiting for the reader to pass it
  let revealed = false, panel = null, msg = '';
  let minimized = false;                 // remembered per device: stays folded across cues until opened
  try { minimized = localStorage.getItem('st-folded') === '1'; } catch (e) {}
  const savePref = () => { try { localStorage.setItem('st-folded', minimized ? '1' : '0'); } catch (e) {} };
  const fired = new Set(JSON.parse(sessionStorage.getItem('st-fired-v2') || '[]'));
  const saveFired = () => { try { sessionStorage.setItem('st-fired-v2', JSON.stringify([...fired].slice(-300))); } catch (e) {} };

  async function api(path, opts = {}) {
    const r = await fetch('/api/st/' + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Request failed (' + r.status + ')');
    return j;
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const on = (k) => ST && ST.settings[k];

  /* ---------- cues for the chapter on screen ---------- */
  document.addEventListener('orv:chapter', (e) => { chapter = e.detail.i; cues = []; tries = 0; held = null; load(); });

  async function load() {
    clearTimeout(pollTimer);
    if (!ST) await refresh();
    if (!on('soundtrack_on') || chapter == null) return;
    const want = chapter;
    let j;
    try { j = await api('cues?ch=' + want); } catch (e) { return; }
    if (want !== chapter) return;
    if (j.pending) {                       // precache still working on this chapter
      if (++tries < 40) pollTimer = setTimeout(load, 8000);
      return;
    }
    cues = j.cues;
    pollTimer = setTimeout(load, 45000);   // picks change as the library syncs and tags come in
    if (active) {                          // keep the open card in sync after feedback
      const fresh = cues.find(c => c.key === active.key);
      if (fresh) { active = fresh; render(); }
    }
    check();
  }

  const anchorEl = (c, extra = 0) => {
    const n = parseInt(String(c.anchor).replace(/^p/, ''), 10) + extra;
    return document.querySelector('#chap [data-pi="' + n + '"]') || (extra ? null : document.querySelector('#chap h1'));
  };

  function check() {
    if (!cues.length) return;
    const line = innerHeight * 0.6;
    let cur = null;
    for (const c of cues) {
      const a = anchorEl(c);
      if (a && a.getBoundingClientRect().top < line) cur = c;
    }
    if (cur && !fired.has(cur.key)) fire(cur);
    else if (cur && cur.pick && !active) {   // already played (e.g. after a reload): show its card, don't restart the song
      active = cur; revealed = !on('spoiler_safe_cards'); panel = null; msg = '';
      render();
    }
    if (held) {
      const past = anchorEl(held, BEAT_PARAS) || anchorEl(held);
      if (past && past.getBoundingClientRect().bottom < 0) { held = null; render(); }
    }
  }
  addEventListener('scroll', (() => { let t = false; return () => { if (t) return; t = true; requestAnimationFrame(() => { t = false; check(); }); }; })(), { passive: true });

  function fire(c) {
    if (!c.pick) return;                   // nothing cleared the bar: keep whatever is playing, show no card.
                                           // Not marked fired, so it can still play once tags or the library improve.
    fired.add(c.key); saveFired();
    active = c; revealed = !on('spoiler_safe_cards'); panel = null; msg = '';
    held = c.spoiler_sensitive ? c : null;
    if (on('autoplay')) play();
    render();
  }

  async function play() {
    if (!active || !active.pick) return;
    try {
      const r = await post('play', { id: active.pick.id, loop: active.pick.loop });
      if (r.status === 'no_device') msg = 'no active spotify device. open spotify, then [play].';
      else if (r.status === 'error') msg = 'spotify: ' + r.error.slice(0, 80);
      else msg = r.status === 'playing' ? (r.loop ? 'playing · on loop' : 'playing') : '';
    } catch (e) { msg = e.message; }
    render();
  }

  /* ---------- card ---------- */
  let root = null;
  function render() {
    if (root) root.remove();
    root = null;
    if (!active || !on('soundtrack_on')) return;
    const c = active, p = c.pick;
    if (held === c) {                      // spoiler hold: only a folded chip until the reader passes the beat
      root = el('div', 'st st-chip', '♪ ···');
      root.title = 'Soundtrack card opens once you read past this moment';
      document.body.append(root);
      return;
    }
    if (minimized) {                       // folded by the user: a small tab that opens the card again
      root = el('button', 'st st-chip', '♪ ' + (c.now || 'soundtrack'));
      root.setAttribute('aria-label', 'Open the soundtrack card');
      root.onclick = () => { minimized = false; savePref(); render(); };
      document.body.append(root);
      return;
    }
    root = el('div', 'st st-card');
    root.setAttribute('role', 'status');
    const head = el('div', 'st-head');
    head.append(el('span', '', 'soundtrack · ch.' + (chapterN() || '')));
    const x = el('button', 'x', '–'); x.setAttribute('aria-label', 'Fold the soundtrack card');
    x.title = 'Fold to a small tab';
    x.onclick = () => { minimized = true; panel = null; savePref(); render(); };
    head.append(x);
    root.append(head);

    const row = (k, v) => { const r = el('div', 'st-row'); r.append(el('span', 'k', k + ':'), el('span', '', v)); return r; };
    root.append(row('now', c.now || '—'));
    if (c.trajectory) root.append(row('next', c.trajectory));

    const tr = el('button', 'st-track');
    if (!revealed) {
      tr.append(el('span', 'st-hidden', '> [ tap to show the song ]'));
      tr.onclick = () => { revealed = true; render(); };
    } else {
      tr.append(el('span', '', '> ' + p.name + ' — ' + p.artists.join(', ')));
      const bits = [p.in_library ? 'your library' : 'outside', p.confidence || 'untagged', p.via === 'score' ? 'score ' + p.score.toFixed(1) : p.via];
      tr.append(el('span', 'meta', bits.join(' · ')));
      tr.onclick = () => open('https://open.spotify.com/track/' + p.id, '_blank', 'noopener');
      tr.title = 'Open in Spotify';
    }
    root.append(tr);

    const acts = el('div', 'st-actions');
    const act = (label, fn, key) => { const b = el('button', panel === key ? 'on' : '', label); b.onclick = fn; acts.append(b); };
    act('play', play);
    act('skip', skip);
    act('wrong vibe', () => toggle('vibe'), 'vibe');
    act('fix tag', () => toggle('tag'), 'tag');
    act('pin', () => toggle('pin'), 'pin');
    root.append(acts);

    if (panel) root.append(buildPanel());
    if (msg) root.append(el('div', 'st-msg', msg));
    document.body.append(root);
  }
  const chapterN = () => { const t = $('#chap .ep'); const m = t && t.textContent.match(/Chapter (\d+)/); return m ? m[1] : ''; };
  const toggle = (k) => { panel = panel === k ? null : k; msg = ''; render(); };

  let vibe = { target: 'track', axis: null };
  function buildPanel() {
    const box = el('div', 'st-panel');
    const opts = (items, cur, fn) => { const d = el('div', 'opts'); items.forEach(([v, label]) => { const b = el('button', v === cur ? 'on' : '', label); b.onclick = () => fn(v); d.append(b); }); return d; };
    if (panel === 'vibe') {
      box.append(el('div', 'st-msg', 'what was off?'));
      box.append(opts([['track', 'the song'], ['scene', 'the scene tag']], vibe.target, v => { vibe.target = v; render(); }));
      box.append(opts(ST.axes.map(a => [a, a]), vibe.axis, v => { vibe.axis = v; render(); }));
      if (vibe.axis) box.append(opts([['too_high', vibe.axis + ' too high'], ['too_low', vibe.axis + ' too low']], null, d =>
        send({ type: 'wrong_vibe', spotify_id: active.pick.id, cue_anchor: active.key, axis: vibe.axis, target: vibe.target, direction: d }, 'noted. retuned.')));
    } else if (panel === 'tag') {
      box.append(el('div', 'st-msg', 'this song is actually:'));
      box.append(opts(ST.presets.map(p => [p, p]), null, p =>
        send({ type: 'tag_correction', spotify_id: active.pick.id, preset: p }, 'tag fixed: ' + p + '. this overrides everything for this song.')));
    } else if (panel === 'pin') {
      box.append(opts([['this', 'pin this song here'], ['now', "pin what's playing"]], null, async v => {
        if (v === 'this') return send({ type: 'pin', spotify_id: active.pick.id, cue_anchor: active.key }, 'pinned.');
        try { const r = await post('pin-now', { key: active.key }); msg = 'pinned: ' + r.track.name; panel = null; await load(); render(); }
        catch (e) { msg = e.message; render(); }
      }));
    }
    return box;
  }

  async function send(fb, done) {
    try { await post('feedback', fb); msg = done; panel = null; vibe.axis = null; await load(); }
    catch (e) { msg = e.message; }
    render();
  }

  async function skip() {
    const c = active, old = c.pick.id;
    try { await post('feedback', { type: 'skip', spotify_id: old, cue_anchor: c.key }); } catch (e) { msg = e.message; render(); return; }
    await load();
    if (active && active.pick && active.pick.id !== old) { msg = ''; await play(); }
    else { msg = 'nothing else clears the bar here. keeping quiet.'; if (active) active.pick = null; active = null; render(); }
  }

  /* ---------- settings (inside the Aa popover) ---------- */
  function settingsUI() {
    const pop = $('#settings');
    let box = $('#st-settings');
    if (!box) { box = el('div', 'st st-settings'); box.id = 'st-settings'; pop.append(box); }
    box.replaceChildren(el('div', 't', '// soundtrack'));
    const row = (label, key, a, b) => {
      const r = el('div', 'r'); r.append(el('span', '', label));
      const seg = el('span');
      [[true, a], [false, b]].forEach(([v, t]) => {
        const btn = el('button', ST.settings[key] === v ? 'on' : '', t);
        btn.onclick = async (e) => { e.stopPropagation(); ST.settings = await api('settings', { method: 'PUT', body: JSON.stringify({ [key]: v }) }); settingsUI(); load(); render(); };
        seg.append(btn, document.createTextNode(' '));
      });
      r.append(seg); box.append(r);
    };
    row('music', 'soundtrack_on', 'on', 'off');
    row('mode', 'commentary_mode', 'commentary', 'in-world');
    row('autoplay', 'autoplay', 'on', 'off');
    row('loop song', 'loop_song', 'on', 'off');
    row('song name', 'spoiler_safe_cards', 'on tap', 'shown');
    const s = el('div', 'status');
    const sp = ST.spotify;
    const conf = Object.entries(ST.by_confidence).map(([k, v]) => k + ' ' + v).join(', ');
    s.append('spotify: ' + (sp.connected ? 'connected' : sp.configured ? 'not connected ' : 'not set up (see soundtrack/README.md)'));
    if (sp.configured && !sp.connected) { const a = el('a', '', '[connect]'); a.href = '/api/st/login'; s.append(a); }
    s.append('\ntracks: ' + ST.tracks + ' · tagged ' + ST.tagged + (conf ? ' (' + conf + ')' : ''));
    s.append('\nlast.fm: ' + (ST.lastfm ? 'on' : 'off') + ' · cued chapters: ' + ST.cued_chapters);
    if (ST.precaching != null) s.append('\nreading ahead: ch.' + (ST.precaching + 1));
    if (ST.sync.running) s.append('\nsyncing… ' + ST.sync.log.join(' · '));
    else if (ST.sync.log.length) s.append('\nlast sync: ' + ST.sync.log.join(' · '));
    if (ST.errors.length) s.append('\nerror: ' + ST.errors[ST.errors.length - 1]);
    if (sp.connected && !ST.sync.running) {
      const b = el('button', 'link', '[sync library]');
      b.onclick = async (e) => { e.stopPropagation(); try { await post('sync', {}); } catch (err) {} refresh(); };
      s.append('\n', b);
    }
    box.append(s);
  }

  async function refresh() {
    try { ST = await api('status'); } catch (e) { return; }
    settingsUI();
  }
  $('#aa').addEventListener('click', refresh);
  refresh().then(() => { if (chapter != null) load(); });
})();
