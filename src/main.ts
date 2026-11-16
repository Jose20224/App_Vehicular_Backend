import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { json, urlencoded } from 'express';
import type { ErrorRequestHandler } from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { validateEnvironment } from './config/environment';
import { configureApplication } from './config/configure-application';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import type { RequestWithId } from './common/middleware/request-id.middleware';

const bodyParserErrorHandler: ErrorRequestHandler = (error, request, response, next) => {
  const parserError = error as { type?: unknown };
  const requestId = (request as RequestWithId).requestId ?? 'unknown';

  if (parserError?.type === 'entity.too.large') {
    response.status(413).json({
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'La solicitud supera el tamaño permitido.',
      details: {},
      request_id: requestId,
    });
    return;
  }

  if (parserError?.type === 'entity.parse.failed') {
    response.status(400).json({
      code: 'BAD_REQUEST',
      message: 'La solicitud contiene JSON no válido.',
      details: {},
      request_id: requestId,
    });
    return;
  }

  next(error);
};

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  app.set('trust proxy', false);

  // request_id debe existir también cuando el parser rechaza el body antes de Nest.
  app.use(requestIdMiddleware);
  const apiPrefix = environment.apiPrefix.replace(/^\/+|\/+$/g, '');
  // 50 mutaciones x 256 KiB = 12.5 MiB; se deja un margen para el sobre JSON.
  app.use(`/${apiPrefix}/sync/push`, json({ limit: '13mb' }));
  // Los polígonos GeoJSON de cobertura tienen un máximo de 250 KB validado en DTO.
  app.use(`/${apiPrefix}/assistance-providers`, json({ limit: '300kb' }));
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: true, limit: '100kb' }));
  app.use(bodyParserErrorHandler);

  configureApplication(app, environment, { installRequestId: false });
  await app.listen(environment.appPort, '0.0.0.0');
  Logger.log(`API disponible en el puerto ${environment.appPort}.`, 'Bootstrap');
  Logger.log(`Documentación Swagger: /docs`, 'Bootstrap');
}

void bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(error instanceof Error ? error.message : 'Error desconocido al iniciar la API.');
  process.exitCode = 1;
});
