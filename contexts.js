// contexts.js — contextes d'exécution : un élément DOM dédié par onglet.
// Approche conservatrice : l'état de chaque contexte est restauré au démarrage
// et sauvegardé (clé "ctx:<id>") via bang.saveToLocal / bang.loadFromLocal.

class Context {
  constructor(bang, id) {
    this.bang = bang;
    this.id = id;
    this.el = null;
    this.built = false;
    this.state = null;
    this._saveTimer = null;
    this._leaveTimer = null;
    this.overlay = false;   // true : contexte superposé (ex. Feed), hors barre d'onglets
  }

  get version() { return 1; }          // à incrémenter si le format de l'état change
  get key() { return 'ctx:' + this.id; }
  defaultState() { return {}; }

  // À surcharger : construit le contenu du contexte dans `el`
  build(el) {}
  onShow() {}
  onHide() {}

  mount(host) {
    this.el = document.createElement('section');
    this.el.className = 'ctx';
    this.el.id = 'ctx-' + this.id;
    this.el.inert = true;
    if (this.overlay) this.el.classList.add('ctx-overlay');
    host.appendChild(this.el);
  }

  // Construction paresseuse + restauration de l'état
  ensureBuilt() {
    if (this.built) return;
    const saved = this.bang.loadFromLocal(this.key);
    this.state = (saved && saved.v === this.version)
      ? { ...this.defaultState(), ...saved, v: this.version }
      : { ...this.defaultState(), v: this.version };
    this.build(this.el);
    this.built = true;
  }

  // Sauvegarde différée (évite d'écrire à chaque frappe)
  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 300);
  }
  flush() {
    if (!this.built) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this.bang.saveToLocal(this.key, this.state);
  }

  // La nouvelle vue apparaît immédiatement (sous la vue qui s'efface)
  reveal() {
    clearTimeout(this._leaveTimer);
    this.el.classList.remove('ctx-leaving');
    this.el.classList.add('ctx-active');
    this.el.inert = false;
    this.onShow();
  }

  // La vue active s'efface en fondu par-dessus
  leave() {
    this.el.inert = true;
    this.el.classList.remove('ctx-active');
    this.el.classList.add('ctx-leaving');
    clearTimeout(this._leaveTimer);
    this._leaveTimer = setTimeout(() => {
      this.el.classList.remove('ctx-leaving');
      this.onHide();
    }, 200);
  }
}

