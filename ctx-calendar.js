// ctx-calendar.js — Feed › Calendrier : périodes de circulation du réseau actif.
// On « peint » le calendrier : petites vacances, vacances, jours fériés. La période scolaire est déduite (tout le reste).
// Les services (périodes ps / pvs / vs / x) s'évaluent ensuite avec Service.runsOn(date, réseau).

class CalendarContext extends Context {
  build(el) {
    this._injectStyle();
    if (typeof fdInjectStyle === 'function') fdInjectStyle();
    const now = new Date();
    this.cursor = { y: now.getFullYear(), m: now.getMonth() };   // mois affiché (m : 0-11)
    this.brush = 'pvs';                                          // 'pvs' | 'vs' | 'x' | 'erase'
    this.pending = null;                                         // premier jour touché d'une période

    const title = document.createElement('div');
    title.className = 'fd-title';
    const h = document.createElement('h2');
    h.textContent = 'Calendrier';
    this.sub = document.createElement('small');
    title.append(h, this.sub);

    this.body = document.createElement('div');
    el.append(fdMkBar(this.bang, { back: true }),
      mkWaveHeader(uiSvg('<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/><path d="M8 14h2M14 14h2M8 17h2"/>')),
      title, this.body);
    this.refresh();
  }

  onShow() { if (this.built) this.refresh(); }

  get net() { return this.bang.network; }

  _save() { this.bang.store.save(); }

  refresh() {
    const net = this.net;
    this.sub.textContent = net ? 'Réseau : ' + net.name : '';
    if (!net) {
      const d = document.createElement('div');
      d.className = 'cl-note';
      d.textContent = 'Aucun réseau actif : active un réseau dans Feed › Réseaux.';
      this.body.replaceChildren(d);
      return;
    }
    this.body.replaceChildren(this._mkToday(), this._mkBrushes(), this._mkHint(), this._mkMonth(), this._mkLegend(), this._mkLists());
  }

  _fmt(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
    return new Date(iso + 'T12:00:00').toLocaleDateString('fr-FR', opts);
  }

