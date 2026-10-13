// gl-map.js — moteur de carte vectoriel (MapLibre GL JS) pour la page Carte : fond OpenStreetMap vectoriel,
// rotation / inclinaison au doigt, boussole. Même interface que NetMap (smap.js) :
//   new GLNet(container, net, onStop) · .status(ok, detail) · .onLocate(best) · .locate() · .recenter() · .destroy()
// Nécessite libs/maplibre-gl.js et libs/maplibre-gl.css (chargés à la demande par CarteContext).

class GLNet {
  static STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

  static supported() {
    try {
      if (!window.maplibregl) return false;
      if (maplibregl.supported && !maplibregl.supported()) return false;
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { return false; }
  }

  // Charge la bibliothèque (script + feuille de style) ; résout true si disponible
  static load(base) {
    if (window.maplibregl) return Promise.resolve(true);
    if (GLNet._loading) return GLNet._loading;
    base = base || 'libs/';   // repli local si le CDN (index.html) n'a pas répondu
    GLNet._loading = new Promise(resolve => {
      if (!document.querySelector('link[data-gl]')) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = base + 'maplibre-gl.css'; l.dataset.gl = '1';
        document.head.appendChild(l);
      }
      const s = document.createElement('script');
      s.src = base + 'maplibre-gl.js';
      s.onload = () => resolve(!!window.maplibregl);
      s.onerror = () => { s.remove(); GLNet._loading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return GLNet._loading;
  }

  constructor(container, net, onStop) {
    this.container = container;
    this.net = net;
    this.onStop = onStop;
    this.status = null;
    this.onLocate = null;
    this.onLine = null;
    this.sel = null;
    this.markers = [];
    this.stopEls = new Map();
    this.meMarker = null;
    this.follow = true;       // la vue suit la position en direct (bandeau de détection) tant qu'on ne déplace pas la carte
    this.onFollow = null;
    this.stops = net.stops.filter(s => s.lat !== null && s.lon !== null);
    this._injectStyle();
    this.container.classList.add('gl-map');
    this.container.style.cursor = 'auto';
    this.el = document.createElement('div');
    this.el.className = 'gl-canvas';
    this.container.appendChild(this.el);

    const ll = this.stops.map(s => [s.lon, s.lat]);
    this.bounds = ll.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(ll[0], ll[0]));
    this.map = new maplibregl.Map({
      container: this.el,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef2ea' } }] },
      bounds: this.bounds,
      fitBoundsOptions: { padding: 40 },
      maxPitch: 70,
      attributionControl: false,
      dragRotate: true,
      touchPitch: true
    });
    this.map.addControl(new maplibregl.AttributionControl({
      compact: true, customAttribution: '© OpenStreetMap contributors · OpenFreeMap' }));
    this.map.on('style.load', () => this._addNetwork());
    this.map.on('styledata', () => { if (!this.dead && !this.map.getSource('net') && this.map.isStyleLoaded()) this._addNetwork(); });   // filet de sécurité
    this.map.on('click', 'net-hit', e => {
      const f = e.features && e.features[0];
      const sv = f && this.net.services.find(x => x.id === f.properties.id);
      if (sv && this.onLine) this.onLine(sv);
    });
    this.map.on('mouseenter', 'net-hit', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'net-hit', () => { this.map.getCanvas().style.cursor = ''; });
    this.map.on('rotate', () => this._compass());
    this.map.on('pitch', () => this._compass());
    this.map.on('zoom', () => this._zoomClass());
    this.map.on('dragstart', e => {   // déplacement au doigt : on cesse de suivre la position
      if (e.originalEvent && this.follow) { this.follow = false; if (this.onFollow) this.onFollow(false); }
    });
    this.map.on('error', () => { /* tuiles manquantes : on garde l'affichage */ });
    this._controls();
    this._addStops();
    this._zoomClass();
    this._loadStyle();
  }

  // Libellés : aucun très loin ; terminus seuls à distance moyenne ; arrêts intermédiaires aussi de près
  _zoomClass() {
    const z = this.map.getZoom();
    this.container.classList.toggle('gl-far', z < 9.5);
    this.container.classList.toggle('gl-near', z >= 12);
  }

  async _loadStyle() {
    if (this.status) this.status(null);
    try {
      const r = await fetch(GLNet.STYLE_URL);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const style = await r.json();
      if (this.dead) return;
      this.map.setStyle(style, { diff: false });   // sans diff : le style est remplacé en bloc, nos couches sont réajoutées ensuite
      this.map.once('idle', () => { if (!this.dead && this.status) this.status(true); });
    } catch (e) {
      if (!this.dead && this.status) this.status(false, false);
    }
  }

  // Lignes du réseau : une source GeoJSON. Couleurs symboliques du service : fond (symcolor0) pour le trait,
  // contour (symcolor2) pour le liseré, blanc par défaut. Tracé routier plein ; segments droits entre arrêts en pointillés.
  _lineData() {
    const feats = [];
    this.net.services.forEach(sv => {
      const co = sv.path().map(([la, lo]) => [lo, la]);
      if (co.length > 1) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: co },
        properties: { id: sv.id, c: sv.symcolor0 || '#115e88', o: sv.symcolor2 || '#ffffff', shaped: sv.shapeValid } });
    });
    return { type: 'FeatureCollection', features: feats };
  }

  // Sans sélection : tous les tracés en noir. Avec une sélection : seul ce service reste affiché, en couleurs symboliques.
  _inSel() { return ['in', ['get', 'id'], ['literal', this.sel]]; }
  _fade() { return this.sel ? ['case', this._inSel(), 1, 0] : 1; }
  _lineColor() { return this.sel ? ['get', 'c'] : '#111111'; }
  _casingColor() { return this.sel ? '#111111' : '#ffffff'; }   // bordure noire : toute couleur reste lisible
  _hitFilter() { return this.sel ? this._inSel() : ['has', 'id']; }

  _addNetwork() {
    const m = this.map;
    if (this.dead || m.getSource('net')) return;
    try {
      m.addSource('net', { type: 'geojson', data: this._lineData() });
      // Sous les libellés du fond (noms de rues, villes) pour qu'ils restent lisibles
      const sym = m.getStyle && (m.getStyle().layers || []).find(l => l.type === 'symbol');
      const before = sym ? sym.id : undefined;
      const join = { 'line-cap': 'round', 'line-join': 'round' };
      const z = (a, b) => ['interpolate', ['linear'], ['zoom'], 6, a, 14, b];
      const shaped = ['==', ['get', 'shaped'], true];
      m.addLayer({ id: 'net-casing', type: 'line', source: 'net', layout: join,
        paint: { 'line-color': this._casingColor(), 'line-width': z(3.2, 9.5), 'line-opacity': this._fade() } }, before);
      m.addLayer({ id: 'net-line', type: 'line', source: 'net', filter: shaped, layout: join,
        paint: { 'line-color': this._lineColor(), 'line-width': z(1.8, 5.5), 'line-opacity': this._fade() } }, before);
      m.addLayer({ id: 'net-dash', type: 'line', source: 'net', filter: ['!', shaped], layout: { 'line-cap': 'butt' },
        paint: { 'line-color': this._lineColor(), 'line-width': z(1.8, 4.5), 'line-dasharray': [2, 1.5], 'line-opacity': this._fade() } }, before);
      m.addLayer({ id: 'net-hit', type: 'line', source: 'net', filter: this._hitFilter(), layout: join,
        paint: { 'line-color': '#000', 'line-opacity': 0.001, 'line-width': 22 } }, before);
    } catch (e) {
      console.warn('Réseau non ajouté à la carte :', e);
      try { if (m.getSource('net') && !m.getLayer('net-line')) m.removeSource('net'); } catch (e2) { /* ignoré */ }
    }
  }

  // Sélectionne un service : lui seul est affiché, en couleurs symboliques (les autres sont masqués) et cadre la carte sur son tracé ; null = tout afficher
  // id : un service, un tableau de services (ligne entière) ou null ; la carte se cadre sur l'ensemble
  focus(id) {
    const ids = Array.isArray(id) ? id.filter(Boolean) : (id ? [id] : []);
    this.sel = ids.length ? ids : null;
    const m = this.map;
    if (m.getLayer && m.getLayer('net-casing')) {
      ['net-casing', 'net-line', 'net-dash'].forEach(l => m.setPaintProperty(l, 'line-opacity', this._fade()));
      m.setPaintProperty('net-casing', 'line-color', this._casingColor());
      ['net-line', 'net-dash'].forEach(l => m.setPaintProperty(l, 'line-color', this._lineColor()));
      m.setFilter('net-hit', this._hitFilter());
    }
    this._styleStops();
    const svs = ids.map(i => this.net.services.find(x => x.id === i)).filter(Boolean);
    const pts = [].concat(...svs.map(v => v.path()));
    if (pts.length > 1) {
      const bb = pts.reduce((b, p) => b.extend([p[1], p[0]]), new maplibregl.LngLatBounds([pts[0][1], pts[0][0]], [pts[0][1], pts[0][0]]));
      m.fitBounds(bb, { padding: 50, maxZoom: 15, duration: 600 });
    }
  }

  _addStops() {
    const labels = this.stops.length <= 400;
    this.stops.forEach(s => {
      const el = document.createElement('div');
      el.className = 'gl-stop';
      const dot = document.createElement('i');
      el.appendChild(dot);
      if (labels) { const t = document.createElement('span'); t.textContent = s.name; el.appendChild(t); }
      el.addEventListener('click', ev => { ev.stopPropagation(); if (this.onStop) this.onStop(s); });
      this.stopEls.set(s.id, el);
      this.markers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [-7, 0] }).setLngLat([s.lon, s.lat]).addTo(this.map));
    });
    this._styleStops();
  }

  // Signalétique : un terminus (premier ou dernier arrêt d'un service) est un carré plein avec son libellé ; un arrêt
  // intermédiaire est un petit rond blanc sans libellé (le libellé n'apparaît que de près). Vue globale : tous les
  // services, en noir. Avec une sélection (service ou ligne) : seuls les arrêts desservis, aux couleurs de la sélection.
  _styleStops() {
    const svs = this.sel ? this.sel.map(i => this.net.services.find(x => x.id === i)).filter(Boolean) : null;
    const roles = Network.stopRoles(svs || this.net.services);
    const col = svs ? ((svs.find(x => x.symcolor0) || {}).symcolor0 || '#115e88') : '#111111';
    this.stopEls.forEach((el, id) => {
      const r = roles.get(id);
      el.classList.toggle('gl-hide', !!svs && !r);
      el.classList.toggle('gl-end', r === 'end');
      el.classList.toggle('gl-mini', r !== 'end');
      el.style.setProperty('--sc', col);
    });
  }

  resize() { try { this.map.resize(); } catch (e) { /* ignoré */ } }

  _controls() {
    const ico = inner => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    const bar = document.createElement('div');
    bar.className = 'lm-bar';
    const mk = (label, svg, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lm-btn';
      b.setAttribute('aria-label', label); b.innerHTML = svg;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    this.compass = mk('Orienter au nord', ico('<path d="M12 3l4 9h-8z" fill="#d33" stroke="#d33"/><path d="M12 21l-4-9h8z" fill="currentColor"/>'),
      () => this.map.resetNorthPitch({ duration: 400 }));
    this.compass.hidden = true;
    mk('Ma position', ico('<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'), () => this.locate());
    mk('Tout le réseau', ico('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'), () => this.recenter());
    const zoom = document.createElement('div');
    zoom.className = 'lm-bar lm-zoom';
    [['Zoom avant', '+', 1], ['Zoom arrière', '−', -1]].forEach(([label, t, d]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'lm-btn lm-z';
      b.setAttribute('aria-label', label); b.textContent = t;
      b.addEventListener('click', () => this.map.easeTo({ zoom: this.map.getZoom() + d, duration: 250 }));
      zoom.appendChild(b);
    });
    this.container.append(bar, zoom);
  }

  _compass() {
    const b = this.map.getBearing(), p = this.map.getPitch();
    const off = Math.abs(b) < 0.5 && p < 0.5;
    this.compass.hidden = off;
    this.compass.firstChild.style.transform = 'rotate(' + (-b) + 'deg)';
  }

  recenter() {
    this.map.fitBounds(this.bounds, { padding: 40, bearing: 0, pitch: 0, duration: 500 });
  }

  // Position en direct (bandeau de détection) ; o : {live, follow, duration}
  setMe(lat, lon, o = {}) {
    if (this.dead) return;
    if (!this.meMarker) {
      const el = document.createElement('div');
      el.className = 'gl-me';
      this.meMarker = new maplibregl.Marker({ element: el });
    }
    this.meMarker.setLngLat([lon, lat]).addTo(this.map);
    this.meMarker.getElement().classList.toggle('gl-me-live', !!o.live);
    if (o.follow && this.follow) {
      this.map.easeTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 13), duration: o.duration != null ? o.duration : 600 });
    }
  }

  async locate() {
    const pos = await new Promise(res => {
      if (!navigator.geolocation) return res(null);
      navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude }), () => res(null),
        { enableHighAccuracy: true, timeout: 10000 });
    });
    if (!pos || this.dead) return { error: true };
    if (!this.meMarker) {
      const el = document.createElement('div');
      el.className = 'gl-me';
      this.meMarker = new maplibregl.Marker({ element: el });
    }
    this.meMarker.setLngLat([pos.lon, pos.lat]).addTo(this.map);
    if (!this.follow) { this.follow = true; if (this.onFollow) this.onFollow(true); }
    this.map.flyTo({ center: [pos.lon, pos.lat], zoom: Math.max(this.map.getZoom(), 14) });
    const rad = Math.PI / 180;
    let best = null;
    this.stops.forEach(s => {
      const a = Math.sin((s.lat - pos.lat) * rad / 2) ** 2 + Math.cos(pos.lat * rad) * Math.cos(s.lat * rad) * Math.sin((s.lon - pos.lon) * rad / 2) ** 2;
      const m = 2 * 6371000 * Math.asin(Math.sqrt(a));
      if (!best || m < best.m) best = { stop: s, m };
    });
    if (this.onLocate) this.onLocate(best);
    return best;
  }

  destroy() {
    this.dead = true;
    try { this.map.remove(); } catch (e) { /* ignoré */ }
    this.container.replaceChildren();
  }

  _injectStyle() {
    if (document.getElementById('gl-style')) return;
    const st = document.createElement('style');
    st.id = 'gl-style';
    st.textContent = `
      .gl-map{touch-action:pan-y}
      .gl-canvas{width:100%;aspect-ratio:1/1}
      .gl-map .maplibregl-canvas{outline:none}
      .gl-stop{display:flex;align-items:center;gap:.35em;cursor:pointer;font:600 11px/1 system-ui,sans-serif;color:#0b3a57;
        text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff}
      .gl-stop i{width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid var(--sc,#111);box-sizing:border-box;flex:none}
      .gl-stop span{white-space:nowrap}
      .gl-stop.gl-hide{display:none}
      .gl-stop.gl-end i{border-radius:4px;background:var(--sc,#111);border:2.5px solid #fff;box-shadow:0 0 0 1.5px var(--sc,#111)}
      .gl-stop.gl-end span{font-weight:700}
      .gl-stop.gl-mini i{transform:scale(.5)}
      .gl-stop.gl-mini span{display:none}
      .gl-near .gl-stop.gl-mini span{display:inline;font-weight:500;opacity:.85}
      .gl-far .gl-stop span{display:none}
      .gl-me{width:16px;height:16px;border-radius:50%;background:#2a7de1;border:3px solid #fff;box-shadow:0 0 0 2px rgba(42,125,225,.35)}
      .gl-me.gl-me-live{animation:gl-pulse 1.6s ease-out infinite}
      @keyframes gl-pulse{0%{box-shadow:0 0 0 2px rgba(42,125,225,.45)}100%{box-shadow:0 0 0 16px rgba(42,125,225,0)}}
      .gl-map .lm-btn[hidden]{display:none}
      .gl-map .lm-btn svg{transition:transform .1s}
    `;
    document.head.appendChild(st);
  }
}

