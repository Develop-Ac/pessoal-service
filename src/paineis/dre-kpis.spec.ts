// Rodar: npm test  (node --experimental-strip-types --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheTtl, FiltroInvalido, chaveFiltros, lerFiltros, parametrosSql } from './dre-kpis.ts';

test('mês único e intervalo de meses viram [de, ate_excl)', () => {
  assert.deepEqual(parametrosSql(lerFiltros({ inicio: '2026-09', fim: '2026-09' })), ['2026-09-01', '2026-10-01', '']);
  assert.deepEqual(parametrosSql(lerFiltros({ inicio: '2026-01', fim: '2026-12' })), ['2026-01-01', '2027-01-01', '']);
  assert.deepEqual(parametrosSql(lerFiltros({ inicio: '2026-09', canal: 'ATACADO' })), ['2026-09-01', '2026-10-01', 'ATACADO']);
  assert.deepEqual(parametrosSql(lerFiltros({ fim: '2026-02' })), ['2026-02-01', '2026-03-01', '']);
});

test('sem datas = sem filtro; vazio conta como ausente', () => {
  assert.deepEqual(lerFiltros({}), { inicio: null, fim: null, canal: null });
  assert.deepEqual(parametrosSql(lerFiltros({ inicio: '', fim: '', canal: '' })), ['', '', '']);
});

test('formatos de Data fora do que a tela envia são recusados', () => {
  for (const inicio of ['past30days', '2026-09-15', '2026-13', '2026-9', '2026-09-01~2026-09-30', 'thisyear']) {
    assert.throws(() => lerFiltros({ inicio }), FiltroInvalido, inicio);
  }
  assert.throws(() => lerFiltros({ inicio: ['2026-01', '2026-02'] }), FiltroInvalido);
  assert.throws(() => lerFiltros({ canal: 'CORPORATIVO' }), FiltroInvalido);
});

test('chave do cache usa os filtros normalizados', () => {
  assert.equal(chaveFiltros(lerFiltros({ inicio: '2026-09' })), chaveFiltros(lerFiltros({ inicio: '2026-09', fim: '2026-09' })));
});

test('cache expira após o TTL', () => {
  let agora = 1_000;
  const cache = new CacheTtl<number>(60_000, () => agora);
  cache.set('a', 1);
  agora += 59_999;
  assert.equal(cache.get('a'), 1);
  agora += 1;
  assert.equal(cache.get('a'), undefined);
});
