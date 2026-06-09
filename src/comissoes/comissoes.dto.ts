import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Abre (ou recupera) uma competência comissional. */
export class AbrirPeriodoDto {
  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  ano!: number;

  @ApiProperty({ example: 5, description: 'Mês da competência (mês do dia 25)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  mes!: number;
}

/** Parâmetros manuais de um representante no período. */
export class AtualizarParametroDto {
  @ApiPropertyOptional({ example: 0, description: 'Abatimento da base (R$)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  abatimento?: number;

  @ApiPropertyOptional({ description: 'Vendedor esteve de férias no período' })
  @IsOptional()
  @IsBoolean()
  tem_ferias?: boolean;

  @ApiPropertyOptional({ example: 10, description: 'Dias de férias no período' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(31)
  dias_ferias?: number;

  @ApiPropertyOptional({ example: 0.0075, description: '% de bônus do técnico (ex.: 0.0075)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  pct_bonus?: number;
}

/** Um parâmetro manual com o código do representante (para o salvar em lote). */
export class ParametroItemDto extends AtualizarParametroDto {
  @ApiProperty({ example: 164 })
  @Type(() => Number)
  @IsInt()
  rep_codigo!: number;
}

/** Salvar em lote os parâmetros + recalcular (reusando o movimento em cache). */
export class RecalcularDto {
  @ApiPropertyOptional({ type: [ParametroItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParametroItemDto)
  parametros?: ParametroItemDto[];
}

/** Edição das colunas mantidas manualmente no cadastro de representante. */
export class AtualizarRepresentanteDto {
  @ApiPropertyOptional({ description: 'Usa a tabela de % ESPECIAL' })
  @IsOptional()
  @IsBoolean()
  especial?: boolean;

  @ApiPropertyOptional({ example: 'BALCÃO', enum: ['BALCÃO', 'ATACADO', 'SERVIÇO'] })
  @IsOptional()
  @IsString()
  local_venda?: string;

  @ApiPropertyOptional({ example: 'VENDEDOR', enum: ['VENDEDOR', 'TECNICO', 'SUPERVISOR'] })
  @IsOptional()
  @IsIn(['VENDEDOR', 'TECNICO', 'SUPERVISOR'])
  papel?: string;

  @ApiPropertyOptional({ description: 'Inativa o representante no cálculo de comissão' })
  @IsOptional()
  @IsBoolean()
  inativo?: boolean;
}

/** Filtros da listagem de representantes. */
export class ListarRepresentantesQuery {
  @ApiPropertyOptional({ enum: ['VENDEDOR', 'TECNICO', 'SUPERVISOR'] })
  @IsOptional()
  @IsString()
  papel?: string;

  @ApiPropertyOptional({ description: 'Só os que comissionam e não estão inativos' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  ativos?: boolean;

  @ApiPropertyOptional({ description: 'Busca por nome/código' })
  @IsOptional()
  @IsString()
  busca?: string;
}
