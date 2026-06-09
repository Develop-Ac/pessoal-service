import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ImportacaoFolhaService } from './importacao-folha.service';
import { ListarLogsQuery, ProcessarFolhaDto } from './importacao-folha.dto';

@ApiTags('Importação de Folha')
@Controller('importacao')
export class ImportacaoFolhaController {
  constructor(private readonly service: ImportacaoFolhaService) {}

  @Post('processar-arquivos')
  @ApiOperation({ summary: 'Envia 1+ PDFs da folha e inicia o processamento em background' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        competencia: { type: 'string', example: '2026-01' },
        arquivos: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @UseInterceptors(FilesInterceptor('arquivos', 20))
  async processarArquivos(
    @UploadedFiles() arquivos: Array<{ originalname: string; buffer: Buffer; mimetype: string }>,
    @Body() dto: ProcessarFolhaDto,
  ) {
    const validos = (arquivos ?? []).filter(
      (a) => a.originalname && a.originalname.toLowerCase().endsWith('.pdf'),
    );
    if (validos.length === 0) {
      throw new BadRequestException('Envie ao menos um arquivo PDF.');
    }

    const job = this.service.criarJob(dto.competencia);
    this.service.processarEmBackground(
      job.job_id,
      dto.competencia,
      validos.map((a) => ({ nome: a.originalname, buffer: a.buffer })),
    );

    return {
      mensagem: `Processamento iniciado em segundo plano para ${validos.length} arquivo(s).`,
      arquivos: validos.map((a) => a.originalname),
      job_id: job.job_id,
    };
  }

  @Get('status/:jobId')
  @ApiOperation({ summary: 'Consulta o progresso de um processamento' })
  @ApiOkResponse({ description: 'Status do job' })
  status(@Param('jobId') jobId: string) {
    return this.service.obterJob(jobId);
  }

  @Get('logs')
  @ApiOperation({ summary: 'Lista o histórico de importações (LogImportacao)' })
  async logs(@Query() query: ListarLogsQuery) {
    const limit = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 500);
    return this.service.listarLogs(limit);
  }
}
