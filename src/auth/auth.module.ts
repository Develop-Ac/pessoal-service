import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

/**
 * Módulo global de autenticação/autorização.
 * Mesmo segredo JWT compartilhado da intranet (JWT_SECRET), para que o token
 * emitido pelo sistema de login funcione neste serviço.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => {
        const secret =
          process.env.JWT_SECRET ||
          process.env.APP_TOKEN ||
          'dev-insecure-secret-change-me';
        if (!process.env.JWT_SECRET) {
          // eslint-disable-next-line no-console
          console.warn(
            '[auth] JWT_SECRET não definido — usando fallback inseguro. Defina JWT_SECRET em produção.',
          );
        }
        return {
          secret,
          signOptions: {
            expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any,
          },
        };
      },
    }),
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [JwtModule],
})
export class AuthModule {}
