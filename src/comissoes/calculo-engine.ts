/* =============================================================================
   ENGINE DE CÁLCULO DE COMISSÕES (puro, sem I/O)
   -----------------------------------------------------------------------------
   Reproduz EXATAMENTE as fórmulas da planilha "COMISSÕES":
   - colunas calculadas das consultas VENDAS / Serviço / OS_SERVICOS;
   - agregação da aba DINAMICA-COMISSÕES (vendedores e técnicos).

   Mantido sem dependências de banco para ser testável e auditável: recebe as
   linhas cruas + a configuração e devolve o resultado pronto para gravar.
   ============================================================================= */

/* ----------------------------- Tipos de entrada ---------------------------- */

/** Linha crua da consulta VENDAS (já normalizada a partir do OPENQUERY). */
export interface VendaRow {
  nfs: number;
  nota_fiscal: string | null;
  dt_emissao: Date | null;
  opf_codigo: number | null;
  cli_codigo: number | null;
  cli_nome: string | null;
  pro_codigo: number | null;
  pro_descricao: string | null;
  quantidade: number;
  unitario: number;
  /** Desconto do ITEM (nfsi.valor_descto -> "DESC_PRODUTO"). */
  desc_produto: number;
  /** Desconto/acréscimo da NOTA (nfs.valor_descto). */
  valor_descto_nota: number;
  preco_custo: number;
  ordem_servico: string | null;
  vendedor_nota: number | null;
  vendedor_item: number | null;
}

/** Linha crua da consulta de Serviço (montadores). */
export interface ServicoRow {
  nfs: number;
  nota_fiscal: string | null;
  dt_emissao: Date | null;
  cli_codigo: number | null;
  cli_nome: string | null;
  pro_codigo: number | null;
  pro_descricao: string | null;
  quantidade: number;
  unitario: number;
  desc_produto: number;
  valor_descto_nota: number;
  comissionado_vendedor: number | null;
  comissionado_item: number | null;
}

/** Linha crua da consulta OS_SERVICOS (serviços externos). */
export interface OsRow {
  nfs: number | null;
  ordem_servico: number | null;
  dt_emissao: Date | null;
  cli_codigo: number | null;
  pro_codigo: number | null;
  pro_descricao: string | null;
  total: number;
  rep_codigo: number | null;
}

/** Representante (config de comissão). */
export interface Representante {
  rep_codigo: number;
  nome: string | null;
  calcula_comissao: boolean;
  inativo: boolean;
  especial: boolean;
  local_venda: string | null;
  papel: string | null; // VENDEDOR | TECNICO | SUPERVISOR
}

/** Faixa de % (aba TABELA %). */
export interface FaixaPercentual {
  tipo_tabela: string; // ESPECIAL | DEMAIS
  valor_min: number;
  valor_max: number;
  percentual: number;
}

/** Parâmetros manuais por representante no período. */
export interface ParametroManual {
  rep_codigo: number;
  abatimento: number;
  tem_ferias: boolean;
  dias_ferias: number;
  pct_bonus: number;
}

/** Configuração geral do cálculo. */
export interface ConfiguracaoCalculo {
  /** pro_codigo -> TIPO efetivo (FRETE/MAO DE OBRA/PINTURA/IMPOSTOS). */
  tipoProduto: Map<number, string>;
  faixas: FaixaPercentual[];
  representantes: Map<number, Representante>;
  parametros: Map<number, ParametroManual>;
  /** dias corridos do período (26 -> 25). */
  diasCorridos: number;
  /** % fixo do técnico (default 0,0175). */
  pctTecnico?: number;
  /** % do supervisor sobre toda a base de serviço (default 0,0065). */
  pctSupervisor?: number;
}

/* ----------------------------- Tipos de saída ------------------------------ */

export const TIPO_VENDAS = 'VENDAS';
export const TIPO_DEVOLUCAO = 'DEVOLUÇÃO';
export const TIPO_FRETE = 'FRETE';
export const TIPO_MAO_OBRA = 'MAO DE OBRA';
export const TIPO_IMPOSTOS = 'IMPOSTOS';
export const TIPO_PINTURA = 'PINTURA';

/** Item de VENDAS com colunas calculadas. */
export interface VendaCalculada extends VendaRow {
  total_produtos2: number;
  total_desconto: number;
  liquido: number;
  vendedor: number | null;
  tipo: string;
  custo: number;
}

