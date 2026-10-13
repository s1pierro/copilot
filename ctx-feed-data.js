// ctx-feed-data.js — import / export JSON des données locales (réseaux).
// Deux pages superposées ouvertes depuis la section « Données » du Feed :
//   feed-export : génère le JSON (réseau actif ou tous les réseaux) → fichier, presse-papiers, partage
//   feed-import : lit un fichier ou du texte JSON, le nettoie, l'affiche, puis l'applique
//
// Format du fichier :
//   { app: 'bang', kind: 'networks', v: 1, exportedAt, active, networks: [ <Network.toJSON()> ] }
// L'import accepte aussi un tableau de réseaux, un réseau seul, ou le format brut de la clé « networks ».

const DATA_FORMAT = Object.freeze({ app: 'bang', kind: 'networks', v: 1 });
const DATA_BACKUP_KEY = 'networks:before-import';

// --- Petits utilitaires ------------------------------------------------------

const dtObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const dtArr = v => (Array.isArray(v) ? v : []);
const dtStr = v => (typeof v === 'string' ? v.trim()
  : (typeof v === 'number' && isFinite(v) ? String(v) : ''));
const dtNum = v => (typeof v === 'number' && isFinite(v) ? v : null);
const dtHHMM = v => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);

const dtSlug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'reseau';

function dtSize(bytes) {
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1).replace('.', ',') + ' Ko';
  return (bytes / 1048576).toFixed(1).replace('.', ',') + ' Mo';
}

function dtLocalDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function dtEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// --- Logique (sans DOM) ------------------------------------------------------

