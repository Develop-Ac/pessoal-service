import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from './auth.decorators';

/**
 * Autenticação global (mesmo padrão do entregas-ac-backend).
 *
 * 1) Rotas marcadas com @Public() passam direto.
 * 2) Aceita JWT (Authorization: Bearer) => preenche req.user com a identidade.
 * 3) Modo legado transitório: enquanto LEGACY_APP_TOKEN_ENABLED !== 'false',
 *    o APP_TOKEN estático autentica a requisição SEM identidade (req.user
 *    undefined). Endpoints com @Roles exigem JWT real.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (req.method === 'OPTIONS') return true;

    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException({
        error: 'TOKEN_MISSING',
        message: 'Autenticação obrigatória.',
      });
    }

    // 1) Tenta validar como JWT (caminho preferido, com identidade).
    try {
      const payload = await this.jwt.verifyAsync(token);
      (req as any).user = {
        sub: payload.sub,
        codigo_usuario: payload.codigo_usuario,
        profile: payload.profile,
        name: payload.name,
      };
      return true;
    } catch {
      // segue para o fallback legado
    }

    // 2) Fallback legado: APP_TOKEN estático (sem identidade).
    const legacyEnabled =
      (process.env.LEGACY_APP_TOKEN_ENABLED ?? 'true') !== 'false';
    const appToken = process.env.APP_TOKEN || '';
    if (legacyEnabled && appToken && token === appToken) {
      (req as any).user = undefined;
      return true;
    }

    throw new UnauthorizedException({
      error: 'TOKEN_INVALID',
      message: 'Token inválido ou expirado.',
    });
  }

  private extractToken(req: Request): string | null {
    const auth = (req.headers.authorization || '').toString();
    if (/^Bearer\s+/i.test(auth)) {
      return auth.replace(/^Bearer\s+/i, '').trim();
    }
    const q = (req.query?.token as string | undefined) ?? undefined;
    if (typeof q === 'string' && q.length > 0) return q;
    const b = (req.body && (req.body as any).token) as string | undefined;
    if (typeof b === 'string' && b.length > 0) return b;
    return null;
  }
}
