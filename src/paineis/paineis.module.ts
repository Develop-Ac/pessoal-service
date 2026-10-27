import { Module } from '@nestjs/common';
import { PaineisController } from './paineis.controller';

@Module({
  controllers: [PaineisController],
})
export class PaineisModule {}
