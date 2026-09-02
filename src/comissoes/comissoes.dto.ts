import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
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

  @ApiPropertyOptional({
    example: 'Quebra de para-brisa na montagem (OS 12345)',
    description: 'Motivo do abatimento (obrigatório na tela quando há abatimento)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  abatimento_motivo?: string;

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

  @ApiPropertyOptional({
    example: '2026-08-01',
    description:
      'Início das férias (AAAA-MM-DD) — supervisores: o movimento dos dias da janela sai da base',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'ferias_inicio deve ser AAAA-MM-DD' })
  ferias_inicio?: string;

  @ApiPropertyOptional({ example: '2026-08-15', description: 'Fim das férias (AAAA-MM-DD)' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'ferias_fim deve ser AAAA-MM-DD' })
  ferias_fim?: string;

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

  @ApiPropertyOptional({
    example: 'VENDEDOR',
    enum: ['VENDEDOR', 'VENDEDOR_ATACADO', 'TECNICO', 'SUPERVISOR', 'SUPERVISOR_ATACADO'],
  })
  @IsOptional()
  @IsIn(['VENDEDOR', 'VENDEDOR_ATACADO', 'TECNICO', 'SUPERVISOR', 'SUPERVISOR_ATACADO'])
  papel?: string;

  @ApiPropertyOptional({ description: 'Inativa o representante no cálculo de comissão' })
  @IsOptional()
  @IsBoolean()
  inativo?: boolean;
}

/** Uma mudança de canal de venda do representante (histórico/vigência). */
export class CanalHistDto {
  @ApiProperty({ example: 'BALCÃO', enum: ['BALCÃO', 'ATACADO', 'SERVIÇO'], description: 'Canal a partir da data' })
  @IsNotEmpty()
  @IsIn(['BALCÃO', 'ATACADO', 'SERVIÇO'])
  canal!: string;

  @ApiProperty({ example: '2026-05-26', description: 'Data a partir da qual o canal passa a valer (YYYY-MM-DD)' })
  @IsNotEmpty()
  @IsString()
  vigente_de!: string;
}

/** Uma faixa progressiva do mix 2/3 do atacado (edição). */
export class FaixaMix23Dto {
  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  id!: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  valor_min?: number;

  @ApiPropertyOptional({ example: 70000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  valor_max?: number;

  @ApiPropertyOptional({ example: 0.0085, description: 'Fração (0.0085 = 0,85%)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  percentual?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

/** % fixo do mix 1 por faixa (edição — só percentual/ativo são editáveis). */
export class FaixaMix1Dto {
  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  id!: number;

  @ApiPropertyOptional({ example: 0.035, description: 'Fração (0.035 = 3,5%)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  percentual?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

/** Atualização em lote das tabelas de alíquota do atacado. */
export class AtualizarAtacadoConfigDto {
  @ApiPropertyOptional({ type: [FaixaMix23Dto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaixaMix23Dto)
  mix23?: FaixaMix23Dto[];

  @ApiPropertyOptional({ type: [FaixaMix1Dto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaixaMix1Dto)
  mix1?: FaixaMix1Dto[];

  @ApiPropertyOptional({ example: 0.3, description: 'Meta de participação do mix 1 (ex.: 0.30)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  meta_mix1?: number;
}

/** Um dia excluído pelo cartão ponto (FALTA/DISPENSA). */
export class PontoDiaDto {
  @ApiProperty({ example: '2026-08-01', description: 'Data do dia (YYYY-MM-DD)' })
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'data deve ser YYYY-MM-DD' })
  data!: string;

  @ApiProperty({ example: 'FALTA', enum: ['FALTA', 'DISPENSA'] })
  @IsIn(['FALTA', 'DISPENSA'])
  motivo!: 'FALTA' | 'DISPENSA';
}

/** Dias de ausência de UM vendedor no período (substitui os já gravados). */
export class PontoRepDto {
  @ApiProperty({ example: 164 })
  @Type(() => Number)
  @IsInt()
  rep_codigo!: number;

  @ApiPropertyOptional({ example: 'RENAN FERREIRA MAFIOLETTI', description: 'Nome impresso no cartão (auditoria)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nome_cartao?: string;

  @ApiPropertyOptional({ example: 'CARTÃO PONTO RENAN.pdf', description: 'PDF de origem (auditoria)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  arquivo?: string;

  @ApiProperty({ type: [PontoDiaDto], description: 'Lista vazia limpa as exclusões do vendedor' })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PontoDiaDto)
  dias!: PontoDiaDto[];
}

/** Confirmação da importação do cartão ponto (grava e recalcula). */
export class SalvarPontoDto {
  @ApiProperty({ type: [PontoRepDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PontoRepDto)
  itens!: PontoRepDto[];
}

/** Filtros da listagem de representantes. */
export class ListarRepresentantesQuery {
  @ApiPropertyOptional({
    enum: ['VENDEDOR', 'VENDEDOR_ATACADO', 'TECNICO', 'SUPERVISOR', 'SUPERVISOR_ATACADO'],
  })
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