const DataIO = {
  // ---- Export ----

  // scope : 'active' (réseau actif) ou 'all' (tous les réseaux)
  buildExport(store, scope) {
    const nets = scope === 'all' ? store.networks : [store.active].filter(Boolean);
    return {
      app: DATA_FORMAT.app,
      kind: DATA_FORMAT.kind,
      v: DATA_FORMAT.v,
      exportedAt: new Date().toISOString(),
      active: store.active ? store.active.id : null,
      networks: nets.map(n => n.toJSON())
    };
  },

  stringify(env) { return JSON.stringify(env, null, 2); },

  fileName(env) {
    const base = env.networks.length === 1 ? dtSlug(env.networks[0].name) : 'reseaux';
    return 'bang-' + base + '-' + dtLocalDate() + '.json';
  },

  // Arrêts distincts d'un réseau (liste du réseau + arrêts desservis par ses services)
  stopCount(n) {
    const ids = new Set(n.stops.map(s => s.id));
    n.services.forEach(sv => sv.stopTimes.forEach(st => ids.add(st.stop.id)));
    return ids.size;
  },

  summary(nets) {
    const s = { networks: nets.length, providers: 0, services: 0, stops: 0, zones: 0, tariffs: 0 };
    nets.forEach(n => {
      s.providers += n.providers.length;
      s.services += n.services.length;
      s.stops += DataIO.stopCount(n);
      s.zones += n.zones.length;
      s.tariffs += n.tariffs.length;
    });
    return s;
  },

  // ---- Import : lecture et nettoyage ----

  // Renvoie { networks: Network[], active: id|null, warnings: string[] } ou lève une Error en français.
  parse(text) {
    const W = [];
    const src = String(text == null ? '' : text).replace(/^﻿/, '').trim();
    if (!src) throw new Error('Aucun contenu à analyser.');

    let data;
    try { data = JSON.parse(src); }
    catch (e) { throw new Error('Ce contenu n’est pas du JSON valide (' + e.message + ').'); }

    let list = null;
    let active = null;
    if (Array.isArray(data)) {
      list = data;
    } else if (dtObj(data)) {
      if (data.kind !== undefined && data.kind !== DATA_FORMAT.kind) {
        throw new Error('Ce fichier contient des données de type « ' + data.kind + ' », pas des réseaux.');
      }
      if (typeof data.v === 'number' && data.v > DATA_FORMAT.v) {
        throw new Error('Format version ' + data.v + ' non pris en charge (cette application gère la version '
          + DATA_FORMAT.v + ').');
      }
      if (data.app !== undefined && data.app !== DATA_FORMAT.app) {
        W.push('Fichier produit par une autre application (« ' + data.app + ' »).');
      }
      if (Array.isArray(data.networks)) {
        list = data.networks;
        if (typeof data.active === 'string') active = data.active;
      } else if (['services', 'stops', 'providers', 'zones'].some(k => Array.isArray(data[k]))) {
        list = [data];   // un réseau seul
      }
    }
    if (!list) throw new Error('Format non reconnu : ce contenu ne décrit aucun réseau.');
    if (!list.length) throw new Error('Le contenu ne comprend aucun réseau.');

    const networks = list.map((raw, i) => DataIO._clean(raw, i, W));

    // Identifiants de réseau en double dans le fichier
    const seen = new Set();
    networks.forEach(n => {
      if (seen.has(n.id)) {
        const old = n.id;
        n.id = uid('n');
        W.push('Identifiant de réseau « ' + old + ' » en double : un nouvel identifiant a été attribué à « ' + n.name + ' ».');
      }
      seen.add(n.id);
    });
    if (active && !networks.some(n => n.id === active)) active = null;
    return { networks, active, warnings: W };
  },

  // Nettoie un réseau brut (données non fiables) et renvoie une instance de Network
  _clean(raw, i, W) {
    if (!dtObj(raw)) throw new Error('Réseau n° ' + (i + 1) + ' : format invalide.');
    const c = { zones: 0, providers: 0, stops: 0, zoneRefs: 0, coords: 0, times: 0, services: 0, provRefs: 0, codes: 0, tariffs: 0, tariffRefs: 0, pricings: 0, validities: 0, kinds: 0, lifeDrops: 0 };
    const name = dtStr(raw.name) || 'Réseau importé';

    let id = dtStr(raw.id);
    if (!id) {
      id = uid('n');
      W.push('« ' + name + ' » : identifiant manquant, un nouvel identifiant a été attribué.');
    }

    // Tarifications (code unique sans tenir compte de la casse, sans espace ni séparateur)
    const tariffs = new Map();
    const tariffKeys = new Set();
    dtArr(raw.tariffs).forEach(tf => {
      const tcode = dtObj(tf) ? dtStr(tf.code) : '';
      if (!tcode || /[\s,;]/.test(tcode) || tariffKeys.has(tcode.toLowerCase())) { c.tariffs++; return; }
      tariffKeys.add(tcode.toLowerCase());
      if (Array.isArray(tf.lifeColors) && Tariff.cleanLifeColors(tf.lifeColors).length !== Math.min(tf.lifeColors.length, 8)) c.lifeDrops++;
      // Mécanisme de prix et durée : valeurs invalides remplacées par « non défini »
      if (tf.pricing != null && !Tariff.isValidPricing(tf.pricing)) c.pricings++;
      if (tf.validityMinutes != null && Tariff.cleanValidity(tf.validityMinutes) === null) c.validities++;
      // Carte sans nombre de trajets valide ou abonnement sans durée valide : retombent en billet unité
      let tkind = Tariff.KINDS.includes(tf.kind) ? tf.kind : 'unit';
      if ((tkind === 'multi' && Tariff.cleanTrips(tf.trips) === null) ||
          (tkind === 'pass' && Tariff.cleanPeriod(tf.periodDays) === null)) { tkind = 'unit'; c.kinds++; }
      tariffs.set(tcode, {
        code: tcode, name: dtStr(tf.name) || tcode, audience: dtStr(tf.audience) || 'Tout public',
        pricing: Tariff.cleanPricing(tf.pricing),
        validityMinutes: Tariff.cleanValidity(tf.validityMinutes),
        currency: /^[A-Z]{3}$/.test(tf.currency) ? tf.currency : 'EUR',
        crossway: tf.crossway === true,
        kind: tkind,
        trips: tkind === 'multi' ? Tariff.cleanTrips(tf.trips) : null,
        periodDays: tkind === 'pass' ? Tariff.cleanPeriod(tf.periodDays) : null,
        lifeColors: Tariff.cleanLifeColors(tf.lifeColors)
      });
    });

    // Zones (identifiant unique sans tenir compte de la casse)
    const zones = new Map();
    const zoneKeys = new Set();
    dtArr(raw.zones).forEach(z => {
      const zid = dtObj(z) ? dtStr(z.id) : '';
      if (!zid || zoneKeys.has(zid.toLowerCase())) { c.zones++; return; }
      zoneKeys.add(zid.toLowerCase());
      zones.set(zid, { id: zid, name: dtStr(z.name) || zid });
    });

    // Fournisseurs
    const providers = new Map();
    const addProvider = p => {
      const pid = dtObj(p) ? dtStr(p.id) : '';
      if (!pid) return null;
      if (!providers.has(pid)) {
        providers.set(pid, {
          id: pid, name: dtStr(p.name) || pid,
          phone: dtStr(p.phone) || null, website: dtStr(p.website) || null
        });
      }
      return pid;
    };
    dtArr(raw.providers).forEach(p => { if (!addProvider(p)) c.providers++; });

    // Arrêts
    const stops = new Map();
    const addStop = s => {
      const sid = dtObj(s) ? dtStr(s.id) : '';
      if (!sid) return null;
      if (stops.has(sid)) return sid;
      let lat = dtNum(s.lat);
      let lon = dtNum(s.lon);
      if ((lat === null) !== (lon === null) || (lat !== null && (Math.abs(lat) > 90 || Math.abs(lon) > 180))) {
        lat = lon = null;
        c.coords++;
      }
      let zoneId = dtStr(s.zoneId) || null;
      if (zoneId && !zones.has(zoneId)) { zoneId = null; c.zoneRefs++; }
      stops.set(sid, { id: sid, name: dtStr(s.name) || sid, city: dtStr(s.city) || null, lat, lon, zoneId });
      return sid;
    };
    dtArr(raw.stops).forEach(s => { if (!addStop(s)) c.stops++; });

    // Services
    const services = [];
    const serviceIds = new Set();
    dtArr(raw.services).forEach(sv => {
      if (!dtObj(sv)) { c.services++; return; }

      const times = [];
      dtArr(sv.stopTimes).forEach(st => {
        let sid = null;
        if (dtObj(st)) {
          if (dtObj(st.stop)) sid = addStop(st.stop);
          else if (typeof st.stop === 'string' && stops.has(st.stop)) sid = st.stop;
        }
        if (!sid) { c.times++; return; }
        times.push({
          stop: stops.get(sid), order: times.length,
          arrival: dtHHMM(st.arrival), departure: dtHHMM(st.departure)
        });
      });
      if (times.length < 2) { c.services++; return; }

      let provider = null;
      if (dtObj(sv.provider)) {
        const pid = addProvider(sv.provider);
        provider = pid ? providers.get(pid) : null;
      } else if (typeof sv.provider === 'string' && sv.provider) {
        provider = providers.get(sv.provider) || null;
        if (!provider) c.provRefs++;
      }

      let sid = dtStr(sv.id);
      if (!sid || serviceIds.has(sid)) sid = uid('s');
      serviceIds.add(sid);

      const days = Array.isArray(sv.operatingDays)
        ? [...new Set(sv.operatingDays.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))]
        : [1, 2, 3, 4, 5];
      const code = dtStr(sv.code);
      services.push({
        id: sid, code, name: dtStr(sv.name) || code || sid,
        mode: serviceMode(sv.mode),
        provider, stopTimes: times,
        operatingDays: days,
        operatingPeriods: dtArr(sv.operatingPeriods).filter(p => typeof p === 'string'),
        color: dtStr(sv.color) || null,
        shape: Service.cleanShape(sv.shape),
        symcolor0: symColor(sv.symcolor0), symcolor1: symColor(sv.symcolor1), symcolor2: symColor(sv.symcolor2),
        tariffCodes: [...new Set(dtArr(sv.tariffCodes).map(dtStr).filter(x => {
          if (!x) return false;
          if (!tariffs.has(x)) { c.tariffRefs++; return false; }
          return true;
        }))]
      });
    });

    // Icône : data URL png/jpeg/webp de taille raisonnable, sinon ignorée
    const icon = NetIcon.clean(raw.icon);
    if (raw.icon != null && raw.icon !== '' && !icon) c.icon = 1;

    // Codes ligne : texte court, sans doublon (casse ignorée)
    const lineCodes = [], seenCodes = new Set();
    dtArr(raw.lineCodes).forEach(x => {
      const s = typeof x === 'string' ? x.trim() : '';
      if (!s || s.length > 12 || seenCodes.has(s.toLowerCase()) || lineCodes.length >= 200) { c.codes++; return; }
      seenCodes.add(s.toLowerCase());
      lineCodes.push(s);
    });

    const bits = [];
    if (c.codes) bits.push(fdPlural(c.codes, 'code ligne invalide ou en double ignoré', 'codes ligne invalides ou en double ignorés'));
    if (c.icon) bits.push('icône invalide ou trop volumineuse ignorée');
    if (c.tariffs) bits.push(fdPlural(c.tariffs, 'tarification invalide ignorée', 'tarifications invalides ignorées'));
    if (c.pricings) bits.push(fdPlural(c.pricings, 'tarification au prix invalide (prix non défini)', 'tarifications aux prix invalides (prix non définis)'));
    if (c.lifeDrops) bits.push(fdPlural(c.lifeDrops, 'tarification avec des paliers de couleur invalides (ignorés)', 'tarifications avec des paliers de couleur invalides (ignorés)'));
    if (c.kinds) bits.push(fdPlural(c.kinds, 'carte ou abonnement incomplet converti en billet unité', 'cartes ou abonnements incomplets convertis en billets unité'));
    if (c.validities) bits.push(fdPlural(c.validities, 'durée de validité invalide ignorée', 'durées de validité invalides ignorées'));
    if (c.tariffRefs) bits.push(fdPlural(c.tariffRefs, 'offre tarifaire inconnue retirée d’un service', 'offres tarifaires inconnues retirées de services'));
    if (c.zones) bits.push(fdPlural(c.zones, 'zone invalide ignorée', 'zones invalides ignorées'));
    if (c.providers) bits.push(fdPlural(c.providers, 'fournisseur invalide ignoré', 'fournisseurs invalides ignorés'));
    if (c.stops) bits.push(fdPlural(c.stops, 'arrêt invalide ignoré', 'arrêts invalides ignorés'));
    if (c.zoneRefs) bits.push(fdPlural(c.zoneRefs, 'arrêt lié à une zone inconnue (zone retirée)', 'arrêts liés à une zone inconnue (zone retirée)'));
    if (c.coords) bits.push(fdPlural(c.coords, 'arrêt aux coordonnées invalides (coordonnées effacées)', 'arrêts aux coordonnées invalides (coordonnées effacées)'));
    if (c.times) bits.push(fdPlural(c.times, 'passage invalide ignoré', 'passages invalides ignorés'));
    if (c.services) bits.push(fdPlural(c.services, 'service ignoré (invalide ou moins de 2 arrêts)', 'services ignorés (invalides ou moins de 2 arrêts)'));
    if (c.provRefs) bits.push(fdPlural(c.provRefs, 'service lié à un fournisseur inconnu (fournisseur retiré)', 'services liés à un fournisseur inconnu (fournisseur retiré)'));
    if (bits.length) W.push('« ' + name + ' » : ' + bits.join(' ; ') + '.');

    try {
      return Network.fromJSON({
        id, name, region: dtStr(raw.region), icon, lineCodes, emissions: Network.cleanEmissions(raw.emissions), lineInfo: Network.cleanLineInfo(raw.lineInfo), calendar: Network.cleanCalendar(raw.calendar),
        zones: [...zones.values()],
        tariffs: [...tariffs.values()],
        providers: [...providers.values()],
        stops: [...stops.values()],
        services
      });
    } catch (e) {
      throw new Error('Réseau « ' + name + ' » illisible : ' + e.message);
    }
  },

  // ---- Import : application ----

  // mode : 'add' (ajouter, copie si identifiant déjà présent), 'merge' (remplacer à identifiant égal),
  //        'all' (tout remplacer). Ne sauvegarde pas : voir store.save().
  apply(store, parsed, mode) {
    const incoming = parsed.networks;
    const r = { mode, added: 0, replaced: 0, copies: 0 };
    if (mode === 'all') {
      store.networks = incoming.slice();
      store.activeId = parsed.active || incoming[0].id;
      r.added = incoming.length;
      return r;
    }
    incoming.forEach(n => {
      const i = store.networks.findIndex(x => x.id === n.id);
      if (i < 0) { store.networks.push(n); r.added++; return; }
      if (mode === 'merge') { store.networks[i] = n; r.replaced++; return; }
      n.id = uid('n');
      n.name = n.name + ' (importé)';
      store.networks.push(n);
      r.added++;
      r.copies++;
    });
    return r;
  },

  describe(r) {
    const nets = k => fdPlural(k, 'réseau', 'réseaux');
    if (r.mode === 'all') {
      return 'Données remplacées : ' + nets(r.added) + (r.added > 1 ? ' importés' : ' importé') + '.';
    }
    const parts = [];
    if (r.added) parts.push(nets(r.added) + (r.added > 1 ? ' ajoutés' : ' ajouté'));
    if (r.replaced) parts.push(nets(r.replaced) + (r.replaced > 1 ? ' remplacés' : ' remplacé'));
    let s = parts.join(', ') + '.';
    if (r.copies) s += ' ' + fdPlural(r.copies, 'importé en copie', 'importés en copie') + ' (identifiant déjà présent).';
    return s;
  },

  // ---- Sauvegarde d'avant import (un seul niveau d'annulation) ----

  backup(bang, store) {
    bang.saveToLocal(DATA_BACKUP_KEY, {
      v: 1, at: new Date().toISOString(), active: store.activeId,
      networks: store.networks.map(n => n.toJSON())
    });
  },

  // Date de la sauvegarde, ou null s'il n'y en a pas
  backupInfo(bang) {
    try { if (localStorage.getItem(DATA_BACKUP_KEY) === null) return null; } catch (e) { return null; }
    const s = bang.loadFromLocal(DATA_BACKUP_KEY);
    return s && Array.isArray(s.networks) && s.networks.length ? { at: s.at } : null;
  },

  restore(bang, store) {
    const s = bang.loadFromLocal(DATA_BACKUP_KEY);
    if (!s || !Array.isArray(s.networks) || !s.networks.length) return false;
    const nets = s.networks.map(Network.fromJSON);
    store.networks = nets;
    store.activeId = nets.some(n => n.id === s.active) ? s.active : nets[0].id;
    store.save();
    bang.removeFromLocal(DATA_BACKUP_KEY);
    return true;
  }
};

