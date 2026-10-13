// ctx-feed-pages.js — pages dédiées ouvertes depuis les tuiles du Feed.
// Chaque page : en-tête à vague, liste des éléments (avec crayon d'édition),
// bouton + formulaire d'ajout. Le même formulaire sert à créer et à modifier.
// Une seule classe (FeedPage) configurée par un descripteur par page.

const fpStopLabel = s => (s.city ? s.city + ' – ' + s.name : s.name);
// « 219, 220 ; L12 » -> ['219', '220', 'L12'] (sans doublon, casse ignorée)
function fpParseCodes(text) {
  const seen = new Set(), out = [];
  String(text || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean).forEach(c => {
    c = c.slice(0, 12);
    if (!seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.push(c); }
  });
  return out.slice(0, 200);
}

const fpProviderId = s => (s.provider && typeof s.provider === 'object' ? s.provider.id : s.provider) || '';

class FeedPage extends Context {
  constructor(bang, id, cfg) {
    super(bang, id);
    this.cfg = cfg;
  }

  build(el) {
    fdInjectStyle();
    const title = document.createElement('div');
    title.className = 'fd-title';
    const h = document.createElement('h2');
    h.textContent = this.cfg.title;
    this.sub = document.createElement('small');
    title.append(h, this.sub);

    // Bouton qui déplie / replie le formulaire d'ajout
    const actions = document.createElement('div');
    actions.className = 'fd-actions';
    this.toggle = document.createElement('button');
    this.toggle.className = 'fd-btn';
    this.toggle.innerHTML = uiSvg('<path d="M12 5v14M5 12h14"/>');
    this.toggleLabel = document.createElement('span');
    this.toggle.appendChild(this.toggleLabel);
    this.toggle.addEventListener('click', () => {
      if (this.slot.hidden) this._openForm(null); else this._closeForm();
    });
    actions.appendChild(this.toggle);
    if (this.cfg.noAdd) actions.hidden = true;     // page de réglages : on modifie, on n'ajoute pas

    this.slot = document.createElement('div');
    this.slot.hidden = true;
    this.list = document.createElement('div');

    el.append(fdMkBar(this.bang, { back: true }),
              mkWaveHeader(uiSvg(this.cfg.icon)),
              title, actions, this.slot, this.list);
    this.refresh();
  }

  // Retour sur la page : données et options du formulaire peuvent avoir changé
  onShow() { if (this.built) this.refresh(); }

  refresh() {
    this.sub.textContent = this.cfg.sub();
    this._closeForm();
    this._renderList();
  }

  _killForm() {
    if (this._form && this._form.ufDestroy) this._form.ufDestroy();
    this._form = null;
  }

  _closeForm() {
    this._killForm();
    this.slot.hidden = true;
    this.slot.replaceChildren();
    this.toggleLabel.textContent = this.cfg.addLabel;
  }

