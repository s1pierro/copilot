// ctx-carte.js — contexte « Carte » (superposé, ouvert depuis Compte).
// Réutilise le module LightMap (smap.js, inchangé) : fond OpenStreetMap (Overpass, mis en cache dans IndexedDB)
// et superpose les arrêts et les lignes du réseau actif. Toucher un arrêt ouvre sa fiche.

class NetMap extends LightMap {
  // Cadre (centre + demi-étendue en mètres Mercator) qui contient tous les arrêts géolocalisés
  static frame(stops) {
    const R = 6378137, d = Math.PI / 180;
    const pr = s => ({ x: s.lon * d * R, y: R * Math.log(Math.tan(Math.PI / 4 + s.lat * d / 2)) });
    const pts = stops.map(pr);
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const half = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2;
    return {
      target: (2 * Math.atan(Math.exp(cy / R)) - Math.PI / 2) / d + ',' + (cx / R) / d,
      size: Math.max(half * 1.2, 250) + 150
    };
  }

  // net : réseau (Network) ; onStop(stop) appelé au toucher d'un arrêt.
  // Les champs sont posés juste après super() : le premier `await` de loadMap() laisse le temps de les définir.
  constructor(container, net, onStop) {
    const f = NetMap.frame(net.stops.filter(s => s.lat !== null && s.lon !== null));
    super(container, f.target, f.size * 1.6);   // zone chargée plus large que la vue : on peut se déplacer sans recharger
    this.net = net;
    this.onStop = onStop;
    this.me = null;
    this.status = null;
    this.onLine = null;
    this.sel = null;
    // Vue courante (centre + demi-largeur) en unités Mercator du module ; la zone chargée peut être plus grande que la vue
    this.R = 6378137;
    this.home = { cx: (this.bbox.minX + this.bbox.maxX) / 2, cy: (this.bbox.minY + this.bbox.maxY) / 2, hv: f.size / 6378137 };
    this.view = { ...this.home };        // vue visée (suit les doigts)
    this.committed = { ...this.home };   // vue réellement dessinée (viewBox du SVG)
    this.hvMin = 60 / this.R;
    this.hvMax = Math.max(this.home.hv * 4, 150000 / this.R);   // jusqu'à ~300 km de large : une région
    this._initGestures();
    this._setViewBox(this.committed);
    this.svgrender.addEventListener('click', ev => {
      const l = ev.target.closest && ev.target.closest('[data-svc]');
      const t = ev.target.closest && ev.target.closest('[data-stop]');
      if (!t && l) {
        const sv = this.net.services.find(x => x.id === l.getAttribute('data-svc'));
        if (sv && this.onLine) this.onLine(sv);
        return;
      }
      if (!t) return;
      const stop = this.net.stops.find(s => s.id === t.getAttribute('data-stop'));
      if (stop && this.onStop) this.onStop(stop);
    });
  }

  // --- Interface (remplace les boutons d'origine, dont les icônes dépendaient d'une autre feuille de style)
  initControls() {
    const ico = inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    this.container.style.position = 'relative';
    const bar = document.createElement('div');
    bar.className = 'lm-bar';
    const mk = (label, svg, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lm-btn';
      b.setAttribute('aria-label', label);
      b.innerHTML = svg;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    const panel = document.createElement('div');
    panel.className = 'lm-panel';
    panel.hidden = true;
    mk('Calques', ico('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'), () => { panel.hidden = !panel.hidden; });
    mk('Ma position', ico('<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'), () => this.locate());
    mk('Tout le réseau', ico('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'), () => this.recenter());
    const zoom = document.createElement('div');
    zoom.className = 'lm-bar lm-zoom';
    [['Zoom avant', '+', 1.6], ['Zoom arrière', '−', 1 / 1.6]].forEach(([label, t, f]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lm-btn lm-z';
      b.setAttribute('aria-label', label);
      b.textContent = t;
      b.addEventListener('click', () => this._zoomBy(f));
      zoom.appendChild(b);
    });
    this.container.append(bar, zoom, panel);
    this.ctrlPanel = panel;
    this.ctrlPanelContent = panel;
  }
  createControlPanel() {}
  createLocateButton() {}

  addLayerControls() {
    const layers = [
      ['Routes', 'g.ground-layer path[stroke]'],
      ['Bâtiments', "g.ground-layer path[fill='#999']"],
      ['Nature', "g.ground-layer path[fill='#6c6'], g.ground-layer path[fill='#66c'], g.ground-layer path[fill='#385'], g.ground-layer path[fill='#eec']"],
      ['Villes', 'g.ground-layer text, g.ground-layer circle'],
      ['Réseau', 'g.lm-net']
    ];
    layers.forEach(([label, sel]) => {
      const l = document.createElement('label');
      const i = document.createElement('input');
      i.type = 'checkbox';
      i.checked = true;
      i.addEventListener('change', () => {
        this.svgrender.querySelectorAll(sel).forEach(el => { el.style.visibility = i.checked ? 'visible' : 'hidden'; });
      });
      l.append(i, document.createTextNode(' ' + label));
      this.ctrlPanel.appendChild(l);
    });
  }

  // --- Données : requête adaptée à l'échelle (un réseau régional couvre des dizaines de km)
  async fetchGeoData(forceRefresh = false) {
    const key = 'LightMapCache_net_' + this.targetbbox.string;
    if (!forceRefresh) {
      const cached = await this.dbGet('geoCache', key);
      if (cached) { this.geoData = cached; return cached; }
    }
    const bb = this.targetbbox.string, diag = this.getDiagonalKm();
    const hw = diag > 250 ? 'motorway'
      : diag > 60 ? 'motorway|trunk'
      : diag > 20 ? 'motorway|trunk|primary|secondary|tertiary'
      : diag > 5 ? 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road' : '';
    const parts = [hw ? `way["highway"~"^(${hw})$"](${bb});` : `way["highway"](${bb});`];
    if (diag < 2) parts.push(`way["building"](${bb});`);
    if (diag < 40) {
      parts.push(`way["natural"~"water|wood"](${bb});`);
      if (diag < 20) parts.push(`way["landuse"~"forest|meadow|grass|vineyard|orchard|farmland"](${bb});`, `way["leisure"~"park|garden|nature_reserve"](${bb});`);
    }
    parts.push(`node["place"~"${diag > 100 ? 'city' : diag > 20 ? 'city|town' : 'city|town|village'}"](${bb});`);
    const query = `[out:json][timeout:${diag > 100 ? 60 : 30}];(${parts.join('')});out geom;`;
    this.geoData = await this.fetchWithRetry('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query), 2, 1200);
    await this.dbSet('geoCache', key, this.geoData);
    return this.geoData;
  }
  async fetchAgglomerationData() { this.agglomerationData = null; }   // inutile à cette échelle

  // Le réseau s'affiche même si le fond de carte est indisponible (hors ligne, serveur occupé)
  async loadMap() {
    let ok = true;
    try { await this.fetchGeoData(); } catch (e) { ok = false; console.warn('Carte : fond indisponible', e); }
    this.render();
    this.addLayerControls();
    this.fond = ok;
    if (this.status) this.status(ok);
  }

  // --- Dessin
  render() {
    super.render();
    this.drawNetwork();
    if (this.committed) { this._setViewBox(this.committed); this._paint(); }
  }

  drawNetwork() {
    const NS = 'http://www.w3.org/2000/svg';
    const proj = this.getProjection(500, 500, 10);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'lm-net');
    const el = (tag, attrs) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); return n; };
    const pt = s => proj(s.lon, s.lat);
    const has = s => s.lat !== null && s.lon !== null;

