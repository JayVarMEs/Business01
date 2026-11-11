/* MakersBridge → Supabase connection.
 *
 * What it does (all optional: if anything fails, the page stays a normal static demo):
 *  1. Reads products, preorder campaigns and preorder progress from the database
 *     and updates the matching cards already on the page (prices, ratings, days left, joined).
 *  2. Adds email + password sign-in / sign-up (account button in the header).
 *  3. "Continue to demo checkout" saves the bag as a real order through the
 *     create_order() database function. Prices are re-read on the server, so the
 *     browser can never set its own price. Orders stay "pending": payment is not connected yet.
 *
 * Only the public (publishable) key is used here. It is safe to ship in the page;
 * Row Level Security in supabase/schema.sql decides what it may do.
 */
(() => {
  'use strict';

  const SB_URL = 'https://dgwyxjgzdctwgvuziyzf.supabase.co';
  const SB_KEY = 'sb_publishable_lhWnxW9ApKGCCA5HqW7UVA_PCZK1XoD';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const baht = n => '฿' + Number(n).toLocaleString('th-TH');
  const tell = m => { try { window.say(m); } catch (_) { /* page toast not available */ } };

  if (!window.supabase || !window.supabase.createClient) {
    console.warn('[shop-db] supabase-js did not load; staying in static demo mode.');
    return;
  }
  const sb = window.supabase.createClient(SB_URL, SB_KEY);
  let session = null;

  /* ---------- 1. Catalog from the database ---------- */

  function daysLeft(iso) {
    const n = Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5);
    return n > 0 ? n + (n === 1 ? ' day left' : ' days left') : 'Closed';
  }

  async function loadCatalog() {
    const [p, c, g] = await Promise.all([
      sb.from('products').select('id,name,price_thb,kind,rating,sold_count').eq('active', true),
      sb.from('campaigns').select('id,product_id,title,seller,minimum,deposit_thb,ends_at').eq('active', true),
      sb.from('campaign_progress').select('campaign_id,joined'),
    ]);
    if (p.error || c.error || g.error) throw (p.error || c.error || g.error);

    const joined = new Map(g.data.map(r => [r.campaign_id, r.joined]));
    const campaignByProduct = new Map(c.data.filter(x => x.product_id).map(x => [x.product_id, x]));
    const productByName = new Map(p.data.map(x => [x.name, x]));
    const campaignByName = new Map(c.data.map(x => [x.seller + ' · ' + x.title, x]));

    $$('.product').forEach(card => {
      const prod = productByName.get($('.product-title', card)?.textContent.trim());
      if (!prod) return;
      card.dataset.productId = prod.id;
      card.dataset.price = prod.price_thb;
      $('.price', card).textContent = baht(prod.price_thb);
      const meta = $('.rating', card);
      if (prod.kind === 'preorder') {
        const camp = campaignByProduct.get(prod.id);
        if (camp && meta) {
          const pct = Math.min(100, Math.round(((joined.get(camp.id) || 0) / camp.minimum) * 100));
          meta.textContent = pct + '% funded';
        }
      } else if (meta) {
        meta.textContent = (prod.rating ? prod.rating + ' · ' : '') + prod.sold_count + ' sold';
      }
      const add = $('.add', card);
      if (add) { add.dataset.productId = prod.id; add.dataset.price = prod.price_thb; }
    });

    $$('.campaign').forEach(card => {
      const camp = campaignByName.get($('h2', card)?.textContent.trim());
      if (!camp) return;
      const n = joined.get(camp.id) || 0;
      const pct = Math.min(100, Math.round((n / camp.minimum) * 100));
      const spans = $$('.labels span', card);
      if (spans[0]) spans[0].textContent = n + ' joined';
      if (spans[1]) spans[1].textContent = camp.minimum + ' minimum';
      const days = $('.days', card); if (days) days.textContent = daysLeft(camp.ends_at);
      const track = $('.track', card);
      if (track) {
        track.setAttribute('aria-valuemax', camp.minimum);
        track.setAttribute('aria-valuenow', n);
        const fill = $('.fill', track); if (fill) fill.style.width = pct + '%';
      }
      const add = $('.add', card);
      if (add) { add.dataset.campaignId = camp.id; add.dataset.price = camp.deposit_thb; }
    });

    document.documentElement.dataset.db = 'live';
  }

  /* ---------- 2. Keep database ids on bag items ---------- */

  // The page's own handler pushes the item first; this runs right after it (bubble phase).
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.add');
    if (!b || typeof cart === 'undefined' || !cart.length) return;
    const last = cart[cart.length - 1];
    if (last.ref !== undefined) return;
    if (b.dataset.productId) last.ref = { product_id: b.dataset.productId };
    else if (b.dataset.campaignId) last.ref = { campaign_id: b.dataset.campaignId };
    else last.ref = null; // not in the live catalog
  });

  /* ---------- 3. Sign in / account dialog ---------- */

  const dlg = document.createElement('dialog');
  dlg.id = 'authDialog';
  dlg.setAttribute('aria-labelledby', 'authTitle');
  dlg.innerHTML =
    '<div class="dialog">' +
      '<div class="dialog-head"><div><h2 id="authTitle">Sign in</h2><p id="authHint"></p></div>' +
      '<button class="round-btn" type="button" id="authClose" aria-label="Close sign in"><svg class="icon"><use href="#close"/></svg></button></div>' +
      '<form id="authForm"><div class="form">' +
        '<div class="field full"><label for="authEmail">Email</label><input id="authEmail" type="email" autocomplete="email" required></div>' +
        '<div class="field full"><label for="authPass">Password (10+ characters)</label><input id="authPass" type="password" minlength="10" autocomplete="current-password" required></div>' +
      '</div><button class="button quiet" type="button" id="authGoogle" style="width:100%;margin-top:13px">Continue with Google</button>' +
      '<p class="fine" id="authMsg" role="status"></p>' +
      '<div class="dialog-actions"><button class="button quiet" type="button" id="authToggle">Create account instead</button>' +
      '<button class="button pink" type="submit" id="authSubmit">Sign in</button></div></form>' +
      '<div id="authAccount" hidden><p id="authWho"></p><h3>Recent orders</h3><ul id="authOrders"></ul>' +
      '<div class="dialog-actions"><button class="button quiet" type="button" id="authOut">Sign out</button></div></div>' +
    '</div>';
  document.body.appendChild(dlg);

  const el = id => dlg.querySelector('#' + id);
  let mode = 'in'; // 'in' | 'up'

  function setMode(m) {
    mode = m;
    el('authTitle').textContent = m === 'in' ? 'Sign in' : 'Create account';
    el('authSubmit').textContent = m === 'in' ? 'Sign in' : 'Create account';
    el('authToggle').textContent = m === 'in' ? 'Create account instead' : 'I already have an account';
    el('authPass').autocomplete = m === 'in' ? 'current-password' : 'new-password';
    el('authMsg').textContent = '';
  }

  async function showAccount() {
    el('authForm').hidden = true;
    el('authAccount').hidden = false;
    el('authTitle').textContent = 'Your account';
    el('authHint').textContent = '';
    el('authWho').textContent = 'Signed in as ' + session.user.email;
    const list = el('authOrders');
    list.replaceChildren();
    const { data, error } = await sb.from('orders').select('id,status,total_thb,created_at')
      .order('created_at', { ascending: false }).limit(5);
    if (error || !data.length) {
      const li = document.createElement('li');
      li.textContent = error ? 'Could not load orders.' : 'No orders yet.';
      list.appendChild(li);
      return;
    }
    data.forEach(o => {
      const li = document.createElement('li');
      li.textContent = '#' + o.id.slice(0, 8) + ' · ' + baht(o.total_thb) + ' · ' + o.status +
        ' · ' + new Date(o.created_at).toLocaleDateString('en-GB');
      list.appendChild(li);
    });
  }

  function openAuth(hint) {
    if (session) { showAccount(); }
    else {
      el('authForm').hidden = false;
      el('authAccount').hidden = true;
      el('authHint').textContent = hint || 'Sign in to save your orders.';
      setMode('in');
    }
    if (!dlg.open) dlg.showModal();
  }

  el('authClose').onclick = () => dlg.close();
  el('authToggle').onclick = () => setMode(mode === 'in' ? 'up' : 'in');
  el('authGoogle').onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) el('authMsg').textContent = error.message;
  };
  el('authOut').onclick = async () => { await sb.auth.signOut(); dlg.close(); tell('Signed out'); };

  el('authForm').onsubmit = async e => {
    e.preventDefault();
    const email = el('authEmail').value.trim();
    const password = el('authPass').value;
    const msg = el('authMsg');
    const btn = el('authSubmit');
    btn.disabled = true; msg.textContent = 'Please wait…';
    try {
      if (mode === 'up') {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session) { dlg.close(); tell('Account created'); }
        else { setMode('in'); msg.textContent = 'Check your email and click the confirmation link, then sign in.'; }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        dlg.close(); tell('Signed in');
      }
    } catch (err) {
      // Same wording for "no such user" and "wrong password" so attackers learn nothing.
      msg.textContent = /confirm/i.test(err.message || '') ? 'Please confirm your email first.'
        : mode === 'in' ? 'Wrong email or password.'
        : /password/i.test(err.message || '') ? err.message : 'Could not create the account. Try a different email or password.';
    } finally { btn.disabled = false; }
  };

  // The page hides the header person icon on phones; sign-in must work there too.
  const st = document.createElement('style');
  st.textContent = '.account{display:grid!important}';
  document.head.appendChild(st);

  // The header person icon used to open the partner form; it now opens sign-in.
  const oldAcct = $('.account');
  const acct = oldAcct.cloneNode(true);
  oldAcct.replaceWith(acct);
  acct.removeAttribute('data-open');
  acct.setAttribute('aria-haspopup', 'dialog');
  acct.onclick = () => openAuth();

  function refreshAcctLabel() {
    acct.setAttribute('aria-label', session ? 'Your account' : 'Sign in');
    acct.title = session ? session.user.email : 'Sign in';
  }

  sb.auth.onAuthStateChange((_evt, s) => {
    session = s;
    refreshAcctLabel();
    if (dlg.open && session) showAccount();
  });

  /* ---------- 4. Checkout → create_order() ---------- */

  const checkout = $('#checkout');
  let busy = false;

  checkout.onclick = async () => {
    if (busy || typeof cart === 'undefined' || !cart.length) return;
    if (cart.some(i => !i.ref)) { tell('Some items are not in the live catalog yet'); return; }
    if (!session) { openAuth('Sign in to place your order.'); return; }

    // Merge identical lines into one with a quantity.
    const lines = new Map();
    cart.forEach(i => {
      const k = JSON.stringify(i.ref);
      lines.set(k, { ...i.ref, quantity: (lines.get(k)?.quantity || 0) + 1 });
    });
    const items = [...lines.values()];
    if (items.some(i => i.quantity > 20)) { tell('Maximum 20 of one item per order'); return; }

    busy = true; checkout.disabled = true;
    try {
      const { data, error } = await sb.rpc('create_order', { items });
      if (error) throw error;
      cart.length = 0;
      if (typeof render === 'function') render();
      if (typeof closeCart === 'function') closeCart();
      tell('Order #' + String(data).slice(0, 8) + ' saved. Payment is not connected yet.');
    } catch (err) {
      // Only show our own messages; never raw database errors.
      tell(/^(Sign in first|Bag must|Too many pending|Daily order limit|Product not available|Preorder is closed|Bad )/.test(err.message || '')
        ? err.message : 'Could not place the order. Please try again.');
    } finally { busy = false; checkout.disabled = false; }
  };

  /* ---------- start ---------- */

  sb.auth.getSession().then(({ data }) => { session = data.session; refreshAcctLabel(); });
  refreshAcctLabel();
  loadCatalog().catch(err => console.warn('[shop-db] catalog not loaded; showing built-in demo data.', err));
})();
