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
    async keys() {
      if (hasChrome) return Object.keys(await chrome.storage.local.get(null));
      return Object.keys(localStorage);
    },
    async remove(keys) {
      if (hasChrome) return chrome.storage.local.remove(keys);
      keys.forEach((k) => localStorage.removeItem(k));
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
  let menuOpen = false;
  let tab = 'want';          // 'want' | 'need'
  let importError = '';
  let scanStatus = '';
  let listKey = null;
  let host, root;

  const isShowcase = () => location.pathname.startsWith('/showcase/');
  const sellerHandle = () => (location.pathname.match(/@([^/?#]+)/) || [])[1] || 'seller';
  // One want list per seller, shared across all of their portfolios (?collection=…),
  // since that is what gets sent to them. Handles are case-insensitive on Collectr.
  const keyForPage = () => `cpp:list:${decodeURIComponent(sellerHandle()).toLowerCase()}`;

  // Before v1.1.4 lists were stored per portfolio as "cpp:<handle>:<collection|all>".
  // Merge any of those for this seller into the per-seller list, then delete them.
  async function migrateLegacyLists(key, current) {
    const handle = key.slice('cpp:list:'.length);
    const legacy = (await store.keys()).filter((k) => {
      const m = k.match(/^cpp:([^:]+):[^:]+$/);
      return m && m[1] !== 'list' && decodeURIComponent(m[1]).toLowerCase() === handle;
    });
    if (!legacy.length) return current;
    const merged = [...current];
    for (const k of legacy) {
      const old = (await store.get(k)) || {};
      for (const it of Array.isArray(old.items) ? old.items : []) {
        const clean = sanitize(it);
        if (clean && !merged.some((x) => x.key === clean.key)) merged.push(clean);
      }
    }
    await store.set(key, { items: merged.slice(0, 1000), updated: Date.now(), url: location.href });
    await store.remove(legacy);
    return merged.slice(0, 1000);
  }

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
      if (ns && cs) {
        if (ns === cs) return n;                                   // exact set match wins
        if (!ns.includes(cs) && !cs.includes(ns)) continue;        // e.g. Vanillish 190/182 Paradox Rift vs Holiday Calendar
      }
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
    importing = false; importError = ''; tab = 'need';
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
      /* selected must win over the gold 'need' style (same or higher specificity, declared later) */
      html .product-card[data-cpp-sel], html.cpp-need .product-card[data-cpp-need][data-cpp-sel] { position: relative !important; outline: 3px solid #10b981 !important; outline-offset: -3px !important; background-color: rgba(16,185,129,.10) !important; }
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
    save();
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
    items = await migrateLegacyLists(listKey, items);
    const nd = (await store.get('cpp:needs')) || {};
    needs = (Array.isArray(nd.rows) ? nd.rows : []).map(sanitizeNeed).filter(Boolean).slice(0, 5000);
    needsMeta = needs.length ? { count: needs.length, importedAt: +nd.meta?.importedAt || 0, source: clip(nd.meta?.source, 80) } : null;
    buildNeedIndex();
    const prefs = (await store.get('cpp:prefs')) || {};
    selectMode = prefs.selectMode ?? true;
    includePrices = prefs.includePrices ?? true;
    highlightNeeds = prefs.highlightNeeds ?? true;
    panelOpen = prefs.panelOpen ?? true;
    tab = prefs.tab === 'need' ? 'need' : 'want';
    scanStatus = '';
    rekeyAll();
    render(true);
  }
  function save() {
    store.set(listKey, { items, updated: Date.now(), url: location.href });
    paintCards();   // update the ✓ markers in the grid right away
    render(true);
  }
  function savePrefs() {
    store.set('cpp:prefs', { selectMode, includePrices, highlightNeeds, panelOpen, tab });
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
  const COND_SHORT = { 'near mint': 'NM', 'lightly played': 'LP', 'moderately played': 'MP', 'heavily played': 'HP', damaged: 'DMG' };
  const shortCond = (c) => COND_SHORT[String(c).toLowerCase()] || c;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    button { font: inherit; }
    .fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483646; background: #10b981; color: #fff; border: 0;
      border-radius: 999px; padding: 11px 16px; font-weight: 700; font-size: 14px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.45); }
    .fab .nd { background: #f59e0b; color: #111827; border-radius: 999px; padding: 2px 8px; margin-left: 6px; }
    .panel { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; width: 340px; max-height: min(620px, calc(100vh - 40px));
      display: flex; flex-direction: column; background: #111827; color: #e5e7eb; border: 1px solid #2b3445; border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0,0,0,.6); font-size: 13px; overflow: hidden; }
    header { display: flex; align-items: center; gap: 4px; padding: 10px 10px 8px 14px; }
    header h1 { flex: 1; margin: 0; font-size: 14px; font-weight: 700; color: #fff; }
    .icon { background: none; border: 0; color: #9ca3af; cursor: pointer; font-size: 16px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
    .icon:hover, .icon.on { color: #fff; background: #1f2937; }
    .tabs { display: flex; gap: 4px; margin: 0 10px 8px; padding: 3px; background: #0b1220; border-radius: 9px; }
    .tabs button { flex: 1; border: 0; background: none; color: #9ca3af; padding: 7px 8px; border-radius: 7px; font-weight: 600; cursor: pointer; font-size: 13px; }
    .tabs button.on { background: #1f2937; color: #fff; }
    .tabs b { display: inline-block; min-width: 20px; margin-left: 4px; padding: 0 6px; border-radius: 9px; background: #374151; color: #fff; font-size: 11px; line-height: 18px; }
    .tabs .need-tab b { background: #f59e0b; color: #111827; }
    .tabs .need-tab b.zero { background: #374151; color: #9ca3af; }
    .notice { margin: 0 10px 8px; padding: 7px 10px; border-radius: 8px; background: #1f2937; color: #d1d5db; font-size: 12px; display: flex; align-items: center; gap: 8px; }
    .notice span { flex: 1; }
    .link { background: none; border: 0; color: #10b981; font-weight: 700; cursor: pointer; padding: 0; font-size: 12px; }
    ul { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; min-height: 60px; border-top: 1px solid #1f2937; }
    li { display: flex; gap: 10px; padding: 7px 10px 7px 12px; align-items: center; border-bottom: 1px solid #1a2130; }
    li.go { cursor: pointer; } li.go:hover { background: #161e2c; }
    li img { width: 28px; height: 39px; object-fit: cover; border-radius: 3px; flex: none; background: #1f2937; }
    .info { flex: 1; min-width: 0; }
    .nm { font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: #8b95a7; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
    .star { color: #f59e0b; }
    .right { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
    .price { font-weight: 700; color: #fff; font-size: 13px; }
    .qty { display: flex; align-items: center; gap: 4px; color: #9ca3af; font-size: 11px; }
    .qty button { width: 17px; height: 17px; border-radius: 4px; border: 1px solid #374151; background: #1f2937; color: #fff; cursor: pointer; padding: 0; line-height: 1; font-size: 12px; }
    .x { flex: none; width: 26px; height: 26px; border: 0; border-radius: 6px; background: none; color: #6b7280; cursor: pointer; font-size: 13px; }
    .x:hover { background: #1f2937; color: #f87171; }
    .add { flex: none; width: 28px; height: 28px; border: 0; border-radius: 7px; background: #f59e0b; color: #111827; font-weight: 800; font-size: 16px; cursor: pointer; }
    .add.in { background: #10b981; color: #fff; font-size: 14px; }
    .empty { padding: 22px 18px; text-align: center; color: #8b95a7; font-size: 12.5px; line-height: 1.5; border-top: 1px solid #1f2937; }
    .empty b { display: block; color: #e5e7eb; font-size: 13.5px; margin-bottom: 4px; }
    footer { padding: 10px; border-top: 1px solid #1f2937; display: flex; flex-direction: column; gap: 8px; }
    .total { display: flex; justify-content: space-between; font-weight: 700; color: #fff; padding: 0 2px; }
    .row { display: flex; gap: 8px; align-items: center; }
    .btn { flex: 1; border: 0; border-radius: 8px; padding: 9px 10px; font-weight: 700; cursor: pointer; font-size: 13px; }
    .primary { background: #10b981; color: #fff; } .primary:hover { background: #059669; }
    .amber { background: #f59e0b; color: #111827; } .amber:hover { background: #fbbf24; }
    .btn:disabled { background: #1f2937; color: #6b7280; cursor: default; }
    .ghost { background: #1f2937; color: #d1d5db; flex: 0 0 auto; } .ghost:hover { background: #374151; }
    .meta { color: #6b7280; font-size: 11px; padding: 0 2px; }
    .toast { position: fixed; right: 20px; top: 20px; z-index: 2147483647; background: #10b981; color: #fff; padding: 10px 14px; border-radius: 8px; font-weight: 700; }
    .menu { padding: 4px 6px 8px; border-top: 1px solid #1f2937; overflow-y: auto; }
    .opt { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 7px; cursor: pointer; user-select: none; }
    .opt:hover { background: #222c3f; }
    .opt span { flex: 1; } .opt small { display: block; color: #8b95a7; font-size: 11px; margin-top: 1px; }
    .sw { width: 32px; height: 18px; border-radius: 9px; background: #374151; position: relative; flex: none; }
    .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .12s; }
    .opt.on .sw { background: #10b981; } .opt.on .sw::after { left: 16px; }
    .sep { height: 1px; background: #2f3a4f; margin: 6px 4px; }
    .needs-meta { padding: 6px 8px 4px; color: #8b95a7; font-size: 11.5px; }
    .needs-meta .row { margin-top: 6px; }
    .sm { border: 0; border-radius: 6px; padding: 5px 9px; font-weight: 700; font-size: 12px; cursor: pointer; background: #2a3448; color: #e5e7eb; }
    .sm:hover { background: #34405a; }
    .imp { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #1f2937; }
    .imp h2 { margin: 8px 0 0; font-size: 13.5px; color: #fff; }
    .imp p { margin: 0; color: #8b95a7; font-size: 12px; line-height: 1.45; }
    .imp textarea { width: 100%; height: 120px; resize: vertical; background: #0b1220; color: #e5e7eb; border: 1px solid #374151; border-radius: 8px; padding: 8px; font: 11.5px ui-monospace, Menlo, monospace; }
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
  const subLine = (c) => esc([c.set, c.number, shortCond(c.condition)].filter(Boolean).join(' · '));
  const thumb = (c) => (c.img ? `<img src="${esc(c.img)}" alt="">` : '<img alt="">');

  function wantView() {
    const needKeys = new Set(matches.map((m) => m.key));
    const count = items.reduce((n, it) => n + it.want, 0);
    const total = items.reduce((n, it) => n + priceNum(it.price) * it.want, 0);
    const body = items.length
      ? `<ul>${items.map((it, i) => `
          <li>
            ${thumb(it)}
            <div class="info">
              <div class="nm" title="${esc(it.name)}">${needKeys.has(it.key) ? '<span class="star">★</span> ' : ''}${esc(it.name)}</div>
              <div class="sub">${subLine(it)}</div>
            </div>
            <div class="right">
              <span class="price">${esc(it.price || '—')}</span>
              ${it.qty > 1 ? `<span class="qty"><button data-act="dec" data-k="${esc(it.key)}">−</button>${it.want} of ${it.qty}<button data-act="inc" data-k="${esc(it.key)}">+</button></span>` : ''}
            </div>
            <button class="x" data-act="rm" data-k="${esc(it.key)}" title="Remove">✕</button>
          </li>`).join('')}</ul>`
      : `<div class="empty"><b>No cards yet</b>${selectMode ? 'Click cards on the page to add them.' : 'Turn on Select mode, then click cards to add them.'}</div>`;
    return `${body}
      <footer>
        <div class="total"><span>${count} card${count === 1 ? '' : 's'}</span><span>${fmt(total)}</span></div>
        <div class="row">
          <button class="btn primary" data-act="copy" ${items.length ? '' : 'disabled'}>Copy list for seller</button>
          <button class="btn ghost" data-act="clear" ${items.length ? '' : 'disabled'}>Clear</button>
        </div>
      </footer>`;
  }

  function needView() {
    if (!needs.length) {
      return `<div class="empty"><b>Highlight cards you need</b>Paste your “still needed” list from a spreadsheet and matching cards on any showcase get a ★ badge.</div>
        <footer><button class="btn amber" data-act="imp-open">Import list</button></footer>`;
    }
    const inList = new Set(items.map((i) => i.key));
    const missing = matches.filter((m) => !inList.has(m.key)).length;
    const scanning = scanStatus.startsWith('Scanning');
    const checked = scanStatus && !scanning ? scanStatus : `Checked ${document.querySelectorAll('.product-card').length} loaded cards`;
    const body = matches.length
      ? `<ul>${matches.map((m) => `
          <li class="go" data-act="goto" data-k="${esc(m.key)}" title="Show on page">
            ${thumb(m.card)}
            <div class="info"><div class="nm">${esc(m.card.name)}</div><div class="sub">${subLine(m.card)}</div></div>
            <div class="right"><span class="price">${esc(m.card.price || '—')}</span></div>
            ${inList.has(m.key)
              ? `<button class="add in" data-act="need-toggle" data-k="${esc(m.key)}" title="In want list (click to remove)">✓</button>`
              : `<button class="add" data-act="need-toggle" data-k="${esc(m.key)}" title="Add to want list">+</button>`}
          </li>`).join('')}</ul>`
      : `<div class="empty"><b>None found yet</b>None of the ${needs.length} cards on your list are on this page.${scanning ? '' : ' Scan the whole showcase to check every card.'}</div>`;
    return `${body}
      <footer>
        <div class="row">
          ${matches.length ? `<button class="btn amber" data-act="add-needs" ${missing ? '' : 'disabled'}>${missing ? `Add ${missing} to want list` : 'All added'}</button>` : ''}
          <button class="btn ${matches.length ? 'ghost' : 'amber'}" data-act="scan" ${scanning ? 'disabled' : ''}>${scanning ? esc(scanStatus) : 'Scan showcase'}</button>
        </div>
        <div class="meta">${esc(checked)} · your list has ${needs.length}</div>
      </footer>`;
  }

  function importView() {
    return `<div class="imp">
        <h2>Import cards you need</h2>
        <p>Copy the rows from your spreadsheet <b>including the header row</b> and paste below. It needs a card name and a number column. Set and Owned columns are used if present.</p>
        <textarea placeholder="Set&#9;Card&#9;Number&#10;Paradox Rift&#9;Crustle&#9;183/182"></textarea>
        ${importError ? `<div class="err">${esc(importError)}</div>` : ''}
        <div class="row">
          <button class="btn amber" data-act="imp-go">Import</button>
          <label class="btn ghost" data-act="imp-file-label" style="text-align:center">CSV file…<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain"></label>
          <button class="btn ghost" data-act="imp-cancel">Cancel</button>
        </div>
      </div>`;
  }

  function menuView() {
    const when = needsMeta?.importedAt ? new Date(needsMeta.importedAt).toLocaleDateString() : '';
    return `<div class="menu">
        <div class="opt ${selectMode ? 'on' : ''}" data-act="mode"><span>Select mode<small>Click cards on the page to add them</small></span><i class="sw"></i></div>
        <div class="opt ${includePrices ? 'on' : ''}" data-act="prices"><span>Include prices<small>In the message you copy</small></span><i class="sw"></i></div>
        <div class="opt ${highlightNeeds ? 'on' : ''}" data-act="hl"><span>Highlight needed cards<small>★ badge in the grid</small></span><i class="sw"></i></div>
        <div class="sep"></div>
        <div class="needs-meta">${needs.length ? `Needs list: <b style="color:#e5e7eb">${needs.length} cards</b>${when ? ` · imported ${esc(when)}` : ''}` : 'No needs list imported'}
          <div class="row">${needs.length ? '<button class="sm" data-act="imp-open">Update</button><button class="sm" data-act="needs-clear">Remove</button>' : '<button class="sm" data-act="imp-open">Import list</button>'}</div>
        </div>
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
    if (!panelOpen) {
      root.innerHTML = `<style>${CSS}</style><button class="fab" data-act="open">🃏 Want list (${count})${matches.length ? `<span class="nd">★ ${matches.length}</span>` : ''}</button>`;
      return;
    }
    const nNeed = matches.length;
    const body = importing ? importView() : tab === 'need' ? needView() : wantView();
    root.innerHTML = `<style>${CSS}</style>
      <div class="panel">
        <header>
          <h1>${menuOpen ? 'Settings' : 'Card Picker'}</h1>
          <button class="icon ${menuOpen ? 'on' : ''}" data-act="menu" title="${menuOpen ? 'Back' : 'Settings'}">${menuOpen ? '✕' : '⚙'}</button>
          <button class="icon" data-act="min" title="Minimize">–</button>
        </header>
        ${menuOpen ? menuView() : `<nav class="tabs">
          <button class="${tab === 'want' ? 'on' : ''}" data-act="tab-want">Want list <b>${count}</b></button>
          <button class="need-tab ${tab === 'need' ? 'on' : ''}" data-act="tab-need">★ Need <b class="${nNeed ? '' : 'zero'}">${needs.length ? nNeed : '–'}</b></button>
        </nav>
        ${!selectMode && !importing ? '<div class="notice"><span>Select mode is off. Clicks open cards normally.</span><button class="link" data-act="mode">Turn on</button></div>' : ''}
        ${body}`}
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

  function setTab(t) { tab = t; menuOpen = false; savePrefs(); render(true); }

  function onPanelClick(e) {
    const btn = e.composedPath().find((n) => n.dataset && n.dataset.act);
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'imp-file-label') return; // let the <label> open the file picker
    e.preventDefault();
    const it = ['rm', 'inc', 'dec'].includes(act) ? items.find((x) => x.key === btn.dataset.k) : null;
    if (['rm', 'inc', 'dec'].includes(act) && !it) { render(true); return; }
    switch (act) {
      case 'open': panelOpen = true; savePrefs(); render(true); break;
      case 'min': panelOpen = false; importing = false; menuOpen = false; savePrefs(); render(true); break;
      case 'menu': menuOpen = !menuOpen; render(true); break;
      case 'tab-want': setTab('want'); break;
      case 'tab-need': setTab('need'); break;
      case 'mode': selectMode = !selectMode; savePrefs(); render(true); break;
      case 'prices': includePrices = !includePrices; savePrefs(); render(true); break;
      case 'hl': highlightNeeds = !highlightNeeds; savePrefs(); render(true); break;
      case 'rm': items = items.filter((x) => x !== it); save(); break;
      case 'inc': it.want = Math.min(it.qty, it.want + 1); save(); break;
      case 'dec': it.want = Math.max(1, it.want - 1); save(); break;
      case 'clear': if (confirm(`Clear all ${items.length} cards from the list?`)) { items = []; save(); } break;
      case 'copy': copy(buildMessage()).then((ok) => toast(ok ? 'Copied — paste it to the seller' : 'Copy failed')); break;
      case 'imp-open': importing = true; menuOpen = false; tab = 'need'; importError = ''; render(true); break;
      case 'imp-cancel': importing = false; importError = ''; render(true); break;
      case 'imp-go': importNeeds(root.querySelector('textarea')?.value || '', 'pasted'); break;
      case 'needs-clear':
        if (confirm('Remove your imported needs list?')) {
          menuOpen = false; needs = []; needsMeta = null; store.set('cpp:needs', null); buildNeedIndex(); rekeyAll(); render(true);
        }
        break;
      case 'need-toggle': {
        e.stopPropagation();
        const m = matches.find((x) => x.key === btn.dataset.k);
        if (m) { toggleItem(m.card); save(); }
        break;
      }
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

  // SPA navigation: reload the list when the seller changes; portfolio switches keep the same list.
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