  _e(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Nature du jour d'aujourd'hui, ou rappel qu'aucun calendrier n'est renseigné
  _mkToday() {
    const net = this.net;
    const card = this._e('div', 'cl-today');
    if (!net.hasCalendar) {
      card.textContent = 'Aucune période renseignée : tous les services sont considérés comme circulant selon leurs jours de la semaine.';
      return card;
    }
    const iso = Network.iso(new Date());
    const p = net.periodsOn(iso);
    const parts = [];
    if (p.holiday) parts.push('jour férié' + (p.holidayName ? ' (' + p.holidayName + ')' : ''));
    if (p.pvs) parts.push('petites vacances');
    if (p.vs) parts.push('vacances');
    if (p.school) parts.push('période scolaire');
    const n = net.services.filter(sv => sv.runsOn(iso, net)).length;
    card.append(this._e('b', null, 'Aujourd’hui : '), document.createTextNode(parts.join(', ') + ' · ' +
      n + (n > 1 ? ' services circulent' : ' service circule') + ' sur ' + net.services.length));
    return card;
  }

  _mkBrushes() {
    const wrap = this._e('div', 'cl-brushes');
    [['pvs', 'Petites vacances'], ['vs', 'Vacances'], ['x', 'Jour férié'], ['erase', 'Gomme']].forEach(([k, label]) => {
      const b = this._e('button', 'cl-brush cl-b-' + k);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(this.brush === k));
      b.append(this._e('i', 'cl-sw'), document.createTextNode(label));
      b.addEventListener('click', () => { this.brush = k; this.pending = null; this.refresh(); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  _mkHint() {
    let t;
    if (this.pending) t = 'Début : ' + this._fmt(this.pending) + ' · touche le dernier jour (ou le même jour pour un seul jour).';
    else if (this.brush === 'x') t = 'Touche un jour pour le marquer ou le démarquer comme férié.';
    else if (this.brush === 'erase') t = 'Touche le premier puis le dernier jour à effacer (vacances et jours fériés).';
    else t = 'Touche le premier puis le dernier jour de la période.';
    return this._e('p', 'cl-hint', t);
  }

  _mkMonth() {
    const net = this.net;
    const { y, m } = this.cursor;
    const box = this._e('div', 'cl-card');

    const head = this._e('div', 'cl-head');
    const nav = (label, aria, dm) => {
      const b = this._e('button', 'cl-nav', label);
      b.type = 'button';
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', () => { this._shift(dm); });
      return b;
    };
    const title = this._e('b', 'cl-month', new Date(Date.UTC(y, m, 1)).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' }));
    const today = this._e('button', 'cl-today-btn', 'Aujourd’hui');
    today.type = 'button';
    today.addEventListener('click', () => { const n = new Date(); this.cursor = { y: n.getFullYear(), m: n.getMonth() }; this.refresh(); });
    head.append(nav('‹', 'Mois précédent', -1), title, nav('›', 'Mois suivant', 1));
    box.append(head);

    const grid = this._e('div', 'cl-grid');
    ['L', 'M', 'M', 'J', 'V', 'S', 'D'].forEach(d => grid.appendChild(this._e('span', 'cl-dow', d)));
    const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    for (let i = 0; i < lead; i++) grid.appendChild(this._e('span', 'cl-blank'));
    const todayIso = Network.iso(new Date());
    for (let d = 1; d <= days; d++) {
      const iso = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      const p = net.periodsOn(iso);
      const b = this._e('button', 'cl-d', String(d));
      b.type = 'button';
      if (p.vs) b.classList.add('vs');
      if (p.pvs) b.classList.add('pvs');
      if (p.holiday) b.classList.add('x');
      if (iso === todayIso) b.classList.add('today');
      if (iso === this.pending) b.classList.add('pending');
      const lab = [this._fmt(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })];
      if (p.holiday) lab.push('jour férié' + (p.holidayName ? ' ' + p.holidayName : ''));
      if (p.pvs) lab.push('petites vacances');
      if (p.vs) lab.push('vacances');
      b.setAttribute('aria-label', lab.join(', '));
      b.addEventListener('click', () => this._tap(iso));
      grid.appendChild(b);
    }
    box.append(grid);

    const foot = this._e('div', 'cl-foot');
    foot.appendChild(today);
    const fr = this._e('button', 'cl-fr', 'Fériés ' + y + ' (France)');
    fr.type = 'button';
    fr.addEventListener('click', () => {
      Network.frenchHolidays(y).forEach(h => { if (!net.calendar.holidays.some(x => x.date === h.date)) net.setHoliday(h.date, true, h.name); });
      this._save();
      this.refresh();
    });
    foot.appendChild(fr);
    box.append(foot);
    return box;
  }

  _shift(dm) {
    let { y, m } = this.cursor;
    m += dm;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    this.cursor = { y, m };
    this.refresh();
  }

  _tap(iso) {
    const net = this.net;
    if (!net) return;
    if (this.brush === 'x') {
      const on = !net.calendar.holidays.some(h => h.date === iso);
      const known = Network.frenchHolidays(+iso.slice(0, 4)).find(h => h.date === iso);
      net.setHoliday(iso, on, known ? known.name : '');
      this._save();
      this.refresh();
      return;
    }
    if (!this.pending) { this.pending = iso; this.refresh(); return; }
    const a = this.pending;
    this.pending = null;
    if (this.brush === 'erase') net.eraseRange(a, iso); else net.paintRange(this.brush, a, iso);
    this._save();
    this.refresh();
  }

  _mkLegend() {
    const l = this._e('div', 'cl-legend');
    [['', 'Période scolaire (déduite)'], ['pvs', 'Petites vacances'], ['vs', 'Vacances'], ['x', 'Jour férié']].forEach(([k, t]) => {
      const s = this._e('span', 'cl-lg');
      s.append(this._e('i', 'cl-sw cl-b-' + (k || 'ps')), document.createTextNode(t));
      l.appendChild(s);
    });
    return l;
  }

  _mkLists() {
    const net = this.net;
    const wrap = document.createElement('div');
    const list = (title, rows) => {
      wrap.appendChild(this._e('div', 'fd-h', title));
      const card = this._e('div', 'fd-card');
      if (!rows.length) card.appendChild(this._e('div', 'fd-row', 'Aucune'));
      rows.forEach(r => card.appendChild(r));
      wrap.appendChild(card);
    };
    const row = (cls, main, sub, goto, remove) => {
      const r = this._e('div', 'fd-row');
      const m = this._e('div', 'fd-main fd-tap');
      m.setAttribute('role', 'button');
      m.tabIndex = 0;
      const col = this._e('div', 'fd-col');
      col.appendChild(this._e('span', null, main));
      if (sub) col.appendChild(this._e('small', null, sub));
      m.append(this._e('i', 'cl-sw ' + cls), col);
      m.addEventListener('click', () => { this.cursor = { y: +goto.slice(0, 4), m: +goto.slice(5, 7) - 1 }; this.refresh(); });
      const x = this._e('button', 'fd-edit');
      x.type = 'button';
      x.setAttribute('aria-label', 'Supprimer');
      x.innerHTML = uiSvg('<path d="M6 6l12 12M18 6L6 18"/>');
      x.addEventListener('click', remove);
      r.append(m, x);
      return r;
    };
    const names = { pvs: 'Petites vacances', vs: 'Vacances' };
    list('Périodes de vacances', net.calendar.ranges.map(r => {
      const n = Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86400000) + 1;
      const label = r.start === r.end ? this._fmt(r.start) : this._fmt(r.start, { day: 'numeric', month: 'short' }) + ' → ' + this._fmt(r.end);
      return row('cl-b-' + r.type, names[r.type], label + ' · ' + n + (n > 1 ? ' jours' : ' jour'), r.start, () => {
        net.calendar.ranges = net.calendar.ranges.filter(x => x !== r);
        this._save();
        this.refresh();
      });
    }));
    list('Jours fériés', net.calendar.holidays.map(h => row('cl-b-x', this._fmt(h.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), h.name, h.date, () => {
      net.setHoliday(h.date, false);
      this._save();
      this.refresh();
    })));
    return wrap;
  }

  _injectStyle() {
    if (document.getElementById('cl-style')) return;
    const st = document.createElement('style');
    st.id = 'cl-style';
    st.textContent = `
      .cl-note,.cl-today{margin:1em 1em 0;font-size:.9em;color:var(--inactive-color);text-align:center}
      .cl-today{background:#fff;border-radius:14px;padding:.8em 1em;color:var(--text-color)}
      .cl-brushes{display:flex;flex-wrap:wrap;gap:.5em;margin:.9em 1em 0}
      .cl-brush,.cl-brush:hover{display:inline-flex;align-items:center;gap:.5em;background:#fff;color:var(--text-color);
        border-radius:999px;padding:.5em .9em;font-size:.88em;border:2px solid transparent}
      .cl-brush[aria-pressed="true"]{border-color:var(--accent-color);font-weight:600}
      .cl-sw{display:inline-block;flex:none;width:1em;height:1em;border-radius:50%;border:1px solid rgba(0,0,0,.2);background:#fff}
      .cl-b-pvs{background:#ffd89a;border-color:#e69a1c}
      .cl-b-vs{background:#b7e0c0;border-color:#4aa564}
      .cl-b-x{background:#fff;border:2px solid #d9534f}
      .cl-b-ps{background:#fff}
      .cl-b-erase{background:repeating-linear-gradient(135deg,#fff 0 3px,#ddd 3px 6px)}
      .cl-hint{margin:.6em 1.2em 0;font-size:.82em;color:var(--inactive-color);min-height:1.3em}
      .cl-card{margin:.5em 1em 0;background:#fff;border-radius:18px;padding:.8em .6em .6em}
      .cl-head{display:flex;align-items:center;justify-content:space-between;padding:0 .2em .5em}
      .cl-month{text-transform:capitalize}
      .cl-nav,.cl-nav:hover{width:2.4em;height:2.4em;padding:0;border-radius:50%;background:#eef2f6;color:var(--accent-color);font-size:1.2em;line-height:1}
      .cl-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
      .cl-dow{text-align:center;font-size:.72em;color:var(--inactive-color);padding:.2em 0}
      .cl-d,.cl-d:hover{aspect-ratio:1/1;padding:0;border-radius:10px;background:#f6f7f9;color:var(--text-color);font-size:.92em;
        border:2px solid transparent;position:relative}
      .cl-d.vs{background:#b7e0c0}
      .cl-d.pvs{background:#ffd89a}
      .cl-d.x{border-color:#d9534f;font-weight:700}
      .cl-d.today{box-shadow:inset 0 0 0 2px var(--accent-color)}
      .cl-d.pending{background:var(--accent-color);color:#fff}
      .cl-foot{display:flex;justify-content:space-between;gap:.6em;padding:.7em .2em 0}
      .cl-today-btn,.cl-fr,.cl-today-btn:hover,.cl-fr:hover{background:none;color:var(--accent-color);padding:.3em .2em;font-size:.82em;font-weight:600}
      .cl-legend{display:flex;flex-wrap:wrap;gap:.4em 1em;margin:.7em 1.2em 0;font-size:.75em;color:var(--inactive-color)}
      .cl-lg{display:inline-flex;align-items:center;gap:.4em}
      .fd-main .cl-sw{margin-right:.2em}
    `;
    document.head.appendChild(st);
  }
}

window.CalendarContext = CalendarContext;
