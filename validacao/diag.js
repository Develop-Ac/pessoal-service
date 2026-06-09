/* Diagnóstico: roda calcularVendas sobre os dados SALVOS no arquivo e compara
   linha-a-linha o VENDEDOR/TIPO/LÍQUIDO contra o que a planilha computou. */
const fs = require('fs');
const path = require('path');
const eng = require('../dist/comissoes/calculo-engine.js');

const rowsRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendas_file.json'), 'utf8'));
const n = (v) => (v == null || v === '' ? 0 : Number(v));
const nn = (v) => (v == null || v === '' ? null : Number(v));
const s = (v) => (v == null || v === '' ? null : String(v).trim());

const vendas = rowsRaw.map((r) => ({
  nfs: n(r.NFS), nota_fiscal: null, dt_emissao: null,
  opf_codigo: nn(r.OPF_CODIGO), cli_codigo: nn(r.CLI_CODIGO), cli_nome: null,
  pro_codigo: nn(r.PRO_CODIGO), pro_descricao: null,
  quantidade: n(r.QUANTIDADE), unitario: n(r.UNITARIO),
  desc_produto: n(r.DESC_PRODUTO), valor_descto_nota: n(r.VALOR_DESCTO),
  preco_custo: n(r.PRECO_CUSTO), ordem_servico: s(r.ORDEM_SERVICO),
  vendedor_nota: nn(r.VENDEDOR_NOTA), vendedor_item: nn(r.VENDEDOR_ITEM),
}));

const tipoProduto = new Map([
  [13497, 'FRETE'], [46784, 'FRETE'], [4174, 'MAO DE OBRA'],
  [9711, 'PINTURA'], [47777, 'IMPOSTOS'],
]);

const vc = eng.calcularVendas(vendas, tipoProduto);

let mismVend = 0, mismTipo = 0, mismLiq = 0;
const exemplosV = [];
for (let i = 0; i < vc.length; i++) {
  const sheetVend = nn(rowsRaw[i]._VENDEDOR);
  const sheetTipo = s(rowsRaw[i]._TIPO);
  const sheetLiq = n(rowsRaw[i]._LIQUIDO);
  if ((vc[i].vendedor ?? null) !== (sheetVend ?? null)) {
    mismVend++;
    if (exemplosV.length < 8) exemplosV.push({
      nfs: vc[i].nfs, pro: vc[i].pro_codigo, os: rowsRaw[i].ORDEM_SERVICO,
      vNota: rowsRaw[i].VENDEDOR_NOTA, vItem: rowsRaw[i].VENDEDOR_ITEM,
      engine: vc[i].vendedor, planilha: sheetVend,
    });
  }
  if ((vc[i].tipo || '') !== (sheetTipo || '')) mismTipo++;
  if (Math.abs(vc[i].liquido - sheetLiq) > 0.01) mismLiq++;
}

console.log('Linhas:', vc.length);
console.log('Divergências VENDEDOR:', mismVend);
console.log('Divergências TIPO    :', mismTipo);
console.log('Divergências LÍQUIDO :', mismLiq);
if (exemplosV.length) {
  console.log('\nExemplos de divergência de VENDEDOR:');
  for (const e of exemplosV) console.log(' ', JSON.stringify(e));
}

// Agregação por vendedor (TIPO=VENDAS) — comparar com DINAMICA do arquivo.
const porVend = new Map();
for (const v of vc) {
  if (v.vendedor == null) continue;
  if (v.tipo !== 'VENDAS') continue;
  porVend.set(v.vendedor, (porVend.get(v.vendedor) ?? 0) + v.liquido);
}
console.log('\nVENDAS por vendedor (engine, sobre dados do arquivo):');
for (const cod of [164, 326, 339, 342, 341]) {
  console.log(`  cod ${cod}: ${(porVend.get(cod) ?? 0).toFixed(2)}`);
}
console.log('  (DINAMICA do arquivo: 164=228395.54 326=182155.97 339=160307.40 342=113959.28 341=102192.47)');
