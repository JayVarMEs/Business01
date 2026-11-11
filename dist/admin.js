/* MakersBridge admin.
 * Security notes:
 *  - Access is decided by the DATABASE (admins table + MFA check in is_admin()), never by this file.
 *    Hiding a button here protects nothing; the policies in supabase/002_admin_security.sql do.
 *  - Everything from the database is written with textContent / DOM nodes, never as HTML strings (no XSS).
 *  - Only the public (publishable) key is used. Never put a service_role / secret key in this folder.
 */
(() => {
  'use strict';

  // Anti-clickjacking: do not show anything when this page is inside someone else's frame.
  if (window.top !== window.self) return;
  document.documentElement.classList.add('framesafe');

  const SB_URL = 'https://dgwyxjgzdctwgvuziyzf.supabase.co';
  const SB_KEY = 'sb_publishable_lhWnxW9ApKGCCA5HqW7UVA_PCZK1XoD';
  const IDLE_MS = 15 * 60 * 1000;

  const $ = id => document.getElementById(id);
  const baht = n => '฿' + Number(n).toLocaleString('th-TH');
  const when = iso => new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour12: false });
  const short = v => String(v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 40);

  /** Tiny safe element builder. Text is always added as text. */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value' || k === 'checked') e[k] = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(c => e.append(c instanceof Node ? c : document.createTextNode(String(c))));
    return e;
  }
  const td = (...kids) => h('td', {}, ...kids);

  function note(msg, good) {
    const n = $('note');
    n.textContent = msg || '';
    n.hidden = !msg;
    n.classList.toggle('good', !!good);
  }
  const fail = err => note(err && err.message ? err.message : 'Something went wrong.');

  if (!window.supabase || !window.supabase.createClient) {
    note('Could not load the sign-in library. Check your connection and reload.');
    return;
  }
  const sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

  /* ---------- views ---------- */
  const VIEWS = ['login', 'denied', 'mfa', 'dash'];
  const show = name => VIEWS.forEach(v => { $('view-' + v).hidden = v !== name; });

  let idleTimer = null;
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      await sb.auth.signOut();
      await route();
      note('Signed out after 15 minutes of inactivity.');
    }, IDLE_MS);
  }
  ['click', 'keydown', 'touchstart', 'mousemove'].forEach(ev =>
    document.addEventListener(ev, () => { if (!$('view-dash').hidden) armIdle(); }, { passive: true }));

  let routing = false;
  async function route() {
    if (routing) return;
    routing = true;
    try {
      note('');
      const { data: { session } } = await sb.auth.getSession();
      $('signOut').hidden = !session;
      $('who').textContent = session ? session.user.email : '';
      if (!session) { clearTimeout(idleTimer); show('login'); return; }

      const { data: status, error } = await sb.rpc('admin_status');
      if (error) { fail(error); show('login'); return; }
      if (status === 'none') { clearTimeout(idleTimer); show('denied'); return; }
      if (status === 'needs_mfa') { await startMfa(); return; }

      show('dash');
      armIdle();
      await loadAll();
    } finally { routing = false; }
  }

  /* ---------- sign in ---------- */
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $('loginEmail').value.trim(), password: $('loginPass').value });
    $('loginPass').value = '';
    btn.disabled = false;
    if (error) {
      note(/confirm/i.test(error.message) ? 'Please confirm your email first.' : 'Wrong email or password.');
      return;
    }
    await route();
  });
  $('signOut').addEventListener('click', async () => { await sb.auth.signOut(); await route(); });
  sb.auth.onAuthStateChange(evt => { if (evt === 'SIGNED_OUT') route(); });

  /* ---------- two-step verification (TOTP) ---------- */
  let factorId = null;
  async function startMfa() {
    show('mfa');
    $('mfaCode').value = '';
    const { data: f, error } = await sb.auth.mfa.listFactors();
    if (error) { fail(error); return; }
    const verified = (f.totp || []).filter(x => x.status === 'verified');
    if (verified.length) {
      factorId = verified[0].id;
      $('mfaEnroll').hidden = true;
      $('mfaAsk').hidden = false;
      return;
    }
    // Remove half-finished setups, then start a fresh one.
    for (const x of (f.all || []).filter(x => x.factor_type === 'totp' && x.status !== 'verified')) {
      await sb.auth.mfa.unenroll({ factorId: x.id });
    }
    const { data, error: e2 } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'admin-' + Date.now() });
    if (e2) { fail(e2); return; }
    factorId = data.id;
    const qr = data.totp.qr_code;
    if (typeof qr === 'string' && qr.startsWith('data:image/')) $('mfaQr').src = qr;
    $('mfaSecret').textContent = data.totp.secret;
    $('mfaEnroll').hidden = false;
    $('mfaAsk').hidden = true;
  }

  $('mfaForm').addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('mfaCode').value.trim();
    if (!/^[0-9]{6}$/.test(code) || !factorId) { note('Enter the 6-digit code.'); return; }
    const btn = e.submitter || e.target.querySelector('button');
    btn.disabled = true;
    const ch = await sb.auth.mfa.challenge({ factorId });
    if (ch.error) { btn.disabled = false; fail(ch.error); return; }
    const v = await sb.auth.mfa.verify({ factorId, challengeId: ch.data.id, code });
    btn.disabled = false;
    $('mfaCode').value = '';
    if (v.error) { note('That code is not right. Try the newest one.'); return; }
    await route();
  });

  /* ---------- dashboard ---------- */
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs [data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    ['orders', 'products', 'campaigns', 'audit'].forEach(t => { $('tab-' + t).hidden = t !== b.dataset.tab; });
  }));

  const state = { products: [], orders: [] };
  const loadAll = () => Promise.all([loadOrders(), loadProducts(), loadCampaigns(), loadAudit()]);

  /** A button that needs a second click to confirm (no browser pop-ups). */
  function confirmBtn(label, cls, fn) {
    let t;
    const b = h('button', { type: 'button', class: cls || '' }, label);
    b.addEventListener('click', async () => {
      if (!b.classList.contains('confirm')) {
        b.classList.add('confirm');
        b.textContent = 'Confirm?';
        t = setTimeout(() => { b.classList.remove('confirm'); b.textContent = label; }, 4000);
        return;
      }
      clearTimeout(t);
      b.disabled = true;
      await fn();
      b.disabled = false;
      b.classList.remove('confirm');
      b.textContent = label;
    });
    return b;
  }

  /* orders */
  const STATUSES = ['pending', 'paid', 'cancelled', 'refunded'];
  async function setStatus(id, status) {
    const { error } = await sb.rpc('admin_set_order_status', { p_order: id, p_status: status });
    if (error) { fail(error); return; }
    note('Order updated.', true);
    await Promise.all([loadOrders(), loadAudit()]);
  }

  async function loadOrders() {
    const { data, error } = await sb.rpc('admin_list_orders', { p_limit: 100 });
    if (error) { fail(error); return; }
    state.orders = data;
    $('ordersBody').replaceChildren(...data.map(o => h('tr', {},
      td('#' + String(o.id).slice(0, 8)),
      td(when(o.created_at)),
      td(o.email),
      td(h('ul', { class: 'items' }, (o.items || []).map(i => h('li', {}, `${i.qty}× ${i.name}${i.size ? ' (' + i.size + ')' : ''}`)))),
      td(baht(o.total_thb)),
      td(h('span', { class: 'badge ' + (STATUSES.includes(o.status) ? o.status : ''), text: o.status })),
      td(
        o.status === 'pending' ? [confirmBtn('Mark paid', 'primary', () => setStatus(o.id, 'paid')), ' ', confirmBtn('Cancel', 'danger', () => setStatus(o.id, 'cancelled'))] : '',
        o.status === 'paid' ? confirmBtn('Refund', 'danger', () => setStatus(o.id, 'refunded')) : ''
      )
    )));
    renderStats();
  }

  function renderStats() {
    const paid = state.orders.filter(o => o.status === 'paid');
    const stat = (label, value) => h('div', { class: 'stat' }, h('span', { class: 'muted', text: label }), h('b', { text: value }));
    $('stats').replaceChildren(
      stat('Pending orders', state.orders.filter(o => o.status === 'pending').length),
      stat('Paid orders', paid.length),
      stat('Paid total', baht(paid.reduce((a, o) => a + o.total_thb, 0))),
      stat('Live products', state.products.filter(p => p.active).length)
    );
  }

  /* products */
  const intIn = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

  async function loadProducts() {
    const { data, error } = await sb.from('products').select('id,name,seller,kind,price_thb,active').order('created_at');
    if (error) { fail(error); return; }
    state.products = data;
    $('productsBody').replaceChildren(...data.map(p => {
      const price = h('input', { type: 'number', min: 1, max: 100000, step: 1, value: p.price_thb, 'aria-label': 'Price for ' + p.name });
      const live = h('input', { type: 'checkbox', checked: p.active, 'aria-label': 'Live: ' + p.name });
      const save = h('button', { type: 'button', class: 'ghost', text: 'Save' });
      save.addEventListener('click', async () => {
        const n = intIn(price.value, 1, 100000);
        if (n === null) { note('Price must be a whole number from 1 to 100000.'); return; }
        save.disabled = true;
        const { error: e } = await sb.from('products').update({ price_thb: n, active: live.checked }).eq('id', p.id);
        save.disabled = false;
        if (e) { fail(e); return; }
        note('Product saved.', true);
        await Promise.all([loadProducts(), loadAudit()]);
      });
      return h('tr', {}, td(h('b', { text: p.name }), h('br'), h('span', { class: 'muted', text: p.seller })), td(p.kind), td(price), td(live), td(save));
    }));
    $('cProduct').replaceChildren(h('option', { value: '' }, '(none)'),
      ...data.filter(p => p.kind === 'preorder').map(p => h('option', { value: p.id }, p.name)));
    renderStats();
  }

  $('productForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('pName').value.trim();
    const price = intIn($('pPrice').value, 1, 100000);
    const kind = $('pKind').value;
    const cats = $('pCats').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const image = $('pImage').value.trim();
    if (price === null) { note('Price must be a whole number from 1 to 100000.'); return; }
    if (cats.length > 5 || cats.some(c => !/^[a-z]{2,20}$/.test(c))) { note('Categories: up to 5 single words, letters only.'); return; }
    if (image && !/^https:\/\//.test(image)) { note('Image link must start with https://'); return; }
    const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item') +
      '-' + Math.random().toString(16).slice(2, 6);
    const { error } = await sb.from('products').insert({
      slug, name, seller: $('pSeller').value.trim(), price_thb: price, kind,
      categories: [...new Set([...cats, kind])], image_url: image || null,
    });
    if (error) { fail(error); return; }
    e.target.reset();
    note('Product added. Remember: the public page needs a matching card to show it.', true);
    await Promise.all([loadProducts(), loadAudit()]);
  });

  /* preorders */
  const bangkokDate = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const endOfDay = d => new Date(d + 'T23:59:59+07:00').toISOString();

  async function loadCampaigns() {
    const { data, error } = await sb.from('campaigns').select('id,title,seller,minimum,deposit_thb,ends_at,active').order('ends_at');
    if (error) { fail(error); return; }
    $('campaignsBody').replaceChildren(...data.map(c => {
      const min = h('input', { type: 'number', min: 1, max: 100000, step: 1, value: c.minimum, 'aria-label': 'Minimum for ' + c.title });
      const dep = h('input', { type: 'number', min: 1, max: 100000, step: 1, value: c.deposit_thb, 'aria-label': 'Deposit for ' + c.title });
      const end = h('input', { type: 'date', value: bangkokDate(c.ends_at), 'aria-label': 'End date for ' + c.title });
      const live = h('input', { type: 'checkbox', checked: c.active, 'aria-label': 'Live: ' + c.title });
      const save = h('button', { type: 'button', class: 'ghost', text: 'Save' });
      save.addEventListener('click', async () => {
        const m = intIn(min.value, 1, 100000), d = intIn(dep.value, 1, 100000);
        if (m === null || d === null || !end.value) { note('Check minimum, deposit and end date.'); return; }
        save.disabled = true;
        const { error: e } = await sb.from('campaigns').update({ minimum: m, deposit_thb: d, ends_at: endOfDay(end.value), active: live.checked }).eq('id', c.id);
        save.disabled = false;
        if (e) { fail(e); return; }
        note('Preorder saved.', true);
        await Promise.all([loadCampaigns(), loadAudit()]);
      });
      return h('tr', {}, td(h('b', { text: c.title }), h('br'), h('span', { class: 'muted', text: c.seller })), td(min), td(dep), td(end), td(live), td(save));
    }));
  }

  $('campaignForm').addEventListener('submit', async e => {
    e.preventDefault();
    const m = intIn($('cMin').value, 1, 100000), d = intIn($('cDeposit').value, 1, 100000);
    if (m === null || d === null) { note('Minimum and deposit must be whole numbers.'); return; }
    const { error } = await sb.from('campaigns').insert({
      title: $('cTitle').value.trim(), seller: $('cSeller').value.trim(),
      description: $('cDesc').value.trim() || null, product_id: $('cProduct').value || null,
      minimum: m, deposit_thb: d, ends_at: endOfDay($('cEnds').value),
    });
    if (error) { fail(error); return; }
    e.target.reset();
    note('Preorder added.', true);
    await Promise.all([loadCampaigns(), loadAudit()]);
  });

  /* audit log */
  function summarize(r) {
    const o = r.old_data || {}, n = r.new_data || {};
    if (r.action === 'STATUS') return `${o.status} → ${n.status}`;
    if (r.action === 'INSERT') return 'created: ' + short(n.name || n.title);
    if (r.action === 'DELETE') return 'deleted: ' + short(o.name || o.title);
    return Object.keys(n).filter(k => JSON.stringify(n[k]) !== JSON.stringify(o[k]))
      .map(k => `${k}: ${short(o[k])} → ${short(n[k])}`).join('; ');
  }

  async function loadAudit() {
    const { data, error } = await sb.from('audit_log').select('id,at,actor,action,table_name,row_id,old_data,new_data')
      .order('id', { ascending: false }).limit(100);
    if (error) { fail(error); return; }
    $('auditBody').replaceChildren(...data.map(r => h('tr', {},
      td(when(r.at)), td(r.action),
      td(`${r.table_name} ${String(r.row_id || '').slice(0, 8)} · by ${r.actor ? String(r.actor).slice(0, 8) : 'system'}`),
      td(summarize(r)))));
  }

  $('reloadOrders').addEventListener('click', loadOrders);
  $('reloadAudit').addEventListener('click', loadAudit);

  route();
})();