// --- Interface ----------------------------------------------------------------

function dtInjectStyle() {
  if (document.getElementById('dt-style')) return;
  const st = document.createElement('style');
  st.id = 'dt-style';
  st.textContent = `
    .dt-body{padding-top:.9em}
    .dt-go .uf-submit{display:block;width:100%}
    .dt-msg{margin:0 1em 1em;padding:.8em 1em;border-radius:12px;font-size:.9em}
    .dt-msg:empty{display:none}
    .dt-msg.ok{background:#e3f1e6;color:#1b5e20}
    .dt-msg.err{background:#fdecea;color:#b3261e}
    .dt-warn{margin:0 1em 1em;padding:.8em 1em;border-radius:12px;background:#fff7e0;
      color:#6b4e00;font-size:.85em}
    .dt-warn b{display:block;margin-bottom:.3em}
    .dt-warn ul{margin:0;padding-left:1.2em}
    .dt-note{color:var(--inactive-color);font-size:.85em}
    .dt-ta{width:100%;box-sizing:border-box;border:1px solid var(--border-color);
      border-radius:10px;padding:.75em .9em;font:12px/1.4 monospace;background:#fff;
      color:var(--text-color);resize:vertical;min-height:7em}
    .uf .dt-file{display:flex;align-items:center;justify-content:center;gap:.5em;
      padding:.85em 1em;border-radius:12px;border:2px dashed var(--accent-color);
      color:var(--accent-color);cursor:pointer;-webkit-tap-highlight-color:transparent}
    .dt-file input{display:none}
    .dt-file svg{width:1.25em;height:1.25em}
    .fd-actions .fd-btn.dt-alt,.fd-actions .fd-btn.dt-alt:hover{background:#fff;
      color:var(--accent-color);box-shadow:inset 0 0 0 2px var(--accent-color)}
    .uf .uf-submit.dt-danger,.uf .uf-submit.dt-danger:hover{background:#b3261e}
    .dt-restore{margin:0 1em 1.4em}
    .dt-restore .dt-link,.dt-restore .dt-link:hover{background:none;color:var(--accent-color);
      padding:.4em 0;text-align:left;font-size:.9em;text-decoration:underline}
  `;
  document.head.appendChild(st);
}

