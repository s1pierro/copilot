// ctx-feed.js — contexte "Feed" (superposé, ouvert depuis Compte) :
// résumé des données locales. Chaque tuile ouvre une page dédiée (ctx-feed-pages.js).

// --- Helpers partagés par Feed et ses pages --------------------------------

const fdPlural = (n, word, plural = word + 's') => n + ' ' + (n > 1 ? plural : word);

// Icônes (contenu SVG) des entrées « Données » et des pages Exporter / Importer
const fdIcons = {
  export: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 14v5h14v-5"/>',
  import: '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 14v5h14v-5"/>'
};

// Nombre de services par fournisseur (service.provider = objet ou id)
function fdProviderCounts(net) {
  const counts = new Map();
  ((net && net.services) || []).forEach(s => {
    const pid = s.provider && typeof s.provider === 'object' ? s.provider.id : s.provider;
    counts.set(pid, (counts.get(pid) || 0) + 1);
  });
  return counts;
}

// Barre collante en haut : retour (←) optionnel à gauche, fermeture (×) à droite
function fdMkBar(bang, { back = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'fd-bar';
  if (back) {
    const b = document.createElement('button');
    b.className = 'fd-bar-btn fd-back';
    b.setAttribute('aria-label', 'Retour');
    b.innerHTML = uiSvg('<path d="M15 5l-7 7 7 7"/>');
    b.addEventListener('click', () => bang.contexts.back());
    wrap.appendChild(b);
  }
  if (bang.lab && !back) return wrap;   // Bang Lab : la page racine est un onglet, rien à fermer
  const c = document.createElement('button');
  c.className = 'fd-bar-btn fd-close';
  c.setAttribute('aria-label', 'Fermer');
  c.innerHTML = uiSvg('<path d="M6 6l12 12M18 6L6 18"/>');
  c.addEventListener('click', () => bang.contexts.closeOverlay());
  wrap.appendChild(c);
  return wrap;
}

function fdInjectStyle() {
  if (document.getElementById('fd-style')) return;
  const st = document.createElement('style');
  st.id = 'fd-style';
  st.textContent = `
    .fd-bar{position:sticky;top:0;height:0;z-index:4}
    .fd-bar .fd-bar-btn{position:absolute;top:calc(env(safe-area-inset-top,0px) + .7em);
      width:2.4em;height:2.4em;padding:0;border-radius:50%;background:var(--accent-color);
      color:#fff;display:flex;align-items:center;justify-content:center;
      box-shadow:0 0 0 2px rgba(255,255,255,.7)}
    .fd-bar .fd-close{right:.8em}
    .fd-bar .fd-back{left:.8em}
    .fd-bar-btn svg{width:1.2em;height:1.2em}
    .fd-title{padding:.2em 1em 0;text-align:center}
    .fd-title h2{margin:0;color:var(--accent-color)}
    .fd-title small{color:var(--inactive-color)}
    .fd-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:.6em;margin:.9em 1em 0}
    .fd-stat{background:#fff;border-radius:14px;padding:.9em .3em;text-align:center;
      cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}
    .fd-stat:active{background:#f2f2f2}
    .fd-stat:last-child:nth-child(odd){grid-column:1/-1}
    .fd-stat b{display:block;font-size:1.6em;color:var(--accent-color)}
    .fd-stat span{font-size:.8em;color:var(--inactive-color)}
    .fd-h{margin:1.3em 1em .4em;font-size:.8em;letter-spacing:.05em;
      text-transform:uppercase;color:var(--inactive-color)}
    .fd-card{margin:0 1em 1em;background:#fff;border-radius:14px;overflow:hidden}
    .fd-row{display:flex;justify-content:space-between;align-items:center;gap:1em;
      padding:.9em 1em;border-top:1px solid #eee}
    .fd-row:first-child{border-top:0}
    .fd-row small{color:var(--inactive-color)}
    .fd-col span,.fd-col small{display:block}
    .fd-main{flex:1;min-width:0;display:flex;justify-content:space-between;
      align-items:center;gap:1em}
    .fd-tap{cursor:pointer;-webkit-tap-highlight-color:transparent}
    .fd-row:has(.fd-tap:active){background:#f2f2f2}
    .fd-row .fd-edit,.fd-row .fd-edit:hover{width:2.2em;height:2.2em;padding:0;flex:none;
      border-radius:50%;background:none;color:var(--inactive-color);
      display:flex;align-items:center;justify-content:center}
    .fd-edit svg{width:1.15em;height:1.15em}
    .fd-row .fd-link,.fd-row .fd-link:hover{background:none;color:var(--accent-color);
      padding:.6em 0 .2em;border-radius:0;font-size:.85em;text-align:left}
    .fd-links{display:flex;flex-wrap:wrap;gap:0 1.4em}
    .fd-svc{--c:var(--accent-color);margin:0 1em .8em;background:#fff;border-radius:22px;padding:1em 1.1em .3em;
      box-shadow:0 2px 8px rgba(0,0,0,.07)}
    .fd-svc-head{display:flex;align-items:center;gap:.8em}
    .fd-svc-left{display:flex;align-items:center;gap:.6em;flex:none}
    .fd-svc-medal{flex:none;width:2.6em;height:2.6em;border-radius:50%;display:flex;align-items:center;justify-content:center;
      color:#000;background:#eef1f5}
    .fd-svc-pic{width:1.5em;height:1.5em}
    .fd-svc-code{flex:none;background:var(--c);color:var(--ct,#fff);box-shadow:0 0 0 var(--cbw,0) var(--cb,transparent);
      border-radius:999px;padding:.35em .9em;font-weight:600;font-size:1.05em;line-height:1.2}
    .fd-svc-txt{flex:1;min-width:0;font-size:.8em;line-height:1.35}
    .fd-svc-txt span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .fd-svc-name{color:var(--text-color);font-weight:600}
    .fd-svc-txt .fd-svc-when{color:var(--inactive-color);white-space:normal}
    .fd-svc .fd-edit,.fd-svc .fd-edit:hover{width:2.2em;height:2.2em;padding:0;flex:none;border-radius:50%;background:none;
      color:var(--inactive-color);display:flex;align-items:center;justify-content:center}
    .fd-svc-trace{margin-top:.55em;font-size:.74em;color:var(--inactive-color)}
    .fd-svc-trace.err{color:#c0392b}
    .fd-link:disabled{opacity:.5}
    .fd-svc-links{margin-top:.7em;border-top:1px solid #eee;gap:0 1.4em}
    .fd-svc .fd-link,.fd-svc .fd-link:hover{display:inline-flex;align-items:center;gap:.4em;background:none;color:var(--accent-color);
      padding:.55em 0;border-radius:0;font-size:.74em;font-weight:600;text-align:left}
    .fd-ic{display:inline-block;width:1.25em;height:1.25em;flex:none;background:currentColor;
      -webkit-mask:var(--pic) center/contain no-repeat;mask:var(--pic) center/contain no-repeat}
    .fd-svc .fd-del,.fd-svc .fd-del:hover{color:#b3261e;opacity:.8}
    .fd-svc .fd-del.armed{opacity:1;font-weight:bold}
    .fd-row .fd-del,.fd-row .fd-del:hover{color:#b3261e;opacity:.75}
    .fd-row .fd-del.armed{opacity:1;font-weight:bold}
    .fd-ico{width:2.4em;height:2.4em;flex:none;object-fit:contain;border-radius:8px;background:#fff}
    .fd-main .fd-col{flex:1;min-width:0}
    .fd-title .fd-ico{display:block;margin:.2em auto .4em;width:3.6em;height:3.6em}
    .fd-ok{width:20px;height:20px;flex:none;color:var(--accent-color)}
    .fd-nav{justify-content:flex-start;cursor:pointer;user-select:none;
      -webkit-tap-highlight-color:transparent}
    .fd-nav:active{background:#f2f2f2}
    .fd-nav .fd-col{flex:1;min-width:0}
    .fd-nav .fd-nav-ic{width:24px;height:24px;flex:none;color:var(--accent-color)}
    .fd-nav .fd-chev{width:18px;height:18px;flex:none;color:var(--inactive-color)}
    .fd-actions{display:flex;flex-direction:column;gap:.6em;margin:1em}
    .fd-actions .fd-btn,.fd-actions .fd-btn:hover{display:flex;align-items:center;
      justify-content:center;gap:.5em;padding:.9em 1em;border-radius:12px;
      background:var(--accent-color);color:#fff;font-size:1em}
    .fd-btn svg{width:1.25em;height:1.25em}
  `;
  document.head.appendChild(st);
}

// --- Contexte Feed ----------------------------------------------------------

class FeedContext extends Context {
  build(el) {
    fdInjectStyle();
    el.append(fdMkBar(this.bang), mkWaveHeader(uiSvg(
      '<path d="M5 5a14 14 0 0 1 14 14"/><path d="M5 11a8 8 0 0 1 8 8"/><circle cx="6" cy="18" r="1.2"/>')));
    this.body = document.createElement('div');
    el.appendChild(this.body);
    this.refresh();
  }

  // Les données ont pu changer dans une page (ou pendant l'absence du contexte)
  onShow() { if (this.built) this.refresh(); }

  refresh() {
    const net = this.bang.network;
    const providers = (net && net.providers) || [];
    const services = (net && net.services) || [];

    this.body.replaceChildren(
      this._mkTitle(net),
      this._mkStats([
        ['networks', 'Réseau', 'Réseaux', this.bang.store.networks.length],
        ['providers', 'Fournisseur', 'Fournisseurs', providers.length],
        ['services', 'Service', 'Services', services.length],
        ['lines', 'Ligne', 'Lignes', net ? net.lines().length : 0],
        ['stops', 'Arrêt', 'Arrêts', this.bang.getStops().length],
        ['zones', 'Zone', 'Zones', ((net && net.zones) || []).length],
        ['tariffs', 'Tarification', 'Tarifications', ((net && net.tariffs) || []).length],
        ['calendar', 'Calendrier', 'Calendrier', net ? net.calendar.ranges.length + net.calendar.holidays.length : 0],
        ['detect', 'Segment', 'Segments', net ? new Set(net.services.flatMap(sv => sv.stopTimes.slice(1).map((t, i) => sv.stopTimes[i].stop.id + '>' + t.stop.id))).size : 0],
        ['emissions', 'Facteur CO₂', 'Facteurs CO₂', SERVICE_MODES.length]
      ]),
      this._mkH('Fournisseurs'),
      this._mkProviders(providers, fdProviderCounts(net)),
      this._mkH('Données'),
      this._mkDataEntries()
    );
  }

  _mkTitle(net) {
    const d = document.createElement('div');
    d.className = 'fd-title';
    if (net && net.icon) d.appendChild(NetIcon.mkImg(net.icon, 'fd-ico'));
    const h = document.createElement('h2');
    h.textContent = (net && net.name) || 'Données locales';
    d.appendChild(h);
    if (net && net.region) {
      const small = document.createElement('small');
      small.textContent = net.region;
      d.appendChild(small);
    }
    return d;
  }

  // Tuiles interactives : chacune ouvre sa page dédiée
  _mkStats(tiles) {
    const grid = document.createElement('div');
    grid.className = 'fd-stats';
    tiles.forEach(([key, one, many, n]) => {
      const t = document.createElement('div');
      t.className = 'fd-stat';
      t.setAttribute('role', 'button');
      t.tabIndex = 0;
      const b = document.createElement('b');
      b.textContent = n;
      const s = document.createElement('span');
      s.textContent = n > 1 ? many : one;
      t.append(b, s);
      const go = () => this.bang.contexts.open('feed-' + key);
      t.addEventListener('click', go);
      t.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      grid.appendChild(t);
    });
    return grid;
  }

  _mkH(text) {
    const h = document.createElement('div');
    h.className = 'fd-h';
    h.textContent = text;
    return h;
  }

  // Entrées « Exporter » et « Importer » : chacune ouvre sa page dédiée
  _mkDataEntries() {
    const card = document.createElement('div');
    card.className = 'fd-card';
    [['export', 'Exporter les données', 'Enregistrer en JSON'],
     ['import', 'Importer des données', 'Depuis un fichier ou du texte JSON']].forEach(([key, title, sub]) => {
      const row = document.createElement('div');
      row.className = 'fd-row fd-nav';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.innerHTML = uiSvg(fdIcons[key], 'fd-nav-ic');
      const col = document.createElement('div');
      col.className = 'fd-col';
      const t = document.createElement('span');
      t.textContent = title;
      const s = document.createElement('small');
      s.textContent = sub;
      col.append(t, s);
      row.appendChild(col);
      row.insertAdjacentHTML('beforeend', uiSvg('<path d="M9 5l7 7-7 7"/>', 'fd-chev'));
      const go = () => this.bang.contexts.open('feed-' + key);
      row.addEventListener('click', go);
      row.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      card.appendChild(row);
    });
    return card;
  }

  _mkProviders(providers, counts) {
    const card = document.createElement('div');
    card.className = 'fd-card';
    if (!providers.length) {
      const empty = document.createElement('div');
      empty.className = 'fd-row';
      empty.textContent = 'Aucun fournisseur';
      card.appendChild(empty);
      return card;
    }
    providers.forEach(p => {
      const row = document.createElement('div');
      row.className = 'fd-row';
      const name = document.createElement('span');
      name.textContent = p.name;
      const small = document.createElement('small');
      small.textContent = fdPlural(counts.get(p.id) || 0, 'service');
      row.append(name, small);
      card.appendChild(row);
    });
    return card;
  }
}

window.FeedContext = FeedContext;
