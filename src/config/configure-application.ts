import {
  BadRequestException,
  INestApplication,
  ValidationPipe,
  RequestMethod,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { ValidationError } from 'class-validator';
import { AppEnvironment } from './environment';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { RequestLoggingInterceptor } from '../common/interceptors/request-logging.interceptor';
import { requestIdMiddleware } from '../common/middleware/request-id.middleware';

function flattenValidationErrors(errors: ValidationError[]): Array<Record<string, unknown>> {
  return errors.flatMap((error) => {
    const current = error.constraints
      ? [{ property: error.property, constraints: Object.values(error.constraints) }]
      : [];
    return [...current, ...flattenValidationErrors(error.children ?? [])];
  });
}

export function configureApplication(
  app: INestApplication,
  environment: AppEnvironment,
  options: { installRequestId?: boolean } = {},
): void {
  if (options.installRequestId !== false) app.use(requestIdMiddleware);
  app.setGlobalPrefix(environment.apiPrefix, {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
  app.enableCors({
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) => {
      if (!origin || environment.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origen CORS no autorizado.'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key', 'If-None-Match'],
    exposedHeaders: ['X-Request-Id', 'ETag', 'Cache-Control'],
    credentials: false,
    maxAge: 600,
  });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) => new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'La solicitud contiene datos no válidos.',
      details: { errors: flattenValidationErrors(errors) },
    }),
  }));
  app.useGlobalInterceptors(new RequestLoggingInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('API de gestión vehicular y asistencia en carretera')
    .setDescription('Contrato HTTP de la API. Todas las rutas de negocio usan el prefijo configurado.')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);

  // Nest incorpora el prefijo global al servidor OpenAPI. /health es una
  // excepción operativa y necesita sobrescribir el servidor solo para su GET.
  const prefixedHealthPath = `/${environment.apiPrefix}/health`;
  if (document.paths[prefixedHealthPath] && !document.paths['/health']) {
    document.paths['/health'] = document.paths[prefixedHealthPath];
    delete document.paths[prefixedHealthPath];
  }
  const healthOperation = document.paths['/health']?.get;
  if (healthOperation) {
    healthOperation.servers = [{ url: '/' }];
  }

  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: false },
  });
}