// Page de base : barre ←/×, en-tête à vague, titre, zone de message
class FeedDataPage extends Context {
  _frame(el, title, sub, icon) {
    fdInjectStyle();
    dtInjectStyle();
    ufInjectStyle();
    const t = dtEl('div', 'fd-title');
    t.append(dtEl('h2', '', title), dtEl('small', '', sub));
    this.msg = dtEl('div', 'dt-msg');
    this.msg.setAttribute('role', 'status');
    this.body = dtEl('div', 'dt-body');
    el.append(fdMkBar(this.bang, { back: true }), mkWaveHeader(uiSvg(icon)), t, this.body);
  }

  say(text, kind) {
    if (!this.msg) return;
    this.msg.textContent = text || '';
    this.msg.className = 'dt-msg' + (kind ? ' ' + kind : '');
  }

  // Bouton à deux temps : le premier appui change le libellé, le second exécute
  _confirm(btn, label, armedLabel, action) {
    let armed = false;
    let timer = null;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        btn.textContent = armedLabel;
        timer = setTimeout(() => { armed = false; btn.textContent = label; }, 5000);
        return;
      }
      clearTimeout(timer);
      action();
    });
  }
}

// --- Page Exporter --------------------------------------------------------------

class ExportPage extends FeedDataPage {
  build(el) {
    this._frame(el, 'Exporter', 'Données au format JSON', fdIcons.export);
    this.scope = 'active';
    this.refresh();
  }

