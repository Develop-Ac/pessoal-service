import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class ProcessarFolhaDto {
  @ApiProperty({
    description: 'Competência de fallback no formato YYYY-MM (usada quando o PDF não traz a competência).',
    example: '2026-01',
  })
  @Matches(/^\d{4}-\d{2}$/, {
    message: 'competencia deve estar no formato YYYY-MM.',
  })
  competencia!: string;
}

export class ListarLogsQuery {
  @ApiPropertyOptional({ description: 'Quantidade máxima de registros', example: 50 })
  @IsOptional()
  @IsString()
  limit?: string;
}
