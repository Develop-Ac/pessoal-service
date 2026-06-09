/* Harness de validação: roda o engine real contra os dados reais (05/2026)
   e compara com a DINAMICA da planilha. */
const fs = require('fs');
const path = require('path');
const eng = require('../dist/comissoes/calculo-engine.js');

const dir = __dirname;
const J = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

// As consultas via Invoke-Sqlcmd devolvem 1 objeto (não array) quando há 1 linha; normaliza.
const arr = (x) => (Array.isArray(x) ? x : [x]);

const vendasRaw = arr(J('vendas.json'));
const servRaw = arr(J('servico.json'));
const osRaw = arr(J('os.json'));
const repsRaw = J('representantes.json');

const n = (v) => (v == null || v === '' ? 0 : Number(v));
const nn = (v) => (v == null || v === '' ? null : Number(v));
const s = (v) => (v == null || v === '' ? null : String(v).trim());

const vendas = vendasRaw.map((r) => ({
  nfs: n(r.NFS), nota_fiscal: null, dt_emissao: null,
  opf_codigo: nn(r.OPF_CODIGO), cli_codigo: nn(r.CLI_CODIGO), cli_nome: null,
  pro_codigo: nn(r.PRO_CODIGO), pro_descricao: null,
  quantidade: n(r.QUANTIDADE), unitario: n(r.UNITARIO),
  desc_produto: n(r.DESC_PRODUTO), valor_descto_nota: n(r.VALOR_DESCTO),
  preco_custo: n(r.PRECO_CUSTO), ordem_servico: s(r.ORDEM_SERVICO),
  vendedor_nota: nn(r.VENDEDOR_NOTA), vendedor_item: nn(r.VENDEDOR_ITEM),
}));

const servicos = servRaw.map((r) => ({
  nfs: n(r.NFS), nota_fiscal: null, dt_emissao: null, cli_codigo: null, cli_nome: null,
  pro_codigo: nn(r.PRO_CODIGO), pro_descricao: null,
  quantidade: n(r.QUANTIDADE), unitario: n(r.UNITARIO),
  desc_produto: n(r.DESC_PRODUTO), valor_descto_nota: n(r.VALOR_DESCTO),
  comissionado_vendedor: nn(r.COMICIONADO_VENDEDOR), comissionado_item: nn(r.COMICIONADO_ITEM),
}));

const os = osRaw.map((r) => ({
  nfs: nn(r.NFS), ordem_servico: nn(r.ORDEM_SERVICO), dt_emissao: null, cli_codigo: null,
  pro_codigo: nn(r.PRO_CODIGO), pro_descricao: null, total: n(r.TOTAL), rep_codigo: nn(r.REP_CODIGO),
}));

const representantes = new Map();
for (const r of repsRaw) representantes.set(r.rep_codigo, r);

const tipoProduto = new Map([
  [13497, 'FRETE'], [46784, 'FRETE'], [4174, 'MAO DE OBRA'],
  [9711, 'PINTURA'], [47777, 'IMPOSTOS'],
]);

const faixas = [
  { tipo_tabela: 'ESPECIAL', valor_min: 0.01, valor_max: 110000, percentual: 0.01 },
  { tipo_tabela: 'ESPECIAL', valor_min: 110000.01, valor_max: 140000, percentual: 0.012 },
  { tipo_tabela: 'ESPECIAL', valor_min: 140000.01, valor_max: 170000, percentual: 0.015 },
  { tipo_tabela: 'ESPECIAL', valor_min: 170000.01, valor_max: 200000, percentual: 0.017 },
  { tipo_tabela: 'ESPECIAL', valor_min: 200000.01, valor_max: 999999999999, percentual: 0.02 },
  { tipo_tabela: 'DEMAIS', valor_min: 0.01, valor_max: 70000, percentual: 0.0085 },
  { tipo_tabela: 'DEMAIS', valor_min: 70000.01, valor_max: 100000, percentual: 0.01 },
  { tipo_tabela: 'DEMAIS', valor_min: 100000.01, valor_max: 130000, percentual: 0.011 },
  { tipo_tabela: 'DEMAIS', valor_min: 130000.01, valor_max: 160000, percentual: 0.0115 },
  { tipo_tabela: 'DEMAIS', valor_min: 160000.01, valor_max: 180000, percentual: 0.012 },
  { tipo_tabela: 'DEMAIS', valor_min: 180000.01, valor_max: 999999999999, percentual: 0.013 },
];

