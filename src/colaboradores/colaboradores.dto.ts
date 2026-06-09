import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Converte 'true'/'false'/'1'/'0' (query string) em booleano. */
const toBool = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

/** Tipos de alocação suportados (CadastroColaboradores.tipo_alocacao). */
export const TIPOS_ALOCACAO = [
  'FIXO',
  'CORPORATIVO',
  'RATEIO_FIXO',
  'EXCECAO',
] as const;
export type TipoAlocacao = (typeof TIPOS_ALOCACAO)[number];

/** Filtros da listagem de colaboradores. */
export class ListarColaboradoresQuery {
  @ApiPropertyOptional({ description: 'Filtra por ativo (true/false)' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  ativo?: boolean;

  @ApiPropertyOptional({
    description: 'Apenas registros vigentes (vigencia_final IS NULL)',
    default: true,
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  vigentes?: boolean;

  @ApiPropertyOptional({
    description: 'Apenas colaboradores sem alocação (tipo_alocacao nulo)',
  })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  semAlocacao?: boolean;

  @ApiPropertyOptional({ description: 'Busca por nome ou matrícula' })
  @IsOptional()
  @IsString()
  busca?: string;
}

/** Atualização parcial do cadastro/alocação de um colaborador. */
export class AtualizarColaboradorDto {
  @ApiPropertyOptional({ example: 'ATACADO' })
  @IsOptional()
  @IsString()
  centro_custo_padrao?: string | null;

  @ApiPropertyOptional({ enum: TIPOS_ALOCACAO, example: 'RATEIO_FIXO' })
  @IsOptional()
  @IsIn(TIPOS_ALOCACAO)
  tipo_alocacao?: TipoAlocacao | null;

  @ApiPropertyOptional({ example: 40, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentual_atacado?: number;

  @ApiPropertyOptional({ example: 30, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentual_varejo?: number;

  @ApiPropertyOptional({ example: 20, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentual_servico?: number;

  @ApiPropertyOptional({
    description: 'Rateio misto varejo+serviço',
    example: 10,
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentual_varejo_servico?: number;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentual_corporativo?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;

  @ApiPropertyOptional({ example: 'Observação livre' })
  @IsOptional()
  @IsString()
  observacao?: string | null;
}
