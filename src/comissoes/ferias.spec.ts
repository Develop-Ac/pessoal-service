// Rodar: npm test  (pretest = nest build; node --experimental-strip-types --test)
// Férias por representante recortadas ao mês comissional (26 a 25). CommonJS sobre
// dist/ pelo mesmo motivo do escada-mix1.spec.ts (imports locais sem extensão).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { feriasNoPeriodo, camposFerias } = require('../../dist/comissoes/ferias');

// mês comissional nov/26
const INI = '2026-10-26';
const FIM = '2026-11-25';

test('janela que atravessa a virada: só os dias dentro do mês contam', () => {
  // 20/10 a 10/11: em out/26 (26/09–25/10) ficam 6 dias; em nov/26 ficam 16
  const rows = [{ rep_codigo: 164, ferias_inicio: '2026-10-20', ferias_fim: '2026-11-10' }];
  const nov = feriasNoPeriodo(rows, INI, FIM).get(164);
  assert.deepEqual(nov, { inicio: '2026-10-26', fim: '2026-11-10', dias: 16, janela_inicio: '2026-10-20', janela_fim: '2026-11-10' });
  const out = feriasNoPeriodo(rows, '2026-09-26', '2026-10-25').get(164);
  assert.equal(out.dias, 6);
  assert.equal(out.inicio, '2026-10-20');
  assert.equal(out.fim, '2026-10-25');
});

test('janela fora do período é ignorada; janela inteira dentro conta cheia', () => {
  const rows = [
    { rep_codigo: 1, ferias_inicio: '2026-09-01', ferias_fim: '2026-09-20' },
    { rep_codigo: 2, ferias_inicio: '2026-11-02', ferias_fim: '2026-11-11' },
  ];
  const m = feriasNoPeriodo(rows, INI, FIM);
  assert.equal(m.has(1), false);
  assert.equal(m.get(2).dias, 10);
});

test('duas janelas do mesmo rep no período: dias somam, janela vai da 1ª à 2ª', () => {
  const rows = [
    { rep_codigo: 3, ferias_inicio: '2026-10-28', ferias_fim: '2026-10-30' },
    { rep_codigo: 3, ferias_inicio: '2026-11-20', ferias_fim: '2026-11-30' },
  ];
  const f = feriasNoPeriodo(rows, INI, FIM).get(3);
  assert.equal(f.dias, 3 + 6);
  assert.equal(f.inicio, '2026-10-28');
  assert.equal(f.fim, '2026-11-25');
  assert.equal(f.janela_fim, '2026-11-30');
});

test('camposFerias: tabela manda; sem tabela só a contagem antiga sem datas vale', () => {
  const f = { inicio: '2026-10-26', fim: '2026-11-10', dias: 16, janela_inicio: '2026-10-20', janela_fim: '2026-11-10' };
  assert.deepEqual(camposFerias(f, { tem_ferias: false, dias_ferias: 0 }), { tem_ferias: true, dias_ferias: 16, ferias_inicio: '2026-10-26', ferias_fim: '2026-11-10' });
  // vendedor de período antigo: dias digitados, sem datas → mantém
  assert.deepEqual(camposFerias(undefined, { tem_ferias: true, dias_ferias: 10, ferias_inicio: null }), { tem_ferias: true, dias_ferias: 10, ferias_inicio: null, ferias_fim: null });
  // datas antigas na linha do período (já migradas) não ressuscitam
  assert.deepEqual(camposFerias(undefined, { tem_ferias: true, dias_ferias: 0, ferias_inicio: '2026-08-01' }), { tem_ferias: false, dias_ferias: 0, ferias_inicio: null, ferias_fim: null });
  assert.equal(camposFerias(undefined, undefined).tem_ferias, false);
});