    // Lignes : tracé blanc dessous, couleur symbolique du service dessus
    const paths = this.net.services.map(sv => ({ sv, pts: sv.path().map(([la, lo]) => { const p = proj(lo, la); return p.x.toFixed(1) + ',' + p.y.toFixed(1); }) }))
      .filter(x => x.pts.length >= 2);
    // Sans sélection : tous les tracés en noir. Avec une sélection : seul ce service, en couleurs symboliques.
    const shown = paths.filter(x => !this.sel || this.sel.includes(x.sv.id));
    shown.forEach(({ sv, pts }) => {       // liseré
      g.appendChild(el('polyline', { points: pts.join(' '), fill: 'none', stroke: this.sel ? '#111' : '#fff', 'stroke-width': this.sel ? 6.5 : 5.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: this.sel ? 1 : .9 }));
    });
    shown.forEach(({ sv, pts }) => {       // trait : plein si le tracé routier est calculé, pointillé (lignes droites) sinon
      const a = { points: pts.join(' '), fill: 'none', stroke: this.sel ? (sv.symcolor0 || '#115e88') : '#111', 'stroke-width': 3, 'stroke-linejoin': 'round' };
      if (sv.shapeValid) a['stroke-linecap'] = 'round'; else a['stroke-dasharray'] = '7 5';
      g.appendChild(el('polyline', a));
    });
    shown.forEach(({ sv, pts }) => {       // zone de toucher élargie
      g.appendChild(el('polyline', { points: pts.join(' '), fill: 'none', stroke: 'transparent', 'stroke-width': 18, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-svc': sv.id, style: 'cursor:pointer' }));
    });

    // Arrêts : terminus = carré plein + libellé ; intermédiaire = petit rond blanc sans libellé (même signalétique que GLNet)
    const svs = this.sel ? this.sel.map(i => this.net.services.find(x => x.id === i)).filter(Boolean) : null;
    const roles = Network.stopRoles(svs || this.net.services);
    const col = svs ? ((svs.find(x => x.symcolor0) || {}).symcolor0 || '#115e88') : '#111111';
    this.net.stops.filter(has).forEach(s => {
      const p = pt(s);
      const role = roles.get(s.id);
      if (svs && !role) return;                            // arrêt non desservi par la sélection
      if (role !== 'end') {                                // intermédiaire : petit repère, sans libellé
        g.appendChild(el('circle', { cx: p.x, cy: p.y, r: 3.4, fill: '#fff', stroke: col, 'stroke-width': 2 }));
        g.appendChild(el('circle', { cx: p.x, cy: p.y, r: 12, fill: 'transparent', 'data-stop': s.id, style: 'cursor:pointer' }));
        return;
      }
      g.appendChild(el('rect', { x: p.x - 6.5, y: p.y - 6.5, width: 13, height: 13, rx: 3.5, fill: col, stroke: '#fff', 'stroke-width': 2.2 }));
      const t = el('text', { x: p.x + 10, y: p.y + 4, 'font-size': 12, 'font-weight': 'bold', 'font-family': 'Arial, sans-serif', fill: '#0b3a56',
        stroke: '#fff', 'stroke-width': 3.5, 'paint-order': 'stroke', 'stroke-linejoin': 'round' });
      t.textContent = s.city || s.name;
      g.appendChild(t);
      g.appendChild(el('circle', { cx: p.x, cy: p.y, r: 16, fill: 'transparent', 'data-stop': s.id, style: 'cursor:pointer' }));
    });

    if (this.me) {
      const p = proj(this.me.lon, this.me.lat);
      if (p.x >= 0 && p.x <= 500 && p.y >= 0 && p.y <= 500) {
        g.appendChild(el('circle', { cx: p.x, cy: p.y, r: 16, fill: '#3b82f6', opacity: .2 }));
        g.appendChild(el('circle', { cx: p.x, cy: p.y, r: 6, fill: '#3b82f6', stroke: '#fff', 'stroke-width': 2.5 }));
      }
    }
    this.layers.top.replaceChildren(g);
  }

  // --- Vue : translation et zoom ------------------------------------------------------------------
  // La vue est exprimée en coordonnées géographiques (Mercator) ; seule la fenêtre (viewBox) du SVG change
  // pendant le geste. Une fois le geste terminé, la zone chargée est recalculée si besoin (_settle).
  // Pendant un geste, le SVG n'est PAS redessiné : on déplace et agrandit son calque par transformation CSS
  // (composition GPU, fluide). Le geste terminé, la vue est « validée » : nouveau viewBox, rendu net.
  _setViewBox(v) {
    const b = this.bbox;
    const W = (b.maxX - b.minX) || 1, H = (b.maxY - b.minY) || 1, P = 10, S = 480;
    const x0 = P + (v.cx - v.hv - b.minX) / W * S;
    const y0 = P + (1 - (v.cy + v.hv - b.minY) / H) * S;
    const w = 2 * v.hv / W * S, h = 2 * v.hv / H * S;
    this.svgrender.setAttribute('viewBox', `${x0.toFixed(2)} ${y0.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`);
    // Pastilles et textes gardent la même taille à l'écran : contre-échelle autour de leur point d'ancrage
    const k = w / 500, wide = v.hv > this.home.hv * 2.5;
    this.svgrender.querySelectorAll('circle,text').forEach(n => {
      const isT = n.tagName === 'text';
      if (isT && n.closest('.lm-net')) n.style.display = wide ? 'none' : '';   // vue très large : pas de libellés d'arrêts
      const ax = +n.getAttribute(isT ? 'x' : 'cx'), ay = +n.getAttribute(isT ? 'y' : 'cy');
      if (Math.abs(k - 1) < 0.001) n.removeAttribute('transform');
      else n.setAttribute('transform', `translate(${ax} ${ay}) scale(${k.toFixed(4)}) translate(${-ax} ${-ay})`);
    });
  }

  // Transformation CSS qui amène la vue validée (committed) sur la vue visée (view)
  _paint() {
    const c = this.committed, v = this.view, r = this.container.getBoundingClientRect();
    const s = c.hv / v.hv;
    if (Math.abs(s - 1) < 1e-6 && Math.abs(c.cx - v.cx) < 1e-12 && Math.abs(c.cy - v.cy) < 1e-12) { this.svgrender.style.transform = ''; return; }
    const tx = (c.cx - v.cx) / (2 * v.hv) * r.width, ty = (v.cy - c.cy) / (2 * v.hv) * r.height;
    this.svgrender.style.transform = `translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) scale(${s})`;
  }

  commit() {
    this.committed = { ...this.view };
    this._setViewBox(this.committed);
    this.svgrender.style.transform = '';
  }

  // Valide la vue peu après la fin du geste (jamais pendant que des doigts sont posés), puis recharge si besoin
  _commitSoon(delay = 140) {
    clearTimeout(this._ct);
    this._ct = setTimeout(() => {
      if (this._down) { this._commitSoon(delay); return; }
      this.commit();
      this._settleSoon();
    }, delay);
  }

  _screenToWorld(sx, sy, v = this.view) {
    const r = this.container.getBoundingClientRect();
    return { x: v.cx + ((sx - r.left) / r.width - .5) * 2 * v.hv, y: v.cy - ((sy - r.top) / r.height - .5) * 2 * v.hv };
  }

  // Zoom d'un facteur f : le point `p0` (écran, avant) se retrouve en `p1` (écran, après) — translation incluse
  _transform(f, p0, p1) {
    const v = this.view, r = this.container.getBoundingClientRect();
    const w = this._screenToWorld(p0.x, p0.y);
    const hv = Math.min(this.hvMax, Math.max(this.hvMin, v.hv / f));
    this.view = {
      hv,
      cx: w.x - ((p1.x - r.left) / r.width - .5) * 2 * hv,
      cy: w.y + ((p1.y - r.top) / r.height - .5) * 2 * hv
    };
    if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._paint(); });
  }