/** Item de Serviço com colunas calculadas. */
export interface ServicoCalculado extends ServicoRow {
  total_produtos2: number;
  total_desconto: number;
  liquido: number;
  base_comissao: number;
  comissionado: number | null;
}

export interface ResultadoVendedor {
  rep_codigo: number;
  nome: string | null;
  especial: boolean;
  vendas: number;
  devolucao: number;
  frete: number;
  mao_obra: number;
  impostos: number;
  pintura: number;
  abatimento: number;
  media_ferias: number;
  dias_ferias: number;
  base_real: number;
  base_geral: number;
  percentual: number;
  valor_comissao: number;
  custo: number;
  lucratividade: number | null;
}

export interface ResultadoTecnico {
  rep_codigo: number | null;
  nome: string | null;
  is_supervisor: boolean;
  valor_base: number;
  abatimento: number;
  base_calculo: number;
  percentual: number;
  valor_comissao: number;
  pct_bonus: number;
  valor_bonus: number;
  total: number;
}

export interface ResultadoComissao {
  vendedores: ResultadoVendedor[];
  tecnicos: ResultadoTecnico[];
  vendasCalculadas: VendaCalculada[];
  servicosCalculados: ServicoCalculado[];
}

/* ------------------------------- Utilidades -------------------------------- */

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function vazio(v: unknown): boolean {
  return v == null || v === '' || (typeof v === 'string' && v.trim() === '');
}

/* --------------------------- Classificação TIPO ---------------------------- */

/**
 * TIPO do item de venda (fórmula AX da aba VENDAS):
 *   opf=2 -> DEVOLUÇÃO; senão lookup pro_codigo -> TIPO efetivo; senão VENDAS.
 * O mapa de config já embute a precedência (9711->PINTURA, 47777->IMPOSTOS).
 */
export function classificarTipo(
  opf: number | null,
  pro: number | null,
  tipoProduto: Map<number, string>,
): string {
  if (num(opf) === 2) return TIPO_DEVOLUCAO;
  if (pro != null && tipoProduto.has(pro)) return tipoProduto.get(pro)!;
  return TIPO_VENDAS;
}

/* ------------------------------ VENDAS (itens) ----------------------------- */

/**
 * Calcula as colunas derivadas de cada item de VENDAS.
 * - TOTAL_PRODUTOS2 = unitario * quantidade
 * - TOTAL_DESCONTO/ACRÉCIMO = desc_item + (desc_nota / Σ TP2 da NFS) * TP2
 * - LIQUIDO = TP2 - desconto (negativo quando opf=2 / devolução)
 * - VENDEDOR = se NÃO há OS OU não há vendedor de item -> vendedor da nota; senão item
 */
export function calcularVendas(
  rows: VendaRow[],
  tipoProduto: Map<number, string>,
): VendaCalculada[] {
  // Σ TOTAL_PRODUTOS2 por NFS (para ratear o desconto da nota).
  const somaTP2PorNfs = new Map<number, number>();
  const tp2 = rows.map((r) => num(r.unitario) * num(r.quantidade));
  rows.forEach((r, i) => {
    somaTP2PorNfs.set(r.nfs, (somaTP2PorNfs.get(r.nfs) ?? 0) + tp2[i]);
  });

  return rows.map((r, i) => {
    const total_produtos2 = tp2[i];
    const somaNfs = somaTP2PorNfs.get(r.nfs) ?? 0;
    const rateioNota =
      somaNfs !== 0 ? (num(r.valor_descto_nota) / somaNfs) * total_produtos2 : 0;
    const total_desconto = num(r.desc_produto) + rateioNota;
    const liquidoBruto = total_produtos2 - total_desconto;
    const liquido = num(r.opf_codigo) === 2 ? -liquidoBruto : liquidoBruto;
    const vendedor =
      vazio(r.ordem_servico) || vazio(r.vendedor_item)
        ? r.vendedor_nota
        : r.vendedor_item;
    const tipo = classificarTipo(r.opf_codigo, r.pro_codigo, tipoProduto);
    const custo = num(r.preco_custo) * num(r.quantidade);
    return { ...r, total_produtos2, total_desconto, liquido, vendedor, tipo, custo };
  });
}

/* ----------------------------- Serviço (itens) ----------------------------- */

