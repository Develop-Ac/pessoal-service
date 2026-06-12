import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { FirebirdSource } from './firebird-source';
import { AtacadoSource } from './atacado-source';
import {
  ConfiguracaoCalculo,
  FaixaPercentual,
  OsRow,
  ParametroManual,
  Representante,
  ResultadoComissao,
  ServicoRow,
  VendaRow,
  calcular,
} from './calculo-engine';
import {
  CelulaAtacado,
  ConfiguracaoAtacado,
  FaixaMix1,
  FaixaMix23,
  ParametroAtacado,
  RepresentanteAtacado,
  ResultadoComissaoAtacado,
  calcularAtacado,
  percentualMix1,
} from './atacado-engine';
import {
  AbrirPeriodoDto,
  AtualizarParametroDto,
  AtualizarRepresentanteDto,
  ListarRepresentantesQuery,
  ParametroItemDto,
} from './comissoes.dto';

/** Movimento bruto lido das origens, mantido em memória p/ recalcular sem rebuscar. */
interface MovimentoCache {
  vendas: VendaRow[];
  servicos: ServicoRow[];
  os: OsRow[];
  /** Células (mix x faixa) do atacado lidas do BI (vw_analise_vendas). */
  atacado: CelulaAtacado[];
}

export interface JobCalculo {
  job_id: string;
  periodo_id: number;
  status: 'processando' | 'concluido' | 'erro';
  etapa: string;
  progresso: number; // 0..100
  iniciado_em: string;
  concluido_em?: string;
  erro?: string;
  resumo?: Record<string, unknown>;
}

