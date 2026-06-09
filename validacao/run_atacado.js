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

/* ---- Cenário 2: regras novas (abatimento proporcional + média férias mix 2/3) ---- */
console.log('\n=== Cenário 2: ALISSON abatimento R$10.000 / KENEDY 15 dias de férias ===');
const params2 = new Map([
  [163, { rep_codigo: 163, abatimento: 10000, tem_ferias: false, dias_ferias: 0 }],
  [340, { rep_codigo: 340, abatimento: 0, tem_ferias: true, dias_ferias: 15 }],
]);
const res2 = eng.calcularAtacado(celulas, { ...cfg, parametros: params2 });

const ali = res2.vendedores.find((v) => v.rep_codigo === 163);
const ken = res2.vendedores.find((v) => v.rep_codigo === 340);

// ALISSON: já estava na faixa máxima (>180k); abatimento NÃO muda o %, só escala o pago.
const aliEsperado = Math.round(3124.95 * ((197229.02 - 10000) / 197229.02) * 100) / 100;
const aliOk = Math.abs(Math.round(ali.valor_comissao * 100) / 100 - aliEsperado) < 0.02;
console.log(
  `ALISSON  base_real=${ali.base_real.toFixed(2)} fator=${ali.fator_abatimento.toFixed(5)} ` +
  `%mix23=${ali.pct_mix23} comissao=${ali.valor_comissao.toFixed(2)} (esperado ~${aliEsperado}) ${aliOk ? 'OK' : 'XXXX'}`,
);

// KENEDY: total 42.555,56; sem férias %mix23=0,85%; com 15 dias o total p/ faixa dobra
// (≈85k) e o %mix23 sobe p/ 1,0%. Conferimos que a faixa mudou e a comissão subiu.
const kenSubiu = ken.pct_mix23 > 0.0085 && ken.valor_comissao > 509.42;
console.log(
  `KENEDY   total_faixa=${ken.total_faixa.toFixed(2)} %mix23=${ken.pct_mix23} ` +
  `comissao=${ken.valor_comissao.toFixed(2)} (era 509,42; faixa do mix 2/3 subiu) ${kenSubiu ? 'OK' : 'XXXX'}`,
);

const cenario2Ok = aliOk && kenSubiu;
console.log('\nCenário 2:', cenario2Ok ? 'OK ✓' : 'FALHOU ✗');
process.exit(allOk && cenario2Ok ? 0 : 1);
