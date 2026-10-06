/*! JetReserve Finance plug-in. Add to a charter company's listing pages:
 *
 *   <script src="https://YOUR-JETRESERVE-HOST/widget.js" defer></script>
 *   <div data-jetreserve-leg="LEG_ID" data-session-url="/your-backend/jetreserve-session"></div>
 *
 * The page never holds a JetReserve API key. On click, the widget POSTs { legId, email? } to YOUR backend
 * (data-session-url); your backend calls JetReserve's POST /api/v1/checkout-sessions with your secret key and returns
 * { embedUrl }. The widget then opens that hosted checkout in a sandboxed iframe.
 *
 * Optional attributes: data-label, data-weekly ("from $X/wk" teaser, fill from the API), data-email.
 * Events (on the element and window): jetreserve:funded, jetreserve:status, jetreserve:close  -> event.detail { loanId, status }
 */
(() => {
  const script = document.currentScript;
  const origin = new URL(script.src, location.href).origin; // JetReserve origin: only messages from here are trusted

  const css = document.createElement('style');
  css.textContent = `
    .jr-btn{background:#1769e0;color:#fff;border:0;border-radius:8px;padding:10px 16px;font:600 15px system-ui,sans-serif;cursor:pointer}
    .jr-btn:disabled{opacity:.6;cursor:wait}.jr-note{font:12px system-ui,sans-serif;color:#666;margin-top:4px}
    .jr-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:12px}
    .jr-frame{width:min(600px,100%);height:min(92vh,860px);border:0;border-radius:14px;background:#fff}`;
  document.head.appendChild(css);

  let overlay = null, activeEl = null;
  const emit = (type, detail) => {
    const ev = new CustomEvent(type, { detail, bubbles: true });
    (activeEl || window).dispatchEvent(ev);
    if (activeEl) window.dispatchEvent(new CustomEvent(type, { detail }));
  };
  const close = () => { overlay?.remove(); overlay = null; };

  function openCheckout(embedUrl) {
    const u = new URL(embedUrl, origin);
    if (u.origin !== origin) throw new Error('Refusing to open a checkout from an unexpected origin');
    close();
    overlay = document.createElement('div');
    overlay.className = 'jr-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const frame = document.createElement('iframe');
    frame.className = 'jr-frame';
    frame.title = 'JetReserve checkout';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    frame.src = u.href;
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== origin || e.data?.source !== 'jetreserve' || !overlay) return;
    const { type, ...detail } = e.data;
    delete detail.source;
    if (typeof type !== 'string' || !type.startsWith('jetreserve:')) return;
    if (type === 'jetreserve:close') { close(); emit(type, detail); return; }
    emit(type, detail);
  });

  function mount(el) {
    if (el.dataset.jrMounted) return;
    el.dataset.jrMounted = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jr-btn';
    const weekly = Number(el.dataset.weekly);
    btn.textContent = `${el.dataset.label || 'Fly now, pay weekly'}${weekly > 0 ? ` · from $${Math.round(weekly / 100).toLocaleString()}/wk` : ''}`;
    const note = document.createElement('div');
    note.className = 'jr-note';
    btn.onclick = async () => {
      btn.disabled = true; note.textContent = '';
      try {
        const sessionUrl = el.dataset.sessionUrl;
        if (!sessionUrl) throw new Error('data-session-url is required');
        const r = await fetch(sessionUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
          body: JSON.stringify({ legId: el.dataset.jetreserveLeg, email: el.dataset.email || undefined }) });
        const j = await r.json();
        if (!r.ok || !j.embedUrl) throw new Error(j.error?.message || 'Could not start checkout');
        activeEl = el;
        openCheckout(j.embedUrl);
      } catch (err) { note.textContent = err.message; }
      finally { btn.disabled = false; }
    };
    el.append(btn, note);
  }

  const scan = (root = document) => root.querySelectorAll('[data-jetreserve-leg]').forEach(mount);
  window.JetReserve = { mount, scan, open: openCheckout, close };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan()); else scan();
})();
