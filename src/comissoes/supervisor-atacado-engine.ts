/* =============================================================================
   ENGINE DE COMISSÃO — SUPERVISOR DO ATACADO (puro, sem I/O)
   -----------------------------------------------------------------------------
   Reproduz a pergunta 420 do Metabase ("Comissão Por Mix e Faixa" do supervisor)
   e a 447 ("Relatório de Vendas por Item com Comissão"). Diferente do vendedor
   de atacado (atacado-engine), o supervisor comissiona sobre TODO o canal de
   atacado (a soma de todos os vendedores juntos), com uma tabela de alíquota
   PRÓPRIA e FIXA (card 420), sem média de férias:

     - base = Σ liquido_produto de todas as células (mix x faixa) do canal,
       MENOS o que o canal vendeu nos dias de férias do supervisor (o canal
       continua vendendo sem ele; esses dias saem da base — e como o % é fixo,
       não há média projetada como no vendedor);
     - mix 2/3: alíquota FIXA de 0,55% (sem escada);
     - mix 1: % base por faixa A/B/C/D (1,00 / 0,86 / 0,71 / 0,57) x multiplicador
       da MESMA escada de participação dos vendedores (dbo.ComissaoAtacadoEscadaMix1:
       22% -> x1,25; 26% -> x1,50; 30% -> x2,00) — decisão da diretoria de 28/10/2026,
       plano do prêmio do supervisor v5; a participação é a do canal inteiro;
     - sem escada vigente (meses antigos): regra anterior — atingiu_meta =
       (Σ mix 1 / base) >= 0,30 troca para a tabela "atingiu" (1,25/1,11/0,96/0,82);
     - comissão bruta = Σ (venda_célula * %).

   O abatimento (R$) segue a mesma mecânica do vendedor de atacado: reduz a base
   (base_real = total_vendido − abatimento) e escala a comissão proporcionalmente
   (fator = base_real / total_vendido). NÃO mexe na participação do mix 1 — não há
   como saber de qual mix o abatimento saiu, então a meta continua pelo bruto.

   Alíquotas embutidas (decisão do usuário: fixas do card 420). Se um dia
   precisarem ser editáveis, basta movê-las para uma tabela de config como o
   atacado-engine faz.
   ============================================================================= */

import { CelulaAtacado, DegrauMix1, multiplicadorMix1 } from './atacado-engine';
import { JanelaFerias } from './calculo-engine';

/* ----------------------------- Tabela do card 420 -------------------------- */

/** Alíquota fixa do mix 2/3 do supervisor (0,55%). */
export const SUP_PCT_MIX23 = 0.0055;

/** Regra antiga (sem escada): participação mínima do mix 1 que muda a tabela (>= 30%). */
export const SUP_META_MIX1 = 0.3;

/**
 * % do mix 1 por faixa. `abaixo` é a base do supervisor (x multiplicador da
 * escada); `atingiu` só vale na regra antiga, sem escada vigente.
 */
const SUP_MIX1: Record<'abaixo' | 'atingiu', Record<string, number>> = {
  abaixo: { A: 0.01, B: 0.0086, C: 0.0071, D: 0.0057 },
  atingiu: { A: 0.0125, B: 0.0111, C: 0.0096, D: 0.0082 },
};

/**
 * % de comissão do supervisor para um item/célula (réplica do CASE do 420/447):
 * mix 2/3 -> fixo 0,55%; mix 1 -> base da faixa x multiplicador da escada
 * (quando informado) ou tabela "abaixo"/"atingiu" (regra antiga).
 */
export function pctSupervisorAtacado(
  mix: number,
  faixa: string,
  atingiuMeta: boolean,
  multiplicador?: number,
): number {
  if (mix === 2 || mix === 3) return SUP_PCT_MIX23;
  if (mix === 1) {
    const f = (faixa ?? '').toUpperCase();
    if (multiplicador !== undefined) return (SUP_MIX1.abaixo[f] ?? 0) * multiplicador;
    const tabela = atingiuMeta ? SUP_MIX1.atingiu : SUP_MIX1.abaixo;
    return tabela[f] ?? 0;
  }
  return 0;
}

/* ------------------------------- Tipos de saída ---------------------------- */

/** Célula (mix x faixa) do canal com % e comissão do supervisor. */
export interface DetalheSupervisorAtacado {
  mix: number;
  faixa: string;
  valor_vendido: number;
  pct_comissao: number;
  valor_comissao: number;
}

export interface ResumoSupervisorAtacado {
  rep_codigo: number;
  nome: string | null;
  total_vendido: number;
  total_mix1: number;
  /** Participação do mix 1 (total_mix1 / total_vendido). */
  pct_mix1: number;
  atingiu_meta: boolean;
  /** Multiplicador do degrau da escada alcançado (1 sem escada ou abaixo do 1º degrau). */
  mult_mix1: number;
  /** Alíquota fixa do mix 2/3 (informativa). */
  pct_mix23: number;
  /** Venda do canal nos dias de férias do supervisor (fora de total_vendido). */
  excluido_ferias: number;
  dias_ferias: number;
  ferias_inicio: string | null;
  ferias_fim: string | null;
  abatimento: number;
  abatimento_motivo: string | null;
  /** total_vendido − abatimento. */
  base_real: number;
  /** Σ (venda_célula * %), antes do abatimento. */
  comissao_bruta: number;
  /** base_real / total_vendido (1 quando não há abatimento). */
  fator_abatimento: number;
  /** Comissão a pagar = comissao_bruta * fator_abatimento. */
  comissao_total: number;
}

