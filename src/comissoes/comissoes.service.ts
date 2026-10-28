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
  dataYmdUtc,
  dentroDaJanela,
  janelaFerias,
} from './calculo-engine';
import { CamposFerias, FeriasPeriodo, FeriasRow, camposFerias, feriasNoPeriodo } from './ferias';
import {
  CelulaAtacado,
  ConfiguracaoAtacado,
  DegrauMix1,
  FaixaMix1,
  FaixaMix23,
  ParametroAtacado,
  RepresentanteAtacado,
  ResultadoComissaoAtacado,
  calcularAtacado,
  percentualMix1,
} from './atacado-engine';
import {
  ResultadoSupervisorAtacado,
  calcularSupervisorAtacado,
  pctSupervisorAtacado,
} from './supervisor-atacado-engine';
import {
  AbrirPeriodoDto,
  AtualizarParametroDto,
  AtualizarRepresentanteDto,
  CanalHistDto,
  ListarRepresentantesQuery,
  ParametroItemDto,
  SalvarPontoDto,
} from './comissoes.dto';
import { extrairCartaoPonto } from './extrator-ponto';

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
  /**
   * Fila por período: dois recálculos simultâneos (ex.: duplo clique, salvar
   * ponto + parâmetros) intercalavam o apaga-e-regrava dos snapshots e
   * estouravam as UNIQUEs (periodo_id, rep_codigo). Aqui cada recálculo espera
   * o anterior do MESMO período terminar.
   */
  private readonly filaPorPeriodo = new Map<number, Promise<unknown>>();

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
      const cfg = await this.carregarConfiguracao(periodo);

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
      const cfgAtacado = await this.carregarConfiguracaoAtacado(periodo);
      const resultadoAtacado = calcularAtacado(atacadoCelulas, cfgAtacado);
      const resultadoSupervisor = await this.calcularSupervisorAtacado(
        periodo,
        atacadoCelulas,
        repsAtacado,
      );

      set('Gravando resultado', 85);
      // Persistência na fila do período: não intercala com um recálculo
      // disparado em paralelo (apaga-e-regrava dos mesmos snapshots).
      await this.serializadoPorPeriodo(periodo.id, async () => {
        await this.persistirResultado(periodo.id, resultado);
        await this.persistirResultadoAtacado(periodo.id, resultadoAtacado);
        await this.persistirResultadoSupervisorAtacado(periodo.id, resultadoSupervisor);
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE dbo.ComissaoPeriodo
          SET status = 'CALCULADO', data_calculo = GETDATE()
          WHERE id = ${periodo.id}`);
      });

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
        total_comissao_supervisor_atacado: round2(
          resultadoSupervisor?.resumo.comissao_total ?? 0,
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
    return this.serializadoPorPeriodo(periodoId, () =>
      this.recalcularInterno(periodoId, parametros),
    );
  }

  /** Executa um trabalho na fila do período (um por vez por competência). */
  private serializadoPorPeriodo<T>(
    periodoId: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const anterior = this.filaPorPeriodo.get(periodoId) ?? Promise.resolve();
    const execucao = anterior.then(fn, fn); // roda mesmo se o anterior falhou
    this.filaPorPeriodo.set(periodoId, execucao.catch(() => undefined));
    return execucao;
  }

  private async recalcularInterno(periodoId: number, parametros?: ParametroItemDto[]) {
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

    const cfg = await this.carregarConfiguracao(periodo);
    const resultado = calcular(mov.vendas, mov.servicos, mov.os, cfg);
    const cfgAtacado = await this.carregarConfiguracaoAtacado(periodo);
    const resultadoAtacado = calcularAtacado(mov.atacado, cfgAtacado);
    const resultadoSupervisor = await this.calcularSupervisorAtacado(
      periodo,
      mov.atacado,
      await this.listarRepsAtacado(),
    );
    await this.persistirResultado(periodoId, resultado);
    await this.persistirResultadoAtacado(periodoId, resultadoAtacado);
    await this.persistirResultadoSupervisorAtacado(periodoId, resultadoSupervisor);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE dbo.ComissaoPeriodo SET status = 'CALCULADO', data_calculo = GETDATE()
      WHERE id = ${periodoId}`);

    const r = await this.consultarResultado(periodoId);
    const atacadoRes = await this.consultarResultadoAtacado(periodoId);
    const supervisorRes = await this.consultarResultadoSupervisorAtacado(periodoId);
    return { ...r, atacado: atacadoRes, supervisor_atacado: supervisorRes, fonte };
  }

  /** Carrega config + parâmetros + cadastro para o engine. */
  private async carregarConfiguracao(periodo: {
    id: number;
    ano: number;
    mes: number;
    dias_corridos: number;
  }): Promise<ConfiguracaoCalculo> {
    const periodoId = Number(periodo.id);
    const diasCorridos = Number(periodo.dias_corridos);
    const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);
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

    // Datas de férias em varchar (CONVERT 23) para não deslocar o dia no fuso.
    const paramRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT rep_codigo, abatimento, abatimento_motivo, tem_ferias, dias_ferias, pct_bonus,
             CONVERT(varchar(10), ferias_inicio, 23) AS ferias_inicio,
             CONVERT(varchar(10), ferias_fim, 23)    AS ferias_fim
      FROM dbo.ComissaoParametroManual WHERE periodo_id = ${periodoId}`);
    const parametros = new Map<number, ParametroManual>();
    for (const p of paramRows) {
      parametros.set(Number(p.rep_codigo), {
        rep_codigo: Number(p.rep_codigo),
        abatimento: Number(p.abatimento),
        abatimento_motivo: p.abatimento_motivo ?? null,
        tem_ferias: !!p.tem_ferias,
        dias_ferias: Number(p.dias_ferias),
        ferias_inicio: p.ferias_inicio ?? null,
        ferias_fim: p.ferias_fim ?? null,
        pct_bonus: Number(p.pct_bonus),
      });
    }
    this.aplicarFerias(parametros, await this.feriasDoPeriodo(dataIniYmd, dataFimYmd), (rep) => ({
      rep_codigo: rep, abatimento: 0, abatimento_motivo: null, tem_ferias: false, dias_ferias: 0,
      ferias_inicio: null, ferias_fim: null, pct_bonus: 0,
    }));

    const pontoExclusoes = await this.carregarPontoExclusoes(periodoId);

    return {
      tipoProduto,
      faixas,
      representantes,
      parametros,
      pontoExclusoes,
      diasCorridos,
      periodoIni: dataIniYmd,
      periodoFim: dataFimYmd,
    };
  }

  /**
   * Férias (dbo.ComissaoFerias) que cruzam o período, recortadas a ele. null = tabela
   * indisponível (SQL 08 não aplicado): aí valem as férias da linha do período.
   */
  private async feriasDoPeriodo(dataIniYmd: string, dataFimYmd: string): Promise<Map<number, FeriasPeriodo> | null> {
    try {
      const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT rep_codigo,
               CONVERT(varchar(10), ferias_inicio, 23) AS ferias_inicio,
               CONVERT(varchar(10), ferias_fim, 23)    AS ferias_fim
        FROM dbo.ComissaoFerias
        WHERE ferias_inicio <= ${dataFimYmd} AND ferias_fim >= ${dataIniYmd}
        ORDER BY rep_codigo, ferias_inicio`);
      const linhas = rows.map((r): FeriasRow => ({
        rep_codigo: Number(r.rep_codigo),
        ferias_inicio: String(r.ferias_inicio),
        ferias_fim: String(r.ferias_fim),
      }));
      return feriasNoPeriodo(linhas, dataIniYmd, dataFimYmd);
    } catch (e) {
      this.logger.warn(
        `Tabela de férias indisponível (dbo.ComissaoFerias não aplicada?); usando as férias da linha do período: ${(e as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Escreve as férias do período nos parâmetros manuais: quem está na tabela de
   * férias ganha os dias recortados (mesmo sem linha de parâmetros no período);
   * quem não está fica só com a contagem antiga de dias, se houver.
   */
  private aplicarFerias<T extends { rep_codigo: number } & Partial<CamposFerias>>(
    parametros: Map<number, T>,
    ferias: Map<number, FeriasPeriodo> | null,
    vazio: (rep: number) => T,
  ) {
    if (!ferias) return;
    for (const [rep, p] of parametros) Object.assign(p, camposFerias(ferias.get(rep), p));
    for (const [rep, f] of ferias) {
      if (!parametros.has(rep)) parametros.set(rep, Object.assign(vazio(rep), camposFerias(f, undefined)));
    }
  }

  /** Dias de FALTA/DISPENSA do cartão ponto: rep -> (YYYY-MM-DD -> motivo). */
  private async carregarPontoExclusoes(
    periodoId: number,
  ): Promise<Map<number, Map<string, string>>> {
    // CONVERT em varchar evita o vaivém de fuso do tipo DATE no driver.
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT rep_codigo, CONVERT(varchar(10), data, 23) AS data, motivo
      FROM dbo.ComissaoPontoDia WHERE periodo_id = ${periodoId}`);
    const mapa = new Map<number, Map<string, string>>();
    for (const r of rows) {
      const cod = Number(r.rep_codigo);
      if (!mapa.has(cod)) mapa.set(cod, new Map());
      mapa.get(cod)!.set(String(r.data), String(r.motivo));
    }
    return mapa;
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
           impostos, pintura, excluido_ponto, itens_excluidos_ponto, dias_falta,
           dias_dispensa, abatimento, abatimento_motivo, media_ferias, dias_ferias,
           base_real, base_geral,
           percentual, valor_comissao, custo, lucratividade)
        VALUES
          (${periodoId}, ${v.rep_codigo}, ${v.nome}, ${v.especial}, ${round2(v.vendas)},
           ${round2(v.devolucao)}, ${round2(v.frete)}, ${round2(v.mao_obra)},
           ${round2(v.impostos)}, ${round2(v.pintura)}, ${round2(v.excluido_ponto)},
           ${v.itens_excluidos_ponto}, ${v.dias_falta}, ${v.dias_dispensa},
           ${round2(v.abatimento)}, ${v.abatimento_motivo},
           ${round2(v.media_ferias)}, ${v.dias_ferias}, ${round2(v.base_real)},
           ${round2(v.base_geral)}, ${round6(v.percentual)}, ${round2(v.valor_comissao)},
           ${round2(v.custo)}, ${v.lucratividade == null ? null : round6(v.lucratividade)})`);
    }

    for (const t of r.tecnicos) {
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO dbo.ComissaoResultadoTecnico
          (periodo_id, rep_codigo, nome, is_supervisor, valor_base, excluido_ferias,
           dias_ferias, ferias_inicio, ferias_fim, abatimento,
           abatimento_motivo, base_calculo,
           percentual, valor_comissao, pct_bonus, valor_bonus, total)
        VALUES
          (${periodoId}, ${t.rep_codigo}, ${t.nome}, ${t.is_supervisor},
           ${round2(t.valor_base)}, ${round2(t.excluido_ferias)}, ${t.dias_ferias},
           ${vdate(t.ferias_inicio)}, ${vdate(t.ferias_fim)}, ${round2(t.abatimento)},
           ${t.abatimento_motivo}, ${round2(t.base_calculo)},
           ${round6(t.percentual)}, ${round2(t.valor_comissao)}, ${round6(t.pct_bonus)},
           ${round2(t.valor_bonus)}, ${round2(t.total)})`);
    }

    // Movimento (item-a-item) em lotes parametrizados.
    //
    // ⚠️ As colunas VARCHAR anuláveis vão com CAST explícito: no VALUES
    // multi-linha o SQL Server unifica o tipo de cada posição entre as linhas
    // e o driver tipa NULL como int — misturar 'FALTA' (linha excluída) com
    // NULL (linha normal) fazia o int vencer por precedência e estourar a
    // conversão (erro 245). O CAST fixa o tipo da posição em varchar.
    const vchar = (v: string | null, tam: number) =>
      Prisma.sql`CAST(${v} AS varchar(${Prisma.raw(String(tam))}))`;
    const movs: Prisma.Sql[] = [];
    for (const v of r.vendasCalculadas) {
      movs.push(Prisma.sql`(${periodoId}, 'VENDAS', ${v.vendedor}, ${v.nfs},
        ${vchar(v.nota_fiscal, 50)}, ${v.dt_emissao}, ${vchar(v.ordem_servico, 50)},
        ${v.cli_codigo}, ${vchar(v.cli_nome, 200)}, ${v.pro_codigo},
        ${vchar(v.pro_descricao, 250)}, ${v.opf_codigo}, ${num(v.quantidade)},
        ${num(v.unitario)}, ${round2(v.total_produtos2)}, ${round2(v.total_desconto)},
        ${round2(v.liquido)}, ${round2(v.custo)}, ${v.tipo}, ${v.excluido_ponto},
        ${vchar(v.excluido_motivo, 20)})`);
    }
    for (const s of r.servicosCalculados) {
      movs.push(Prisma.sql`(${periodoId}, 'SERVICO', ${s.comissionado}, ${s.nfs},
        ${vchar(s.nota_fiscal, 50)}, ${s.dt_emissao}, ${vchar(null, 50)},
        ${s.cli_codigo}, ${vchar(s.cli_nome, 200)}, ${s.pro_codigo},
        ${vchar(s.pro_descricao, 250)}, ${null}, ${num(s.quantidade)},
        ${num(s.unitario)}, ${round2(s.total_produtos2)}, ${round2(s.total_desconto)},
        ${round2(s.base_comissao)}, ${null}, ${'SERVICO'}, ${false},
        ${vchar(null, 20)})`);
    }

    const COLS = Prisma.sql`(periodo_id, origem, rep_codigo, nfs, nota_fiscal, dt_emissao,
      ordem_servico, cli_codigo, cli_nome, pro_codigo, pro_descricao, opf_codigo,
      quantidade, unitario, total_produtos2, desconto, liquido, custo, tipo,
      excluido_ponto, excluido_motivo)`;
    // 20 parâmetros/linha (origem é literal): teto de 2100 parâmetros por lote.
    const LOTE = 90;
    for (let i = 0; i < movs.length; i += LOTE) {
      const fatia = movs.slice(i, i + LOTE);
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO dbo.ComissaoMovimento ${COLS} VALUES ${Prisma.join(fatia)}`);
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
             quantidade, unitario, total_produtos2, desconto, liquido, tipo,
             excluido_ponto, excluido_motivo
      FROM dbo.ComissaoMovimento
      WHERE periodo_id = ${periodoId} AND origem = 'VENDAS' AND rep_codigo = ${repCodigo}
      ORDER BY dt_emissao, nfs`);
  }

  async relatorioServicos(periodoId: number, repCodigo: number) {
    await this.obterPeriodo(periodoId);
    // O supervisor da oficina (Bruno) comissiona 0,65% sobre TODA a base de
    // serviço — e o código dele (sentinela) não tem serviço atribuído. Então,
    // para o supervisor, o relatório lista o serviço INTEIRO do período (sem
    // filtrar por rep_codigo); para os demais técnicos, só o serviço deles.
    const ehSupervisor = await this.repEhSupervisorOficina(repCodigo);
    const filtroRep = ehSupervisor
      ? Prisma.empty
      : Prisma.sql`AND rep_codigo = ${repCodigo}`;
    const linhas = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT nfs, nota_fiscal, dt_emissao, cli_nome, pro_codigo, pro_descricao,
             quantidade, unitario, total_produtos2, desconto, liquido
      FROM dbo.ComissaoMovimento
      WHERE periodo_id = ${periodoId} AND origem = 'SERVICO' ${filtroRep}
      ORDER BY dt_emissao, nfs`);
    if (!ehSupervisor) return linhas;

    // Supervisor de férias: o serviço emitido na janela saiu da base dele.
    // A linha do movimento é compartilhada com os técnicos, então a marcação
    // é feita aqui (só no relatório do supervisor), a partir do snapshot.
    const ferias = await this.janelaFeriasSupervisorOficina(periodoId);
    return linhas.map((l) => {
      const excluido = dentroDaJanela(dataYmdUtc(l.dt_emissao ?? null), ferias);
      return {
        ...l,
        excluido_ponto: excluido,
        excluido_motivo: excluido ? 'FERIAS' : null,
      };
    });
  }

  /** Janela de férias gravada no snapshot do supervisor da oficina (ou null). */
  private async janelaFeriasSupervisorOficina(periodoId: number) {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT CONVERT(varchar(10), ferias_inicio, 23) AS ferias_inicio,
             CONVERT(varchar(10), ferias_fim, 23)    AS ferias_fim
      FROM dbo.ComissaoResultadoTecnico
      WHERE periodo_id = ${periodoId} AND is_supervisor = 1`);
    const r = rows[0];
    if (!r?.ferias_inicio || !r?.ferias_fim) return null;
    return janelaFerias({
      tem_ferias: true,
      ferias_inicio: String(r.ferias_inicio),
      ferias_fim: String(r.ferias_fim),
    });
  }

  /** True se o rep é o supervisor da oficina (papel='SUPERVISOR'). */
  private async repEhSupervisorOficina(repCodigo: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT 1 AS ok FROM dbo.ComissaoRepresentante
      WHERE rep_codigo = ${repCodigo} AND papel = 'SUPERVISOR'`);
    return rows.length > 0;
  }

  /* =========================== PARÂMETROS ============================== */

  async listarParametros(periodoId: number) {
    const periodo = await this.obterPeriodo(periodoId);
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT p.rep_codigo, r.nome, r.papel, p.abatimento, p.abatimento_motivo,
             p.tem_ferias, p.dias_ferias, p.pct_bonus, p.data_atualizacao,
             CONVERT(varchar(10), p.ferias_inicio, 23) AS ferias_inicio,
             CONVERT(varchar(10), p.ferias_fim, 23)    AS ferias_fim
      FROM dbo.ComissaoParametroManual p
      LEFT JOIN dbo.ComissaoRepresentante r ON r.rep_codigo = p.rep_codigo
      WHERE p.periodo_id = ${periodoId}
      ORDER BY r.nome`);
    const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);
    const ferias = await this.feriasDoPeriodo(dataIniYmd, dataFimYmd);
    if (!ferias) return rows;
    // A tela recebe a janela como foi digitada e os dias que caem neste período.
    const lista = rows.map((p) => {
      const f = ferias.get(Number(p.rep_codigo));
      const c = camposFerias(f, {
        tem_ferias: !!p.tem_ferias,
        dias_ferias: Number(p.dias_ferias),
        ferias_inicio: p.ferias_inicio ?? null,
      });
      return {
        ...p,
        tem_ferias: c.tem_ferias,
        dias_ferias: c.dias_ferias,
        ferias_inicio: f?.janela_inicio ?? null,
        ferias_fim: f?.janela_fim ?? null,
      };
    });
    // Férias digitadas em outro mês que avançam para este: rep sem linha de parâmetros aqui.
    const faltam = [...ferias.keys()].filter((rep) => !rows.some((p) => Number(p.rep_codigo) === rep));
    if (faltam.length) {
      const nomes = await this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT rep_codigo, nome, papel FROM dbo.ComissaoRepresentante
        WHERE rep_codigo IN (${Prisma.join(faltam)})`);
      for (const rep of faltam) {
        const f = ferias.get(rep)!;
        const r = nomes.find((x) => Number(x.rep_codigo) === rep);
        lista.push({
          rep_codigo: rep, nome: r?.nome ?? null, papel: r?.papel ?? null,
          abatimento: 0, abatimento_motivo: null, tem_ferias: true, dias_ferias: f.dias,
          pct_bonus: 0, data_atualizacao: null, ferias_inicio: f.janela_inicio, ferias_fim: f.janela_fim,
        });
      }
    }
    return lista;
  }

  /** Upsert dos parâmetros manuais de um representante no período. */
  async atualizarParametro(
    periodoId: number,
    repCodigo: number,
    dto: AtualizarParametroDto,
  ) {
    const periodo = await this.obterPeriodo(periodoId);
    // Janela de férias (todos os papéis): só é guardada com férias marcadas e as
    // duas datas informadas; fim antes do início é erro de digitação.
    const temFerias = dto.tem_ferias ?? false;
    const feriasIni = temFerias ? (dto.ferias_inicio ?? null) : null;
    const feriasFim = temFerias ? (dto.ferias_fim ?? null) : null;
    if ((feriasIni && !feriasFim) || (!feriasIni && feriasFim)) {
      throw new BadRequestException(
        `Rep ${repCodigo}: informe início E fim das férias.`,
      );
    }
    if (feriasIni && feriasFim && feriasFim < feriasIni) {
      throw new BadRequestException(
        `Rep ${repCodigo}: o fim das férias (${feriasFim}) é anterior ao início (${feriasIni}).`,
      );
    }
    await this.prisma.$executeRaw(Prisma.sql`
      MERGE dbo.ComissaoParametroManual AS alvo
      USING (SELECT ${periodoId} AS periodo_id, ${repCodigo} AS rep_codigo) AS fonte
        ON alvo.periodo_id = fonte.periodo_id AND alvo.rep_codigo = fonte.rep_codigo
      WHEN MATCHED THEN UPDATE SET
        abatimento  = ${dto.abatimento ?? 0},
        abatimento_motivo = ${motivoAbatimento(dto)},
        tem_ferias  = ${temFerias},
        dias_ferias = ${dto.dias_ferias ?? 0},
        ferias_inicio = ${vdate(feriasIni)},
        ferias_fim    = ${vdate(feriasFim)},
        pct_bonus   = ${dto.pct_bonus ?? 0},
        data_atualizacao = GETDATE()
      WHEN NOT MATCHED THEN
        INSERT (periodo_id, rep_codigo, abatimento, abatimento_motivo, tem_ferias,
                dias_ferias, ferias_inicio, ferias_fim, pct_bonus)
        VALUES (${periodoId}, ${repCodigo}, ${dto.abatimento ?? 0}, ${motivoAbatimento(dto)},
                ${temFerias}, ${dto.dias_ferias ?? 0}, ${vdate(feriasIni)}, ${vdate(feriasFim)},
                ${dto.pct_bonus ?? 0});`);
    await this.gravarFerias(periodo, repCodigo, feriasIni, feriasFim);
    return { ok: true };
  }

  /**
   * Sincroniza dbo.ComissaoFerias com o que foi digitado para o rep neste período:
   * as férias que cruzam o período são trocadas pela janela informada (ou apagadas,
   * se a caixa foi desmarcada). Uma janela que avança para o mês seguinte já vale
   * lá, sem redigitar. Sem a tabela (SQL 08 não aplicado), a linha do período basta.
   */
  private async gravarFerias(periodo: { ano: number; mes: number }, repCodigo: number, ini: string | null, fim: string | null) {
    const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);
    try {
      await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM dbo.ComissaoFerias
        WHERE rep_codigo = ${repCodigo} AND ferias_inicio <= ${dataFimYmd} AND ferias_fim >= ${dataIniYmd}`);
      if (ini && fim) {
        await this.prisma.$executeRaw(Prisma.sql`
          INSERT INTO dbo.ComissaoFerias (rep_codigo, ferias_inicio, ferias_fim)
          VALUES (${repCodigo}, ${vdate(ini)}, ${vdate(fim)})`);
      }
    } catch (e) {
      this.logger.warn(
        `Tabela de férias indisponível (dbo.ComissaoFerias não aplicada?); férias gravadas só na linha do período: ${(e as Error).message}`,
      );
    }
  }

  /* ====================== CARTÃO PONTO (Sécullum) ====================== */

  /**
   * Lê os PDFs do CARTÃO PONTO e devolve o PREVIEW (nada é gravado): por
   * arquivo, o colaborador identificado, o vendedor sugerido do cadastro e os
   * dias de FALTA/DISPENSA encontrados. O RH confere na tela e confirma com
   * salvarPonto().
   */
  async processarCartaoPonto(
    periodoId: number,
    arquivos: { nome: string; buffer: Buffer }[],
  ) {
    const periodo = await this.obterPeriodo(periodoId);
    const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);

    const vendedores = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT rep_codigo, nome FROM dbo.ComissaoRepresentante
      WHERE papel = 'VENDEDOR' AND inativo = 0`);

    const resultado: any[] = [];
    for (const arq of arquivos) {
      try {
        const cartao = await extrairCartaoPonto(arq.buffer, arq.nome);
        const avisos = [...cartao.avisos];

        if (
          cartao.periodo_inicio &&
          (cartao.periodo_inicio !== dataIniYmd || cartao.periodo_fim !== dataFimYmd)
        ) {
          avisos.push(
            `O cartão cobre ${cartao.periodo_inicio} a ${cartao.periodo_fim}, mas a ` +
              `competência vai de ${dataIniYmd} a ${dataFimYmd}.`,
          );
        }
        const dias = cartao.dias.filter((d) => {
          const dentro = d.data >= dataIniYmd && d.data <= dataFimYmd;
          if (!dentro)
            avisos.push(`Dia ${d.data} (${d.motivo.toLowerCase()}) está fora da competência — ignorado.`);
          return dentro;
        });

        const sugerido = sugerirRepresentante(cartao.nome, vendedores);
        resultado.push({
          arquivo: arq.nome,
          nome_cartao: cartao.nome,
          cpf: cartao.cpf,
          folha: cartao.folha,
          periodo_inicio: cartao.periodo_inicio,
          periodo_fim: cartao.periodo_fim,
          rep_sugerido: sugerido?.rep_codigo ?? null,
          rep_sugerido_nome: sugerido?.nome ?? null,
          dias,
          avisos,
        });
      } catch (e) {
        resultado.push({
          arquivo: arq.nome,
          nome_cartao: null,
          cpf: null,
          folha: null,
          periodo_inicio: null,
          periodo_fim: null,
          rep_sugerido: null,
          rep_sugerido_nome: null,
          dias: [],
          avisos: [
            `Falha ao ler o PDF: ${e instanceof Error ? e.message : String(e)}`,
          ],
        });
      }
    }
    return { periodo_id: periodoId, arquivos: resultado };
  }

  /** Dias de ausência já gravados no período, agrupados por vendedor. */
  async listarPonto(periodoId: number) {
    await this.obterPeriodo(periodoId);
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT p.rep_codigo, r.nome, CONVERT(varchar(10), p.data, 23) AS data,
             p.motivo, p.nome_cartao, p.arquivo, p.data_importacao
      FROM dbo.ComissaoPontoDia p
      LEFT JOIN dbo.ComissaoRepresentante r ON r.rep_codigo = p.rep_codigo
      WHERE p.periodo_id = ${periodoId}
      ORDER BY r.nome, p.data`);
    const porRep = new Map<number, any>();
    for (const r of rows) {
      const cod = Number(r.rep_codigo);
      if (!porRep.has(cod)) {
        porRep.set(cod, {
          rep_codigo: cod,
          nome: r.nome ?? null,
          nome_cartao: r.nome_cartao ?? null,
          arquivo: r.arquivo ?? null,
          dias: [],
        });
      }
      porRep.get(cod)!.dias.push({ data: String(r.data), motivo: String(r.motivo) });
    }
    return [...porRep.values()];
  }

  /**
   * Grava os dias confirmados na tela (substitui os do vendedor no período) e
   * RECALCULA o período reusando o movimento em cache. Lista de dias vazia
   * limpa as exclusões do vendedor.
   */
  async salvarPonto(periodoId: number, dto: SalvarPontoDto) {
    const periodo = await this.obterPeriodo(periodoId);
    if (periodo.status === 'FECHADO') {
      throw new BadRequestException('Período fechado: reabra para importar o ponto.');
    }
    const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);
    for (const item of dto.itens) {
      for (const dia of item.dias) {
        if (dia.data < dataIniYmd || dia.data > dataFimYmd) {
          throw new BadRequestException(
            `Dia ${dia.data} está fora da competência (${dataIniYmd} a ${dataFimYmd}).`,
          );
        }
      }
    }

    for (const item of dto.itens) {
      await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM dbo.ComissaoPontoDia
        WHERE periodo_id = ${periodoId} AND rep_codigo = ${item.rep_codigo}`);
      for (const dia of item.dias) {
        await this.prisma.$executeRaw(Prisma.sql`
          INSERT INTO dbo.ComissaoPontoDia
            (periodo_id, rep_codigo, data, motivo, nome_cartao, arquivo)
          VALUES (${periodoId}, ${item.rep_codigo}, ${dia.data}, ${dia.motivo},
                  ${item.nome_cartao ?? null}, ${item.arquivo ?? null})`);
      }
    }

    const recalculo = await this.recalcular(periodoId);
    return { ...recalculo, ponto: await this.listarPonto(periodoId) };
  }

  /** Remove as exclusões de um vendedor no período e recalcula. */
  async removerPonto(periodoId: number, repCodigo: number) {
    const periodo = await this.obterPeriodo(periodoId);
    if (periodo.status === 'FECHADO') {
      throw new BadRequestException('Período fechado: reabra para alterar o ponto.');
    }
    await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM dbo.ComissaoPontoDia
      WHERE periodo_id = ${periodoId} AND rep_codigo = ${repCodigo}`);
    const recalculo = await this.recalcular(periodoId);
    return { ...recalculo, ponto: await this.listarPonto(periodoId) };
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
  private async carregarConfiguracaoAtacado(periodo: {
    id: number;
    ano: number;
    mes: number;
    dias_corridos: number;
  }): Promise<ConfiguracaoAtacado> {
    const periodoId = Number(periodo.id);
    const diasCorridos = Number(periodo.dias_corridos);
    const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);
    const escadaMix1 = await this.lerEscadaMix1(dataFimYmd);
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
      SELECT rep_codigo, abatimento, abatimento_motivo, tem_ferias, dias_ferias
      FROM dbo.ComissaoParametroManual WHERE periodo_id = ${periodoId}`);
    const parametros = new Map<number, ParametroAtacado>();
    for (const p of paramRows) {
      parametros.set(Number(p.rep_codigo), {
        rep_codigo: Number(p.rep_codigo),
        abatimento: Number(p.abatimento),
        abatimento_motivo: p.abatimento_motivo ?? null,
        tem_ferias: !!p.tem_ferias,
        dias_ferias: Number(p.dias_ferias),
      });
    }
    this.aplicarFerias(parametros, await this.feriasDoPeriodo(dataIniYmd, dataFimYmd), (rep) => ({
      rep_codigo: rep, abatimento: 0, abatimento_motivo: null, tem_ferias: false, dias_ferias: 0,
    }));

    return {
      faixasMix23,
      faixasMix1,
      metaMix1,
      escadaMix1,
      representantes,
      parametros,
      diasCorridos,
    };
  }

  /**
   * Escada de participação do mix 1 vigente no fim do período (plano do atacado
   * de set/26; parâmetros em dbo.ComissaoAtacadoEscadaMix1, SQL manual 07).
   * A mesma escada vale para os vendedores e para o supervisor do atacado.
   * Vazia quando a tabela ainda não existe ou nenhum degrau vige na data: o
   * cálculo cai na regra anterior (meta_mix1 binária), o que preserva os meses
   * antigos. A coluna venda_min_vs_media3m (trava anti-manipulação) não é
   * aplicada: fica em 1,0 até a diretoria aprovar.
   */
  private async lerEscadaMix1(dataFimYmd?: string): Promise<DegrauMix1[]> {
    try {
      const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT part_min, multiplicador
        FROM dbo.ComissaoAtacadoEscadaMix1
        WHERE ativo = 1 AND vigente_de <= ${dataFimYmd ?? '9999-12-31'}
        ORDER BY part_min`);
      return rows.map((r) => ({
        part_min: Number(r.part_min),
        multiplicador: Number(r.multiplicador),
      }));
    } catch (e) {
      this.logger.warn(
        `Escada do mix 1 indisponível (dbo.ComissaoAtacadoEscadaMix1 não aplicada?); usando a regra antiga: ${(e as Error).message}`,
      );
      return [];
    }
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
           mult_mix1, abatimento, abatimento_motivo, base_real, dias_ferias, media_ferias, total_faixa,
           pct_mix23, comissao_bruta, fator_abatimento, valor_comissao)
        VALUES
          (${periodoId}, ${v.rep_codigo}, ${v.nome}, ${round2(v.total_vendido)},
           ${round2(v.total_mix1)}, ${round6(v.pct_mix1)}, ${v.atingiu_meta}, ${round6(v.mult_mix1)},
           ${round2(v.abatimento)}, ${v.abatimento_motivo}, ${round2(v.base_real)}, ${v.dias_ferias},
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
      const cfg = await this.carregarConfiguracaoAtacado(periodo);
      const pctMix23 = Number(resumo.pct_mix23);
      const atingiuMeta = !!resumo.atingiu_meta;
      // Multiplicador gravado no cálculo (escada vigente); sem escada, regra antiga.
      const multMix1 = cfg.escadaMix1.length ? Number(resumo.mult_mix1 ?? 1) : undefined;
      const raw = await this.atacado.lerItensRep(dataIniYmd, dataFimYmd, repCodigo);
      itens = raw.map((it) => {
        const pct =
          it.mix === 1
            ? percentualMix1(it.faixa, atingiuMeta, cfg.faixasMix1, multMix1)
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

  /* ======================= SUPERVISOR DO ATACADO ====================== */

  /** Cadastro do supervisor do atacado (papel='SUPERVISOR_ATACADO', ativo). */
  private async obterSupervisorAtacadoRep(): Promise<{
    rep_codigo: number;
    nome: string | null;
  } | null> {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT TOP 1 rep_codigo, nome
      FROM dbo.ComissaoRepresentante
      WHERE papel = 'SUPERVISOR_ATACADO' AND inativo = 0
      ORDER BY rep_codigo`);
    if (!rows.length) return null;
    return { rep_codigo: Number(rows[0].rep_codigo), nome: rows[0].nome ?? null };
  }

  /**
   * Calcula a comissão do supervisor do atacado sobre TODO o canal (soma das
   * células já lidas para os vendedores). Devolve null se não houver supervisor
   * cadastrado. A meta de participação reusa a config do atacado (default 0,30);
   * o abatimento vem dos parâmetros manuais do período (proporcional).
   */
  private async calcularSupervisorAtacado(
    periodo: { id: number; ano: number; mes: number },
    celulas: CelulaAtacado[],
    repsAtacado: number[],
  ): Promise<ResultadoSupervisorAtacado | null> {
    const periodoId = Number(periodo.id);
    const rep = await this.obterSupervisorAtacadoRep();
    if (!rep) return null;
    const metaRows = await this.prisma.$queryRaw<any[]>(
      Prisma.sql`SELECT meta_mix1 FROM dbo.ComissaoAtacadoConfig WHERE id = 1`,
    );
    const metaMix1 = metaRows.length ? Number(metaRows[0].meta_mix1) : undefined;
    const escada = await this.lerEscadaMix1(
      calcularDatasPeriodo(periodo.ano, periodo.mes).dataFimYmd,
    );
    const paramRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT abatimento, abatimento_motivo, tem_ferias,
             CONVERT(varchar(10), ferias_inicio, 23) AS ferias_inicio,
             CONVERT(varchar(10), ferias_fim, 23)    AS ferias_fim
      FROM dbo.ComissaoParametroManual
      WHERE periodo_id = ${periodoId} AND rep_codigo = ${rep.rep_codigo}`);
    const p = paramRows[0];
    // Férias do supervisor: a tabela de férias recortada ao período (ou, sem a
    // tabela, a janela da linha do período). O engine subtrai do canal só a janela,
    // relida no BI com a mesma consulta das células — leitura local ao SQL Server,
    // então não invalida o cache do movimento (que continua sendo o período inteiro).
    const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);
    const feriasTab = await this.feriasDoPeriodo(dataIniYmd, dataFimYmd);
    const ferias = feriasTab
      ? (feriasTab.get(rep.rep_codigo) ?? null)
      : janelaFerias(
          {
            tem_ferias: !!p?.tem_ferias,
            ferias_inicio: p?.ferias_inicio ?? null,
            ferias_fim: p?.ferias_fim ?? null,
          },
          dataIniYmd,
          dataFimYmd,
        );
    if (!p && !ferias) return calcularSupervisorAtacado(celulas, rep, metaMix1, undefined, escada);
    const celulasFerias = ferias
      ? await this.atacado.lerCelulas(ferias.inicio, ferias.fim, repsAtacado)
      : [];
    return calcularSupervisorAtacado(
      celulas,
      rep,
      metaMix1,
      {
        abatimento: Number(p?.abatimento ?? 0),
        abatimento_motivo: p?.abatimento_motivo ?? null,
        ferias,
        celulasFerias,
      },
      escada,
    );
  }

  /** Grava o snapshot do supervisor do atacado (apaga e regrava o período). */
  private async persistirResultadoSupervisorAtacado(
    periodoId: number,
    r: ResultadoSupervisorAtacado | null,
  ): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM dbo.ComissaoSupervisorAtacadoDetalhe WHERE periodo_id = ${periodoId}`,
    );
    await this.prisma.$executeRaw(
      Prisma.sql`DELETE FROM dbo.ComissaoResultadoSupervisorAtacado WHERE periodo_id = ${periodoId}`,
    );
    if (!r) return;

    const v = r.resumo;
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO dbo.ComissaoResultadoSupervisorAtacado
        (periodo_id, rep_codigo, nome, total_vendido, total_mix1, pct_mix1,
         atingiu_meta, mult_mix1, pct_mix23, excluido_ferias, dias_ferias, ferias_inicio, ferias_fim,
         abatimento, abatimento_motivo, base_real,
         comissao_bruta, fator_abatimento, comissao_total)
      VALUES
        (${periodoId}, ${v.rep_codigo}, ${v.nome}, ${round2(v.total_vendido)},
         ${round2(v.total_mix1)}, ${round6(v.pct_mix1)}, ${v.atingiu_meta}, ${round6(v.mult_mix1)},
         ${round6(v.pct_mix23)}, ${round2(v.excluido_ferias)}, ${v.dias_ferias},
         ${vdate(v.ferias_inicio)}, ${vdate(v.ferias_fim)},
         ${round2(v.abatimento)}, ${v.abatimento_motivo},
         ${round2(v.base_real)}, ${round2(v.comissao_bruta)},
         ${round6(v.fator_abatimento)}, ${round2(v.comissao_total)})`);

    type Det = (string | number)[];
    const dets: Det[] = r.detalhe.map((d) => [
      periodoId, d.mix, d.faixa, round2(d.valor_vendido),
      round6(d.pct_comissao), round2(d.valor_comissao),
    ]);
    const COLS = Prisma.sql`(periodo_id, mix, faixa, valor_vendido, pct_comissao, valor_comissao)`;
    const LOTE = 100;
    for (let i = 0; i < dets.length; i += LOTE) {
      const fatia = dets.slice(i, i + LOTE);
      const tuplas = fatia.map((m) => Prisma.sql`(${Prisma.join(m)})`);
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO dbo.ComissaoSupervisorAtacadoDetalhe ${COLS} VALUES ${Prisma.join(tuplas)}`);
    }
  }

  /** Snapshot calculado do supervisor do atacado (um registro por período). */
  async consultarResultadoSupervisorAtacado(periodoId: number) {
    await this.obterPeriodo(periodoId);
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT * FROM dbo.ComissaoResultadoSupervisorAtacado
      WHERE periodo_id = ${periodoId}`);
    return rows[0] ?? null;
  }

  /**
   * Relatório de assinatura do supervisor do atacado: resumo + quebra mix x faixa
   * + relação de vendas por item de TODO o canal (espelha a 447). Devolve o mesmo
   * formato do relatório do vendedor de atacado para reaproveitar a tela/impressão
   * (campos de abatimento/férias zerados — o supervisor não os tem).
   */
  async relatorioSupervisorAtacado(periodoId: number) {
    const periodo = await this.obterPeriodo(periodoId);
    const resumoRows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT * FROM dbo.ComissaoResultadoSupervisorAtacado WHERE periodo_id = ${periodoId}`);
    const s = resumoRows[0] ?? null;
    if (!s) return { resumo: null, detalhe: [], itens: [] };

    // Espelha a forma do ResultadoAtacado consumido pela tela/impressão.
    // Férias do supervisor = janela de datas cujo movimento saiu da base
    // (excluido_ferias); não há média (media_ferias fica 0, o % é fixo).
    const feriasIni = s.ferias_inicio ? dataYmdUtc(new Date(s.ferias_inicio)) : null;
    const feriasFim = s.ferias_fim ? dataYmdUtc(new Date(s.ferias_fim)) : null;
    const ferias =
      feriasIni && feriasFim
        ? janelaFerias({ tem_ferias: true, ferias_inicio: feriasIni, ferias_fim: feriasFim })
        : null;
    const resumo = {
      rep_codigo: Number(s.rep_codigo),
      nome: s.nome ?? null,
      total_vendido: Number(s.total_vendido),
      total_mix1: Number(s.total_mix1),
      pct_mix1: Number(s.pct_mix1),
      atingiu_meta: !!s.atingiu_meta,
      mult_mix1: Number(s.mult_mix1 ?? 1),
      abatimento: Number(s.abatimento ?? 0),
      abatimento_motivo: s.abatimento_motivo ?? null,
      base_real: Number(s.base_real ?? s.total_vendido),
      dias_ferias: Number(s.dias_ferias ?? 0),
      media_ferias: 0,
      excluido_ferias: Number(s.excluido_ferias ?? 0),
      ferias_inicio: ferias?.inicio ?? null,
      ferias_fim: ferias?.fim ?? null,
      total_faixa: Number(s.total_vendido),
      pct_mix23: Number(s.pct_mix23),
      comissao_bruta: Number(s.comissao_bruta ?? s.comissao_total),
      fator_abatimento: Number(s.fator_abatimento ?? 1),
      valor_comissao: Number(s.comissao_total),
    };

    const detalhe = await this.prisma.$queryRaw(Prisma.sql`
      SELECT mix, faixa, valor_vendido, pct_comissao, valor_comissao
      FROM dbo.ComissaoSupervisorAtacadoDetalhe
      WHERE periodo_id = ${periodoId}
      ORDER BY mix,
        CASE faixa WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 9 END`);

    const { dataIniYmd, dataFimYmd } = calcularDatasPeriodo(periodo.ano, periodo.mes);
    const repsAtacado = await this.listarRepsAtacado();
    const atingiuMeta = !!s.atingiu_meta;
    // Multiplicador gravado no cálculo (escada vigente); sem escada, regra antiga.
    const escada = await this.lerEscadaMix1(dataFimYmd);
    const multMix1 = escada.length ? Number(s.mult_mix1 ?? 1) : undefined;
    const raw = await this.atacado.lerItensCanal(dataIniYmd, dataFimYmd, repsAtacado);
    const itens = raw.map((it) => {
      // Item emitido nos dias de férias do supervisor: fica na relação (é venda
      // do canal), mas não comissiona — sai carimbado para o demonstrativo.
      const excluido_ferias = dentroDaJanela(it.dt_emissao, ferias);
      const pct = excluido_ferias
        ? 0
        : pctSupervisorAtacado(it.mix, it.faixa, atingiuMeta, multMix1);
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
        excluido_ferias,
      };
    });

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
    return {
      mix23,
      mix1,
      meta_mix1: cfg.length ? Number(cfg[0].meta_mix1) : 0.3,
      // Escada vigente hoje (só leitura; parâmetros via SQL manual 07).
      escada_mix1: await this.lerEscadaMix1(),
    };
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

/** Normaliza nome para casamento: sem acento, maiúsculo, sem conectivos. */
function tokensNome(nome: string | null | undefined): string[] {
  if (!nome) return [];
  const CONECTIVOS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E']);
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !CONECTIVOS.has(t));
}

/**
 * Sugere o representante cujo nome mais casa com o nome impresso no cartão.
 * Sugere só com pelo menos 2 tokens em comum, OU 1 token quando o primeiro
 * nome do cartão é único no cadastro (o Firebird costuma guardar só "RENAN").
 */
function sugerirRepresentante(
  nomeCartao: string | null,
  vendedores: { rep_codigo: unknown; nome: unknown }[],
): { rep_codigo: number; nome: string | null } | null {
  const alvo = tokensNome(nomeCartao);
  if (!alvo.length) return null;

  let melhor: { rep_codigo: number; nome: string | null } | null = null;
  let melhorScore = 0;
  let empate = false;
  const primeiroNomeMatches: { rep_codigo: number; nome: string | null }[] = [];

  for (const v of vendedores) {
    const rep = { rep_codigo: Number(v.rep_codigo), nome: (v.nome as string) ?? null };
    const tokens = tokensNome(rep.nome);
    const score = tokens.filter((t) => alvo.includes(t)).length;
    if (tokens[0] && tokens[0] === alvo[0]) primeiroNomeMatches.push(rep);
    if (score > melhorScore) {
      melhorScore = score;
      melhor = rep;
      empate = false;
    } else if (score === melhorScore && score > 0) {
      empate = true;
    }
  }

  if (melhor && melhorScore >= 2 && !empate) return melhor;
  if (primeiroNomeMatches.length === 1) return primeiroNomeMatches[0];
  return null;
}

/** Motivo só é guardado quando há abatimento (sem abatimento, limpa o campo). */
function motivoAbatimento(dto: AtualizarParametroDto): string | null {
  if (!num(dto.abatimento)) return null;
  const t = (dto.abatimento_motivo ?? '').trim();
  return t === '' ? null : t.slice(0, 200);
}
/**
 * Data 'AAAA-MM-DD' (ou null) para coluna DATE. Vai como varchar: o driver tipa
 * NULL como int, e int não converte para date (erro 206) — varchar converte.
 */
function vdate(v: string | null | undefined): Prisma.Sql {
  return Prisma.sql`CAST(${v ?? null} AS varchar(10))`;
}
function round2(v: number): number {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}
function round6(v: number): number {
  return Math.round((num(v) + Number.EPSILON) * 1e6) / 1e6;
}