class ContextManager {
  constructor(bang, host) {
    this.bang = bang;
    this.host = host;
    this.map = {};
    this.active = null;
    this.overlays = [];     // pile des contextes superposés ouverts (le dernier est au-dessus)
    this._injectStyle();
    // Android peut tuer la PWA en arrière-plan : on écrit tout de suite
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushAll();
    });
    window.addEventListener('pagehide', () => this.flushAll());
  }

  register(ctx, opts = {}) {
    ctx.overlay = !!opts.overlay;
    ctx.mount(this.host);
    this.map[ctx.id] = ctx;
    return ctx;
  }

  show(id) {
    const next = this.map[id];
    if (!next || next.overlay) return;
    this.closeOverlay();
    if (next === this.active) return;
    const prev = this.active;
    next.ensureBuilt();
    next.reveal();
    if (prev) prev.leave();
    this.active = next;
  }

  // Ouvre un contexte superposé : il apparaît tout de suite par-dessus la pile actuelle
  open(id) {
    const ctx = this.map[id];
    if (!ctx || !ctx.overlay || this.overlays.includes(ctx)) return;
    ctx.ensureBuilt();
    ctx.el.style.zIndex = 3 + this.overlays.length;
    ctx.reveal();
    this.overlays.push(ctx);
    this._syncInert();
  }

  // Retire le contexte superposé du dessus (fondu) ; celui du dessous est notifié (onShow)
  back() { this._pop(true); }

  // Ferme tous les contextes superposés
  closeOverlay() {
    while (this.overlays.length) this._pop(false);
  }

  _pop(notify) {
    const top = this.overlays.pop();
    if (!top) return;
    top.leave();
    this._syncInert();
    const under = this.overlays[this.overlays.length - 1];
    if (notify && under) under.onShow();
  }

  // Seul l'élément du dessus reçoit focus et clics
  _syncInert() {
    this.overlays.forEach((c, i) => { c.el.inert = i < this.overlays.length - 1; });
    if (this.active) this.active.el.inert = this.overlays.length > 0;
  }

  flushAll() {
    Object.values(this.map).forEach(c => c.flush());
  }

  _injectStyle() {
    if (document.getElementById('ctx-style')) return;
    const st = document.createElement('style');
    st.id = 'ctx-style';
    st.textContent = `
      .ui-pic{display:inline-block;width:1.4em;height:1.4em;flex:none;background:currentColor;
        -webkit-mask:var(--pic) center/contain no-repeat;mask:var(--pic) center/contain no-repeat}
      #app-content{position:relative;padding:0;overflow:hidden}
      .ctx{position:absolute;inset:0;overflow-y:auto;box-sizing:border-box;
        background:var(--background-color);visibility:hidden;opacity:0;
        -webkit-overflow-scrolling:touch}
      .ctx-active{visibility:visible;opacity:1;z-index:1}
      .ctx-leaving{visibility:visible;opacity:0;z-index:2;pointer-events:none;
        transition:opacity .18s ease-out}
      .ctx-overlay.ctx-active,.ctx-overlay.ctx-leaving{z-index:3}
      @media (prefers-reduced-motion:reduce){.ctx-leaving{transition:none}}
      /* En-tête commun : aplat + icône centrale + vague */
      .ui-head{background:var(--accent-color);display:flex;justify-content:center;
        padding:calc(env(safe-area-inset-top,0px) + 2.2em) 1em 1em}
      .ui-avatar{width:92px;height:92px;border-radius:50%;color:#fff;
        background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center}
      .ui-avatar svg{width:52px;height:52px}
      .ui-avatar-main{width:128px;height:128px;background:none;border-radius:0}   /* pictogramme principal : ni badge ni marge, plein */
      .ui-avatar .ui-main{width:100%;height:100%}
      .ui-wave{display:block;width:100%;height:auto;aspect-ratio:400/${WAVE_H};margin-top:-1px;fill:var(--accent-color)}
    `;
    document.head.appendChild(st);
  }
}

// Vague de l'en-tête : une courbe lisse, calculée automatiquement, qui passe par trois points
// A (bord gauche), B (le creux) et C (bord droit), dans une zone de 400 de large étirée sur l'écran.
// La forme pleine est celle de l'en-tête : bord haut droit, bord bas = la courbe A → B → C.
// Pour modifier la vague, déplace seulement ces trois points [x, y] (y vers le bas) :
const WAVE_A = [0, 44];     // bord gauche
const WAVE_B = [155, 81];   // creux
const WAVE_C = [400, 56];   // bord droit

