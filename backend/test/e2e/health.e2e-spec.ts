import { BadRequestException, Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { IsInt, Min } from 'class-validator';
import { Client } from 'pg';
import request from 'supertest';
import { GenericContainer, Wait } from 'testcontainers';
import { configureApplication } from '../../src/config/configure-application';

class ValidationProbeDto {
  @IsInt()
  @Min(1)
  quantity!: number;
}

@Controller('validation-probe')
class ValidationProbeController {
  @Post()
  create(@Body() body: ValidationProbeDto): { quantity: number } {
    if (body.quantity < 1) throw new BadRequestException();
    return { quantity: body.quantity };
  }
}

describe('GET /health (PostGIS + Redis mediante Testcontainers)', () => {
  jest.setTimeout(120_000);

  const adminPassword = 'test-admin-password';
  const migratorPassword = 'test-migrator-password';
  const runtimePassword = 'test-runtime-password';
  const redisPassword = 'test-redis-password';
  let postgresContainer: Awaited<ReturnType<GenericContainer['start']>>;
  let redisContainer: Awaited<ReturnType<GenericContainer['start']>>;
  let adminClient: Client;
  let app: INestApplication;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    postgresContainer = await new GenericContainer('postgis/postgis:16-3.5')
      .withEnvironment({
        POSTGRES_USER: 'postgres_admin',
        POSTGRES_PASSWORD: adminPassword,
        POSTGRES_DB: 'vehicular_test',
      })
      .withExposedPorts(5432)
      // The image first starts a temporary server for init scripts, then restarts.
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .start();

    redisContainer = await new GenericContainer('redis:7.4-alpine')
      .withCommand(['redis-server', '--requirepass', redisPassword])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();

    const dbHost = postgresContainer.getHost();
    const dbPort = postgresContainer.getMappedPort(5432);
    adminClient = new Client({
      host: dbHost,
      port: dbPort,
      user: 'postgres_admin',
      password: adminPassword,
      database: 'vehicular_test',
    });
    await adminClient.connect();
    await adminClient.query(`CREATE ROLE app_migrator LOGIN PASSWORD '${migratorPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await adminClient.query(`CREATE ROLE app_runtime LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await adminClient.query('GRANT CONNECT ON DATABASE vehicular_test TO app_migrator, app_runtime');
    await adminClient.query('GRANT USAGE, CREATE ON SCHEMA public TO app_migrator');
    await adminClient.query('GRANT USAGE ON SCHEMA public TO app_runtime');
    await adminClient.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await adminClient.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    const dbUrl = `postgresql://app_runtime:${runtimePassword}@${dbHost}:${dbPort}/vehicular_test?schema=public&connection_limit=3&pool_timeout=10`;
    const migrationUrl = `postgresql://app_migrator:${migratorPassword}@${dbHost}:${dbPort}/vehicular_test?schema=public`;
    const redisUrl = `redis://:${redisPassword}@${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}/0`;

    Object.assign(process.env, {
      NODE_ENV: 'test',
      APP_PORT: '3000',
      API_PREFIX: 'api/v1',
      APP_TIMEZONE: 'America/Managua',
      LOG_LEVEL: 'error',
      DATABASE_URL: dbUrl,
      DATABASE_MIGRATION_URL: migrationUrl,
      DATABASE_POOL_MAX: '3',
      DATABASE_POOL_TIMEOUT_SECONDS: '10',
      DATABASE_SSL_MODE: 'disable',
      REDIS_URL: redisUrl,
      REDIS_TLS_REQUIRED: 'false',
      CORS_ORIGINS: 'http://localhost:3000',
      RATE_LIMIT_TTL_MS: '60000',
      RATE_LIMIT_MAX_REQUESTS: '120',
      AWS_REGION: 'us-east-1',
      AWS_S3_PRIVATE_BUCKET: 'vehicular-test-private',
      AWS_S3_PRESIGN_UPLOAD_TTL_SECONDS: '300',
      AWS_S3_PRESIGN_DOWNLOAD_TTL_SECONDS: '600',
      ENCRYPTION_MODE: 'local',
      LOCAL_DATA_KEY_BASE64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      LOCAL_BLIND_INDEX_KEY_BASE64: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
      OTP_MODE: 'mock',
      JWT_ACCESS_SECRET: 'e2e-access-secret-000000000000000000000000000000',
      JWT_REFRESH_SECRET: 'e2e-refresh-secret-000000000000000000000000000000',
      JWT_ACCESS_TTL_SECONDS: '900',
      JWT_REFRESH_TTL_SECONDS: '2592000',
    });

    // Importación diferida: la configuración se valida después de preparar los contenedores.
    const { AppModule } = await import('../../src/app.module');
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ValidationProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    const { validateEnvironment } = await import('../../src/config/environment');
    configureApplication(app, validateEnvironment(process.env));
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (moduleRef) await moduleRef.close();
    if (adminClient) await adminClient.end();
    if (redisContainer) await redisContainer.stop();
    if (postgresContainer) await postgresContainer.stop();
  });

  it('responde con API, PostgreSQL y Redis disponibles', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('ok');
        expect(body.dependencies).toEqual({ database: 'up', redis: 'up' });
        expect(typeof body.server_time).toBe('string');
      });
  });

  it('devuelve el formato uniforme en español para errores de DTO', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/validation-probe')
      .send({ quantity: 'no-es-entero', unexpected: true })
      .expect(400);

    expect(response.body).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'La solicitud contiene datos no válidos.',
      request_id: expect.any(String),
    });
    expect(response.body.details.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: 'quantity' }),
      expect.objectContaining({ property: 'unexpected' }),
    ]));
    expect(response.headers['x-request-id']).toBe(response.body.request_id);
  });
});
