// Extrai do Metabase o SQL dos cards do dashboard 22 (DRE) que alimentam os
// KPIs de pessoal da intranet e grava em src/paineis/sql/:
//   <card>-<slug>.sql  SQL nativo com os filtros de campo ({{tag}}) trocados por
//                      parâmetros nomeados (@de, @ate_excl, @canal);
//   dre-kpis.json      manifesto (dashcard, card, título, display, layout,
//                      visualization_settings e colunas do resultado).
//
// Uso: node --experimental-strip-types scripts/extrair-cards-metabase.ts
// Rodar de novo só quando um desses cards mudar no Metabase; depois conferir
// com scripts/comparar-com-metabase.ts.
import fs from 'node:fs';
import path from 'node:path';
import { metabase } from './metabase.ts';

const DASHBOARD = 22;
// Dashcards consumidos por /api/pessoal/dre-kpis (KPIs + gráficos), na ordem da rota.
const DASHCARDS = [535, 537, 542, 540, 532, 536, 538, 533, 531, 539, 541];
// Parâmetros do dashboard → como o filtro de campo vira SQL.
const PARAM_DATA = 'a1aa7e6f';
const PARAM_CANAL = '59852ad';

const DESTINO = path.resolve(import.meta.dirname, '../src/paineis/sql');

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const campos = new Map<number, string>();
async function coluna(fieldId: number): Promise<string> {
  if (!campos.has(fieldId)) {
    const f = await metabase('GET', `/api/field/${fieldId}`);
    campos.set(fieldId, `${f.table.name}.${f.name}`);
  }
  return campos.get(fieldId)!;
}

const dash = await metabase('GET', `/api/dashboard/${DASHBOARD}`);
fs.mkdirSync(DESTINO, { recursive: true });
const manifesto: any[] = [];

for (const id of DASHCARDS) {
  const dc = dash.dashcards.find((d: any) => d.id === id);
  if (!dc) throw new Error(`dashcard ${id} não existe mais no dashboard ${DASHBOARD}`);
  const card = await metabase('GET', `/api/card/${dc.card_id}`);
  const nativo = card.dataset_query?.native;
  if (!nativo?.query) throw new Error(`card ${card.id} não é SQL nativo`);

  let sql: string = nativo.query;
  for (const [nome, tag] of Object.entries<any>(nativo['template-tags'] ?? {})) {
    if (tag.type !== 'dimension') throw new Error(`card ${card.id}: tag {{${nome}}} do tipo ${tag.type} não suportada`);
    const mapa = dc.parameter_mappings.find((m: any) => m.target?.[1]?.[1] === nome);
    const col = await coluna(tag.dimension[1]);
    let expr: string;
    if (mapa?.parameter_id === PARAM_DATA) expr = `(@de IS NULL OR (${col} >= @de AND ${col} < @ate_excl))`;
    else if (mapa?.parameter_id === PARAM_CANAL) expr = `(@canal IS NULL OR ${col} = @canal)`;
    else throw new Error(`card ${card.id}: tag {{${nome}}} sem filtro do dashboard conhecido`);
    sql = sql.split(`{{${nome}}}`).join(expr);
  }
  if (/\{\{|\[\[/.test(sql)) throw new Error(`card ${card.id}: sobrou tag/trecho opcional não convertido`);

  const arquivo = `${card.id}-${slug(card.name)}.sql`;
  const cabecalho =
    `-- Dashboard ${DASHBOARD} do Metabase, card ${card.id} (dashcard ${dc.id}): ${card.name}\n` +
    `-- Gerado por scripts/extrair-cards-metabase.ts. Parâmetros declarados pelo serviço:\n` +
    `--   @de date, @ate_excl date (competência no intervalo [de, ate_excl); NULL = sem filtro)\n` +
    `--   @canal varchar (LOCAL_VENDA; NULL = todos os canais)\n`;
  fs.writeFileSync(path.join(DESTINO, arquivo), cabecalho + sql.trim() + '\n');

  manifesto.push({
    dashcard: dc.id,
    card: card.id,
    arquivo,
    titulo: card.name,
    display: card.display,
    row: dc.row,
    col: dc.col,
    size_x: dc.size_x,
    size_y: dc.size_y,
    visualization_settings: card.visualization_settings ?? {},
    cols: (card.result_metadata ?? []).map((c: any) => ({
      name: c.name,
      display_name: c.display_name,
      base_type: c.base_type,
    })),
  });
  console.log(`card ${card.id} → ${arquivo}`);
}

fs.writeFileSync(path.join(DESTINO, 'dre-kpis.json'), JSON.stringify(manifesto, null, 2) + '\n');
console.log(`manifesto: ${manifesto.length} cards`);