// Courbe de Bézier cubique passant exactement par A, B et C (spline de Catmull-Rom convertie en
// Béziers : tangente en B = (C − A) / 2, tangentes d'extrémité = segment voisin).
// Renvoie le tracé de la forme pleine et sa hauteur (point le plus bas de la courbe, arrondi).
function waveCurve(A, B, C) {
  const W = C[0];
  const tA = [B[0] - A[0], B[1] - A[1]];
  const tB = [(C[0] - A[0]) / 2, (C[1] - A[1]) / 2];
  const tC = [C[0] - B[0], C[1] - B[1]];
  const r = n => Math.round(n * 100) / 100;
  // Segment A→B puis B→C : points de contrôle c1 = P + T/3, c2 = Q − T'/3
  const ab = [[A[0] + tA[0] / 3, A[1] + tA[1] / 3], [B[0] - tB[0] / 3, B[1] - tB[1] / 3]];
  const bc = [[B[0] + tB[0] / 3, B[1] + tB[1] / 3], [C[0] - tC[0] / 3, C[1] - tC[1] / 3]];
  // On dessine de C vers A (le haut de la forme est déjà tracé de gauche à droite)
  const d = `M${A[0]} 0H${W}V${C[1]}C${r(bc[1][0])} ${r(bc[1][1])} ${r(bc[0][0])} ${r(bc[0][1])} ${B[0]} ${B[1]}` +
    `C${r(ab[1][0])} ${r(ab[1][1])} ${r(ab[0][0])} ${r(ab[0][1])} ${A[0]} ${A[1]}Z`;
  // Hauteur = plus grand y atteint par la courbe (échantillonnage)
  const bez = (p0, c1, c2, p3, u) => {
    const v = 1 - u;
    return v * v * v * p0[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * p3[1];
  };
  let maxY = Math.max(A[1], B[1], C[1]);
  for (let i = 0; i <= 50; i++) {
    maxY = Math.max(maxY, bez(A, ab[0], ab[1], B, i / 50), bez(B, bc[0], bc[1], C, i / 50));
  }
  return { d, h: Math.ceil(maxY) + 1 };
}
const WAVE = waveCurve(WAVE_A, WAVE_B, WAVE_C);
const WAVE_H = WAVE.h;
const WAVE_PATH = WAVE.d;

// Icône SVG en chaîne (contour, couleur héritée)
function uiSvg(inner, cls) {
  return `<svg ${cls ? `class="${cls}" ` : ''}xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
    stroke-linejoin="round">${inner}</svg>`;
}

// Pictogramme de véhicule (pictos/<mode>.svg), teinté par la couleur du texte courant
function uiPicto(mode, cls) {
  const m = typeof serviceMode === 'function' ? serviceMode(mode) : 'bus';   // liste fermée : jamais de chemin libre
  const n = document.createElement('span');
  n.className = 'ui-pic' + (cls ? ' ' + cls : '');
  n.style.setProperty('--pic', 'url("pictos/' + m + '.svg")');
  n.setAttribute('aria-hidden', 'true');
  return n;
}

// En-tête commun : aplat uni, icône centrale, bordure inférieure en vague
// main = true : l'icône est le pictogramme principal de l'application (pictos/mainpicto.svg, teinté en blanc) ;
// `iconSvg` sert de repli si le fichier est introuvable.
function mkWaveHeader(iconSvg, main = false) {
  const head = document.createElement('div');
  head.className = 'ui-head';
  const av = document.createElement('div');
  av.className = 'ui-avatar';
  if (main) {
    const pic = document.createElement('span');
    av.classList.add('ui-avatar-main');
    pic.className = 'ui-pic ui-main';
    pic.style.setProperty('--pic', 'url("pictos/mainpicto.svg")');
    pic.setAttribute('aria-hidden', 'true');
    av.appendChild(pic);
    const probe = new Image();
    probe.addEventListener('error', () => { av.classList.remove('ui-avatar-main'); av.innerHTML = iconSvg; });   // fichier absent : icône de repli
    probe.src = 'pictos/mainpicto.svg';
  } else av.innerHTML = iconSvg;
  head.appendChild(av);

  const holder = document.createElement('div');
  holder.innerHTML = `<svg class="ui-wave" viewBox="0 0 400 ${WAVE_H}" preserveAspectRatio="none"
    xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="${WAVE_PATH}"/></svg>`;

  const frag = document.createDocumentFragment();
  frag.append(head, holder.firstElementChild);
  return frag;
}

// Contexte provisoire pour les onglets pas encore développés
class PlaceholderContext extends Context {
  build(el) {
    const h = document.createElement('h2');
    h.textContent = this.id.charAt(0).toUpperCase() + this.id.slice(1);
    h.style.cssText = 'margin:0;padding:1.2em 1em;color:var(--accent-color)';
    el.appendChild(h);
  }
}

window.Context = Context;
window.ContextManager = ContextManager;
window.PlaceholderContext = PlaceholderContext;
window.mkWaveHeader = mkWaveHeader;
window.uiSvg = uiSvg;
window.uiPicto = uiPicto;