// Sélecteur de position : carte vectorielle où l'on touche pour poser (ou glisser) un repère.
//   new GLPicker(container, { point: {lat,lon}|null, others: [{lat,lon}], onPick(lat, lon) })
//   .set(lat, lon) place le repère et centre la carte · .destroy()
class GLPicker {
  constructor(container, opts) {
    this.container = container;
    this.onPick = opts.onPick;
    this.others = (opts.others || []).filter(o => o.lat !== null && o.lon !== null);
    GLNet.prototype._injectStyle.call(this);
    container.classList.add('gl-map');
    this.el = document.createElement('div');
    this.el.className = 'gl-canvas gl-pick';
    container.appendChild(this.el);

    const pt = opts.point;
    const mo = { container: this.el, attributionControl: false, maxPitch: 60,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef2ea' } }] } };
    if (pt) { mo.center = [pt.lon, pt.lat]; mo.zoom = 16; }
    else if (this.others.length) {
      const ll = this.others.map(o => [o.lon, o.lat]);
      mo.bounds = ll.reduce((b, q) => b.extend(q), new maplibregl.LngLatBounds(ll[0], ll[0]));
      mo.fitBoundsOptions = { padding: 40, maxZoom: 16 };
    } else { mo.center = [2.35, 46.6]; mo.zoom = 4.5; }
    this.map = new maplibregl.Map(mo);
    this.map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors · OpenFreeMap' }));
    this.map.on('style.load', () => this._addOthers());
    this.map.on('styledata', () => { if (!this.dead && !this.map.getSource('others') && this.map.isStyleLoaded()) this._addOthers(); });
    this.map.on('click', e => this._place(e.lngLat.lat, e.lngLat.lng, true));
    if (pt) this._marker(pt.lat, pt.lon);
    this._loadStyle();
  }

  async _loadStyle() {
    try {
      const r = await fetch(GLNet.STYLE_URL);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const style = await r.json();
      if (!this.dead) this.map.setStyle(style, { diff: false });
    } catch (e) { /* fond indisponible : le repère reste utilisable */ }
  }

  _addOthers() {
    const m = this.map;
    if (this.dead || m.getSource('others')) return;
    try {
    m.addSource('others', { type: 'geojson', data: { type: 'FeatureCollection',
      features: this.others.map(o => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [o.lon, o.lat] } })) } });
    m.addLayer({ id: 'others', type: 'circle', source: 'others',
      paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-color': '#115e88', 'circle-stroke-width': 2.5 } });
    } catch (e) { console.warn('Arrêts non ajoutés à la carte :', e); }
  }

