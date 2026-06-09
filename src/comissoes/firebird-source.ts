/* =============================================================================
   LEITURA DO MOVIMENTO NO FIREBIRD (via linked server CONSULTA / OPENQUERY)
   -----------------------------------------------------------------------------
   As três consultas são transcritas VERBATIM da planilha (Power Query /
   Section1.m). Só as DATAS do período são parametrizadas (26/mm-1 a 25/mm).
   Mantemos o SELECT e o GROUP BY originais para reproduzir o mesmo conjunto de
   linhas — e, portanto, os mesmos números que o vendedor assina.

   O backend NÃO conecta no Firebird: o SQL Server BI tem o linked server
   `CONSULTA` (CeltaFirebird/ODBC) e nós rodamos OPENQUERY a partir dele.
   ============================================================================= */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OsRow, ServicoRow, VendaRow } from './calculo-engine';

/** OPF aceitos nas consultas de venda/serviço (mesma lista da planilha). */
const OPF_VENDAS = '1, 2, 4, 5, 6, 7, 124, 101, 102, 104, 105, 106, 107, 200';

@Injectable()
export class FirebirdSource {
  private readonly logger = new Logger('FirebirdSource');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Converte uma data 'AAAA-MM-DD' para o literal do Firebird 'DD.MM.AAAA'.
   * Recebe STRING de propósito: usar objeto Date aqui causava deslocamento de 1
   * dia (DATE volta como meia-noite UTC e os getters locais recuam o dia em
   * fusos negativos), o que rodava o período comissional errado (25→24 em vez de
   * 26→25).
   */
  static formatarData(ymd: string): string {
    const [y, m, d] = ymd.split('-');
    return `${d}.${m}.${y}`;
  }

  /** Envolve a consulta Firebird em OPENQUERY (dobrando aspas simples). */
  private openquery(inner: string): string {
    return `SELECT * FROM OPENQUERY(CONSULTA, '${inner.replace(/'/g, "''")}')`;
  }

  private async exec<T>(inner: string): Promise<T[]> {
    const sql = this.openquery(inner);
    return this.prisma.$queryRawUnsafe<T[]>(sql);
  }

  /* ------------------------------- VENDAS -------------------------------- */

