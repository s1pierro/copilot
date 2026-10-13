// models.js — structures de données du réseau de transport régional
// Chaque classe expose toJSON() (objet simple, sérialisable) et
// static fromJSON(obj) (reconstruction). JSON.stringify(obj) fonctionne directement.

/** Autorité organisatrice (la région). */
class Network {
  constructor({ id, name, region, icon = null, lineCodes = [], tariffs = [], services = [], providers = [], stops = [], zones = [], emissions = {}, lineInfo = {}, calendar = null } = {}) {
    this.id = id;
    this.name = name;         // ex. "Réseau régional Zou"
    this.region = region;     // ex. "Provence-Alpes-Côte d'Azur"
    this.icon = icon;         // data URL (png/webp) de l'icône importée, ou null
    this.lineCodes = Array.isArray(lineCodes) ? lineCodes : []; // codes ligne du réseau, ex. ['219', '220', 'L12']
    this.providers = providers;
    this.services = services;
    this.stops = stops;      // arrêts du réseau (indépendants des services)
    this.zones = zones;      // zones tarifaires / géographiques
    this.tariffs = tariffs;  // tarifications proposées (code, nom, public cible)
    this.emissions = Network.cleanEmissions(emissions);   // g CO₂e / passager·km modifiés, par mode (le reste : CO2_DEFAULTS)
    this.lineInfo = Network.cleanLineInfo(lineInfo);      // données complémentaires des lignes : { clé: { name, description } }
    this.calendar = Network.cleanCalendar(calendar);      // périodes de circulation : { holidays:[{date,name}], ranges:[{type,start,end}] }
  }

  // ----- Calendrier : petites vacances (pvs), vacances (vs), jours fériés. La période scolaire (ps) est déduite :
  // tout jour qui n'est ni en vacances ni férié. Dates au format ISO local « AAAA-MM-JJ ».
  static isoOk(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    const y = +s.slice(0, 4);
    return !isNaN(d) && d.toISOString().slice(0, 10) === s && y >= 2000 && y <= 2100;
  }
  static iso(d) {   // Date → « AAAA-MM-JJ » (jour local)
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  static addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  static cleanCalendar(o) {
    const out = { holidays: [], ranges: [] };
    if (!o || typeof o !== 'object') return out;
    const seen = new Set();
    (Array.isArray(o.holidays) ? o.holidays : []).slice(0, 800).forEach(h => {
      const date = h && h.date;
      if (!Network.isoOk(date) || seen.has(date)) return;
      seen.add(date);
      out.holidays.push({ date, name: typeof h.name === 'string' ? h.name.trim().slice(0, 40) : '' });
    });
    (Array.isArray(o.ranges) ? o.ranges : []).slice(0, 400).forEach(r => {
      if (!r || !['pvs', 'vs'].includes(r.type) || !Network.isoOk(r.start) || !Network.isoOk(r.end)) return;
      out.ranges.push({ type: r.type, start: r.start <= r.end ? r.start : r.end, end: r.start <= r.end ? r.end : r.start });
    });
    out.holidays.sort((a, b) => a.date.localeCompare(b.date));
    out.ranges.sort((a, b) => a.start.localeCompare(b.start));
    return out;
  }
  get hasCalendar() { return this.calendar.holidays.length > 0 || this.calendar.ranges.length > 0; }

  /** Nature d'un jour : { holiday, holidayName, pvs, vs, school }. */
  periodsOn(iso) {
    const h = this.calendar.holidays.find(x => x.date === iso);
    const inR = t => this.calendar.ranges.some(r => r.type === t && r.start <= iso && iso <= r.end);
    const pvs = inR('pvs'), vs = inR('vs');
    return { holiday: !!h, holidayName: h ? h.name : '', pvs, vs, school: !pvs && !vs };
  }
  // Retire [start, end] des périodes existantes (qui sont découpées au besoin)
  _cutRanges(start, end) {
    const out = [];
    this.calendar.ranges.forEach(r => {
      if (r.end < start || r.start > end) { out.push(r); return; }
      if (r.start < start) out.push({ type: r.type, start: r.start, end: Network.addDays(start, -1) });
      if (r.end > end) out.push({ type: r.type, start: Network.addDays(end, 1), end: r.end });
    });
    this.calendar.ranges = out;
  }
  _mergeRanges() {
    const rs = this.calendar.ranges.slice().sort((a, b) => a.start.localeCompare(b.start));
    const out = [];
    rs.forEach(r => {
      const last = out[out.length - 1];
      if (last && last.type === r.type && r.start <= Network.addDays(last.end, 1)) { if (r.end > last.end) last.end = r.end; }
      else out.push({ ...r });
    });
    this.calendar.ranges = out;
  }
  /** Définit une période de vacances (type 'pvs' | 'vs') ; elle remplace ce qui existait sur ces jours. */
  paintRange(type, a, b) {
    if (!['pvs', 'vs'].includes(type) || !Network.isoOk(a) || !Network.isoOk(b)) return;
    const [start, end] = a <= b ? [a, b] : [b, a];
    this._cutRanges(start, end);
    this.calendar.ranges.push({ type, start, end });
    this._mergeRanges();
  }
  /** Efface vacances et jours fériés sur [a, b]. */
  eraseRange(a, b) {
    if (!Network.isoOk(a) || !Network.isoOk(b)) return;
    const [start, end] = a <= b ? [a, b] : [b, a];
    this._cutRanges(start, end);
    this.calendar.holidays = this.calendar.holidays.filter(h => h.date < start || h.date > end);
  }
  setHoliday(date, on, name = '') {
    if (!Network.isoOk(date)) return;
    this.calendar.holidays = this.calendar.holidays.filter(h => h.date !== date);
    if (on) {
      this.calendar.holidays.push({ date, name: String(name || '').trim().slice(0, 40) });
      this.calendar.holidays.sort((a, b) => a.date.localeCompare(b.date));
    }
  }
  /** Jours fériés de France métropolitaine pour une année : [{ date, name }] */
  static frenchHolidays(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    const easter = y + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    return [
      [y + '-01-01', 'Jour de l’an'], [Network.addDays(easter, 1), 'Lundi de Pâques'], [y + '-05-01', 'Fête du Travail'],
      [y + '-05-08', 'Victoire 1945'], [Network.addDays(easter, 39), 'Ascension'], [Network.addDays(easter, 50), 'Lundi de Pentecôte'],
      [y + '-07-14', 'Fête nationale'], [y + '-08-15', 'Assomption'], [y + '-11-01', 'Toussaint'],
      [y + '-11-11', 'Armistice 1918'], [y + '-12-25', 'Noël']
    ].map(([date, name]) => ({ date, name }));
  }

  // ----- Lignes : déduites des services (même code dans le réseau), complétées par lineInfo
  /** Clé de la ligne d'un service : son code (à défaut, son nom), casse ignorée. */
  static lineKey(sv) {
    return String(sv.code || sv.name || '').trim().toLowerCase();
  }
  static cleanLineInfo(o) {
    const out = {};
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      Object.keys(o).slice(0, 1000).forEach(k0 => {
        const v = o[k0];
        const k = k0.includes('|') ? k0.slice(k0.indexOf('|') + 1) : k0;   // anciennes clés « mode|code »
        if (!v || typeof v !== 'object' || k.length > 80 || out[k]) return;
        const name = typeof v.name === 'string' ? v.name.trim().slice(0, 80) : '';
        const description = typeof v.description === 'string' ? v.description.trim().slice(0, 1000) : '';
        if (name || description) out[k] = { name, description };
      });
    }
    return out;
  }
  /** Fixe nom et description d'une ligne ; deux champs vides effacent l'entrée. */
  setLineInfo(key, { name = '', description = '' } = {}) {
    const n = String(name || '').trim().slice(0, 80), d = String(description || '').trim().slice(0, 1000);
    if (n || d) this.lineInfo[key] = { name: n, description: d }; else delete this.lineInfo[key];
  }
  /** Lignes du réseau (triées par code, ordre naturel) : { key, code, mode (le plus fréquent), modes, name, autoName, custom, description,
   *  services, symcolor0-2, stopCount }. Le nom est celui saisi, sinon « terminus – terminus » du plus long service. */
  lines() {
    const groups = new Map();
    this.services.forEach(sv => {
      const k = Network.lineKey(sv);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(sv);
    });
    const lab = st => (st && st.stop ? (st.stop.city || st.stop.name) : '');
    const out = [...groups].map(([key, services]) => {
      const first = services[0];
      const longest = services.reduce((a, b) => (b.stopTimes.length > a.stopTimes.length ? b : a), first);
      const a = lab(longest.stopTimes[0]), b = lab(longest.stopTimes[longest.stopTimes.length - 1]);
      const autoName = a && b ? (a === b ? a : a + ' – ' + b) : (first.name || '');
      const info = this.lineInfo[key] || { name: '', description: '' };
      const col = services.find(x => x.symcolor0) || first;
      const count = {};
      services.forEach(x => { count[x.mode] = (count[x.mode] || 0) + 1; });
      const modes = Object.keys(count).sort((u, v) => count[v] - count[u]);
      const stopIds = new Set();
      services.forEach(x => x.stopTimes.forEach(st => stopIds.add(st.stop.id)));
      return { key, code: first.code || '', mode: modes[0], modes, name: info.name || autoName, autoName, custom: info.name,
        description: info.description, services, symcolor0: col.symcolor0, symcolor1: col.symcolor1, symcolor2: col.symcolor2,
        stopCount: stopIds.size };
    });
    const coll = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
    return out.sort((x, y) => coll.compare(x.code || x.name, y.code || y.name));
  }
  /** Rôle des arrêts d'un ensemble de services : 'end' (premier ou dernier arrêt d'un service : terminus possible) ou
   *  'mid' (arrêt intermédiaire uniquement). Les arrêts absents de la Map ne sont desservis par aucun de ces services. */
  static stopRoles(services) {
    const roles = new Map();
    services.forEach(sv => {
      const last = sv.stopTimes.length - 1;
      sv.stopTimes.forEach((st, i) => {
        if (i === 0 || i === last) roles.set(st.stop.id, 'end');
        else if (!roles.has(st.stop.id)) roles.set(st.stop.id, 'mid');
      });
    });
    return roles;
  }
  getLine(key) { return this.lines().find(l => l.key === key) || null; }

