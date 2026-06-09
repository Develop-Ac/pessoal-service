import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ComissoesService } from './comissoes.service';
import {
  AbrirPeriodoDto,
  AtualizarParametroDto,
  AtualizarRepresentanteDto,
  ListarRepresentantesQuery,
  RecalcularDto,
} from './comissoes.dto';

@ApiTags('Comissões')
@Controller('comissoes')
export class ComissoesController {
  constructor(private readonly service: ComissoesService) {}

  /* ----------------------------- Períodos ----------------------------- */

  @Get('periodos')
  @ApiOperation({ summary: 'Lista as competências comissionais' })
  listarPeriodos() {
    return this.service.listarPeriodos();
  }

  @Post('periodos')
  @ApiOperation({ summary: 'Abre (ou recupera) uma competência (datas 26 → 25)' })
  abrirPeriodo(@Body() dto: AbrirPeriodoDto) {
    return this.service.abrirPeriodo(dto);
  }

  @Get('periodos/:id')
  @ApiOperation({ summary: 'Detalha uma competência' })
  @ApiParam({ name: 'id', example: 1 })
  obterPeriodo(@Param('id', ParseIntPipe) id: number) {
    return this.service.obterPeriodo(id);
  }

  /* ------------------------------ Cálculo ----------------------------- */

  @Post('periodos/:id/calcular')
  @ApiOperation({
    summary: 'Lê o movimento do Firebird (OPENQUERY) e calcula as comissões em background',
  })
  calcular(@Param('id', ParseIntPipe) id: number) {
    return this.service.iniciarCalculo(id);
  }

  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Progresso de um cálculo' })
  status(@Param('jobId') jobId: string) {
    return this.service.obterJob(jobId);
  }

  @Post('periodos/:id/recalcular')
  @ApiOperation({
    summary:
      'Salva os parâmetros em lote e recalcula reusando o movimento em cache (sem reconsultar o Firebird)',
  })
  recalcular(@Param('id', ParseIntPipe) id: number, @Body() dto: RecalcularDto) {
    return this.service.recalcular(id, dto.parametros);
  }

  @Get('periodos/:id/resultado')
  @ApiOperation({ summary: 'Dinâmica do período (vendedores + técnicos)' })
  @ApiOkResponse({ description: 'Resultado calculado' })
  resultado(@Param('id', ParseIntPipe) id: number) {
    return this.service.consultarResultado(id);
  }

  /* ----------------------------- Relatórios --------------------------- */

  @Get('periodos/:id/relatorio/vendas/:rep')
  @ApiOperation({ summary: 'Relatório sintético de vendas do vendedor (assinatura)' })
  relatorioVendas(
    @Param('id', ParseIntPipe) id: number,
    @Param('rep', ParseIntPipe) rep: number,
  ) {
    return this.service.relatorioVendas(id, rep);
  }

  @Get('periodos/:id/relatorio/servicos/:rep')
  @ApiOperation({ summary: 'Relatório sintético de serviços do técnico (assinatura)' })
  relatorioServicos(
    @Param('id', ParseIntPipe) id: number,
    @Param('rep', ParseIntPipe) rep: number,
  ) {
    return this.service.relatorioServicos(id, rep);
  }

  /* ---------------------------- Parâmetros ---------------------------- */

  @Get('periodos/:id/parametros')
  @ApiOperation({ summary: 'Parâmetros manuais do período (abatimento, férias, bônus)' })
  listarParametros(@Param('id', ParseIntPipe) id: number) {
    return this.service.listarParametros(id);
  }

  @Patch('periodos/:id/parametros/:rep')
  @ApiOperation({ summary: 'Define os parâmetros manuais de um representante no período' })
  atualizarParametro(
    @Param('id', ParseIntPipe) id: number,
    @Param('rep', ParseIntPipe) rep: number,
    @Body() dto: AtualizarParametroDto,
  ) {
    return this.service.atualizarParametro(id, rep, dto);
  }

  /* -------------------------- Representantes --------------------------- */

  @Get('representantes')
  @ApiOperation({ summary: 'Cadastro de representantes (filtros: papel, ativos, busca)' })
  listarRepresentantes(@Query() q: ListarRepresentantesQuery) {
    return this.service.listarRepresentantes(q);
  }

  @Patch('representantes/:rep')
  @ApiOperation({ summary: 'Edita especial / local_venda / papel de um representante' })
  atualizarRepresentante(
    @Param('rep', ParseIntPipe) rep: number,
    @Body() dto: AtualizarRepresentanteDto,
  ) {
    return this.service.atualizarRepresentante(rep, dto);
  }

  @Post('representantes/sincronizar')
  @ApiOperation({ summary: 'Sincroniza nome/comissiona/inativo do Firebird (preserva colunas manuais)' })
  sincronizar() {
    return this.service.sincronizarRepresentantes();
  }

  /* ------------------------------ Config ------------------------------ */

  @Get('faixas')
  @ApiOperation({ summary: 'Faixas de % (TABELA %)' })
  faixas() {
    return this.service.listarFaixas();
  }

  @Get('tipos-produto')
  @ApiOperation({ summary: 'Mapa PRO_CODIGO → TIPO' })
  tiposProduto() {
    return this.service.listarTiposProduto();
  }
}
