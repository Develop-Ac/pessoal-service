/* Compara, linha a linha (NF+item+produto+opf), os dados da planilha (file_rows)
   contra os dados ao vivo da OPENQUERY (live_rows), achando onde o VENDEDOR diverge. */
const fs = require('fs');
const path = require('path');
const arr = (x) => (Array.isArray(x) ? x : [x]);
const file = arr(JSON.parse(fs.readFileSync(path.join(__dirname, 'file_rows.json'), 'utf8')));
const live = arr(JSON.parse(fs.readFileSync(path.join(__dirname, 'live_rows.json'), 'utf8')));

const nn = (v) => (v == null || v === '' ? null : Number(v));
const s = (v) => (v == null || v === '' ? null : String(v).trim());
const vazio = (v) => v == null || v === '' || (typeof v === 'string' && v.trim() === '');
const resolve = (os, vitem, vnota) => (vazio(os) || vazio(vitem) ? vnota : vitem);
const key = (r) => `${nn(r.nfs)}|${nn(r.item)}|${nn(r.pro)}|${nn(r.opf)}`;

console.log('file:', file.length, 'live:', live.length);

const fmap = new Map(), lmap = new Map();
for (const r of file) { const k = key(r); (fmap.get(k) ?? fmap.set(k, []).get(k)).push(r); }
for (const r of live) { const k = key(r); (lmap.get(k) ?? lmap.set(k, []).get(k)).push(r); }

// chaves duplicadas (mais de 1 linha por chave) — indício de join multiplicando
const dupF = [...fmap.values()].filter((a) => a.length > 1).length;
const dupL = [...lmap.values()].filter((a) => a.length > 1).length;
console.log('chaves duplicadas — file:', dupF, 'live:', dupL);

const soFile = [...fmap.keys()].filter((k) => !lmap.has(k));
const soLive = [...lmap.keys()].filter((k) => !fmap.has(k));
console.log('chaves só na planilha:', soFile.length, ' só no live:', soLive.length);

// Divergências de VENDEDOR por chave (compara 1ª linha de cada lado)
let diffs = [];
for (const [k, fr] of fmap) {
  const lr = lmap.get(k);
  if (!lr) continue;
  const f = fr[0], l = lr[0];
  const fv = nn(f.vend); // vendedor resolvido pela planilha (coluna AU)
  const lv = resolve(s(l.os), nn(l.vitem), nn(l.vnota));
  if (fv !== lv) {
    diffs.push({
      nfs: nn(f.nfs), item: nn(f.item), pro: nn(f.pro),
      planilha: { vend: fv, os: f.os, vitem: nn(f.vitem), vnota: nn(f.vnota) },
      live: { vend: lv, os: l.os, vitem: nn(l.vitem), vnota: nn(l.vnota) },
      liq: nn(f.liq),
    });
  }
}
console.log('\nDivergências de VENDEDOR (mesma chave):', diffs.length);
for (const d of diffs.slice(0, 20)) console.log(' ', JSON.stringify(d));

// Soma do líquido que migra por par (de -> para)
const mov = new Map();
for (const d of diffs) {
  const kk = `${d.planilha.vend} -> ${d.live.vend}`;
  mov.set(kk, (mov.get(kk) ?? 0) + (d.liq || 0));
}
console.log('\nLíquido que muda de vendedor (planilha -> live):');
for (const [k, v] of [...mov.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 15))
  console.log(`  ${k}: ${v.toFixed(2)}`);
