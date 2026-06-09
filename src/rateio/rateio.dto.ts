import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** Filtros da consulta de rateio da despesa com pessoal por canal. */
export class ConsultarRateioQuery {
  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  ano?: number;

  @ApiPropertyOptional({ example: 1, minimum: 1, maximum: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  mes?: number;

  @ApiPropertyOptional({ description: 'Filtra por canal (LOCAL_VENDA)', example: 'ATACADO' })
  @IsOptional()
  @IsString()
  canal?: string;
}

/** Corpo opcional do recálculo da DRE. */
export class AtualizarRateioDto {
  @ApiPropertyOptional({
    description:
      'Ano de projeção para o sp_refresh_mart_dre_full. Se omitido, usa o ano da última competência implantada (folha).',
    example: 2026,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  ano?: number;
}