/** Parâmetros manuais do supervisor do atacado (ComissaoParametroManual). */
export interface ParametroSupervisorAtacado {
  abatimento: number;
  abatimento_motivo: string | null;
  /** Janela de férias já recortada ao período (null = sem férias). */
  ferias?: JanelaFerias | null;
  /**
   * Células do canal SÓ dos dias da janela de férias (mesma leitura de
   * lerCelulas, restrita a ferias.inicio..fim). São subtraídas do canal.
   */
  celulasFerias?: CelulaAtacado[];
}

export interface ResultadoSupervisorAtacado {
  resumo: ResumoSupervisorAtacado;
  detalhe: DetalheSupervisorAtacado[];
}

/* ------------------------------- Utilidades -------------------------------- */

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const ordFaixa = (f: string) => ({ A: 1, B: 2, C: 3, D: 4 })[f] ?? 9;

/* ------------------------------ Orquestração ------------------------------- */

/**
 * Soma as células de TODO o canal (ignora o rep_codigo de origem), agrega por
 * (mix, faixa) e aplica a tabela do supervisor (card 420). `rep` é só o cadastro
 * do supervisor (código/nome) para identificar a quem a comissão pertence.
 * `parametro` traz o abatimento manual do período (opcional). `escadaMix1` é a
 * escada vigente no período (vazia = regra antiga em metaMix1).
 */
export function calcularSupervisorAtacado(
  celulas: CelulaAtacado[],
  rep: { rep_codigo: number; nome: string | null },
  metaMix1: number = SUP_META_MIX1,
  parametro?: ParametroSupervisorAtacado,
  escadaMix1: DegrauMix1[] = [],
): ResultadoSupervisorAtacado {
  // Agrega o canal inteiro por (mix, faixa). As células dos dias de férias do
  // supervisor entram com sinal trocado: o que o canal vendeu sem ele sai da
  // base (célula a célula, para a participação do mix 1 também refletir só os
  // dias trabalhados).
  const ferias = parametro?.ferias ?? null;
  const celulasFerias = ferias ? (parametro?.celulasFerias ?? []) : [];
  const porCelula = new Map<string, DetalheSupervisorAtacado>();
  const somar = (c: CelulaAtacado, sinal: 1 | -1) => {
    const mix = num(c.mix);
    const faixa = (c.faixa ?? '').toUpperCase();
    const k = `${mix}|${faixa}`;
    const acc = porCelula.get(k);
    if (acc) acc.valor_vendido += sinal * num(c.valor_vendido);
    else
      porCelula.set(k, {
        mix,
        faixa,
        valor_vendido: sinal * num(c.valor_vendido),
        pct_comissao: 0,
        valor_comissao: 0,
      });
  };
  for (const c of celulas) somar(c, 1);
  for (const c of celulasFerias) somar(c, -1);
  const excluido_ferias = celulasFerias.reduce((s, c) => s + num(c.valor_vendido), 0);

  const detalhe = [...porCelula.values()];
  const total_vendido = detalhe.reduce((s, d) => s + d.valor_vendido, 0);
  const total_mix1 = detalhe
    .filter((d) => d.mix === 1)
    .reduce((s, d) => s + d.valor_vendido, 0);
  const pct_mix1 = total_vendido > 0 ? total_mix1 / total_vendido : 0;
  const comEscada = escadaMix1.length > 0;
  const mult_mix1 = comEscada ? multiplicadorMix1(pct_mix1, escadaMix1) : 1;
  const atingiu_meta = comEscada ? mult_mix1 > 1 : pct_mix1 >= metaMix1;

  let comissao_bruta = 0;
  for (const d of detalhe) {
    d.pct_comissao = pctSupervisorAtacado(
      d.mix,
      d.faixa,
      atingiu_meta,
      comEscada ? mult_mix1 : undefined,
    );
    d.valor_comissao = d.valor_vendido * d.pct_comissao;
    comissao_bruta += d.valor_comissao;
  }

  detalhe.sort((a, b) => a.mix - b.mix || ordFaixa(a.faixa) - ordFaixa(b.faixa));

  // Abatimento proporcional (mesma mecânica do vendedor de atacado).
  const abatimento = num(parametro?.abatimento);
  const base_real = total_vendido - abatimento;
  const fator_abatimento = total_vendido > 0 ? base_real / total_vendido : 1;
  const comissao_total = comissao_bruta * fator_abatimento;

  return {
    resumo: {
      rep_codigo: rep.rep_codigo,
      nome: rep.nome,
      total_vendido,
      total_mix1,
      pct_mix1,
      atingiu_meta,
      mult_mix1,
      pct_mix23: SUP_PCT_MIX23,
      excluido_ferias,
      dias_ferias: ferias?.dias ?? 0,
      ferias_inicio: ferias?.inicio ?? null,
      ferias_fim: ferias?.fim ?? null,
      abatimento,
      abatimento_motivo: abatimento
        ? ((parametro?.abatimento_motivo ?? '').trim() || null)
        : null,
      base_real,
      comissao_bruta,
      fator_abatimento,
      comissao_total,
    },
    detalhe,
  };
}
