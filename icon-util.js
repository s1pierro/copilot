// icon-util.js — icônes importées par l'utilisateur (ex. logo d'un réseau).
//
// Stockage : l'image est réduite (128 px max) puis encodée en « data URL » PNG/WebP
// directement dans le JSON de l'objet (champ `icon`). Une seule source de vérité :
// localStorage, sauvegardes, export et import JSON la transportent sans fichier annexe.
// Tout format lisible par le navigateur est accepté (png, jpg, webp, svg…) mais seul un
// raster re-encodé par canvas est conservé : un SVG importé ne peut donc pas embarquer
// de script, et le fichier d'origine n'est jamais stocké.

const NetIcon = {
  SIZE: 128,              // côté maximal en pixels
  MAX_FILE: 8 * 1024 * 1024,
  MAX_CHARS: 90000,       // taille maximale de la data URL acceptée (~65 Ko d'image)

  // Chaîne acceptable : data URL base64 png / jpeg / webp, de taille raisonnable
  isValid(s) {
    return typeof s === 'string' && s.length <= NetIcon.MAX_CHARS &&
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s);
  },

  // Valeur issue d'un JSON non fiable : la chaîne si valide, sinon null
  clean(s) { return NetIcon.isValid(s) ? s : null; },

  // <img> sûr (jamais d'innerHTML avec la donnée)
  mkImg(src, cls) {
    const img = document.createElement('img');
    img.className = cls || '';
    img.alt = '';
    img.decoding = 'async';
    if (NetIcon.isValid(src)) img.src = src;
    return img;
  },

  // Fichier image -> Promise<data URL>. Rejette avec un Error au message lisible.
  fromFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type || '')) return reject(new Error('Ce fichier n’est pas une image.'));
      if (file.size > NetIcon.MAX_FILE) return reject(new Error('Image trop volumineuse (8 Mo maximum).'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        try {
          let w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) { w = h = NetIcon.SIZE; }   // SVG sans dimensions
          const k = Math.min(1, NetIcon.SIZE / Math.max(w, h));
          const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
          // SVG sans taille propre : on le dessine à la taille cible
          const c = document.createElement('canvas');
          c.width = cw; c.height = ch;
          c.getContext('2d').drawImage(img, 0, 0, cw, ch);
          let out = c.toDataURL('image/png');
          if (out.length > NetIcon.MAX_CHARS) out = c.toDataURL('image/webp', 0.85);
          if (!NetIcon.isValid(out)) return reject(new Error('Image trop complexe : choisis une image plus simple.'));
          resolve(out);
        } catch (e) {
          reject(new Error('Image illisible.'));
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible.')); };
      img.src = url;
    });
  }
};

window.NetIcon = NetIcon;
