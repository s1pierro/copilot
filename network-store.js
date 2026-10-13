// network-store.js — réseaux disponibles + réseau actif, sauvegardés en local.
// La démo (buildDemoNetwork) ne sert que de réseau de départ s'il n'y a rien de sauvegardé.

function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

class NetworkStore {
  constructor(bang, key = 'networks') {
    this.bang = bang;
    this.key = key;
    this.networks = [];
    this.activeId = null;
    this.load();
  }

  get active() {
    return this.networks.find(n => n.id === this.activeId) || this.networks[0] || null;
  }

  load() {
    const data = this.bang.loadFromLocal(this.key);
    if (data && data.v === 1 && Array.isArray(data.networks) && data.networks.length) {
      try {
        if (!data.networks.every(n => n && n.id)) throw new Error('réseau sans identifiant');
        this.networks = data.networks.map(Network.fromJSON);
        this.activeId = data.active;
      } catch (e) {
        // Données illisibles : on garde une copie avant tout écrasement
        console.error('❌ Réseaux illisibles, copie conservée :', e);
        this.bang.saveToLocal(this.key + ':backup', data);
        this.networks = [];
      }
    }
    if (!this.networks.length) {
      this.networks = [buildDemoNetwork()];
      this.activeId = this.networks[0].id;
    }
    if (!this.networks.some(n => n.id === this.activeId)) this.activeId = this.networks[0].id;
  }

  save() {
    this.bang.saveToLocal(this.key, {
      v: 1,
      active: this.activeId,
      networks: this.networks.map(n => n.toJSON())
    });
  }

  // Ajoute un réseau et le rend actif (les ajouts suivants s'y rattachent)
  add(net) {
    this.networks.push(net);
    this.activeId = net.id;
    return net;
  }

  setActive(id) {
    if (this.networks.some(n => n.id === id)) this.activeId = id;
  }

  // Arrêts du réseau actif : ceux du réseau + ceux référencés par ses services
  stops() {
    const net = this.active;
    if (!net) return [];
    const map = new Map();
    net.stops.forEach(s => map.set(s.id, s));
    net.services.forEach(sv => sv.stopTimes.forEach(st => {
      if (!map.has(st.stop.id)) map.set(st.stop.id, st.stop);
    }));
    return [...map.values()];
  }
}

window.uid = uid;
window.NetworkStore = NetworkStore;