  /** Facteur d'émission du mode, en g CO₂e par passager et par km. */
  co2PerKm(mode) {
    const m = serviceMode(mode);
    return typeof this.emissions[m] === 'number' ? this.emissions[m] : CO2_DEFAULTS[m];
  }
  /** Fixe le facteur d'un mode ; une valeur égale à celle par défaut (ou null) rétablit la valeur par défaut. */
  setCo2(mode, g) {
    const m = serviceMode(mode);
    if (g === null || g === CO2_DEFAULTS[m]) delete this.emissions[m]; else this.emissions[m] = g;
  }
  static cleanEmissions(o) {
    const out = {};
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      Object.keys(CO2_DEFAULTS).forEach(m => {
        const v = o[m];
        if (typeof v === 'number' && isFinite(v) && v >= 0 && v <= 5000 && v !== CO2_DEFAULTS[m]) out[m] = v;
      });
    }
    return out;
  }
  /** 0,4 → « 0,4 g » · 340 → « 340 g » · 3400 → « 3,4 kg » · 25000 → « 25 kg » */
  static formatCo2(g) {
    if (typeof g !== 'number' || !isFinite(g)) return '—';
    const f = (n, d) => n.toFixed(d).replace('.', ',');
    if (g < 10) return f(g, 1) + ' g';
    if (g < 1000) return Math.round(g) + ' g';
    const kg = g / 1000;
    return (kg < 10 ? f(kg, 1) : Math.round(kg)) + ' kg';
  }
  addZone(z) { this.zones.push(z); return z; }
  getZone(id) { return this.zones.find(z => z.id === id) || null; }
  addTariff(t) { this.tariffs.push(t); return t; }
  getTariff(code) { return this.tariffs.find(t => t.code === code) || null; }
  addStop(s) { this.stops.push(s); return s; }
  getStop(id) { return this.stops.find(s => s.id === id) || null; }
  addProvider(p) { this.providers.push(p); return p; }
  addService(s) { this.services.push(s); return s; }
  removeService(id) { this.services = this.services.filter(s => s.id !== id); }
  getService(id) { return this.services.find(s => s.id === id) || null; }
  getProvider(id) { return this.providers.find(p => p.id === id) || null; }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      region: this.region,
      icon: this.icon,
      lineCodes: this.lineCodes.slice(),
      providers: this.providers.map(p => p.toJSON()),
      zones: this.zones.map(z => z.toJSON()),
      tariffs: this.tariffs.map(t => t.toJSON()),
      stops: this.stops.map(s => s.toJSON()),
      services: this.services.map(s => s.toJSON()),
      emissions: { ...this.emissions },
      lineInfo: JSON.parse(JSON.stringify(this.lineInfo)),
      calendar: JSON.parse(JSON.stringify(this.calendar))
    };
  }
  static fromJSON(o) {
    const net = new Network({
      ...o,
      providers: (o.providers || []).map(Provider.fromJSON),
      zones: (o.zones || []).map(Zone.fromJSON),
      tariffs: (o.tariffs || []).map(Tariff.fromJSON),
      stops: (o.stops || []).map(Stop.fromJSON),
      services: (o.services || []).map(Service.fromJSON)
    });
    net.relink();
    return net;
  }

  // Après rechargement, chaque service embarque des copies de ses arrêts et de son
  // fournisseur : on les remplace par les instances du réseau pour qu'elles soient
  // partagées (modifier un arrêt ou un fournisseur le modifie partout).
  relink() {
    const stops = new Map(this.stops.map(s => [s.id, s]));
    const provs = new Map(this.providers.map(p => [p.id, p]));
    this.services.forEach(sv => {
      sv.stopTimes.forEach(st => {
        const known = stops.get(st.stop.id);
        if (known) st.stop = known;
        else { stops.set(st.stop.id, st.stop); this.stops.push(st.stop); }
      });
      const p = sv.provider;
      if (p && typeof p === 'object') {
        const known = provs.get(p.id);
        if (known) sv.provider = known;
        else { provs.set(p.id, p); this.providers.push(p); }
      } else if (typeof p === 'string' && provs.has(p)) {
        sv.provider = provs.get(p);
      }
    });
  }
}

