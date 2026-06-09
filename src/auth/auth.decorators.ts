import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Perfis de usuário suportados neste serviço.
 * 'rh' e 'dp' são os papéis do módulo Pessoal; 'admin' tem acesso total.
 * 'administrativo' é mantido por compatibilidade com o restante da intranet.
 */
export type UserRole = 'admin' | 'administrativo' | 'rh' | 'dp';

/** Identidade autenticada extraída do JWT. */
export interface AuthUser {
  sub: number;
  codigo_usuario: string;
  profile: UserRole;
  name?: string;
}

/** Marca uma rota como pública (sem autenticação). */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restringe a rota aos perfis informados. */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Injeta o usuário autenticado (ou undefined em modo legado). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return req.user;
  },
);
