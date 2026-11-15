// linux-whazzapp: powiadomienia o wiadomościach znikają po przeczytaniu.
// Wstrzykiwany do strony. Owija Notification z WhatsApp Web i:
//  - po kliknięciu w powiadomienie przekazuje procesowi głównemu tytuł (otworzy rozmowę) i zamyka je,
//  - zamyka powiadomienia rozmowy, która jest otwarta w oknie (okno aktywne, strona widoczna),
//  - zamyka wszystkie, gdy licznik nieprzeczytanych w tytule strony spadnie do zera
//    (np. po przeczytaniu na telefonie).
// Powiadomienia wyświetla proces główny przez D-Bus (notifier.js), więc zamknięcie naprawdę usuwa
// wpis z listy powiadomień Ubuntu. Gdy WhatsApp zmieni strukturę strony,
// mechanizmy oparte na układzie przestaną działać, ale kliknięcie w powiadomienie nadal działa.
(() => {
  if (window.__whazzappPatched) return;
  window.__whazzappPatched = true;

  const Orig = window.Notification;
  const GRACE_MS = 3000;

  // Stand-in for Chromium's Notification: the main process shows it through D-Bus (notifier.js),
  // so the app can remove it from GNOME's list itself. WhatsApp sees the usual API: onclick, close(),
  // 'show' / 'click' / 'close' events.
  const reg = new Map();           // key -> DbusNotification
  let seq = 0;
  const ICON_MAX = 400000;         // data URL size limit for the sender's picture

  function iconData(url) {
    if (!url) return Promise.resolve('');
    if (/^data:image\//.test(url)) return Promise.resolve(url.length < ICON_MAX ? url : '');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    return fetch(url, { signal: ctl.signal }).then((r) => (r.ok ? r.blob() : null)).then((b) => new Promise((res) => {
      if (!b || !/^image\//.test(b.type)) { res(''); return; }
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).length < ICON_MAX ? String(fr.result) : '');
      fr.onerror = () => res('');
      fr.readAsDataURL(b);
    })).catch(() => '').finally(() => clearTimeout(t));
  }

  class DbusNotification extends EventTarget {
    constructor(title, opts) {
      super();
      opts = opts || {};
      this.title = String(title == null ? '' : title);
      this.body = String(opts.body || '');
      this.tag = String(opts.tag || '');
      this.icon = String(opts.icon || '');
      this.data = opts.data === undefined ? null : opts.data;
      this.silent = !!opts.silent;
      this.onclick = this.onshow = this.onclose = this.onerror = null;
      this._key = 'n' + (++seq) + '-' + Date.now();
      this._closed = false;
      reg.set(this._key, this);
      const send = (icon) => {
        if (this._closed) return;
        console.log('__WHAZZAPP_NOTIFY__' + JSON.stringify({
          key: this._key, title: this.title, body: this.body, tag: this.tag, icon: /^https?:/.test(this.icon) ? this.icon : '', iconData: icon,
        }));
      };
      iconData(this.icon).then(send, () => send(''));
      setTimeout(() => this._fire('show'), 0);
    }
    close() {
      if (this._closed) return;
      this._closed = true;
      reg.delete(this._key);
      console.log('__WHAZZAPP_NOTIFY_CLOSE__' + JSON.stringify({ key: this._key }));
      setTimeout(() => this._fire('close'), 0);
    }
    _fire(type) {
      const ev = new Event(type);
      this.dispatchEvent(ev);
      const h = this['on' + type];
      if (typeof h === 'function') { try { h.call(this, ev); } catch (e) {} }
    }
  }
  // called by the main process for D-Bus signals of our notifications
  window.__whazzappNotifClick = (key) => { const n = reg.get(key); if (n) n._fire('click'); };
  window.__whazzappNotifClosed = (key) => {
    const n = reg.get(key);
    if (!n || n._closed) return;
    n._closed = true;
    reg.delete(key);
    n._fire('close');
  };           // świeżych powiadomień nie zamykamy z powodu opóźnionej zmiany tytułu
  const active = new Set();        // { n, title, ts }

  const chatNames = (title) => {   // w grupach tytuł ma postać „Nadawca @ Grupa”
    const names = [title];
    if (title.includes(' @ ')) names.push(title.split(' @ ').pop());
    return names;
  };

  function dismiss(rec) {
    active.delete(rec);
    try { rec.n.close(); } catch (e) {}
  }

  function dismissChat(name, { exceptYoungerThan = 0 } = {}) {
    if (!name) return;
    for (const rec of Array.from(active)) {
      if (exceptYoungerThan && Date.now() - rec.ts < exceptYoungerThan) continue;
      if (chatNames(rec.title).includes(name)) dismiss(rec);
    }
  }

  function dismissAll(exceptYoungerThan = 0) {
    for (const rec of Array.from(active)) {
      if (exceptYoungerThan && Date.now() - rec.ts < exceptYoungerThan) continue;
      dismiss(rec);
    }
  }

  function P(title, opts) {
    const n = new DbusNotification(title, opts);
    const rec = { n, title: String(title || ''), ts: Date.now() };
    active.add(rec);
    n.addEventListener('close', () => active.delete(rec));
    n.addEventListener('click', () => {
      try {
        console.log('__WHAZZAPP_NOTIF_CLICK__' + JSON.stringify({
          title: rec.title, tag: String((opts && opts.tag) || ''),
        }));
      } catch (e) { console.log('__WHAZZAPP_NOTIF_CLICK__{}'); }
      // po obsłudze kliknięcia przez WhatsApp (jego onclick otwiera rozmowę), jak w przeglądarce
      setTimeout(() => { dismissChat(rec.title); dismiss(rec); }, 0);   // to i pozostałe tej rozmowy
    });
    return n;
  }
  P.prototype = DbusNotification.prototype;
  Object.defineProperty(P, 'permission', { get: () => Orig.permission });
  P.requestPermission = Orig.requestPermission.bind(Orig);
  window.Notification = P;

  // nazwa rozmowy otwartej w oknie (nagłówek prawego panelu)
  function openChatName() {
    const el = document.querySelector('#main header span[title]') || document.querySelector('#main header [title]');
    return el ? (el.getAttribute('title') || '').trim() : '';
  }

  const unreadCount = () => {
    const m = /^\((\d+)\)/.exec(document.title || '');
    return m ? parseInt(m[1], 10) : 0;
  };

  let prevUnread = unreadCount();
  function check() {
    if (!active.size) { prevUnread = unreadCount(); return; }
    // 1) rozmowa jest otwarta i okno jest aktywne = wiadomości są czytane
    if (document.hasFocus() && !document.hidden) dismissChat(openChatName());
    // 2) wszystko przeczytane (tu albo na telefonie)
    const now = unreadCount();
    if (prevUnread > 0 && now === 0) dismissAll(GRACE_MS);
    prevUnread = now;
  }
  setInterval(check, 1000);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
})();