/** Transporteur qui exploite un ou plusieurs services. */
class Provider {
  constructor({ id, name, phone = null, website = null } = {}) {
    this.id = id;
    this.name = name;
    this.phone = phone;
    this.website = website;
  }
  toJSON() {
    return { id: this.id, name: this.name, phone: this.phone, website: this.website };
  }
  static fromJSON(o) { return new Provider(o); }
}

/** Zone : regroupe des arrêts (nom + identifiant, ex. « Z1 »). */
class Zone {
  constructor({ id, name } = {}) {
    this.id = id;
    this.name = name;
  }
  toJSON() { return { id: this.id, name: this.name }; }
  static fromJSON(o) { return new Zone(o); }
}

/** Tarification : une offre identifiée par un code, avec son public cible, son mécanisme
 *  de prix, une durée de validité optionnelle et l'option crossway (valable dans les 2 sens).
 *  Exemple : { code: '1BUTP', name: 'Billet unité', audience: 'Tout public',
 *              pricing: { type: 'zones', prices: [2, 3, 3, 4, 5] }, validityMinutes: 90 }
 *  Mécanismes (pricing) :
 *    { type: 'fixed', price: 2 }          tarif unique (price null = non défini)
 *    { type: 'zones', prices: [2,3,3,4,5] } forfait : prices[n-1] = prix pour n zones traversées
 *  Un service référence les tarifications qu'il propose par leur code. */
class Tariff {
  constructor({ code, name, audience = 'Tout public', pricing = null,
                validityMinutes = null, currency = 'EUR', crossway = false,
                kind = 'unit', trips = null, periodDays = null, lifeColors = null } = {}) {
    this.code = code;         // identifiant unique dans le réseau, ex. "1BUTP"
    this.name = name;         // ex. "Billet unité"
    this.audience = audience; // public cible, ex. "Tout public", "Moins de 26 ans"
    this.pricing = Tariff.cleanPricing(pricing);
    this.validityMinutes = Tariff.cleanValidity(validityMinutes); // null = pas de limite de durée
    this.currency = typeof currency === 'string' && currency ? currency : 'EUR';
    this.crossway = crossway === true; // billet valable dans les deux sens (aller et retour)
    // Nature du titre : 'unit' billet unité, 'multi' carte de N trajets, 'pass' abonnement
    let k = Tariff.KINDS.includes(kind) ? kind : 'unit';
    if ((k === 'multi' && Tariff.cleanTrips(trips) === null) || (k === 'pass' && Tariff.cleanPeriod(periodDays) === null)) k = 'unit';
    this.kind = k;
    this.trips = k === 'multi' ? Tariff.cleanTrips(trips) : null;            // trajets d'une carte
    this.periodDays = k === 'pass' ? Tariff.cleanPeriod(periodDays) : null;  // durée d'un abonnement
    this.lifeColors = Tariff.cleanLifeColors(lifeColors);  // couleur symbolique du ticket de contrôle selon son âge
  }