  onShow() { if (this.built) this.refresh(); }

  refresh() {
    const store = this.bang.store;
    const multi = store.networks.length > 1;
    if (!multi) this.scope = 'active';
    const env = DataIO.buildExport(store, this.scope);
    const text = DataIO.stringify(env);
    const name = DataIO.fileName(env);
    this.current = { text, name };

    const nets = this.scope === 'all' ? store.networks : [store.active].filter(Boolean);
    const parts = [];
    if (multi) parts.push(this._mkScope(store));
    parts.push(this._mkSummary(DataIO.summary(nets), name, text), this._mkActions(), this.msg, this._mkPreview(text));
    this.body.replaceChildren(...parts);
  }

  _mkScope(store) {
    const card = dtEl('div', 'fd-card');
    const box = dtEl('div', 'uf');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Données à exporter');
    [['active', 'Réseau actif : ' + store.active.name],
     ['all', 'Tous les réseaux (' + store.networks.length + ')']].forEach(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    });
    sel.value = this.scope;
    sel.addEventListener('change', () => { this.scope = sel.value; this.say(''); this.refresh(); });
    box.append(dtEl('div', 'uf-label', 'Données à exporter'), sel);
    card.appendChild(box);
    return card;
  }

  _mkSummary(s, name, text) {
    const card = dtEl('div', 'fd-card');
    [['Réseaux', s.networks], ['Fournisseurs', s.providers], ['Services', s.services],
     ['Arrêts', s.stops], ['Zones', s.zones], ['Tarifications', s.tariffs]].forEach(([label, v]) => {
      const row = dtEl('div', 'fd-row');
      row.append(dtEl('span', '', label), dtEl('small', '', String(v)));
      card.appendChild(row);
    });
    // Le nom de fichier est long : il a sa propre ligne
    const file = dtEl('div', 'fd-row');
    const col = dtEl('div', 'fd-col');
    col.append(dtEl('span', '', 'Fichier'),
      dtEl('small', '', name + ' · ' + dtSize(new TextEncoder().encode(text).length)));
    file.appendChild(col);
    card.appendChild(file);
    return card;
  }

  _mkActions() {
    const box = dtEl('div', 'fd-actions');
    const add = (label, icon, cls, fn) => {
      const b = dtEl('button', 'fd-btn' + (cls ? ' ' + cls : ''));
      b.type = 'button';
      b.innerHTML = uiSvg(icon);
      b.append(label);
      b.addEventListener('click', fn);
      box.appendChild(b);
    };
    add('Télécharger le fichier', fdIcons.export, '', () => this._download());
    add('Copier le JSON', '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>', 'dt-alt', () => this._copy());
    if (this._canShare()) {
      add('Partager', '<circle cx="6" cy="12" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 11l8-4M8 13l8 4"/>', 'dt-alt', () => this._share());
    }
    return box;
  }

  _mkPreview(text) {
    const card = dtEl('div', 'fd-card');
    const box = dtEl('div', 'uf');
    box.appendChild(dtEl('div', 'uf-label', 'Aperçu'));
    if (text.length > 60000) {
      box.appendChild(dtEl('div', 'dt-note', 'Aperçu masqué : le JSON est volumineux. Utilise le téléchargement ou la copie.'));
    } else {
      const ta = dtEl('textarea', 'dt-ta');
      ta.readOnly = true;
      ta.wrap = 'off';
      ta.rows = 10;
      ta.value = text;
      ta.setAttribute('aria-label', 'Aperçu du JSON');
      box.appendChild(ta);
    }
    card.appendChild(box);
    return card;
  }

  _download() {
    const { text, name } = this.current;
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.say('Fichier « ' + name + ' » généré : cherche-le dans tes téléchargements.', 'ok');
    } catch (e) {
      this.say('Téléchargement impossible (' + e.message + '). Utilise « Copier le JSON ».', 'err');
    }
  }

  async _copy() {
    const { text } = this.current;
    try {
      await navigator.clipboard.writeText(text);
      this.say('JSON copié dans le presse-papiers.', 'ok');
      return;
    } catch (e) { /* repli ci-dessous */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('commande refusée');
      this.say('JSON copié dans le presse-papiers.', 'ok');
    } catch (e) {
      this.say('Copie impossible : sélectionne le texte de l’aperçu à la main.', 'err');
    }
  }

  _canShare() {
    try {
      return !!(navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'a.json', { type: 'application/json' })] }));
    } catch (e) { return false; }
  }

  async _share() {
    const { text, name } = this.current;
    try {
      const file = new File([text], name, { type: 'application/json' });
      await navigator.share({ files: [file], title: name });
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // l'utilisateur a fermé la feuille de partage
      this.say('Partage impossible (' + (e && e.message) + ').', 'err');
    }
  }
}