@Injectable()
export class ComissoesService {
  private readonly logger = new Logger('Comissoes');
  private readonly jobs = new Map<string, JobCalculo>();
  /** Movimento por período (cache em memória) para recalcular sem ir ao Firebird. */
  private readonly movimentoCache = new Map<number, MovimentoCache>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebird: FirebirdSource,
    private readonly atacado: AtacadoSource,
  ) {}

  /* ============================= PERÍODOS ============================== */

  async listarPeriodos() {
    return this.prisma.$queryRaw`
      SELECT id, ano, mes, data_inicio, data_fim, dias_corridos, status,
             data_calculo, data_criacao
      FROM dbo.ComissaoPeriodo
      ORDER BY ano DESC, mes DESC`;
  }

  async obterPeriodo(id: number) {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT id, ano, mes, data_inicio, data_fim, dias_corridos, status,
             data_calculo, data_criacao
      FROM dbo.ComissaoPeriodo WHERE id = ${id}`);
    if (!rows.length) throw new NotFoundException('Período não encontrado.');
    return rows[0];
  }

  /** Abre a competência (ou devolve a existente). Calcula as datas 26 -> 25. */
  async abrirPeriodo(dto: AbrirPeriodoDto) {
    const existente = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT id FROM dbo.ComissaoPeriodo WHERE ano = ${dto.ano} AND mes = ${dto.mes}`);
    if (existente.length) return this.obterPeriodo(existente[0].id);

    const { dataIniYmd, dataFimYmd, diasCorridos } = calcularDatasPeriodo(
      dto.ano,
      dto.mes,
    );
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO dbo.ComissaoPeriodo (ano, mes, data_inicio, data_fim, dias_corridos, status)
      VALUES (${dto.ano}, ${dto.mes}, ${dataIniYmd}, ${dataFimYmd}, ${diasCorridos}, 'ABERTO')`);
    const novo = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT id FROM dbo.ComissaoPeriodo WHERE ano = ${dto.ano} AND mes = ${dto.mes}`);
    return this.obterPeriodo(novo[0].id);
  }

  /* ============================== CÁLCULO ============================== */

  criarJob(periodoId: number): JobCalculo {
    const job: JobCalculo = {
      job_id: randomUUID(),
      periodo_id: periodoId,
      status: 'processando',
      etapa: 'Iniciando',
      progresso: 0,
      iniciado_em: new Date().toISOString(),
    };
    this.jobs.set(job.job_id, job);
    return job;
  }

  obterJob(jobId: string): JobCalculo {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundException('Job não encontrado.');
    return job;
  }

  /** Dispara o cálculo do período em background e devolve o job. */
  async iniciarCalculo(periodoId: number): Promise<JobCalculo> {
    const periodo = await this.obterPeriodo(periodoId);
    if (periodo.status === 'FECHADO') {
      throw new BadRequestException('Período fechado: reabra para recalcular.');
    }
    const job = this.criarJob(periodoId);
    // Sem await: roda em segundo plano.
    void this.processarCalculo(job, periodo);
    return job;
  }

  private async processarCalculo(job: JobCalculo, periodo: any): Promise<void> {
    const set = (etapa: string, progresso: number) => {
      job.etapa = etapa;
      job.progresso = progresso;
    };
    try {
      // Período derivado de ano/mes (strings AAAA-MM-DD) — NÃO da coluna DATE do
      // banco, que volta como meia-noite UTC e deslocaria o dia no fuso local.
      const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);

      set('Carregando configuração', 5);
      const cfg = await this.carregarConfiguracao(periodo.id, periodo.dias_corridos);

      set('Lendo VENDAS do Firebird', 20);
      const vendas = await this.firebird.lerVendas(dataIniYmd, dataFimYmd);
      set('Lendo SERVIÇOS do Firebird', 40);
      const servicos = await this.firebird.lerServicos(dataIniYmd, dataFimYmd);
      set('Lendo OS de serviço do Firebird', 55);
      const os = await this.firebird.lerOs(dataIniYmd, dataFimYmd);

      set('Lendo vendas do atacado (BI)', 60);
      const repsAtacado = await this.listarRepsAtacado();
      const atacadoCelulas = await this.atacado.lerCelulas(
        dataIniYmd,
        dataFimYmd,
        repsAtacado,
      );

      // Guarda o movimento em cache p/ permitir recalcular (ajuste de parâmetros)
      // sem reconsultar as origens.
      this.guardarCache(periodo.id, { vendas, servicos, os, atacado: atacadoCelulas });

      set('Calculando comissões', 70);
      const resultado = calcular(vendas, servicos, os, cfg);
      const cfgAtacado = await this.carregarConfiguracaoAtacado(
        periodo.id,
        periodo.dias_corridos,
      );
      const resultadoAtacado = calcularAtacado(atacadoCelulas, cfgAtacado);

      set('Gravando resultado', 85);
      await this.persistirResultado(periodo.id, resultado);
      await this.persistirResultadoAtacado(periodo.id, resultadoAtacado);

      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE dbo.ComissaoPeriodo
        SET status = 'CALCULADO', data_calculo = GETDATE()
        WHERE id = ${periodo.id}`);

      set('Concluído', 100);
      job.status = 'concluido';
      job.concluido_em = new Date().toISOString();
      job.resumo = {
        vendedores: resultado.vendedores.length,
        tecnicos: resultado.tecnicos.filter((t) => t.rep_codigo != null).length,
        atacado: resultadoAtacado.vendedores.length,
        total_comissao_vendedores: round2(
          resultado.vendedores.reduce((s, v) => s + v.valor_comissao, 0),
        ),
        total_comissao_tecnicos: round2(
          resultado.tecnicos.reduce((s, t) => s + t.total, 0),
        ),
        total_comissao_atacado: round2(
          resultadoAtacado.vendedores.reduce((s, v) => s + v.valor_comissao, 0),
        ),
        linhas_vendas: vendas.length,
        linhas_servico: servicos.length,
        linhas_os: os.length,
        celulas_atacado: atacadoCelulas.length,
      };
      this.logger.log(
        `Cálculo do período ${periodo.id} concluído: ${JSON.stringify(job.resumo)}`,
      );
    } catch (e) {
      job.status = 'erro';
      job.erro = e instanceof Error ? e.message : String(e);
      job.concluido_em = new Date().toISOString();
      this.logger.error(`Falha no cálculo do período ${periodo.id}: ${job.erro}`);
    }
  }

  /** Guarda o movimento em cache (limita o tamanho para não crescer sem fim). */
  private guardarCache(periodoId: number, mov: MovimentoCache): void {
    if (this.movimentoCache.size >= 12 && !this.movimentoCache.has(periodoId)) {
      const maisAntigo = this.movimentoCache.keys().next().value;
      if (maisAntigo !== undefined) this.movimentoCache.delete(maisAntigo);
    }
    this.movimentoCache.set(periodoId, mov);
  }

  /**
   * Salva os parâmetros manuais em lote e RECALCULA reusando o movimento já lido
   * (cache em memória) — sem reconsultar o Firebird. Se o cache estiver vazio
   * (ex.: serviço reiniciado), lê o Firebird uma vez e cacheia. Síncrono: como
   * normalmente não vai ao banco de origem, responde rápido com o resultado novo.
   */
  async recalcular(periodoId: number, parametros?: ParametroItemDto[]) {
    const periodo = await this.obterPeriodo(periodoId);
    if (periodo.status === 'FECHADO') {
      throw new BadRequestException('Período fechado: reabra para recalcular.');
    }

    if (parametros?.length) {
      for (const p of parametros) {
        await this.atualizarParametro(periodoId, p.rep_codigo, p);
      }
    }

    let mov = this.movimentoCache.get(periodoId);
    let fonte: 'cache' | 'firebird' = 'cache';
    if (!mov) {
      // Cache frio: busca uma vez (e cacheia para os próximos recálculos).
      const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);
      const vendas = await this.firebird.lerVendas(dataIniYmd, dataFimYmd);
      const servicos = await this.firebird.lerServicos(dataIniYmd, dataFimYmd);
      const os = await this.firebird.lerOs(dataIniYmd, dataFimYmd);
      const repsAtacado = await this.listarRepsAtacado();
      const atacado = await this.atacado.lerCelulas(dataIniYmd, dataFimYmd, repsAtacado);
      mov = { vendas, servicos, os, atacado };
      this.guardarCache(periodoId, mov);
      fonte = 'firebird';
    }

    const cfg = await this.carregarConfiguracao(periodoId, periodo.dias_corridos);
    const resultado = calcular(mov.vendas, mov.servicos, mov.os, cfg);
    const cfgAtacado = await this.carregarConfiguracaoAtacado(periodoId, periodo.dias_corridos);
    const resultadoAtacado = calcularAtacado(mov.atacado, cfgAtacado);
    await this.persistirResultado(periodoId, resultado);
    await this.persistirResultadoAtacado(periodoId, resultadoAtacado);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE dbo.ComissaoPeriodo SET status = 'CALCULADO', data_calculo = GETDATE()
      WHERE id = ${periodoId}`);

    const r = await this.consultarResultado(periodoId);
    const atacadoRes = await this.consultarResultadoAtacado(periodoId);
    return { ...r, atacado: atacadoRes, fonte };
  }

  /** Carrega config + parâmetros + cadastro para o engine. */
  private async carregarConfiguracao(
    periodoId: number,
    diasCorridos: number,
  ): Promise<ConfiguracaoCalculo> {
    const reps = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT rep_codigo, nome, calcula_comissao, inativo, especial, local_venda, papel
      FROM dbo.ComissaoRepresentante`);
    const representantes = new Map<number, Representante>();
    for (const r of reps) {
      representantes.set(Number(r.rep_codigo), {
        rep_codigo: Number(r.rep_codigo),
        nome: r.nome ?? null,
        calcula_comissao: !!r.calcula_comissao,
        inativo: !!r.inativo,
        especial: !!r.especial,
        local_venda: r.local_venda ?? null,
        papel: r.papel ?? null,
      });
    }

    const faixasRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT tipo_tabela, valor_min, valor_max, percentual
      FROM dbo.ComissaoFaixaPercentual WHERE ativo = 1
      ORDER BY tipo_tabela, valor_min`);
    const faixas: FaixaPercentual[] = faixasRows.map((f) => ({
      tipo_tabela: f.tipo_tabela,
      valor_min: Number(f.valor_min),
      valor_max: Number(f.valor_max),
      percentual: Number(f.percentual),
    }));

    const tipoRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT pro_codigo, tipo FROM dbo.ComissaoTipoProduto`);
    const tipoProduto = new Map<number, string>();
    for (const t of tipoRows) tipoProduto.set(Number(t.pro_codigo), t.tipo);

    const paramRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT rep_codigo, abatimento, tem_ferias, dias_ferias, pct_bonus
      FROM dbo.ComissaoParametroManual WHERE periodo_id = ${periodoId}`);
    const parametros = new Map<number, ParametroManual>();
    for (const p of paramRows) {
      parametros.set(Number(p.rep_codigo), {
        rep_codigo: Number(p.rep_codigo),
        abatimento: Number(p.abatimento),
        tem_ferias: !!p.tem_ferias,
        dias_ferias: Number(p.dias_ferias),
        pct_bonus: Number(p.pct_bonus),
      });
    }

    return { tipoProduto, faixas, representantes, parametros, diasCorridos };
  }

  /** Grava o snapshot (apaga e regrava o período). */
  private async persistirResultado(
    periodoId: number,
    r: ResultadoComissao,
  ): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM dbo.ComissaoMovimento WHERE periodo_id = ${periodoId}`,
    );
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM dbo.ComissaoResultadoVendedor WHERE periodo_id = ${periodoId}`,
    );
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM dbo.ComissaoResultadoTecnico WHERE periodo_id = ${periodoId}`,
    );

    for (const v of r.vendedores) {
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO dbo.ComissaoResultadoVendedor
          (periodo_id, rep_codigo, nome, especial, vendas, devolucao, frete, mao_obra,
           impostos, pintura, abatimento, media_ferias, dias_ferias, base_real, base_geral,
           percentual, valor_comissao, custo, lucratividade)
        VALUES
          (${periodoId}, ${v.rep_codigo}, ${v.nome}, ${v.especial}, ${round2(v.vendas)},
           ${round2(v.devolucao)}, ${round2(v.frete)}, ${round2(v.mao_obra)},
           ${round2(v.impostos)}, ${round2(v.pintura)}, ${round2(v.abatimento)},
           ${round2(v.media_ferias)}, ${v.dias_ferias}, ${round2(v.base_real)},
           ${round2(v.base_geral)}, ${round6(v.percentual)}, ${round2(v.valor_comissao)},
           ${round2(v.custo)}, ${v.lucratividade == null ? null : round6(v.lucratividade)})`);
    }

    for (const t of r.tecnicos) {
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO dbo.ComissaoResultadoTecnico
          (periodo_id, rep_codigo, nome, is_supervisor, valor_base, abatimento, base_calculo,
           percentual, valor_comissao, pct_bonus, valor_bonus, total)
        VALUES
          (${periodoId}, ${t.rep_codigo}, ${t.nome}, ${t.is_supervisor},
           ${round2(t.valor_base)}, ${round2(t.abatimento)}, ${round2(t.base_calculo)},
           ${round6(t.percentual)}, ${round2(t.valor_comissao)}, ${round6(t.pct_bonus)},
           ${round2(t.valor_bonus)}, ${round2(t.total)})`);
    }

    // Movimento (item-a-item) em lotes parametrizados.
    type Mov = (string | number | Date | null)[];
    const movs: Mov[] = [];
    for (const v of r.vendasCalculadas) {
      movs.push([
        periodoId, 'VENDAS', v.vendedor, v.nfs, v.nota_fiscal, v.dt_emissao,
        v.ordem_servico, v.cli_codigo, v.cli_nome, v.pro_codigo, v.pro_descricao,
        v.opf_codigo, num(v.quantidade), num(v.unitario), round2(v.total_produtos2),
        round2(v.total_desconto), round2(v.liquido), round2(v.custo), v.tipo,
      ]);
    }
    for (const s of r.servicosCalculados) {
      movs.push([
        periodoId, 'SERVICO', s.comissionado, s.nfs, s.nota_fiscal, s.dt_emissao,
        null, s.cli_codigo, s.cli_nome, s.pro_codigo, s.pro_descricao,
        null, num(s.quantidade), num(s.unitario), round2(s.total_produtos2),
        round2(s.total_desconto), round2(s.base_comissao), null, 'SERVICO',
      ]);
    }

    const COLS = Prisma.sql`(periodo_id, origem, rep_codigo, nfs, nota_fiscal, dt_emissao,
      ordem_servico, cli_codigo, cli_nome, pro_codigo, pro_descricao, opf_codigo,
      quantidade, unitario, total_produtos2, desconto, liquido, custo, tipo)`;
    const LOTE = 100;
    for (let i = 0; i < movs.length; i += LOTE) {
      const fatia = movs.slice(i, i + LOTE);
      const tuplas = fatia.map(
        (m) => Prisma.sql`(${Prisma.join(m)})`,
      );
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO dbo.ComissaoMovimento ${COLS} VALUES ${Prisma.join(tuplas)}`);
    }
  }

  /* ============================ CONSULTAS ============================== */

  async consultarResultado(periodoId: number) {
    await this.obterPeriodo(periodoId);
    const vendedores = await this.prisma.$queryRaw(Prisma.sql`
      SELECT * FROM dbo.ComissaoResultadoVendedor
      WHERE periodo_id = ${periodoId} ORDER BY vendas DESC`);
    const tecnicos = await this.prisma.$queryRaw(Prisma.sql`
      SELECT * FROM dbo.ComissaoResultadoTecnico
      WHERE periodo_id = ${periodoId}
      ORDER BY is_supervisor, valor_base DESC`);
    return { vendedores, tecnicos };
  }

  async relatorioVendas(periodoId: number, repCodigo: number) {
    await this.obterPeriodo(periodoId);
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT nfs, nota_fiscal, dt_emissao, cli_nome, pro_codigo, pro_descricao,
             quantidade, unitario, total_produtos2, desconto, liquido, tipo
      FROM dbo.ComissaoMovimento
      WHERE periodo_id = ${periodoId} AND origem = 'VENDAS' AND rep_codigo = ${repCodigo}
      ORDER BY dt_emissao, nfs`);
  }

  async relatorioServicos(periodoId: number, repCodigo: number) {
    await this.obterPeriodo(periodoId);
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT nfs, nota_fiscal, dt_emissao, cli_nome, pro_codigo, pro_descricao,
             quantidade, unitario, total_produtos2, desconto, liquido
      FROM dbo.ComissaoMovimento
      WHERE periodo_id = ${periodoId} AND origem = 'SERVICO' AND rep_codigo = ${repCodigo}
      ORDER BY dt_emissao, nfs`);
  }

  /* =========================== PARÂMETROS ============================== */

  async listarParametros(periodoId: number) {
    await this.obterPeriodo(periodoId);
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT p.rep_codigo, r.nome, r.papel, p.abatimento, p.tem_ferias, p.dias_ferias,
             p.pct_bonus, p.data_atualizacao
      FROM dbo.ComissaoParametroManual p
      LEFT JOIN dbo.ComissaoRepresentante r ON r.rep_codigo = p.rep_codigo
      WHERE p.periodo_id = ${periodoId}
      ORDER BY r.nome`);
  }

  /** Upsert dos parâmetros manuais de um representante no período. */
  async atualizarParametro(
    periodoId: number,
    repCodigo: number,
    dto: AtualizarParametroDto,
  ) {
    await this.obterPeriodo(periodoId);
    await this.prisma.$executeRaw(Prisma.sql`
      MERGE dbo.ComissaoParametroManual AS alvo
      USING (SELECT ${periodoId} AS periodo_id, ${repCodigo} AS rep_codigo) AS fonte
        ON alvo.periodo_id = fonte.periodo_id AND alvo.rep_codigo = fonte.rep_codigo
      WHEN MATCHED THEN UPDATE SET
        abatimento  = ${dto.abatimento ?? 0},
        tem_ferias  = ${dto.tem_ferias ?? false},
        dias_ferias = ${dto.dias_ferias ?? 0},
        pct_bonus   = ${dto.pct_bonus ?? 0},
        data_atualizacao = GETDATE()
      WHEN NOT MATCHED THEN
        INSERT (periodo_id, rep_codigo, abatimento, tem_ferias, dias_ferias, pct_bonus)
        VALUES (${periodoId}, ${repCodigo}, ${dto.abatimento ?? 0}, ${dto.tem_ferias ?? false},
                ${dto.dias_ferias ?? 0}, ${dto.pct_bonus ?? 0});`);
    return { ok: true };
  }

  /* ========================= REPRESENTANTES =========================== */

  async listarRepresentantes(q: ListarRepresentantesQuery) {
    const cond: Prisma.Sql[] = [];
    if (q.papel) cond.push(Prisma.sql`papel = ${q.papel}`);
    if (q.ativos) cond.push(Prisma.sql`calcula_comissao = 1 AND inativo = 0`);
    if (q.busca) {
      const termo = `%${q.busca}%`;
      cond.push(Prisma.sql`(nome LIKE ${termo} OR CAST(rep_codigo AS VARCHAR(20)) LIKE ${termo})`);
    }
    const where = cond.length
      ? Prisma.sql`WHERE ${Prisma.join(cond, ' AND ')}`
      : Prisma.empty;
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT rep_codigo, nome, calcula_comissao, inativo, especial, local_venda, papel,
             data_atualizacao
      FROM dbo.ComissaoRepresentante ${where}
      ORDER BY nome`);
  }

  /** Edita as colunas mantidas manualmente (especial/local_venda/papel). */
  async atualizarRepresentante(repCodigo: number, dto: AtualizarRepresentanteDto) {
    const sets: Prisma.Sql[] = [];
    if (dto.especial !== undefined) sets.push(Prisma.sql`especial = ${dto.especial}`);
    if (dto.local_venda !== undefined)
      sets.push(Prisma.sql`local_venda = ${dto.local_venda}`);
    if (dto.papel !== undefined) sets.push(Prisma.sql`papel = ${dto.papel}`);
    if (dto.inativo !== undefined) sets.push(Prisma.sql`inativo = ${dto.inativo}`);
    if (!sets.length) throw new BadRequestException('Nada a atualizar.');
    sets.push(Prisma.sql`data_atualizacao = GETDATE()`);
    const r = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE dbo.ComissaoRepresentante SET ${Prisma.join(sets, ', ')}
      WHERE rep_codigo = ${repCodigo}`);
    if (!r) throw new NotFoundException('Representante não encontrado.');
    return { ok: true };
  }

  /* ===== Histórico de canal de venda do representante (vigência) ===== */

  /** Lista as mudanças de canal de um representante (mais recente primeiro). */
  async listarCanalHist(repCodigo: number) {
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT id, rep_codigo, canal, CONVERT(varchar(10), vigente_de, 23) AS vigente_de
      FROM dbo.ComissaoRepresentanteCanal
      WHERE rep_codigo = ${repCodigo}
      ORDER BY vigente_de DESC, id DESC`);
  }

  /** Adiciona uma mudança de canal (a partir de uma data). */
  async adicionarCanalHist(repCodigo: number, dto: CanalHistDto) {
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO dbo.ComissaoRepresentanteCanal (rep_codigo, canal, vigente_de)
      VALUES (${repCodigo}, ${dto.canal}, ${dto.vigente_de})`);
    return { ok: true };
  }

  /** Remove uma mudança de canal pelo id. */
  async removerCanalHist(id: number) {
    const r = await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM dbo.ComissaoRepresentanteCanal WHERE id = ${id}`);
    if (!r) throw new NotFoundException('Registro não encontrado.');
    return { ok: true };
  }

  /**
   * Sincroniza nome/calcula_comissao do Firebird (tabela representantes) SEM tocar
   * nas colunas mantidas manualmente (especial/local_venda/papel) NEM em `inativo`
   * de quem já existe — o ativo/inativo passa a ser controlado na tela de comissões
   * (o Firebird só define o valor inicial de reps novos).
   */
  async sincronizarRepresentantes() {
    const inner = `SELECT rep_codigo, rep_nome, calcula_comissao, inativo
                   FROM representantes WHERE empresa = 3`;
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM OPENQUERY(CONSULTA, '${inner.replace(/'/g, "''")}')`,
    );
    let upserts = 0;
    for (const r of rows) {
      const cod = Number(r.REP_CODIGO ?? r.rep_codigo);
      if (!Number.isInteger(cod)) continue;
      const nome = (r.REP_NOME ?? r.rep_nome ?? null) as string | null;
      const calc = String(r.CALCULA_COMISSAO ?? r.calcula_comissao ?? '').toUpperCase() === 'S';
      const inat = String(r.INATIVO ?? r.inativo ?? '').toUpperCase() === 'S';
      await this.prisma.$executeRaw(Prisma.sql`
        MERGE dbo.ComissaoRepresentante AS alvo
        USING (SELECT ${cod} AS rep_codigo) AS fonte
          ON alvo.rep_codigo = fonte.rep_codigo
        WHEN MATCHED THEN UPDATE SET
          nome = ${nome}, calcula_comissao = ${calc},
          data_atualizacao = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (rep_codigo, nome, calcula_comissao, inativo)
          VALUES (${cod}, ${nome}, ${calc}, ${inat});`);
      upserts += 1;
    }
    this.logger.log(`Sincronização de representantes: ${upserts} registros.`);
    return { sincronizados: upserts };
  }

  /* ============================== CONFIG ============================== */

  async listarFaixas() {
    return this.prisma.$queryRaw`
      SELECT id, tipo_tabela, valor_min, valor_max, percentual, ativo
      FROM dbo.ComissaoFaixaPercentual ORDER BY tipo_tabela, valor_min`;
  }

  async listarTiposProduto() {
    return this.prisma.$queryRaw`
      SELECT pro_codigo, tipo, descricao FROM dbo.ComissaoTipoProduto ORDER BY tipo, pro_codigo`;
  }

  /* ============================== ATACADO ============================== */

  /** Códigos dos representantes de atacado ativos (local_venda='ATACADO'). */
  private async listarRepsAtacado(): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT rep_codigo FROM dbo.ComissaoRepresentante
      WHERE local_venda = 'ATACADO' AND inativo = 0`);
    return rows.map((r) => Number(r.rep_codigo)).filter((n) => Number.isInteger(n));
  }

  /** Faixas (mix23/mix1), meta, cadastro e parâmetros do atacado. */
  private async carregarConfiguracaoAtacado(
    periodoId: number,
    diasCorridos: number,
  ): Promise<ConfiguracaoAtacado> {
    const repsRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT rep_codigo, nome, inativo
      FROM dbo.ComissaoRepresentante WHERE local_venda = 'ATACADO'`);
    const representantes = new Map<number, RepresentanteAtacado>();
    for (const r of repsRows) {
      representantes.set(Number(r.rep_codigo), {
        rep_codigo: Number(r.rep_codigo),
        nome: r.nome ?? null,
        inativo: !!r.inativo,
      });
    }

    const mix23Rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT valor_min, valor_max, percentual
      FROM dbo.ComissaoAtacadoFaixaMix23 WHERE ativo = 1 ORDER BY valor_max`);
    const faixasMix23: FaixaMix23[] = mix23Rows.map((f) => ({
      valor_min: Number(f.valor_min),
      valor_max: Number(f.valor_max),
      percentual: Number(f.percentual),
    }));

    const mix1Rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT faixa, atingiu_meta, percentual
      FROM dbo.ComissaoAtacadoFaixaMix1 WHERE ativo = 1`);
    const faixasMix1: FaixaMix1[] = mix1Rows.map((f) => ({
      faixa: String(f.faixa ?? '').trim().toUpperCase(),
      atingiu_meta: !!f.atingiu_meta,
      percentual: Number(f.percentual),
    }));

    const metaRows = await this.prisma.$queryRaw<any[]>(
      Prisma.sql`SELECT meta_mix1 FROM dbo.ComissaoAtacadoConfig WHERE id = 1`,
    );
    const metaMix1 = metaRows.length ? Number(metaRows[0].meta_mix1) : 0.3;

    const paramRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT rep_codigo, abatimento, tem_ferias, dias_ferias
      FROM dbo.ComissaoParametroManual WHERE periodo_id = ${periodoId}`);
    const parametros = new Map<number, ParametroAtacado>();
    for (const p of paramRows) {
      parametros.set(Number(p.rep_codigo), {
        rep_codigo: Number(p.rep_codigo),
        abatimento: Number(p.abatimento),
        tem_ferias: !!p.tem_ferias,
        dias_ferias: Number(p.dias_ferias),
      });
    }

    return { faixasMix23, faixasMix1, metaMix1, representantes, parametros, diasCorridos };
  }

  /** Grava o snapshot do atacado (apaga e regrava o período). */
  private async persistirResultadoAtacado(
    periodoId: number,
    r: ResultadoComissaoAtacado,
  ): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM dbo.ComissaoAtacadoDetalhe WHERE periodo_id = ${periodoId}`,
    );
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM dbo.ComissaoResultadoAtacado WHERE periodo_id = ${periodoId}`,
    );

    for (const v of r.vendedores) {
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO dbo.ComissaoResultadoAtacado
          (periodo_id, rep_codigo, nome, total_vendido, total_mix1, pct_mix1, atingiu_meta,
           abatimento, base_real, dias_ferias, media_ferias, total_faixa, pct_mix23,
           comissao_bruta, fator_abatimento, valor_comissao)
        VALUES
          (${periodoId}, ${v.rep_codigo}, ${v.nome}, ${round2(v.total_vendido)},
           ${round2(v.total_mix1)}, ${round6(v.pct_mix1)}, ${v.atingiu_meta},
           ${round2(v.abatimento)}, ${round2(v.base_real)}, ${v.dias_ferias},
           ${round2(v.media_ferias)}, ${round2(v.total_faixa)}, ${round6(v.pct_mix23)},
           ${round2(v.comissao_bruta)}, ${round6(v.fator_abatimento)}, ${round2(v.valor_comissao)})`);
    }

    type Det = (string | number)[];
    const dets: Det[] = r.detalhe.map((d) => [
      periodoId, d.rep_codigo, d.mix, d.faixa, round2(d.valor_vendido),
      round6(d.pct_comissao), round2(d.valor_comissao),
    ]);
    const COLS = Prisma.sql`(periodo_id, rep_codigo, mix, faixa, valor_vendido, pct_comissao, valor_comissao)`;
    const LOTE = 100;
    for (let i = 0; i < dets.length; i += LOTE) {
      const fatia = dets.slice(i, i + LOTE);
      const tuplas = fatia.map((m) => Prisma.sql`(${Prisma.join(m)})`);
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO dbo.ComissaoAtacadoDetalhe ${COLS} VALUES ${Prisma.join(tuplas)}`);
    }
  }

  /** Snapshot calculado do atacado (um registro por vendedor). */
  async consultarResultadoAtacado(periodoId: number) {
    await this.obterPeriodo(periodoId);
    return this.prisma.$queryRaw(Prisma.sql`
      SELECT * FROM dbo.ComissaoResultadoAtacado
      WHERE periodo_id = ${periodoId} ORDER BY total_vendido DESC`);
  }

  /**
   * Relatório de assinatura do atacado: resumo + quebra mix x faixa (totalização)
   * + relação de vendas por item (espelha a 443). O % de cada item usa as MESMAS
   * alíquotas do cálculo (pct_mix23 já ajustado por férias; mix 1 pela faixa
   * conforme atingiu_meta) para a soma dos itens fechar com a comissão bruta.
   */
  async relatorioAtacado(periodoId: number, repCodigo: number) {
    const periodo = await this.obterPeriodo(periodoId);
    const resumoRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT * FROM dbo.ComissaoResultadoAtacado
      WHERE periodo_id = ${periodoId} AND rep_codigo = ${repCodigo}`);
    const resumo = resumoRows[0] ?? null;
    const detalhe = await this.prisma.$queryRaw(Prisma.sql`
      SELECT mix, faixa, valor_vendido, pct_comissao, valor_comissao
      FROM dbo.ComissaoAtacadoDetalhe
      WHERE periodo_id = ${periodoId} AND rep_codigo = ${repCodigo}
      ORDER BY mix,
        CASE faixa WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 9 END`);

    let itens: any[] = [];
    if (resumo) {
      const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);
      const cfg = await this.carregarConfiguracaoAtacado(periodoId, periodo.dias_corridos);
      const pctMix23 = Number(resumo.pct_mix23);
      const atingiuMeta = !!resumo.atingiu_meta;
      const raw = await this.atacado.lerItensRep(dataIniYmd, dataFimYmd, repCodigo);
      itens = raw.map((it) => {
        const pct =
          it.mix === 1
            ? percentualMix1(it.faixa, atingiuMeta, cfg.faixasMix1)
            : it.mix === 2 || it.mix === 3
              ? pctMix23
              : 0;
        return {
          dt_emissao: it.dt_emissao,
          cli_codigo: it.cli_codigo,
          cli_nome: it.cli_nome,
          pro_codigo: it.pro_codigo,
          pro_descricao: it.pro_descricao,
          liquido_produto: round2(it.liquido_produto),
          mix: it.mix,
          faixa: it.faixa,
          pct_comissao: round6(pct),
          valor_comissao: round2(it.liquido_produto * pct),
        };
      });
    }

    return { resumo, detalhe, itens };
  }

  /** Tabelas de alíquota do atacado (config editável). */
  async listarFaixasAtacado() {
    const mix23 = await this.prisma.$queryRaw(Prisma.sql`
      SELECT id, valor_min, valor_max, percentual, ativo
      FROM dbo.ComissaoAtacadoFaixaMix23 ORDER BY valor_max`);
    const mix1 = await this.prisma.$queryRaw(Prisma.sql`
      SELECT id, faixa, atingiu_meta, percentual, ativo
      FROM dbo.ComissaoAtacadoFaixaMix1
      ORDER BY atingiu_meta, faixa`);
    const cfg = await this.prisma.$queryRaw<any[]>(
      Prisma.sql`SELECT meta_mix1 FROM dbo.ComissaoAtacadoConfig WHERE id = 1`,
    );
    return { mix23, mix1, meta_mix1: cfg.length ? Number(cfg[0].meta_mix1) : 0.3 };
  }

  /** Edita em lote as tabelas de alíquota do atacado (mix23/mix1/meta). */
  async atualizarFaixasAtacado(dto: {
    mix23?: { id: number; valor_min?: number; valor_max?: number; percentual?: number; ativo?: boolean }[];
    mix1?: { id: number; percentual?: number; ativo?: boolean }[];
    meta_mix1?: number;
  }) {
    for (const f of dto.mix23 ?? []) {
      const sets: Prisma.Sql[] = [];
      if (f.valor_min !== undefined) sets.push(Prisma.sql`valor_min = ${f.valor_min}`);
      if (f.valor_max !== undefined) sets.push(Prisma.sql`valor_max = ${f.valor_max}`);
      if (f.percentual !== undefined) sets.push(Prisma.sql`percentual = ${f.percentual}`);
      if (f.ativo !== undefined) sets.push(Prisma.sql`ativo = ${f.ativo}`);
      if (sets.length)
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE dbo.ComissaoAtacadoFaixaMix23 SET ${Prisma.join(sets, ', ')} WHERE id = ${f.id}`);
    }
    for (const f of dto.mix1 ?? []) {
      const sets: Prisma.Sql[] = [];
      if (f.percentual !== undefined) sets.push(Prisma.sql`percentual = ${f.percentual}`);
      if (f.ativo !== undefined) sets.push(Prisma.sql`ativo = ${f.ativo}`);
      if (sets.length)
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE dbo.ComissaoAtacadoFaixaMix1 SET ${Prisma.join(sets, ', ')} WHERE id = ${f.id}`);
    }
    if (dto.meta_mix1 !== undefined) {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE dbo.ComissaoAtacadoConfig
        SET meta_mix1 = ${dto.meta_mix1}, data_atualizacao = GETDATE() WHERE id = 1`);
    }
    return this.listarFaixasAtacado();
  }
}

/* ------------------------------- helpers ----------------------------------- */

/** Datas do período comissional: 26 do mês anterior a 25 do mês da competência. */
export function calcularDatasPeriodo(ano: number, mes: number) {
  const iniAno = mes === 1 ? ano - 1 : ano;
  const iniMes = mes === 1 ? 12 : mes - 1;
  const dataIniYmd = `${iniAno}-${String(iniMes).padStart(2, '0')}-26`;
  const dataFimYmd = `${ano}-${String(mes).padStart(2, '0')}-25`;
  const diasCorridos =
    Math.round(
      (Date.UTC(ano, mes - 1, 25) - Date.UTC(iniAno, iniMes - 1, 26)) / 86400000,
    ) + 1;
  return { dataIniYmd, dataFimYmd, diasCorridos };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(v: number): number {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}
function round6(v: number): number {
  return Math.round((num(v) + Number.EPSILON) * 1e6) / 1e6;
}
