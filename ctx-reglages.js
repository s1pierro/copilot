// ctx-reglages.js — onglet « Réglages » de Bang Lab : réseau actif, outils, affichage, application.

class ReglagesContext extends Context {
  build(el) {
    this._injectStyle();
    this.list = document.createElement('div');
    this.list.className = 'rg-list';
    el.append(mkWaveHeader(uiSvg('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'), true), this.list);
    this.refresh();
    if (window.PWA) PWA.on(() => this.refresh());
    if (window.GeoPerm) { GeoPerm.on(() => this.refresh()); GeoPerm.state(); }
    if (window.ServerData) ServerData.on(() => this.refresh());
  }

  onShow() { if (this.built) this.refresh(); }

  _row(icon, label, sub, onTap, cls) {
    const row = document.createElement('div');
    row.className = 'rg-row' + (cls ? ' ' + cls : '');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.innerHTML = uiSvg(icon);
    const t = document.createElement('span');
    t.append(label);
    if (sub) { const s = document.createElement('small'); s.textContent = sub; t.appendChild(s); }
    row.appendChild(t);
    row.insertAdjacentHTML('beforeend', uiSvg('<path d="M9 5l7 7-7 7"/>', 'rg-chev'));
    if (onTap) {
      row.addEventListener('click', onTap);
      row.addEventListener('keydown', ev => { if (ev.key === 'Enter') onTap(); });
    }
    return row;
  }

  _group(title, rows) {
    const g = document.createElement('div');
    if (title) { const h = document.createElement('div'); h.className = 'rg-h'; h.textContent = title; g.appendChild(h); }
    const box = document.createElement('div');
    box.className = 'rg-box';
    rows.filter(Boolean).forEach(r => box.appendChild(r));
    g.appendChild(box);
    return g;
  }

  refresh() {
    const bang = this.bang, nets = bang.store.networks, net = bang.network;
    const groups = [];

    // Réseau actif : une ligne par réseau (le réseau coché est utilisé par la carte, les formulaires et la détection)
    const netRows = nets.map(n => {
      const r = this._row(n === net ? '<path d="M5 12.5l4.5 4.5L19 7.5"/>' : '<circle cx="12" cy="12" r="7"/>',
        n.name || 'Réseau', (n.services ? n.services.length : 0) + ' service' + (n.services && n.services.length > 1 ? 's' : ''),
        () => { bang.store.setActive(n.id); this._netChanged(); }, n === net ? 'rg-on' : '');
      r.querySelector('.rg-chev').remove();
      return r;
    });
    if (!netRows.length) netRows.push(this._row('<circle cx="12" cy="12" r="7"/>', 'Aucun réseau', 'Importe un jeu de données dans Formulaires › Importer', () => bang.selectNav('feed')));
    groups.push(this._group('Réseau actif', netRows));

    // Données du serveur : état de la dernière synchronisation ; toucher recharge le fichier (remplace les données locales)
    if (window.ServerData) {
      const sd = ServerData, busy = sd.status === 'loading';
      const warn = sd.status === 'missing' || sd.status === 'error';
      const row = this._row('<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7"/><path d="M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5"/>',
        busy ? 'Chargement des données…' : 'Recharger les données du serveur', sd.summary(), busy ? null : async () => {
          const s = await sd.sync(bang, true);
          sd.toast(s === 'synced' ? 'Données du serveur rechargées.'
            : s === 'missing' ? 'Fichier introuvable : ' + sd.url
            : s === 'offline' ? 'Hors ligne : données locales conservées.'
            : 'Échec : ' + sd.detail, s === 'synced' ? '' : 'err');
        }, warn ? 'rg-warn' : '');
      groups.push(this._group('Données', [row]));
    }

    // Autorisation de position : état, demande, aide pour réactiver
    let geo = null;
    if (window.GeoPerm) {
      const ps = GeoPerm.current;
      const sub = ps === 'granted' ? 'Autorisée · utilisée par la carte et la détection'
        : ps === 'prompt' || ps === 'unknown' ? 'Pas encore autorisée · toucher pour la demander'
        : GeoPerm.label(ps) + ' · toucher pour l’aide';
      geo = this._row('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
        'Autorisation de position', sub, () => {
          if (ps === 'prompt' || ps === 'unknown') GeoPerm.ensure();
          else GeoPerm.showHelp(ps === 'granted' ? 'unavailable' : ps);
        }, ps === 'denied' || ps === 'insecure' ? 'rg-warn' : '');
    }

    groups.push(this._group('Outils', [
      geo,
      this._row('<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
        'Détection du service en cours', 'GNSS réel ou trace simulée', () => bang.contexts.open('feed-detect')),
      this._row('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
        'Calendrier de circulation', 'Vacances et jours fériés', () => bang.contexts.open('feed-calendar'))
    ]));

    let fs = null;
    if (window.PWA && PWA.fullscreenSupported()) {
      fs = this._row('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 'Plein écran',
        PWA.isFullscreen() ? 'Activé · toucher pour quitter' : 'Désactivé · toucher pour activer', () => PWA.toggleFullscreen());
    }
    groups.push(this._group('Application', [
      fs,
      this._row('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>', 'Installation et état',
        'Version, mise à jour, hors ligne, données', () => { if (window.PWA) PWA.openPanel(); })
    ]));
    this.list.replaceChildren(...groups);
  }

  // Le réseau actif a changé : la carte, les formulaires et la détection se reconstruisent à leur prochaine ouverture
  _netChanged() { this.refresh(); }

  _injectStyle() {
    if (document.getElementById('rg-style')) return;
    const st = document.createElement('style');
    st.id = 'rg-style';
    st.textContent = `
      .rg-list{padding:.2em 0 1.5em}
      .rg-h{margin:1.2em 1.4em .4em;font-size:.8em;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--inactive-color)}
      .rg-box{margin:0 1em;background:#fff;border-radius:14px;overflow:hidden}
      .rg-row{display:flex;align-items:center;gap:1em;padding:.95em 1em;cursor:pointer;color:var(--text-color);border-top:1px solid #eee;
        -webkit-tap-highlight-color:transparent;user-select:none}
      .rg-row:first-child{border-top:0}
      .rg-row:active{background:#f2f2f2}
      .rg-row>svg{width:24px;height:24px;flex:none;color:var(--accent-color)}
      .rg-row>span{flex:1;min-width:0}
      .rg-row small{display:block;font-size:.8em;margin-top:.15em;color:var(--inactive-color)}
      .rg-row .rg-chev{width:18px;height:18px;flex:none;color:var(--inactive-color)}
      .rg-on>span{font-weight:700;color:var(--accent-color)}
      .rg-warn small{color:#b3261e}
    `;
    document.head.appendChild(st);
  }
}

window.ReglagesContext = ReglagesContext;
