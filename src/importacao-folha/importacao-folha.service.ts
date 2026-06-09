import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { extrairDadosPdf, RegistroFolha } from './extrator-pdf';
import { sincronizarCadastro } from './sincronizacao';

export interface ArquivoUpload {
  nome: string;
  buffer: Buffer;
}

export type StatusJob = 'PROCESSANDO' | 'CONCLUIDO' | 'ERRO';

export interface Job {
  job_id: string;
  status: StatusJob;
  progress: number;
  message: string;
  competencia: string | null;
  processed_files: number;
  total_files: number;
  started_at: Date;
  finished_at: Date | null;
}

@Injectable()
export class ImportacaoFolhaService {
  private readonly logger = new Logger('ImportacaoFolha');
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ Jobs --
  criarJob(competencia: string | null): Job {
    const job: Job = {
      job_id: randomUUID().replace(/-/g, ''),
      status: 'PROCESSANDO',
      progress: 0,
      message: 'Processamento em fila...',
      competencia,
      processed_files: 0,
      total_files: 0,
      started_at: new Date(),
      finished_at: null,
    };
    this.jobs.set(job.job_id, job);
    return job;
  }

  obterJob(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundException('Job não encontrado.');
    return job;
  }

  private atualizarJob(jobId: string, dados: Partial<Job>) {
    const job = this.jobs.get(jobId);
    if (job) Object.assign(job, dados);
  }

  /**
   * Dispara o processamento dos arquivos em segundo plano (não bloqueia a
   * resposta HTTP). O front acompanha via GET /importacao/status/:jobId.
   */
  processarEmBackground(
    jobId: string,
    competencia: string,
    arquivos: ArquivoUpload[],
  ): void {
    void this.executar(jobId, competencia, arquivos).catch((e) => {
      this.atualizarJob(jobId, {
        status: 'ERRO',
        message: `Erro no processamento: ${e instanceof Error ? e.message : String(e)}`,
        finished_at: new Date(),
      });
    });
  }

  // ------------------------------------------------------------- Pipeline --
  private async executar(
    jobId: string,
    competencia: string,
    arquivos: ArquivoUpload[],
  ): Promise<void> {
    const total = arquivos.length;
    this.atualizarJob(jobId, {
      total_files: total,
      progress: 5,
      message: `${total} arquivo(s) recebido(s).`,
    });

    let indice = 0;
    for (const arq of arquivos) {
      indice += 1;
      this.atualizarJob(jobId, {
        progress: Math.floor(((indice - 1) / total) * 90) + 5,
        message: `Processando arquivo ${indice}/${total}: ${arq.nome}`,
        processed_files: indice - 1,
      });

      await this.processarArquivo(arq, competencia);

      this.atualizarJob(jobId, {
        progress: Math.floor((indice / total) * 90) + 5,
        message: `Arquivo ${indice}/${total} concluído.`,
        processed_files: indice,
      });
    }

    this.atualizarJob(jobId, {
      status: 'CONCLUIDO',
      progress: 100,
      message: 'Processamento concluído com sucesso.',
      finished_at: new Date(),
    });
  }

