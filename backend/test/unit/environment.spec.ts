import { validateEnvironment } from '../../src/config/environment';

const validEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  APP_PORT: '3000',
  API_PREFIX: 'api/v1',
  APP_TIMEZONE: 'America/Managua',
  DATABASE_URL: 'postgresql://app_runtime:runtime@localhost:5432/vehicular_test?schema=public',
  DATABASE_MIGRATION_URL: 'postgresql://app_migrator:migrator@localhost:5432/vehicular_test?schema=public',
  DATABASE_POOL_MAX: '3',
  DATABASE_POOL_TIMEOUT_SECONDS: '10',
  DATABASE_SSL_MODE: 'disable',
  REDIS_URL: 'redis://:redis-password@localhost:6379/0',
  REDIS_TLS_REQUIRED: 'false',
  CORS_ORIGINS: 'http://localhost:3000,http://127.0.0.1:3000',
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
  OTP_MOCK_CODE: '123456',
  OTP_CODE_TTL_SECONDS: '300',
  OTP_MAX_REQUESTS_PER_HOUR: '5',
  OTP_MAX_FAILED_ATTEMPTS: '5',
  OTP_LOCK_MINUTES: '15',
  CONSENT_POLICY_VERSION: 'privacy-2026-11-v1',
  S3_CLEANUP_MODE: 'mock',
  JWT_ACCESS_SECRET: 'unit-test-access-secret-000000000000000000000000',
  JWT_REFRESH_SECRET: 'unit-test-refresh-secret-000000000000000000000000',
  JWT_ACCESS_TTL_SECONDS: '900',
  JWT_REFRESH_TTL_SECONDS: '2592000',
});