// Parâmetros manuais da DINAMICA 05/2026.
const parametros = new Map();
const setP = (cod, abat, bonus, dias) =>
  parametros.set(cod, { rep_codigo: cod, abatimento: abat || 0, tem_ferias: !!dias, dias_ferias: dias || 0, pct_bonus: bonus || 0 });
setP(326, 400, 0, 0); // EDILSOM abatimento 400
setP(273, 0, 0.0075); setP(76, 0, 0.0075); setP(314, 0, 0.0075); setP(249, 0, 0);
setP(328, 0, 0.0075); setP(332, 0, 0.0075); setP(333, 0, 0.0045); setP(338, 0, 0.0075);
setP(99999, 400, 0); // supervisor abatimento 400

const cfg = { tipoProduto, faixas, representantes, parametros, diasCorridos: 30 };
const res = eng.calcular(vendas, servicos, os, cfg);

const f2 = (x) => (x == null ? '' : Number(x).toFixed(2));
const f4 = (x) => (x == null ? '' : Number(x).toFixed(4));

console.log('\n===== VENDEDORES (engine) =====');
console.log('cod  nome                 vendas       devol      mao      baseGeral     %       comissao');
for (const v of res.vendedores) {
  console.log(
    String(v.rep_codigo).padEnd(5),
    (v.nome || '').slice(0, 18).padEnd(18),
    f2(v.vendas).padStart(12), f2(v.devolucao).padStart(10), f2(v.mao_obra).padStart(8),
    f2(v.base_geral).padStart(12), f4(v.percentual).padStart(7), f2(v.valor_comissao).padStart(10),
  );
}
console.log('TOTAL comissão vendedores:', f2(res.vendedores.reduce((s, v) => s + v.valor_comissao, 0)));

console.log('\n===== TÉCNICOS (engine) =====');
console.log('cod   nome                       valorBase     %       comissao   %bonus   bonus     total');
for (const t of res.tecnicos) {
  console.log(
    String(t.rep_codigo == null ? '-' : t.rep_codigo).padEnd(5),
    (t.nome || '').slice(0, 24).padEnd(24),
    f2(t.valor_base).padStart(12), f4(t.percentual).padStart(7), f2(t.valor_comissao).padStart(10),
    f4(t.pct_bonus).padStart(7), f2(t.valor_bonus).padStart(9), f2(t.total).padStart(10),
    t.is_supervisor ? 'SUPERV' : '',
  );
}
const tecReais = res.tecnicos.filter((t) => t.rep_codigo != null && !t.is_supervisor);
console.log('TOTAL comissão técnicos (s/ superv):', f2(tecReais.reduce((s, t) => s + t.valor_comissao, 0)));
console.log('TOTAL bônus técnicos:', f2(tecReais.reduce((s, t) => s + t.valor_bonus, 0)));

// Controle de líquido total (compara com a planilha: TP2=1445585.09 DESC=113259.69 LIQ=1282099.27)
let tp2 = 0, desc = 0, liq = 0;
for (const v of res.vendasCalculadas) { tp2 += v.total_produtos2; desc += v.total_desconto; liq += v.liquido; }
console.log('\n===== CONTROLE VENDAS =====');
console.log('linhas:', res.vendasCalculadas.length, 'TP2:', f2(tp2), 'DESC:', f2(desc), 'LIQ:', f2(liq));
console.log('(planilha salva: linhas~4524 TP2=1445585.09 DESC=113259.69 LIQ=1282099.27)');
