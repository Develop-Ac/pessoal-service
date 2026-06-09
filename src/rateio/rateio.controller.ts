import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RateioService } from './rateio.service';
import { AtualizarRateioDto, ConsultarRateioQuery } from './rateio.dto';

@ApiTags('Rateio / DRE')
@Controller('rateio')
export class RateioController {
  constructor(private readonly service: RateioService) {}

  @Get()
  @ApiOperation({
    summary: 'Despesa com pessoal rateada por canal e competência (lê o DW)',
  })
  @ApiOkResponse({ description: 'Linhas de rateio agregadas' })
  async consultar(@Query() query: ConsultarRateioQuery) {
    return this.service.consultar(query);
  }

  @Post('atualizar')
  @ApiOperation({
    summary:
      'Recalcula o rateio, encerra sessões do Metabase e atualiza toda a DRE (sp_refresh_mart_dre_full)',
  })
  async atualizar(@Body() body: AtualizarRateioDto) {
    return this.service.atualizar(body?.ano);
  }
}