  _zoomBy(f) {
    const r = this.container.getBoundingClientRect(), c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    this._transform(f, c, c);
    this._commitSoon(220);
  }

  recenter() {
    this.view = { ...this.home };
    this._paint();
    this._commitSoon(0);
  }

  _initGestures() {
    const el = this.container, pts = new Map();
    el.style.touchAction = 'none';
    let moved = 0, suppress = false;
    const ui = t => t.closest && t.closest('.lm-bar,.lm-panel');
    const geom = () => {
      const a = [...pts.values()];
      const c = { x: a.reduce((s, p) => s + p.x, 0) / a.length, y: a.reduce((s, p) => s + p.y, 0) / a.length };
      return { c, d: a.length > 1 ? Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) : 0 };
    };
    el.addEventListener('pointerdown', e => {
      if (ui(e.target) || pts.size >= 2) return;
      if (!pts.size) moved = 0;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._down = true;
      clearTimeout(this._st);   // pas de rechargement pendant un geste
    });
    window.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      const before = geom();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const after = geom();
      moved += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0) || Math.hypot(after.c.x - before.c.x, after.c.y - before.c.y);
      const f = before.d && after.d ? after.d / before.d : 1;
      this._transform(f, before.c, after.c);
    });
    const end = e => {
      if (!pts.delete(e.pointerId)) return;
      if (moved > 6) { suppress = true; setTimeout(() => { suppress = false; }, 350); }
      if (!pts.size) { this._down = false; this._commitSoon(); }
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    // Un glissement ne doit pas compter comme un toucher d'arrêt
    el.addEventListener('click', e => { if (suppress) { e.stopPropagation(); e.preventDefault(); suppress = false; } }, true);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const p = { x: e.clientX, y: e.clientY };
      this._transform(Math.exp(-e.deltaY * 0.0015), p, p);
      this._commitSoon(180);
    }, { passive: false });
    el.addEventListener('dblclick', e => {
      if (ui(e.target)) return;
      const p = { x: e.clientX, y: e.clientY };
      this._transform(2, p, p);
      this._commitSoon(220);
    });
  }

  // --- Rechargement des données une fois le geste terminé : zone adaptée à la vue (niveaux 150 m × 2^n,
  // centre calé sur une grille : les zones reviennent identiques, donc servies par le cache IndexedDB).
  _settleSoon() {
    clearTimeout(this._st);
    this._st = setTimeout(() => this._settle(), 450);
  }

  async _settle() {
    if (this._busy) { this._again = true; return; }
    if (this._down) return;
    const b = this.bbox, v = this.view, half = (b.maxX - b.minX) / 2;
    const inside = v.cx - v.hv >= b.minX && v.cx + v.hv <= b.maxX && v.cy - v.hv >= b.minY && v.cy + v.hv <= b.maxY;
    if (inside && v.hv >= half / 3) return;
    const R = this.R;
    const size = 150 * Math.pow(2, Math.ceil(Math.log2(Math.max(1, 1.6 * v.hv * R / 150))));
    const g = size / 2;
    const c = this.mercatorUnproject(Math.round(v.cx * R / g) * g / R, Math.round(v.cy * R / g) * g / R);
    const target = c.lat.toFixed(6) + ',' + c.lon.toFixed(6);
    const key = target + '|' + size;
    if (key === this._key || key === this._failed) return;

    this._busy = true;
    const old = { t: this.targetbbox, b: this.bbox, g: this.geoData };
    if (this.status) this.status(null);
    try {
      this.updateBBox(target, size);
      await this.fetchGeoData();
      this._key = key;
      this.render();
      if (this.status) this.status(true);
    } catch (e) {
      this.targetbbox = old.t; this.bbox = old.b; this.geoData = old.g;   // on garde l'affichage actuel
      this._failed = key;
      if (this.status) this.status(false, true);
    }
    this._busy = false;
    if (this._again) { this._again = false; this._settleSoon(); }
  }

  destroy() { this.container.replaceChildren(); }

  // Position en direct (bandeau de détection) : simple repère, sans suivi de la vue
  setMe(lat, lon) { this.me = { lat, lon }; this.drawNetwork(); }

  focus(id) { const ids = Array.isArray(id) ? id.filter(Boolean) : (id ? [id] : []); this.sel = ids.length ? ids : null; this.drawNetwork(); }

  // Position de l'utilisateur ; renvoie l'arrêt le plus proche (avec la distance en mètres)
  async locate() {
    const pos = await this.getCurrentPosition();
    if (!pos) return { error: true };
    this.me = pos;
    this.drawNetwork();
    const m = this.mercatorProject(pos.lon, pos.lat);
    this.view = { cx: m.x, cy: m.y, hv: Math.min(this.view.hv, 2000 / this.R) };
    this._paint();
    this._commitSoon(0);
    const rad = Math.PI / 180;
    let best = null;
    this.net.stops.filter(s => s.lat !== null && s.lon !== null).forEach(s => {
      const a = Math.sin((s.lat - pos.lat) * rad / 2) ** 2 + Math.cos(pos.lat * rad) * Math.cos(s.lat * rad) * Math.sin((s.lon - pos.lon) * rad / 2) ** 2;
      const m = 2 * 6371000 * Math.asin(Math.sqrt(a));
      if (!best || m < best.m) best = { stop: s, m };
    });
    if (this.onLocate) this.onLocate(best);
    return best;
  }
}