  static get KINDS() { return ['unit', 'multi', 'pass']; }
  /** Cycle de vie coloré : [{ minutes, color }] trié par minutes croissantes. La couleur d'un ticket de
   *  contrôle est celle du premier palier dont la durée n'est pas encore écoulée (le dernier palier
   *  s'applique ensuite). Couleurs : #rgb ou #rrggbb uniquement (valeurs reprises telles quelles en CSS). */
  static cleanLifeColors(v) {
    if (!Array.isArray(v)) return [];
    const out = [], seen = new Set();
    v.forEach(s => {
      if (!s || typeof s !== 'object') return;
      const min = s.minutes, col = typeof s.color === 'string' ? s.color.trim().toLowerCase() : '';
      if (!Number.isInteger(min) || min < 1 || min > 525600 || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(col) || seen.has(min)) return;
      seen.add(min); out.push({ minutes: min, color: col });
    });
    return out.sort((a, b) => a.minutes - b.minutes).slice(0, 8);
  }
  /** « 30 #2c1; 60 #2cc; 110 #c00 » -> { stages } ou { error }. Vide = aucun palier. */
  static parseLifeColors(text) {
    const parts = String(text || '').split(/[;\n]/).map(x => x.trim()).filter(Boolean);
    if (parts.length > 8) return { error: 'Huit paliers au maximum.' };
    const stages = [];
    for (const p of parts) {
      const mt = /^(\d+)\s*(?:mn|min)?\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/.exec(p);
      if (!mt) return { error: 'Palier illisible : « ' + p.slice(0, 30) + ' ». Format : 30 #2c1; 60 #2cc' };
      stages.push({ minutes: parseInt(mt[1], 10), color: mt[2] });
    }
    const clean = Tariff.cleanLifeColors(stages);
    if (clean.length !== stages.length) return { error: 'Minutes entre 1 et 525600, toutes différentes, couleurs en #rgb ou #rrggbb.' };
    return { stages: clean };
  }
  static formatLifeColors(stages) { return Tariff.cleanLifeColors(stages).map(s => s.minutes + ' ' + s.color).join('; '); }
  /** Couleur d'un ticket après `elapsedMin` minutes (null si aucun palier défini). */
  static colorAt(stages, elapsedMin) {
    if (!stages || !stages.length) return null;
    const s = stages.find(x => elapsedMin < x.minutes);
    return (s || stages[stages.length - 1]).color;
  }
  static cleanTrips(v) { return Number.isInteger(v) && v >= 2 && v <= 1000 ? v : null; }
  static cleanPeriod(v) { return Number.isInteger(v) && v >= 1 && v <= 366 ? v : null; }
  static kindLabel(kind) { return { unit: 'Billet unité', multi: 'Carte de trajets', pass: 'Abonnement' }[kind] || ''; }
  /** « 10 trajets », « 30 jours »… : ce que contient le titre (vide pour un billet unité). */
  get contentLabel() {
    if (this.kind === 'multi' && this.trips) return this.trips + ' trajets';
    if (this.kind === 'pass' && this.periodDays) return this.periodDays + (this.periodDays > 1 ? ' jours' : ' jour');
    return '';
  }

  static _money(n) { return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 100000; }
  static _round(n) { return Math.round(n * 100) / 100; }

  static isValidPricing(p) {
    if (!p || typeof p !== 'object') return false;
    if (p.type === 'fixed') return p.price === null || p.price === undefined || Tariff._money(p.price);
    if (p.type === 'zones') {
      return Array.isArray(p.prices) && p.prices.length >= 1 && p.prices.length <= 20 &&
        p.prices.every(Tariff._money);
    }
    return false;
  }
  /** Mécanisme normalisé ; à défaut de valeur valide : tarif unique sans prix. */
  static cleanPricing(p) {
    if (!Tariff.isValidPricing(p)) return { type: 'fixed', price: null };
    if (p.type === 'zones') return { type: 'zones', prices: p.prices.map(Tariff._round) };
    return { type: 'fixed', price: p.price == null ? null : Tariff._round(p.price) };
  }
  static cleanValidity(v) {
    return Number.isInteger(v) && v >= 1 && v <= 525600 ? v : null; // 1 minute … 1 an
  }

  /** Prix pour un nombre de zones traversées (au moins 1) ; null si non défini ou hors grille. */
  priceFor(zoneCount) {
    const p = this.pricing;
    if (p.type === 'fixed') return p.price;
    const n = Math.max(1, Math.floor(zoneCount) || 1);
    return n <= p.prices.length ? p.prices[n - 1] : null;
  }
  /** Nombre maximal de zones vendues (null pour un tarif unique). */
  get maxZones() { return this.pricing.type === 'zones' ? this.pricing.prices.length : null; }

  /** « 2,00 € » */
  static formatPrice(n, currency = 'EUR') {
    if (typeof n !== 'number') return '—';
    try { return n.toLocaleString('fr-FR', { style: 'currency', currency }); }
    catch (e) { return n.toFixed(2).replace('.', ',') + ' ' + currency; }
  }
  /** 90 -> « 1 h 30 », 1440 -> « 24 h », 10080 -> « 7 j », 45 -> « 45 min » */
  static formatDuration(min) {
    if (!Number.isInteger(min) || min <= 0) return '';
    if (min % 1440 === 0 && min >= 2880) return (min / 1440) + ' j';
    const h = Math.floor(min / 60), r = min % 60;
    if (!h) return r + ' min';
    return h + ' h' + (r ? ' ' + String(r).padStart(2, '0') : '');
  }
  /** Résumé du mécanisme de prix, pour les listes. */
  priceSummary() {
    const p = this.pricing, f = n => Tariff.formatPrice(n, this.currency);
    if (p.type === 'fixed') return p.price === null ? 'prix non défini' : f(p.price);
    const lo = Math.min(...p.prices), hi = Math.max(...p.prices);
    return 'forfait 1 à ' + p.prices.length + (p.prices.length > 1 ? ' zones · ' : ' zone · ') +
      (lo === hi ? f(lo) : f(lo) + ' à ' + f(hi));
  }

  toJSON() {
    return {
      code: this.code, name: this.name, audience: this.audience,
      pricing: this.pricing.type === 'zones'
        ? { type: 'zones', prices: this.pricing.prices.slice() }
        : { type: 'fixed', price: this.pricing.price },
      validityMinutes: this.validityMinutes,
      currency: this.currency,
      crossway: this.crossway,
      kind: this.kind, trips: this.trips, periodDays: this.periodDays,
      lifeColors: this.lifeColors.map(s => ({ ...s }))
    };
  }
  static fromJSON(o) { return new Tariff(o); }
}

/** Point d'arrêt physique (partagé entre plusieurs services). */
class Stop {
  constructor({ id, name, city = null, lat = null, lon = null, zoneId = null } = {}) {
    this.id = id;
    this.name = name;
    this.city = city;
    this.lat = lat;
    this.lon = lon;
    this.zoneId = zoneId;   // id d'une Zone du réseau, ou null
  }
  toJSON() {
    return { id: this.id, name: this.name, city: this.city, lat: this.lat, lon: this.lon, zoneId: this.zoneId };
  }
  static fromJSON(o) { return new Stop(o); }
}

