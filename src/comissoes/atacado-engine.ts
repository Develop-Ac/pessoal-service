/* =============================================================================
   ENGINE DE COMISSÃO — ATACADO (puro, sem I/O)
   -----------------------------------------------------------------------------
   Reproduz a pergunta 422 do Metabase ("Comissão Por Mix e Faixa") + as regras
   extras da intranet (abatimento e média de férias do mix 2/3).

   Por vendedor, sobre o período comissional (26 -> 25):
     - células = Σ liquido_produto por (mix, faixa) lidas de vw_analise_vendas;
     - total_vendido = Σ todas as células; total_mix1 = Σ células do mix 1;
     - atingiu_meta = (total_mix1 / total_vendido) >= meta_mix1 (ex.: 30%);
     - abatimento (R$) reduz o total: base_real = total_vendido - abatimento;
     - média de férias (só mix 2/3) projeta a venda dos dias parados sobre o
       total geral: total_faixa = base_real + media_ferias (escolhe a faixa do
       mix 2/3); a comissão é paga sobre a venda real;
     - % por célula: mix 1 -> fixo por faixa (dobra se atingiu_meta); mix 2/3 ->
       progressivo sobre total_faixa;
     - comissão bruta = Σ (venda_célula * %); o abatimento é proporcional:
       valor_comissao = comissao_bruta * (base_real / total_vendido).

   Sem dependências de banco para ser testável/auditável.
   ============================================================================= */

/* ----------------------------- Tipos de entrada ---------------------------- */

/** Célula crua (Σ por mix x faixa) de um vendedor, vinda de vw_analise_vendas. */
export interface CelulaAtacado {
  rep_codigo: number;
  mix: number; // 1 | 2 | 3
  faixa: string; // A | B | C | D
  valor_vendido: number;
}

/** Faixa progressiva do mix 2/3 (casa por valor_max em ordem crescente). */
export interface FaixaMix23 {
  valor_min: number;
  valor_max: number;
  percentual: number;
}

/** % fixo do mix 1 por (faixa, atingiu_meta). */
export interface FaixaMix1 {
  faixa: string;
  atingiu_meta: boolean;
  percentual: number;
}

/** Representante (só nome/inativo importam aqui; o filtro de atacado é externo). */
export interface RepresentanteAtacado {
  rep_codigo: number;
  nome: string | null;
  inativo: boolean;
}

/** Parâmetros manuais do atacado (reaproveita ComissaoParametroManual). */
export interface ParametroAtacado {
  rep_codigo: number;
  abatimento: number;
  tem_ferias: boolean;
  dias_ferias: number;
}

export interface ConfiguracaoAtacado {
  faixasMix23: FaixaMix23[];
  faixasMix1: FaixaMix1[];
  /** Participação do mix 1 que dobra o % (ex.: 0.30). */
  metaMix1: number;
  representantes: Map<number, RepresentanteAtacado>;
  parametros: Map<number, ParametroAtacado>;
  /** Dias corridos do período (26 -> 25). */
  diasCorridos: number;
}

/* ----------------------------- Tipos de saída ------------------------------ */

/** Célula com % e comissão (bruta) calculados. */
export interface CelulaAtacadoCalculada {
  rep_codigo: number;
  mix: number;
  faixa: string;
  valor_vendido: number;
  pct_comissao: number;
  /** Comissão bruta da célula = valor_vendido * %. O abatimento (fator) é no total. */
  valor_comissao: number;
}

export interface ResultadoAtacado {
  rep_codigo: number;
  nome: string | null;
  total_vendido: number;
  total_mix1: number;
  /** Participação do mix 1 (total_mix1 / total_vendido). */
  pct_mix1: number;
  atingiu_meta: boolean;
  abatimento: number;
  base_real: number;
  dias_ferias: number;
  media_ferias: number;
  /** Total usado para escolher a faixa do mix 2/3 (base_real + media_ferias). */
  total_faixa: number;
  pct_mix23: number;
  comissao_bruta: number;
  /** base_real / total_vendido (1 quando não há abatimento). */
  fator_abatimento: number;
  valor_comissao: number;
}

export interface ResultadoComissaoAtacado {
  vendedores: ResultadoAtacado[];
  detalhe: CelulaAtacadoCalculada[];
}

/* ------------------------------- Utilidades -------------------------------- */

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Alíquota progressiva do mix 2/3 (réplica do CASE do Metabase):
 * 1ª faixa (ordem crescente de valor_max) em que total <= valor_max. <= 0 => 0.
 */
