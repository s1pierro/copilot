// ui-form.js — mini constructeur de formulaires (champs déclaratifs)
//
// mkForm(fields, { submitLabel, onSubmit })
//   fields : [{ name, label, type, required, ... }]
//   onSubmit(values) : renvoie un message d'erreur (affiché sous le formulaire) ou null si OK
// Types : picto, text (input: 'tel' | 'url'…), decimal, select, chips, stops, icon, prices, duration, toggle
// Option de champ : showIf(valeurs) -> booléen, pour afficher le champ selon les autres valeurs.

const UF_TYPES = {
  text(f) {
    const i = document.createElement(f.multiline ? 'textarea' : 'input');
    if (f.multiline) { i.rows = f.rows || 4; i.style.resize = 'vertical'; i.style.fontFamily = 'inherit'; }
    else i.type = f.input || 'text';
    i.autocomplete = 'off';
    i.spellcheck = false;
    if (f.inputmode) i.inputMode = f.inputmode;
    if (f.capitalize) i.autocapitalize = f.capitalize;
    if (f.placeholder) i.placeholder = f.placeholder;
    i.setAttribute('aria-label', f.label);
    i.value = f.value == null ? '' : String(f.value);
    // Suggestions (liste de valeurs proposées, saisie libre conservée)
    if (f.suggest && f.suggest.length) {
      const dl = document.createElement('datalist');
      dl.id = 'uf-dl-' + Math.random().toString(36).slice(2, 9);
      f.suggest.forEach(v => { const o = document.createElement('option'); o.value = v; dl.appendChild(o); });
      i.setAttribute('list', dl.id);
      const wrap = document.createElement('div');
      wrap.append(i, dl);
      return { el: wrap, get: () => i.value.trim() };
    }
    return { el: i, get: () => i.value.trim() };
  },

  // Nombre décimal : null si vide, NaN si invalide
  decimal(f) {
    const c = UF_TYPES.text({ ...f, inputmode: 'decimal' });
    const get = c.get;
    c.get = () => {
      const v = get().replace(',', '.');
      return v === '' ? null : Number(v);
    };
    return c;
  },

  // Position : latitude + longitude, avec carte (MapLibre) pour la désigner en touchant.
  // f.value = {lat, lon} ; f.others = [{lat, lon}] (repères existants) ; get() -> {lat, lon} (null si vide, NaN si invalide)
  latlon(f) {
    const box = document.createElement('div');
    box.className = 'uf-ll';
    const la = UF_TYPES.decimal({ label: 'Latitude', placeholder: 'Latitude', value: f.value && f.value.lat });
    const lo = UF_TYPES.decimal({ label: 'Longitude', placeholder: 'Longitude', value: f.value && f.value.lon });
    const nums = document.createElement('div');
    nums.className = 'uf-ll-nums';
    nums.append(la.el, lo.el);
    const acts = document.createElement('div');
    acts.className = 'uf-ll-acts';
    const mkBtn = t => { const b = document.createElement('button'); b.type = 'button'; b.className = 'uf-ll-btn'; b.textContent = t; acts.appendChild(b); return b; };
    const bMap = mkBtn('Placer sur la carte');
    const bMe = mkBtn('Ma position');
    const bClr = mkBtn('Effacer');
    const hold = document.createElement('div');
    hold.className = 'uf-ll-map';
    hold.hidden = true;
    const note = document.createElement('div');
    note.className = 'uf-ll-note';
    box.append(nums, acts, hold, note);

    let picker = null;
    const valid = () => {
      const a = la.get(), b = lo.get();
      return a === null || b === null || Number.isNaN(a) || Number.isNaN(b) || Math.abs(a) > 90 || Math.abs(b) > 180 ? null : { lat: a, lon: b };
    };
    const write = (lat, lon) => { la.el.value = lat.toFixed(6); lo.el.value = lon.toFixed(6); };
    const sync = () => { const v = valid(); if (picker && v) picker.set(v.lat, v.lon); };
    la.el.addEventListener('change', sync);
    lo.el.addEventListener('change', sync);

    bMap.addEventListener('click', async () => {
      if (picker || !hold.hidden) { if (picker) picker.destroy(); picker = null; hold.hidden = true; bMap.textContent = 'Placer sur la carte'; note.textContent = ''; return; }
      hold.hidden = false;
      bMap.textContent = 'Fermer la carte';
      note.textContent = 'Chargement de la carte…';
      const ok = window.GLNet && await GLNet.load();
      if (hold.hidden) return;                         // refermée entre-temps
      if (!ok || !GLNet.supported()) {
        hold.hidden = true; bMap.textContent = 'Placer sur la carte';
        note.textContent = 'Carte indisponible ici (hors ligne ?). Saisis les coordonnées à la main.';
        return;
      }
      note.textContent = 'Touche la carte pour placer l’arrêt, ou fais glisser le repère rouge.';
      picker = new GLPicker(hold, { point: valid(), others: f.others, onPick: write });
    });
    bMe.addEventListener('click', () => {
      if (!navigator.geolocation) { note.textContent = 'Position indisponible.'; return; }
      note.textContent = 'Recherche de ta position…';
      navigator.geolocation.getCurrentPosition(p => {
        write(p.coords.latitude, p.coords.longitude);
        note.textContent = 'Position actuelle appliquée.';
        if (picker) picker.set(p.coords.latitude, p.coords.longitude);
      }, () => { note.textContent = 'Position refusée ou indisponible.'; }, { enableHighAccuracy: true, timeout: 10000 });
    });
    bClr.addEventListener('click', () => { la.el.value = ''; lo.el.value = ''; if (picker) picker.clear(); });

    return {
      el: box,
      get: () => ({ lat: la.get(), lon: lo.get() }),
      destroy: () => { if (picker) { picker.destroy(); picker = null; } }
    };
  },

  select(f) {
    const s = document.createElement('select');
    s.setAttribute('aria-label', f.label);
    (f.options || []).forEach(o => {
      const op = document.createElement('option');
      op.value = o.value;
      op.textContent = o.label;
      s.appendChild(op);
    });
    if (f.value != null) s.value = f.value;
    return { el: s, get: () => s.value };
  },

  // Couleur « #rgb » / « #rrggbb » : champ texte et pastille d'aperçu (vide = aucune)
  color(f) {
    const box = document.createElement('div');
    box.className = 'uf-color';
    const sw = document.createElement('span');
    sw.className = 'uf-sw';
    const i = document.createElement('input');
    i.type = 'text';
    i.placeholder = f.placeholder || '#2c1';
    i.setAttribute('aria-label', f.label);
    i.autocomplete = 'off'; i.autocapitalize = 'none'; i.spellcheck = false; i.maxLength = 7;
    i.value = f.value || '';
    const paint = () => {
      const c = typeof symColor === 'function' ? symColor(i.value) : null;
      sw.style.background = c || '';
      sw.classList.toggle('empty', !c);
      i.setAttribute('aria-invalid', i.value.trim() && !c ? 'true' : 'false');
    };
    i.addEventListener('input', paint);
    paint();
    box.append(sw, i);
    return { el: box, get: () => i.value.trim() };
  },

  // Choix unique parmi des pictogrammes : options { value, label } (pictos/<value>.svg)
  picto(f) {
    const box = document.createElement('div');
    box.className = 'uf-pics';
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', f.label);
    let cur = f.value != null ? f.value : (f.options[0] && f.options[0].value);
    const btns = f.options.map(o => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'uf-pic';
      b.setAttribute('role', 'radio');
      b.appendChild(uiPicto(o.value));
      const t = document.createElement('span');
      t.textContent = o.label;
      b.appendChild(t);
      b.addEventListener('click', () => { cur = o.value; sync(); });
      box.appendChild(b);
      return [o.value, b];
    });
    const sync = () => btns.forEach(([v, b]) => b.setAttribute('aria-checked', v === cur ? 'true' : 'false'));
    sync();
    return { el: box, get: () => cur };
  },

  // Choix multiple sous forme de pastilles
  chips(f) {
    const box = document.createElement('div');
    box.className = 'uf-chips';
    const sel = new Set(f.value || []);
    f.options.forEach(o => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'uf-chip';
      b.textContent = o.label;
      b.setAttribute('aria-pressed', sel.has(o.value));
      b.addEventListener('click', () => {
        if (sel.has(o.value)) sel.delete(o.value); else sel.add(o.value);
        b.setAttribute('aria-pressed', sel.has(o.value));
      });
      box.appendChild(b);
    });
    return { el: box, get: () => f.options.map(o => o.value).filter(v => sel.has(v)) };
  },

  // Prix par nombre de zones : une ligne par nombre de zones (1, 2, 3…), au moins une.
  // get() -> tableau (nombre, null si vide, NaN si invalide) ; une ligne par zone
  prices(f) {
    const box = document.createElement('div');
    const rowsEl = document.createElement('div');
    const rows = [];
    const addRow = v => {
      const r = document.createElement('div');
      r.className = 'uf-zrow';
      const lab = document.createElement('span');
      const n = rows.length + 1;
      lab.textContent = n + (n > 1 ? ' zones' : ' zone');
      const c = UF_TYPES.decimal({ label: lab.textContent + ' : prix en euros', placeholder: '€', value: v });
      r.append(lab, c.el);
      rows.push({ el: r, c });
      rowsEl.appendChild(r);
    };
    (f.value && f.value.length ? f.value : [null]).forEach(v => addRow(v));
    const bar = document.createElement('div');
    bar.className = 'uf-zbar';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'uf-link';
    add.textContent = '+ Ajouter une zone';
    add.addEventListener('click', () => { if (rows.length < 20) addRow(null); });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'uf-link';
    del.textContent = 'Retirer la dernière';
    del.addEventListener('click', () => { if (rows.length > 1) rows.pop().el.remove(); });
    bar.append(add, del);
    box.append(rowsEl, bar);
    return { el: box, get: () => rows.map(r => r.c.get()) };
  },

  // Durée : nombre + unité (minutes / heures / jours). get() -> minutes entières, null si vide, NaN si invalide
  duration(f) {
    const box = document.createElement('div');
    box.className = 'uf-dur';
    const v = Number.isInteger(f.value) && f.value > 0 ? f.value : null;
    let unit = 'min', shown = v;
    if (v !== null && v % 1440 === 0) { unit = 'd'; shown = v / 1440; }
    else if (v !== null && v % 60 === 0) { unit = 'h'; shown = v / 60; }
    const num = UF_TYPES.decimal({ label: f.label, placeholder: 'illimitée', value: shown });
    const sel = UF_TYPES.select({
      label: 'Unité de durée', value: unit,
      options: [{ value: 'min', label: 'minutes' }, { value: 'h', label: 'heures' }, { value: 'd', label: 'jours' }]
    });
    box.append(num.el, sel.el);
    const mult = { min: 1, h: 60, d: 1440 };
    return {
      el: box,
      get: () => {
        const n = num.get();
        if (n === null) return null;
        if (!isFinite(n)) return NaN;
        return Math.round(n * mult[sel.get()]);
      }
    };
  },

  // Interrupteur oui / non (bouton à bascule). get() -> booléen. f.text : libellé du bouton
  toggle(f) {
    let on = f.value === true;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'uf-chip uf-toggle';
    b.textContent = f.text || f.label;
    b.setAttribute('aria-pressed', on);
    b.addEventListener('click', () => { on = !on; b.setAttribute('aria-pressed', on); });
    return { el: b, get: () => on };
  },

  // Icône importée (voir icon-util.js) : aperçu + choisir / retirer. get() -> data URL ou null
  icon(f) {
    let value = NetIcon.isValid(f.value) ? f.value : null;
    const box = document.createElement('div');
    box.className = 'uf-icon';
    const prev = document.createElement('div');
    prev.className = 'uf-icon-prev';
    const col = document.createElement('div');
    col.className = 'uf-icon-col';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'uf-link';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'uf-link';
    del.textContent = 'Retirer l’icône';
    const msg = document.createElement('div');
    msg.className = 'uf-err';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;

    const paint = () => {
      prev.replaceChildren();
      if (value) prev.appendChild(NetIcon.mkImg(value));
      else prev.textContent = '∅';
      pick.textContent = value ? 'Changer l’image' : 'Choisir une image';
      del.hidden = !value;
    };
    pick.addEventListener('click', () => file.click());
    del.addEventListener('click', () => { value = null; msg.textContent = ''; paint(); });
    file.addEventListener('change', () => {
      const fl = file.files && file.files[0];
      file.value = '';
      if (!fl) return;
      msg.textContent = '';
      NetIcon.fromFile(fl).then(d => { value = d; paint(); })
        .catch(e => { msg.textContent = e.message; });
    });
    col.append(pick, del, msg);
    box.append(prev, col, file);
    paint();
    return { el: box, get: () => value };
  },

  // Liste ordonnée d'arrêts avec heure de passage (2 lignes minimum).
  // Un lien « insérer un arrêt » entre deux arrêts consécutifs en ajoute un à cet endroit.
  stops(f) {
    const box = document.createElement('div');
    const rowsEl = document.createElement('div');
    const rows = [];
    const options = [{ value: '', label: 'Choisir un arrêt…' }, ...(f.options || [])];

    // La ligne intercalée sous chaque arrêt porte « insérer un arrêt » (sauf sous le dernier)
    // et « supprimer » (à droite, tant qu'il reste plus de 2 arrêts). Recalculée à chaque changement.
    const relink = () => {
      rowsEl.querySelectorAll('.uf-sep').forEach(n => n.remove());
      rows.forEach((rec, i) => {
        const sep = document.createElement('div');
        sep.className = 'uf-sep';
        if (i < rows.length - 1) {
          const ins = document.createElement('button');
          ins.type = 'button';
          ins.className = 'uf-ins';
          ins.textContent = 'insérer un arrêt';
          ins.setAttribute('aria-label', 'Insérer un arrêt après l’arrêt ' + (i + 1));
          ins.addEventListener('click', () => addRow({}, rows.indexOf(rec) + 1));
          sep.appendChild(ins);
        }
        if (rows.length > 2) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'uf-ins uf-del';
          del.textContent = 'supprimer';
          del.setAttribute('aria-label', 'Supprimer l’arrêt ' + (i + 1));
          del.addEventListener('click', () => {
            if (rows.length <= 2) return;
            rows.splice(rows.indexOf(rec), 1);
            rec.el.remove();
            relink();
          });
          sep.appendChild(del);
        }
        rec.el.after(sep);
      });
    };

    // index : position d'insertion (par défaut à la fin)
    const addRow = (init = {}, index = rows.length) => {
      const r = document.createElement('div');
      r.className = 'uf-stoprow';
      const sel = UF_TYPES.select({ label: 'Arrêt', options, value: init.stopId || '' });
      const time = document.createElement('input');
      time.type = 'time';
      time.value = init.time || '';
      time.setAttribute('aria-label', 'Heure de passage');
      const rec = { sel, time, el: r };
      r.append(sel.el, time);
      if (index >= rows.length) rowsEl.appendChild(r);
      else rowsEl.insertBefore(r, rows[index].el);
      rows.splice(index, 0, rec);
      relink();
    };

    (f.value && f.value.length >= 2 ? f.value : [{}, {}]).forEach(r => addRow(r));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'uf-link';
    add.textContent = '+ Ajouter un arrêt à la ligne';
    add.addEventListener('click', () => addRow());
    box.append(rowsEl, add);
    return {
      el: box,
      get: () => rows.map(r => ({ stopId: r.sel.get(), time: r.time.value }))
    };
  },

};

