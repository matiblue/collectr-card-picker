(() => {
  if (window.__cppLoaded) return;
  window.__cppLoaded = true;

  // ---------- storage (chrome.storage when running as an extension, localStorage otherwise) ----------
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get(key) {
      if (hasChrome) return (await chrome.storage.local.get(key))[key];
      try { return JSON.parse(localStorage.getItem(key)); } catch { return undefined; }
    },
    async set(key, val) {
      if (hasChrome) return chrome.storage.local.set({ [key]: val });
      localStorage.setItem(key, JSON.stringify(val));
    },
  };

  // ---------- state ----------
  let items = [];            // want list for this showcase
  let needs = [];            // imported "cards I need" list (global)
  let needsMeta = null;      // { count, importedAt, source }
  let needIndex = new Map(); // normalized number -> [need rows]
  let matches = [];          // needed cards found on this page: [{ key, card, need }]
  let matchSig = '';
  let selectMode = true;
  let includePrices = true;
  let highlightNeeds = true;
  let panelOpen = true;
  let importing = false;
  let importError = '';
  let scanStatus = '';
  let listKey = null;
  let host, root;

  const isShowcase = () => location.pathname.startsWith('/showcase/');
  const sellerHandle = () => (location.pathname.match(/@([^/?#]+)/) || [])[1] || 'seller';
  const keyForPage = () => {
    const col = new URLSearchParams(location.search).get('collection') || 'all';
    return `cpp:${sellerHandle()}:${col}`;
  };

  // ---------- normalisation & matching ----------
  // "070/086" -> "70/86", "SVP 012" -> "svp12"
  const normNum = (s) => String(s ?? '').toLowerCase().replace(/[\s#]/g, '')
    .split('/').map((p) => p.replace(/^([a-z]*)0+(?=\d)/, '$1')).join('/');
  // "Mudkip -  057" -> "mudkip", "Haxorus (Master Ball Pattern)" -> "haxorus", "Flabébé" -> "flabebe"
  const normName = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\s+-\s+\S+$/, '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
  const normSet = (s) => String(s ?? '').toLowerCase().replace(/^(sv|swsh|sm|xy|me)\d*[a-z]?\s*:\s*/, '').replace(/[^a-z0-9]/g, '');

  function buildNeedIndex() {
    needIndex = new Map();
    for (const n of needs) {
      const k = normNum(n.number);
      if (!needIndex.has(k)) needIndex.set(k, []);
      needIndex.get(k).push(n);
    }
  }

  // A Collectr card matches a need when the card number AND the name agree.
  // (Name alone is not enough: e.g. Mega Gengar ex 269/217 vs 284/217 are different cards.)
  function findNeed(card) {
    const cands = needIndex.get(normNum(card.number));
    if (!cands || !card.number) return null;
    const nm = normName(card.name);
    if (!nm) return null;
    const cs = normSet(card.set);
    let best = null;
    for (const n of cands) {
      const nn = normName(n.name);
      if (!nn || !(nn === nm || nm.startsWith(nn) || nn.startsWith(nm))) continue;
      const ns = normSet(n.set);
      if (ns && cs && ns === cs) return n;          // exact set match wins
      if (!best) best = n;
    }
    return best;
  }

  // ---------- parse a Collectr product card ----------
  const MONEY = /^\$[\d,]+(\.\d+)?$/;
  const COND = /^(near mint|lightly played|moderately played|heavily played|damaged|mint|excellent|good|poor)\b|^(psa|bgs|cgc|sgc|tag|ace|beckett|ars)\s*\d/i;

  function parseCard(el) {
    const leaves = [...el.querySelectorAll('*')]
      .filter((e) => e.childElementCount === 0 && !e.closest('a[href*="ebay"]'))
      .map((e) => e.textContent.trim())
      .filter((t) => t && t !== '•');
    const img = el.querySelector('img');
    const setEl = el.querySelector('.underline');
    const name = (img?.alt || '').trim() || leaves[0] || 'Unknown card';
    const set = setEl ? setEl.textContent.trim() : '';
    const price = leaves.find((t) => MONEY.test(t)) || '';
    const qtyTxt = leaves.find((t) => /^Qty:/i.test(t)) || '';
    const qty = parseInt(qtyTxt.replace(/\D/g, ''), 10) || 1;
    // Layout is: name, set, [rarity], [number], condition, variant, price, change, qty
    const setIdx = set ? leaves.indexOf(set) : 0;
    const condIdx = leaves.findIndex((t, i) => i > setIdx && COND.test(t));
    const condition = condIdx >= 0 ? leaves[condIdx] : '';
    const between = condIdx > setIdx ? leaves.slice(setIdx + 1, condIdx) : [];
    let rarity = '', number = '';
    if (between.length >= 2) { rarity = between[0]; number = between[between.length - 1]; }
    else if (between.length === 1) { if (/\d/.test(between[0])) number = between[0]; else rarity = between[0]; }
    let variant = condIdx >= 0 ? leaves[condIdx + 1] || '' : '';
    if (MONEY.test(variant) || /^[-+]\$|^\(|^Qty/i.test(variant)) variant = '';
    const key = [name, set, number, condition, variant, img?.getAttribute('src') || ''].join('|');
    const imgUrl = img?.currentSrc || img?.src || '';
    return sanitize({ key, name, set, rarity, number, condition, variant, price, qty, want: 1, img: imgUrl });
  }

  // Normalise anything parsed from the page or read back from storage.
  const clip = (v, n = 200) => String(v ?? '').slice(0, n);
  function sanitize(it) {
    if (!it || typeof it !== 'object') return null;
    const qty = Math.min(Math.max(parseInt(it.qty, 10) || 1, 1), 999);
    let img = clip(it.img, 2000);
    try { if (new URL(img).protocol !== 'https:') img = ''; } catch { img = ''; }
    return {
      key: clip(it.key, 3000), name: clip(it.name), set: clip(it.set), rarity: clip(it.rarity),
      number: clip(it.number, 40), condition: clip(it.condition, 60), variant: clip(it.variant, 60),
      price: MONEY.test(it.price) ? it.price : '', qty,
      want: Math.min(Math.max(parseInt(it.want, 10) || 1, 1), qty), img,
    };
  }
  function sanitizeNeed(n) {
    if (!n || typeof n !== 'object') return null;
    const name = clip(n.name, 120).trim(), number = clip(n.number, 40).trim();
    if (!name || !number) return null;
    return { name, number, set: clip(n.set, 120).trim(), rarity: clip(n.rarity, 60).trim(), price: clip(n.price, 20).trim() };
  }

  const priceNum = (p) => parseFloat(String(p).replace(/[^\d.]/g, '')) || 0;
  const fmt = (n) => '$' + n.toFixed(2);

  // ---------- import a needs list (pasted from Google Sheets / Excel, or a CSV/TSV file) ----------
  function parseDelimited(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const delim = lines.some((l) => l.includes('\t')) ? '\t' : ',';
    const rows = [];
    let row = [], field = '', q = false;
    const src = lines.join('\n');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) {
        if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"' && field === '') q = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    row.push(field); rows.push(row);
    return rows.map((r) => r.map((f) => f.trim()));
  }

  const HDR = {
    name: /^(card( name)?|name|pokemon|card title)$/i,
    number: /^(card )?(number|no\.?|num|#|card #|collector number)$/i,
    set: /^(set|set name|expansion)$/i,
    owned: /^(owned|have|status|got( it)?|in collection)$/i,
    rarity: /^rarity$/i,
    price: /^(price|market( price)?|value)$/i,
  };
  const OWNED = /^(yes|y|true|x|owned|have|got|coming|✓|✔|1)$/i;

  // Accepts one table, or a whole workbook export with "## Sheet name: X" sections.
  // Header row can be anywhere; rows marked owned/coming in an "Owned" column are skipped.
  function parseNeeds(text) {
    const sections = String(text).split(/^##\s*Sheet name:\s*(.*)$/m);
    let chunks = sections.length > 1
      ? sections.slice(1).reduce((a, v, i, arr) => (i % 2 === 0 ? a.concat([{ title: v.trim(), body: arr[i + 1] || '' }]) : a), [])
      : [{ title: '', body: text }];
    // A workbook with a dedicated "Still Needed" / "Wants" tab: trust that tab only.
    const needTabs = chunks.filter((c) => /need|want|missing/i.test(c.title));
    if (needTabs.length) chunks = needTabs;
    const out = [];
    for (const { title, body } of chunks) {
      const rows = parseDelimited(body);
      let h = -1, cols = null, setTitle = title;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const find = (re) => r.findIndex((c) => re.test(c));
        const ni = find(HDR.name), nu = find(HDR.number);
        if (ni >= 0 && nu >= 0) {
          h = i;
          cols = { name: ni, number: nu, set: find(HDR.set), owned: find(HDR.owned), rarity: find(HDR.rarity), price: find(HDR.price) };
          // Per-set tabs often have the set name as a title line above the header.
          const titleLine = rows.slice(0, i).map((x) => x.filter(Boolean)).find((x) => x.length === 1 && !/progress|tracker|summary/i.test(x[0]));
          if (titleLine) setTitle = titleLine[0];
          break;
        }
      }
      if (h < 0) continue;
      for (const r of rows.slice(h + 1)) {
        const get = (k) => (cols[k] >= 0 ? r[cols[k]] || '' : '');
        if (cols.owned >= 0 && OWNED.test(get('owned'))) continue;
        const n = sanitizeNeed({ name: get('name'), number: get('number'), set: get('set') || (cols.set < 0 ? setTitle : ''), rarity: get('rarity'), price: get('price') });
        if (n) out.push(n);
      }
    }
    const seen = new Set();
    return out.filter((n) => {
      const k = normName(n.name) + '|' + normNum(n.number) + '|' + normSet(n.set);
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, 5000);
  }

  async function importNeeds(text, source) {
    const rows = parseNeeds(text);
    if (!rows.length) {
      importError = "Couldn't find any cards. Include the header row with a card name column and a number column (e.g. Card, Number).";
      render(true); return;
    }
    needs = rows;
    needsMeta = { count: rows.length, importedAt: Date.now(), source: clip(source, 80) };
    await store.set('cpp:needs', { rows: needs, meta: needsMeta });
    importing = false; importError = '';
    buildNeedIndex(); rekeyAll(); render(true);
    toast(`Imported ${rows.length} needed cards`);
  }

  // ---------- page styling ----------
  function injectPageStyle() {
    if (document.getElementById('cpp-page-style')) return;
    const s = document.createElement('style');
    s.id = 'cpp-page-style';
    s.textContent = `
      html.cpp-select .product-card { transition: outline-color .12s; outline: 2px dashed transparent; outline-offset: -2px; }
      html.cpp-select .product-card:hover { outline-color: rgba(16,185,129,.7) !important; }
      html.cpp-need .product-card[data-cpp-need] { position: relative !important; outline: 3px solid #f59e0b !important; outline-offset: -3px !important; background-color: rgba(245,158,11,.10) !important; }
      html.cpp-need .product-card[data-cpp-need]::before {
        content: '★ NEED'; position: absolute; top: 6px; left: 6px; z-index: 5; height: 24px; padding: 0 8px;
        border-radius: 12px; background: #f59e0b; color: #111827; font: 800 12px/24px system-ui, sans-serif; letter-spacing: .3px;
        box-shadow: 0 2px 6px rgba(0,0,0,.4); pointer-events: none;
      }
      .product-card[data-cpp-sel] { position: relative !important; outline: 3px solid #10b981 !important; outline-offset: -3px !important; background-color: rgba(16,185,129,.10) !important; }
      .product-card[data-cpp-sel]::after {
        content: attr(data-cpp-sel); position: absolute; top: 6px; right: 6px; z-index: 5;
        min-width: 26px; height: 26px; padding: 0 6px; box-sizing: border-box; border-radius: 13px;
        background: #10b981; color: #fff; font: 700 14px/26px system-ui, sans-serif; text-align: center;
        box-shadow: 0 2px 6px rgba(0,0,0,.4); pointer-events: none;
      }
      .product-card.cpp-flash { animation: cpp-flash 1.2s ease-out 1; }
      @keyframes cpp-flash { 0%,40% { box-shadow: 0 0 0 6px rgba(245,158,11,.9); } 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); } }`;
    document.head.appendChild(s);
  }

  // Paint selection + need markers, and recompute which needed cards are on the page.
  function paintCards() {
    if (!isShowcase()) return;
    const byKey = new Map(items.map((it) => [it.key, it]));
    const found = new Map();
    document.querySelectorAll('.product-card').forEach((el) => {
      let k = el.dataset.cppKey;
      if (!k) {
        const card = parseCard(el);
        k = card.key; el.dataset.cppKey = k;
        const need = needs.length ? findNeed(card) : null;
        el._cppCard = card; el._cppNeed = need;
      }
      if (!el._cppCard) { el._cppCard = parseCard(el); el._cppNeed = needs.length ? findNeed(el._cppCard) : null; }
      if (el._cppNeed) {
        if (!el.hasAttribute('data-cpp-need')) el.setAttribute('data-cpp-need', '');
        if (!found.has(k)) found.set(k, { key: k, card: el._cppCard, need: el._cppNeed });
      } else if (el.hasAttribute('data-cpp-need')) el.removeAttribute('data-cpp-need');
      const it = byKey.get(k);
      const want = it ? (it.qty > 1 ? `✓ ${it.want}` : '✓') : null;
      if (want) { if (el.getAttribute('data-cpp-sel') !== want) el.setAttribute('data-cpp-sel', want); }
      else if (el.hasAttribute('data-cpp-sel')) el.removeAttribute('data-cpp-sel');
    });
    matches = [...found.values()];
    const sig = matches.map((m) => m.key).join('\n');
    if (sig !== matchSig) {
      matchSig = sig;
      updateBadge();
      if (host) render();
    }
  }

  // React may reuse card nodes for different products when filtering/sorting; re-key on content changes.
  function rekeyAll() {
    document.querySelectorAll('.product-card').forEach((el) => { delete el.dataset.cppKey; el._cppCard = null; el._cppNeed = null; });
    paintCards();
  }

  function updateBadge() {
    if (!hasChrome || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'cpp-badge', count: isShowcase() ? matches.length : 0 }).catch(() => {});
  }

  // ---------- click to toggle ----------
  function onClick(e) {
    if (!e.isTrusted || !selectMode || !isShowcase()) return;
    if (host && e.composedPath().includes(host)) return;
    const card = e.target.closest && e.target.closest('.product-card');
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    toggleItem(parseCard(card));
  }
  function toggleItem(data, forceAdd = false) {
    const i = items.findIndex((it) => it.key === data.key);
    if (i >= 0) { if (!forceAdd) items.splice(i, 1); }
    else items.push(data);
  }

  // ---------- scan: scroll through the showcase so every card loads ----------
  async function scanAll() {
    if (scanStatus.startsWith('Scanning')) return;
    const startY = window.scrollY;
    let prev = -1, same = 0;
    for (let i = 0; i < 60 && same < 2; i++) {
      const n = document.querySelectorAll('.product-card').length;
      scanStatus = `Scanning… ${n} cards loaded`; render(true);
      same = n === prev ? same + 1 : 0; prev = n;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, 1200));
    }
    window.scrollTo(0, startY);
    paintCards();
    scanStatus = `Scanned all ${document.querySelectorAll('.product-card').length} cards`;
    render(true);
  }

  function scrollToCard(key) {
    const el = [...document.querySelectorAll('.product-card')].find((c) => c.dataset.cppKey === key);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('cpp-flash'); void el.offsetWidth; el.classList.add('cpp-flash');
  }

  // ---------- persistence ----------
  async function load() {
    listKey = keyForPage();
    const saved = (await store.get(listKey)) || {};
    items = (Array.isArray(saved.items) ? saved.items : []).map(sanitize).filter(Boolean).slice(0, 1000);
    const nd = (await store.get('cpp:needs')) || {};
    needs = (Array.isArray(nd.rows) ? nd.rows : []).map(sanitizeNeed).filter(Boolean).slice(0, 5000);
    needsMeta = needs.length ? { count: needs.length, importedAt: +nd.meta?.importedAt || 0, source: clip(nd.meta?.source, 80) } : null;
    buildNeedIndex();
    const prefs = (await store.get('cpp:prefs')) || {};
    selectMode = prefs.selectMode ?? true;
    includePrices = prefs.includePrices ?? true;
    highlightNeeds = prefs.highlightNeeds ?? true;
    panelOpen = prefs.panelOpen ?? true;
    scanStatus = '';
    rekeyAll();
    render(true);
  }
  function save() {
    store.set(listKey, { items, updated: Date.now(), url: location.href });
    render(true);
  }
  function savePrefs() {
    store.set('cpp:prefs', { selectMode, includePrices, highlightNeeds, panelOpen });
  }

  // ---------- message text ----------
  function buildMessage() {
    const lines = items.map((it, i) => {
      const bits = [it.name];
      const setLine = [it.set, it.number].filter(Boolean).join(' ');
      if (setLine) bits.push(setLine);
      const cond = [it.condition, it.variant].filter(Boolean).join(', ');
      if (cond) bits.push(cond);
      let line = `${i + 1}. ${bits.join(' — ')}`;
      if (it.want > 1) line += ` (x${it.want})`;
      if (includePrices && it.price) line += ` — ${it.price}${it.want > 1 ? ' ea' : ''}`;
      return line;
    });
    const count = items.reduce((n, it) => n + it.want, 0);
    const total = items.reduce((n, it) => n + priceNum(it.price) * it.want, 0);
    let msg = `Hi! I'm interested in these cards from your Collectr showcase (@${sellerHandle()}):\n\n${lines.join('\n')}\n\n`;
    msg += includePrices ? `${count} card${count === 1 ? '' : 's'} — Collectr market total ${fmt(total)}` : `${count} card${count === 1 ? '' : 's'} total`;
    return msg;
  }

  // ---------- panel UI ----------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; background: #10b981; color: #fff; border: 0;
      border-radius: 999px; padding: 12px 18px; font-weight: 700; font-size: 14px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.45); }
    .fab .nd { background: #f59e0b; color: #111827; border-radius: 999px; padding: 2px 8px; margin-left: 6px; }
    .panel { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; width: 360px; max-height: calc(100vh - 40px);
      display: flex; flex-direction: column; background: #111827; color: #e5e7eb; border: 1px solid #374151; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.6); font-size: 13px; overflow: hidden; }
    header { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #1f2937; }
    header h1 { flex: 1; margin: 0; font-size: 15px; font-weight: 700; color: #fff; }
    header .count { color: #10b981; }
    .icon { background: none; border: 0; color: #9ca3af; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 4px; }
    .icon:hover { color: #fff; }
    .bar { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: #0b1220; gap: 8px; }
    .toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; color: #d1d5db; }
    .sw { width: 34px; height: 18px; border-radius: 9px; background: #374151; position: relative; transition: background .15s; flex: none; }
    .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .15s; }
    .on .sw { background: #10b981; } .on .sw::after { left: 18px; }
    .need .on .sw { background: #f59e0b; }
    .hint { color: #6b7280; font-size: 12px; padding: 10px 14px; }
    ul { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; flex: 1; min-height: 0; }
    li { display: flex; gap: 10px; padding: 8px 14px; align-items: center; border-bottom: 1px solid #1f2937; }
    li img { width: 34px; height: 47px; object-fit: cover; border-radius: 3px; flex: none; background: #1f2937; }
    .info { flex: 1; min-width: 0; }
    .nm { font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: #9ca3af; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .right { text-align: right; flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
    .price { font-weight: 700; color: #fff; }
    .qty { display: flex; align-items: center; gap: 4px; color: #9ca3af; font-size: 11.5px; }
    .qty button { width: 18px; height: 18px; border-radius: 4px; border: 1px solid #374151; background: #1f2937; color: #fff; cursor: pointer; padding: 0; line-height: 1; }
    .rm { color: #6b7280; } .rm:hover { color: #f87171; }
    footer { padding: 12px 14px; border-top: 1px solid #1f2937; display: flex; flex-direction: column; gap: 10px; }
    .total { display: flex; justify-content: space-between; font-weight: 700; color: #fff; }
    .row { display: flex; gap: 8px; }
    .btn { flex: 1; border: 0; border-radius: 8px; padding: 10px; font-weight: 700; cursor: pointer; font-size: 13px; }
    .primary { background: #10b981; color: #fff; } .primary:hover { background: #059669; }
    .primary:disabled { background: #374151; color: #6b7280; cursor: default; }
    .ghost { background: #1f2937; color: #d1d5db; flex: 0 0 auto; padding: 10px 14px; } .ghost:hover { background: #374151; }
    .toast { position: fixed; right: 30px; bottom: 30px; z-index: 2147483647; background: #10b981; color: #fff; padding: 10px 14px; border-radius: 8px; font-weight: 700; }

    .need { border-bottom: 1px solid #1f2937; background: #1a1505; }
    .need-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px 6px; }
    .need-head .t { flex: 1; font-weight: 700; color: #fbbf24; }
    .need-head .t.none { color: #9ca3af; font-weight: 600; }
    .need ul { max-height: 170px; flex: none; padding: 0; }
    .need li { padding: 6px 14px; border-bottom: 1px solid #2a2208; cursor: pointer; }
    .need li:hover { background: #2a2208; }
    .need li img { width: 26px; height: 36px; }
    .need .star { color: #f59e0b; font-weight: 800; }
    .need .in { color: #10b981; font-size: 11px; font-weight: 700; }
    .need-actions { display: flex; gap: 6px; padding: 8px 14px 10px; align-items: center; flex-wrap: wrap; }
    .sbtn { border: 0; border-radius: 7px; padding: 6px 10px; font-weight: 700; font-size: 12px; cursor: pointer; background: #2a2208; color: #fbbf24; }
    .sbtn:hover { background: #3a2f0b; }
    .sbtn.amber { background: #f59e0b; color: #111827; } .sbtn.amber:hover { background: #fbbf24; }
    .sbtn:disabled { opacity: .5; cursor: default; }
    .meta { color: #78716c; font-size: 11px; padding: 0 14px 10px; }
    .meta a { color: #a8a29e; cursor: pointer; text-decoration: underline; }
    .imp { padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 8px; }
    .imp p { margin: 0; color: #a8a29e; font-size: 12px; line-height: 1.4; }
    .imp textarea { width: 100%; height: 110px; resize: vertical; background: #0b1220; color: #e5e7eb; border: 1px solid #374151; border-radius: 8px; padding: 8px; font: 12px ui-monospace, Menlo, monospace; }
    .imp .err { color: #f87171; font-size: 12px; }
    .imp input[type=file] { display: none; }
  `;

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = 'collectr-card-picker';
    root = host.attachShadow({ mode: 'closed' });
    root.addEventListener('click', (e) => { if (e.isTrusted) onPanelClick(e); });
    root.addEventListener('change', (e) => { if (e.isTrusted) onPanelChange(e); });
    document.documentElement.appendChild(host);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function needSection() {
    if (importing) {
      return `<div class="need"><div class="imp">
          <p><b style="color:#fbbf24">Import cards you need.</b> In your spreadsheet, select the rows <i>including the header row</i> (needs a card name column and a number column; Set and Owned columns are used if present, and rows marked owned are skipped), copy, and paste here. Or choose a CSV file.</p>
          <textarea placeholder="Set&#9;Card&#9;Rarity&#9;Number&#9;Price&#10;Paradox Rift&#9;Crustle&#9;Illustration Rare&#9;183/182&#9;5.66"></textarea>
          ${importError ? `<div class="err">${esc(importError)}</div>` : ''}
          <div class="row">
            <button class="sbtn amber" data-act="imp-go">Import</button>
            <label class="sbtn" data-act="imp-file-label">Choose CSV…<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain"></label>
            <span style="flex:1"></span>
            <button class="sbtn" data-act="imp-cancel">Cancel</button>
          </div></div></div>`;
    }
    if (!needs.length) {
      return `<div class="need"><div class="need-head"><span class="t none">★ Highlight cards you need</span>
        <button class="sbtn" data-act="imp-open">Import list</button></div><div class="meta">Paste your “still needed” list from a spreadsheet and matching cards light up.</div></div>`;
    }
    const inList = new Set(items.map((i) => i.key));
    const n = matches.length;
    const missing = matches.filter((m) => !inList.has(m.key)).length;
    const list = n ? `<ul>${matches.map((m) => `
        <li data-act="goto" data-k="${esc(m.key)}">
          ${m.card.img ? `<img src="${esc(m.card.img)}" alt="">` : ''}
          <div class="info"><div class="nm"><span class="star">★</span> ${esc(m.card.name)}</div>
            <div class="sub">${esc([m.card.set, m.card.number].filter(Boolean).join(' · '))}${m.card.condition ? ' · ' + esc(m.card.condition) : ''}</div></div>
          <div class="right"><span class="price">${esc(m.card.price || '—')}</span>${inList.has(m.key) ? '<span class="in">✓ in list</span>' : ''}</div>
        </li>`).join('')}</ul>` : '';
    const when = needsMeta?.importedAt ? new Date(needsMeta.importedAt).toLocaleDateString() : '';
    return `<div class="need">
        <div class="need-head"><span class="t ${n ? '' : 'none'}">${n ? `★ ${n} card${n === 1 ? '' : 's'} you need here` : 'No cards you need found yet'}</span>
          <label class="toggle ${highlightNeeds ? 'on' : ''}" data-act="hl" title="Highlight in grid"><span class="sw"></span></label></div>
        ${list}
        <div class="need-actions">
          ${n ? `<button class="sbtn amber" data-act="add-needs" ${missing ? '' : 'disabled'}>${missing ? `+ Add ${missing} to want list` : 'All in want list'}</button>` : ''}
          <button class="sbtn" data-act="scan" ${scanStatus.startsWith('Scanning') ? 'disabled' : ''}>${esc(scanStatus.startsWith('Scanning') ? scanStatus : 'Scan whole showcase')}</button>
        </div>
        <div class="meta">${scanStatus && !scanStatus.startsWith('Scanning') ? esc(scanStatus) + ' · ' : 'Only cards loaded so far are checked · '}Needs list: ${needs.length} cards${when ? ` (imported ${esc(when)})` : ''} · <a data-act="imp-open">Update</a> · <a data-act="needs-clear">Remove</a></div>
      </div>`;
  }

  function render(force = false) {
    if (!isShowcase()) { if (host) host.remove(); document.documentElement.classList.remove('cpp-select', 'cpp-need'); return; }
    if (importing && !force) return; // don't wipe the textarea while the user is pasting
    ensureHost();
    injectPageStyle();
    document.documentElement.classList.toggle('cpp-select', selectMode);
    document.documentElement.classList.toggle('cpp-need', highlightNeeds && needs.length > 0);

    const count = items.reduce((n, it) => n + it.want, 0);
    const total = items.reduce((n, it) => n + priceNum(it.price) * it.want, 0);

    if (!panelOpen) {
      root.innerHTML = `<style>${CSS}</style><button class="fab" data-act="open">🃏 Want list (${count})${matches.length ? `<span class="nd">★ ${matches.length} needed</span>` : ''}</button>`;
      return;
    }

    const list = items.length
      ? `<ul>${items.map((it, i) => `
          <li>
            ${it.img ? `<img src="${esc(it.img)}" alt="">` : '<img alt="">'}
            <div class="info">
              <div class="nm" title="${esc(it.name)}">${esc(it.name)}</div>
              <div class="sub">${esc([it.set, it.number].filter(Boolean).join(' · '))}</div>
              <div class="sub">${esc([it.condition, it.variant].filter(Boolean).join(' · '))}</div>
            </div>
            <div class="right">
              <span class="price">${esc(it.price || '—')}</span>
              ${it.qty > 1 ? `<span class="qty"><button data-act="dec" data-i="${i}">−</button>${it.want}/${it.qty}<button data-act="inc" data-i="${i}">+</button></span>` : ''}
              <button class="icon rm" data-act="rm" data-i="${i}" title="Remove">✕</button>
            </div>
          </li>`).join('')}</ul>`
      : `<div class="hint">Click any card on the page to add it here. Click it again to remove it.</div>`;

    root.innerHTML = `<style>${CSS}</style>
      <div class="panel">
        <header>
          <h1>Want list <span class="count">(${count})</span></h1>
          <button class="icon" data-act="min" title="Minimize">–</button>
        </header>
        <div class="bar">
          <label class="toggle ${selectMode ? 'on' : ''}" data-act="mode"><span class="sw"></span>Select mode</label>
          <label class="toggle ${includePrices ? 'on' : ''}" data-act="prices"><span class="sw"></span>Include prices</label>
        </div>
        ${needSection()}
        ${list}
        <footer>
          <div class="total"><span>${count} card${count === 1 ? '' : 's'}</span><span>${fmt(total)}</span></div>
          <div class="row">
            <button class="btn primary" data-act="copy" ${items.length ? '' : 'disabled'}>Copy list for seller</button>
            <button class="btn ghost" data-act="clear" ${items.length ? '' : 'disabled'}>Clear</button>
          </div>
        </footer>
      </div>`;
    if (importing) root.querySelector('textarea')?.focus();
  }

  function toast(msg) {
    if (!root) return;
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }
  }

  function onPanelChange(e) {
    const input = e.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.files?.[0]) return;
    const f = input.files[0];
    if (f.size > 5 * 1024 * 1024) { importError = 'That file is too large (max 5 MB).'; render(true); return; }
    f.text().then((txt) => importNeeds(txt, f.name));
  }

  function onPanelClick(e) {
    const btn = e.composedPath().find((n) => n.dataset && n.dataset.act);
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'imp-file-label') return; // let the <label> open the file picker
    e.preventDefault();
    const i = +btn.dataset.i;
    if (['rm', 'inc', 'dec'].includes(act) && !items[i]) return;
    switch (act) {
      case 'open': panelOpen = true; savePrefs(); render(true); break;
      case 'min': panelOpen = false; importing = false; savePrefs(); render(true); break;
      case 'mode': selectMode = !selectMode; savePrefs(); render(true); break;
      case 'prices': includePrices = !includePrices; savePrefs(); render(true); break;
      case 'hl': highlightNeeds = !highlightNeeds; savePrefs(); render(true); break;
      case 'rm': items.splice(i, 1); save(); break;
      case 'inc': items[i].want = Math.min(items[i].qty, items[i].want + 1); save(); break;
      case 'dec': items[i].want = Math.max(1, items[i].want - 1); save(); break;
      case 'clear': if (confirm(`Clear all ${items.length} cards from the list?`)) { items = []; save(); } break;
      case 'copy': copy(buildMessage()).then((ok) => toast(ok ? 'Copied — paste it to the seller' : 'Copy failed')); break;
      case 'imp-open': importing = true; importError = ''; render(true); break;
      case 'imp-cancel': importing = false; importError = ''; render(true); break;
      case 'imp-go': importNeeds(root.querySelector('textarea')?.value || '', 'pasted'); break;
      case 'needs-clear':
        if (confirm('Remove your imported needs list?')) {
          needs = []; needsMeta = null; store.set('cpp:needs', null); buildNeedIndex(); rekeyAll(); render(true);
        }
        break;
      case 'add-needs': matches.forEach((m) => toggleItem(m.card, true)); save(); break;
      case 'goto': scrollToCard(btn.dataset.k); break;
      case 'scan': scanAll(); break;
    }
  }

  // ---------- wiring ----------
  document.addEventListener('click', onClick, true);

  let paintQueued = false;
  let rekeyQueued = false;
  new MutationObserver((muts) => {
    if (muts.some((m) => m.type === 'characterData')) rekeyQueued = true;
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (rekeyQueued) { rekeyQueued = false; rekeyAll(); } else paintCards();
    });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // SPA navigation: reload the list when the showcase/collection changes.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (keyForPage() !== listKey) load(); else render(true);
    rekeyAll();
  }, 500);

  if (hasChrome && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (sender?.id !== chrome.runtime.id) return;
      if (msg?.type === 'cpp-toggle-panel') { panelOpen = !panelOpen; savePrefs(); render(true); }
    });
  }
  // Keep the needs list in sync if it is updated in another tab.
  if (hasChrome && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes['cpp:needs'] && !importing) load();
    });
  }

  // Test hook (only when not running as an extension).
  if (!hasChrome) window.__cppTest = { parseNeeds, findNeed, normNum, normName, buildMessage, get matches() { return matches; } };

  load();
})();
