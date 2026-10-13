// server-data.js — Bang Lab sert à l'exploitation : ses réseaux viennent d'un fichier statique déposé sur le serveur
// (même format que l'export de Bang : { app:'bang', kind:'networks', v:1, active, networks:[…] }).
//
// Au démarrage : l'appli s'ouvre aussitôt avec la dernière copie locale (fonctionne hors ligne), puis le fichier du
// serveur est relu. S'il a changé depuis la dernière synchronisation, il remplace les réseaux locaux (une sauvegarde
// d'avant remplacement reste disponible dans Formulaires › Importer). Le réseau choisi dans Réglages est conservé
// s'il existe toujours. « Recharger » (Réglages) force le remplacement, même sans changement.
//
// Emplacement du fichier : ServerData.URL (relatif à index.html). Pour un autre fichier sans toucher au code :
// ouvrir l'appli une fois avec ?data=chemin/vers/fichier.json (le chemin est mémorisé ; ?data=defaut pour revenir).

const ServerData = {
  URL: 'data/networks.json',
  META_KEY: 'server-data',
  _subs: new Set(),
  status: 'idle',      // idle | loading | synced | uptodate | missing | offline | error
  detail: '',

  get url() {
    let u = null;
    try {
      const q = new URLSearchParams(location.search).get('data');
      if (q === 'defaut' || q === 'default') localStorage.removeItem('server-data-url');
      else if (q) localStorage.setItem('server-data-url', q);
      u = localStorage.getItem('server-data-url');
    } catch (e) { /* stockage indisponible */ }
    return u || ServerData.URL;
  },

  meta() { try { return JSON.parse(localStorage.getItem(this.META_KEY) || 'null') || {}; } catch (e) { return {}; } },
  _saveMeta(m) { try { localStorage.setItem(this.META_KEY, JSON.stringify(m)); } catch (e) { /* plein */ } },

  on(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },
  _set(status, detail) {
    this.status = status;
    this.detail = detail || '';
    this._subs.forEach(f => { try { f(status); } catch (e) { console.error(e); } });
  },

  // Empreinte du contenu (FNV-1a 32 bits) : suffit à savoir si le fichier a changé
  hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16) + ':' + text.length;
  },

  // force : remplacer même si le fichier n'a pas changé. Résout le statut final.
  async sync(bang, force) {
    if (this._busy) return this._busy;
    this._busy = this._sync(bang, force).finally(() => { this._busy = null; });
    return this._busy;
  },

  async _sync(bang, force) {
    const url = this.url;
    this._set('loading');
    let text;
    try {
      const sep = url.includes('?') ? '&' : '?';
      const r = await fetch(url + sep + 't=' + Date.now(), { cache: 'no-store' });
      if (r.status === 404) { this._set('missing', url); return this.status; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    } catch (e) {
      this._set(navigator.onLine === false ? 'offline' : 'error', e && e.message || String(e));
      return this.status;
    }

    const meta = this.meta(), h = this.hash(text);
    if (!force && meta.hash === h && meta.url === url) {
      this._saveMeta({ ...meta, checkedAt: new Date().toISOString() });
      this._set('uptodate');
      return this.status;
    }

    let parsed;
    try { parsed = DataIO.parse(text); }
    catch (e) { this._set('error', 'Fichier illisible : ' + e.message); return this.status; }

    const store = bang.store;
    const keep = store.activeId;
    DataIO.backup(bang, store);                       // annulable depuis Formulaires › Importer
    DataIO.apply(store, parsed, 'all');
    if (keep && store.networks.some(n => n.id === keep)) store.activeId = keep;
    store.save();

    let exportedAt = null;
    try { exportedAt = JSON.parse(text).exportedAt || null; } catch (e) { /* déjà validé par parse */ }
    this._saveMeta({ url, hash: h, syncedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
      exportedAt, networks: parsed.networks.length, warnings: parsed.warnings.length, bytes: text.length });
    this._set('synced', parsed.warnings.length ? parsed.warnings.length + ' avertissement(s) au chargement' : '');
    this._refreshViews(bang);
    return this.status;
  },

  // Les vues construites relisent le réseau actif (la Carte compare une signature et se reconstruit si besoin)
  _refreshViews(bang) {
    const cm = bang.contexts;
    // nouveaux objets réseau : la Carte (et toute vue à signature) doit se reconstruire, même à identifiants égaux
    Object.values(cm.map).forEach(c => { if ('_sig' in c) c._sig = null; });
    const visible = [cm.active, ...cm.overlays].filter(c => c && c.built);
    visible.forEach(c => { try { c.onShow(); } catch (e) { console.error(e); } });
  },

  // Texte court pour les Réglages
  summary() {
    const m = this.meta();
    const when = iso => {
      if (!iso) return '';
      const d = new Date(iso), p = n => String(n).padStart(2, '0');
      return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    };
    const copy = m.syncedAt ? 'copie du ' + when(m.syncedAt) : 'aucune copie du serveur';
    switch (this.status) {
      case 'loading': return 'Lecture de ' + this.url + '…';
      case 'synced': return 'Mises à jour · ' + (m.networks || 0) + ' réseau' + (m.networks > 1 ? 'x' : '') + (this.detail ? ' · ' + this.detail : '');
      case 'uptodate': return 'À jour · ' + copy + (m.exportedAt ? ' · fichier du ' + when(m.exportedAt) : '');
      case 'missing': return 'Fichier absent : ' + this.url + ' · données locales utilisées';
      case 'offline': return 'Hors ligne · ' + copy;
      case 'error': return 'Erreur · ' + this.detail + ' · ' + copy;
      default: return m.syncedAt ? copy : this.url;
    }
  },

  toast(text, kind) {
    let t = document.getElementById('sd-toast');
    if (!t) {
      const st = document.createElement('style');
      st.textContent = `
        #sd-toast{position:fixed;left:50%;bottom:calc(5.5em + env(safe-area-inset-bottom));transform:translate(-50%,1em);opacity:0;
          z-index:900;max-width:calc(100% - 2em);box-sizing:border-box;padding:.65em 1.1em;border-radius:14px;background:#123;color:#fff;
          font-size:.88em;box-shadow:0 4px 16px rgba(0,0,0,.25);transition:opacity .2s,transform .2s;pointer-events:none}
        #sd-toast.in{opacity:1;transform:translate(-50%,0)}
        #sd-toast.err{background:#8c1d18}`;
      document.head.appendChild(st);
      t = document.createElement('div');
      t.id = 'sd-toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.toggle('err', kind === 'err');
    requestAnimationFrame(() => t.classList.add('in'));
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('in'), 4000);
  },

  // Démarrage : synchronisation silencieuse, sauf mise à jour ou erreur de lecture du fichier
  async start(bang) {
    const s = await this.sync(bang, false);
    if (s === 'synced') this.toast('Données du serveur chargées · ' + (this.meta().networks || 0) + ' réseau' + (this.meta().networks > 1 ? 'x' : ''));
    else if (s === 'error' && /illisible/.test(this.detail)) this.toast(this.detail, 'err');
  }
};

window.ServerData = ServerData;
