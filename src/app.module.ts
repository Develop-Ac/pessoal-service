import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { HealthController } from './health.controller';
import { ColaboradoresModule } from './colaboradores/colaboradores.module';
import { ImportacaoFolhaModule } from './importacao-folha/importacao-folha.module';
import { RateioModule } from './rateio/rateio.module';
import { ComissoesModule } from './comissoes/comissoes.module';

@Module({
  imports: [
    // Rate-limit base (60s).
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    AuthModule,
    PrismaModule,
    ColaboradoresModule,
    ImportacaoFolhaModule,
    RateioModule,
    ComissoesModule,

    PrometheusModule.register({
      defaultMetrics: { enabled: true }, // CPU, memória, event loop, GC
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
