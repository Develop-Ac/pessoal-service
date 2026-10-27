import { BadRequestException, Controller, Get, Logger, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import {
  CacheTtl,
  FiltroInvalido,
  carregarCards,
  chaveFiltros,
  executarCard,
  lerFiltros,
  parametrosSql,
  type FiltrosDre,
} from './dre-kpis';

interface RespostaPainel {
  painel: string;
  filtros: FiltrosDre;
  geradoEm: string;
  cache: boolean;
  cards: Array<Record<string, unknown>>;
}

/**
 * Painéis da intranet servidos direto do SQL Server BI (mart f_dre_base),
 * numa chamada só, no formato de card do Metabase. Cache de 60 s por filtro:
 * menor que o intervalo de recarga do mart, então nunca fica mais velho que ele.
 */
@ApiTags('Painéis')
@Controller('paineis')
export class PaineisController {
  private readonly logger = new Logger(PaineisController.name);
  private readonly cards = carregarCards(path.join(__dirname, 'sql'));
  private readonly cache = new CacheTtl<RespostaPainel>(60_000);

  constructor(private readonly prisma: PrismaService) {}

  @Get('dre-kpis')
  @ApiOperation({
    summary: 'KPIs de pessoal do DRE (cards do dashboard 22). Filtros: inicio e fim (AAAA-MM), canal',
  })
  async dreKpis(@Query() query: Record<string, unknown>): Promise<RespostaPainel> {
    let filtros: FiltrosDre;
    try {
      filtros = lerFiltros(query);
    } catch (e) {
      if (e instanceof FiltroInvalido) throw new BadRequestException(e.message);
      throw e;
    }

    const chave = chaveFiltros(filtros);
    const emCache = this.cache.get(chave);
    if (emCache) return { ...emCache, cache: true };

    const params = parametrosSql(filtros);
    let falhou = false;
    const cards = await Promise.all(
      this.cards.map(async (def) => {
        const { sql: _sql, arquivo: _arquivo, cols: _cols, ...card } = def;
        try {
          return { ...card, data: await executarCard(this.prisma, def, params), erro: null };
        } catch (e) {
          // Card isolado com falha não derruba o painel (a tela mostra os demais).
          falhou = true;
          this.logger.error(`dre-kpis card ${def.card}: ${(e as Error).message}`);
          return { ...card, data: null, erro: 'falha ao consultar o card' };
        }
      }),
    );

    const resposta: RespostaPainel = {
      painel: 'dre-kpis',
      filtros,
      geradoEm: new Date().toISOString(),
      cache: false,
      cards,
    };
    if (!falhou) this.cache.set(chave, resposta);
    return resposta;
  }
}
