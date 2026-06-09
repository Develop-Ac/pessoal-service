/* Validação do engine de ATACADO contra o gabarito (lógica da pergunta 422).
   Lê as células reais (atacado_celulas.json) e roda o engine compilado. */
const fs = require('fs');
const path = require('path');
const eng = require('../dist/comissoes/atacado-engine.js');

const dir = __dirname;
const arr = (x) => (Array.isArray(x) ? x : [x]);
const celulas = arr(JSON.parse(fs.readFileSync(path.join(dir, 'atacado_celulas.json'), 'utf8')))
  .map((r) => ({
    rep_codigo: Number(r.rep_codigo),
    mix: Number(r.mix),
    faixa: String(r.faixa).trim().toUpperCase(),
    valor_vendido: Number(r.valor_vendido),
  }));

// Config = seed do 03_comissoes_atacado.sql (mix23 = tabela DEMAIS; mix1 fixo; meta 30%).
const faixasMix23 = [
  { valor_min: 0, valor_max: 70000, percentual: 0.0085 },
  { valor_min: 70000.01, valor_max: 100000, percentual: 0.01 },
  { valor_min: 100000.01, valor_max: 130000, percentual: 0.011 },
  { valor_min: 130000.01, valor_max: 160000, percentual: 0.0115 },
  { valor_min: 160000.01, valor_max: 180000, percentual: 0.012 },
  { valor_min: 180000.01, valor_max: 999999999999, percentual: 0.013 },
];
const faixasMix1 = [
  { faixa: 'A', atingiu_meta: false, percentual: 0.035 },
  { faixa: 'B', atingiu_meta: false, percentual: 0.03 },
  { faixa: 'C', atingiu_meta: false, percentual: 0.025 },
  { faixa: 'D', atingiu_meta: false, percentual: 0.02 },
  { faixa: 'A', atingiu_meta: true, percentual: 0.07 },
  { faixa: 'B', atingiu_meta: true, percentual: 0.06 },
  { faixa: 'C', atingiu_meta: true, percentual: 0.05 },
  { faixa: 'D', atingiu_meta: true, percentual: 0.04 },
];
const reps = new Map();
for (const c of celulas) {
  if (!reps.has(c.rep_codigo))
    reps.set(c.rep_codigo, { rep_codigo: c.rep_codigo, nome: String(c.rep_codigo), inativo: false });
}

const cfg = {
  faixasMix23,
  faixasMix1,
  metaMix1: 0.3,
  representantes: reps,
  parametros: new Map(),
  diasCorridos: 30,
};

const res = eng.calcularAtacado(celulas, cfg);

// Gabarito (lógica 422 pura, validada via SQL).
const esperado = { 163: 3124.95, 200: 1821.49, 218: 1358.46, 340: 509.42 };

console.log('rep    total_vendido   comissao   esperado   ok');
let allOk = true;
for (const v of res.vendedores) {
  const exp = esperado[v.rep_codigo];
  const got = Math.round(v.valor_comissao * 100) / 100;
  const ok = exp == null ? '-' : Math.abs(got - exp) < 0.01 ? 'OK' : 'XXXX';
  if (exp != null && ok !== 'OK') allOk = false;
  console.log(
    String(v.rep_codigo).padEnd(6),
    v.total_vendido.toFixed(2).padStart(13),
    got.toFixed(2).padStart(10),
    (exp == null ? '-' : exp.toFixed(2)).padStart(10),
    '  ' + ok,
  );
}
console.log('\nRESULTADO:', allOk ? 'TODOS BATEM ✓' : 'DIVERGÊNCIA ✗');
process.exit(allOk ? 0 : 1);
