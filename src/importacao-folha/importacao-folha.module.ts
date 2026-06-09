import { Module } from '@nestjs/common';
import { ImportacaoFolhaController } from './importacao-folha.controller';
import { ImportacaoFolhaService } from './importacao-folha.service';

@Module({
  controllers: [ImportacaoFolhaController],
  providers: [ImportacaoFolhaService],
})
export class ImportacaoFolhaModule {}