/** Passage d'un service à un arrêt (ordre + horaires). */
class StopTime {
  constructor({ stop, order = 0, arrival = null, departure = null } = {}) {
    this.stop = stop;           // instance de Stop
    this.order = order;         // position dans la ligne (0 = départ)
    this.arrival = arrival;     // "HH:MM" ou null
    this.departure = departure; // "HH:MM" ou null
  }
  toJSON() {
    return {
      stop: this.stop.toJSON(),
      order: this.order,
      arrival: this.arrival,
      departure: this.departure
    };
  }
  static fromJSON(o) {
    return new StopTime({ ...o, stop: Stop.fromJSON(o.stop) });
  }
}

/**
 * Périodes de fonctionnement possibles d'un service.
 * Règle : un service ne circule PAS les jours fériés, sauf s'il porte 'x'.
 * 'x' est donc une exception explicite (ex. ['ta', 'x'] = toute l'année
 * + jours fériés ; ['ta'] = toute l'année, hors jours fériés).
 */
const OPERATING_PERIODS = Object.freeze({
  TA: 'ta',   // toute l'année
  PS: 'ps',   // période scolaire
  PVS: 'pvs', // petites vacances scolaires
  VS: 'vs',   // vacances scolaires
  X: 'x'      // jour férié
});

/** Types de véhicule d'un service ; le pictogramme est pictos/<value>.svg */
const SERVICE_MODES = [
  { value: 'bus', label: 'Bus' }, { value: 'car', label: 'Car' },
  { value: 'train', label: 'Train' }, { value: 'tramway', label: 'Tramway' }, { value: 'metro', label: 'Métro' },
  { value: 'voiture', label: 'Voiture' }, { value: 'velo', label: 'Vélo' },
  { value: 'velo-libre-service', label: 'Vélo en libre-service' }
];
/** Émissions par défaut, en g CO₂e par passager et par km (ordres de grandeur indicatifs : Base Empreinte ADEME,
 *  Carbone 4) ; chaque réseau peut les ajuster (Network.emissions, Feed › Facteurs CO₂). */
const CO2_DEFAULTS = Object.freeze({ bus: 100, car: 30, train: 28, tramway: 5, metro: 4, voiture: 110, velo: 0, 'velo-libre-service': 0 });
const co2Default = m => CO2_DEFAULTS[serviceMode(m)];

const serviceMode = m => (SERVICE_MODES.some(x => x.value === m) ? m : 'bus');

/** Couleur symbolique valide (#rgb ou #rrggbb) -> minuscules, sinon null : jamais de CSS libre */
const symColor = v => (typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim().toLowerCase() : null);

/** Une ligne : départ, arrivée, arrêts intermédiaires, exploitant. */
class Service {
  constructor({
    id, code, name, mode = 'bus',      // voir SERVICE_MODES
    provider = null,                   // instance de Provider (ou son id)
    stopTimes = [],
    operatingDays = [1, 2, 3, 4, 5],   // 0 = dimanche … 6 = samedi
    operatingPeriods = [],             // 'ta' | 'ps' | 'pvs' | 'vs' | 'x' (cumulables, ex. ['ta', 'x'])
    color = null,
    symcolor0 = null, symcolor1 = null, symcolor2 = null,   // couleurs symboliques : fond, texte et contour du badge de ligne
    tariffCodes = [],                  // codes des tarifications proposées (Network.tariffs)
    shape = null                       // tracé routier calculé : { sig, profile, m, s, pts:[[lat,lon]…] } (voir routing.js)
  } = {}) {
    this.id = id;
    this.code = code;                  // ex. "L12"
    this.name = name;                  // ex. "Aix – Marseille"
    this.mode = serviceMode(mode);
    this.provider = provider;
    this.stopTimes = stopTimes;
    this.operatingDays = operatingDays;
    const valid = Object.values(OPERATING_PERIODS);
    this.operatingPeriods = operatingPeriods.filter(p => valid.includes(p));
    this.color = color;
    this.symcolor0 = symColor(symcolor0);
    this.symcolor1 = symColor(symcolor1);
    this.symcolor2 = symColor(symcolor2);
    this.tariffCodes = Array.isArray(tariffCodes) ? tariffCodes : [];
    this.shape = Service.cleanShape(shape);
  }

