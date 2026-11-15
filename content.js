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
  let items = [];            // [{key,name,set,rarity,number,condition,variant,price,qty,want,img}]
  let selectMode = true;
  let includePrices = true;
  let panelOpen = true;
  let listKey = null;
  let host, root;

  const isShowcase = () => location.pathname.startsWith('/showcase/');
  const sellerHandle = () => (location.pathname.match(/@([^/?#]+)/) || [])[1] || 'seller';
  const keyForPage = () => {
    const col = new URLSearchParams(location.search).get('collection') || 'all';
    return `cpp:${sellerHandle()}:${col}`;
  };

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

  const priceNum = (p) => parseFloat(String(p).replace(/[^\d.]/g, '')) || 0;
  const fmt = (n) => '$' + n.toFixed(2);

  // ---------- page styling for selected cards ----------
  function injectPageStyle() {
    if (document.getElementById('cpp-page-style')) return;
    const s = document.createElement('style');
    s.id = 'cpp-page-style';
    s.textContent = `
      html.cpp-select .product-card { transition: outline-color .12s; outline: 2px dashed transparent; outline-offset: -2px; }
      html.cpp-select .product-card:hover { outline-color: rgba(16,185,129,.7) !important; }
      .product-card[data-cpp-sel] { position: relative !important; outline: 3px solid #10b981 !important; outline-offset: -3px !important; background-color: rgba(16,185,129,.10) !important; }
      .product-card[data-cpp-sel]::after {
        content: attr(data-cpp-sel); position: absolute; top: 6px; right: 6px; z-index: 5;
        min-width: 26px; height: 26px; padding: 0 6px; box-sizing: border-box; border-radius: 13px;
        background: #10b981; color: #fff; font: 700 14px/26px system-ui, sans-serif; text-align: center;
        box-shadow: 0 2px 6px rgba(0,0,0,.4); pointer-events: none;
      }`;
    document.head.appendChild(s);
  }

  function paintCards() {
    if (!isShowcase()) return;
    const byKey = new Map(items.map((it) => [it.key, it]));
    document.querySelectorAll('.product-card').forEach((el) => {
      let k = el.dataset.cppKey;
      if (!k) { k = parseCard(el).key; el.dataset.cppKey = k; }
      const it = byKey.get(k);
      const want = it ? (it.qty > 1 ? `✓ ${it.want}` : '✓') : null;
      if (want) { if (el.getAttribute('data-cpp-sel') !== want) el.setAttribute('data-cpp-sel', want); }
      else if (el.hasAttribute('data-cpp-sel')) el.removeAttribute('data-cpp-sel');
    });
  }

  // React may reuse card nodes for different products when filtering/sorting; re-key on content changes.
  function rekeyAll() {
    document.querySelectorAll('.product-card').forEach((el) => delete el.dataset.cppKey);
    paintCards();
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
    const data = parseCard(card);
    card.dataset.cppKey = data.key;
    const i = items.findIndex((it) => it.key === data.key);
    if (i >= 0) items.splice(i, 1);
    else items.push(data);
    save();
  }

  // ---------- persistence ----------
  async function load() {
    listKey = keyForPage();
    const saved = (await store.get(listKey)) || {};
    items = (Array.isArray(saved.items) ? saved.items : []).map(sanitize).filter(Boolean).slice(0, 1000);
    const prefs = (await store.get('cpp:prefs')) || {};
    selectMode = prefs.selectMode ?? true;
    includePrices = prefs.includePrices ?? true;
    panelOpen = prefs.panelOpen ?? true;
    render();
  }
  function save() {
    store.set(listKey, { items, updated: Date.now(), url: location.href });
    render();
  }
  function savePrefs() {
    store.set('cpp:prefs', { selectMode, includePrices, panelOpen });
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
  `;

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = 'collectr-card-picker';
    root = host.attachShadow({ mode: 'closed' });
    root.addEventListener('click', (e) => { if (e.isTrusted) onPanelClick(e); });
    document.documentElement.appendChild(host);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render() {
    if (!isShowcase()) { if (host) host.remove(); document.documentElement.classList.remove('cpp-select'); return; }
    ensureHost();
    injectPageStyle();
    document.documentElement.classList.toggle('cpp-select', selectMode);
    paintCards();

    const count = items.reduce((n, it) => n + it.want, 0);
    const total = items.reduce((n, it) => n + priceNum(it.price) * it.want, 0);

    if (!panelOpen) {
      root.innerHTML = `<style>${CSS}</style><button class="fab" data-act="open">🃏 Want list (${count})</button>`;
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
        ${list}
        <footer>
          <div class="total"><span>${count} card${count === 1 ? '' : 's'}</span><span>${fmt(total)}</span></div>
          <div class="row">
            <button class="btn primary" data-act="copy" ${items.length ? '' : 'disabled'}>Copy list for seller</button>
            <button class="btn ghost" data-act="clear" ${items.length ? '' : 'disabled'}>Clear</button>
          </div>
        </footer>
      </div>`;
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    root.appendChild(t);
    setTimeout(() => t.remove(), 1600);
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

  function onPanelClick(e) {
    const btn = e.composedPath().find((n) => n.dataset && n.dataset.act);
    if (!btn) return;
    e.preventDefault();
    const i = +btn.dataset.i;
    if (['rm', 'inc', 'dec'].includes(btn.dataset.act) && !items[i]) return;
    switch (btn.dataset.act) {
      case 'open': panelOpen = true; savePrefs(); render(); break;
      case 'min': panelOpen = false; savePrefs(); render(); break;
      case 'mode': selectMode = !selectMode; savePrefs(); render(); break;
      case 'prices': includePrices = !includePrices; savePrefs(); render(); break;
      case 'rm': items.splice(i, 1); save(); break;
      case 'inc': items[i].want = Math.min(items[i].qty, items[i].want + 1); save(); break;
      case 'dec': items[i].want = Math.max(1, items[i].want - 1); save(); break;
      case 'clear': if (confirm(`Clear all ${items.length} cards from the list?`)) { items = []; save(); } break;
      case 'copy': copy(buildMessage()).then((ok) => toast(ok ? 'Copied — paste it to the seller' : 'Copy failed')); break;
    }
  }

  // ---------- wiring ----------
  document.addEventListener('click', onClick, true);

  let paintQueued = false;
  let rekeyQueued = false;
  new MutationObserver((muts) => {
    if (host && muts.every((m) => host.contains(m.target) || m.target === host)) return;
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
    if (keyForPage() !== listKey) load(); else render();
    rekeyAll();
  }, 500);

  if (hasChrome && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (sender?.id !== chrome.runtime.id) return;
      if (msg?.type === 'cpp-toggle-panel') { panelOpen = !panelOpen; savePrefs(); render(); }
    });
  }

  load();
})();