/**
 * Colunas derivadas de cada item de Serviço.
 * - TOTAL_PRODUTOS2 = 0 se pro=13497 (frete) senão quantidade*unitario
 * - TOTAL_DESCONTO = desc_item + (desc_nota / Σ TP2 da NFS) * TP2
 * - LIQUIDO_PRODUTO = TP2 - desconto
 * - BASE_COMISSÃO = dedup por (NFS, PRO, TP2): (liq / Σliq_do_grupo) * liq
 * - COMISSIONADO = se há comissionado de item -> item; senão vendedor da OS
 */
export function calcularServicos(rows: ServicoRow[]): ServicoCalculado[] {
  const somaTP2PorNfs = new Map<number, number>();
  const tp2 = rows.map((r) =>
    num(r.pro_codigo) === 13497 ? 0 : num(r.quantidade) * num(r.unitario),
  );
  rows.forEach((r, i) => {
    somaTP2PorNfs.set(r.nfs, (somaTP2PorNfs.get(r.nfs) ?? 0) + tp2[i]);
  });

  const liquidos = rows.map((r, i) => {
    const somaNfs = somaTP2PorNfs.get(r.nfs) ?? 0;
    const rateioNota =
      somaNfs !== 0 ? (num(r.valor_descto_nota) / somaNfs) * tp2[i] : 0;
    const total_desconto = num(r.desc_produto) + rateioNota;
    return { total_produtos2: tp2[i], total_desconto, liquido: tp2[i] - total_desconto };
  });

  // Σ LIQUIDO por (NFS, PRO, TP2) para o dedup do BASE_COMISSÃO.
  const chave = (i: number) =>
    `${rows[i].nfs}|${rows[i].pro_codigo}|${liquidos[i].total_produtos2}`;
  const somaLiqPorChave = new Map<string, number>();
  liquidos.forEach((l, i) => {
    const k = chave(i);
    somaLiqPorChave.set(k, (somaLiqPorChave.get(k) ?? 0) + l.liquido);
  });

  return rows.map((r, i) => {
    const { total_produtos2, total_desconto, liquido } = liquidos[i];
    const denom = somaLiqPorChave.get(chave(i)) ?? 0;
    const base_comissao = denom !== 0 ? (liquido / denom) * liquido : 0;
    const comissionado = vazio(r.comissionado_item)
      ? r.comissionado_vendedor
      : r.comissionado_item;
    return { ...r, total_produtos2, total_desconto, liquido, base_comissao, comissionado };
  });
}

/* ------------------------------ Faixa de % --------------------------------- */

/**
 * % da comissão do vendedor pela Base Geral (réplica da fórmula da coluna N):
 * percorre as faixas do tipo (ESPECIAL/DEMAIS) e devolve a 1ª em que
 * valor_min < baseGeral < valor_max (comparação ESTRITA, como na planilha).
 * Fora de qualquer faixa => 0.
 */
export function percentualFaixa(
  baseGeral: number,
  especial: boolean,
  faixas: FaixaPercentual[],
): number {
  const tipo = especial ? 'ESPECIAL' : 'DEMAIS';
  for (const f of faixas) {
    if (f.tipo_tabela !== tipo) continue;
    if (baseGeral > f.valor_min && baseGeral < f.valor_max) return f.percentual;
  }
  return 0;
}

/* --------------------------- Agregação VENDEDORES -------------------------- */

/**
 * Bloco de vendedores da DINAMICA. Entra na lista quem é VENDEDOR no cadastro,
 * comissiona, não está inativo e teve movimento de VENDAS no período.
 */
