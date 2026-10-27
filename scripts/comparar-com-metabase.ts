// Confere o painel nativo dre-kpis contra o Metabase, card a card.
//
// Para cada cenário de filtro, roda o card no Metabase pelo dashboard 22
// (POST /api/dashboard/22/dashcard/:dc/card/:card/query, com os parâmetros no
// mesmo formato que a rota /api/pessoal/dre-kpis da intranet envia) e roda o
// .sql do serviço no SQL Server BI. Compara linha a linha: números com
// tolerância de 0,01, datas pelo dia, texto exato.
//
// Uso (DATABASE_URL do SQL Server BI no ambiente, como no .env do serviço):
//   node --experimental-strip-types scripts/comparar-com-metabase.ts
//   node --experimental-strip-types scripts/comparar-com-metabase.ts 2026-09 2026-09 ATACADO
// Sai com código 1 se algum card divergir.
import path from 'node:path';
import prismaPkg from '@prisma/client';
import { metabase } from './metabase.ts';
import { carregarCards, executarCard, lerFiltros, parametrosSql, type FiltrosDre } from '../src/paineis/dre-kpis.ts';

const DASHBOARD = 22;
const PARAM_DATA = 'a1aa7e6f';
const PARAM_CANAL = '59852ad';
const TOLERANCIA = 0.01;

const cards = carregarCards(path.resolve(import.meta.dirname, '../src/paineis/sql'));
const prisma = new prismaPkg.PrismaClient();

/** Parâmetros do dashboard exatamente como a rota da intranet monta. */
function parametrosMetabase(f: FiltrosDre) {
  const p: Array<{ id: string; value: string }> = [];
  if (f.inicio && f.fim) {
    const [a, m] = f.fim.split('-').map(Number);
    const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
    p.push({ id: PARAM_DATA, value: `${f.inicio}-01~${f.fim}-${String(ultimo).padStart(2, '0')}` });
  }
  if (f.canal) p.push({ id: PARAM_CANAL, value: f.canal });
  return p;
}

function celulaIgual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a) - Number(b)) <= TOLERANCIA;
  // Coluna date: o Metabase devolve a meia-noite no fuso do relatório
  // ("2025-01-01T00:00:00-03:00"), o serviço devolve "2025-01-01". Vale o dia.
  const DIA = /^\d{4}-\d{2}-\d{2}/;
  if (DIA.test(String(a)) && DIA.test(String(b))) return String(a).slice(0, 10) === String(b).slice(0, 10);
  return String(a) === String(b);
}

function comparar(mb: unknown[][], nat: unknown[][]): string | null {
  if (mb.length !== nat.length) return `linhas: metabase ${mb.length} × serviço ${nat.length}`;
  for (let i = 0; i < mb.length; i++) {
    for (let j = 0; j < mb[i].length; j++) {
      if (!celulaIgual(mb[i][j], nat[i][j])) {
        return `linha ${i} col ${j}: metabase ${JSON.stringify(mb[i][j])} × serviço ${JSON.stringify(nat[i][j])}`;
      }
    }
  }
  return null;
}

const resumo = (rows: unknown[][]) =>
  rows.length <= 2 ? JSON.stringify(rows) : `${rows.length} linhas`;

const argv = process.argv.slice(2);
const cenarios: Record<string, unknown>[] = argv.length
  ? [{ inicio: argv[0], fim: argv[1], canal: argv[2] }]
  : [
      {},
      { inicio: '2026-09', fim: '2026-09' },
      { inicio: '2026-09', fim: '2026-09', canal: 'ATACADO' },
      { inicio: '2026-01', fim: '2026-12' },
      { inicio: '2026-01', fim: '2026-12', canal: 'VAREJO-SERVIÇO' },
    ];

let divergencias = 0;
for (const q of cenarios) {
  const f = lerFiltros(q);
  const params = parametrosSql(f);
  const pm = parametrosMetabase(f);
  console.log(`\n### ${f.inicio}..${f.fim} canal=${f.canal ?? '(todos)'}`);
  for (const card of cards) {
    const t0 = Date.now();
    const [mb, nat] = await Promise.all([
      metabase('POST', `/api/dashboard/${DASHBOARD}/dashcard/${card.dashcard}/card/${card.card}/query`, {
        parameters: pm,
      }),
      executarCard(prisma, card, params),
    ]);
    const mbRows: unknown[][] = mb?.data?.rows ?? [];
    const erroMb = mb?.error ? `metabase: ${mb.error}` : null;
    const dif = erroMb ?? comparar(mbRows, nat.rows);
    if (dif) divergencias++;
    console.log(
      `${dif ? 'DIVERGE' : 'OK     '} card ${card.card} (${card.titulo}) ${Date.now() - t0}ms` +
        (dif ? ` — ${dif}` : ` — ${resumo(nat.rows)}`),
    );
  }
}

await prisma.$disconnect();
console.log(`\n${divergencias ? `${divergencias} divergência(s)` : 'tudo igual'}`);
process.exit(divergencias ? 1 : 0);
