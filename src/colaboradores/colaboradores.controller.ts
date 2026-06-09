import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ColaboradoresService } from './colaboradores.service';
import {
  AtualizarColaboradorDto,
  ListarColaboradoresQuery,
} from './colaboradores.dto';

@ApiTags('Colaboradores')
@Controller('colaboradores')
export class ColaboradoresController {
  constructor(private readonly service: ColaboradoresService) {}

  @Get()
  @ApiOperation({
    summary: 'Lista colaboradores (filtros: ativo, vigentes, semAlocacao, busca)',
  })
  @ApiOkResponse({ description: 'Lista de colaboradores' })
  async index(@Query() query: ListarColaboradoresQuery) {
    return this.service.listar(query);
  }

  @Get('pendencias/sem-alocacao')
  @ApiOperation({
    summary: 'Colaboradores vigentes ainda sem tipo de alocação definido',
  })
  async semAlocacao() {
    return this.service.listar({ semAlocacao: true, ativo: true, vigentes: true });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtém um colaborador pelo id' })
  @ApiParam({ name: 'id', example: 1 })
  async show(@Param('id', ParseIntPipe) id: number) {
    return this.service.obter(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Atualiza alocação e percentuais por canal de um colaborador',
  })
  @ApiParam({ name: 'id', example: 1 })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AtualizarColaboradorDto,
  ) {
    return this.service.atualizar(id, dto);
  }
}
