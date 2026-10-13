// storage-ns.js — isole les données de « Bang Lab » dans localStorage (préfixe « lab: »).
// Chargé en premier : l'appli Bang d'origine, servie sur la même origine, garde ses propres données intactes.
(function () {
  const P = 'lab:', S = Storage.prototype;
  const get = S.getItem, set = S.setItem, rem = S.removeItem, key = S.key, clr = S.clear;
  const lenDesc = Object.getOwnPropertyDescriptor(S, 'length');
  const mine = o => { try { return o === window.localStorage; } catch (e) { return false; } };
  const keys = o => { const out = []; const n = lenDesc.get.call(o); for (let i = 0; i < n; i++) { const k = key.call(o, i); if (k && k.indexOf(P) === 0) out.push(k); } return out; };
  S.getItem = function (k) { return mine(this) ? get.call(this, P + k) : get.call(this, k); };
  S.setItem = function (k, v) { return mine(this) ? set.call(this, P + k, v) : set.call(this, k, v); };
  S.removeItem = function (k) { return mine(this) ? rem.call(this, P + k) : rem.call(this, k); };
  S.key = function (i) { if (!mine(this)) return key.call(this, i); const k = keys(this)[i]; return k === undefined ? null : k.slice(P.length); };
  S.clear = function () { if (!mine(this)) return clr.call(this); keys(this).forEach(k => rem.call(this, k)); };
  Object.defineProperty(S, 'length', { configurable: true, get() { return mine(this) ? keys(this).length : lenDesc.get.call(this); } });
})();
