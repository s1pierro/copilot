// routing.js — tracé réel d'un service le long des routes OpenStreetMap, via des moteurs de routage publics.
//   Routing.compute(service) -> { pts:[[lat,lon]…], m, s, sig, profile, via } (ne modifie pas le service)
// Valhalla (valhalla1.openstreetmap.de) en premier, puis OSRM (serveurs d'OSM Allemagne / projet OSRM) en secours.
// Services publics à usage raisonnable : le résultat est mémorisé dans le service (Service.shape), un seul appel suffit.

const Routing = {
  VALHALLA: 'https://valhalla1.openstreetmap.de/route',
  OSRM: { bus: 'https://router.project-osrm.org/route/v1/driving/', bicycle: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/' },
  TIMEOUT: 20000,

  // Profil de calcul selon le mode du service ; null = pas de tracé routier (voies ferrées…)
  profileFor(mode) {
    if (mode === 'bus' || mode === 'car' || mode === 'voiture') return 'bus';
    if (mode === 'velo' || mode === 'velo-libre-service') return 'bicycle';
    return null;
  },

  sig(service) {
    return service.stopTimes.map(t => t.stop.id).join('>') + '|' + (Routing.profileFor(service.mode) || '');
  },

  async compute(service) {
    const profile = Routing.profileFor(service.mode);
    if (!profile) throw new Error('Ce mode ne suit pas les routes : tracé routier indisponible.');
    const stops = service.stopTimes.map(t => t.stop);
    if (stops.length < 2) throw new Error('Il faut au moins deux arrêts.');
    const missing = stops.filter(s => s.lat === null || s.lon === null);
    if (missing.length) throw new Error('Arrêts sans coordonnées : ' + [...new Set(missing.map(s => s.name))].join(', ') + '.');
    const pts = stops.map(s => [s.lat, s.lon]);

    let lastErr = null;
    for (const [name, fn] of [['Valhalla', Routing._valhalla], ['OSRM', Routing._osrm]]) {
      try {
        const r = await Routing._chunked(pts, profile, fn);
        return { pts: Routing.simplify(r.pts, 3), m: Math.round(r.m), s: Math.round(r.s), sig: Routing.sig(service), profile, via: name };
      } catch (e) { lastErr = e; }
    }
    throw new Error('Calcul impossible (hors ligne, ou service de routage indisponible).' + (lastErr && lastErr.message ? ' ' + lastErr.message : ''));
  },

  // Les moteurs publics limitent le nombre de points : on découpe en tronçons qui se chevauchent d'un arrêt
  async _chunked(pts, profile, fn) {
    const N = 12, out = [];
    let m = 0, s = 0;
    for (let i = 0; i < pts.length - 1; i += N - 1) {
      const r = await fn(pts.slice(i, i + N), profile);
      if (!r.pts.length) throw new Error('Tracé vide.');
      out.push(...(out.length ? r.pts.slice(1) : r.pts));
      m += r.m; s += r.s;
    }
    return { pts: out, m, s };
  },

  async _get(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Routing.TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  },

  async _valhalla(pts, profile) {
    const body = { locations: pts.map(p => ({ lat: p[0], lon: p[1], type: 'break' })), costing: profile,
      directions_options: { units: 'kilometers' } };
    const j = await Routing._get(Routing.VALHALLA + '?json=' + encodeURIComponent(JSON.stringify(body)));
    if (!j.trip || !j.trip.legs) throw new Error('Réponse Valhalla invalide.');
    const out = [];
    j.trip.legs.forEach(l => { const d = Routing.decode(l.shape, 6); out.push(...(out.length ? d.slice(1) : d)); });
    return { pts: out, m: (j.trip.summary.length || 0) * 1000, s: j.trip.summary.time || 0 };
  },

  async _osrm(pts, profile) {
    const base = Routing.OSRM[profile];
    const url = base + pts.map(p => p[1].toFixed(6) + ',' + p[0].toFixed(6)).join(';') + '?overview=full&geometries=geojson&steps=false';
    const j = await Routing._get(url);
    if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error('Réponse OSRM invalide.');
    const r = j.routes[0];
    return { pts: r.geometry.coordinates.map(c => [c[1], c[0]]), m: r.distance, s: r.duration };
  },

  // Polyligne encodée (Google / Valhalla, précision 6 ou 5) -> [[lat, lon]…]
  decode(str, prec) {
    const f = Math.pow(10, prec), out = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (const k of [0, 1]) {
        let sh = 0, res = 0, b;
        do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << sh; sh += 5; } while (b >= 32);
        const d = (res & 1) ? ~(res >> 1) : (res >> 1);
        if (k === 0) lat += d; else lon += d;
      }
      out.push([lat / f, lon / f]);
    }
    return out;
  },

  // Douglas-Peucker (tolérance en mètres) puis arrondi à 5 décimales (~1 m) : tracé léger à stocker
  simplify(pts, tol) {
    if (pts.length < 3) return pts.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]);
    const k = 111320, c = Math.cos(pts[0][0] * Math.PI / 180);
    const xy = pts.map(p => [p[1] * k * c, p[0] * k]);
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let dmax = 0, idx = -1;
      const [ax, ay] = xy[a], [bx, by] = xy[b];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) {
        let t = L ? ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / L : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
        if (d > dmax) { dmax = d; idx = i; }
      }
      if (dmax > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]);
  },

  // Longueur en mètres d'une suite de points [lat, lon] (haversine)
  length(pts) {
    let m = 0;
    for (let i = 1; i < pts.length; i++) {
      const r = Math.PI / 180, a = pts[i - 1], b = pts[i];
      const h = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
      m += 2 * 6371000 * Math.asin(Math.sqrt(h));
    }
    return m;
  },

  label(shape) {
    const km = shape.m / 1000, min = Math.max(1, Math.round(shape.s / 60));
    return (km < 10 ? km.toFixed(1) : Math.round(km)).toString().replace('.', ',') + ' km · ' + min + ' min de route';
  }
};

window.Routing = Routing;