function mkForm(fields, { title, submitLabel = 'Ajouter', onSubmit } = {}) {
  ufInjectStyle();
  const el = document.createElement('div');
  el.className = 'uf';
  const getters = {};
  const rowsByName = {};
  const destroyers = [];

  if (title) {
    const t = document.createElement('div');
    t.className = 'uf-title';
    t.textContent = title;
    el.appendChild(t);
  }

  fields.forEach(f => {
    const row = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'uf-label';
    label.textContent = f.label + (f.required ? ' *' : '');
    const ctl = UF_TYPES[f.type || 'text'](f);
    row.append(label, ctl.el);
    el.appendChild(row);
    getters[f.name] = ctl.get;
    if (ctl.destroy) destroyers.push(ctl.destroy);
    rowsByName[f.name] = row;
  });

  // Champs conditionnels (showIf)
  const refreshVisibility = () => {
    const values = {};
    Object.keys(getters).forEach(k => { values[k] = getters[k](); });
    fields.forEach(f => { if (f.showIf) rowsByName[f.name].hidden = !f.showIf(values); });
  };
  if (fields.some(f => f.showIf)) {
    el.addEventListener('input', refreshVisibility);
    el.addEventListener('change', refreshVisibility);
    refreshVisibility();
  }

  const err = document.createElement('div');
  err.className = 'uf-err';
  err.setAttribute('role', 'alert');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'uf-submit';
  btn.textContent = submitLabel;
  btn.addEventListener('click', () => {
    const values = {};
    Object.keys(getters).forEach(k => { values[k] = getters[k](); });
    err.textContent = (onSubmit && onSubmit(values)) || '';
  });
  el.append(err, btn);
  el.ufDestroy = () => destroyers.forEach(d => d());   // libère les cartes (contextes WebGL)
  return el;
}

