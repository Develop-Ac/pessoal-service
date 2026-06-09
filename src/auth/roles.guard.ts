import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser, ROLES_KEY, UserRole } from './auth.decorators';

/**
 * Autorização por papel. Roda DEPOIS do JwtAuthGuard.
 * - Sem @Roles: qualquer requisição autenticada passa.
 * - Com @Roles: exige req.user (JWT) com profile na lista.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user: AuthUser | undefined = req.user;
    if (!user) {
      throw new ForbiddenException({
        error: 'IDENTITY_REQUIRED',
        message: 'Esta ação exige login de usuário (JWT).',
      });
    }
    if (!requiredRoles.includes(user.profile)) {
      throw new ForbiddenException({
        error: 'FORBIDDEN_ROLE',
        message: 'Você não tem permissão para esta ação.',
      });
    }
    return true;
  }
}