describe('validateEnvironment', () => {
  it('acepta configuración de pruebas completa y devuelve tipos normalizados', () => {
    const config = validateEnvironment(validEnvironment());

    expect(config.nodeEnv).toBe('test');
    expect(config.appPort).toBe(3000);
    expect(config.databasePoolMax).toBe(3);
    expect(config.corsOrigins).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    expect(config.maxVehiclesPerUser).toBe(10);
    expect(config.vehiclePhotoMaxBytes).toBe(5 * 1024 * 1024);
    expect(config.documentExpiringSoonDays).toBe(30);
    expect(config.fcmMode).toBe('mock');
    expect(config.assistanceNotificationMode).toBe('mock');
    expect(config.assistanceActionTokenTtlSeconds).toBe(86400);
    expect(config.assistanceRequestMaxPerHour).toBe(3);
  });

  it('no requiere ni expone la credencial de migración en la configuración runtime', () => {
    const env = validEnvironment();
    delete env.DATABASE_MIGRATION_URL;
    const config = validateEnvironment(env);
    expect(config).not.toHaveProperty('databaseMigrationUrl');
  });


  it('permite configurar el umbral de vencimiento de documentos', () => {
    const env = validEnvironment();
    env.DOCUMENT_EXPIRING_SOON_DAYS = '45';
    expect(validateEnvironment(env).documentExpiringSoonDays).toBe(45);
  });

  it('rechaza un umbral de vencimiento fuera del rango permitido', () => {
    const env = validEnvironment();
    env.DOCUMENT_EXPIRING_SOON_DAYS = '400';
    expect(() => validateEnvironment(env)).toThrow(/DOCUMENT_EXPIRING_SOON_DAYS debe ser un entero entre 1 y 365/);
  });

  it('permite configurar el límite de vehículos y el tamaño máximo de fotografía', () => {
    const env = validEnvironment();
    env.MAX_VEHICLES_PER_USER = '15';
    env.VEHICLE_PHOTO_MAX_BYTES = '10485760';
    const config = validateEnvironment(env);
    expect(config.maxVehiclesPerUser).toBe(15);
    expect(config.vehiclePhotoMaxBytes).toBe(10485760);
  });

  it('rechaza un límite de vehículos fuera del rango permitido', () => {
    const env = validEnvironment();
    env.MAX_VEHICLES_PER_USER = '101';
    expect(() => validateEnvironment(env)).toThrow(/MAX_VEHICLES_PER_USER debe ser un entero entre 1 y 100/);
  });

  it('rechaza CORS abierto a cualquier origen', () => {
    const env = validEnvironment();
    env.CORS_ORIGINS = '*';
    expect(() => validateEnvironment(env)).toThrow(/no se permite/);
  });

  it('impide arrancar cuando falta una variable obligatoria', () => {
    const env = validEnvironment();
    delete env.DATABASE_URL;

    expect(() => validateEnvironment(env)).toThrow(/Falta la variable obligatoria DATABASE_URL/);
  });

  it('exige claves distintas para cifrado de datos e índice ciego', () => {
    const env = validEnvironment();
    env.LOCAL_BLIND_INDEX_KEY_BASE64 = env.LOCAL_DATA_KEY_BASE64;
    expect(() => validateEnvironment(env)).toThrow(/deben ser claves distintas/);
  });

  it('rechaza el uso de claves locales y OTP simulado en producción', () => {
    const env = {
      ...validEnvironment(),
      NODE_ENV: 'production',
      DATABASE_SSL_MODE: 'disable',
      REDIS_TLS_REQUIRED: 'false',
      ENCRYPTION_MODE: 'local',
      OTP_MODE: 'mock',
  OTP_MOCK_CODE: '123456',
  OTP_CODE_TTL_SECONDS: '300',
  OTP_MAX_REQUESTS_PER_HOUR: '5',
  OTP_MAX_FAILED_ATTEMPTS: '5',
  OTP_LOCK_MINUTES: '15',
  CONSENT_POLICY_VERSION: 'privacy-2026-11-v1',
  S3_CLEANUP_MODE: 'mock',
    };

    expect(() => validateEnvironment(env)).toThrow(/Producción exige ENCRYPTION_MODE=kms/);
  });

  it('impide activar OTP simulado en producción aunque se definan credenciales Twilio', () => {
    const env = {
      ...validEnvironment(),
      NODE_ENV: 'production',
      DATABASE_SSL_MODE: 'verify-full',
      REDIS_URL: 'rediss://:secret@redis.example.invalid:6380/0',
      REDIS_TLS_REQUIRED: 'true',
      ENCRYPTION_MODE: 'kms',
      AWS_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000001',
      AWS_KMS_BLIND_INDEX_KEY_ARN: 'arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000002',
      LOCAL_DATA_KEY_BASE64: '',
      LOCAL_BLIND_INDEX_KEY_BASE64: '',
      OTP_MODE: 'mock',
      OTP_MOCK_CODE: '123456',
      S3_CLEANUP_MODE: 's3',
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
      TWILIO_AUTH_TOKEN: 'fake-token',
      TWILIO_VERIFY_SERVICE_SID: 'VA00000000000000000000000000000000',
    };
    expect(() => validateEnvironment(env)).toThrow(/Producción exige OTP_MODE=twilio/);
  });

  it('permite configurar los límites de asistencia y rechaza un máximo fuera de rango', () => {
    const env = validEnvironment();
    env.ASSISTANCE_ACTION_TOKEN_TTL_SECONDS = '3600';
    env.ASSISTANCE_REQUEST_MAX_PER_HOUR = '5';
    expect(validateEnvironment(env)).toMatchObject({ assistanceActionTokenTtlSeconds: 3600, assistanceRequestMaxPerHour: 5 });
    env.ASSISTANCE_REQUEST_MAX_PER_HOUR = '21';
    expect(() => validateEnvironment(env)).toThrow(/ASSISTANCE_REQUEST_MAX_PER_HOUR debe ser un entero entre 1 y 20/);
  });

  it('rechaza DATABASE_URL conectada con el rol de migraciones', () => {
    const env = validEnvironment();
    env.DATABASE_URL = 'postgresql://app_migrator:secret@localhost:5432/vehicular_test';

    expect(() => validateEnvironment(env)).toThrow(/DATABASE_URL debe utilizar el rol app_runtime/);
  });
});


describe('FCM environment configuration', () => {
  it('requires Firebase service credentials in production mode', () => {
    const env = { ...validEnvironment(), NODE_ENV: 'production', DATABASE_SSL_MODE: 'verify-full',
      REDIS_URL: 'rediss://:redis-password@localhost:6380/0', REDIS_TLS_REQUIRED: 'true',
      ENCRYPTION_MODE: 'kms', AWS_KMS_KEY_ARN: 'arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000001',
      AWS_KMS_BLIND_INDEX_KEY_ARN: 'arn:aws:kms:us-east-1:111122223333:key/00000000-0000-4000-8000-000000000002',
      LOCAL_DATA_KEY_BASE64: '', LOCAL_BLIND_INDEX_KEY_BASE64: '', OTP_MODE: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret', TWILIO_VERIFY_SERVICE_SID: 'VA123',
      S3_CLEANUP_MODE: 's3', FCM_MODE: 'firebase', FIREBASE_PROJECT_ID: 'vehicular-test' };
    expect(() => validateEnvironment(env)).toThrow(/FIREBASE_SERVICE_ACCOUNT_BASE64/);
  });
});
