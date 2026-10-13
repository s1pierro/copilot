// ctx-detect.js — Feed › Détection : essai de la détection du service à partir du GNSS (voir detect.js).
// Deux sources de positions : le GNSS de l'appareil (watchPosition, appli au premier plan) ou une trace simulée
// d'un service du réseau (bruit, retard et point de départ réglables), rejouée plus vite que le temps réel.

class DetectContext extends Context {
  defaultState() { return { noise: 15, speed: 30, from: 0, delay: 0, svc: null }; }

  build(el) {
    this._injectStyle();
    if (typeof fdInjectStyle === 'function') fdInjectStyle();
    const title = document.createElement('div');
    title.className = 'fd-title';
    const h = document.createElement('h2');
    h.textContent = 'Détection GNSS';
    this.sub = document.createElement('small');
    title.append(h, this.sub);
    this.body = document.createElement('div');
    el.append(fdMkBar(this.bang, { back: true }),
      mkWaveHeader(uiSvg('<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>')),
      title, this.body);
    this.refresh();
  }

  onShow() { if (this.built) this.refresh(); }
  onHide() { this._stop(); }

  get net() { return this.bang.network; }

  _e(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  refresh() {
    this._stop();
    const net = this.net;
    this.sub.textContent = net ? 'Réseau : ' + net.name : '';
    this.det = null;
    if (!net || !net.services.length) {
      this.body.replaceChildren(this._e('div', 'dt-note', net ? 'Ce réseau n’a pas encore de service.' : 'Aucun réseau actif : active un réseau dans Feed › Réseaux.'));
      return;
    }
    this.det = new Detector(net);
    this.out = this._e('div', 'dt-out');
    this.body.replaceChildren(this.out, this._mkLive(), this._mkSim(), this._mkInfo());
    this._render(this.det.state, null);
  }

  _mkInfo() {
    const net = this.net, d = this.det;
    const noPos = new Set(net.stops.filter(s => s.lat === null || s.lon === null).map(s => s.id)).size;
    const unshaped = net.services.filter(s => !s.shapeValid).length;
    const lines = [d.segmentCount + ' segments dérivés des ' + net.services.length + ' services'];
    if (unshaped) lines.push(unshaped + ' service' + (unshaped > 1 ? 's' : '') + ' sans tracé routier (lignes droites : moins précis)');
    if (noPos) lines.push(noPos + ' arrêt' + (noPos > 1 ? 's' : '') + ' sans coordonnées, ignorés');
    if (!net.hasCalendar) lines.push('aucun calendrier : les périodes (vacances, fériés) ne sont pas utilisées');
    const c = this._e('div', 'dt-card dt-info');
    lines.forEach(l => c.appendChild(this._e('small', null, l)));
    return c;
  }

  _mkLive() {
    const c = this._e('div', 'dt-card');
    c.appendChild(this._e('b', 'dt-h', 'Position réelle'));
    this.liveBtn = this._e('button', 'dt-btn', 'Démarrer le GNSS');
    this.liveBtn.type = 'button';
    this.liveBtn.addEventListener('click', () => this.watching ? this._stop() : this._startLive());
    c.append(this.liveBtn, this._e('small', 'dt-s', 'L’appli doit rester ouverte et l’écran allumé : le navigateur coupe le GNSS en arrière-plan.'));
    return c;
  }

  _mkSim() {
    const net = this.net, st = this.state;
    const c = this._e('div', 'dt-card');
    c.appendChild(this._e('b', 'dt-h', 'Simulation'));
    const sel = this._e('select', 'dt-sel');
    net.services.forEach((sv, i) => {
      const o = this._e('option', null, (sv.code ? sv.code + ' · ' : '') + (sv.name || 'Service'));
      o.value = sv.id;
      sel.appendChild(o);
    });
    if (st.svc && net.services.some(s => s.id === st.svc)) sel.value = st.svc;
    sel.addEventListener('change', () => { st.svc = sel.value; this.save(); });

    const mk = (label, key, values, fmt) => {
      const w = this._e('label', 'dt-f');
      w.appendChild(this._e('span', null, label));
      const s = this._e('select', 'dt-sel');
      values.forEach(v => { const o = this._e('option', null, fmt(v)); o.value = v; s.appendChild(o); });
      s.value = String(st[key]);
      if (s.value !== String(st[key])) s.selectedIndex = 0;
      s.addEventListener('change', () => { st[key] = +s.value; this.save(); });
      w.appendChild(s);
      return w;
    };
    const row = this._e('div', 'dt-row');
    row.append(
      mk('Bruit GNSS', 'noise', [5, 15, 30, 60], v => '± ' + v + ' m'),
      mk('Départ', 'from', [0, 0.25, 0.5, 0.75], v => v ? 'à ' + v * 100 + ' % du trajet' : 'au terminus'),
      mk('Retard', 'delay', [-3, 0, 5, 12], v => v ? (v > 0 ? '+' : '') + v + ' min' : 'à l’heure'),
      mk('Vitesse', 'speed', [10, 30, 60, 120], v => '× ' + v));

    this.simBtn = this._e('button', 'dt-btn', 'Lancer la simulation');
    this.simBtn.type = 'button';
    this.simBtn.addEventListener('click', () => this.simTimer ? this._stop() : this._startSim(sel.value));
    c.append(sel, row, this.simBtn, this._e('small', 'dt-s', 'Le jour choisi est le prochain où le service circule (calendrier compris).'));
    return c;
  }

  // Prochain jour (à partir d'aujourd'hui) où le service circule
  _dayFor(sv) {
    const d = new Date();
    for (let i = 0; i < 400; i++, d.setDate(d.getDate() + 1)) if (sv.runsOn(d, this.net)) return new Date(d);
    return new Date();
  }

  _startSim(id) {
    const sv = this.net.services.find(s => s.id === id);
    if (!sv) return;
    this._stop();
    this.det.reset();
    const st = this.state, day = this._dayFor(sv);
    const from = Math.min(sv.stopTimes.length - 2, Math.floor((sv.stopTimes.length - 1) * st.from));
    const fixes = Detector.simulate(sv, { date: day, noise: st.noise, delay: st.delay, from, seed: Date.now() & 0xffff, every: 5 });
    if (!fixes.length) { this._render({ status: 'none', candidates: [], n: 0, matched: 0 }, 'Ce service n’a pas d’horaires exploitables.'); return; }
    this.sim = { sv, day, fixes, i: 0 };
    this.simBtn.textContent = 'Arrêter';
    const stepMs = 250, perStep = Math.max(1, Math.round(st.speed * stepMs / 1000 / 5));   // positions (5 s chacune) par tick
    this.simTimer = setInterval(() => {
      for (let k = 0; k < perStep && this.sim.i < fixes.length; k++) this.det.feed(fixes[this.sim.i++]);
      const done = this.sim.i >= fixes.length;
      const f = fixes[Math.min(this.sim.i, fixes.length) - 1];
      this._render(this.det.state, null, { sim: sv, f, progress: this.sim.i / fixes.length });
      if (done) this._stop(true);
    }, stepMs);
  }

  _startLive() {
    if (!navigator.geolocation) { this._render(this.det.state, 'Ce navigateur n’a pas de GNSS.'); return; }
    this._stop();
    this.det.reset();
    this.liveBtn.textContent = 'Arrêter le GNSS';
    this.watching = navigator.geolocation.watchPosition(p => {
      const c = p.coords;
      this.det.feed({ t: p.timestamp, lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed, heading: c.heading });
      this._render(this.det.state, null, { f: { acc: c.accuracy }, live: true });
    }, err => {
      this._stop(true);
      if (window.GeoPerm) { GeoPerm.noteError(err); if (err.code === 1) GeoPerm.showHelp('denied'); }
      this._render(this.det.state, err.code === 1 ? 'Localisation refusée : autorise-la pour ce site dans les réglages du navigateur.' : 'Position indisponible (' + err.message + ').');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }

  _stop(keepResult) {
    if (this.simTimer) { clearInterval(this.simTimer); this.simTimer = null; }
    if (this.watching != null && navigator.geolocation) { navigator.geolocation.clearWatch(this.watching); }
    this.watching = null;
    if (this.liveBtn) this.liveBtn.textContent = 'Démarrer le GNSS';
    if (this.simBtn) this.simBtn.textContent = 'Lancer la simulation';
  }

  _fmtMin(m) { const t = Math.round(m); return String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); }

  _badge(sv) {
    const b = this._e('span', 'dt-code', sv.code || '•');
    if (sv.symcolor0) b.style.background = sv.symcolor0;
    if (sv.symcolor1) b.style.color = sv.symcolor1;
    return b;
  }

  _render(s, msg, info = {}) {
    const LABEL = { none: ['En attente de positions…', 'wait'], off: ['Hors réseau', 'off'], ambiguous: ['Ambigu', 'amb'], probable: ['Service probable', 'prob'], locked: ['Service identifié', 'lock'] };
    const [txt, cls] = LABEL[s.status] || LABEL.none;
    const c = this._e('div', 'dt-card dt-res');
    const head = this._e('div', 'dt-status ' + cls);
    head.appendChild(this._e('span', null, txt));
    c.appendChild(head);
    if (msg) c.appendChild(this._e('div', 'dt-err', msg));
    const meta = [s.n + ' position' + (s.n > 1 ? 's' : ''), s.matched + ' sur le réseau'];
    if (info.f && Number.isFinite(info.f.acc)) meta.push('précision ' + Math.round(info.f.acc) + ' m');
    c.appendChild(this._e('small', 'dt-s', meta.join(' · ')));
    if (info.sim) c.appendChild(this._e('small', 'dt-s', 'Simulé : ' + (info.sim.name || info.sim.code) + (info.progress != null ? ' (' + Math.round(info.progress * 100) + ' %)' : '')));

    const best = s.candidates[0];
    if (s.candidates.length && s.status !== 'off' && s.status !== 'none') {
      const top = this._e('div', 'dt-top');
      const hd = this._e('div', 'dt-line');
      hd.append(this._badge(best.service), this._e('b', 'dt-n', best.service.name || ''), this._e('span', 'dt-p', Math.round(best.p * 100) + ' %'));
      top.appendChild(hd);
      if (best.fresh && best.next) {
        const a = best.prevStop.stop, b = best.next.stop;
        top.appendChild(this._e('div', 'dt-where', a.name + ' → ' + b.name));
        const bar = this._e('div', 'dt-prog'), fill = this._e('i');
        fill.style.width = Math.round(best.progress * 100) + '%';
        bar.appendChild(fill);
        top.appendChild(bar);
        const arr = best.next.arrival != null ? best.next.arrival : best.next.departure;
        const l = [];
        if (arr) l.push('Prochain arrêt : ' + b.name + ' à ' + arr.slice(0, 5) + (best.delay != null && Math.abs(best.delay) >= 1 ? ' (' + (best.delay > 0 ? '+' : '') + Math.round(best.delay) + ' min)' : ''));
        if (best.delay != null) l.push(Math.abs(best.delay) < 1.5 ? 'à l’heure' : best.delay > 0 ? 'en retard de ' + Math.round(best.delay) + ' min' : 'en avance de ' + Math.round(-best.delay) + ' min');
        top.appendChild(this._e('small', 'dt-s', l.join(' · ')));
      }
      c.appendChild(top);
      const others = s.candidates.slice(1).filter(x => x.p >= 0.01);
      if (others.length) {
        const ul = this._e('div', 'dt-others');
        others.forEach(x => {
          const r = this._e('div', 'dt-line dt-o');
          r.append(this._badge(x.service), this._e('span', 'dt-n', x.service.name || ''), this._e('span', 'dt-p', Math.round(x.p * 100) + ' %'));
          ul.appendChild(r);
        });
        c.appendChild(ul);
      }
    }
    this.out.replaceChildren(c);
  }

  _injectStyle() {
    if (document.getElementById('dt-style')) return;
    const st = document.createElement('style');
    st.id = 'dt-style';
    st.textContent = `
      .dt-note{margin:1em;text-align:center;color:var(--inactive-color)}
      .dt-card{margin:.9em 1em 0;background:#fff;border-radius:18px;padding:.9em 1.1em;box-shadow:0 2px 8px rgba(17,94,136,.08)}
      .dt-info small{display:block;color:var(--inactive-color);line-height:1.5}
      .dt-h{display:block;margin-bottom:.5em}
      .dt-s{display:block;color:var(--inactive-color);margin-top:.4em;font-size:.82em}
      .dt-btn,.dt-btn:hover{display:block;width:100%;border-radius:14px;padding:.75em;background:var(--accent-color);color:#fff;font-weight:600;margin-top:.7em}
      .dt-sel{width:100%;border:1px solid #d5dde5;border-radius:10px;padding:.5em;background:#fff;font:inherit;color:inherit;min-width:0}
      .dt-row{display:grid;grid-template-columns:1fr 1fr;gap:.5em .6em;margin-top:.6em}
      .dt-f span{display:block;font-size:.78em;color:var(--inactive-color);margin-bottom:.15em}
      .dt-status{display:inline-block;border-radius:999px;padding:.25em .9em;font-weight:700;font-size:.9em}
      .dt-status.wait,.dt-status.off{background:#eceff2;color:#5b6772}
      .dt-status.amb{background:#fff0d1;color:#9a6200}
      .dt-status.prob{background:#e0eefa;color:#115e88}
      .dt-status.lock{background:#dff3e6;color:#1c7a4d}
      .dt-err{margin-top:.5em;color:#b3261e;font-size:.9em}
      .dt-top{margin-top:.8em}
      .dt-line{display:flex;align-items:center;gap:.6em}
      .dt-n{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dt-p{flex:none;font-variant-numeric:tabular-nums;font-weight:700}
      .dt-code{flex:none;background:var(--accent-color);color:#fff;border-radius:999px;padding:.2em .7em;font-weight:600;font-size:.85em}
      .dt-where{margin-top:.6em}
      .dt-prog{height:6px;border-radius:3px;background:#e3e9ee;margin-top:.5em;overflow:hidden}
      .dt-prog i{display:block;height:100%;background:var(--accent-color)}
      .dt-others{margin-top:.8em;padding-top:.6em;border-top:1px solid #eef1f4}
      .dt-o{padding:.2em 0;color:var(--inactive-color);font-size:.9em}
      .dt-out{padding-bottom:1.5em}
    `;
    document.head.appendChild(st);
  }
}

window.DetectContext = DetectContext;