  // item = null : création ; sinon modification de l'élément.
  // duplicate = true : création préremplie avec les valeurs de `item` (rien n'est
  // enregistré tant qu'on ne valide pas).
  // Le formulaire est reconstruit à chaque ouverture (options et valeurs à jour).
  _openForm(item, itemTitle, duplicate = false) {
    const editing = !!item && !duplicate;
    const fields = this.cfg.fields(item);
    if (duplicate) {
      const nm = fields.find(f => f.name === 'name');
      if (nm) nm.value = (nm.value || '') + ' (copie)';
    }
    const card = document.createElement('div');
    card.className = 'fd-card';
    this._killForm();
    card.appendChild(this._form = mkForm(fields, {
      title: duplicate ? 'Dupliquer · ' + itemTitle
           : editing ? 'Modifier · ' + itemTitle : this.cfg.addLabel,
      submitLabel: editing ? 'Enregistrer' : 'Ajouter',
      onSubmit: values => {
        const err = this.cfg.submit(values, editing ? item : null);
        if (err) return err;
        this.bang.store.save();
        this.refresh();
        return null;
      }
    }));
    this.slot.replaceChildren(card);
    this.slot.hidden = false;
    this.toggleLabel.textContent = 'Annuler';
    this.slot.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // Lien « supprimer » à double appui : le 1er demande confirmation (3 s), le 2e supprime
  _mkRemoveLink(r) {
    const b = document.createElement('button');
    b.className = 'fd-link fd-del';
    b.type = 'button';
    const ic = document.createElement('span');
    ic.className = 'fd-ic';
    ic.style.setProperty('--pic', 'url("icons/delete-svgrepo-com.svg")');
    ic.setAttribute('aria-hidden', 'true');
    const lab = document.createElement('span');
    lab.textContent = this.cfg.removeLabel;
    b.append(ic, lab);
    let armed = false, timer = null;
    b.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        lab.textContent = 'Confirmer ?';
        b.classList.add('armed');
        timer = setTimeout(() => { armed = false; lab.textContent = this.cfg.removeLabel; b.classList.remove('armed'); }, 3000);
        return;
      }
      clearTimeout(timer);
      r.remove();
      this.bang.store.save();
      this.refresh();
    });
    return b;
  }

  // Lien « Calculer le tracé » : itinéraire réel le long des routes (routing.js), mémorisé dans le service
  _mkTraceLink(sv) {
    if (!window.Routing || !Routing.profileFor(sv.mode)) return null;
    const note = document.createElement('div');
    note.className = 'fd-svc-trace';
    const setNote = () => {
      note.textContent = sv.shapeValid ? 'Tracé routier : ' + Routing.label(sv.shape)
        : sv.shape ? 'Tracé à recalculer (arrêts ou mode modifiés)' : 'Pas de tracé routier (lignes droites sur la carte)';
      note.classList.remove('err');
    };
    setNote();
    const btn = document.createElement('button');
    btn.className = 'fd-link';
    btn.type = 'button';
    const ic = document.createElement('span');
    ic.className = 'fd-ic';
    ic.style.setProperty('--pic', 'url("icons/map-ways-mono.svg")');
    ic.setAttribute('aria-hidden', 'true');
    const lab = document.createElement('span');
    lab.textContent = sv.shapeValid ? 'Recalculer le tracé' : 'Calculer le tracé';
    btn.append(ic, lab);
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      note.classList.remove('err');
      note.textContent = 'Calcul du tracé en cours…';
      try {
        sv.shape = Service.cleanShape(await Routing.compute(sv));
        this.bang.store.save();
        this.refresh();
      } catch (e) {
        note.textContent = e.message || 'Calcul impossible.';
        note.classList.add('err');
        btn.disabled = false;
      }
    });
    return { btn, note };
  }

  // Carte de service : tête (pictogramme + badge de ligne | nom, jours et périodes), puis liens d'action
  _mkServiceCard(r) {
    const sv = r.service;
    const e = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
    const card = e('div', 'fd-svc');
    if (sv.symcolor0) card.style.setProperty('--c', sv.symcolor0);       // valeurs déjà validées (symColor)
    if (sv.symcolor1) card.style.setProperty('--ct', sv.symcolor1);
    if (sv.symcolor2) { card.style.setProperty('--cb', sv.symcolor2); card.style.setProperty('--cbw', '2px'); }

    const head = e('div', 'fd-svc-head');
    const left = e('div', 'fd-svc-left');
    const medal = e('span', 'fd-svc-medal');
    medal.appendChild(uiPicto(sv.mode, 'fd-svc-pic'));
    left.append(medal, e('span', 'fd-svc-code', sv.code || '•'));

    const TS = window.TicketSearch;
    const when = TS ? [TS.daysLabel(sv.operatingDays), TS.periodsLabel(sv.operatingPeriods)].filter(Boolean).join(' · ') : '';
    const txt = e('div', 'fd-svc-txt');
    txt.append(e('span', 'fd-svc-name', sv.name || ''), e('span', 'fd-svc-when', when || '—'));

    const edit = e('button', 'fd-edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', 'Modifier ' + r.title);
    edit.innerHTML = uiSvg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>');
    edit.addEventListener('click', () => this._openForm(r.item, r.title));
    head.append(left, txt, edit);

    const links = e('div', 'fd-links fd-svc-links');
    const dup = e('button', 'fd-link');
    dup.type = 'button';
    const dic = e('span', 'fd-ic');
    dic.style.setProperty('--pic', 'url("icons/copy-svgrepo-com.svg")');
    dic.setAttribute('aria-hidden', 'true');
    dup.append(dic, e('span', null, this.cfg.duplicateLabel));
    dup.addEventListener('click', () => this._openForm(r.item, r.title, true));
    links.append(dup);
    const trace = this._mkTraceLink(sv);
    if (trace) links.append(trace.btn);
    links.append(this._mkRemoveLink(r));
    card.append(head);
    if (trace) card.append(trace.note);
    card.append(links);
    return card;
  }

  _renderList() {
    const card = document.createElement('div');
    card.className = 'fd-card';
    const rows = this.cfg.rows();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'fd-row';
      empty.textContent = 'Aucun élément';
      card.appendChild(empty);
    }
    if (rows.length && rows.every(r => r.service)) {
      const wrap = document.createElement('div');
      rows.forEach(r => wrap.appendChild(this._mkServiceCard(r)));
      this.list.replaceChildren(wrap);
      return;
    }
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'fd-row';

      // Zone principale (texte + coche) : action de la ligne s'il y en a une
      const main = document.createElement('div');
      main.className = 'fd-main';
      if (r.icon) main.appendChild(NetIcon.mkImg(r.icon, 'fd-ico'));
      const col = document.createElement('div');
      col.className = 'fd-col';
      const t = document.createElement('span');
      t.textContent = r.title;
      col.appendChild(t);
      if (r.sub) {
        const s = document.createElement('small');
        s.textContent = r.sub;
        col.appendChild(s);
      }
      // Liens « dupliquer » et « supprimer » sous le texte (pages qui les prévoient)
      if (r.duplicate || r.remove) {
        const links = document.createElement('div');
        links.className = 'fd-links';
        if (r.duplicate) {
          const d = document.createElement('button');
          d.className = 'fd-link';
          d.textContent = this.cfg.duplicateLabel;
          d.addEventListener('click', () => this._openForm(r.item, r.title, true));
          links.appendChild(d);
        }
        if (r.remove) links.appendChild(this._mkRemoveLink(r));
        col.appendChild(links);
      }
      main.appendChild(col);
      if (r.check) main.insertAdjacentHTML('beforeend', uiSvg('<path d="M5 12l5 5 9-10"/>', 'fd-ok'));
      if (r.onTap) {
        main.classList.add('fd-tap');
        main.setAttribute('role', 'button');
        main.tabIndex = 0;
        main.addEventListener('click', () => { r.onTap(); this.bang.store.save(); this.refresh(); });
      }
      row.appendChild(main);

      // Crayon : ouvre le formulaire prérempli
      if (r.item) {
        const e = document.createElement('button');
        e.className = 'fd-edit';
        e.setAttribute('aria-label', 'Modifier ' + r.title);
        e.innerHTML = uiSvg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>');
        e.addEventListener('click', () => this._openForm(r.item, r.title));
        row.appendChild(e);
      }
      card.appendChild(row);
    });
    this.list.replaceChildren(card);
  }
}