  /** Tracé de données externes : forme stricte, sinon null */
  static cleanShape(o) {
    if (!o || typeof o !== 'object' || typeof o.sig !== 'string' || !Array.isArray(o.pts)) return null;
    if (o.pts.length < 2 || o.pts.length > 20000) return null;
    const ok = o.pts.every(p => Array.isArray(p) && p.length === 2 && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
    if (!ok) return null;
    const n = v => (Number.isFinite(v) && v >= 0 ? v : 0);
    return { sig: o.sig.slice(0, 2000), profile: String(o.profile || '').slice(0, 20), m: n(o.m), s: n(o.s),
      pts: o.pts.map(p => [+p[0], +p[1]]) };
  }

  /** Le tracé correspond-il encore aux arrêts et au mode du service ? */
  get shapeValid() {
    return !!this.shape && typeof Routing !== 'undefined' && this.shape.sig === Routing.sig(this);
  }

  /** Points [lat, lon] du tronçon entre les arrêts d'indices i et j (inclus) : tracé routier s'il est à jour
   *  (on repère le sommet du tracé le plus proche de chaque arrêt, en avançant le long du tracé), sinon lignes droites. */
  sectionPath(i, j) {
    const sts = this.stopTimes;
    const straight = () => sts.slice(i, j + 1).map(t => t.stop).filter(s => s.lat !== null && s.lon !== null).map(s => [s.lat, s.lon]);
    if (!this.shapeValid) return straight();
    const pts = this.shape.pts;
    const idx = [];
    let from = 0;
    for (const t of sts) {
      const s = t.stop;
      if (s.lat === null || s.lon === null) { idx.push(null); continue; }
      const cos = Math.cos(s.lat * Math.PI / 180);
      let best = from, bd = Infinity;
      for (let k = from; k < pts.length; k++) {
        const d = (pts[k][0] - s.lat) ** 2 + ((pts[k][1] - s.lon) * cos) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      idx.push(best);
      from = best;
    }
    const a = idx[i], b = idx[j];
    if (a === null || b === null || b <= a) return straight();
    return pts.slice(a, b + 1);
  }

  /** Points [lat, lon] à dessiner : tracé routier s'il est à jour, sinon arrêts reliés en ligne droite */
  path() {
    if (this.shapeValid) return this.shape.pts;
    return this.stopTimes.map(t => t.stop).filter(s => s.lat !== null && s.lon !== null).map(s => [s.lat, s.lon]);
  }

  /** Le service circule-t-il pendant cette période ('ps', 'pvs', 'vs' ou 'x') ? */
  operatesDuring(period) { return this.operatingPeriods.includes(period); }

  /** Le service circule-t-il ce jour-là ? date : Date ou « AAAA-MM-JJ » ; net : réseau (calendrier). Sans calendrier
   *  renseigné, seuls les jours de la semaine sont vérifiés (les périodes ne peuvent pas être évaluées). */
  runsOn(date, net) {
    const iso = typeof date === 'string' ? date : Network.iso(date);
    const dow = new Date(iso + 'T12:00:00').getDay();
    if (!this.operatingDays.includes(dow)) return false;
    if (!net || !net.hasCalendar) return true;
    const p = net.periodsOn(iso);
    if (p.holiday) return this.operatesDuring('x');
    if (!this.operatingPeriods.length) return true;
    return this.operatingPeriods.some(per => per === 'ta' || (per === 'ps' && p.school) || (per === 'pvs' && p.pvs) || (per === 'vs' && p.vs));
  }

  get departure() { return this.stopTimes[0] || null; }
  get arrival() { return this.stopTimes[this.stopTimes.length - 1] || null; }
  get intermediateStops() { return this.stopTimes.slice(1, -1); }

  addStop(stop, { arrival = null, departure = null } = {}) {
    const st = new StopTime({ stop, order: this.stopTimes.length, arrival, departure });
    this.stopTimes.push(st);
    return st;
  }

  toJSON() {
    const p = this.provider;
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      mode: this.mode,
      provider: p && typeof p === 'object' ? p.toJSON() : p,
      stopTimes: this.stopTimes.map(s => s.toJSON()),
      operatingDays: this.operatingDays,
      operatingPeriods: this.operatingPeriods,
      color: this.color,
      symcolor0: this.symcolor0, symcolor1: this.symcolor1, symcolor2: this.symcolor2,
      tariffCodes: this.tariffCodes.slice(),
      shape: this.shape
    };
  }
  static fromJSON(o) {
    return new Service({
      ...o,
      provider: o.provider && typeof o.provider === 'object'
        ? Provider.fromJSON(o.provider) : o.provider,
      stopTimes: (o.stopTimes || []).map(StopTime.fromJSON)
    });
  }
}

/** Offre tarifaire vendue (unité, carnet, abonnement…). */
class Fare {
  constructor({ id, name, type = 'single', price = 0, currency = 'EUR',
                validityMinutes = null, maxTrips = 1 } = {}) {
    this.id = id;
    this.name = name;                  // ex. "Billet unité"
    this.type = type;                  // 'single' | 'pack' | 'pass'
    this.price = price;
    this.currency = currency;
    this.validityMinutes = validityMinutes; // durée après validation
    this.maxTrips = maxTrips;          // null = illimité
  }
  toJSON() {
    return {
      id: this.id, name: this.name, type: this.type, price: this.price,
      currency: this.currency, validityMinutes: this.validityMinutes,
      maxTrips: this.maxTrips
    };
  }
  static fromJSON(o) { return new Fare(o); }
}

/** Titre de transport détenu par l'utilisateur. */
class Ticket {
  constructor({
    id, serviceId = null, fare = null,
    departure = null, arrival = null,   // ids d'arrêts (null = valable sur tout le réseau)
    networkId = null,                   // réseau d'origine du titre
    departureTime = null, arrivalTime = null, // horaires « HH:MM » du service choisi
    purchasedAt = new Date().toISOString(),
    validatedAt = null, expiresAt = null,
    tripsLeft = null, status = 'valid', // 'valid' | 'used' | 'expired'
    code = null,                        // contenu du QR code / numéro
    bothWays = true,                    // valable dans les 2 sens
    tariff = null,                      // copie { code, name, audience } de la tarification choisie
    price = null, currency = 'EUR',     // prix calculé à l'ajout (null = non défini)
    zoneCount = null,                   // nombre de zones traversées au moment de l'ajout
    validityMinutes = null,             // durée d'un ticket de contrôle (copie de la tarification)
    kind = 'unit', trips = null,        // nature du titre : 'unit' | 'multi' | 'pass' ; trajets d'une carte
    periodDays = null, activatedAt = null, // abonnement : durée en jours, date de première validation
    lifeColors = null                   // paliers de couleur du ticket de contrôle (copie de la tarification)
  } = {}) {
    this.id = id;
    this.serviceId = serviceId;
    this.fare = fare;                   // instance de Fare
    this.departure = departure;
    this.arrival = arrival;
    this.networkId = networkId;
    this.departureTime = departureTime;
    this.arrivalTime = arrivalTime;
    this.purchasedAt = purchasedAt;
    this.validatedAt = validatedAt;
    this.expiresAt = expiresAt;
    this.tripsLeft = tripsLeft !== null ? tripsLeft : (fare ? fare.maxTrips : null);
    this.status = status;
    this.code = code;
    this.bothWays = bothWays;
    this.tariff = tariff && typeof tariff === 'object'
      ? { code: tariff.code, name: tariff.name, audience: tariff.audience } : null;
    this.price = typeof price === 'number' && isFinite(price) ? price : null;
    this.currency = currency || 'EUR';
    this.zoneCount = Number.isInteger(zoneCount) ? zoneCount : null;
    this.validityMinutes = Tariff.cleanValidity(validityMinutes);
    this.kind = Tariff.KINDS.includes(kind) ? kind : 'unit';
    this.trips = this.kind === 'multi' ? Tariff.cleanTrips(trips) : null;
    this.periodDays = this.kind === 'pass' ? Tariff.cleanPeriod(periodDays) : null;
    this.activatedAt = activatedAt;
    this.lifeColors = Tariff.cleanLifeColors(lifeColors);
    // Billet unité : un trajet ; carte : N trajets ; abonnement : pas de compteur
    if (tripsLeft === null && !fare) {
      this.tripsLeft = this.kind === 'pass' ? null : (this.kind === 'multi' ? this.trips : 1);
    }
  }