export function agregarVendedores(
  vendas: VendaCalculada[],
  cfg: ConfiguracaoCalculo,
): ResultadoVendedor[] {
  // Soma por (vendedor, tipo) de líquido e do custo (só TIPO=VENDAS).
  const porVendedor = new Map<
    number,
    { tipos: Map<string, number>; custo: number }
  >();
  for (const v of vendas) {
    if (v.vendedor == null) continue;
    let acc = porVendedor.get(v.vendedor);
    if (!acc) {
      acc = { tipos: new Map(), custo: 0 };
      porVendedor.set(v.vendedor, acc);
    }
    acc.tipos.set(v.tipo, (acc.tipos.get(v.tipo) ?? 0) + v.liquido);
    if (v.tipo === TIPO_VENDAS) acc.custo += v.custo;
  }

  const resultado: ResultadoVendedor[] = [];
  for (const [cod, acc] of porVendedor) {
    const rep = cfg.representantes.get(cod);
    // Entra no bloco quem é VENDEDOR no cadastro, não está inativo e teve venda.
    // (NÃO gatilha por calcula_comissao: na prática vendedores/montadores recebem
    //  independentemente dessa flag do ERP — quem manda é o papel do cadastro.)
    if (!rep || rep.inativo) continue;
    if ((rep.papel ?? '').toUpperCase() !== 'VENDEDOR') continue;

    const vendasV = acc.tipos.get(TIPO_VENDAS) ?? 0;
    const devolucao = acc.tipos.get(TIPO_DEVOLUCAO) ?? 0;
    const frete = acc.tipos.get(TIPO_FRETE) ?? 0;
    const mao_obra = acc.tipos.get(TIPO_MAO_OBRA) ?? 0;
    const impostos = acc.tipos.get(TIPO_IMPOSTOS) ?? 0;
    const pintura = acc.tipos.get(TIPO_PINTURA) ?? 0;

    const p = cfg.parametros.get(cod);
    const abatimento = num(p?.abatimento);
    const diasFerias = p?.tem_ferias ? num(p?.dias_ferias) : 0;

    // base_real = VENDAS + DEVOLUÇÃO + MAO DE OBRA − ABATIMENTO (frete/impostos/pintura ficam de fora).
    const base_real = vendasV + devolucao + mao_obra - abatimento;

    // Média de férias: projeta a venda dos dias parados (só vendedores).
    let media_ferias = 0;
    const diasTrabalhados = cfg.diasCorridos - diasFerias;
    if (diasFerias > 0 && diasTrabalhados > 0) {
      media_ferias = (base_real / diasTrabalhados) * diasFerias;
    }

    const base_geral = base_real + media_ferias;
    const percentual = percentualFaixa(base_geral, rep.especial, cfg.faixas);
    // Comissão paga sobre a venda real (= base_geral − media_ferias).
    const valor_comissao = base_real * percentual;
    const lucratividade = acc.custo !== 0 ? (vendasV - acc.custo) / acc.custo : null;

    resultado.push({
      rep_codigo: cod,
      nome: rep.nome,
      especial: rep.especial,
      vendas: vendasV,
      devolucao,
      frete,
      mao_obra,
      impostos,
      pintura,
      abatimento,
      media_ferias,
      dias_ferias: diasFerias,
      base_real,
      base_geral,
      percentual,
      valor_comissao,
      custo: acc.custo,
      lucratividade,
    });
  }

  resultado.sort((a, b) => b.vendas - a.vendas);
  return resultado;
}

/* ---------------------------- Agregação TÉCNICOS --------------------------- */

/**
 * Bloco de técnicos da DINAMICA.
 * VALOR BASE do técnico = Σ BASE_COMISSÃO (serviço, comissionado=cod)
 *                       + Σ TOTAL (OS_SERVICOS atribuída ao cod).
 * A OS só é atribuída quando o par (NFS, PRO) NÃO está na consulta de serviço
 * (evita dupla contagem); a atribuição é pelo comissionado da NFS no serviço.
 * Inclui a linha do SUPERVISOR (0,65% sobre TODA a base de serviço) e a linha
 * informativa "SEM APONTAMENTO DE TÉCNICO".
 */
