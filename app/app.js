(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  let INDEX = [];
  let S = { readTo: null, pos: null };
  let cur = 0;
  let lastWrite = 0;
  const chCache = new Map();
  const askCache = new Map();
  const device = /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'iPhone' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'Browser';

  /* ---------- preferences (per device) ---------- */
  const prefs = { theme: 'auto', size: 1.125, font: 'serif', hl: 'on' };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('orv-prefs') || '{}')); } catch (e) {}
  const savePrefs = () => { try { localStorage.setItem('orv-prefs', JSON.stringify(prefs)); } catch (e) {} };
  const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  const effectiveTheme = () => (prefs.theme === 'auto' ? (systemDark() ? 'dark' : 'light') : prefs.theme);

  function applyPrefs() {
    const r = document.documentElement;
    if (prefs.theme === 'auto') r.removeAttribute('data-theme'); else r.dataset.theme = prefs.theme;
    r.dataset.font = prefs.font;
    r.dataset.hl = prefs.hl;
    r.style.setProperty('--size', prefs.size + 'rem');
    const dark = effectiveTheme() === 'dark';
    $('#theme').textContent = dark ? '☀' : '☾';
    $('#theme').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    $$('#seg-theme button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.theme));
    $$('#seg-font button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.font));
    $$('#seg-hl button').forEach(b => b.classList.toggle('on', b.dataset.v === prefs.hl));
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyPrefs);

  $('#theme').onclick = () => { prefs.theme = effectiveTheme() === 'dark' ? 'light' : 'dark'; savePrefs(); applyPrefs(); };
  $('#bigger').onclick = () => { prefs.size = Math.min(1.6, +(prefs.size + 0.0625).toFixed(4)); savePrefs(); applyPrefs(); };
  $('#smaller').onclick = () => { prefs.size = Math.max(0.9, +(prefs.size - 0.0625).toFixed(4)); savePrefs(); applyPrefs(); };
  $$('#seg-theme button').forEach(b => b.onclick = () => { prefs.theme = b.dataset.v; savePrefs(); applyPrefs(); });
  $$('#seg-font button').forEach(b => b.onclick = () => { prefs.font = b.dataset.v; savePrefs(); applyPrefs(); });
  $$('#seg-hl button').forEach(b => b.onclick = () => { prefs.hl = b.dataset.v; savePrefs(); applyPrefs(); });
  $('#aa').onclick = (e) => {
    e.stopPropagation();
    const open = $('#settings').hidden;
    $('#settings').hidden = !open;
    $('#aa').setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('click', (e) => {
    if (!$('#settings').hidden && !e.target.closest('#settings')) { $('#settings').hidden = true; $('#aa').setAttribute('aria-expanded', 'false'); }
  });

  /* ---------- server ---------- */
  async function api(path, opts) {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Request failed (' + r.status + ')');
    return j;
  }
  function putState(patch, keepalive) {
    Object.assign(S, patch);
    lastWrite = Date.now();
    return fetch('/api/state', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, keepalive: !!keepalive,
      body: JSON.stringify({ ...patch, device, ts: lastWrite }),
    }).catch(() => {});
  }
  let saveTimer;
  const queuePos = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => putState({ pos: { ch: cur, frac: fracNow() } }), 700); };
  addEventListener('pagehide', () => putState({ pos: { ch: cur, frac: fracNow() } }, true));

  /* ---------- helpers ---------- */
  const chNum = (i) => (INDEX[i] ? INDEX[i].n : i + 1);
  function fracNow() {
    const h = document.documentElement.scrollHeight - innerHeight;
    return h > 0 ? Math.min(1, Math.max(0, scrollY / h)) : 0;
  }
  async function getChapter(i) {
    if (chCache.has(i)) return chCache.get(i);
    const c = await api('/api/chapter/' + i);
    chCache.set(i, c);
    if (chCache.size > 12) chCache.delete(chCache.keys().next().value);
    return c;
  }
  const isSys = (t) => /^\[[\s\S]*\]$/.test(t);
  const isStar = (t) => /constellation/i.test(t);

  function renderBody(c) {
    const frag = document.createDocumentFragment();
    let group = null;
    const flush = () => {
      if (!group) return;
      const box = document.createElement('div');
      box.className = 'sysmsg' + (group.star ? ' star' : '');
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = group.star ? 'Constellation' : 'System';
      box.append(lbl);
      group.lines.forEach(([t, j]) => { const d = document.createElement('div'); d.textContent = t; d.dataset.pi = j; box.append(d); });
      frag.append(box);
      group = null;
    };
    c.p.forEach((t, j) => {
      if (isSys(t)) {
        group = group || { lines: [], star: false };
        group.lines.push([t, j]);
        if (isStar(t)) group.star = true;
      } else {
        flush();
        const p = document.createElement('p');
        p.textContent = t;
        p.dataset.pi = j;
        frag.append(p);
      }
    });
    flush();
    return frag;
  }

  function highlight(find) {
    const q = find.toLowerCase();
    let first = null;
    $$('#chap p, #chap .sysmsg div').forEach(el => {
      const t = el.textContent;
      const idx = t.toLowerCase().indexOf(q);
      if (idx < 0) return;
      const m = document.createElement('mark');
      m.textContent = t.slice(idx, idx + find.length);
      el.replaceChildren(t.slice(0, idx), m, t.slice(idx + find.length));
      first = first || m;
    });
    return first;
  }

  /* ---------- names: constellations, nebulae, items, places ---------- */
  const ENT_LABEL = { constellation: 'Constellation', nebula: 'Nebula', item: 'Item', place: 'Place' };
  let ENT = new Map(), ENT_RE = null;
  function buildEntities(list) {
    ENT = new Map(list.map(e => [e.n, e.c]));
    const names = [...ENT.keys()].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    ENT_RE = names.length ? new RegExp('(?<![\\w])(?:' + names.join('|') + ')(?![\\w])', 'g') : null;
  }
  function applyEntities(root) {
    if (!ENT_RE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement.closest('.ent, h1, .ep, .lbl') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const tn of nodes) {
      const t = tn.nodeValue;
      ENT_RE.lastIndex = 0;
      let m, last = 0, frag = null;
      while ((m = ENT_RE.exec(t))) {
        frag = frag || document.createDocumentFragment();
        if (m.index > last) frag.append(t.slice(last, m.index));
        const cat = ENT.get(m[0]);
        const s = document.createElement('span');
        s.className = 'ent e-' + cat;
        s.textContent = m[0];
        s.title = ENT_LABEL[cat] + ' · tap to look up';
        s.dataset.term = m[0];
        frag.append(s);
        last = m.index + m[0].length;
      }
      if (frag) { if (last < t.length) frag.append(t.slice(last)); tn.replaceWith(frag); }
    }
  }

  /* ---------- navigation ---------- */
  function paint(c, find) {
    const art = $('#chap');
    const h1 = document.createElement('h1');
    h1.textContent = c.title;
    const ep = document.createElement('div');
    ep.className = 'ep';
    ep.textContent = 'Chapter ' + c.n + ' of ' + INDEX.length;
    art.replaceChildren(h1, ep, renderBody(c));
    const mark = find ? highlight(find) : null;
    applyEntities(art);
    return mark;
  }
  async function goTo(i, { frac = 0, find = null } = {}) {
    i = Math.max(0, Math.min(INDEX.length - 1, i));
    let c;
    try { c = await getChapter(i); } catch (e) { toast(e.message); return; }
    cur = i;
    document.title = 'Ch. ' + chNum(i) + ' · ORV Reader';
    updateChrome();
    closeSheet();
    window.scrollTo(0, 0);
    const mark = paint(c, find);
    requestAnimationFrame(() => {
      if (mark) mark.scrollIntoView({ block: 'center' });
      else if (frac > 0) scrollTo(0, frac * (document.documentElement.scrollHeight - innerHeight));
      updateProg();
    });
    getChapter(i + 1).catch(() => {});
    putState({ pos: { ch: cur, frac } });
    document.dispatchEvent(new CustomEvent('orv:chapter', { detail: { i, n: c.n } }));
  }

  async function next() {
    if (cur >= INDEX.length - 1) return;
    if (cur === S.readTo) await putState({ readTo: cur + 1 });
    goTo(cur + 1);
  }
  $('#next').onclick = next;
  $('#prev').onclick = () => goTo(cur - 1);

  function updateProg() {
    $('#prog').style.width = (((cur + fracNow()) / INDEX.length) * 100).toFixed(2) + '%';
  }
  addEventListener('scroll', (() => {
    let t = false;
    return () => { if (t) return; t = true; requestAnimationFrame(() => { t = false; updateProg(); queuePos(); }); };
  })(), { passive: true });

  function updateChrome() {
    const e = INDEX[cur];
    $('#w-title').textContent = e.t;
    $('#w-sub').textContent = 'Chapter ' + e.n + ' of ' + INDEX.length + (cur === S.readTo ? '' : ' · your place: ch. ' + chNum(S.readTo));
    $('#prev').disabled = cur === 0;
    $('#next').disabled = cur >= INDEX.length - 1;

    const place = $('#place');
    place.replaceChildren();
    if (cur > S.readTo) {
      place.append('This chapter is ahead of your place (ch. ' + chNum(S.readTo) + '). Search and lookups stay at your place.');
      const b = document.createElement('button');
      b.textContent = 'Move my place here';
      b.onclick = () => { putState({ readTo: cur }); updateChrome(); };
      place.append(b);
      place.hidden = false;
    } else if (cur < S.readTo) {
      place.append('Rereading. Your place is ch. ' + chNum(S.readTo) + '.');
      const b = document.createElement('button');
      b.textContent = 'Back to my place';
      b.onclick = () => goTo(S.readTo);
      const m = document.createElement('button');
      m.textContent = 'Make this my place';
      m.onclick = () => { putState({ readTo: cur }); askCache.clear(); updateChrome(); };
      place.append(b, m);
      place.hidden = false;
    } else {
      place.hidden = true;
    }

    const showRecap = cur === S.readTo && S.readTo > 0;
    $('#recap').hidden = !showRecap;
    if (showRecap) {
      $('#recap-sub').textContent = 'Covers up to the end of ch. ' + chNum(S.readTo - 1);
      if (!$('#recap').dataset.for || +$('#recap').dataset.for !== S.readTo) { $('#recap-out').replaceChildren(); $('#recap').dataset.for = S.readTo; }
    }
    markList();
  }

  /* ---------- catch me up ---------- */
  function showText(el, text) {
    el.replaceChildren();
    String(text).split(/\n{2,}/).forEach(t => { const p = document.createElement('p'); p.textContent = t.trim(); if (p.textContent) el.append(p); });
  }
  async function ask(body, el, busy) {
    const key = JSON.stringify(body) + '|' + S.readTo;
    if (askCache.has(key)) { showText(el, askCache.get(key)); return; }
    el.innerHTML = '';
    const b = document.createElement('div');
    b.className = 'busy';
    b.textContent = busy;
    el.append(b);
    try {
      const j = await api('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      askCache.set(key, j.text);
      showText(el, j.text);
    } catch (e) {
      el.replaceChildren();
      const d = document.createElement('div');
      d.className = 'err busy';
      d.textContent = e.message;
      el.append(d);
    }
  }
  $$('#recap [data-k]').forEach(btn => btn.onclick = async () => {
    const all = $$('#recap [data-k]');
    all.forEach(b => b.disabled = true);
    const body = btn.dataset.k === 'recap' ? { kind: 'recap', count: +btn.dataset.c } : { kind: 'sofar' };
    const busy = btn.dataset.k === 'sofar'
      ? 'Summarizing everything up to your place. The first time takes a minute or two, then it is saved.'
      : 'Reading your last chapters…';
    await ask(body, $('#recap-out'), busy);
    all.forEach(b => b.disabled = false);
  });
  $('#recap-hide').onclick = () => { $('#recap').hidden = true; };

  /* ---------- lookup ---------- */
  const pill = $('#pill'), sheet = $('#sheet');
  function closeSheet() { sheet.hidden = true; }
  $('#s-close').onclick = closeSheet;
  function updatePill() {
    const sel = getSelection();
    const t = sel && sel.rangeCount ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    const ok = t.length >= 2 && t.length <= 60 && t.split(' ').length <= 7 && sel.anchorNode && $('#chap').contains(sel.anchorNode);
    if (ok && sheet.hidden) { pill.textContent = 'Look up “' + t + '”'; pill.dataset.term = t; pill.hidden = false; }
    else pill.hidden = true;
  }
  let selTimer;
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(updatePill, 180); });
  pill.addEventListener('pointerdown', e => e.preventDefault());
  pill.addEventListener('mousedown', e => e.preventDefault());
  async function openLookup(term) {
    pill.hidden = true;
    $('#s-name').textContent = term;
    $('#s-gate').textContent = 'Built only from chapters up to ch. ' + chNum(S.readTo) + '. Nothing past that.';
    sheet.hidden = false;
    await ask({ kind: 'lookup', term }, $('#s-body'), 'Checking what you have read about this…');
  }
  pill.onclick = () => openLookup(pill.dataset.term);
  $('#chap').addEventListener('click', e => {
    const el = e.target.closest('.ent');
    if (!el || prefs.hl === 'off') return;
    if (getSelection().toString().trim()) return;   // user is selecting text, not tapping a name
    openLookup(el.dataset.term);
  });

  /* ---------- drawer: chapters + search ---------- */
  const drawer = $('#drawer'), backdrop = $('#backdrop');
  function openDrawer(tab) {
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); backdrop.hidden = false;
    setTab(tab || 'chapters');
    const el = $('#chlist .cur');
    if (el) el.scrollIntoView({ block: 'center' });
  }
  function closeDrawer() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); backdrop.hidden = true; }
  function setTab(t) {
    $$('.tabs [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $('#tab-chapters').hidden = t !== 'chapters';
    $('#tab-search').hidden = t !== 'search';
    if (t === 'search') { $('#q-note').textContent = 'Searches chapters 1 to ' + chNum(S.readTo) + ' only, so nothing gets spoiled.'; $('#q').focus(); }
  }
  $('#menu').onclick = () => openDrawer();
  $('#drawer-close').onclick = closeDrawer;
  backdrop.onclick = closeDrawer;
  $$('.tabs [data-tab]').forEach(b => b.onclick = () => setTab(b.dataset.tab));

  function buildList() {
    const frag = document.createDocumentFragment();
    INDEX.forEach(e => {
      const b = document.createElement('button');
      b.dataset.i = e.i;
      b.dataset.s = (e.n + ' ' + e.t).toLowerCase();
      const n = document.createElement('span'); n.className = 'n'; n.textContent = e.n;
      b.append(n, e.t);
      b.onclick = () => { closeDrawer(); goTo(e.i); };
      frag.append(b);
    });
    $('#chlist').replaceChildren(frag);
  }
  function markList() {
    $$('#chlist button').forEach(b => {
      const i = +b.dataset.i;
      b.classList.toggle('cur', i === cur);
      const old = b.querySelector('.here'); if (old) old.remove();
      if (i === S.readTo) { const h = document.createElement('span'); h.className = 'here'; h.textContent = 'your place'; b.append(h); }
    });
  }
  $('#filter').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    $$('#chlist button').forEach(b => { b.hidden = q && !b.dataset.s.includes(q); });
  });

  let qTimer;
  $('#q').addEventListener('input', e => {
    clearTimeout(qTimer);
    const q = e.target.value.trim();
    qTimer = setTimeout(async () => {
      const out = $('#q-out');
      if (q.length < 2) { out.replaceChildren(); return; }
      try {
        const res = await api('/api/search?q=' + encodeURIComponent(q));
        const frag = document.createDocumentFragment();
        if (!res.length) { const d = document.createElement('div'); d.className = 'note-sm'; d.textContent = 'No matches in what you have read.'; frag.append(d); }
        res.forEach(r => {
          const b = document.createElement('button');
          const n = document.createElement('span'); n.className = 'n'; n.textContent = r.n;
          const s = document.createElement('span'); s.className = 'snip'; s.textContent = r.snip;
          b.append(n, r.t, s);
          b.onclick = () => { closeDrawer(); goTo(r.i, { find: q }); };
          frag.append(b);
        });
        out.replaceChildren(frag);
      } catch (err) { out.textContent = err.message; }
    }, 300);
  });

  /* ---------- toast + cross-device sync ---------- */
  let toastTimer;
  function toast(msg, label, fn) {
    const t = $('#toast');
    t.replaceChildren(msg);
    if (label) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { t.hidden = true; fn(); }; t.append(b); }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, label ? 12000 : 4000);
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || S.readTo == null) return;
    try {
      const st = await api('/api/state');
      if (st.readTo != null && st.readTo !== S.readTo) { S.readTo = st.readTo; updateChrome(); }
      if (st.device && st.device !== device && st.ts > lastWrite && st.pos &&
          (st.pos.ch !== cur || Math.abs(st.pos.frac - fracNow()) > 0.03)) {
        toast(st.device + ' is at ch. ' + chNum(st.pos.ch) + '.', 'Jump there', () => goTo(st.pos.ch, { frac: st.pos.frac }));
      }
    } catch (e) {}
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSheet(); closeDrawer(); $('#settings').hidden = true; }
  });

  /* ---------- first run + boot ---------- */
  $('#onboard-form').addEventListener('submit', e => {
    e.preventDefault();
    const n = +$('#start-ch').value;
    let idx = INDEX.findIndex(x => x.n === n);
    if (idx < 0) idx = Math.max(0, Math.min(INDEX.length - 1, n - 1));
    startAt(idx);
  });
  $('#from-start').onclick = () => startAt(0);
  async function startAt(idx) {
    await putState({ readTo: idx, pos: { ch: idx, frac: 0 } });
    $('#onboard').hidden = true;
    goTo(idx);
  }

  async function boot() {
    applyPrefs();
    try {
      const [idx, st, ents] = await Promise.all([api('/api/index'), api('/api/state'), api('/api/entities').catch(() => [])]);
      INDEX = idx; S = Object.assign(S, st);
      buildEntities(ents);
    } catch (e) {
      document.body.textContent = 'Could not reach the reader server: ' + e.message;
      return;
    }
    buildList();
    if (S.readTo == null) { $('#onboard').hidden = false; return; }
    const p = S.pos || { ch: S.readTo, frac: 0 };
    goTo(p.ch, { frac: p.frac || 0 });
  }
  boot();
})();