  isExpired(now = new Date()) {
    return !!this.expiresAt && new Date(this.expiresAt) < now;
  }

  /** Période de validité du ticket de contrôle qu'une validation faite à `now` générerait
   *  (sans rien modifier : sert aussi à l'écran de confirmation). Jamais au-delà de la fin d'un abonnement. */
  controlWindow(now = new Date()) {
    let end = now.getTime() + (this.validityMinutes || CONTROL_DEFAULT_MINUTES) * 60000;
    if (this.kind === 'pass') {
      const passEnd = this.activatedAt && this.expiresAt
        ? new Date(this.expiresAt).getTime() : now.getTime() + (this.periodDays || 30) * 86400000;
      end = Math.min(end, passEnd);
    }
    return { start: now.toISOString(), end: new Date(end).toISOString() };
  }

  /** Valide le titre avant de voyager et renvoie le ticket de contrôle généré (ou null si le titre
   *  n'est plus utilisable). Le titre est affecté : billet unité consommé, carte décomptée d'un
   *  trajet, abonnement activé à la première validation puis valable jusqu'à son terme. */
  validate(now = new Date(), controlId = null) {
    if (this.status !== 'valid' || this.isExpired(now)) return null;
    if (this.kind === 'pass') {
      if (!this.activatedAt) {
        this.activatedAt = now.toISOString();
        this.expiresAt = new Date(now.getTime() + (this.periodDays || 30) * 86400000).toISOString();
      }
    } else if (this.tripsLeft !== null && --this.tripsLeft <= 0) {
      this.status = 'used';
    }
    this.validatedAt = now.toISOString();
    const win = this.controlWindow(now);
    return new ControlTicket({
      id: controlId, ticketId: this.id, createdAt: win.start, expiresAt: win.end,
      title: this.tariff ? this.tariff.name : 'Billet unité',
      audience: this.tariff ? this.tariff.audience : 'Tout public',
      tariffCode: this.tariff ? this.tariff.code : null,
      serviceId: this.serviceId, networkId: this.networkId,
      departure: this.departure, arrival: this.arrival, bothWays: this.bothWays,
      lifeColors: this.lifeColors,
      kind: this.kind, departureTime: this.departureTime, arrivalTime: this.arrivalTime
    });
  }

  toJSON() {
    return {
      id: this.id,
      serviceId: this.serviceId,
      fare: this.fare ? this.fare.toJSON() : null,
      departure: this.departure,
      arrival: this.arrival,
      networkId: this.networkId,
      departureTime: this.departureTime,
      arrivalTime: this.arrivalTime,
      purchasedAt: this.purchasedAt,
      validatedAt: this.validatedAt,
      expiresAt: this.expiresAt,
      tripsLeft: this.tripsLeft,
      status: this.status,
      code: this.code,
      bothWays: this.bothWays,
      tariff: this.tariff ? { ...this.tariff } : null,
      price: this.price,
      currency: this.currency,
      zoneCount: this.zoneCount,
      validityMinutes: this.validityMinutes,
      kind: this.kind, trips: this.trips, periodDays: this.periodDays, activatedAt: this.activatedAt,
      lifeColors: this.lifeColors.map(s => ({ ...s }))
    };
  }
  static fromJSON(o) {
    return new Ticket({ ...o, fare: o.fare ? Fare.fromJSON(o.fare) : null });
  }
}

/** Durée par défaut d'un ticket de contrôle quand la tarification n'en fixe pas. */
const CONTROL_DEFAULT_MINUTES = 90;

/** Ticket de contrôle : preuve de validation générée à partir d'un titre (voir Ticket.validate).
 *  Il porte une copie des informations du titre : il reste lisible même si le titre est supprimé. */
class ControlTicket {
  constructor({
    id, ticketId = null, createdAt = new Date().toISOString(), expiresAt = null,
    title = 'Billet unité', audience = 'Tout public', tariffCode = null,
    serviceId = null, networkId = null, departure = null, arrival = null, bothWays = true,
    lineLabel = null, fromLabel = null, toLabel = null,   // libellés figés à la validation
    lifeColors = [],                                      // paliers de couleur figés à la validation
    code = null,
    kind = 'unit', departureTime = null, arrivalTime = null   // type du titre et horaires, figés pour l'historique
  } = {}) {
    this.id = id;
    this.ticketId = ticketId;       // titre d'origine
    this.createdAt = createdAt;     // début de validité
    this.expiresAt = expiresAt;     // fin de validité
    this.title = title;
    this.audience = audience;
    this.tariffCode = tariffCode;
    this.serviceId = serviceId;
    this.networkId = networkId;
    this.departure = departure;
    this.arrival = arrival;
    this.bothWays = bothWays !== false;
    this.lineLabel = lineLabel;
    this.fromLabel = fromLabel;
    this.toLabel = toLabel;
    this.lifeColors = Tariff.cleanLifeColors(lifeColors);
    this.code = code;               // numéro de contrôle
    this.kind = ['unit', 'multi', 'pass'].includes(kind) ? kind : 'unit';
    this.departureTime = typeof departureTime === 'string' ? departureTime : null;
    this.arrivalTime = typeof arrivalTime === 'string' ? arrivalTime : null;
  }

  /** Couleur symbolique à cet instant (null sans paliers : couleur par défaut de l'interface). */
  colorAt(now = new Date()) {
    return Tariff.colorAt(this.lifeColors, (now.getTime() - new Date(this.createdAt).getTime()) / 60000);
  }

  isExpired(now = new Date()) { return !!this.expiresAt && new Date(this.expiresAt) <= now; }
  /** Part du temps écoulé, entre 0 et 1. */
  progress(now = new Date()) {
    const a = new Date(this.createdAt).getTime(), b = new Date(this.expiresAt).getTime();
    return b > a ? Math.min(1, Math.max(0, (now.getTime() - a) / (b - a))) : 1;
  }

