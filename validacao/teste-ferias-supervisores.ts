/* Teste sintético: férias dos supervisores (oficina + atacado). */
import assert from 'node:assert/strict';
import {
  ConfiguracaoCalculo,
  OsRow,
  ServicoRow,
  agregarTecnicos,
  calcularServicos,
  janelaFerias,
} from '../src/comissoes/calculo-engine';
import { calcularSupervisorAtacado } from '../src/comissoes/supervisor-atacado-engine';

/* ---------- janelaFerias ---------- */
assert.equal(janelaFerias(undefined), null);
assert.equal(janelaFerias({ tem_ferias: false, ferias_inicio: '2026-08-01', ferias_fim: '2026-08-10' }), null);
assert.equal(janelaFerias({ tem_ferias: true, ferias_inicio: '2026-08-01', ferias_fim: null }), null);
// recorte ao período 26/07..25/08
const j = janelaFerias(
  { tem_ferias: true, ferias_inicio: '2026-07-20', ferias_fim: '2026-08-05' },
  '2026-07-26',
  '2026-08-25',
);
assert.deepEqual(j, { inicio: '2026-07-26', fim: '2026-08-05', dias: 11 });
// fora do período => null
assert.equal(
  janelaFerias({ tem_ferias: true, ferias_inicio: '2026-09-01', ferias_fim: '2026-09-10' }, '2026-07-26', '2026-08-25'),
  null,
);

/* ---------- supervisor da oficina ---------- */
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const servicoRows: ServicoRow[] = [
  // NFS 1, dia 30/07 (fora das férias): 1000
  { nfs: 1, nota_fiscal: '1', dt_emissao: d('2026-07-30'), cli_codigo: 1, cli_nome: 'A', pro_codigo: 10, pro_descricao: 'X', quantidade: 1, unitario: 1000, desc_produto: 0, valor_descto_nota: 0, comissionado_vendedor: 50, comissionado_item: null },
  // NFS 2, dia 02/08 (dentro das férias): 500
  { nfs: 2, nota_fiscal: '2', dt_emissao: d('2026-08-02'), cli_codigo: 1, cli_nome: 'A', pro_codigo: 10, pro_descricao: 'X', quantidade: 1, unitario: 500, desc_produto: 0, valor_descto_nota: 0, comissionado_vendedor: 50, comissionado_item: null },
];
const osRows: OsRow[] = [
  // OS da NFS 2, produto diferente (não está no serviço) => conta, dia 03/08 (férias): 200
  { nfs: 2, ordem_servico: 9, dt_emissao: d('2026-08-03'), cli_codigo: 1, pro_codigo: 11, pro_descricao: 'Y', total: 200, rep_codigo: 50 },
  // OS da NFS 1, produto diferente, dia 30/07 (fora): 300
  { nfs: 1, ordem_servico: 8, dt_emissao: d('2026-07-30'), cli_codigo: 1, pro_codigo: 11, pro_descricao: 'Y', total: 300, rep_codigo: 50 },
];
const cfg: ConfiguracaoCalculo = {
  tipoProduto: new Map(),
  faixas: [],
  representantes: new Map([
    [50, { rep_codigo: 50, nome: 'TEC', calcula_comissao: true, inativo: false, especial: false, local_venda: 'SERVIÇO', papel: 'TECNICO' }],
    [9001, { rep_codigo: 9001, nome: 'BRUNO', calcula_comissao: true, inativo: false, especial: false, local_venda: 'SERVIÇO', papel: 'SUPERVISOR' }],
  ]),
  parametros: new Map([
    [9001, { rep_codigo: 9001, abatimento: 100, abatimento_motivo: 'teste', tem_ferias: true, dias_ferias: 0, ferias_inicio: '2026-08-01', ferias_fim: '2026-08-05', pct_bonus: 0 }],
  ]),
  diasCorridos: 31,
  periodoIni: '2026-07-26',
  periodoFim: '2026-08-25',
};
const tec = agregarTecnicos(calcularServicos(servicoRows), osRows, cfg);
const sup = tec.find((t) => t.is_supervisor)!;
const tecnico = tec.find((t) => t.rep_codigo === 50)!;
const semApont = tec.find((t) => t.rep_codigo == null)!;
// base total = 1000 + 500 + 200 + 300 = 2000; férias = 500 + 200 = 700
assert.equal(tecnico.valor_base, 2000); // técnico não é afetado
assert.equal(sup.excluido_ferias, 700);
assert.equal(sup.valor_base, 1300);
assert.equal(sup.base_calculo, 1200); // − abatimento 100
assert.ok(Math.abs(sup.valor_comissao - 1200 * 0.0065) < 1e-9);
assert.equal(sup.dias_ferias, 5);
assert.equal(sup.ferias_inicio, '2026-08-01');
assert.equal(semApont.valor_base, 0); // linha informativa usa a base cheia
// sem férias => base cheia
const cfgSem = { ...cfg, parametros: new Map() };
const sup2 = agregarTecnicos(calcularServicos(servicoRows), osRows, cfgSem).find((t) => t.is_supervisor)!;
assert.equal(sup2.valor_base, 2000);
assert.equal(sup2.excluido_ferias, 0);
assert.equal(sup2.ferias_inicio, null);

