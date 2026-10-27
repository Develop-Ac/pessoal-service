// KPIs de pessoal do DRE servidos sem o Metabase.
//
// Os cards são os do dashboard 22 do Metabase que a tela "Indicadores de
// Pessoal" da intranet consome. O SQL de cada card está em ./sql (extraído por
// scripts/extrair-cards-metabase.ts) e o manifesto ./sql/dre-kpis.json guarda
// título, display, layout e colunas, para o resultado sair no mesmo formato
// cols/rows do Metabase e a rota da intranet manter o mesmo tratamento.
//
// Este arquivo não usa decorators nem imports locais: é carregado tanto pelo
// controller (build Nest) quanto pelos scripts e testes (node --experimental-strip-types).
import fs from 'node:fs';
import path from 'node:path';

/** Canais do filtro "Canal de Venda" do dashboard (LOCAL_VENDA). */
export const CANAIS = ['ATACADO', 'VAREJO', 'VAREJO-SERVIÇO'];

const MES = /^\d{4}-(0[1-9]|1[0-2])$/;

export class FiltroInvalido extends Error {}

/**
 * Filtros da tela: competência inicial e final (AAAA-MM, inclusive) e canal.
 * Sem datas = todo o histórico, como o dashboard sem o filtro Data.
 */
export interface FiltrosDre {
  inicio: string | null;
  fim: string | null;
  canal: string | null;
}

/**
 * Lê e valida a querystring. Só aceita meses AAAA-MM, que é o que a tela envia
 * (o filtro Data do Metabase aceita outros formatos, como "past30days" ou dia
 * avulso; aqui eles são recusados). Com só um dos lados, vale o mês único.
 */
export function lerFiltros(q: Record<string, unknown>): FiltrosDre {
  const texto = (nome: string): string | null => {
    const v = q[nome];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string') throw new FiltroInvalido(`${nome} informado mais de uma vez`);
    return v.trim() || null;
  };
  let inicio = texto('inicio');
  let fim = texto('fim');
  const canal = texto('canal');
  for (const [nome, v] of [['inicio', inicio], ['fim', fim]] as const) {
    if (v && !MES.test(v)) throw new FiltroInvalido(`${nome} deve estar no formato AAAA-MM (recebido "${v}")`);
  }
  if (canal && !CANAIS.includes(canal)) {
    throw new FiltroInvalido(`canal deve ser um de ${CANAIS.join(', ')} (recebido "${canal}")`);
  }
  inicio ??= fim;
  fim ??= inicio;
  return { inicio, fim, canal };
}

/** Chave de cache: filtros já normalizados. */
export const chaveFiltros = (f: FiltrosDre) => `${f.inicio ?? ''}|${f.fim ?? ''}|${f.canal ?? ''}`;

/**
 * Valores de @de, @ate_excl e @canal. Vão como texto ('' = sem filtro) porque o
 * NULL sem tipo do driver não converte para date no SQL Server; o DECLARE faz NULLIF.
 * O mês final vira o 1º dia do mês seguinte (intervalo semiaberto), o mesmo
 * recorte do "AAAA-MM-01~AAAA-MM-<último dia>" que o Metabase recebe.
 */
export function parametrosSql(f: FiltrosDre): [string, string, string] {
  if (!f.inicio || !f.fim) return ['', '', f.canal ?? ''];
  const [ano, mes] = f.fim.split('-').map(Number);
  const ateExcl = mes === 12 ? `${ano + 1}-01-01` : `${ano}-${String(mes + 1).padStart(2, '0')}-01`;
  return [`${f.inicio}-01`, ateExcl, f.canal ?? ''];
}

const DECLARACAO =
  "DECLARE @de date = NULLIF(@P1, ''), @ate_excl date = NULLIF(@P2, ''), @canal varchar(40) = NULLIF(@P3, '');\n";

export interface ColunaCard {
  name: string;
  display_name: string;
  base_type: string;
}

export interface CardDre {
  dashcard: number;
  card: number;
  arquivo: string;
  titulo: string;
  display: string;
  row: number;
  col: number;
  size_x: number;
  size_y: number;
  visualization_settings: Record<string, unknown>;
  cols: ColunaCard[];
  sql: string;
}

/** Lê o manifesto e o SQL de cada card (uma vez, na subida). */
export function carregarCards(dir: string): CardDre[] {
  const manifesto = JSON.parse(fs.readFileSync(path.join(dir, 'dre-kpis.json'), 'utf8')) as Omit<CardDre, 'sql'>[];
  return manifesto.map((c) => ({ ...c, sql: fs.readFileSync(path.join(dir, c.arquivo), 'utf8') }));
}

/**
 * Coluna date (meia-noite UTC no driver) → "AAAA-MM-DD"; demais datas → ISO;
 * Decimal/bigint → number (o JSON do Metabase traz números puros).
 */
function paraJson(v: unknown): unknown {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return v;
}

type Banco = { $queryRawUnsafe: (sql: string, ...valores: unknown[]) => Promise<unknown> };

/** Executa o SQL de um card e devolve { cols, rows } na ordem das colunas do manifesto. */
export async function executarCard(db: Banco, card: CardDre, params: [string, string, string]) {
  const linhas = (await db.$queryRawUnsafe(DECLARACAO + card.sql, ...params)) as Record<string, unknown>[];
  return {
    cols: card.cols,
    rows: linhas.map((l) => card.cols.map((c) => paraJson(l[c.name]))),
  };
}

/** Cache em memória com validade fixa por item. */
export class CacheTtl<T> {
  private readonly itens = new Map<string, { expira: number; valor: T }>();
  private readonly ttlMs: number;
  private readonly agora: () => number;

  constructor(ttlMs: number, agora: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.agora = agora;
  }

  get(chave: string): T | undefined {
    const item = this.itens.get(chave);
    if (!item) return undefined;
    if (item.expira <= this.agora()) {
      this.itens.delete(chave);
      return undefined;
    }
    return item.valor;
  }

  set(chave: string, valor: T): void {
    const t = this.agora();
    // Limpa vencidos a cada gravação: as combinações de filtro são poucas.
    for (const [k, item] of this.itens) if (item.expira <= t) this.itens.delete(k);
    this.itens.set(chave, { expira: t + this.ttlMs, valor });
  }
}