  /** Processa um único PDF: extrai, grava bruta+valores, sincroniza e loga. */
  async processarArquivo(arq: ArquivoUpload, competenciaFallback: string) {
    const nomeArquivo = arq.nome;
    let totalExtraidos = 0;
    let totalGravados = 0;
    let totalNovos = 0;
    let status: 'SUCESSO' | 'PARCIAL' | 'ERRO' = 'ERRO';
    let mensagem = '';

    try {
      const { registros } = await extrairDadosPdf(arq.buffer, nomeArquivo);
      // Preenche competência ausente com o fallback informado no upload.
      for (const r of registros) {
        if (!r.competencia) r.competencia = competenciaFallback;
      }
      totalExtraidos = registros.length;

      if (registros.length === 0) {
        mensagem = 'Nenhum registro extraído do PDF.';
        await this.registrarLog(
          competenciaFallback,
          nomeArquivo,
          0,
          0,
          0,
          0,
          'ERRO',
          mensagem,
        );
        return { arquivo: nomeArquivo, status: 'ERRO', mensagem };
      }

      const competencias = Array.from(
        new Set(registros.map((r) => r.competencia).filter(Boolean) as string[]),
      );

      // Gravação idempotente em transação por arquivo.
      await this.prisma.$transaction(async (tx) => {
        // 1) ImportacaoFolhaBruta — remove anteriores (competência+arquivo) e insere.
        for (const comp of competencias) {
          await tx.importacaoFolhaBruta.deleteMany({
            where: { competencia: comp, arquivo_origem: nomeArquivo },
          });
        }
        await tx.importacaoFolhaBruta.createMany({
          data: registros.map((r) => ({
            competencia: r.competencia as string,
            matricula: r.matricula || null,
            nome: r.nome,
            departamento_folha: r.departamento_folha,
            cpf: r.cpf || null,
            valor_liquido:
              r.valor_liquido == null ? null : new Prisma.Decimal(r.valor_liquido),
            tipo_registro: r.tipo_registro,
            arquivo_origem: nomeArquivo,
            data_importacao: new Date(),
          })),
        });

        // 2) FolhaValoresMensais — só registros com matrícula e valor.
        const valores = registros.filter(
          (r) => (r.matricula ?? '').trim() !== '' && r.valor_liquido != null,
        );
        for (const comp of competencias) {
          await tx.folhaValoresMensais.deleteMany({
            where: { competencia: comp, arquivo_origem: nomeArquivo },
          });
        }
        if (valores.length > 0) {
          await tx.folhaValoresMensais.createMany({
            data: valores.map((r) => ({
              competencia: r.competencia as string,
              matricula: r.matricula,
              cpf: r.cpf || null,
              valor_liquido: new Prisma.Decimal(r.valor_liquido as number),
              arquivo_origem: nomeArquivo,
              data_criacao: new Date(),
            })),
          });
        }

        // 3) Sincronização do cadastro mestre por competência.
        for (const comp of competencias) {
          const res = await sincronizarCadastro(tx, comp);
          totalNovos += res.total_novos + res.total_mudanca_dept;
        }
      });

      totalGravados = registros.length;
      status = 'SUCESSO';
      mensagem = `Extraídos: ${totalExtraidos} | Gravados: ${totalGravados} | Novos/Versões: ${totalNovos}`;

      for (const comp of competencias) {
        await this.registrarLog(
          comp,
          nomeArquivo,
          totalExtraidos,
          totalGravados,
          0,
          totalNovos,
          status,
          mensagem,
        );
      }
      return { arquivo: nomeArquivo, status, mensagem };
    } catch (e) {
      mensagem = `Falha no processamento: ${e instanceof Error ? e.message : String(e)}`;
      this.logger.error(mensagem);
      await this.registrarLog(
        competenciaFallback,
        nomeArquivo,
        totalExtraidos,
        0,
        totalExtraidos,
        0,
        'ERRO',
        mensagem,
      );
      throw e;
    }
  }

  private async registrarLog(
    competencia: string,
    arquivo: string,
    totalExtraidos: number,
    totalGravados: number,
    totalFalhas: number,
    totalNovos: number,
    status: string,
    mensagem: string,
  ) {
    try {
      await this.prisma.logImportacao.create({
        data: {
          competencia,
          arquivo_origem: arquivo,
          data_execucao: new Date(),
          total_linhas_extraidas: totalExtraidos,
          total_gravados: totalGravados,
          total_falhas: totalFalhas,
          total_novos_colaboradores: totalNovos,
          status,
          mensagem,
        },
      });
    } catch (e) {
      this.logger.error(
        `Falha ao registrar log de importação: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ---------------------------------------------------------------- Logs ---
  async listarLogs(limit = 50) {
    return this.prisma.logImportacao.findMany({
      orderBy: { data_execucao: 'desc' },
      take: limit,
    });
  }
}
