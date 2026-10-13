// pwa.js — installation PWA, service worker, état de l'application, réinitialisation, plein écran.
// Expose window.PWA ; alimente l'écran d'accueil (#overlay) et la page Compte.
(function () {
  'use strict';

  const OK = 'ok', WARN = 'warn', KO = 'ko';
  const PWA = {
    reg: null,            // ServiceWorkerRegistration
    deferred: null,       // événement beforeinstallprompt
    installedEvt: false,
    swError: null,
    _userUpdate: false,
    _listeners: [],

    on(fn) { this._listeners.push(fn); },
    _emit() { this._listeners.forEach(f => { try { f(); } catch (e) {} }); },

    // ---- État ---------------------------------------------------------
    displayMode() {
      const mm = q => window.matchMedia && window.matchMedia(q).matches;
      if (navigator.standalone) return 'standalone';
      if (mm('(display-mode: fullscreen)')) return 'fullscreen';
      if (mm('(display-mode: standalone)')) return 'standalone';
      if (mm('(display-mode: minimal-ui)')) return 'minimal-ui';
      return 'browser';
    },
    isInstalled() { return this.displayMode() !== 'browser'; },
    isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); },
    canInstall() { return !!this.deferred; },
    updateReady() { return !!(this.reg && this.reg.waiting && navigator.serviceWorker.controller); },
    fullscreenSupported() { return !!(document.fullscreenEnabled && document.documentElement.requestFullscreen); },
    isFullscreen() { return !!document.fullscreenElement; },

    swState() {
      if (!('serviceWorker' in navigator)) return { t: window.isSecureContext ? 'Non pris en charge' : 'HTTPS requis', s: KO };
      if (this.swError) return { t: 'Erreur', s: KO };
      if (!this.reg) return { t: 'Enregistrement…', s: WARN };
      const w = this.reg.active || this.reg.waiting || this.reg.installing;
      if (!w) return { t: 'Inactif', s: WARN };
      if (this.reg.installing && !this.reg.active) return { t: 'Installation…', s: WARN };
      if (w.state === 'activated') return navigator.serviceWorker.controller ? { t: 'Actif', s: OK } : { t: 'Actif (au prochain démarrage)', s: WARN };
      return { t: w.state, s: WARN };
    },

    async cacheInfo() {
      if (!('caches' in window)) return { name: null, n: 0 };
      try {
        const names = (await caches.keys()).filter(k => k.indexOf('lab-') === 0);
        if (!names.length) return { name: null, n: 0 };
        const name = names.sort().pop();
        const n = (await (await caches.open(name)).keys()).length;
        return { name, n };
      } catch (e) { return { name: null, n: 0 }; }
    },

    // Cache des données de carte (module LightMap) : base IndexedDB « LightMapDB », magasin « geoCache ».
    // On ne l'ouvre que si elle existe déjà : ouvrir une base absente la créerait sans son magasin.
    async _mapDb() {
      if (!window.indexedDB || !indexedDB.databases) return null;
      const dbs = await indexedDB.databases();
      if (!dbs.some(d => d.name === 'LightMapDB')) return false;
      return new Promise(res => {
        const rq = indexedDB.open('LightMapDB');
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => res(null);
        rq.onblocked = () => res(null);
      });
    },

    // { n : zones en cache, bytes : taille approximative } ; null si le navigateur ne permet pas de le savoir
    async mapCache() {
      try {
        const db = await this._mapDb();
        if (db === null) return null;
        if (db === false) return { n: 0, bytes: 0 };
        if (!db.objectStoreNames.contains('geoCache')) { db.close(); return { n: 0, bytes: 0 }; }
        return await new Promise(res => {
          let n = 0, bytes = 0;
          const rq = db.transaction('geoCache', 'readonly').objectStore('geoCache').openCursor();
          rq.onsuccess = () => {
            const c = rq.result;
            if (!c) { db.close(); res({ n, bytes }); return; }
            n++;
            try { bytes += JSON.stringify(c.value).length + String(c.key).length; } catch (e) {}
            c.continue();
          };
          rq.onerror = () => { db.close(); res(null); };
        });
      } catch (e) { return null; }
    },

    async clearMapCache() {
      try {
        const db = await this._mapDb();
        if (!db) return;
        if (db.objectStoreNames.contains('geoCache')) {
          await new Promise(res => {
            const tx = db.transaction('geoCache', 'readwrite');
            tx.objectStore('geoCache').clear();
            tx.oncomplete = tx.onerror = tx.onabort = () => res();
          });
        }
        db.close();
      } catch (e) {}
      this._emit();
    },

    localSize() {
      let n = 0;
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += (k.length + (localStorage.getItem(k) || '').length) * 2; } } catch (e) {}
      return n;
    },

    async storage() {
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const e = await navigator.storage.estimate();
          return { usage: e.usage || 0, quota: e.quota || 0 };
        }
      } catch (e) {}
      return null;
    },

    fmt(b) {
      if (b < 1024) return b + ' o';
      if (b < 1048576) return (b / 1024).toFixed(1).replace('.', ',') + ' Ko';
      if (b < 1073741824) return (b / 1048576).toFixed(1).replace('.', ',') + ' Mo';
      return (b / 1073741824).toFixed(1).replace('.', ',') + ' Go';
    },

    // ---- Actions ------------------------------------------------------
    async install() {
      if (!this.deferred) return false;
      const ev = this.deferred;
      this.deferred = null;
      ev.prompt();
      try { await ev.userChoice; } catch (e) {}
      this._emit();
      return true;
    },

    applyUpdate() {
      if (!this.updateReady()) return;
      this._userUpdate = true;
      this.reg.waiting.postMessage('SKIP_WAITING');
    },

    // wipe=false : supprime service worker + cache (données conservées) ; wipe=true : efface aussi les données locales
    async reset(wipe) {
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        if (wipe) {
          try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
          try {
            if (indexedDB.databases) {
              const dbs = await indexedDB.databases();
              dbs.forEach(d => d.name && indexedDB.deleteDatabase(d.name));
            }
          } catch (e) {}
        }
      } finally {
        location.reload();
      }
    },

    async toggleFullscreen() {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (this.fullscreenSupported()) await document.documentElement.requestFullscreen();
      } catch (e) { console.warn('Plein écran non autorisé :', e); }
      this._emit();
    },

    // ---- Service worker -----------------------------------------------
    register() {
      if (!('serviceWorker' in navigator)) { this._emit(); return; }
      navigator.serviceWorker.register('./service-worker.js').then(reg => {
        this.reg = reg;
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          if (w) w.addEventListener('statechange', () => this._emit());
          this._emit();
        });
        const w = reg.installing || reg.waiting || reg.active;
        if (w) w.addEventListener('statechange', () => this._emit());
        reg.update().catch(() => {});
        this._emit();
      }).catch(err => { this.swError = err; console.error('Service Worker :', err); this._emit(); });

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (this._userUpdate) location.reload(); else this._emit();
      });
    },

    // ---- Écran d'accueil / état --------------------------------------
    _el(tag, cls, text) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    },

    // Reconstruit le panneau dans #overlay. first=true : bouton « Démarrer », sinon « Fermer »
    async render() {
      const ov = document.getElementById('overlay');
      if (!ov) return;
      const info = await this.cacheInfo();
      const stor = await this.storage();
      const mc = await this.mapCache();
      const sw = this.swState();
      const mode = this.displayMode();

      const panel = this._el('div', 'pw-panel');
      const logo = this._el('img', 'pw-logo');
      logo.src = 'icons/icon-256x256.png';
      logo.alt = '';
      panel.append(logo, this._el('h1', 'pw-title', 'Bang'),
        this._el('p', 'pw-ver', info.name ? 'version ' + info.name.replace(/^lab-/, '') : 'version —'));

      const card = this._el('div', 'pw-card');
      const row = (k, v, s) => {
        const r = this._el('div', 'pw-row');
        r.append(this._el('span', 'pw-dot' + (s ? ' ' + s : '')), this._el('span', 'pw-k', k), this._el('span', 'pw-v', v));
        card.appendChild(r);
      };
      const modeTxt = { fullscreen: 'Installée · plein écran', standalone: 'Installée · autonome', 'minimal-ui': 'Installée · minimale', browser: 'Dans le navigateur' }[mode];
      row('Application', modeTxt, mode === 'browser' ? (this.canInstall() ? WARN : null) : OK);
      row('Service worker', sw.t, sw.s);
      row('Hors ligne', info.n ? 'Prêt · ' + info.n + ' fichiers' : 'Non disponible', info.n ? OK : WARN);
      row('Connexion', navigator.onLine ? 'En ligne' : 'Hors ligne', navigator.onLine ? OK : WARN);
      row('Données locales', this.fmt(this.localSize()));
      if (mc) row('Cache carte', mc.n ? mc.n + (mc.n > 1 ? ' zones' : ' zone') + ' · ' + this.fmt(mc.bytes) : 'Vide');
      if (stor && stor.quota) row('Stockage navigateur', this.fmt(stor.usage) + ' / ' + this.fmt(stor.quota));
      if (this.fullscreenSupported()) row('Plein écran', this.isFullscreen() ? 'Actif' : 'Inactif', this.isFullscreen() ? OK : null);
      if (this.updateReady()) row('Mise à jour', 'Disponible', WARN);
      panel.appendChild(card);

      if (!this.isInstalled() && !this.canInstall()) {
        const hint = this.isIOS()
          ? 'Pour installer : Safari › Partager › « Sur l’écran d’accueil ».'
          : (window.isSecureContext ? 'L’installation est proposée par le menu du navigateur (« Installer l’application »).'
                                    : 'L’installation nécessite une connexion sécurisée (HTTPS).');
        panel.appendChild(this._el('p', 'pw-hint', hint));
      }

      const btn = (label, cls, fn) => {
        const b = this._el('button', 'pw-btn' + (cls ? ' ' + cls : ''), label);
        b.type = 'button';
        b.addEventListener('click', fn);
        panel.appendChild(b);
        return b;
      };
      btn(this._started ? 'Fermer' : 'Démarrer', '', () => { this._started = true; ov.classList.add('fade-out'); });
      if (this.updateReady()) btn('Mettre à jour l’application', 'sec', () => this.applyUpdate());
      if (this.canInstall()) btn('Installer l’application', 'sec', () => this.install());

      panel.appendChild(this._el('div', 'pw-sep', 'Réinitialisation'));
      this._armBtn(btn('Réinitialiser l’application', 'sec', () => {}), 'Réinitialiser l’application', 'Confirmer ? (cache et mises à jour)', () => this.reset(false));
      if (mc && mc.n) this._armBtn(btn('Vider le cache de la carte', 'sec', () => {}), 'Vider le cache de la carte', 'Confirmer ? (' + this.fmt(mc.bytes) + ')', () => this.clearMapCache());
      this._armBtn(btn('Tout effacer, données comprises', 'danger', () => {}), 'Tout effacer, données comprises', 'Confirmer ? (portefeuille et réseaux perdus)', () => this.reset(true));
      panel.appendChild(this._el('p', 'pw-hint', 'La réinitialisation supprime le cache hors ligne et recharge l’application ; vos titres et réseaux sont conservés, sauf avec « Tout effacer ».'));

      ov.replaceChildren(panel);
    },

    // Double appui : le 1er arme le bouton (4 s), le 2nd exécute
    _armBtn(b, normal, armedLabel, fn) {
      let t = null;
      const fresh = b.cloneNode(true);
      b.replaceWith(fresh);
      fresh.addEventListener('click', () => {
        if (!fresh.classList.contains('armed')) {
          fresh.classList.add('armed');
          fresh.textContent = armedLabel;
          clearTimeout(t);
          t = setTimeout(() => { fresh.classList.remove('armed'); fresh.textContent = normal; }, 4000);
          return;
        }
        clearTimeout(t);
        fn();
      });
    },

    // Rouvre le panneau (depuis Compte)
    async openPanel() {
      const ov = document.getElementById('overlay');
      if (!ov) return;
      this.reg && this.reg.update().catch(() => {});
      await this.render();
      ov.classList.remove('fade-out');
    },

    _refresh() {
      const ov = document.getElementById('overlay');
      if (ov && !ov.classList.contains('fade-out')) this.render();
    }
  };

  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); PWA.deferred = e; PWA._emit(); });
  window.addEventListener('appinstalled', () => { PWA.deferred = null; PWA.installedEvt = true; PWA._emit(); });
  window.addEventListener('online', () => PWA._emit());
  window.addEventListener('offline', () => PWA._emit());
  document.addEventListener('fullscreenchange', () => PWA._emit());
  PWA.on(() => PWA._refresh());

  window.PWA = PWA;
  PWA.render();
  PWA.register();
})();