class CarteContext extends Context {
  defaultState() { return { split: 0.4 }; }   // part de la hauteur occupée par la carte (entre 0,3 et 0,7)

  // Mise en page : la carte est ancrée en haut, sur toute la largeur ; le panneau d'informations occupe le reste et défile.
  // Une poignée entre les deux règle le ratio (chaque partie garde au moins 30 % de la hauteur).
  build(el) {
    this._injectStyle();
    el.classList.add('cm-ctx');
    this.mapbox = document.createElement('div');
    this.mapbox.className = 'cm-mapbox';
    this.split = document.createElement('div');
    this.split.className = 'cm-split';
    this.split.setAttribute('role', 'separator');
    this.split.setAttribute('aria-orientation', 'horizontal');
    this.split.setAttribute('aria-label', 'Redimensionner la carte');
    this.split.tabIndex = 0;
    this.split.appendChild(document.createElement('i'));

    this.panel = document.createElement('div');
    this.panel.className = 'cm-panel';
    this.sub = document.createElement('small');
    this.sub.className = 'cm-net';
    this.bar = document.createElement('div');
    this.bar.className = 'cm-bar';
    this.bar.hidden = true;
    this.legend = document.createElement('div');
    this.legend.className = 'cm-legend';
    this.legend.hidden = true;
    this.msg = document.createElement('div');
    this.msg.className = 'cm-msg';
    this.card = document.createElement('div');
    this.card.className = 'cm-card';
    this.card.hidden = true;
    this.foot = document.createElement('div');
    this.foot.className = 'cm-foot';
    this.panel.append(this.bar, this.sub, this.legend, this.msg, this.card, this.foot);

    // Bandeau de détection du service en cours : entre la carte (et sa poignée) et le panneau
    this.detect = window.DetectBand ? new DetectBand(this) : null;
    // un défilement fait au doigt suspend un moment le défilement automatique du suivi
    ['touchstart', 'wheel', 'pointerdown'].forEach(t => this.panel.addEventListener(t, () => { this._userScroll = Date.now(); }, { passive: true }));
    el.append(this.mapbox, this.split);
    if (this.detect) el.appendChild(this.detect.el);
    el.appendChild(this.panel);
    this._initSplit(el);
    if (window.ResizeObserver) new ResizeObserver(() => this._layout()).observe(el);
  }

  _ratio() {
    const r = Number(this.state.split);
    return Number.isFinite(r) ? Math.min(0.7, Math.max(0.3, r)) : 0.4;
  }

  // Applique le ratio : hauteur de la carte, puis adaptation du moteur à sa nouvelle taille
  _layout() {
    const H = this.el.clientHeight;
    if (!H) return;
    this.mapbox.style.height = Math.round(H * this._ratio()) + 'px';
    this._sizeHolder();
  }

  _sizeHolder() {
    const h = this.holder;
    if (!h || !this.map) return;
    const W = this.mapbox.clientWidth, H = this.mapbox.clientHeight;
    if (this.engine === 'gl') {
      Object.assign(h.style, { left: '0', top: '0', width: '100%', height: '100%' });
      if (this.map.resize) this.map.resize();
    } else {                              // carte SVG de secours : carrée, centrée dans la zone
      const q = Math.max(60, Math.min(W, H));
      Object.assign(h.style, { width: q + 'px', height: q + 'px', left: ((W - q) / 2) + 'px', top: ((H - q) / 2) + 'px' });
    }
  }

