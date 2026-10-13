// geo-perm.js — autorisation d'accès à la position (GNSS), partagée par la Carte, la détection et les Réglages.
//   GeoPerm.state()     -> Promise : 'granted' | 'prompt' | 'denied' | 'unknown' | 'insecure' | 'unsupported'
//   GeoPerm.request()   -> Promise {ok, state, error} : déclenche la demande du navigateur (getCurrentPosition)
//   GeoPerm.on(fn)      -> abonnement aux changements d'état (renvoie la fonction de désabonnement)
//   GeoPerm.showHelp(k) -> feuille d'aide : comment autoriser / réactiver ('denied', 'insecure', 'unavailable'…)
// Un navigateur ne repose jamais la question après un refus : il faut alors passer par les réglages du site.
// La position n'existe que dans un contexte sécurisé (https:// ou localhost).

const GeoPerm = {
  _st: null,
  _subs: new Set(),
  _ps: null,
  _denied: false,   // refus constaté alors que le navigateur annonce encore « prompt » (question bloquée par Chrome)

  get current() { return this._st; },

  label(s) {
    return ({
      granted: 'Autorisée', prompt: 'À demander', denied: 'Refusée', unknown: 'Demandée au démarrage',
      insecure: 'Indisponible (adresse non sécurisée)', unsupported: 'Non prise en charge'
    })[s || this._st] || '…';
  },

  async state() {
    if (!window.isSecureContext) return this._set('insecure');
    if (!navigator.geolocation) return this._set('unsupported');
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const ps = this._ps || await navigator.permissions.query({ name: 'geolocation' });
        if (!this._ps) {
          this._ps = ps;
          ps.addEventListener('change', () => { this._denied = false; this._set(ps.state); });
        }
        return this._set(ps.state === 'prompt' && this._denied ? 'denied' : ps.state);
      } catch (e) { /* API absente (anciens navigateurs) : on ne sait pas avant d'essayer */ }
    }
    return this._set(this._st === 'granted' || this._st === 'denied' ? this._st : 'unknown');
  },

  _set(s) {
    if (s !== this._st) {
      this._st = s;
      this._subs.forEach(f => { try { f(s); } catch (e) { console.error(e); } });
    }
    return s;
  },

  on(fn) { this._subs.add(fn); return () => this._subs.delete(fn); },

  // Erreur reçue d'un appel géolocalisation ailleurs dans l'appli : met l'état à jour
  noteError(err) {
    if (err && err.code === 1) { this._denied = true; this._set('denied'); }
    else if (err && (err.code === 2 || err.code === 3) && this._st !== 'granted') this.state();
  },
  noteSuccess() { this._denied = false; this._set('granted'); },

  // Déclenche la demande. Résout {ok, state, error : 'denied' | 'unavailable' | 'timeout' | 'insecure' | 'unsupported'}
  async request() {
    const s = await this.state();
    if (s === 'insecure' || s === 'unsupported') return { ok: false, state: s, error: s };
    return new Promise(res => {
      navigator.geolocation.getCurrentPosition(
        () => { this._denied = false; res({ ok: true, state: this._set('granted') }); },
        err => {
          // Chrome bloque parfois la question sans l'afficher (après plusieurs refus) : même traitement qu'un refus
          if (err.code === 1) { this._denied = true; res({ ok: false, state: this._set('denied'), error: 'denied' }); }
          else res({ ok: false, state: this._st === 'prompt' || this._st === 'unknown' ? this._set('granted') : this._st,
            error: err.code === 2 ? 'unavailable' : 'timeout' });
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    });
  },

  // Demande, puis aide si nécessaire ; résout true si l'accès est obtenu
  async ensure() {
    const r = await this.request();
    if (!r.ok) this.showHelp(r.error);
    return r.ok;
  },

  // ----- Feuille d'aide -----------------------------------------------------------------------------
  showHelp(kind) {
    this._style();
    const old = document.getElementById('gp-sheet');
    if (old) old.remove();
    const e = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
    const installed = window.matchMedia && matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
    const C = {
      denied: ['Accès à la position refusé',
        'Le navigateur ne repose pas la question après un refus : il faut réautoriser le site.',
        installed ? [
          'Appui long sur l’icône <b>Bang Lab</b> › <b>Infos sur l’appli</b> › <b>Autorisations</b> › <b>Position</b> › <b>Autoriser</b>.',
          'Si l’option n’y est pas : dans Chrome, <b>⋮</b> › <b>Paramètres</b> › <b>Paramètres des sites</b> › <b>Position</b>, puis touche l’adresse de Bang Lab et choisis <b>Autoriser</b>.',
          'Reviens ici et touche <b>Réessayer</b>.'
        ] : [
          'Touche l’icône à gauche de l’adresse (réglages / cadenas) › <b>Autorisations</b> › <b>Position</b> › <b>Autoriser</b>.',
          'Ou : <b>⋮</b> › <b>Paramètres</b> › <b>Paramètres des sites</b> › <b>Position</b>, puis l’adresse de Bang Lab.',
          'Reviens ici et touche <b>Réessayer</b>.'
        ]],
      insecure: ['Adresse non sécurisée',
        'Les navigateurs ne donnent la position qu’aux pages servies en <b>https://</b> (ou depuis <b>localhost</b>). Adresse actuelle : <code>' +
          location.origin.replace(/</g, '&lt;') + '</code>',
        [
          'Sers Bang Lab en <b>https://</b> (certificat valide) sur ton serveur de test.',
          'Sur le téléphone qui fait tourner le serveur : ouvre-le par <b>http://localhost:…</b>, qui est accepté.',
          'Pour un essai rapide sur Chrome Android : <b>chrome://flags</b> › « Insecure origins treated as secure », ajoute <code>' +
            location.origin.replace(/</g, '&lt;') + '</code>, puis relance Chrome.'
        ]],
      unavailable: ['Position introuvable',
        'L’accès est autorisé, mais l’appareil ne fournit pas de position.',
        [
          'Active la <b>Localisation</b> d’Android (volet des réglages rapides).',
          'Dans Paramètres › Localisation, active la <b>précision de la localisation</b> (Wi-Fi et réseau en plus du GPS).',
          'À l’intérieur, le GPS peut mettre du temps : approche-toi d’une fenêtre, puis <b>Réessayer</b>.'
        ]],
      timeout: ['Position trop lente',
        'Aucune position reçue à temps. Le GPS cherche encore les satellites.',
        ['Reste à découvert quelques instants, puis touche <b>Réessayer</b>.']],
      unsupported: ['Position non prise en charge', 'Ce navigateur ne propose pas la géolocalisation.', ['Essaie avec Chrome ou Firefox à jour.']]
    };
    const [title, intro, steps] = C[kind] || C.denied;
    const back = e('div', 'gp-back');
    back.id = 'gp-sheet';
    const sh = e('div', 'gp-sheet');
    sh.setAttribute('role', 'dialog');
    sh.setAttribute('aria-modal', 'true');
    sh.append(e('i', 'gp-grip'), e('b', 'gp-t', title), e('p', 'gp-p', intro));
    const ol = e('ol', 'gp-ol');
    steps.forEach(s => ol.appendChild(e('li', null, s)));
    sh.appendChild(ol);
    const st = e('small', 'gp-st', 'État actuel : ' + this.label());
    sh.appendChild(st);
    const acts = e('div', 'gp-acts');
    const close = () => { back.classList.remove('in'); setTimeout(() => back.remove(), 200); off(); };
    const off = this.on(s => { st.textContent = 'État actuel : ' + this.label(s); if (s === 'granted') close(); });
    const bClose = e('button', 'gp-b2', 'Fermer');
    bClose.type = 'button';
    bClose.addEventListener('click', close);
    acts.appendChild(bClose);
    if (kind !== 'unsupported') {
      const bTry = e('button', 'gp-b1', 'Réessayer');
      bTry.type = 'button';
      bTry.addEventListener('click', async () => {
        bTry.disabled = true; bTry.textContent = 'Demande…';
        const r = await this.request();
        bTry.disabled = false; bTry.textContent = 'Réessayer';
        if (r.ok) close();
        else if (r.error !== kind) { close(); this.showHelp(r.error); }
        else st.textContent = 'État actuel : ' + this.label() + ' · toujours bloqué';
      });
      acts.appendChild(bTry);
    }
    sh.appendChild(acts);
    back.appendChild(sh);
    back.addEventListener('click', ev => { if (ev.target === back) close(); });
    document.body.appendChild(back);
    requestAnimationFrame(() => back.classList.add('in'));
  },

  _style() {
    if (document.getElementById('gp-style')) return;
    const st = document.createElement('style');
    st.id = 'gp-style';
    st.textContent = `
      .gp-back{position:fixed;inset:0;z-index:1000;background:rgba(10,30,45,0);display:flex;align-items:flex-end;justify-content:center;transition:background .2s}
      .gp-back.in{background:rgba(10,30,45,.45)}
      .gp-sheet{width:100%;max-width:560px;background:#fff;border-radius:22px 22px 0 0;padding:.6em 1.3em calc(1.2em + env(safe-area-inset-bottom));
        transform:translateY(100%);transition:transform .2s ease-out;max-height:85vh;overflow-y:auto;box-sizing:border-box}
      .gp-back.in .gp-sheet{transform:none}
      .gp-grip{display:block;width:44px;height:5px;border-radius:3px;background:#d0d7de;margin:0 auto .9em}
      .gp-t{display:block;font-size:1.15em;color:var(--accent-color,#115e88)}
      .gp-p{margin:.5em 0 .2em;line-height:1.45;color:#333}
      .gp-p code,.gp-ol code{font-size:.85em;background:#eef3f7;border-radius:6px;padding:.05em .35em;word-break:break-all}
      .gp-ol{margin:.6em 0 0;padding-left:1.3em;line-height:1.5}
      .gp-ol li{margin:.35em 0}
      .gp-st{display:block;margin-top:.8em;color:var(--inactive-color,#666)}
      .gp-acts{display:flex;gap:.6em;margin-top:1em}
      .gp-b1,.gp-b1:hover,.gp-b2,.gp-b2:hover{flex:1;border-radius:14px;padding:.75em;font-weight:600;font-size:.95em}
      .gp-b1,.gp-b1:hover{background:var(--accent-color,#115e88);color:#fff}
      .gp-b2,.gp-b2:hover{background:#eef3f7;color:var(--accent-color,#115e88)}
      .gp-b1[disabled]{opacity:.6}
    `;
    document.head.appendChild(st);
  }
};

// Retour des réglages Android : l'état a pu changer
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && GeoPerm._st) GeoPerm.state(); });
window.GeoPerm = GeoPerm;
