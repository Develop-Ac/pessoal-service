import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConsultarRateioQuery } from './rateio.dto';

/**
 * Leitura do rateio da DESPESA COM PESSOAL por canal de venda.
 *
 * O cálculo já existe no DW: a fato `f_dre_base_despesa_com_pessoal` é
 * materializada pela proc `sp_refresh_f_dre_base_despesa_com_pessoal`, que
 * cruza FolhaValoresMensais × percentuais do CadastroColaboradores × vendas
 * por canal. Aqui apenas LEMOS o resultado agregado e disparamos o refresh.
 */
@Injectable()
export class RateioService {
  private readonly logger = new Logger('Rateio');

  constructor(private readonly prisma: PrismaService) {}

  /** Despesa com pessoal agregada por competência e canal. */
  async consultar(q: ConsultarRateioQuery) {
    const condicoes: Prisma.Sql[] = [];
    if (q.ano != null) condicoes.push(Prisma.sql`ANO = ${q.ano}`);
    if (q.mes != null) condicoes.push(Prisma.sql`MES = ${q.mes}`);
    if (q.canal) condicoes.push(Prisma.sql`LOCAL_VENDA = ${q.canal}`);
    const where =
      condicoes.length > 0
        ? Prisma.sql`WHERE ${Prisma.join(condicoes, ' AND ')}`
        : Prisma.empty;

    const linhas = await this.prisma.$queryRaw<
      Array<{ ano: number; mes: number; canal: string | null; total: Prisma.Decimal }>
    >(Prisma.sql`
      SELECT ANO AS ano, MES AS mes, LOCAL_VENDA AS canal,
             SUM(VALOR_CONVERTIDO) AS total
      FROM dbo.f_dre_base_despesa_com_pessoal
      ${where}
      GROUP BY ANO, MES, LOCAL_VENDA
      ORDER BY ANO, MES, LOCAL_VENDA
    `);

    return linhas.map((l) => ({
      ano: Number(l.ano),
      mes: Number(l.mes),
      competencia: `${l.ano}-${String(l.mes).padStart(2, '0')}`,
      canal: l.canal,
      total: l.total == null ? 0 : Number(l.total),
    }));
  }

  /**
   * Recalcula o rateio e atualiza TODA a DRE.
   * Fluxo:
   *   1. sp_refresh_f_dre_base_despesa_com_pessoal (rateio da folha por canal).
   *   2. Encerra sessões ativas do Metabase (evita bloqueios no refresh pesado).
   *   3. sp_refresh_mart_dre_full @ANO_PROJECAO = <ano>, atualizando todas as
   *      views da DRE. O ano vem da última competência implantada (folha), salvo
   *      override explícito.
   */
  async atualizar(anoOverride?: number) {
    // 1) Rateio da despesa com pessoal por canal.
    this.logger.log('Disparando sp_refresh_f_dre_base_despesa_com_pessoal...');
    await this.execProc('EXEC dbo.sp_refresh_f_dre_base_despesa_com_pessoal');

    // 2) Ano de projeção: override ou ano da última competência implantada.
    const ano = anoOverride ?? (await this.anoUltimaCompetencia());

    // 3) Encerra sessões ativas do Metabase (best-effort).
    const metabase = await this.encerrarSessoesMetabase();

    // 4) Atualiza toda a DRE para o ano de projeção.
    this.logger.log(`Disparando sp_refresh_mart_dre_full @ANO_PROJECAO=${ano}...`);
    await this.execProc(
      `EXEC [dbo].[sp_refresh_mart_dre_full] @ANO_PROJECAO = ${ano}`,
    );

    return {
      mensagem: `Rateio recalculado e DRE atualizada para ${ano}.`,
      ano_projecao: ano,
      metabase_sessoes_encerradas: metabase.encerradas,
      metabase_aviso: metabase.aviso,
    };
  }

  /** Ano (YYYY) da maior competência presente na folha (FolhaValoresMensais). */
  private async anoUltimaCompetencia(): Promise<number> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ comp: string | null }>>(
        'SELECT MAX(competencia) AS comp FROM FolhaValoresMensais',
      );
      const comp = rows?.[0]?.comp ?? null;
      if (comp && /^\d{4}-\d{2}$/.test(comp)) return parseInt(comp.substring(0, 4), 10);
    } catch (e) {
      this.logger.warn(
        `Não foi possível obter a última competência: ${e instanceof Error ? e.message : e}`,
      );
    }
    return new Date().getFullYear();
  }

  /**
   * Encerra (KILL) as sessões do Metabase que NÃO estão "sleeping" — ou seja,
   * com consulta em execução que poderia bloquear o refresh da DRE.
   * Best-effort: requer VIEW SERVER STATE + ALTER ANY CONNECTION para o usuário
   * do banco; se faltar permissão, registra aviso e segue o fluxo.
   */
  private async encerrarSessoesMetabase(): Promise<{ encerradas: number; aviso?: string }> {
    let sessoes: Array<{ session_id: number }> = [];
    try {
      sessoes = await this.prisma.$queryRawUnsafe<Array<{ session_id: number }>>(`
        SELECT s.session_id
        FROM sys.dm_exec_sessions s
        LEFT JOIN sys.dm_exec_requests r ON s.session_id = r.session_id
        WHERE (s.program_name LIKE '%Metabase%' OR s.host_name LIKE '%metabase%')
          AND s.status <> 'sleeping'
          AND s.session_id <> @@SPID
      `);
    } catch (e) {
      const aviso = `Sem permissão para listar sessões do Metabase (VIEW SERVER STATE): ${e instanceof Error ? e.message : e}`;
      this.logger.warn(aviso);
      return { encerradas: 0, aviso };
    }

    let encerradas = 0;
    let ultimoErro: string | undefined;
    for (const s of sessoes) {
      const sid = Number(s.session_id);
      if (!Number.isInteger(sid)) continue;
      try {
        await this.prisma.$executeRawUnsafe(`KILL ${sid}`);
        encerradas += 1;
        this.logger.log(`Sessão Metabase ${sid} encerrada.`);
      } catch (e) {
        ultimoErro = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Falha ao encerrar sessão ${sid}: ${ultimoErro}`);
      }
    }
    const aviso =
      sessoes.length > 0 && encerradas < sessoes.length
        ? `Algumas sessões não puderam ser encerradas (verifique ALTER ANY CONNECTION). Último erro: ${ultimoErro}`
        : undefined;
    return { encerradas, aviso };
  }

  /**
   * Executa um EXEC de stored procedure. Usa $executeRaw; se o proc retornar um
   * result set (alguns refresh procs fazem SELECT), refaz via $queryRaw.
   */
  private async execProc(sql: string): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/result|resultset|SELECT/i.test(msg)) {
        await this.prisma.$queryRawUnsafe(sql);
        return;
      }
      throw e;
    }
  }
}
