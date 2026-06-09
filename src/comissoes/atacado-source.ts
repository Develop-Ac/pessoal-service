/* =============================================================================
   LEITURA DA BASE DO ATACADO (DW BI — dbo.vw_analise_vendas)
   -----------------------------------------------------------------------------
   Diferente do varejo/serviço (Firebird via OPENQUERY), a base do atacado é o
   próprio SQL Server BI: a view vw_analise_vendas já traz mix_custo (1/2/3),
   faixa_mix (A/B/C/D) e liquido_produto por item. Agregamos por
   (vendedor, mix, faixa) no período, só para os reps de atacado informados.

   Espelha a pergunta 422 do Metabase: filtra pelo período em
   dt_emissao_convertida e exige mix_custo/faixa_mix não nulos. O filtro de
   vendedor é por código (vendedor_venda) — que casa com rep_codigo da intranet.
   ============================================================================= */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CelulaAtacado } from './atacado-engine';

/** Item de venda do atacado (linha da relação por item — espelha a 443). */
export interface ItemAtacadoRow {
  dt_emissao: string | null;
  cli_codigo: number | null;
  cli_nome: string | null;
  pro_codigo: number | null;
  pro_descricao: string | null;
  liquido_produto: number;
  mix: number;
  faixa: string;
}

@Injectable()
export class AtacadoSource {
  private readonly logger = new Logger('AtacadoSource');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Σ liquido_produto por (vendedor_venda, mix_custo, faixa_mix) no período,
   * restrito aos reps de atacado. Datas em 'AAAA-MM-DD'.
   */
  async lerCelulas(
    dataIni: string,
    dataFim: string,
    repsAtacado: number[],
  ): Promise<CelulaAtacado[]> {
    if (!repsAtacado.length) return [];
    const inList = Prisma.join(repsAtacado.map((r) => Prisma.sql`${r}`));
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT
        v.vendedor_venda           AS rep_codigo,
        v.mix_custo                AS mix,
        v.faixa_mix                AS faixa,
        SUM(v.liquido_produto)     AS valor_vendido
      FROM dbo.vw_analise_vendas v
      WHERE v.dt_emissao_convertida BETWEEN ${dataIni} AND ${dataFim}
        AND v.mix_custo IS NOT NULL
        AND v.faixa_mix IS NOT NULL
        AND v.vendedor_venda IN (${inList})
      GROUP BY v.vendedor_venda, v.mix_custo, v.faixa_mix`);

    return rows.map((r) => ({
      rep_codigo: Number(r.rep_codigo),
      mix: Number(r.mix),
      faixa: String(r.faixa ?? '').trim().toUpperCase(),
      valor_vendido: Number(r.valor_vendido),
    }));
  }

  /**
   * Relação de vendas por item de UM vendedor no período (espelha a 443).
   * Data como 'AAAA-MM-DD' (CONVERT 23) para não deslocar o dia no fuso.
   * Ordenado por data desc, cliente, produto.
   */
  async lerItensRep(
    dataIni: string,
    dataFim: string,
    repCodigo: number,
  ): Promise<ItemAtacadoRow[]> {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT
        CONVERT(varchar(10), v.dt_emissao_convertida, 23) AS dt_emissao,
        v.cli_codigo,
        v.cli_nome,
        v.pro_codigo,
        v.pro_descricao,
        v.liquido_produto,
        v.mix_custo  AS mix,
        v.faixa_mix  AS faixa
      FROM dbo.vw_analise_vendas v
      WHERE v.dt_emissao_convertida BETWEEN ${dataIni} AND ${dataFim}
        AND v.mix_custo IS NOT NULL
        AND v.faixa_mix IS NOT NULL
        AND v.vendedor_venda = ${repCodigo}
      ORDER BY v.dt_emissao_convertida DESC, v.cli_nome, v.pro_descricao`);

    return rows.map((r) => ({
      dt_emissao: r.dt_emissao ?? null,
      cli_codigo: r.cli_codigo == null ? null : Number(r.cli_codigo),
      cli_nome: r.cli_nome ?? null,
      pro_codigo: r.pro_codigo == null ? null : Number(r.pro_codigo),
      pro_descricao: r.pro_descricao ?? null,
      liquido_produto: Number(r.liquido_produto),
      mix: Number(r.mix),
      faixa: String(r.faixa ?? '').trim().toUpperCase(),
    }));
  }
}