export function agregarTecnicos(
  servicos: ServicoCalculado[],
  os: OsRow[],
  cfg: ConfiguracaoCalculo,
): ResultadoTecnico[] {
  const pctTecnico = cfg.pctTecnico ?? 0.0175;
  const pctSupervisor = cfg.pctSupervisor ?? 0.0065;

  // BASE_COMISSÃO por comissionado.
  const baseServicoPorCod = new Map<number, number>();
  let totalBaseServico = 0;
  for (const s of servicos) {
    totalBaseServico += s.base_comissao;
    if (s.comissionado != null) {
      baseServicoPorCod.set(
        s.comissionado,
        (baseServicoPorCod.get(s.comissionado) ?? 0) + s.base_comissao,
      );
    }
  }

  // Conjunto (NFS, PRO) presente no serviço e comissionado por NFS (1º match).
  const servicoNfsPro = new Set<string>();
  const comissionadoPorNfs = new Map<number, number>();
  for (const s of servicos) {
    servicoNfsPro.add(`${s.nfs}|${s.pro_codigo}`);
    if (s.comissionado != null && !comissionadoPorNfs.has(s.nfs)) {
      comissionadoPorNfs.set(s.nfs, s.comissionado);
    }
  }

  // OS atribuída ao técnico (só quando o item não veio no serviço por NFS+PRO).
  const osPorCod = new Map<number, number>();
  let totalOsComComissionado = 0;
  for (const o of os) {
    if (o.nfs == null) continue;
    if (servicoNfsPro.has(`${o.nfs}|${o.pro_codigo}`)) continue; // já contado no serviço
    const cod = comissionadoPorNfs.get(o.nfs);
    if (cod == null) continue; // sem comissionado resolvido -> não entra
    osPorCod.set(cod, (osPorCod.get(cod) ?? 0) + num(o.total));
    totalOsComComissionado += num(o.total);
  }

  const baseGeralServico = totalBaseServico + totalOsComComissionado;

  const resultado: ResultadoTecnico[] = [];
  const codigos = new Set<number>([
    ...baseServicoPorCod.keys(),
    ...osPorCod.keys(),
  ]);

  let somaBaseTecnicos = 0;
  for (const cod of codigos) {
    const rep = cfg.representantes.get(cod);
    if (!rep || rep.inativo) continue;
    if ((rep.papel ?? '').toUpperCase() !== 'TECNICO') continue;

    const valor_base = (baseServicoPorCod.get(cod) ?? 0) + (osPorCod.get(cod) ?? 0);
    const p = cfg.parametros.get(cod);
    const abatimento = num(p?.abatimento);
    const pct_bonus = num(p?.pct_bonus);
    const base_calculo = valor_base - abatimento;
    const valor_comissao = base_calculo * pctTecnico;
    const valor_bonus = valor_base * pct_bonus;
    somaBaseTecnicos += valor_base;

    resultado.push({
      rep_codigo: cod,
      nome: rep.nome,
      is_supervisor: false,
      valor_base,
      abatimento,
      base_calculo,
      percentual: pctTecnico,
      valor_comissao,
      pct_bonus,
      valor_bonus,
      total: valor_comissao + valor_bonus,
    });
  }

  resultado.sort((a, b) => b.valor_base - a.valor_base);

  // Linha do supervisor: 0,65% sobre TODA a base de serviço do período.
  const supervisor = [...cfg.representantes.values()].find(
    (r) => (r.papel ?? '').toUpperCase() === 'SUPERVISOR',
  );
  if (supervisor) {
    const p = cfg.parametros.get(supervisor.rep_codigo);
    const abatimento = num(p?.abatimento);
    const base_calculo = baseGeralServico - abatimento;
    const valor_comissao = base_calculo * pctSupervisor;
    resultado.push({
      rep_codigo: supervisor.rep_codigo,
      nome: supervisor.nome,
      is_supervisor: true,
      valor_base: baseGeralServico,
      abatimento,
      base_calculo,
      percentual: pctSupervisor,
      valor_comissao,
      pct_bonus: 0,
      valor_bonus: 0,
      total: valor_comissao,
    });
  }

  // Linha informativa: base de serviço sem técnico apontado.
  resultado.push({
    rep_codigo: null,
    nome: 'SEM APONTAMENTO DE TÉCNICO',
    is_supervisor: false,
    valor_base: baseGeralServico - somaBaseTecnicos,
    abatimento: 0,
    base_calculo: 0,
    percentual: 0,
    valor_comissao: 0,
    pct_bonus: 0,
    valor_bonus: 0,
    total: 0,
  });

  return resultado;
}

/* ------------------------------ Orquestração ------------------------------- */

export function calcular(
  vendas: VendaRow[],
  servicos: ServicoRow[],
  os: OsRow[],
  cfg: ConfiguracaoCalculo,
): ResultadoComissao {
  const vendasCalculadas = calcularVendas(vendas, cfg.tipoProduto);
  const servicosCalculados = calcularServicos(servicos);
  return {
    vendedores: agregarVendedores(vendasCalculadas, cfg),
    tecnicos: agregarTecnicos(servicosCalculados, os, cfg),
    vendasCalculadas,
    servicosCalculados,
  };
}
