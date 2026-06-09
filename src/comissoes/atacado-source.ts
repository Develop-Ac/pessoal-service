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
}
