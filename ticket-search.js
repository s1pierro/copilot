// ticket-search.js — libellés des jours et périodes de circulation (extrait de ctx-accueil.js)

const acNorm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const acLabel = s => (s.city ? s.city + ' – ' + s.name : s.name);

// --- Recherche de billets : services directs, sans correspondance -----------------------

const acPlural = (n, one, many) => n + ' ' + (n > 1 ? many : one);
const acUp = s => s.charAt(0).toUpperCase() + s.slice(1);
const acMinutes = t => { const m = /^(\d{2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };

const TicketSearch = {
  // Un résultat par service qui dessert `fromId` puis `toId` (dans cet ordre).
  // Si le service repasse plusieurs fois aux mêmes arrêts, on garde la section la plus courte.
  find(net, fromId, toId) {
    if (!net || !fromId || !toId || fromId === toId) return [];
    const out = [];
    net.services.forEach(sv => {
      const sts = sv.stopTimes;
      let best = null;
      sts.forEach((st, j) => {
        if (st.stop.id !== toId) return;
        for (let i = j - 1; i >= 0; i--) {
          if (sts[i].stop.id === fromId) {
            if (!best || j - i < best.j - best.i) best = { i, j };
            break;
          }
        }
      });
      if (!best) return;

      const { i, j } = best;
      const dep = sts[i].departure || sts[i].arrival || null;
      const arr = sts[j].arrival || sts[j].departure || null;
      const zoneIds = [];
      sts.slice(i, j + 1).forEach(st => {
        if (st.stop.zoneId && !zoneIds.includes(st.stop.zoneId)) zoneIds.push(st.stop.zoneId);
      });
      const a = acMinutes(dep), b = acMinutes(arr);
      out.push({
        service: sv,
        departure: dep,
        arrival: arr,
        minutes: a === null || b === null ? null : (b - a + 1440) % 1440,   // franchit minuit si besoin
        between: j - i - 1,                       // arrêts intermédiaires
        fromIndex: i, toIndex: j, total: sts.length,
        full: i === 0 && j === sts.length - 1,    // ligne complète ou section
        zones: zoneIds.map(id => net.getZone(id)).filter(Boolean),   // zones traversées, dans l'ordre
        ticket: { serviceId: sv.id, departure: fromId, arrival: toId }   // de quoi créer un Ticket
      });
    });
    // Par heure de départ, les services sans horaire en dernier
    out.sort((x, y) => {
      const a = acMinutes(x.departure), b = acMinutes(y.departure);
      return ((a === null) - (b === null)) || (a - b) || String(x.service.code).localeCompare(String(y.service.code), 'fr');
    });
    return out;
  },

  // Prix unitaire du trajet : offre « billet unité » au tarif « Tout public » (à défaut la moins chère du service)
  // pour les zones traversées. { price, currency, from } (from : repli sur la moins chère, donc « dès ») ou null.
  unitPrice(net, r) {
    const zones = Math.max(1, (r.zones || []).length);
    const all = (r.service.tariffCodes || []).map(c => net.getTariff(c)).filter(t => t && t.kind === 'unit')
      .map(t => ({ price: t.priceFor(zones), currency: t.currency, pub: /^tout public$/i.test(t.audience || '') })).filter(x => x.price !== null);
    if (!all.length) return null;
    const pub = all.filter(x => x.pub);
    const pool = (pub.length ? pub : all).sort((a, b) => a.price - b.price);
    return { price: pool[0].price, currency: pool[0].currency, from: !pub.length && all.some(x => x.price !== pool[0].price) };
  },

  // Bilan carbone du trajet : distance du tronçon (par la route si le tracé est calculé, sinon à vol d'oiseau)
  // × facteur du mode ; comparaison avec la voiture. null si les arrêts n'ont pas de position.
  co2(net, r) {
    const pts = r.service.sectionPath(r.fromIndex, r.toIndex);
    if (pts.length < 2 || !window.Routing) return null;
    const km = Routing.length(pts) / 1000, factor = net.co2PerKm(r.service.mode);
    return { km, factor, grams: km * factor, carGrams: km * net.co2PerKm('voiture'), road: r.service.shapeValid };
  },

  durationLabel(min) {
    if (min < 60) return min + ' min';
    return Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + String(min % 60).padStart(2, '0') : '');
  },

  // [1,2,3,4,5] → « lun–ven » ; [6,0] → « sam, dim » ; 7 jours → « tous les jours »
  daysLabel(days) {
    const week = [1, 2, 3, 4, 5, 6, 0];
    const names = { 1: 'lun', 2: 'mar', 3: 'mer', 4: 'jeu', 5: 'ven', 6: 'sam', 0: 'dim' };
    const on = week.filter(d => (days || []).includes(d));
    if (!on.length) return '';
    if (on.length === 7) return 'tous les jours';
    const runs = [];
    on.forEach(d => {
      const last = runs[runs.length - 1];
      if (last && week.indexOf(d) === week.indexOf(last[last.length - 1]) + 1) last.push(d);
      else runs.push([d]);
    });
    return runs.map(r => r.length >= 3 ? names[r[0]] + '–' + names[r[r.length - 1]] : r.map(d => names[d]).join(', ')).join(', ');
  },

  periodsLabel(periods) {
    const names = { ta: 'toute l’année', ps: 'période scolaire', pvs: 'petites vacances', vs: 'vacances', x: 'jours fériés' };
    return (periods || []).map(p => names[p]).filter(Boolean).join(', ');
  }
};

window.TicketSearch = TicketSearch;
