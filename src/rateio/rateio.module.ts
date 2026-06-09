import { Module } from '@nestjs/common';
import { RateioController } from './rateio.controller';
import { RateioService } from './rateio.service';

@Module({
  controllers: [RateioController],
  providers: [RateioService],
})
export class RateioModule {}