  async lerVendas(dataIni: string, dataFim: string): Promise<VendaRow[]> {
    const ini = FirebirdSource.formatarData(dataIni);
    const fim = FirebirdSource.formatarData(dataFim);
    const inner = `SELECT
      nfs.empresa, nfs.nfs, nfs.nota_fiscal, nfs.serie, nfs.chave_nfe, nfs.dt_emissao,
      nfs.opf_codigo, opf.opf_descricao, nfs.cli_codigo, cli.cli_nome, cli.uf, cli.cidade,
      nfs.indicador_presenca, nfs.base_icms, nfs.valor_icms, nfs.total_produtos, nfs.valor_descto,
      nfs.total_nota, subprod.grp_codigo, gprod.grp_descricao, pro.subgrp_codigo, subprod.subgrp_descricao,
      marc.mar_descricao, nfsi.pro_codigo, pro.pro_descricao, pro.ncm, nfsi.cst, nfsi.cfop,
      nfsi.unidade_comercial, nfsi.quantidade, nfsi.unitario, nfsi.total, nfsi.valor_descto as DESC_PRODUTO,
      nfsi.qtde_devolvida, nfsi.promocao, nfsi.preco_venda, nfsi.preco_custo, nfsi.preco_custo_comercial,
      ord.ordem_servico, nfs.rep_codigo as Vendedor_Nota, ordi.rep_codigo as Vendedor_Item, nfsi.item
FROM nf_saida NFS
JOIN nfs_itens NFSI ON (nfs.empresa = nfsi.empresa) and (nfs.nfs = nfsi.nfs)
JOIN operacoes_fiscais OPF on (opf.empresa = nfs.empresa) and (nfs.opf_codigo = opf.opf_codigo)
JOIN clientes CLI ON (CLI.empresa = nfs.empresa) and (CLI.cli_codigo = nfs.cli_codigo)
left join produtos PRO on (pro.empresa = nfs.empresa) and (pro.pro_codigo = nfsi.pro_codigo)
left join ordens_servico ord on (ord.empresa = nfs.empresa) and (ord.nfs = nfs.nfs)
left join ordem_servico_comissionado ordcom on (ordcom.empresa = nfs.empresa) and (ordcom.item = nfsi.item) and (ordcom.ordem_servico = ord.ordem_servico)
left join os_itens ordi on (ordi.empresa = nfs.empresa) and (ordi.pro_codigo = nfsi.pro_codigo) and (ordi.ordem_servico = ord.ordem_servico)
left join produtos_subgrupos subprod on (pro.empresa = subprod.empresa) and (pro.subgrp_codigo = subprod.subgrp_codigo)
left join produtos_grupos gprod on (pro.empresa = gprod.empresa) and (subprod.grp_codigo = gprod.grp_codigo)
left join marcas marc on (marc.empresa = nfs.empresa) and (marc.mar_codigo = pro.mar_codigo)
WHERE NFS.dt_emissao between '${ini}' and '${fim}'
AND NFS.empresa = '3'
and nfs.dt_cancelamento is null
AND nfs.opf_codigo in (${OPF_VENDAS})
group by nfs.empresa, nfs.nfs, nfs.nota_fiscal, nfs.serie, nfs.chave_nfe, nfs.dt_emissao, nfs.opf_codigo, opf.opf_descricao, nfs.cli_codigo, cli.cli_nome, cli.uf, cli.cidade, nfs.indicador_presenca, nfs.base_icms,
nfs.valor_icms, nfs.total_produtos, nfs.valor_descto, nfs.total_nota, subprod.grp_codigo, gprod.grp_descricao, pro.subgrp_codigo, subprod.subgrp_descricao, marc.mar_descricao, nfsi.pro_codigo, pro.pro_descricao,
pro.ncm, nfsi.cst, nfsi.cfop, nfsi.unidade_comercial, nfsi.quantidade, nfsi.unitario, nfsi.total, nfsi.valor_descto, nfsi.qtde_devolvida, nfsi.promocao, nfsi.preco_venda, nfsi.preco_custo, nfsi.preco_custo_comercial,
ord.ordem_servico, nfs.rep_codigo, ordi.rep_codigo, nfsi.item`;

    const rows = await this.exec<Record<string, unknown>>(inner);
    this.logger.log(`VENDAS: ${rows.length} linhas (${ini} a ${fim}).`);
    return rows.map((r) => ({
      nfs: toNum(pick(r, 'NFS', 'nfs')),
      nota_fiscal: toStr(pick(r, 'NOTA_FISCAL', 'nota_fiscal')),
      dt_emissao: toDate(pick(r, 'DT_EMISSAO', 'dt_emissao')),
      opf_codigo: toNumN(pick(r, 'OPF_CODIGO', 'opf_codigo')),
      cli_codigo: toNumN(pick(r, 'CLI_CODIGO', 'cli_codigo')),
      cli_nome: toStr(pick(r, 'CLI_NOME', 'cli_nome')),
      pro_codigo: toNumN(pick(r, 'PRO_CODIGO', 'pro_codigo')),
      pro_descricao: toStr(pick(r, 'PRO_DESCRICAO', 'pro_descricao')),
      quantidade: toNum(pick(r, 'QUANTIDADE', 'quantidade')),
      unitario: toNum(pick(r, 'UNITARIO', 'unitario')),
      desc_produto: toNum(pick(r, 'DESC_PRODUTO', 'desc_produto')),
      valor_descto_nota: toNum(pick(r, 'VALOR_DESCTO', 'valor_descto')),
      preco_custo: toNum(pick(r, 'PRECO_CUSTO', 'preco_custo')),
      ordem_servico: toStr(pick(r, 'ORDEM_SERVICO', 'ordem_servico')),
      vendedor_nota: toNumN(pick(r, 'VENDEDOR_NOTA', 'Vendedor_Nota', 'vendedor_nota')),
      vendedor_item: toNumN(pick(r, 'VENDEDOR_ITEM', 'Vendedor_Item', 'vendedor_item')),
    }));
  }

  /* ------------------------------- SERVIÇO ------------------------------- */

