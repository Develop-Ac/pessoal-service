import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import * as dotenv from 'dotenv';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

// Serializa BigInt (ex.: colunas BIGINT como ComissaoMovimento.nfs) como número
// no JSON — sem isso, JSON.stringify lança "Do not know how to serialize a BigInt".
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (
  this: bigint,
) {
  return Number(this);
};

/** Limite de corpo das requisições (equivalente ao body-parser 25mb anterior). */
const BODY_LIMIT = 25 * 1024 * 1024;

async function bootstrap() {
  // Carrega variáveis do arquivo .env (se existir)
  try {
    dotenv.config();
  } catch (_) {}
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Confia no proxy reverso para obter o IP real do cliente (rate-limit por IP).
      trustProxy: 1,
      // Fastify já parseia application/json e x-www-form-urlencoded nativamente;
      // aqui só se ajusta o limite que antes vinha do body-parser.
      bodyLimit: BODY_LIMIT,
    }),
    { bufferLogs: true },
  );

  // Validação/sanitização global de payloads.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Filtro global: não vaza stack/detalhes em erros não tratados.
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // Upload multipart (PDFs da folha) — substitui o multer do platform-express.
  await app.register(multipart, {
    limits: { fileSize: BODY_LIMIT },
  });

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()) ?? true,
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
  });

  if (process.env.SWAGGER_ENABLED === 'true') {
    const config = new DocumentBuilder()
      .setTitle('RH/DP — Folha para DRE API')
      .setDescription('API do módulo Pessoal: importação de folha e rateio para DRE')
      .setVersion('1.0.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT do /login' },
        'jwt',
      )
      .addApiKey(
        { type: 'apiKey', name: 'token', in: 'query', description: 'APP_TOKEN (legado)' },
        'appToken',
      )
      .addServer(process.env.PUBLIC_URL ?? 'http://localhost:8000')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
      customSiteTitle: 'RH/DP — Swagger',
    });
  }

  // Encerramento gracioso (PrismaService.$disconnect em SIGTERM/SIGINT).
  app.enableShutdownHooks();

  const port = parseInt(process.env.PORT || '8000', 10);
  await app.listen(port, '0.0.0.0');
  console.log(`API listening on http://localhost:${port}`);
  if (process.env.SWAGGER_ENABLED === 'true') {
    console.log(`Swagger em http://localhost:${port}/docs`);
  }
}

bootstrap();
