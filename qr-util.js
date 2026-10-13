// qr-util.js — générateur de QR code (mode octets, versions 1 à 20, correction M puis L).
// QR.svg(texte) -> chaîne SVG (modules noirs sur fond blanc, marge de 1 module) ou null si trop long.
// Ne produit que des chiffres et des commandes de tracé : aucune donnée n'est injectée telle quelle.

const QR = (() => {
  const ECC_PER_BLOCK = { M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26], L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28] };
  const NUM_BLOCKS = { M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16], L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8] };
  const FORMAT_BITS = { L: 1, M: 0 };

  const rawModules = v => {
    let r = (16 * v + 128) * v + 64;
    if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  };
  const dataCodewords = (v, e) => Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[e][v - 1] * NUM_BLOCKS[e][v - 1];

  // --- Reed-Solomon sur GF(256), polynôme 0x11D
  const gfMul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; };
  const rsDivisor = d => {
    const r = new Array(d).fill(0); r[d - 1] = 1; let root = 1;
    for (let i = 0; i < d; i++) { for (let j = 0; j < d; j++) { r[j] = gfMul(r[j], root); if (j + 1 < d) r[j] ^= r[j + 1]; } root = gfMul(root, 2); }
    return r;
  };
  const rsRemainder = (data, div) => {
    const r = new Array(div.length).fill(0);
    data.forEach(b => { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => { r[i] ^= gfMul(c, f); }); });
    return r;
  };

  function build(bytes, ver, ecl) {
    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
    const bit = (n, i) => ((n >>> i) & 1) !== 0;

    // Motifs de repérage, de synchronisation, d'alignement
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const n = ver === 1 ? 0 : Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6]; for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    pos.forEach((px, i) => pos.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = mask => {
      const data = (FORMAT_BITS[ecl] << 3) | mask; let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
      set(8, 7, bit(bits, 6)); set(8, 8, bit(bits, 7)); set(7, 8, bit(bits, 8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, bit(bits, i)); set(b, a, bit(bits, i));
      }
    }

    // Mots de code : blocs, correction d'erreurs, entrelacement
    const nb = NUM_BLOCKS[ecl][ver - 1], eb = ECC_PER_BLOCK[ecl][ver - 1];
    const raw = Math.floor(rawModules(ver) / 8), shortCount = nb - (raw % nb), shortLen = Math.floor(raw / nb);
    const div = rsDivisor(eb), blocks = []; let k = 0;
    for (let i = 0; i < nb; i++) {
      const dat = bytes.slice(k, k + shortLen - eb + (i < shortCount ? 0 : 1)); k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < shortCount) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const all = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eb || j >= shortCount) all.push(b[i]); });

    // Placement en zigzag
    let idx = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x] && idx < all.length * 8) { mod[y][x] = bit(all[idx >>> 3], 7 - (idx & 7)); idx++; }
      }
    }

    // Masque : on garde celui de moindre pénalité
    const applyMask = m => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const inv = [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, x * y % 2 + x * y % 3 === 0,
          (x * y % 2 + x * y % 3) % 2 === 0, ((x + y) % 2 + x * y % 3) % 2 === 0][m];
        if (!fn[y][x] && inv) mod[y][x] = !mod[y][x];
      }
    };
    const penalty = () => {
      let p = 0;
      const lines = [];
      for (let y = 0; y < size; y++) lines.push(mod[y].map(b => (b ? '1' : '0')).join(''));
      for (let x = 0; x < size; x++) lines.push(mod.map(r => (r[x] ? '1' : '0')).join(''));
      lines.forEach(s => {
        (s.match(/0{5,}|1{5,}/g) || []).forEach(r => { p += r.length - 2; });
        p += 40 * ((s.match(/(?=10111010000)/g) || []).length + (s.match(/(?=00001011101)/g) || []).length);
      });
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
      }
      const dark = mod.reduce((a, r) => a + r.filter(Boolean).length, 0);
      return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    };
    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const p = penalty(); if (p < bestP) { bestP = p; best = m; }
      applyMask(m);   // annule
    }
    applyMask(best); drawFormat(best);
    return mod;
  }

  function matrix(text) {
    const raw = unescape(encodeURIComponent(String(text))), data = Array.from(raw, c => c.charCodeAt(0));
    for (const ecl of ['M', 'L']) for (let ver = 1; ver <= 20; ver++) {
      const cap = dataCodewords(ver, ecl), ccBits = ver < 10 ? 8 : 16;
      if (4 + ccBits + data.length * 8 > cap * 8) continue;
      const bits = [];
      const put = (v, len) => { for (let i = len - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
      put(4, 4); put(data.length, ccBits); data.forEach(b => put(b, 8));
      put(0, Math.min(4, cap * 8 - bits.length));
      while (bits.length % 8) bits.push(0);
      for (let pad = 0xEC; bits.length < cap * 8; pad ^= 0xEC ^ 0x11) put(pad, 8);
      const bytes = []; for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
      return build(bytes, ver, ecl);
    }
    return null;
  }

  function svg(text) {
    const m = matrix(text); if (!m) return null;
    const s = m.length, q = 1;
    let d = '';
    m.forEach((row, y) => { let x = 0; while (x < s) { if (!row[x]) { x++; continue; } let e = x; while (e < s && row[e]) e++; d += 'M' + (x + q) + ' ' + (y + q) + 'h' + (e - x) + 'v1h-' + (e - x) + 'z'; x = e; } });
    const t = s + 2 * q;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + t + ' ' + t + '" shape-rendering="crispEdges">' +
      '<rect width="' + t + '" height="' + t + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }
  return { matrix, svg };
})();

window.QR = QR;
