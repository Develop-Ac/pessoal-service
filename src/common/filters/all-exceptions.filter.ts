import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Filtro global de exceções.
 * - HttpException: mantém status e corpo originais.
 * - Erros não tratados: responde 500 genérico (sem vazar stack) e registra
 *   o erro completo no servidor.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<FastifyReply>();
    const req = ctx.getRequest<FastifyRequest>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return this.sendJson(res, status, exception.getResponse());
    }

    this.logger.error(
      `Erro não tratado em ${req.method} ${req.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    return this.sendJson(res, HttpStatus.INTERNAL_SERVER_ERROR, {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Erro interno do servidor.',
    });
  }

  /**
   * Equivale ao `res.status(s).json(body)` do Express: o `send()` do Fastify
   * enviaria uma string crua como text/plain, então o corpo é sempre
   * serializado como JSON para preservar o contrato da API.
   */
  private sendJson(res: FastifyReply, status: number, body: unknown) {
    return res
      .status(status)
      .header('content-type', 'application/json; charset=utf-8')
      .send(JSON.stringify(body));
  }
}