// Enregistre les quatre pages (contextes superposés) auprès du gestionnaire
function registerFeedPages(manager, bang) {
  const store = () => bang.store;
  const net = () => bang.network;
  const scope = () => 'Réseau : ' + (net() ? net().name : '—');
  const providerName = s => {
    if (s.provider && typeof s.provider === 'object') return s.provider.name;
    const p = net() && net().getProvider(s.provider);
    return p ? p.name : '';
  };
  const zoneName = s => { const z = net() && s.zoneId && net().getZone(s.zoneId); return z ? z.name : ''; };
  const sortedStops = () => bang.getStops().slice()
    .sort((a, b) => fpStopLabel(a).localeCompare(fpStopLabel(b), 'fr'));

  const pages = {
    networks: {
      title: 'Réseaux',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
      addLabel: 'Ajouter un réseau',
      sub: () => fdPlural(store().networks.length, 'réseau', 'réseaux') + ' · touche un réseau pour l’activer',
      fields: n => [
        { name: 'name', label: 'Nom du réseau', required: true, capitalize: 'sentences', value: n && n.name },
        { name: 'region', label: 'Région', capitalize: 'words', value: n && n.region },
        { name: 'lineCodes', label: 'Codes ligne (séparés par des virgules, ex. 219, 220, L12)',
          capitalize: 'characters', value: n ? n.lineCodes.join(', ') : '' },
        { name: 'icon', label: 'Icône', type: 'icon', value: n && n.icon }
      ],
      submit: (v, n) => {
        if (!v.name) return 'Le nom du réseau est obligatoire.';
        const codes = fpParseCodes(v.lineCodes);
        if (n) { n.name = v.name; n.region = v.region; n.icon = v.icon || null; n.lineCodes = codes; }
        else store().add(new Network({ id: uid('n'), name: v.name, region: v.region, icon: v.icon || null, lineCodes: codes }));
        return null;
      },
      rows: () => store().networks.map(n => ({
        title: n.name,
        sub: [n.region, fdPlural(n.services.length, 'service'), n.lineCodes.length ? fdPlural(n.lineCodes.length, 'code ligne', 'codes ligne') : ''].filter(Boolean).join(' · '),
        icon: n.icon,
        check: n.id === store().activeId,
        onTap: () => store().setActive(n.id),
        item: n
      }))
    },

    providers: {
      title: 'Fournisseurs',
      icon: '<rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 11h16"/><circle cx="8" cy="20" r="1.5"/><circle cx="16" cy="20" r="1.5"/>',
      addLabel: 'Ajouter un fournisseur',
      sub: scope,
      fields: p => [
        { name: 'name', label: 'Nom du fournisseur', required: true, capitalize: 'words', value: p && p.name },
        { name: 'phone', label: 'Téléphone', input: 'tel', value: p && p.phone },
        { name: 'website', label: 'Site web', input: 'url', value: p && p.website }
      ],
      submit: (v, p) => {
        if (!v.name) return 'Le nom du fournisseur est obligatoire.';
        if (p) { p.name = v.name; p.phone = v.phone || null; p.website = v.website || null; }
        else net().addProvider(new Provider({
          id: uid('p'), name: v.name, phone: v.phone || null, website: v.website || null
        }));
        return null;
      },
      rows: () => {
        const counts = fdProviderCounts(net());
        return net().providers.map(p => ({
          title: p.name,
          sub: [fdPlural(counts.get(p.id) || 0, 'service'), p.phone].filter(Boolean).join(' · '),
          item: p
        }));
      }
    },

    zones: {
      title: 'Zones',
      icon: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
      addLabel: 'Ajouter une zone',
      sub: scope,
      fields: z => [
        { name: 'id', label: 'Identifiant (ex. Z1)', required: true, capitalize: 'characters', value: z && z.id },
        { name: 'name', label: 'Nom de la zone', required: true, capitalize: 'words', value: z && z.name }
      ],
      submit: (v, z) => {
        if (!v.id) return 'L’identifiant est obligatoire.';
        if (!v.name) return 'Le nom de la zone est obligatoire.';
        if (net().zones.some(o => o !== z && o.id.toLowerCase() === v.id.toLowerCase()))
          return 'Cet identifiant existe déjà.';
        if (z) {
          const old = z.id;
          z.id = v.id; z.name = v.name;
          // L'identifiant change : les arrêts rattachés suivent
          if (old !== v.id) bang.getStops().forEach(s => { if (s.zoneId === old) s.zoneId = v.id; });
        } else net().addZone(new Zone({ id: v.id, name: v.name }));
        return null;
      },
      rows: () => {
        const counts = new Map();
        bang.getStops().forEach(s => { if (s.zoneId) counts.set(s.zoneId, (counts.get(s.zoneId) || 0) + 1); });
        return net().zones.map(z => ({
          title: z.name,
          sub: [z.id, fdPlural(counts.get(z.id) || 0, 'arrêt')].join(' · '),
          item: z
        }));
      }
    },

    lines: {
      title: 'Lignes',
      icon: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 17c6-1 2-9 8-10.3"/>',
      noAdd: true,
      sub: () => 'Déduites des services (même code ligne) · touche le crayon pour ajouter un nom ou une description',
      fields: l => [
        { name: 'name', label: 'Nom de la ligne (défaut : ' + l.autoName + ')', capitalize: 'sentences', value: l.custom },
        { name: 'description', label: 'Description (facultative)', capitalize: 'sentences', multiline: true, rows: 5, value: l.description }
      ],
      submit: (v, l) => {
        net().setLineInfo(l.key, { name: v.name, description: v.description });
        return null;
      },
      rows: () => net().lines().map(l => {
        const mode = l.modes.map(x => (SERVICE_MODES.find(m => m.value === x) || {}).label || x).join(' + ');
        return {
          title: (l.code ? l.code + ' · ' : '') + l.name,
          sub: [mode, fdPlural(l.services.length, 'service'), fdPlural(l.stopCount, 'arrêt'), l.description].filter(Boolean).join(' · '),
          item: l
        };
      })
    },

    emissions: {
      title: 'Facteurs CO₂',
      icon: '<path d="M7 17a5 5 0 1 1 1.5-9.8A6 6 0 0 1 20 9.5 4 4 0 0 1 18 17z"/><path d="M9 21l2-3M14 21l2-3"/>',
      noAdd: true,
      sub: () => 'g CO₂e par passager et par km · valeurs indicatives à ajuster',
      fields: m => [
        { name: 'g', label: 'g CO₂e par passager et par km (défaut : ' + co2Default(m.value) + ')', type: 'decimal', required: true, value: net().co2PerKm(m.value) }
      ],
      submit: (v, m) => {
        if (v.g === null || Number.isNaN(v.g) || v.g < 0 || v.g > 5000) return 'Indique un nombre entre 0 et 5000.';
        net().setCo2(m.value, v.g);
        return null;
      },
      rows: () => SERVICE_MODES.map(m => {
        const g = net().co2PerKm(m.value), custom = g !== co2Default(m.value);
        return { title: m.label, sub: g + ' g/km' + (custom ? ' · modifié (défaut ' + co2Default(m.value) + ')' : ' · valeur par défaut'), item: m };
      })
    },

    tariffs: {
      title: 'Tarifications',
      icon: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>',
      addLabel: 'Ajouter une tarification',
      sub: scope,
      fields: t => [
        { name: 'code', label: 'Code (ex. 1BUTP)', required: true, capitalize: 'characters', value: t && t.code },
        { name: 'name', label: 'Nom (ex. Billet unité)', required: true, capitalize: 'sentences', value: t && t.name },
        { name: 'audience', label: 'Public cible (ex. Tout public)', capitalize: 'sentences',
          value: t ? t.audience : 'Tout public' },
        { name: 'kind', label: 'Nature du titre', type: 'select', value: t ? t.kind : 'unit',
          options: [{ value: 'unit', label: 'Billet unité (1 trajet)' },
                    { value: 'multi', label: 'Carte de plusieurs trajets' },
                    { value: 'pass', label: 'Abonnement (période)' }] },
        { name: 'trips', label: 'Nombre de trajets de la carte (ex. 10)', input: 'text', inputmode: 'numeric', type: 'decimal',
          value: t && t.kind === 'multi' ? t.trips : null, showIf: v => v.kind === 'multi' },
        { name: 'periodDays', label: 'Durée de l’abonnement en jours (ex. 30)', input: 'text', inputmode: 'numeric', type: 'decimal',
          value: t && t.kind === 'pass' ? t.periodDays : null, showIf: v => v.kind === 'pass' },
        { name: 'crossway', label: 'Crossway', type: 'toggle', text: 'Valable dans les deux sens',
          value: t ? t.crossway : false },
        { name: 'mode', label: 'Mécanisme de tarification', type: 'select',
          value: t ? t.pricing.type : 'fixed',
          options: [{ value: 'fixed', label: 'Tarif unique' }, { value: 'zones', label: 'Forfait par nombre de zones' }] },
        { name: 'price', label: 'Prix (€)', input: 'text', inputmode: 'decimal', type: 'decimal',
          value: t && t.pricing.type === 'fixed' ? t.pricing.price : null,
          showIf: v => v.mode === 'fixed' },
        { name: 'zonePrices', label: 'Prix selon le nombre de zones traversées (€)', type: 'prices',
          value: t && t.pricing.type === 'zones' ? t.pricing.prices : [null],
          showIf: v => v.mode === 'zones' },
        { name: 'validity', label: 'Durée d’un ticket de contrôle après validation (vide = 1 h 30)', type: 'duration',
          value: t ? t.validityMinutes : null },
        { name: 'life', label: 'Couleur du ticket selon son âge : minutes et couleur (ex. 30 #2c1; 60 #2cc; 110 #c00)',
          capitalize: 'none', placeholder: '30 #2c1; 60 #2cc; 110 #c00', value: t ? Tariff.formatLifeColors(t.lifeColors) : '' }
      ],
      submit: (v, t) => {
        if (!v.code) return 'Le code est obligatoire.';
        if (/[\s,;]/.test(v.code)) return 'Le code ne doit pas contenir d’espace, de virgule ni de point-virgule.';
        if (!v.name) return 'Le nom de la tarification est obligatoire.';
        if (net().tariffs.some(o => o !== t && o.code.toLowerCase() === v.code.toLowerCase()))
          return 'Ce code existe déjà.';
        const audience = v.audience || 'Tout public';
        let pricing;
        if (v.mode === 'zones') {
          if (v.zonePrices.some(x => x === null)) return 'Renseigne le prix pour chaque nombre de zones.';
          if (v.zonePrices.some(x => !Tariff._money(x))) return 'Un des prix est invalide (nombre positif attendu).';
          pricing = { type: 'zones', prices: v.zonePrices };
        } else {
          if (v.price === null) return 'Indique le prix (0 si gratuit).';
          if (!Tariff._money(v.price)) return 'Le prix est invalide (nombre positif attendu).';
          pricing = { type: 'fixed', price: v.price };
        }
        if (v.kind === 'multi' && Tariff.cleanTrips(v.trips) === null)
          return 'Indique le nombre de trajets de la carte (entier de 2 à 1000).';
        if (v.kind === 'pass' && Tariff.cleanPeriod(v.periodDays) === null)
          return 'Indique la durée de l’abonnement en jours (entier de 1 à 366).';
        const life = Tariff.parseLifeColors(v.life);
        if (life.error) return life.error;
        const extra = { lifeColors: life.stages, kind: v.kind, trips: v.kind === 'multi' ? v.trips : null, periodDays: v.kind === 'pass' ? v.periodDays : null };
        if (v.validity !== null && (!Number.isInteger(v.validity) || v.validity < 1 || v.validity > 525600))
          return 'La durée de validité doit être comprise entre 1 minute et 1 an.';
        if (t) {
          const old = t.code;
          t.code = v.code; t.name = v.name; t.audience = audience;
          t.pricing = Tariff.cleanPricing(pricing); t.validityMinutes = v.validity; t.crossway = v.crossway;
          t.kind = extra.kind; t.trips = extra.trips; t.periodDays = extra.periodDays; t.lifeColors = extra.lifeColors;
          // Le code change : les services qui la proposent suivent
          if (old !== v.code) net().services.forEach(s => {
            s.tariffCodes = s.tariffCodes.map(c => (c === old ? v.code : c));
          });
        } else net().addTariff(new Tariff({ code: v.code, name: v.name, audience, pricing, validityMinutes: v.validity, crossway: v.crossway, ...extra }));
        return null;
      },
      rows: () => {
        const counts = new Map();
        net().services.forEach(s => s.tariffCodes.forEach(c => counts.set(c, (counts.get(c) || 0) + 1)));
        return net().tariffs.map(t => ({
          title: t.name,
          sub: [t.code, t.audience, Tariff.kindLabel(t.kind) + (t.contentLabel ? ' ' + t.contentLabel : ''), t.priceSummary(),
                t.crossway ? 'crossway' : '',
                t.validityMinutes ? 'ticket ' + Tariff.formatDuration(t.validityMinutes) : '',
                t.lifeColors.length ? fdPlural(t.lifeColors.length, 'palier de couleur', 'paliers de couleur') : '',
                fdPlural(counts.get(t.code) || 0, 'service')].filter(Boolean).join(' · '),
          item: t
        }));
      }
    },

    stops: {
      title: 'Arrêts',
      icon: '<path d="M12 21s-6-5.2-6-10a6 6 0 0 1 12 0c0 4.8-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
      addLabel: 'Ajouter un arrêt',
      sub: scope,
      fields: s => [
        { name: 'name', label: 'Nom de l’arrêt', required: true, capitalize: 'words', value: s && s.name },
        { name: 'city', label: 'Commune', capitalize: 'words', value: s && s.city },
        { name: 'zone', label: 'Zone', type: 'select', value: s ? (s.zoneId || '') : undefined,
          options: [{ value: '', label: '— Aucune —' },
                    ...net().zones.map(z => ({ value: z.id, label: z.name + ' (' + z.id + ')' }))] },
        { name: 'pos', label: 'Position (facultatif)', type: 'latlon', value: s ? { lat: s.lat, lon: s.lon } : null,
          others: net().stops.filter(o => o !== s && o.lat !== null && o.lon !== null) }
      ],
      submit: (v, s) => {
        if (!v.name) return 'Le nom de l’arrêt est obligatoire.';
        v.lat = v.pos.lat; v.lon = v.pos.lon;
        if (Number.isNaN(v.lat) || Number.isNaN(v.lon)) return 'Coordonnées invalides.';
        if ((v.lat === null) !== (v.lon === null)) return 'Renseigne la latitude et la longitude, ou aucune des deux.';
        if (v.lat !== null && (Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180)) return 'Coordonnées hors limites.';
        if (s) { s.name = v.name; s.city = v.city || null; s.lat = v.lat; s.lon = v.lon; s.zoneId = v.zone || null; }
        else net().addStop(new Stop({ id: uid('st'), name: v.name, city: v.city || null, lat: v.lat, lon: v.lon, zoneId: v.zone || null }));
        return null;
      },
      rows: () => sortedStops().map(s => ({ title: s.name, sub: [s.city, zoneName(s)].filter(Boolean).join(' · '), item: s }))
    },

    services: {
      title: 'Services',
      icon: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 6h6a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h6"/>',
      addLabel: 'Ajouter un service',
      duplicateLabel: 'Dupliquer le service',
      removeLabel: 'Supprimer le service',
      sub: scope,
      fields: sv => [
        { name: 'code', label: 'Code de la ligne (ex. L12)', required: true, capitalize: 'characters', value: sv && sv.code,
          suggest: net() ? net().lineCodes : [] },
        { name: 'name', label: 'Nom (ex. Aix – Marseille)', required: true, capitalize: 'words', value: sv && sv.name },
        { name: 'mode', label: 'Véhicule', type: 'picto', value: sv ? sv.mode : undefined, options: SERVICE_MODES },
        { name: 'provider', label: 'Fournisseur', type: 'select', value: sv ? fpProviderId(sv) : undefined,
          options: [{ value: '', label: '— Aucun —' },
                    ...net().providers.map(p => ({ value: p.id, label: p.name }))] },
        { name: 'symcolor0', label: 'Couleur symbolique 0 · fond du badge de ligne (ex. #2c1)', type: 'color', value: sv && sv.symcolor0 },
        { name: 'symcolor1', label: 'Couleur symbolique 1 · texte du badge (ex. #fff)', type: 'color', placeholder: '#fff', value: sv && sv.symcolor1 },
        { name: 'symcolor2', label: 'Couleur symbolique 2 · contour du badge (ex. #000)', type: 'color', placeholder: '#000', value: sv && sv.symcolor2 },
        { name: 'days', label: 'Jours de circulation', type: 'chips',
          value: sv ? sv.operatingDays : [1, 2, 3, 4, 5],
          options: [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Jeu'], [5, 'Ven'], [6, 'Sam'], [0, 'Dim']]
            .map(([value, label]) => ({ value, label })) },
        { name: 'periods', label: 'Périodes de fonctionnement', type: 'chips',
          value: sv ? sv.operatingPeriods : ['ta'],
          options: [{ value: 'ta', label: 'Toute l’année' }, { value: 'ps', label: 'Période scolaire' },
                    { value: 'pvs', label: 'Petites vacances' },
                    { value: 'vs', label: 'Vacances' }, { value: 'x', label: 'Jours fériés' }] },
        ...(net().tariffs.length ? [{
          name: 'tariffs', label: 'Offres tarifaires proposées', type: 'chips',
          value: sv ? sv.tariffCodes : [],
          options: net().tariffs.map(t => ({ value: t.code, label: t.name + ' · ' + t.audience + ' (' + t.code + ')' }))
        }] : []),
        { name: 'stops', label: 'Arrêts desservis (départ → arrivée) *', type: 'stops',
          value: sv ? sv.stopTimes.map(st => ({ stopId: st.stop.id, time: st.departure || st.arrival || '' })) : undefined,
          options: sortedStops().map(s => ({ value: s.id, label: fpStopLabel(s) })) }
      ],
      submit: (v, item) => {
        const all = bang.getStops();
        if (all.length < 2) return 'Ajoute d’abord au moins deux arrêts.';
        if (!v.code) return 'Le code de la ligne est obligatoire.';
        if (!v.name) return 'Le nom du service est obligatoire.';
        if (v.stops.some(s => !s.stopId)) return 'Choisis un arrêt pour chaque ligne.';
        if (v.stops.some((s, i) => i && s.stopId === v.stops[i - 1].stopId)) return 'Deux arrêts consécutifs sont identiques.';
        for (const k of [0, 1, 2]) {
          if (v['symcolor' + k] && !symColor(v['symcolor' + k])) return 'Couleur symbolique ' + k + ' : format attendu #rgb ou #rrggbb.';
        }
        if (!v.days.length) return 'Choisis au moins un jour de circulation.';
        if (!v.periods.length) return 'Choisis au moins une période.';

        const byId = new Map(all.map(s => [s.id, s]));
        const svc = item || new Service({ id: uid('s') });
        svc.code = v.code;
        svc.name = v.name;
        svc.mode = v.mode;
        svc.symcolor0 = symColor(v.symcolor0);
        svc.symcolor1 = symColor(v.symcolor1);
        svc.symcolor2 = symColor(v.symcolor2);
        svc.provider = net().getProvider(v.provider) || null;
        svc.operatingDays = v.days.slice();
        svc.operatingPeriods = v.periods.slice();
        svc.tariffCodes = (v.tariffs || []).slice();

        // Une heure par arrêt : départ au premier, arrivée au dernier, les deux entre.
        // Si l'arrêt et l'heure n'ont pas changé, on garde les horaires d'origine
        // (arrivée et départ distincts éventuels).
        const old = item ? item.stopTimes.slice() : [];
        const last = v.stops.length - 1;
        svc.stopTimes = [];
        v.stops.forEach((s, i) => {
          const o = old[i];
          const same = o && o.stop.id === s.stopId && (o.departure || o.arrival || '') === s.time;
          svc.addStop(byId.get(s.stopId), same
            ? { arrival: i === 0 ? null : o.arrival, departure: i === last ? null : o.departure }
            : { arrival: i === 0 ? null : (s.time || null), departure: i === last ? null : (s.time || null) });
        });
        if (!item) net().addService(svc);
        return null;
      },
      rows: () => net().services.map(s => {
        const a = s.departure && fpStopLabel(s.departure.stop);
        const b = s.arrival && fpStopLabel(s.arrival.stop);
        return {
          title: s.code + ' · ' + s.name,
          sub: [a && b ? a + ' → ' + b : '', providerName(s), s.tariffCodes.join(', ')].filter(Boolean).join(' · '),
          item: s,
          service: s,
          duplicate: true,
          remove: () => net().removeService(s.id)
        };
      })
    }
  };

  Object.entries(pages).forEach(([key, cfg]) => {
    manager.register(new FeedPage(bang, 'feed-' + key, cfg), { overlay: true });
  });

  if (typeof DetectContext === 'function') manager.register(new DetectContext(bang, 'feed-detect'), { overlay: true });
  if (typeof CalendarContext === 'function') manager.register(new CalendarContext(bang, 'feed-calendar'), { overlay: true });

  // Pages Exporter / Importer (ctx-feed-data.js)
  if (typeof registerFeedDataPages === 'function') registerFeedDataPages(manager, bang);
}

window.FeedPage = FeedPage;
window.registerFeedPages = registerFeedPages;
