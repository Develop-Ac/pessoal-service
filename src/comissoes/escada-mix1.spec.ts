// Rodar: npm test  (pretest = nest build; node --experimental-strip-types --test)
// Escada de participação do mix 1 (22/26/30% -> x1,25/x1,50/x2,00) nas duas engines
// do atacado, e o fallback para a regra antiga (binária em 30%) sem escada vigente.
// As engines importam módulos locais sem extensão, que o loader ESM do node não
// resolve; por isso este spec é CommonJS e testa o JS compilado em dist/.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calcularAtacado, multiplicadorMix1, percentualMix1 } = require('../../dist/comissoes/atacado-engine');
const { calcularSupervisorAtacado, pctSupervisorAtacado } = require('../../dist/comissoes/supervisor-atacado-engine');

const ESCADA = [
  { part_min: 0.3, multiplicador: 2 },
  { part_min: 0.22, multiplicador: 1.25 },
  { part_min: 0.26, multiplicador: 1.5 },
];

const FAIXAS_MIX1 = [
  { faixa: 'A', atingiu_meta: false, percentual: 0.04 },
  { faixa: 'B', atingiu_meta: false, percentual: 0.03 },
  { faixa: 'C', atingiu_meta: false, percentual: 0.03 },
  { faixa: 'D', atingiu_meta: false, percentual: 0.02 },
  { faixa: 'A', atingiu_meta: true, percentual: 0.07 },
  { faixa: 'B', atingiu_meta: true, percentual: 0.06 },
  { faixa: 'C', atingiu_meta: true, percentual: 0.05 },
  { faixa: 'D', atingiu_meta: true, percentual: 0.04 },
];

const DEGRAUS = [
  [10, 90, 1],
  [22, 78, 1.25],
  [26, 74, 1.5],
  [30, 70, 2],
];

/** Vendedor `rep` com `mix1` em mix 1 faixa A e `resto` em mix 2 faixa A. */
function celulas(mix1, resto, rep = 1) {
  return [
    { rep_codigo: rep, mix: 1, faixa: 'A', valor_vendido: mix1 },
    { rep_codigo: rep, mix: 2, faixa: 'A', valor_vendido: resto },
  ];
}

function cfg(escadaMix1) {
  return {
    faixasMix23: [{ valor_min: 0, valor_max: 1e12, percentual: 0.01 }],
    faixasMix1: FAIXAS_MIX1,
    metaMix1: 0.3,
    escadaMix1,
    representantes: new Map([[1, { rep_codigo: 1, nome: 'V', inativo: false }]]),
    parametros: new Map(),
    diasCorridos: 30,
  };
}

const quase = (a, b, msg = '') => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} != ${b}`);

test('multiplicadorMix1: maior degrau alcançado; abaixo do 1º ou sem escada = 1', () => {
  assert.equal(multiplicadorMix1(0.1, ESCADA), 1);
  assert.equal(multiplicadorMix1(0.2199, ESCADA), 1);
  assert.equal(multiplicadorMix1(0.22, ESCADA), 1.25);
  assert.equal(multiplicadorMix1(0.259, ESCADA), 1.25);
  assert.equal(multiplicadorMix1(0.26, ESCADA), 1.5);
  assert.equal(multiplicadorMix1(0.3, ESCADA), 2);
  assert.equal(multiplicadorMix1(0.9, ESCADA), 2);
  assert.equal(multiplicadorMix1(0.9, []), 1);
});

test('percentualMix1: com escada usa a base x multiplicador; sem escada, a tabela atingiu', () => {
  quase(percentualMix1('B', true, FAIXAS_MIX1, 1.5), 0.045);
  quase(percentualMix1('A', false, FAIXAS_MIX1, 2), 0.08);
  quase(percentualMix1('D', true, FAIXAS_MIX1), 0.04);
  quase(percentualMix1('D', false, FAIXAS_MIX1), 0.02);
  assert.equal(percentualMix1('X', false, FAIXAS_MIX1, 2), 0);
});

test('vendedor: os 4 degraus da escada', () => {
  for (const [mix1, resto, mult] of DEGRAUS) {
    const v = calcularAtacado(celulas(mix1 * 1000, resto * 1000), cfg(ESCADA)).vendedores[0];
    assert.equal(v.mult_mix1, mult, `mix1 ${mix1}%`);
    assert.equal(v.atingiu_meta, mult > 1);
    // mix 1 faixa A: 4% x mult; mix 2: 1%
    quase(v.comissao_bruta, mix1 * 1000 * 0.04 * mult + resto * 1000 * 0.01, `mix1 ${mix1}%`);
  }
});

test('vendedor sem escada vigente: regra antiga (30% troca a tabela, 4% -> 7%)', () => {
  const abaixo = calcularAtacado(celulas(26_000, 74_000), cfg([])).vendedores[0];
  assert.equal(abaixo.mult_mix1, 1);
  assert.equal(abaixo.atingiu_meta, false);
  quase(abaixo.comissao_bruta, 26_000 * 0.04 + 74_000 * 0.01);
  const atingiu = calcularAtacado(celulas(30_000, 70_000), cfg([])).vendedores[0];
  assert.equal(atingiu.atingiu_meta, true);
  quase(atingiu.comissao_bruta, 30_000 * 0.07 + 70_000 * 0.01);
});

test('pctSupervisorAtacado: base própria x multiplicador; mix 2/3 fixo 0,55%', () => {
  quase(pctSupervisorAtacado(1, 'A', false, 1.25), 0.0125);
  quase(pctSupervisorAtacado(1, 'B', false, 1.5), 0.0129);
  quase(pctSupervisorAtacado(1, 'C', false, 2), 0.0142);
  quase(pctSupervisorAtacado(1, 'D', false, 1), 0.0057);
  quase(pctSupervisorAtacado(2, 'A', true, 2), 0.0055);
  // regra antiga (sem multiplicador): tabela "atingiu" aos 30%
  quase(pctSupervisorAtacado(1, 'A', true), 0.0125);
  quase(pctSupervisorAtacado(1, 'A', false), 0.01);
});

test('supervisor: os 4 degraus sobre o canal inteiro (dois vendedores somados)', () => {
  const rep = { rep_codigo: 316, nome: 'Sup' };
  for (const [mix1, resto, mult] of DEGRAUS) {
    // metade da venda em cada vendedor; a participação é a do canal
    const cels = [...celulas(mix1 * 500, resto * 500, 1), ...celulas(mix1 * 500, resto * 500, 2)];
    const r = calcularSupervisorAtacado(cels, rep, 0.3, undefined, ESCADA).resumo;
    assert.equal(r.mult_mix1, mult, `mix1 ${mix1}%`);
    assert.equal(r.atingiu_meta, mult > 1);
    quase(r.comissao_total, mix1 * 1000 * 0.01 * mult + resto * 1000 * 0.0055, `mix1 ${mix1}%`);
  }
});

test('supervisor sem escada: regra antiga (tabela atingiu 1,25% aos 30%)', () => {
  const rep = { rep_codigo: 316, nome: 'Sup' };
  const r = calcularSupervisorAtacado(celulas(30_000, 70_000), rep).resumo;
  assert.equal(r.mult_mix1, 1);
  assert.equal(r.atingiu_meta, true);
  quase(r.comissao_total, 30_000 * 0.0125 + 70_000 * 0.0055);
  const r2 = calcularSupervisorAtacado(celulas(29_000, 71_000), rep).resumo;
  assert.equal(r2.atingiu_meta, false);
  quase(r2.comissao_total, 29_000 * 0.01 + 71_000 * 0.0055);
});
