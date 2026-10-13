// bang.js
class Bang {
    /**
     * Crée un div avec textContent, id et className.
     * @param {string} textContent - Le texte à afficher dans le div.
     * @param {string} id - L'identifiant du div.
     * @param {string} className - La classe CSS du div.
     * @returns {HTMLElement} - L'élément div créé.
     */
constructor () {
  this.appground = document.getElementById('app-content');
  this.store = new NetworkStore(this);
  this.initContexts();
  this.buildNavDock();
  this.mkwallet (this.appground);
  // Réseaux d'exploitation : fichier statique du serveur (voir server-data.js) ; la copie locale sert en attendant / hors ligne
  if (window.ServerData && window.DataIO) ServerData.start(this);
  l("on");
}
  initContexts () {
  this.appground.innerHTML = '';
  this.contexts = new ContextManager(this, this.appground);
  // Bang Lab : trois onglets (carte, formulaires du Feed, réglages) ; les pages du Feed s'ouvrent en surcouche
  this.lab = true;
  this.contexts.register(new CarteContext(this, 'carte'));
  this.contexts.register(new FeedContext(this, 'feed'));
  this.contexts.register(new ReglagesContext(this, 'reglages'));
registerFeedPages(this.contexts, this);
}
get network () { return this.store.active; }

getStops () { return this.store.stops(); }
getStopss () {
  const map = new Map();
  ((this.network && this.network.services) || []).forEach(s =>
    s.stopTimes.forEach(st => map.set(st.stop.id, st.stop)));
  return [...map.values()];
}
    mkticket(domdest, ticket, context) {}
    mkwallet(domdest) {
        domdest.style.backgroundColor = '#115E88';
    }
    buildNavDock() {
        const nav = document.getElementById('app-nav');
        if (!nav) return;
        // --- Styles (injectés une seule fois, classes préfixées "nd-") ---
        if (!document.getElementById('nd-style')) {
            const st = document.createElement('style');
            st.id = 'nd-style';
            st.textContent = `
      .nd-item{flex:1;display:flex;flex-direction:column;align-items:center;
        gap:.3em;padding:.6em .2em .2em;cursor:pointer;color:#000;
        -webkit-tap-highlight-color:transparent;user-select:none}
      .nd-item svg{width:28px;height:28px;display:block}
      .nd-label{font-size:.85em;color:var(--inactive-color);font-weight:normal}
      /* réserve la largeur du gras pour éviter tout décalage */
      .nd-label::after{content:attr(data-label);display:block;height:0;
        overflow:hidden;visibility:hidden;font-weight:bold}
      .nd-item.nd-active{color:var(--accent-color)}
      .nd-item.nd-active .nd-label{color:var(--accent-color);font-weight:bold}
    `;
            document.head.appendChild(st);
        }
        // --- Icônes SVG : off = contour, on = version pleine ---
        const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round">${inner}</svg>`;
        const cut = 'var(--navbar-footer-color)'; // couleur des "découpes"
        const items = [{
            id: 'carte',
            label: 'Carte',
            off: svg(`<path d="M6 4h6a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h3"/>
        <path d="M17.5 22s-4-3.2-4-6.2a4 4 0 0 1 8 0c0 3-4 6.2-4 6.2z"/>
        <circle cx="17.5" cy="15.8" r="1.2"/>`),
            on: svg(`<path d="M6 4h6a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h3" stroke-width="2.6"/>
        <path d="M17.5 22s-4-3.2-4-6.2a4 4 0 0 1 8 0c0 3-4 6.2-4 6.2z" fill="currentColor"/>
        <circle cx="17.5" cy="15.8" r="1.4" fill="${cut}" stroke="none"/>`)
        }, {
            id: 'feed',
            label: 'Formulaires',
            off: svg(`<rect x="4" y="5" width="16" height="16" rx="4"/>
        <path d="M8 3v4M16 3v4M8 12h8M8 16h5"/>`),
            on: svg(`<rect x="4" y="5" width="16" height="16" rx="4" fill="currentColor"/>
        <path d="M8 3v4M16 3v4"/>
        <path d="M8 12h8M8 16h5" stroke="${cut}"/>`)
        }, {
            id: 'reglages',
            label: 'Réglages',
            off: svg(`<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>`),
            on: svg(`<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.6" fill="currentColor"/><circle cx="8" cy="17" r="2.6" fill="currentColor"/>`)
        }];
        // --- Construction ---
        this.navItems = {};
        this.navActive = null;
        items.forEach(it => {
            const el = document.createElement('div');
            el.className = 'nd-item';
            el.dataset.id = it.id;
            const icon = document.createElement('div');
            icon.innerHTML = it.off;
            const label = document.createElement('span');
            label.className = 'nd-label';
            label.textContent = it.label;
            label.dataset.label = it.label;
            el.append(icon, label);
            el.addEventListener('click', () => this.selectNav(it.id));
            nav.appendChild(el);
            this.navItems[it.id] = {
                el,
                icon,
                def: it
            };
        });
        // Onglet initial : dernier utilisé, sinon "achat"
        const saved = this.loadFromLocal('nav-active');
        this.selectNav(this.navItems[saved] ? saved : 'carte');
    }
    selectNav(id) {
        if (!this.navItems[id]) return;
if (id === this.navActive) { this.contexts.closeOverlay(); return; }
        // Désactive l'ancien
        const prev = this.navItems[this.navActive];
        if (prev) {
            prev.el.classList.remove('nd-active');
            prev.icon.innerHTML = prev.def.off;
        }
        // Active le nouveau
        const cur = this.navItems[id];
        cur.el.classList.add('nd-active');
        cur.icon.innerHTML = cur.def.on;
        const before = this.navActive;
        this.navActive = id;
        l('onglet : ' + id);
        // ici : charger la vue correspondante dans this.appground
      try {
        this.contexts.show(id);
        this.saveToLocal('nav-active', id);
      } catch (err) {
        // L'ouverture a échoué : on revient à l'onglet précédent (sinon les appuis suivants seraient ignorés)
        console.error('Onglet ' + id + ' :', err);
        const ctx = this.contexts.map[id];
        if (ctx && !ctx.built) { try { ctx.el.replaceChildren(); } catch (e2) {} }
        cur.el.classList.remove('nd-active'); cur.icon.innerHTML = cur.def.off;
        const back = this.navItems[before];
        if (back) { back.el.classList.add('nd-active'); back.icon.innerHTML = back.def.on; }
        this.navActive = before;
        this._navError(id, err);
      }
    }
    _navError(id, err) {
      let t = document.getElementById('nav-err');
      if (!t) {
        t = document.createElement('div'); t.id = 'nav-err';
        t.style.cssText = 'position:fixed;left:.6em;right:.6em;bottom:5em;z-index:5000;background:#b3261e;color:#fff;padding:.7em .9em;border-radius:12px;font-size:.85em;word-break:break-word';
        document.body.appendChild(t);
      }
      t.textContent = 'Impossible d’ouvrir « ' + id + ' » : ' + (err && err.message || err);
      clearTimeout(this._navErrT); this._navErrT = setTimeout(() => t.remove(), 7000);
    }
    saveToLocal(key, value) {
        try {
            const serialized = JSON.stringify(value);
            localStorage.setItem(key, serialized);
            console.log(`✅ Données sauvegardées sous la clé "${key}".`);
        } catch (e) {
            console.error("❌ Erreur lors de la sauvegarde dans LocalStorage :", e);
        }
    }
    loadFromLocal(key) {
        try {
            const serialized = localStorage.getItem(key);
            if (serialized === null) {
                console.warn(`⚠️ Aucune donnée trouvée sous la clé "${key}".`);
                return null;
            }
            return JSON.parse(serialized);
        } catch (e) {
            console.error("❌ Erreur lors du chargement depuis LocalStorage :", e);
            return null;
        }
    }
    removeFromLocal(key) {
        try {
            localStorage.removeItem(key);
            console.log(`🗑️ Données supprimées sous la clé "${key}".`);
        } catch (e) {
            console.error("❌ Erreur lors de la suppression dans LocalStorage :", e);
        }
    }
    createElement(type, textContent, classString, id, data, eventType, callback) {
        let element = document.createElement(type);
        element.innerHTML = textContent;
        element.className = classString;
        if (classString) {}
        if (id) {
            element.id = id;
        }
        if (data) {
            for (let key in data) {
                element.setAttribute(`data-${key}`, data[key]);
            }
        }
        if (eventType && callback) {
            element.addEventListener(eventType, callback);
        }
        return element;
    }
    div(textContent, classString, id, data, eventType, callback) {
        let div = this.createElement('div', textContent, classString, id, data, eventType, callback);
        return div;
    }
    fullsvg(domTarget, id, className, backgroundColor) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svg.setAttribute('version', '1.1');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('viewBox', '0 0 ' + domTarget.clientWidth + ' ' + domTarget.clientHeight);
        if (id) svg.id = id;
        if (className) svg.classList.add(className);
        svg.style.position = 'absolute';
        svg.style.top = '0';
        svg.style.left = '0';
        svg.style.zIndex = '999'; // Ajustable selon tes besoins
        domTarget.style.position = 'relative'; // Assure le contexte de positionnement
        // Si backgroundColor est défini, ajoute un <rect> de fond
        if (backgroundColor) {
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', '0');
            rect.setAttribute('y', '0');
            rect.setAttribute('width', '100%');
            rect.setAttribute('height', '100%');
            rect.setAttribute('fill', backgroundColor);
            svg.appendChild(rect);
        }
        domTarget.appendChild(svg);
        return svg;
    }
    ic(icn) {
        const ic = this.createElement('span', '', icn);
        return ic;
    }
    //class Bang
}
// Exporter si besoin (optionnel)
window.Bang = Bang;