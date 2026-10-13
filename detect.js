// detect.js — détection du service en cours à partir de positions GNSS.
//   Segments.derive(réseau)      -> index des segments (paire d'arrêts ordonnée : A>B), dérivé des services
//   new Detector(réseau)         -> .feed({t, lat, lon, acc, speed, heading}) renvoie l'état de la détection
//   Detector.simulate(service,…) -> trace GNSS synthétique (tests et démonstration)
// Principe : chaque position vote pour les segments proches (grille ~200 m, cap, précision) ; chaque service qui
// emprunte un de ces segments reçoit une vraisemblance (écart au tracé, cap, horaire théorique à cet endroit,
// circulation ce jour-là d'après le calendrier). Les scores s'accumulent avec oubli progressif (demi-vie ~45 s).
// Aucune dépendance au DOM : le module se teste hors navigateur.

const Segments = {
  CELL: 200,        // taille d'une case de la grille (m)
  STEP: 25,         // pas de ré-échantillonnage des tracés (m)

  // Projection plane locale autour de (lat0, lon0) : [x, y] en mètres
  proj(lat0, lon0) {
    const kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
    return (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky];
  },

  minutes(hhmm) {
    if (typeof hhmm !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
    return m ? +m[1] * 60 + +m[2] : null;
  },

  // Index : { segs: Map(clé -> segment), byService: Map(id -> [clés dans l'ordre]), grid: Map(case -> [échantillons]), P }
  derive(net) {
    const stops = net.stops.filter(s => s.lat !== null && s.lon !== null);
    const lat0 = stops.length ? stops.reduce((a, s) => a + s.lat, 0) / stops.length : 0;
    const lon0 = stops.length ? stops.reduce((a, s) => a + s.lon, 0) / stops.length : 0;
    const P = Segments.proj(lat0, lon0);
    const segs = new Map(), byService = new Map();

    for (const sv of net.services) {
      const keys = [];
      const sts = sv.stopTimes;
      for (let i = 0; i + 1 < sts.length; i++) {
        const a = sts[i].stop, b = sts[i + 1].stop;
        if (a.lat === null || a.lon === null || b.lat === null || b.lon === null) { keys.push(null); continue; }
        const key = a.id + '>' + b.id;
        keys.push(key);
        let seg = segs.get(key);
        if (!seg) { seg = { key, from: a, to: b, path: null, shaped: false, services: [] }; segs.set(key, seg); }
        const shaped = sv.shapeValid;
        const path = sv.sectionPath(i, i + 1);
        if (path.length >= 2 && (!seg.path || (shaped && !seg.shaped))) { seg.path = path; seg.shaped = shaped; }
        const dep = sts[i].departure != null ? sts[i].departure : sts[i].arrival;
        const arr = sts[i + 1].arrival != null ? sts[i + 1].arrival : sts[i + 1].departure;
        seg.services.push({ service: sv, index: i, t0: Segments.minutes(dep), t1: Segments.minutes(arr) });
      }
      byService.set(sv.id, keys);
    }

    const grid = new Map();
    const cellOf = (x, y) => Math.floor(x / Segments.CELL) + ',' + Math.floor(y / Segments.CELL);
    for (const seg of segs.values()) {
      if (!seg.path) { seg.len = 0; seg.pts = []; continue; }
      // ré-échantillonnage à pas fixe, en repère local
      const raw = seg.path.map(p => P(p[0], p[1]));
      const pts = [raw[0]];
      let acc = 0;
      for (let i = 1; i < raw.length; i++) {
        let [x0, y0] = raw[i - 1]; const [x1, y1] = raw[i];
        let d = Math.hypot(x1 - x0, y1 - y0);
        while (acc + d >= Segments.STEP) {
          const f = (Segments.STEP - acc) / d;
          x0 += (x1 - x0) * f; y0 += (y1 - y0) * f;
          pts.push([x0, y0]);
          d = Math.hypot(x1 - x0, y1 - y0); acc = 0;
        }
        acc += d;
      }
      const last = raw[raw.length - 1], lp = pts[pts.length - 1];
      if (Math.hypot(last[0] - lp[0], last[1] - lp[1]) > 1) pts.push(last);
      seg.pts = pts;
      // abscisse curviligne et cap en chaque échantillon
      seg.cum = [0];
      for (let i = 1; i < pts.length; i++) seg.cum.push(seg.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      seg.len = seg.cum[seg.cum.length - 1];
      seg.brg = pts.map((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        return (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
      });
      // centroïde et rayon (préfiltre grossier)
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      seg.centroid = [cx, cy];
      seg.radius = Math.max(...pts.map(p => Math.hypot(p[0] - cx, p[1] - cy)));
      pts.forEach((p, i) => {
        const c = cellOf(p[0], p[1]);
        let l = grid.get(c);
        if (!l) grid.set(c, l = []);
        l.push([seg, i]);
      });
    }
    return { segs, byService, grid, P, cellOf };
  },

  // Segments proches d'un point (repère local) : Map(clé -> {seg, d, s, brg}) ; d = distance au tracé, s = abscisse (m)
  near(ix, x, y, r) {
    const C = Segments.CELL, out = new Map();
    const x0 = Math.floor((x - r) / C), x1 = Math.floor((x + r) / C), y0 = Math.floor((y - r) / C), y1 = Math.floor((y + r) / C);
    const seen = new Set();
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const l = ix.grid.get(cx + ',' + cy);
      if (!l) continue;
      for (const [seg, i] of l) {
        const id = seg.key + '#' + i;
        if (seen.has(id)) continue;
        seen.add(id);
        if (Math.hypot(x - seg.centroid[0], y - seg.centroid[1]) > seg.radius + r) continue;
        // projection sur les deux arêtes qui touchent l'échantillon i
        for (const k of [i - 1, i]) {
          if (k < 0 || k + 1 >= seg.pts.length) continue;
          const a = seg.pts[k], b = seg.pts[k + 1];
          const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
          const f = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0;
          const d = Math.hypot(x - (a[0] + f * dx), y - (a[1] + f * dy));
          const cur = out.get(seg.key);
          if (d <= r && (!cur || d < cur.d)) {
            const s = seg.cum[k] + f * (seg.cum[k + 1] - seg.cum[k]);
            out.set(seg.key, { seg, d, s, brg: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 });
          }
        }
      }
    }
    return out;
  }
};

class Detector {
  constructor(net, opts = {}) {
    this.net = net;
    this.opt = Object.assign({
      halfLife: 45,       // s : oubli des anciennes positions
      K: 6,               // nombre équivalent de positions indépendantes (aplatit les scores)
      outLL: -5,          // vraisemblance d'une position sans segment du service à proximité
      maxAcc: 150,        // m : positions plus imprécises ignorées
      lockP: 0.8, probP: 0.45,
      sigmaEarly: 4, sigmaLate: 12    // min : tolérance sur l'écart à l'horaire (en avance / en retard)
    }, opts);
    this.ix = Segments.derive(net);
    this.reset();
  }

  reset() {
    this.score = new Map();     // id service -> score cumulé
    this.last = null;           // dernière position utile
    this.pos = new Map();       // id service -> {index, seg, s, t}
    this.n = 0;                 // positions utiles
    this._weight = 0;
    this.matched = 0;           // positions ayant au moins un segment à proximité
    this.state = { status: 'none', candidates: [], n: 0 };
  }

  get segmentCount() { return this.ix.segs.size; }

  static angle(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  // Une position : {t: ms (Date.now), lat, lon, acc (m), speed (m/s) ou null, heading (°) ou null}
  feed(fx) {
    const o = this.opt, ix = this.ix;
    if (!Number.isFinite(fx.lat) || !Number.isFinite(fx.lon)) return this.state;
    const acc = Number.isFinite(fx.acc) ? fx.acc : 20;
    if (acc > o.maxAcc) return this.state;
    const [x, y] = ix.P(fx.lat, fx.lon);
    const t = fx.t || Date.now();

    // cap : fourni, sinon déduit du déplacement depuis la position précédente
    let heading = Number.isFinite(fx.heading) ? fx.heading : null, speed = Number.isFinite(fx.speed) ? fx.speed : null;
    if (this.last) {
      const dx = x - this.last.x, dy = y - this.last.y, dm = Math.hypot(dx, dy), dt = (t - this.last.t) / 1000;
      if (heading === null && dm > Math.max(15, acc)) heading = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      if (speed === null && dt > 0) speed = dm / dt;
    }
    const moving = speed !== null && speed >= 2 && heading !== null;

    const dtLast = this.last ? Math.max(0, (t - this.last.t) / 1000) : 0;
    const lambda = Math.pow(0.5, dtLast / o.halfLife);
    this.last = { x, y, t };
    this.n++;
    this._weight = lambda * (this._weight || 0) + 1;

    const radius = Math.min(300, Math.max(40, 2.5 * acc));
    const sigma = Math.max(12, 0.8 * acc);
    const near = Segments.near(ix, x, y, radius);
    if (near.size) this.matched++;

    const date = new Date(t);
    const nowMin = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
    const runs = new Map();
    const runsToday = sv => { if (!runs.has(sv.id)) runs.set(sv.id, sv.runsOn(date, this.net)); return runs.get(sv.id); };

    // meilleure vraisemblance par service
    const ll = new Map(), hit = new Map();
    for (const m of near.values()) {
      for (const inst of m.seg.services) {
        const sv = inst.service;
        let v = -Math.min(0.5 * (m.d / sigma) ** 2, 5);
        if (moving) v -= Math.min((Detector.angle(heading, m.brg) / 50) ** 2, 4);
        let sched = null, delay = null;
        if (inst.t0 !== null && inst.t1 !== null && m.seg.len > 0) {
          sched = inst.t0 + (inst.t1 - inst.t0) * Math.min(1, m.s / m.seg.len);
          delay = nowMin - sched;
          v -= Math.min((delay / (delay < 0 ? o.sigmaEarly : o.sigmaLate)) ** 2, 6);
        }
        if (!runsToday(sv)) v -= 3;
        // continuité : ne pas revenir en arrière sur le service
        const prev = this.pos.get(sv.id);
        if (prev && inst.index < prev.index) v -= 2;
        if (!ll.has(sv.id) || v > ll.get(sv.id)) {
          ll.set(sv.id, v);
          hit.set(sv.id, { index: inst.index, seg: m.seg, s: m.s, d: m.d, sched, delay, inst });
        }
      }
    }
    for (const sv of this.net.services) {
      const v = ll.has(sv.id) ? ll.get(sv.id) : o.outLL;
      this.score.set(sv.id, lambda * (this.score.get(sv.id) || 0) + v);
      if (hit.has(sv.id)) this.pos.set(sv.id, { ...hit.get(sv.id), t });
    }
    this.state = this._summarize(near.size > 0, t);
    return this.state;
  }

  _summarize(inNetwork, t) {
    const o = this.opt;
    const svs = this.net.services;
    const rows = svs.map(sv => ({ sv, s: this.score.get(sv.id) || 0 }));
    // poids total de la fenêtre d'oubli (somme des λ^j) : ramène le score cumulé à une moyenne, puis × K
    const norm = o.K / (this._weight || 1);
    const mx = Math.max(...rows.map(r => r.s));
    const ex = rows.map(r => Math.exp((r.s - mx) * norm));
    const tot = ex.reduce((a, b) => a + b, 0);
    const cands = rows.map((r, i) => ({ service: r.sv, p: ex[i] / tot, score: r.s }))
      .sort((a, b) => b.p - a.p).slice(0, 5)
      .map(c => {
        const pos = this.pos.get(c.service.id);
        const fresh = pos && t - pos.t < 120000;
        const out = { service: c.service, p: c.p, score: c.score, fresh: !!fresh };
        if (fresh) {
          const sts = c.service.stopTimes;
          out.index = pos.index;                              // tronçon courant : entre stopTimes[index] et [index+1]
          out.next = sts[pos.index + 1];
          out.prevStop = sts[pos.index];
          out.progress = pos.seg.len ? Math.min(1, pos.s / pos.seg.len) : 0;
          out.offRoute = pos.d;
          out.delay = pos.delay;                              // minutes (> 0 : en retard)
        }
        return out;
      });
    const top = cands[0];
    let status = 'none';
    if (!this.matched || !inNetwork && !(top && top.fresh)) status = 'off';
    else if (top && top.fresh && this.matched >= 3 && top.p >= o.lockP) status = 'locked';
    else if (top && top.fresh && top.p >= o.probP) status = 'probable';
    else if (top && top.fresh) status = 'ambiguous';
    return { status, candidates: cands, n: this.n, matched: this.matched, best: status === 'locked' || status === 'probable' ? top : null };
  }

  // Trace synthétique d'un service : positions toutes les `every` s, bruit gaussien σ = `noise` m.
  //   opts : {date: Date (jour du trajet), every: 5, noise: 8, delay: 0 (min), from: 0, to: n-1 (indices d'arrêts),
  //           heading: true, dwell: arrêt de 20 s si les horaires sont identiques, seed}
  static simulate(sv, opts = {}) {
    const o = Object.assign({ every: 5, noise: 8, delay: 0, heading: true, seed: 1 }, opts);
    let seed = o.seed >>> 0 || 1;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const sts = sv.stopTimes;
    const from = o.from || 0, to = o.to != null ? o.to : sts.length - 1;
    const lat0 = sts[0].stop.lat, lon0 = sts[0].stop.lon;
    const kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
    const day = o.date || new Date();
    const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const fixes = [];
    let prev = null;
    for (let i = from; i < to; i++) {
      const a = sts[i], b = sts[i + 1];
      const t0 = Segments.minutes(a.departure != null ? a.departure : a.arrival), t1 = Segments.minutes(b.arrival != null ? b.arrival : b.departure);
      if (t0 === null || t1 === null) continue;
      const path = sv.sectionPath(i, i + 1);
      const cum = [0];
      for (let k = 1; k < path.length; k++) cum.push(cum[k - 1] + Math.hypot((path[k][1] - path[k - 1][1]) * kx, (path[k][0] - path[k - 1][0]) * ky));
      const L = cum[cum.length - 1];
      for (let sec = t0 * 60; sec <= t1 * 60; sec += o.every) {
        const f = t1 > t0 ? (sec - t0 * 60) / ((t1 - t0) * 60) : 1, d = f * L;
        let k = 1; while (k < cum.length - 1 && cum[k] < d) k++;
        const u = cum[k] > cum[k - 1] ? (d - cum[k - 1]) / (cum[k] - cum[k - 1]) : 0;
        const lat = path[k - 1][0] + (path[k][0] - path[k - 1][0]) * u, lon = path[k - 1][1] + (path[k][1] - path[k - 1][1]) * u;
        const brg = (Math.atan2((path[k][1] - path[k - 1][1]) * kx, (path[k][0] - path[k - 1][0]) * ky) * 180 / Math.PI + 360) % 360;
        const nl = lat + gauss() * o.noise / ky, nn = lon + gauss() * o.noise / kx;
        const speed = L / Math.max(1, (t1 - t0) * 60);
        fixes.push({ t: midnight + (sec + o.delay * 60) * 1000, lat: nl, lon: nn, acc: Math.max(5, o.noise * 1.5),
          speed, heading: o.heading ? brg : null });
      }
    }
    return fixes;
  }
}

if (typeof window !== 'undefined') { window.Segments = Segments; window.Detector = Detector; }