// --- Page Importer ---------------------------------------------------------------

class ImportPage extends FeedDataPage {
  build(el) {
    this._frame(el, 'Importer', 'Depuis un fichier ou du texte JSON', fdIcons.import);
    this.parsed = null;
    this.mode = 'add';
    this.fileText = null;
    this.resultSlot = dtEl('div');
    this.restoreSlot = dtEl('div');
    this.body.append(this._mkSource(), this.msg, this.resultSlot, this.restoreSlot);
    this._renderRestore();
  }

  // Au retour sur la page, les identifiants déjà présents ont pu changer
  onShow() { if (this.built) { this._renderResult(); this._renderRestore(); } }

  _mkSource() {
    const card = dtEl('div', 'fd-card');
    const box = dtEl('div', 'uf');

    const pick = dtEl('label', 'dt-file');
    pick.innerHTML = uiSvg(fdIcons.import);
    pick.append('Choisir un fichier JSON');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json,text/plain';
    input.addEventListener('change', () => this._onFile(input));
    pick.appendChild(input);

    this.fileLabel = dtEl('div', 'dt-note');
    this.ta = dtEl('textarea', 'dt-ta');
    this.ta.placeholder = '{ "networks": [ … ] }';
    this.ta.spellcheck = false;
    this.ta.autocapitalize = 'none';
    this.ta.setAttribute('autocomplete', 'off');
    this.ta.setAttribute('aria-label', 'JSON à importer');
    this.ta.addEventListener('input', () => {
      this.fileText = null;
      this.fileLabel.textContent = '';
      this.say('');
      this._setParsed(null);
    });

    const go = dtEl('button', 'uf-submit', 'Analyser');
    go.type = 'button';
    go.addEventListener('click', () => this._analyzeInput());

    box.append(pick, this.fileLabel, dtEl('div', 'uf-label', 'ou colle le JSON ici'), this.ta, go);
    card.appendChild(box);
    return card;
  }