  _marker(lat, lon) {
    if (!this.mk) {
      this.mk = new maplibregl.Marker({ color: '#d33', draggable: true }).setLngLat([lon, lat]).addTo(this.map);
      this.mk.on('dragend', () => { const l = this.mk.getLngLat(); this._place(l.lat, l.lng, true); });
    } else this.mk.setLngLat([lon, lat]);
  }

  _place(lat, lon, notify) {
    this._marker(lat, lon);
    if (notify && this.onPick) this.onPick(lat, lon);
  }

  set(lat, lon) {
    this._place(lat, lon, false);
    this.map.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 16) });
  }

  clear() { if (this.mk) { this.mk.remove(); this.mk = null; } }

  destroy() {
    this.dead = true;
    try { this.map.remove(); } catch (e) { /* ignoré */ }
    this.container.replaceChildren();
  }
}

// Tracé d'un trajet : tronçon en couleurs symboliques avec bordure noire, arrêts de départ / d'arrivée / intermédiaires.
//   new GLTrip(container, { pts:[[lat,lon]…], stops:[{lat,lon,name,role:'from'|'to'|'mid'}], color })
class GLTrip {
  constructor(container, o) {
    this.container = container;
    this.o = o;
    this.markers = [];
    GLNet.prototype._injectStyle.call(this);
    GLTrip._style();
    container.classList.add('gl-map');
    this.el = document.createElement('div');
    this.el.className = 'gl-canvas gl-trip';
    container.appendChild(this.el);
    const all = o.pts.concat(o.stops.map(s => [s.lat, s.lon]));
    const ll = all.map(p => [p[1], p[0]]);
    const bounds = ll.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(ll[0], ll[0]));
    this.map = new maplibregl.Map({
      container: this.el, attributionControl: false, maxPitch: 60,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef2ea' } }] },
      bounds, fitBoundsOptions: { padding: 44, maxZoom: 16, duration: 0 }
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© OpenStreetMap contributors · OpenFreeMap' }));
    this.map.on('style.load', () => this._addLine());
    this.map.on('styledata', () => { if (!this.dead && !this.map.getSource('trip') && this.map.isStyleLoaded()) this._addLine(); });
    this.map.on('zoom', () => container.classList.toggle('gl-far', this.map.getZoom() < 12.5));
    this.map.on('error', () => { /* tuiles manquantes */ });
    o.stops.forEach(s => {
      const el = document.createElement('div');
      el.className = 'tp-pin tp-' + s.role;
      el.appendChild(document.createElement('i'));
      if (s.role !== 'mid' || o.stops.length < 40) { const t = document.createElement('span'); t.textContent = s.name; el.appendChild(t); }
      this.markers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [s.role === 'mid' ? -5 : -8, 0] }).setLngLat([s.lon, s.lat]).addTo(this.map));
    });
    this._loadStyle();
  }

  async _loadStyle() {
    try {
      const r = await fetch(GLNet.STYLE_URL);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const style = await r.json();
      if (!this.dead) this.map.setStyle(style, { diff: false });
    } catch (e) { /* fond indisponible : le tracé reste visible */ }
  }

  _addLine() {
    const m = this.map;
    if (this.dead || m.getSource('trip')) return;
    try {
      m.addSource('trip', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this.o.pts.map(p => [p[1], p[0]]) } } });
      const sym = m.getStyle && (m.getStyle().layers || []).find(l => l.type === 'symbol');
      const join = { 'line-cap': 'round', 'line-join': 'round' };
      m.addLayer({ id: 'trip-casing', type: 'line', source: 'trip', layout: join, paint: { 'line-color': '#111111', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 16, 13] } }, sym && sym.id);
      m.addLayer({ id: 'trip-line', type: 'line', source: 'trip', layout: join, paint: { 'line-color': this.o.color || '#115e88', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 3, 16, 8] } }, sym && sym.id);
    } catch (e) { console.warn('Tracé non ajouté à la carte :', e); }
  }

  resize() { try { this.map.resize(); } catch (e) { /* ignoré */ } }

  destroy() {
    this.dead = true;
    try { this.map.remove(); } catch (e) { /* ignoré */ }
    this.container.replaceChildren();
  }

  static _style() {
    if (document.getElementById('gl-trip-style')) return;
    const st = document.createElement('style');
    st.id = 'gl-trip-style';
    st.textContent = `
      .gl-trip{width:100%;height:100%;aspect-ratio:auto}
      .tp-pin{display:flex;align-items:center;gap:.4em;font:700 12px/1 system-ui,sans-serif;color:#0b3a57;pointer-events:none;
        text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff}
      .tp-pin i{flex:none;border-radius:50%;background:#fff;border:3px solid #111;box-sizing:border-box;width:16px;height:16px}
      .tp-pin.tp-from i{background:#1d9d4a;border-color:#fff;box-shadow:0 0 0 2px #111;width:18px;height:18px}
      .tp-pin.tp-to i{background:#d33;border-color:#fff;box-shadow:0 0 0 2px #111;width:18px;height:18px}
      .tp-pin.tp-mid i{width:10px;height:10px;border-width:2px}
      .tp-pin.tp-mid{font-weight:600;font-size:11px}
      .gl-far .tp-pin.tp-mid span{display:none}
    `;
    document.head.appendChild(st);
  }
}

window.GLNet = GLNet;
window.GLPicker = GLPicker;
window.GLTrip = GLTrip;
