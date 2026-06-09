import { Module } from '@nestjs/common';
import { ComissoesController } from './comissoes.controller';
import { ComissoesService } from './comissoes.service';
import { FirebirdSource } from './firebird-source';
import { AtacadoSource } from './atacado-source';

@Module({
  controllers: [ComissoesController],
  providers: [ComissoesService, FirebirdSource, AtacadoSource],
})
export class ComissoesModule {}
