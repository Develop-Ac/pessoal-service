import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
  Type,
  mixin,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Observable } from 'rxjs';

/**
 * Arquivo recebido via multipart, no mesmo formato que o multer entregava
 * (`Express.Multer.File`), para que os controllers não precisem mudar.
 */
export interface UploadedFileLike {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

// `files` é omitido porque o @fastify/multipart o declara como método na
// FastifyRequest; aqui ele é sobrescrito com o array que `@UploadedFiles()` lê.
type MultipartRequest = Omit<FastifyRequest, 'files'> & {
  isMultipart?: () => boolean;
  parts?: (opts?: Record<string, unknown>) => AsyncIterableIterator<any>;
  files?: UploadedFileLike[];
};

/**
 * Equivalente Fastify do `FilesInterceptor` do @nestjs/platform-express.
 *
 * Consome o corpo multipart com `@fastify/multipart` e popula:
 *  - `req.files` — arquivos do campo `fieldName` (lidos por `@UploadedFiles()`);
 *  - `req.body`  — demais campos de texto (lidos por `@Body()`, ainda passando
 *                  pelo ValidationPipe global).
 *
 * O plugin `@fastify/multipart` precisa estar registrado na aplicação.
 */
export function FastifyFilesInterceptor(
  fieldName: string,
  maxCount = 10,
  options: { fileSize?: number } = {},
): Type<NestInterceptor> {
  @Injectable()
  class MixinInterceptor implements NestInterceptor {
    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<any>> {
      const req = context.switchToHttp().getRequest<MultipartRequest>();

      if (typeof req.isMultipart !== 'function' || !req.isMultipart()) {
        throw new BadRequestException(
          'A requisição precisa ser multipart/form-data.',
        );
      }

      const files: UploadedFileLike[] = [];
      const body: Record<string, unknown> = {};

      const limits: Record<string, number> = { files: maxCount };
      if (options.fileSize) limits.fileSize = options.fileSize;

      try {
        for await (const part of req.parts!({ limits })) {
          if (part.type === 'file') {
            // Arquivos de outros campos precisam ser drenados para que o
            // iterador avance até a próxima parte.
            const buffer: Buffer = await part.toBuffer();

            if (part.file?.truncated) {
              throw new PayloadTooLargeException(
                `Arquivo "${part.filename}" excede o tamanho máximo permitido.`,
              );
            }
            if (part.fieldname !== fieldName) continue;

            files.push({
              fieldname: part.fieldname,
              originalname: part.filename,
              encoding: part.encoding,
              mimetype: part.mimetype,
              buffer,
              size: buffer.length,
            });
          } else {
            body[part.fieldname] = part.value;
          }
        }
      } catch (err: any) {
        if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new PayloadTooLargeException(
            'Arquivo excede o tamanho máximo permitido.',
          );
        }
        if (err?.code === 'FST_FILES_LIMIT') {
          throw new BadRequestException(
            `Envie no máximo ${maxCount} arquivo(s).`,
          );
        }
        throw err;
      }

      req.files = files;
      req.body = body;

      return next.handle();
    }
  }

  return mixin(MixinInterceptor);
}