export function percentualMix23(total: number, faixas: FaixaMix23[]): number {
  if (total <= 0) return 0;
  const ordenadas = [...faixas].sort((a, b) => a.valor_max - b.valor_max);
  for (const f of ordenadas) {
    if (total <= f.valor_max) return f.percentual;
  }
  return ordenadas.length ? ordenadas[ordenadas.length - 1].percentual : 0;
}

/** % fixo do mix 1 por (faixa, atingiu_meta). Sem match => 0. */
export function percentualMix1(
  faixa: string,
  atingiuMeta: boolean,
  faixas: FaixaMix1[],
): number {
  const alvo = (faixa ?? '').toUpperCase();
  const f = faixas.find(
    (x) => (x.faixa ?? '').toUpperCase() === alvo && !!x.atingiu_meta === atingiuMeta,
  );
  return f ? f.percentual : 0;
}

/* ------------------------------ Orquestração ------------------------------- */

export function calcularAtacado(
  celulas: CelulaAtacado[],
  cfg: ConfiguracaoAtacado,
): ResultadoComissaoAtacado {
  // Agrupa as células por vendedor.
  const porRep = new Map<number, CelulaAtacado[]>();
  for (const c of celulas) {
    const cod = num(c.rep_codigo);
    if (!porRep.has(cod)) porRep.set(cod, []);
    porRep.get(cod)!.push(c);
  }

  const vendedores: ResultadoAtacado[] = [];
  const detalhe: CelulaAtacadoCalculada[] = [];

  for (const [cod, cels] of porRep) {
    const rep = cfg.representantes.get(cod);
    if (!rep || rep.inativo) continue; // só atacado ativo (filtro de papel é na origem)

    const total_vendido = cels.reduce((s, c) => s + num(c.valor_vendido), 0);
    const total_mix1 = cels
      .filter((c) => num(c.mix) === 1)
      .reduce((s, c) => s + num(c.valor_vendido), 0);
    const pct_mix1 = total_vendido > 0 ? total_mix1 / total_vendido : 0;
    const atingiu_meta = pct_mix1 >= cfg.metaMix1;

    const p = cfg.parametros.get(cod);
    const abatimento = num(p?.abatimento);
    const dias_ferias = p?.tem_ferias ? num(p?.dias_ferias) : 0;
    const base_real = total_vendido - abatimento;

    // Média de férias (só mix 2/3): projeta a venda dos dias parados sobre o
    // total geral. Define a faixa do mix 2/3; não infla a comissão paga.
    let media_ferias = 0;
    const diasTrabalhados = cfg.diasCorridos - dias_ferias;
    if (dias_ferias > 0 && diasTrabalhados > 0) {
      media_ferias = (base_real / diasTrabalhados) * dias_ferias;
    }
    const total_faixa = base_real + media_ferias;
    const pct_mix23 = percentualMix23(total_faixa, cfg.faixasMix23);

    // Abatimento proporcional: escala a base comissionável de todas as células.
    const fator_abatimento = total_vendido > 0 ? base_real / total_vendido : 0;

    let comissao_bruta = 0;
    for (const c of cels) {
      const mix = num(c.mix);
      const pct =
        mix === 1
          ? percentualMix1(c.faixa, atingiu_meta, cfg.faixasMix1)
          : mix === 2 || mix === 3
            ? pct_mix23
            : 0;
      const valor_comissao = num(c.valor_vendido) * pct;
      comissao_bruta += valor_comissao;
      detalhe.push({
        rep_codigo: cod,
        mix,
        faixa: (c.faixa ?? '').toUpperCase(),
        valor_vendido: num(c.valor_vendido),
        pct_comissao: pct,
        valor_comissao,
      });
    }

    const valor_comissao = comissao_bruta * fator_abatimento;

    vendedores.push({
      rep_codigo: cod,
      nome: rep.nome,
      total_vendido,
      total_mix1,
      pct_mix1,
      atingiu_meta,
      abatimento,
      base_real,
      dias_ferias,
      media_ferias,
      total_faixa,
      pct_mix23,
      comissao_bruta,
      fator_abatimento,
      valor_comissao,
    });
  }

  vendedores.sort((a, b) => b.total_vendido - a.total_vendido);
  // Detalhe ordenado por vendedor, mix e faixa (A/B/C/D) para o relatório.
  const ordFaixa = (f: string) => ({ A: 1, B: 2, C: 3, D: 4 })[f] ?? 9;
  detalhe.sort(
    (a, b) =>
      a.rep_codigo - b.rep_codigo ||
      a.mix - b.mix ||
      ordFaixa(a.faixa) - ordFaixa(b.faixa),
  );

  return { vendedores, detalhe };
}
