
class LightMap {
  constructor(domdest, target = '49.283572,1.557704', size = 3000) {
    console.log('🗺️ LightMap init');
    this.container = domdest;
    this.homePos = target;
    this.geoData = null;
    this.agglomerationData = null;
    this.elevations = null;
    
    this.updateBBox(target, size);
    this.initRender();
    this.initControls();
    this.loadMap();
  }
  // --- 🎯 Calcul de la BBox ---
  updateBBox(target, size) {
    const [latC, lonC] = target.split(',').map(Number);
    const earthRadius = 6378137;
    const pCenter = this.mercatorProject(lonC, latC);
    const delta = size / earthRadius;

    const minX = pCenter.x - delta, maxX = pCenter.x + delta;
    const minY = pCenter.y - delta, maxY = pCenter.y + delta;

    const sw = this.mercatorUnproject(minX, minY);
    const ne = this.mercatorUnproject(maxX, maxY);

    this.targetbbox = {
      string: [sw.lat.toFixed(6), sw.lon.toFixed(6), ne.lat.toFixed(6), ne.lon.toFixed(6)].join(','),
      lat: { min: sw.lat, max: ne.lat },
      long: { min: sw.lon, max: ne.lon }
    };
    
    this.bbox = this.projectBBox();
  }
  // --- 📐 Projections Mercator ---
  mercatorProject(lon, lat) {
    const λ = lon * Math.PI / 180;
    const φ = lat * Math.PI / 180;
    return {
      x: λ,
      y: Math.log(Math.tan(Math.PI / 4 + φ / 2))
    };
  }
  mercatorUnproject(x, y) {
    return {
      lon: x * 180 / Math.PI,
      lat: (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI
    };
  }
  projectBBox() {
    const { lat, long } = this.targetbbox;
    const p1 = this.mercatorProject(long.min, lat.min);
    const p2 = this.mercatorProject(long.max, lat.max);

    return {
      minX: Math.min(p1.x, p2.x),
      maxX: Math.max(p1.x, p2.x),
      minY: Math.min(p1.y, p2.y),
      maxY: Math.max(p1.y, p2.y),
      ...lat, ...long
    };
  }
  // --- 🎨 Initialisation du rendu
  initRender(width = 500, height = 500) {
    const svgNS = "http://www.w3.org/2000/svg";
    this.svgrender = document.createElementNS(svgNS, "svg");
    this.svgrender.setAttribute("width", width);
    this.svgrender.setAttribute("height", height);
    this.svgrender.setAttribute("viewBox", `0 0 ${width} ${height}`);
    Object.assign(this.svgrender.style, {
      border: "1px solid rgba(0,0,0,0.08)",
      display: "block",
      background: "#0000"
    });

    this.container.innerHTML = "";
    this.container.appendChild(this.svgrender);

    // Groupes de calques
    this.layers = {
      ground: this.createLayer("ground-layer"),
      top: this.createLayer("top-layer")
    };
  }
  createLayer(className) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", className);
    this.svgrender.appendChild(g);
    return g;
  }
  // --- 🎛️ Interface utilisateur ---
  initControls() {
    this.container.style.position = "relative";
    this.createControlPanel();
    this.createLocateButton();
  }
  createControlPanel() {
    const panel = document.createElement("div");
    panel.className = "lightmap-panel state-hidden";
    
    const content = document.createElement("div");
    content.className = "lightmap-panel-content";
    content.innerHTML = '<b>Contrôles carte</b><br>État : <span class="panel-state-label">Masqué</span>';
    panel.appendChild(content);

    const toggleBtn = document.createElement("div");
    toggleBtn.className = "lightmap-toggle-btn";
    toggleBtn.innerHTML = '<i class="icon-cog"></i>';
    toggleBtn.title = "Changer mode panneau";

    const states = ["state-hidden", "state-compact", "state-full"];
    let current = 0;

    toggleBtn.onclick = () => {
      panel.classList.replace(states[current], states[current = (current + 1) % 3]);
      content.querySelector(".panel-state-label").textContent = ["Masqué", "Compact", "Plein écran"][current];
      toggleBtn.style.transform = `rotate(${current * 45}deg)`;
    };

    this.container.appendChild(toggleBtn);
    this.container.appendChild(panel);
    this.ctrlPanel = panel;
    this.ctrlPanelContent = content;
  }
  createLocateButton() {
    const btn = document.createElement("div");
    btn.className = "lightmap-locate-btn";
    btn.innerHTML = '<i class="icon-target"></i>';
    btn.title = "Localiser ma position";
    
    btn.onclick = async () => {
      btn.style.transform = "scale(0.9)";
      setTimeout(() => btn.style.transform = "scale(1)", 200);

      const routeInfo = await this.centerBetweenHomeAndCurrent();
      if (!routeInfo) return alert("Position GPS indisponible");

      await this.drawRoute(routeInfo.from, routeInfo.to);
    };

    this.container.appendChild(btn);
  }
  // --- 🌐 Récupération des données
  async loadMap() {
    try {
      await this.fetchGeoData();
      await this.fetchAgglomerationData();
      this.render();
      this.addLayerControls();
      this.addReliefControl();
    } catch (err) {
      console.error("❌ Erreur chargement carte:", err);
    }
  }
  async fetchGeoData(forceRefresh = false) {
    const key = `LightMapCache_${this.targetbbox.string}`;
    
    if (!forceRefresh) {
      const cached = await this.dbGet("geoCache", key);
      if (cached) {
        console.log("📦 Chargement depuis cache");
        this.geoData = cached;
        return cached;
      }
    }

    const diagKm = this.getDiagonalKm();
    const includeBuildings = diagKm < 2.0;
    
    const query = `
      [out:json][timeout:25];
      (
        way["highway"](${this.targetbbox.string});
        ${includeBuildings ? `way["building"](${this.targetbbox.string});` : ''}
        way["landuse"~"forest|meadow|grass|vineyard|orchard|farmland"](${this.targetbbox.string});
        way["natural"~"water|wetland|wood|beach|sand"](${this.targetbbox.string});
        way["leisure"~"park|garden|nature_reserve"](${this.targetbbox.string});
        node["place"~"city|town|village"](${this.targetbbox.string});
      );
      out geom;
    `;

    const url = "https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(query);
    this.geoData = await this.fetchWithRetry(url);
    
    await this.dbSet("geoCache", key, this.geoData);
    return this.geoData;
  }
  async fetchAgglomerationData() {
    const query = `
      [out:json][timeout:25];
      (
        relation["admin_level"="8"](${this.targetbbox.string});
        way["place"~"city|town|village"](${this.targetbbox.string});
      );
      out geom;
    `;
    const url = "https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(query);
    this.agglomerationData = await this.fetchWithRetry(url);
  }
  async fetchWithRetry(url, maxAttempts = 3, delay = 1500) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        await new Promise(r => setTimeout(r, delay * attempt));
      }
    }
  }
  // --- 🎨 Rendu de la carte ---
  render(width = 500, height = 500, padding = 10) {
    this.layers.ground.innerHTML = "";
    this.layers.top.innerHTML = "";
    
    const projToSvg = this.getProjection(width, height, padding);
    const diagKm = this.getDiagonalKm();
    
    this.drawRoads(projToSvg, diagKm);
    this.drawBuildings(projToSvg);
    this.drawNature(projToSvg);
    this.drawPlaces(projToSvg, diagKm);
    this.drawAgglomerations(projToSvg);
  }
  getProjection(width, height, padding) {
    const { minX, maxX, minY, maxY } = this.bbox;
    const viewW = width - 2 * padding;
    const viewH = height - 2 * padding;
    
    return (lon, lat) => {
      const p = this.mercatorProject(lon, lat);
      const nx = (p.x - minX) / (maxX - minX || 1);
      const ny = (p.y - minY) / (maxY - minY || 1);
      return {
        x: padding + nx * viewW,
        y: padding + (1 - ny) * viewH
      };
    };
  }
  getDiagonalKm() {
    const { lat, long } = this.targetbbox;
    return Math.hypot(lat.max - lat.min, long.max - long.min) * 111;
  }
  drawRoads(projToSvg, diagKm) {
    const highwayLevels = {
      main: ["motorway", "trunk", "primary", "secondary", "tertiary"],
      local: ["unclassified", "residential", "living_street", "service", "road"],
      rural: ["track", "path", "footway", "cycleway", "bridleway"]
    };

    let allowed = [];
    if (diagKm > 60) allowed = highwayLevels.main.slice(0, 2);
    else if (diagKm > 20) allowed = highwayLevels.main;
    else if (diagKm > 5) allowed = [...highwayLevels.main, ...highwayLevels.local];
    else allowed = [...highwayLevels.main, ...highwayLevels.local, ...highwayLevels.rural];

    const styles = {
      motorway: { stroke: "#f60", width: 3, opacity: 0.9 },
      trunk: { stroke: "#fd4", width: 2.6, opacity: 0.9 },
      primary: { stroke: "#fff", width: 2.2, opacity: 0.9 },
      secondary: { stroke: "#eee", width: 1.8, opacity: 0.9 },
      tertiary: { stroke: "#ddd", width: 1.4, opacity: 0.9 },
      residential: { stroke: "#bbb", width: 1, opacity: 0.7 },
      service: { stroke: "#aaa", width: 0.9, opacity: 0.6 },
      track: { stroke: "#775", width: 0.8, opacity: 0.5 },
      path: { stroke: "#484", width: 0.6, opacity: 0.4 }
    };

    this.geoData?.elements
      ?.filter(e => e.tags?.highway && allowed.includes(e.tags.highway))
      .forEach(e => {
        const style = styles[e.tags.highway] || styles.path;
        this.drawPath(e.geometry, projToSvg, style);
      });
  }
  drawBuildings(projToSvg) {
    this.geoData?.elements
      ?.filter(e => e.tags?.building)
      .forEach(e => {
        this.drawPath(e.geometry, projToSvg, {
          fill: "#999",
          stroke: "#333",
          width: 0.3,
          opacity: 0.7,
          closed: true
        });
      });
  }
  drawNature(projToSvg) {
    const colors = {
      water: "#66c",
      forest: "#385",
      beach: "#eec",
      sand: "#eec",
      default: "#6c6"
    };

    this.geoData?.elements
      ?.filter(e => e.tags?.natural || e.tags?.landuse || e.tags?.leisure)
      .forEach(e => {
        const fill = colors[e.tags.natural] || colors[e.tags.landuse] || colors.default;
        this.drawPath(e.geometry, projToSvg, { fill, opacity: 0.4, closed: true });
      });
  }
  drawPlaces(projToSvg, diagKm) {
    const sizes = { city: 6, town: 4, village: 3 };
    const colors = { city: "#a00", town: "#a55", village: "#a77" };
    const fontSizes = { city: 24, town: 18, village: 14 };

    this.geoData?.elements
      ?.filter(e => e.type === "node" && e.tags?.place)
      .forEach(e => {
        const type = e.tags.place;
        if (diagKm > 40 && type !== "city") return;
        
        const pos = projToSvg(e.lon, e.lat);
        this.drawCircle(pos, sizes[type], { fill: "#fff", stroke: colors[type] });
        
        if (e.tags.name) {
          this.drawTexto(e.tags.name, { x: pos.x + 5, y: pos.y - 5 }, {
            fontSize: fontSizes[type],
            fontFamily: "Roboto",
            fontWeight: "bold"
          });
        }
      });
  }
  drawAgglomerations(projToSvg) {
    const colors = { city: "#c55", town: "#d77", village: "#fbb", default: "#ddd" };
    
    this.agglomerationData?.elements
      ?.filter(e => e.geometry?.length >= 3)
      .forEach(e => {
        const fill = colors[e.tags.place] || colors.default;
        this.drawPath(e.geometry, projToSvg, {
          fill,
          opacity: 0.25,
          stroke: "#000",
          width: 0.2,
          closed: true
        });
      });
  }
  // --- 🛠️ Utilitaires de dessin SVG
  drawPath(geometry, projToSvg, style) {
    const coords = geometry.map(g => [g.lon, g.lat]);
    const d = coords.map((c, i) => {
      const p = projToSvg(c[0], c[1]);
      return `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
    }).join(' ') + (style.closed ? ' Z' : '');

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", style.fill || "none");
    if (style.stroke) path.setAttribute("stroke", style.stroke);
    if (style.width) path.setAttribute("stroke-width", style.width);
    if (style.opacity) path.setAttribute("opacity", style.opacity);
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    
    this.layers.ground.appendChild(path);
  }
  drawCircle(pos, radius, style) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", pos.x);
    circle.setAttribute("cy", pos.y);
    circle.setAttribute("r", radius);
    if (style.fill) circle.setAttribute("fill", style.fill);
    if (style.stroke) circle.setAttribute("stroke", style.stroke);
    circle.setAttribute("stroke-width", style.width || 0.6);
    this.layers.ground.appendChild(circle);
  }
  drawText(text, pos, style) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
    el.setAttribute("x", pos.x);
    el.setAttribute("y", pos.y);
    el.setAttribute("fill", style.fill || "#111");
    el.setAttribute("font-size", style.fontSize);
    el.setAttribute("font-family", style.fontFamily);
    el.setAttribute("font-weight", style.fontWeight);
    el.textContent = text;
    this.layers.ground.appendChild(el);
  }
  drawTexto(text, pos, style) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
    el.setAttribute("x", pos.x);
    el.setAttribute("y", pos.y);
    el.setAttribute("fill", style.fill || "#111");
    el.setAttribute("font-size", style.fontSize);
    el.setAttribute("font-family", style.fontFamily);
    el.setAttribute("font-weight", style.fontWeight);
    el.textContent = text;
    this.layers.ground.appendChild(el);
  }
  drawPancarte(text, pos, style = {}) {
    const svgNS = "http://www.w3.org/2000/svg";
  
    // Groupe principal
    const group = document.createElementNS(svgNS, "g");
    group.setAttribute("class", "pancarte");
    this.layers.ground.appendChild(group);
  
    // Élément texte
    const el = document.createElementNS(svgNS, "text");
    el.setAttribute("x", pos.x);
    el.setAttribute("y", pos.y);
    el.setAttribute("fill", style.fill || "#111");
    el.setAttribute("font-size", style.fontSize || 18);
    el.setAttribute("font-family", style.fontFamily || "Permanent");
    el.setAttribute("font-weight", style.fontWeight || "bold");
    el.textContent = text;
    group.appendChild(el);
  
    // On doit d'abord ajouter le texte pour obtenir son bbox
    const bbox = el.getBBox();
  
    // Fond rectangulaire derrière le texte
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", bbox.x - 8);
    rect.setAttribute("y", bbox.y - 4);
    rect.setAttribute("width", bbox.width + 12);
    rect.setAttribute("height", bbox.height + 4);
    rect.setAttribute("rx", 6);
    rect.setAttribute("ry", 6);
    rect.setAttribute("fill", style.bg || "#fff");
    rect.setAttribute("stroke", style.border || "#c00");
    rect.setAttribute("stroke-width", style.borderWidth || 3);
    rect.setAttribute("filter", "url(#shadow)");
  
    // Le rectangle doit précéder le texte dans le groupe
    group.insertBefore(rect, el);
  
    // Option : ombre portée via filtre SVG (créée une seule fois)
    if (!this._shadowFilterAdded) {
      const defs = document.createElementNS(svgNS, "defs");
      const filter = document.createElementNS(svgNS, "filter");
      filter.setAttribute("id", "shadow");
      filter.innerHTML = `
        <feDropShadow dx="2" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.3"/>
      `;
      defs.appendChild(filter);
      this.layers.ground.prepend(defs);
      this._shadowFilterAdded = true;
    }
  
    return group;
  }
  // --- 📍 Marqueurs et routage ---
  addMarker0(lon, lat, label = "", options = {}) {
    const projToSvg = this.getProjection(500, 500, 10);
    const pos = projToSvg(lon, lat);
    
    this.drawCircle(pos, options.radius || 5, {
      fill: options.color || "#ff0",
      stroke: options.stroke || "#000",
      width: options.strokeWidth || 5
    });
    
    if (label) {
      this.drawText(label, { x: pos.x + 8, y: pos.y - 10 }, {
        fontSize: options.fontSize || 20,
        fontFamily: "Permanent",
        fontWeight: "bold",
        fill: options.fontColor || "#222"
      });
    }
  }
  addMarker2(lon, lat, label = "", options = {}) {
  const projToSvg = this.getProjection(500, 500, 10);
  const pos = projToSvg(lon, lat);

  // --- Cercle du marqueur
  this.drawCircle(pos, options.radius || 5, {
    fill: options.color || "#ff0",
    stroke: options.stroke || "#000",
    width: options.strokeWidth || 5
  });

  if (label) {
    const svg = this.svg || document.querySelector("svg"); // ton conteneur
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", pos.x + 8);
    text.setAttribute("y", pos.y - 10);
    text.setAttribute("font-size", options.fontSize || 20);
    text.setAttribute("font-family", options.fontFamily || "Permanent");
    text.setAttribute("font-weight", "bold");
    text.setAttribute("fill", options.fontColor || "#222");
    text.textContent = label;
    svg.appendChild(text);

    // --- Calcul du fond
    const bbox = text.getBBox();
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", bbox.x - 4);
    rect.setAttribute("y", bbox.y - 2);
    rect.setAttribute("width", bbox.width + 8);
    rect.setAttribute("height", bbox.height + 4);
    rect.setAttribute("rx", 8);
    rect.setAttribute("ry", 8);
    rect.setAttribute("fill", options.labelBg || "rgba(255,255,255,0.7)");
    rect.setAttribute("stroke", options.labelBorder || "none");

    // --- Placer le rect avant le texte
    svg.insertBefore(rect, text);
  }
}
  addMarker(lon, lat, label = "", options = {}) {
  const projToSvg = this.getProjection(500, 500, 10);
  const pos = projToSvg(lon, lat);

  // --- Cercle du marqueur
  this.drawCircle(pos, options.radius || 5, {
    fill: options.color || "#ff0",
    stroke: options.stroke || "#000",
    width: options.strokeWidth || 5
  });

  if (label) {
    const svg = this.svg || document.querySelector("svg"); // ton conteneur
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", pos.x + 8);
    text.setAttribute("y", pos.y - 10);
    text.setAttribute("font-size", options.fontSize || 20);
    text.setAttribute("font-family", options.fontFamily || "Permanent");
    text.setAttribute("font-weight", "bold");
    text.setAttribute("fill", options.fontColor || "#222");
    text.textContent = label;
    svg.appendChild(text);

    // --- Calcul du fond
    const bbox = text.getBBox();
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", bbox.x - 4);
    rect.setAttribute("y", bbox.y - 2);
    rect.setAttribute("width", bbox.width + 8);
    rect.setAttribute("height", bbox.height + 4);
    rect.setAttribute("rx", 8);
    rect.setAttribute("ry", 8);
    rect.setAttribute("fill", options.labelBg || "rgba(255,255,255,0.7)");
    rect.setAttribute("stroke", options.labelBorder || "none");
rect.setAttribute("stroke-width", options.borderWidth || 3);
    // --- Placer le rect avant le texte
    svg.insertBefore(rect, text);
  }
}
  pancarte(lon, lat, label = "", options = {}) {
    const projToSvg = this.getProjection(500, 500, 10);
    const pos = projToSvg(lon, lat);
  
    const svg = this.svg || document.querySelector("svg");
  
    // --- Groupe global
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "pancarte");
    svg.appendChild(group);
  
    // --- Cercle indicateur (optionnel)
    this.drawCircle(pos, options.radius || 5, {
      fill: options.color || "#ff0",
      stroke: options.stroke || "#000",
      width: options.strokeWidth || 5
    });
  
    // --- Texte
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", pos.x + 8);
    text.setAttribute("y", pos.y - 10);
    text.setAttribute("font-size", options.fontSize || 20);
    text.setAttribute("font-family", options.fontFamily || "Permanent");
    text.setAttribute("font-weight", "bold");
    text.setAttribute("fill", options.fontColor || "#222");
    text.textContent = label;
    group.appendChild(text);
  
    // --- Calcul du fond (après insertion du texte)
    const bbox = text.getBBox();
  
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", bbox.x - 6);
    rect.setAttribute("y", bbox.y - 4);
    rect.setAttribute("width", bbox.width + 12);
    rect.setAttribute("height", bbox.height + 8);
    rect.setAttribute("rx", 6);
    rect.setAttribute("ry", 6);
    rect.setAttribute("fill", options.labelBg || "#fff");
    rect.setAttribute("stroke", options.labelBorder || "#c00");
    rect.setAttribute("stroke-width", options.borderWidth || 3);
  
    // --- Le rect doit apparaître avant le texte
    group.insertBefore(rect, text);
  
    // --- Position globale ajustée
    group.setAttribute("transform", `translate(${pos.x}, ${pos.y})`);
  }
  async drawRoute(from, to) {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    const data = await res.json();
    if (!data.routes?.[0]) throw new Error("Pas de route trouvée");
    
    const route = data.routes[0];
    const distanceKm = route.distance / 1000;
    const durationMin = route.duration / 60;
    
    const geom = route.geometry;
    const projToSvg = this.getProjection(500, 500, 10);
    
    geom.coordinates.forEach((coords, idx) => {
      if (idx === 0) return;
      const prev = projToSvg(geom.coordinates[idx - 1][0], geom.coordinates[idx - 1][1]);
      const curr = projToSvg(coords[0], coords[1]);
      
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", prev.x);
      line.setAttribute("y1", prev.y);
      line.setAttribute("x2", curr.x);
      line.setAttribute("y2", curr.y);
      line.setAttribute("stroke", "#f80");
      line.setAttribute("stroke-width", 4);
      line.setAttribute("opacity", 0.85);
      this.layers.top.appendChild(line);
    });
    
    this.addMarker(from.lon, from.lat, "FleurePizza", { color: "#09f" });
    this.addMarker(to.lon, to.lat, "Vous", { color: "#0f0", labelBorder: "#a00" });
    
    // 🎯 Émission de l'événement avec les données de la route
    this.dispatchRouteCalculated({
      from,
      to,
      distanceKm,
      durationMin,
      routeData: route
    });
    
    return { distanceKm, durationMin };
  }
  // Gestion des événements  
  dispatchRouteCalculated(routeInfo) {
    const event = new CustomEvent('routeCalculated', {
      detail: routeInfo,
      bubbles: true
    });
    this.container.dispatchEvent(event);
    console.log(`📡 Event dispatched: ${routeInfo.distanceKm.toFixed(2)} km, ${routeInfo.durationMin.toFixed(1)} min`);
  }
  // Méthode helper pour écouter l'événement
  onRouteCalculated(callback) {
    this.container.addEventListener('routeCalculated', (e) => callback(e.detail));
  }
  // Méthode helper pour retirer l'écouteur
  offRouteCalculated(callback) {
    this.container.removeEventListener('routeCalculated', callback);
  }
  async centerBetweenHomeAndCurrent() {
    const [latHome, lonHome] = this.homePos.split(',').map(Number);
    const pos = await this.getCurrentPosition();
    if (!pos) return null;

    const latCenter = (latHome + pos.lat) / 2;
    const lonCenter = (lonHome + pos.lon) / 2;
    
    const R = 6371;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(pos.lat - latHome);
    const dLon = toRad(pos.lon - lonHome);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(latHome)) * Math.cos(toRad(pos.lat)) * Math.sin(dLon / 2) ** 2;
    const distanceKm = 1.2 * R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    this.updateBBox(`${latCenter},${lonCenter}`, Math.max(distanceKm * 700, 300));
    await this.fetchGeoData(true);
    this.render();
    
    return {
      from: { lat: latHome, lon: lonHome },
      to: { lat: pos.lat, lon: pos.lon }
    };
  }
  async getCurrentPosition() {
    if (!navigator.geolocation) return null;
    
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }
  // --- 🎛️ Contrôles de calques ---
  addLayerControls() {
    const layers = [
      { key: "road", label: "Routes", selector: "path[stroke]" },
      { key: "building", label: "Bâtiments", selector: "path[fill='#999']" },
      { key: "nature", label: "Nature", selector: "path[fill='#6c6'], path[fill='#66c']" },
      { key: "place", label: "Villes", selector: "circle[stroke='#a00'], text" },
      { key: "marker", label: "Marqueurs", selector: "g.custom-marker" }
    ];

    const ctrl = document.createElement("div");
    ctrl.className = "lightmap-controls";
    ctrl.style.cssText = "display:flex; gap:.5em; margin-top:.5em; padding:.5em; background:#fff8; border-radius:.5em;";

    layers.forEach(l => {
      const label = document.createElement("label");
      label.style.cursor = "pointer";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = true;
      input.onchange = () => {
        this.svgrender.querySelectorAll(l.selector).forEach(el => {
          el.style.visibility = input.checked ? "visible" : "hidden";
        });
      };
      label.appendChild(input);
      label.appendChild(document.createTextNode(" " + l.label));
      ctrl.appendChild(label);
    });

    this.ctrlPanelContent.appendChild(ctrl);
  }
  addReliefControl() {
    // À implémenter si nécessaire
  }
  // --- 💾 IndexedDB ---
  async openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("LightMapDB", 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("geoCache")) {
          db.createObjectStore("geoCache");
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = reject;
    });
  }
  async dbSet(storeName, key, value) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = reject;
    });
  }
  async dbGet(storeName, key) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = reject;
    });
  }
  // Focus sur utilisateurs
  focusOnUsers(positions = []) {
    if (!positions.length) return;
    
    const lats = positions.map(p => p.lat);
    const lons = positions.map(p => p.lon);
    const latCenter = (Math.min(...lats) + Math.max(...lats)) / 2;
    const lonCenter = (Math.min(...lons) + Math.max(...lons)) / 2;
    
    const R = 6371;
    const latDist = (Math.max(...lats) - Math.min(...lats)) * Math.PI / 180 * R;
    const lonDist = (Math.max(...lons) - Math.min(...lons)) * Math.PI / 180 * R * Math.cos(latCenter * Math.PI / 180);
    const radiusKm = Math.max(latDist, lonDist) / 2;
    
    this.updateBBox(`${latCenter},${lonCenter}`, radiusKm * 1000);
    this.render();
    
    positions.forEach(p => this.addMarker(p.lon, p.lat, 'user'));
  }
  // Calcul d'itinéraire depuis la position d'origine (établissement)
  async calculateRouteFromHome() {
    const routeInfo = await this.centerBetweenHomeAndCurrent();
    if (!routeInfo) {
      alert("⚠️ Impossible de récupérer votre position GPS");
      return null;
    }
    
    try {
      const result = await this.drawRoute(routeInfo.from, routeInfo.to);
      return { ...routeInfo, ...result };
    } catch (err) {
      console.error("❌ Erreur calcul d'itinéraire:", err);
      alert("⚠️ Impossible de calculer l'itinéraire");
      return null;
    }
  }
}