/* ---------- supervisor do atacado ---------- */
const celulas = [
  { rep_codigo: 1, mix: 1, faixa: 'A', valor_vendido: 30000 },
  { rep_codigo: 2, mix: 1, faixa: 'A', valor_vendido: 10000 },
  { rep_codigo: 1, mix: 2, faixa: 'B', valor_vendido: 60000 },
];
const celulasFerias = [
  { rep_codigo: 1, mix: 1, faixa: 'A', valor_vendido: 10000 },
  { rep_codigo: 1, mix: 2, faixa: 'B', valor_vendido: 20000 },
];
const rep = { rep_codigo: 77, nome: 'SUP' };
const semFerias = calcularSupervisorAtacado(celulas, rep, 0.3, { abatimento: 0, abatimento_motivo: null });
assert.equal(semFerias.resumo.total_vendido, 100000);
assert.equal(semFerias.resumo.total_mix1, 40000);
assert.equal(semFerias.resumo.atingiu_meta, true);
assert.equal(semFerias.resumo.excluido_ferias, 0);
const comFerias = calcularSupervisorAtacado(celulas, rep, 0.3, {
  abatimento: 0,
  abatimento_motivo: null,
  ferias: { inicio: '2026-08-01', fim: '2026-08-10', dias: 10 },
  celulasFerias,
});
assert.equal(comFerias.resumo.total_vendido, 70000);
assert.equal(comFerias.resumo.total_mix1, 30000);
assert.equal(comFerias.resumo.excluido_ferias, 30000);
assert.equal(comFerias.resumo.dias_ferias, 10);
assert.equal(comFerias.resumo.atingiu_meta, true); // 30/70 = 42,8%
const celA = comFerias.detalhe.find((x) => x.mix === 1 && x.faixa === 'A')!;
const celB = comFerias.detalhe.find((x) => x.mix === 2 && x.faixa === 'B')!;
assert.equal(celA.valor_vendido, 30000);
assert.equal(celB.valor_vendido, 40000);
assert.ok(Math.abs(comFerias.resumo.comissao_bruta - (30000 * 0.0125 + 40000 * 0.0055)) < 1e-9);
// férias informadas mas sem células (ninguém vendeu nos dias) => nada muda além do carimbo
const vazio = calcularSupervisorAtacado(celulas, rep, 0.3, {
  abatimento: 0, abatimento_motivo: null,
  ferias: { inicio: '2026-08-01', fim: '2026-08-02', dias: 2 }, celulasFerias: [],
});
assert.equal(vazio.resumo.total_vendido, 100000);
assert.equal(vazio.resumo.dias_ferias, 2);

console.log('OK — todos os cenários passaram');