  _initSplit(el) {
    let drag = false;
    const apply = r => {
      this.state.split = Math.min(0.7, Math.max(0.3, r));
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._layout(); });
    };
    this.split.addEventListener('pointerdown', ev => { drag = true; this.split.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    this.split.addEventListener('pointermove', ev => {
      if (!drag) return;
      const r = el.getBoundingClientRect();
      apply((ev.clientY - r.top - 13) / r.height);      // 13 px : milieu de la poignée
    });
    const end = () => { if (drag) { drag = false; this.save(); } };
    this.split.addEventListener('pointerup', end);
    this.split.addEventListener('pointercancel', end);
    this.split.addEventListener('dblclick', () => { apply(this._ratio() < 0.55 ? 0.7 : 0.4); this.save(); });   // double toucher : agrandir / revenir à 40 %
    this.split.addEventListener('keydown', ev => {
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
      ev.preventDefault();
      apply(this._ratio() + (ev.key === 'ArrowDown' ? 0.05 : -0.05));
      this.save();
    });
  }

  // Ouvre la carte et localise l'utilisateur : fiche de l'arrêt le plus proche (tuile « Arrêts à proximité » de l'Accueil)
  showNearby() {
    this._wantLocate = true;
    this.bang.contexts.open('carte');
    this._runPending();
  }

  _runPending() {
    if (!this._wantLocate || !this.map) return;      // la carte n'est pas encore prête : _mount relancera
    this._wantLocate = false;
    Promise.resolve(this.map.locate());     // l'échec est traité par _locFail (voir _mount)
  }

  // « Ma position » a échoué : aide adaptée (accès refusé, adresse non sécurisée, GPS coupé)
  async _locFail() {
    const s = window.GeoPerm ? await GeoPerm.state() : null;
    if (s === 'denied' || s === 'insecure' || s === 'unsupported') { this._info('Position indisponible : accès à la position ' + GeoPerm.label(s).toLowerCase() + '.'); GeoPerm.showHelp(s); return; }
    if (s === 'prompt' || s === 'unknown') { this._info('Autorise l’accès à la position pour voir l’arrêt le plus proche.'); GeoPerm.ensure(); return; }
    this._info('Position introuvable pour le moment : vérifie que la localisation d’Android est activée.');
  }

  onShow() {
    if (!this.built) return;
    const net = this.bang.network;
    const sig = net ? JSON.stringify([net.id, net.stops.map(s => [s.id, s.name, s.lat, s.lon]),
      net.lineInfo, net.services.map(v => [v.id, v.code, v.mode, v.name, v.symcolor0, v.symcolor1, v.symcolor2, v.stopTimes.map(t => t.stop.id), v.shapeValid ? v.shape.pts.length + ':' + v.shape.m : 0])]) : '';
    this._layout();
    if (sig === this._sig) { this._runPending(); return; }
    this._sig = sig;
    this._mount(net);
  }

  _mount(net) {
    if (this.map && this.map.destroy) this.map.destroy();
    this.mapbox.replaceChildren();
    this.legend.replaceChildren();
    this.legend.hidden = true;
    this.map = null;
    this.holder = null;
    this.mode = null;
    this.sub.textContent = net ? 'Réseau : ' + net.name : '';
    const located = net ? net.stops.filter(s => s.lat !== null && s.lon !== null) : [];
    this.mapbox.hidden = !located.length;
    this.split.hidden = !located.length;
    this.foot.hidden = !located.length;
    this.msg.hidden = !!located.length;
    this.card.hidden = true;
    if (this.detect) this.detect.setNetwork(located.length ? net : null, this._sig);
    if (!located.length) {
      this.msg.textContent = 'Aucun arrêt n’a de coordonnées. Renseignez la latitude et la longitude des arrêts (Compte › Feed › Arrêts) pour les voir ici.';
      return;
    }
    this._layout();
    this.foot.textContent = 'Chargement du fond de carte…';
    const holder = this.holder = document.createElement('div');
    holder.className = 'cm-map';
    this.mapbox.appendChild(holder);
    const token = this._tok = (this._tok || 0) + 1;
    const start = ok => {
      if (token !== this._tok) return;      // une autre ouverture a pris le relais
      this.engine = ok && window.GLNet && GLNet.supported() ? 'gl' : 'svg';
      const Engine = this.engine === 'gl' ? GLNet : NetMap;
      if (this.engine === 'svg') { const q = Math.max(60, Math.min(this.mapbox.clientWidth, this.mapbox.clientHeight)); holder.style.width = holder.style.height = q + 'px'; }
      this.map = new Engine(holder, net, stop => this._go('stop', { stop }));
      const locate = this.map.locate.bind(this.map);       // bouton « Ma position » compris
      this.map.locate = async () => {
        const r = await locate();
        if (r && r.error) this._locFail(); else if (r && window.GeoPerm) GeoPerm.noteSuccess();
        return r;
      };
      // Toucher un tracé : sa ligne ; si la ligne est déjà sélectionnée, ce service précisément
      this.map.onLine = sv => {
        const key = Network.lineKey(sv);
        if (this.selLine === key) this._go('service', { id: sv.id }); else this._go('line', { key });
      };
      this._sizeHolder();
      this._buildLegend(net);
      this._go('overview');
      this.map.status = (ok2, detail) => {
        this.foot.textContent = ok2 === null ? 'Mise à jour de la carte…'
          : ok2 ? '© contributeurs OpenStreetMap'
          : detail ? 'Détails indisponibles ici (hors ligne ?) · © contributeurs OpenStreetMap'
          : 'Fond de carte indisponible (hors ligne ?) · réseau affiché seul';
      };
      this.map.onLocate = best => {
        if (!best) { this._info('Aucun arrêt géolocalisé.'); return; }
        this._go('stop', { stop: best.stop, note: 'Arrêt le plus proche · ' + (best.m < 1000 ? Math.round(best.m) + ' m' : (best.m / 1000).toFixed(1).replace('.', ',') + ' km') });
      };
      if (this.detect) this.detect.setNetwork(net, this._sig);     // reporte la position et le suivi sur la nouvelle carte
      this._runPending();
    };
    // Moteur vectoriel (MapLibre) s'il est présent dans libs/ et que WebGL fonctionne ; sinon carte SVG (smap.js)
    if (window.GLNet) GLNet.load().then(start); else start(false);
  }

  // ----- États de la carte : un seul à la fois, qui décide de ce que montre la carte et de ce qu'affiche le panneau.
  //   overview : rien de sélectionné (tous les tracés en noir, résumé du réseau)
  //   line     : une ligne (tous ses services en couleurs) → liste de ses services
  //   service  : un service → son détail, ses arrêts et horaires
  //   stop     : un arrêt → sa fiche (lignes, Départ / Arrivée ici)
  //   info     : un simple message
  _go(mode, d = {}) {
    const net = this.bang.network;
    if (!net) return;
    let focus = null, line = null, sv = null;
    if (mode === 'line') {
      line = net.getLine(d.key);
      if (!line) { this._go('overview'); return; }
      focus = line.services.map(x => x.id);
    } else if (mode === 'service') {
      sv = net.services.find(x => x.id === d.id);
      if (!sv) { this._go('overview'); return; }
      focus = sv.id;
    }
    this.mode = mode;
    this.selLine = line ? line.key : (sv ? Network.lineKey(sv) : null);
    this.selSvc = sv ? sv.id : null;
    [...this.legend.children].forEach(c => c.classList.toggle('on', c.dataset.key === this.selLine));
    if (this.map && this.map.focus) this.map.focus(focus);
    const flat = mode === 'line' || mode === 'service' || mode === 'stop';
    this.card.className = flat ? 'cm-flat' : 'cm-card';
    this.panel.classList.toggle('flat', flat);
    this.bar.hidden = !flat;
    if (!flat) this.bar.replaceChildren();
    if (mode === 'line') this._showLine(line, net);
    else if (mode === 'service') this._showService(sv, net);
    else if (mode === 'stop') this._showStop(d.stop, net, d.note);
    else if (mode === 'info') this._showInfo(d.text);
    else this._showOverview(net);
    this.panel.scrollTop = 0;
    if (this.detect) this.detect.render();     // le bandeau propose de simuler le service affiché
  }

  _showOverview(net) {
    const e = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    const lines = net.lines().length, stops = net.stops.filter(s => s.lat !== null && s.lon !== null).length;
    this.card.replaceChildren(
      e('b', 'cm-name', lines + (lines > 1 ? ' lignes' : ' ligne') + ' · ' + stops + (stops > 1 ? ' arrêts' : ' arrêt')),
      e('small', 'cm-sub', 'Touche une ligne pour voir ses services, ou un arrêt sur la carte pour sa fiche. Tire la poignée pour agrandir la carte ou le panneau.'));
    this.card.hidden = false;
  }

  // Pastille aux couleurs symboliques d'une ligne ou d'un service (valeurs déjà validées par symColor)
  _badge(o, tag = 'span') {
    const b = document.createElement(tag);
    b.className = 'cm-code';
    b.textContent = o.code || '•';
    if (o.symcolor0) b.style.background = o.symcolor0;
    if (o.symcolor1) b.style.color = o.symcolor1;
    if (o.symcolor2) b.style.boxShadow = '0 0 0 2px ' + o.symcolor2;
    return b;
  }

  // Légende : une pastille par ligne (les services du même code sont regroupés) ; toucher sélectionne la ligne
  _buildLegend(net) {
    this.legend.replaceChildren();
    net.lines().forEach(l => {
      const b = this._badge(l, 'button');
      b.type = 'button';
      b.classList.add('cm-chip');
      if (l.services.every(sv => sv.shapeValid)) b.classList.add('shaped');
      b.dataset.key = l.key;
      b.addEventListener('click', () => this._selectLine(this.selLine === l.key && this.mode === 'line' ? null : l.key));
      this.legend.appendChild(b);
    });
    this.legend.hidden = !net.services.length;
  }

  // Bandeau du haut en mode détail : bouton retour à gauche, pastille, titre
  _setBar(backLabel, onBack, badgeOf, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-bk';
    b.setAttribute('aria-label', backLabel);
    b.textContent = '‹';
    b.addEventListener('click', onBack);
    const t = document.createElement('b');
    t.className = 'cm-bt';
    t.textContent = title || '';
    this.bar.replaceChildren(b);
    if (badgeOf) this.bar.appendChild(this._badge(badgeOf));
    this.bar.appendChild(t);
  }

  _selectLine(key) { this._go(key ? 'line' : 'overview', { key }); }
  _selectService(id) { this._go('service', { id }); }

  _when(sv) {
    const TS = window.TicketSearch;
    return TS ? [TS.daysLabel(sv.operatingDays), TS.periodsLabel(sv.operatingPeriods)].filter(Boolean).join(' · ') : '';
  }
  _traceLabel(sv) {
    return sv.shapeValid && window.Routing ? 'Tracé routier : ' + Routing.label(sv.shape) : 'Tracé non calculé : lignes droites';
  }

  // Panneau d'une ligne : badge, nom, description, puis la liste de ses services
  _showLine(line, net) {
    const e = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    this.card.replaceChildren();
    this._setBar('Retour à la vue d’ensemble', () => this._selectLine(null), line, line.name);
    const mode = line.modes.map(x => (SERVICE_MODES.find(m => m.value === x) || {}).label || x).join(' + ');
    this.card.appendChild(e('small', 'cm-sub', [mode, line.services.length + (line.services.length > 1 ? ' services' : ' service'), line.stopCount + (line.stopCount > 1 ? ' arrêts' : ' arrêt')].filter(Boolean).join(' · ')));
    if (line.description) this.card.appendChild(e('p', 'cm-desc', line.description));
    const list = e('div', 'cm-svlist');
    line.services.forEach(sv => {
      const row = e('button', 'cm-svrow');
      row.type = 'button';
      const first = sv.departure && sv.departure.stop, last = sv.arrival && sv.arrival.stop;
      row.append(e('b', null, sv.name || sv.code || 'Service'),
        e('small', null, this._when(sv)),
        e('small', null, [first && last ? first.name + ' → ' + last.name : '', this._traceLabel(sv)].filter(Boolean).join(' · ')));
      row.addEventListener('click', () => this._selectService(sv.id));
      list.appendChild(row);
    });
    this.card.appendChild(list);
    this.card.hidden = false;
  }

  // Fiche d'un service : badge, nom, jours, tracé (routier ou lignes droites), arrêts ; retour à la liste de sa ligne
  _showService(sv, net) {
    const e = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    net = net || this.bang.network;
    this.card.replaceChildren();
    const line = net.getLine(Network.lineKey(sv));
    this._setBar(line ? 'Retour aux services de la ligne' : 'Retour', () => line ? this._selectLine(line.key) : this._selectLine(null), sv, sv.name || (line && line.name) || '');
    const when = this._when(sv);
    if (when) this.card.appendChild(e('small', 'cm-sub', when));
    if (net.hasCalendar) {
      const runs = sv.runsOn(new Date(), net);
      const wrap = e('div', 'cm-runwrap');
      wrap.appendChild(e('span', 'cm-run ' + (runs ? 'yes' : 'no'), runs ? 'Circule aujourd’hui' : 'Ne circule pas aujourd’hui'));
      this.card.appendChild(wrap);
    }
    const first = sv.departure && sv.departure.stop, last = sv.arrival && sv.arrival.stop;
    if (first && last) this.card.appendChild(e('small', 'cm-sub', first.name + ' → ' + last.name + ' · ' + sv.stopTimes.length + ' arrêts'));
    this.card.appendChild(e('small', 'cm-sub', sv.shapeValid && window.Routing ? 'Tracé routier : ' + Routing.label(sv.shape)
      : 'Tracé non calculé : lignes droites entre les arrêts (Compte › Feed › Services › Calculer le tracé)'));
    this.card.appendChild(this._mkStopList(sv));
    this.card.hidden = false;
    this._scrolledIdx = null;
    if (this.detect) this.detect.markNow();
  }

  // Détection en cours : arrêts déjà passés estompés, prochain arrêt mis en avant (si ce service est affiché)
  // et défilement automatique : le dernier arrêt passé et le suivant viennent en tête du panneau, sous le bandeau du service.
  // Si l'utilisateur fait défiler le panneau lui-même, le défilement automatique attend quelques secondes.
  markProgress(id, index) {
    const show = id && this.mode === 'service' && this.selSvc === id && index != null;
    if (!show && !this._marked) return;
    this._marked = !!show;
    const ol = this.card.querySelector('.cm-stops');
    if (!ol) return;
    let anchor = null;
    ol.querySelectorAll('li').forEach(li => {
      const i = +li.dataset.i;
      li.classList.toggle('cm-past', !!show && i < index);
      li.classList.toggle('cm-last', !!show && i === index);
      li.classList.toggle('cm-next', !!show && i === index + 1);
      if (show && i === index) anchor = li;
    });
    this.panel.classList.toggle('cm-track', !!show);
    // marge sous la liste : permet d'amener même les derniers arrêts en tête du panneau
    ol.style.marginBottom = show ? Math.round(this.panel.clientHeight * 0.6) + 'px' : '';
    if (!show) { this._scrolledIdx = null; return; }
    const key = id + ':' + index;
    if (key === this._scrolledIdx || Date.now() - (this._userScroll || 0) < 6000 || !anchor) return;
    this._scrolledIdx = key;
    const bar = this.bar.hidden ? 0 : this.bar.offsetHeight;
    const top = this.panel.scrollTop + anchor.getBoundingClientRect().top - this.panel.getBoundingClientRect().top - bar - 6;
    this._autoScrolling = true;
    this.panel.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    clearTimeout(this._autoScrollT);
    this._autoScrollT = setTimeout(() => { this._autoScrolling = false; }, 800);
  }

  // Liste des arrêts du service, chacun précédé de son horaire (passage ; départ en plus si l'arrêt est marqué)
  _mkStopList(sv) {
    const e = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    const ol = e('ol', 'cm-stops');
    if (sv.symcolor0) ol.style.setProperty('--sc', sv.symcolor0);
    const last = sv.stopTimes.length - 1;
    sv.stopTimes.forEach((st, i) => {
      const li = e('li', i === 0 ? 'first' : i === last ? 'last' : '');
      li.dataset.i = i;
      const t = i === 0 ? st.departure : st.arrival || st.departure;
      const time = e('b', 'cm-t', t || '—');
      const name = e('span', 'cm-sn', st.stop.name);
      if (i && i < last && st.arrival && st.departure && st.arrival !== st.departure) name.appendChild(e('small', null, ' · départ ' + st.departure));
      if (st.stop.city && st.stop.city !== st.stop.name) name.appendChild(e('small', 'cm-sc', st.stop.city));
      li.append(time, e('i', 'cm-dot'), name);
      ol.appendChild(li);
    });
    return ol;
  }

  _info(text) { this._go('info', { text }); }

  _showInfo(text) {
    const p = document.createElement('div');
    p.className = 'cm-note';
    p.textContent = text;
    this.card.replaceChildren(p);
    this.card.hidden = false;
  }

  // Fiche d'un arrêt : nom, commune, zone, lignes qui le desservent, boutons Départ / Arrivée
  _showStop(stop, net, note) {
    const e = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    this.card.replaceChildren();
    this._setBar('Retour à la vue d’ensemble', () => this._selectLine(null), null, stop.name);
    if (note) this.card.appendChild(e('div', 'cm-note', note));
    const zone = stop.zoneId && net.getZone ? net.getZone(stop.zoneId) : null;
    const sub = [stop.city, zone && zone.name].filter(Boolean).join(' · ');
    if (sub) this.card.appendChild(e('small', 'cm-sub', sub));

    const lines = e('div', 'cm-lines');
    net.lines().filter(l => l.services.some(sv => sv.stopTimes.some(st => st.stop.id === stop.id))).forEach(l => {
      const b = this._badge(l, 'button');
      b.type = 'button';
      b.classList.add('cm-chip');
      if (l.services.every(sv => sv.shapeValid)) b.classList.add('shaped');
      b.addEventListener('click', () => this._selectLine(l.key));
      lines.appendChild(b);
    });
    if (lines.childNodes.length) this.card.appendChild(lines);

    const acts = e('div', 'cm-acts');
    [['Départ ici', 'from'], ['Arrivée ici', 'to']].forEach(([label, k]) => {
      const b = e('button', 'cm-act', label);
      b.type = 'button';
      b.addEventListener('click', () => this._useStop(k, stop));
      acts.appendChild(b);
    });
    if (this.bang.contexts.map && this.bang.contexts.map.accueil) this.card.appendChild(acts);
    this.card.hidden = false;
  }

  // Renseigne l'écran d'accueil (recherche de trajet) avec cet arrêt
  _useStop(k, stop) {
    const ac = this.bang.contexts.map && this.bang.contexts.map.accueil;
    if (!ac) return;
    ac.ensureBuilt();
    ac.setStop(k, stop);
    this.bang.contexts.closeOverlay();
    this.bang.selectNav('accueil');
  }

  _injectStyle() {
    if (document.getElementById('cm-style')) return;
    const st = document.createElement('style');
    st.id = 'cm-style';
    st.textContent = `
      .ctx.cm-ctx{display:flex;flex-direction:column;overflow:hidden}
      .cm-mapbox{position:relative;flex:none;overflow:hidden;background:#eef2ea}
      .cm-mapbox .cm-map{position:absolute;left:0;top:0;width:100%;height:100%;border-radius:0;box-shadow:none}
      .cm-mapbox .gl-canvas{width:100%;height:100%;aspect-ratio:auto}
      .cm-split{flex:none;height:26px;margin-top:-12px;position:relative;z-index:2;display:flex;align-items:center;justify-content:center;
        background:var(--background-color);border-radius:16px 16px 0 0;box-shadow:0 -2px 6px rgba(0,0,0,.14);cursor:ns-resize;touch-action:none;
        -webkit-tap-highlight-color:transparent;outline:none}
      .cm-split[hidden]{display:none}
      .cm-split i{display:block;width:44px;height:5px;border-radius:3px;background:#b9c2cc}
      .cm-split:focus-visible i,.cm-split:active i{background:var(--accent-color)}
      .cm-panel{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:var(--background-color);padding:.5em 0 1.2em}
      .cm-net{display:block;margin:.1em 1.2em 0;color:var(--inactive-color);font-size:.8em}
      .cm-map{position:relative;border-radius:22px;overflow:hidden;background:#eef2ea;box-shadow:0 2px 8px rgba(17,94,136,.12);
        touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab}
      .cm-map path,.cm-map polyline{vector-effect:non-scaling-stroke}
      .cm-map svg{display:block;width:100%;height:auto;border:0!important;overflow:visible;transform-origin:50% 50%;will-change:transform}
      .lm-bar{position:absolute;right:.6em;top:.6em;display:flex;flex-direction:column;gap:.5em;z-index:2}
      .lm-btn,.lm-btn:hover{width:2.6em;height:2.6em;padding:0;border-radius:14px;background:#fff;color:var(--accent-color);
        display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.2)}
      .lm-btn svg{width:1.3em;height:1.3em}
      .lm-zoom{right:auto;left:.6em;top:auto;bottom:.6em}
      .lm-z,.lm-z:hover{font-size:1.3em;width:2em;height:2em;border-radius:12px;font-weight:bold;line-height:1}
      .lm-panel{position:absolute;right:3.8em;top:.6em;z-index:2;background:#fff;border-radius:14px;padding:.6em .9em;
        box-shadow:0 2px 10px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:.35em;font-size:.9em}
      .lm-panel[hidden]{display:none}
      .lm-panel label{cursor:pointer;white-space:nowrap}
      .cm-msg{margin:1.4em 1.6em;text-align:center;color:var(--inactive-color)}
      .cm-foot{margin:.5em 1.2em 0;text-align:center;font-size:.75em;color:var(--inactive-color)}
      .cm-card{margin:1em 1em 1.6em;background:#fff;border-radius:22px;padding:1em 1.2em;box-shadow:0 2px 8px rgba(17,94,136,.10)}
      .cm-flat{margin:0;padding:.5em 1.1em 1em}
      .cm-flat .cm-sub{margin-top:.1em}
      .cm-flat .cm-stops{margin-top:.6em}
      .cm-bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:.6em;padding:.2em 1em .5em .6em;background:var(--background-color)}
      .cm-bar[hidden]{display:none}
      .cm-bar .cm-code{flex:none}
      .cm-bt{min-width:0;flex:1;font-size:1.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cm-bk,.cm-bk:hover{flex:none;width:1.9em;height:1.9em;border-radius:50%;padding:0;background:var(--accent-color);color:#fff;font-size:1.2em;line-height:1;
        display:flex;align-items:center;justify-content:center;padding-bottom:.12em}
      .cm-panel.flat{padding-top:0}
      .cm-panel.flat .cm-legend,.cm-panel.flat .cm-net{display:none}
      .cm-note{font-size:.8em;color:var(--accent-color);font-weight:600;margin-bottom:.4em}
      .cm-name{display:block;font-size:1.05em}
      .cm-sub{display:block;color:var(--inactive-color);margin-top:.15em}
      .cm-lines{display:flex;flex-wrap:wrap;gap:.5em;margin-top:.7em}
      .cm-code{background:var(--accent-color);color:#fff;border-radius:999px;padding:.25em .8em;font-weight:600;font-size:.9em}
      .cm-legend{display:flex;flex-wrap:wrap;gap:.5em;margin:0;padding:.6em 1em .5em;position:sticky;top:-.5em;z-index:1;background:var(--background-color);max-height:7.5em;overflow-y:auto}
      .cm-legend[hidden]{display:none}
      .cm-chip,.cm-chip:hover{border:0;cursor:pointer;opacity:.9}
      .cm-chip.on{opacity:1;transform:scale(1.12);box-shadow:0 0 0 3px #fff,0 0 0 5px var(--accent-color)!important}
      .cm-chip:not(.shaped){background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.28) 0 4px,transparent 4px 8px)}
      .cm-lhead{min-width:0;flex:1}
      .cm-svhead{align-items:center;flex-wrap:nowrap;margin-bottom:.1em}
      .cm-svhead .cm-code{flex:none}
      .cm-svhead .cm-name{min-width:0}
      .cm-lines:has(.cm-lhead){align-items:center;flex-wrap:nowrap;margin-top:0}
      .cm-desc{margin:.7em 0 0;line-height:1.4;white-space:pre-line}
      .cm-svlist{display:flex;flex-direction:column;gap:.6em;margin-top:.8em}
      .cm-svrow,.cm-svrow:hover{display:block;text-align:left;width:100%;background:#fff;box-shadow:0 1px 5px rgba(17,94,136,.12);border-radius:14px;padding:.7em .9em;color:inherit}
      .cm-svrow b{display:block}
      .cm-svrow small{display:block;color:var(--inactive-color);margin-top:.1em}
            .cm-stops{list-style:none;margin:1em 0 0;padding:0}
      .cm-stops li{display:flex;align-items:baseline;gap:.7em;position:relative;padding:.32em 0}
      .cm-t{flex:none;width:3em;text-align:right;font-variant-numeric:tabular-nums}
      .cm-dot{flex:none;align-self:stretch;position:relative;width:1em;margin:-.32em 0}
      .cm-dot::before{content:"";position:absolute;left:calc(50% - 1px);top:0;bottom:0;width:2px;background:var(--sc,var(--accent-color))}
      .cm-dot::after{content:"";position:absolute;left:calc(50% - .3em);top:calc(50% - .3em);width:.6em;height:.6em;border-radius:50%;
        background:#fff;box-shadow:0 0 0 2px var(--sc,var(--accent-color))}
      .cm-stops .first .cm-dot::before{top:50%}
      .cm-stops .last .cm-dot::before{bottom:50%}
      .cm-stops .first .cm-dot::after,.cm-stops .last .cm-dot::after{background:var(--sc,var(--accent-color))}
      .cm-sn{min-width:0}
      .cm-sn small{color:var(--inactive-color);margin-left:.3em}
      .cm-runwrap{margin-top:.5em}
      .cm-run{display:inline-block;border-radius:999px;padding:.2em .8em;font-size:.85em;font-weight:700}
      .cm-run.yes{background:#dff3e6;color:#1c7a4d}
      .cm-run.no{background:#fbe2e0;color:#b3261e}
      .cm-acts{display:flex;gap:.6em;margin-top:.9em}
      .cm-stops li.cm-past{opacity:.4}
      .cm-stops li.cm-last{opacity:.75}
      .cm-stops li.cm-next{padding:.5em 0}
      .cm-stops li.cm-next .cm-t,.cm-stops li.cm-next .cm-sn{font-size:1.3em;font-weight:700}
      .cm-stops li.cm-next .cm-t{width:2.31em}
      .cm-stops li.cm-next .cm-sn small{font-size:.7em;font-weight:normal}
      .cm-stops li.cm-next .cm-dot::after{background:var(--sc,var(--accent-color));box-shadow:0 0 0 2px var(--sc,var(--accent-color)),0 0 0 6px rgba(17,94,136,.18)}
      .cm-act,.cm-act:hover{flex:1;border-radius:14px;padding:.7em .5em;background:var(--accent-color);color:#fff;font-weight:600;font-size:.95em}
    `;
    document.head.appendChild(st);
  }
}

window.NetMap = NetMap;
window.CarteContext = CarteContext;