  _readFile(f) {
    if (f.text) return f.text();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsText(f);
    });
  }

  _onFile(input) {
    const f = input.files && input.files[0];
    if (!f) return;
    this.ta.value = '';
    this.say('');
    this._setParsed(null);
    this.fileLabel.textContent = f.name + ' · ' + dtSize(f.size);
    if (f.size > 15 * 1048576) {
      this.fileText = null;
      this.say('Fichier trop volumineux (maximum 15 Mo).', 'err');
      input.value = '';
      return;
    }
    this._readFile(f)
      .then(text => { this.fileText = text; this._analyze(text); })
      .catch(() => this.say('Lecture du fichier impossible.', 'err'));
    input.value = '';   // permet de re-choisir le même fichier
  }

  _analyzeInput() {
    const typed = this.ta.value.trim();
    const text = typed ? this.ta.value : this.fileText;
    if (!text || !text.trim()) { this.say('Choisis un fichier ou colle du JSON.', 'err'); return; }
    this._analyze(text);
  }

  _analyze(text) {
    this.say('');
    try {
      this._setParsed(DataIO.parse(text));
    } catch (e) {
      this._setParsed(null);
      this.say(e.message, 'err');
    }
  }

  _setParsed(p) {
    this.parsed = p;
    this._renderResult();
  }

  _renderResult() {
    const slot = this.resultSlot;
    slot.replaceChildren();
    const p = this.parsed;
    if (!p) return;
    const store = this.bang.store;

    // Contenu du fichier
    slot.appendChild(dtEl('div', 'fd-h', 'Contenu du fichier'));
    const card = dtEl('div', 'fd-card');
    p.networks.forEach(n => {
      const s = DataIO.summary([n]);
      const row = dtEl('div', 'fd-row');
      const col = dtEl('div', 'fd-col');
      col.appendChild(dtEl('span', '', n.name));
      const exists = store.networks.some(x => x.id === n.id);
      col.appendChild(dtEl('small', '', [
        n.region,
        fdPlural(s.services, 'service'),
        fdPlural(s.stops, 'arrêt'),
        fdPlural(s.providers, 'fournisseur'),
        fdPlural(s.zones, 'zone'),
        fdPlural(s.tariffs, 'tarification'),
        exists ? 'identifiant déjà présent' : ''
      ].filter(Boolean).join(' · ')));
      row.appendChild(col);
      card.appendChild(row);
    });
    slot.appendChild(card);

    // Avertissements du nettoyage
    if (p.warnings.length) {
      const w = dtEl('div', 'dt-warn');
      w.appendChild(dtEl('b', '', 'À savoir'));
      const ul = document.createElement('ul');
      p.warnings.slice(0, 6).forEach(m => ul.appendChild(dtEl('li', '', m)));
      if (p.warnings.length > 6) ul.appendChild(dtEl('li', '', '… et ' + (p.warnings.length - 6) + ' autre(s).'));
      w.appendChild(ul);
      slot.appendChild(w);
    }

    // Mode d'import
    const mcard = dtEl('div', 'fd-card');
    const box = dtEl('div', 'uf');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Mode d’import');
    [['add', 'Ajouter aux réseaux existants'],
     ['merge', 'Remplacer les réseaux de même identifiant'],
     ['all', 'Tout remplacer']].forEach(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    });
    sel.value = this.mode;
    const hint = dtEl('div', 'dt-note');
    const goSlot = dtEl('div', 'dt-go');
    const hints = {
      add: 'Les réseaux du fichier sont ajoutés. Si un identifiant existe déjà, le réseau est importé en copie (« … (importé) »).',
      merge: 'Un réseau du fichier remplace celui qui a le même identifiant ; les autres sont ajoutés.',
      all: 'Tous les réseaux actuels sont effacés puis remplacés par ceux du fichier.'
    };
    const drawButton = () => {
      this.mode = sel.value;
      hint.textContent = hints[this.mode] + ' Une sauvegarde est conservée pour annuler.';
      const b = dtEl('button', 'uf-submit' + (this.mode === 'all' ? ' dt-danger' : ''));
      b.type = 'button';
      if (this.mode === 'all') {
        this._confirm(b, 'Tout remplacer…', 'Confirmer : effacer et remplacer', () => this._doImport());
      } else {
        b.textContent = this.mode === 'merge' ? 'Importer et remplacer' : 'Importer';
        b.addEventListener('click', () => this._doImport());
      }
      goSlot.replaceChildren(b);
    };
    sel.addEventListener('change', drawButton);
    box.append(dtEl('div', 'uf-label', 'Mode d’import'), sel, hint, goSlot);
    mcard.appendChild(box);
    slot.appendChild(mcard);
    drawButton();
  }

  _doImport() {
    const p = this.parsed;
    if (!p) return;
    const bang = this.bang;
    const store = bang.store;
    DataIO.backup(bang, store);
    const r = DataIO.apply(store, p, this.mode);
    store.save();
    this.ta.value = '';
    this.fileText = null;
    this.fileLabel.textContent = '';
    this._setParsed(null);
    this._renderRestore();
    this.say(DataIO.describe(r) + ' Une sauvegarde permet d’annuler.', 'ok');
  }

  _renderRestore() {
    const slot = this.restoreSlot;
    slot.replaceChildren();
    const info = DataIO.backupInfo(this.bang);
    if (!info) return;
    const when = info.at ? new Date(info.at).toLocaleString('fr-FR',
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const wrap = dtEl('div', 'dt-restore');
    const b = dtEl('button', 'dt-link');
    b.type = 'button';
    this._confirm(b,
      'Annuler le dernier import' + (when ? ' (sauvegarde du ' + when + ')' : ''),
      'Confirmer : les modifications faites depuis seront perdues',
      () => {
        const ok = DataIO.restore(this.bang, this.bang.store);
        this._renderRestore();
        this.say(ok ? 'Données d’avant import restaurées.' : 'Aucune sauvegarde à restaurer.', ok ? 'ok' : 'err');
      });
    wrap.appendChild(b);
    slot.appendChild(wrap);
  }
}

function registerFeedDataPages(manager, bang) {
  manager.register(new ExportPage(bang, 'feed-export'), { overlay: true });
  manager.register(new ImportPage(bang, 'feed-import'), { overlay: true });
}

window.DataIO = DataIO;
window.registerFeedDataPages = registerFeedDataPages;