  async lerServicos(dataIni: string, dataFim: string): Promise<ServicoRow[]> {
    const ini = FirebirdSource.formatarData(dataIni);
    const fim = FirebirdSource.formatarData(dataFim);
    const inner = `SELECT
      nfs.empresa, nfs.nfs, nfs.nota_fiscal, nfs.serie, nfs.chave_nfe, nfs.dt_emissao,
      nfs.opf_codigo, opf.opf_descricao, nfs.cli_codigo, cli.cli_nome, cli.uf,
      nfs.indicador_presenca, nfs.base_icms, nfs.valor_icms, nfs.total_produtos, nfs.valor_descto,
      nfs.total_nota, nfsi.pro_codigo, pro.pro_descricao, pro.ncm, nfsi.cst, nfsi.cfop,
      nfsi.unidade_comercial, nfsi.quantidade, nfsi.unitario, nfsi.total, nfsi.valor_descto as DESC_PRODUTO,
      nfsi.qtde_devolvida, nfsi.promocao, nfsi.preco_venda, nfsi.preco_custo, nfsi.preco_custo_comercial,
      ord.ordem_servico, ord.rep_codigo as COMICIONADO_VENDEDOR, ordcom.rep_codigo as COMICIONADO_ITEM,
      ordi.cancelado, nfs.dt_cancelamento, ord.categoria_codigo
FROM nf_saida NFS
JOIN nfs_itens NFSI ON (nfs.empresa = nfsi.empresa) and (nfs.nfs = nfsi.nfs)
JOIN operacoes_fiscais OPF on (opf.empresa = nfs.empresa) and (nfs.opf_codigo = opf.opf_codigo)
JOIN clientes CLI ON (CLI.empresa = nfs.empresa) and (CLI.cli_codigo = nfs.cli_codigo)
LEFT join produtos PRO on (pro.empresa = nfs.empresa) and (pro.pro_codigo = nfsi.pro_codigo)
left join ordens_servico ord on (ord.empresa = nfs.empresa) and (ord.nfs = nfs.nfs)
left join os_itens ordi on (ordi.empresa = nfs.empresa) and (ordi.pro_codigo = nfsi.pro_codigo) and (ordi.ordem_servico = ord.ordem_servico)
left join ordem_servico_comissionado ordcom on (ordcom.empresa = nfs.empresa) and (ordcom.item = ordi.item) and (ordcom.ordem_servico = ord.ordem_servico)
WHERE NFS.dt_emissao between '${ini}' and '${fim}'
AND NFS.empresa = '3'
AND ord.ordem_servico is not null
AND nfs.dt_cancelamento is null
AND nfs.opf_codigo in (${OPF_VENDAS})
AND ord.categoria_codigo not in ('3','7','10','9')`;

    const rows = await this.exec<Record<string, unknown>>(inner);
    this.logger.log(`SERVIÇO: ${rows.length} linhas (${ini} a ${fim}).`);
    return rows.map((r) => ({
      nfs: toNum(pick(r, 'NFS', 'nfs')),
      nota_fiscal: toStr(pick(r, 'NOTA_FISCAL', 'nota_fiscal')),
      dt_emissao: toDate(pick(r, 'DT_EMISSAO', 'dt_emissao')),
      cli_codigo: toNumN(pick(r, 'CLI_CODIGO', 'cli_codigo')),
      cli_nome: toStr(pick(r, 'CLI_NOME', 'cli_nome')),
      pro_codigo: toNumN(pick(r, 'PRO_CODIGO', 'pro_codigo')),
      pro_descricao: toStr(pick(r, 'PRO_DESCRICAO', 'pro_descricao')),
      quantidade: toNum(pick(r, 'QUANTIDADE', 'quantidade')),
      unitario: toNum(pick(r, 'UNITARIO', 'unitario')),
      desc_produto: toNum(pick(r, 'DESC_PRODUTO', 'desc_produto')),
      valor_descto_nota: toNum(pick(r, 'VALOR_DESCTO', 'valor_descto')),
      comissionado_vendedor: toNumN(
        pick(r, 'COMICIONADO_VENDEDOR', 'comicionado_vendedor'),
      ),
      comissionado_item: toNumN(pick(r, 'COMICIONADO_ITEM', 'comicionado_item')),
    }));
  }

  /* ----------------------------- OS_SERVICOS ----------------------------- */

  async lerOs(dataIni: string, dataFim: string): Promise<OsRow[]> {
    const ini = FirebirdSource.formatarData(dataIni);
    const fim = FirebirdSource.formatarData(dataFim);
    const inner = `select
    os.empresa, os.ordem_servico, os.dt_emissao, os.cli_codigo, osi.pro_codigo,
    osi.pro_descricao, osi.total, osi.rep_codigo, OS.nfs
from os_itens OSI
left join ordens_servico OS on (osi.ordem_servico = os.ordem_servico) and (os.empresa = osi.empresa)
WHERE osi.pro_codigo in (37560, 4174)
and os.dt_emissao between '${ini}' and '${fim}'
and os.status = 4`;

    const rows = await this.exec<Record<string, unknown>>(inner);
    this.logger.log(`OS_SERVICOS: ${rows.length} linhas (${ini} a ${fim}).`);
    return rows.map((r) => ({
      nfs: toNumN(pick(r, 'NFS', 'nfs')),
      ordem_servico: toNumN(pick(r, 'ORDEM_SERVICO', 'ordem_servico')),
      dt_emissao: toDate(pick(r, 'DT_EMISSAO', 'dt_emissao')),
      cli_codigo: toNumN(pick(r, 'CLI_CODIGO', 'cli_codigo')),
      pro_codigo: toNumN(pick(r, 'PRO_CODIGO', 'pro_codigo')),
      pro_descricao: toStr(pick(r, 'PRO_DESCRICAO', 'pro_descricao')),
      total: toNum(pick(r, 'TOTAL', 'total')),
      rep_codigo: toNumN(pick(r, 'REP_CODIGO', 'rep_codigo')),
    }));
  }
}

/* ------------------------------ helpers de tipo ---------------------------- */

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (k in obj && obj[k] != null) return obj[k];
  }
  return null;
}

function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'bigint') return Number(v);
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function toNumN(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = toNum(v);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}