function ufInjectStyle() {
  if (document.getElementById('uf-style')) return;
  const st = document.createElement('style');
  st.id = 'uf-style';
  st.textContent = `
    .uf-ll{display:flex;flex-direction:column;gap:.5em}
    .uf-ll-nums{display:grid;grid-template-columns:1fr 1fr;gap:.5em}
    .uf-ll-acts{display:flex;flex-wrap:wrap;gap:.5em}
    .uf-ll-btn,.uf-ll-btn:hover{border-radius:999px;padding:.45em .9em;background:#fff;color:var(--accent-color);
      font-weight:600;font-size:.85em;box-shadow:0 1px 5px rgba(17,94,136,.25)}
    .uf-ll-map{position:relative;border-radius:18px;overflow:hidden;box-shadow:0 2px 8px rgba(17,94,136,.15)}
    .uf-ll-note{font-size:.78em;color:var(--inactive-color)}
    .uf{display:flex;flex-direction:column;gap:.8em;padding:1em}
    .uf-title{font-weight:bold;color:var(--accent-color)}
    .uf-label{font-size:.8em;color:var(--inactive-color);margin-bottom:.25em}
    .uf input,.uf select,.uf textarea{width:100%;box-sizing:border-box;border:1px solid var(--border-color);
      border-radius:10px;padding:.75em .9em;font-size:16px;background:#fff;color:var(--text-color)}
    .uf-color{display:flex;align-items:center;gap:.6em}
    .uf-color input{flex:1;min-width:0}
    .uf-color input[aria-invalid="true"]{border-color:#b3261e}
    .uf-sw{flex:none;width:2.4em;height:2.4em;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
    .uf-sw.empty{background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/10px 10px}
    .uf-pics{display:grid;grid-template-columns:repeat(4,1fr);gap:.4em}
    .uf .uf-pic,.uf .uf-pic:hover{display:flex;flex-direction:column;align-items:center;gap:.25em;padding:.55em .2em;
      border-radius:12px;background:#fff;color:var(--text-color);font-size:.72em;line-height:1.15;text-align:center}
    .uf .uf-pic .ui-pic{width:2.4em;height:2.4em;color:var(--accent-color)}
    .uf .uf-pic[aria-checked="true"],.uf .uf-pic[aria-checked="true"]:hover{background:var(--accent-color);color:#fff}
    .uf .uf-pic[aria-checked="true"] .ui-pic{color:#fff}
    .uf-chips{display:flex;flex-wrap:wrap;gap:.4em}
    .uf .uf-chip{padding:.45em .8em;border-radius:999px;background:#fff;color:var(--text-color);
      border:1px solid var(--border-color);font-size:.9em}
    .uf .uf-chip[aria-pressed="true"]{background:var(--accent-color);
      border-color:var(--accent-color);color:#fff}
    .uf .uf-stoprow{display:flex;gap:.4em;align-items:center}
    .uf .uf-stoprow select{flex:1;min-width:0}
    .uf .uf-stoprow input{width:6.4em;flex:none}
    .uf .uf-link{background:none;color:var(--accent-color);padding:.4em 0;text-align:left}
    /* ligne intercalée : « insérer un arrêt » à gauche, « supprimer » (rouge adouci) à droite */
    .uf .uf-sep{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.4em}
    .uf .uf-ins,.uf .uf-ins:hover{display:block;background:none;border-radius:0;
      font-size:.75em;line-height:.85;padding:.2rem 0 .8rem;text-align:left;
      color:#6f9bb5;color:color-mix(in srgb,var(--accent-color) 60%,#fff)}
    .uf .uf-del,.uf .uf-del:hover{margin-left:auto;padding-left:1rem;
      color:#c98a8a;color:color-mix(in srgb,#d33 55%,#fff)}
    .uf-zrow{display:flex;align-items:center;gap:.8em;margin-bottom:.4em}
    .uf-zrow span{width:5.5em;flex:none}
    .uf-zbar{display:flex;gap:1.4em}
    .uf-dur{display:flex;gap:.5em}
    .uf-dur input{flex:1;min-width:0}
    .uf-dur select{width:auto;flex:none}
    .uf-icon{display:flex;align-items:center;gap:1em}
    .uf-icon-prev{width:64px;height:64px;flex:none;border-radius:14px;background:#fff;
      border:1px solid var(--border-color);display:flex;align-items:center;justify-content:center;
      color:var(--inactive-color);font-size:1.4em;overflow:hidden}
    .uf-icon-prev img{max-width:100%;max-height:100%;display:block}
    .uf-icon-col{display:flex;flex-direction:column;align-items:flex-start;min-width:0}
    .uf-err{color:#b3261e;font-size:.9em}
    .uf-err:empty{display:none}
    .uf .uf-submit,.uf .uf-submit:hover{padding:.85em 1em;border-radius:12px;font-size:1em;
      background:var(--accent-color);color:#fff}
  `;
  document.head.appendChild(st);
}

window.mkForm = mkForm;