  toJSON() {
    return {
      id: this.id, ticketId: this.ticketId, createdAt: this.createdAt, expiresAt: this.expiresAt,
      title: this.title, audience: this.audience, tariffCode: this.tariffCode,
      serviceId: this.serviceId, networkId: this.networkId,
      departure: this.departure, arrival: this.arrival, bothWays: this.bothWays,
      lineLabel: this.lineLabel, fromLabel: this.fromLabel, toLabel: this.toLabel,
      lifeColors: this.lifeColors.map(s => ({ ...s })), code: this.code,
      kind: this.kind, departureTime: this.departureTime, arrivalTime: this.arrivalTime
    };
  }
  static fromJSON(o) { return new ControlTicket(o); }
}

/** Portefeuille : collection de titres, sauvegardable via les clés locales. */
class Wallet {
  constructor({ owner = null, tickets = [], controls = [], history = [] } = {}) {
    this.owner = owner;
    this.tickets = tickets;     // titres disponibles
    this.controls = controls;   // tickets de contrôle générés à la validation
    this.history = Wallet.cleanHistory(history);   // trajets effectués : un par ticket de contrôle détruit à son expiration (plus récents en dernier)
  }

  /** Une entrée d'historique est une copie à plat d'un ticket de contrôle au moment de sa destruction ; nettoyée à la lecture. */
  static cleanHistory(list) {
    const str = (v, n = 80) => (typeof v === 'string' && v ? v.slice(0, n) : null);
    const hm = v => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
    const iso = v => (typeof v === 'string' && !isNaN(Date.parse(v)) ? v : null);
    return (Array.isArray(list) ? list : []).map(h => (h && typeof h === 'object' ? {
      id: str(h.id, 60), ticketId: str(h.ticketId, 60), date: iso(h.date),
      mode: serviceMode(h.mode), line: str(h.line, 20),
      c0: symColor(h.c0), c1: symColor(h.c1), c2: symColor(h.c2),
      from: str(h.from), fromTime: hm(h.fromTime), to: str(h.to), toTime: hm(h.toTime),
      tariff: str(h.tariff), kind: ['unit', 'multi', 'pass'].includes(h.kind) ? h.kind : 'unit'
    } : null)).filter(h => h && h.id && h.date).slice(-500);
  }
  addHistory(entry) {
    if (this.history.some(h => h.id === entry.id)) return;
    this.history = Wallet.cleanHistory([...this.history, entry]);
  }
  addControl(c) { this.controls.push(c); return c; }
  /** Tickets de contrôle encore valables, les plus récents d'abord. */
  activeControls(now = new Date()) {
    return this.controls.filter(c => !c.isExpired(now)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** Détruit les tickets de contrôle expirés et les renvoie (l'appelant les inscrit à l'historique). */
  takeExpiredControls(now = new Date()) {
    const gone = this.controls.filter(c => c.isExpired(now));
    if (gone.length) this.controls = this.controls.filter(c => !c.isExpired(now));
    return gone;
  }
  add(ticket) { this.tickets.push(ticket); return ticket; }
  remove(id) { this.tickets = this.tickets.filter(t => t.id !== id); }
  get(id) { return this.tickets.find(t => t.id === id) || null; }
  get active() { return this.tickets.filter(t => t.status === 'valid' && !t.isExpired()); }

  toJSON() {
    return { owner: this.owner, tickets: this.tickets.map(t => t.toJSON()), controls: this.controls.map(c => c.toJSON()), history: this.history.map(h => ({ ...h })) };
  }
  static fromJSON(o) {
    return new Wallet({
      owner: o.owner,
      tickets: (o.tickets || []).map(Ticket.fromJSON),
      controls: (o.controls || []).map(ControlTicket.fromJSON),
      history: o.history
    });
  }

  /** Utilise les méthodes de Bang : bang.saveToLocal / bang.loadFromLocal. */
  save(bang, key = 'wallet') { bang.saveToLocal(key, this.toJSON()); }
  static load(bang, key = 'wallet') {
    const data = bang.loadFromLocal(key);
    return data ? Wallet.fromJSON(data) : new Wallet();
  }
}

window.symColor = symColor;
window.SERVICE_MODES = SERVICE_MODES;
window.serviceMode = serviceMode;
window.Network = Network;
window.Provider = Provider;
window.Zone = Zone;
window.Tariff = Tariff;
window.ControlTicket = ControlTicket;
window.CONTROL_DEFAULT_MINUTES = CONTROL_DEFAULT_MINUTES;
window.Stop = Stop;
window.StopTime = StopTime;
window.OPERATING_PERIODS = OPERATING_PERIODS;
window.Service = Service;
window.Fare = Fare;
window.Ticket = Ticket;
window.Wallet = Wallet;

/* Exemple d'utilisation :

const net = new Network({ id: 'zou', name: 'Réseau régional', region: 'Provence-Alpes-Côte d\'Azur' });
const prov = net.addProvider(new Provider({ id: 'p1', name: 'Cars Exemple' }));

const l12 = net.addService(new Service({ id: 's12', code: 'L12', name: 'Aix – Marseille', provider: prov,
  operatingDays: [1, 2, 3, 4, 5], operatingPeriods: ['ta', 'x'] }));
// l12.operatesDuring(OPERATING_PERIODS.X) -> true
l12.addStop(new Stop({ id: 'aix', name: 'Gare routière', city: 'Aix' }), { departure: '07:00' });
l12.addStop(new Stop({ id: 'plan', name: 'Plan de Campagne', city: 'Cabriès' }), { arrival: '07:20', departure: '07:22' });
l12.addStop(new Stop({ id: 'mrs', name: 'Saint-Charles', city: 'Marseille' }), { arrival: '07:50' });

const wallet = new Wallet();
wallet.add(new Ticket({ id: 't1', serviceId: 's12', fare: new Fare({ id: 'f1', name: 'Billet unité', price: 2, validityMinutes: 90 }) }));
wallet.save(bang);              // -> localStorage via saveToLocal
const w2 = Wallet.load(bang);   // reconstruit les instances
*/
