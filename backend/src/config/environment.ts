import { existsSync } from 'node:fs';
export type NodeEnvironment = 'development' | 'test' | 'production';
export type EncryptionMode = 'local' | 'kms';
export type OtpMode = 'mock' | 'twilio';
export type DatabaseSslMode = 'disable' | 'require' | 'verify-full';
export type S3CleanupMode = 'mock' | 's3';
export type FcmMode = 'mock' | 'firebase';
export type AssistanceNotificationMode = 'mock' | 'twilio';

export interface AppEnvironment {
  nodeEnv: NodeEnvironment;
  appPort: number;
  apiPrefix: string;
  appTimezone: 'America/Managua';
  logLevel: string;
  databaseUrl: string;
  databasePoolMax: number;
  databasePoolTimeoutSeconds: number;
  databaseSslMode: DatabaseSslMode;
  databaseCaCertPath?: string;
  redisUrl: string;
  redisTlsRequired: boolean;
  corsOrigins: string[];
  rateLimitTtlMs: number;
  rateLimitMaxRequests: number;
  awsRegion: string;
  awsS3PrivateBucket: string;
  awsS3PresignUploadTtlSeconds: number;
  awsS3PresignDownloadTtlSeconds: number;
  awsKmsKeyArn?: string;
  awsKmsBlindIndexKeyArn?: string;
  s3CleanupMode: S3CleanupMode;
  encryptionMode: EncryptionMode;
  localDataKeyBase64?: string;
  localBlindIndexKeyBase64?: string;
  otpMode: OtpMode;
  otpMockCode?: string;
  otpCodeTtlSeconds: number;
  otpMaxRequestsPerHour: number;
  otpMaxFailedAttempts: 5;
  otpLockMinutes: number;
  consentPolicyVersion: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioVerifyServiceSid?: string;
  assistanceNotificationMode: AssistanceNotificationMode;
  twilioSmsFrom?: string;
  twilioWhatsappFrom?: string;
  publicApiBaseUrl?: string;
  assistanceActionTokenTtlSeconds: number;
  assistanceRequestMaxPerHour: number;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtlSeconds: number;
  jwtRefreshTtlSeconds: number;
  maxVehiclesPerUser: number;
  vehiclePhotoMaxBytes: number;
  documentExpiringSoonDays: number;
  fcmMode: FcmMode;
  firebaseServiceAccountBase64?: string;
  firebaseProjectId?: string;
}

const REQUIRED_ENVIRONMENT_VARIABLES = [
  'NODE_ENV',
  'APP_PORT',
  'API_PREFIX',
  'APP_TIMEZONE',
  'DATABASE_URL',
  'DATABASE_POOL_MAX',
  'DATABASE_POOL_TIMEOUT_SECONDS',
  'DATABASE_SSL_MODE',
  'REDIS_URL',
  'REDIS_TLS_REQUIRED',
  'CORS_ORIGINS',
  'RATE_LIMIT_TTL_MS',
  'RATE_LIMIT_MAX_REQUESTS',
  'AWS_REGION',
  'AWS_S3_PRIVATE_BUCKET',
  'AWS_S3_PRESIGN_UPLOAD_TTL_SECONDS',
  'AWS_S3_PRESIGN_DOWNLOAD_TTL_SECONDS',
  'S3_CLEANUP_MODE',
  'CONSENT_POLICY_VERSION',
  'OTP_CODE_TTL_SECONDS',
  'OTP_MAX_REQUESTS_PER_HOUR',
  'OTP_MAX_FAILED_ATTEMPTS',
  'OTP_LOCK_MINUTES',
  'ENCRYPTION_MODE',
  'OTP_MODE',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_ACCESS_TTL_SECONDS',
  'JWT_REFRESH_TTL_SECONDS',
] as const;

function required(source: NodeJS.ProcessEnv, key: string, errors: string[]): string {
  const value = source[key]?.trim();
  if (!value) {
    errors.push(`Falta la variable obligatoria ${key}.`);
    return '';
  }
  return value;
}

function integer(
  source: NodeJS.ProcessEnv,
  key: string,
  errors: string[],
  minimum: number,
  maximum: number,
): number {
  const raw = required(source, key, errors);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    errors.push(`${key} debe ser un entero entre ${minimum} y ${maximum}.`);
    return minimum;
  }
  return value;
}

function boolean(source: NodeJS.ProcessEnv, key: string, errors: string[]): boolean {
  const value = required(source, key, errors).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  errors.push(`${key} solo acepta true o false.`);
  return false;
}

function isUrl(value: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isValidBase64Key(value: string | undefined): boolean {
  if (!value) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

export function validateEnvironment(source: NodeJS.ProcessEnv): AppEnvironment {
  const errors: string[] = [];
  for (const key of REQUIRED_ENVIRONMENT_VARIABLES) {
    if (!source[key]?.trim()) errors.push(`Falta la variable obligatoria ${key}.`);
  }

  const nodeEnv = required(source, 'NODE_ENV', errors);
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    errors.push('NODE_ENV debe ser development, test o production.');
  }

  const appTimezone = required(source, 'APP_TIMEZONE', errors);
  if (appTimezone !== 'America/Managua') {
    errors.push('APP_TIMEZONE debe ser America/Managua para este despliegue.');
  }

  const databaseUrl = required(source, 'DATABASE_URL', errors);
  if (!isUrl(databaseUrl, ['postgres:', 'postgresql:'])) {
    errors.push('DATABASE_URL debe ser una URL PostgreSQL válida.');
  }

  if (isUrl(databaseUrl, ['postgres:', 'postgresql:'])) {
    const username = decodeURIComponent(new URL(databaseUrl).username);
    if (username !== 'app_runtime') {
      errors.push('DATABASE_URL debe utilizar el rol app_runtime, nunca el rol de migraciones.');
    }
  }

  const databaseCaCertPath = source.DATABASE_CA_CERT_PATH?.trim() || undefined;
  if (databaseCaCertPath && !existsSync(databaseCaCertPath)) {
    errors.push('DATABASE_CA_CERT_PATH apunta a un archivo que no existe o no está montado.');
  }

  const databaseSslMode = required(source, 'DATABASE_SSL_MODE', errors);
  if (!['disable', 'require', 'verify-full'].includes(databaseSslMode)) {
    errors.push('DATABASE_SSL_MODE debe ser disable, require o verify-full.');
  }

  const redisUrl = required(source, 'REDIS_URL', errors);
  if (!isUrl(redisUrl, ['redis:', 'rediss:'])) {
    errors.push('REDIS_URL debe ser una URL Redis válida.');
  }
  const redisTlsRequired = boolean(source, 'REDIS_TLS_REQUIRED', errors);
  if (redisTlsRequired && !redisUrl.startsWith('rediss://')) {
    errors.push('REDIS_TLS_REQUIRED=true exige que REDIS_URL use rediss://.');
  }

  const corsOriginsRaw = required(source, 'CORS_ORIGINS', errors);
  const corsOrigins = corsOriginsRaw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (corsOrigins.length === 0 || corsOrigins.includes('*')) {
    errors.push('CORS_ORIGINS debe contener orígenes explícitos; no se permite * .');
  }
  for (const origin of corsOrigins) {
    if (!isUrl(origin, ['http:', 'https:'])) {
      errors.push('Cada origen de CORS debe ser una URL HTTP o HTTPS válida.');
    }
  }

  const encryptionMode = required(source, 'ENCRYPTION_MODE', errors);
  if (!['local', 'kms'].includes(encryptionMode)) {
    errors.push('ENCRYPTION_MODE debe ser local o kms.');
  }
  if (encryptionMode === 'kms' && !source.AWS_KMS_KEY_ARN?.trim()) {
    errors.push('ENCRYPTION_MODE=kms exige AWS_KMS_KEY_ARN.');
  }
  if (encryptionMode === 'kms' && !source.AWS_KMS_BLIND_INDEX_KEY_ARN?.trim()) {
    errors.push('ENCRYPTION_MODE=kms exige AWS_KMS_BLIND_INDEX_KEY_ARN (clave HMAC dedicada).');
  }
  const otpMode = required(source, 'OTP_MODE', errors);
  if (!['mock', 'twilio'].includes(otpMode)) {
    errors.push('OTP_MODE debe ser mock o twilio.');
  }
  const consentPolicyVersion = required(source, 'CONSENT_POLICY_VERSION', errors);
  if (consentPolicyVersion.length > 40 || !/^[A-Za-z0-9._-]+$/.test(consentPolicyVersion)) {
    errors.push('CONSENT_POLICY_VERSION debe tener hasta 40 caracteres alfanuméricos, punto, guion o guion bajo.');
  }
  const otpMockCode = source.OTP_MOCK_CODE?.trim() || undefined;
  if (otpMode === 'mock' && (!otpMockCode || !/^\d{6}$/.test(otpMockCode))) {
    errors.push('OTP_MODE=mock exige OTP_MOCK_CODE de exactamente 6 dígitos.');
  }
  if (otpMode === 'twilio') {
    if (!source.TWILIO_ACCOUNT_SID?.trim()) errors.push('OTP_MODE=twilio exige TWILIO_ACCOUNT_SID.');
    if (!source.TWILIO_AUTH_TOKEN?.trim()) errors.push('OTP_MODE=twilio exige TWILIO_AUTH_TOKEN.');
    if (!source.TWILIO_VERIFY_SERVICE_SID?.trim()) errors.push('OTP_MODE=twilio exige TWILIO_VERIFY_SERVICE_SID.');
  }

  const jwtAccessSecret = required(source, 'JWT_ACCESS_SECRET', errors);
  const jwtRefreshSecret = required(source, 'JWT_REFRESH_SECRET', errors);
  if (jwtAccessSecret.length < 32) errors.push('JWT_ACCESS_SECRET debe tener al menos 32 caracteres.');
  if (jwtRefreshSecret.length < 32) errors.push('JWT_REFRESH_SECRET debe tener al menos 32 caracteres.');
  if (jwtAccessSecret === jwtRefreshSecret) errors.push('Los secretos JWT access y refresh deben ser distintos.');

  const localDataKeyBase64 = source.LOCAL_DATA_KEY_BASE64?.trim() || undefined;
  const localBlindIndexKeyBase64 = source.LOCAL_BLIND_INDEX_KEY_BASE64?.trim() || undefined;
  if (encryptionMode === 'local') {
    if (!isValidBase64Key(localDataKeyBase64)) {
      errors.push('LOCAL_DATA_KEY_BASE64 debe codificar exactamente 32 bytes en Base64.');
    }
    if (!isValidBase64Key(localBlindIndexKeyBase64)) {
      errors.push('LOCAL_BLIND_INDEX_KEY_BASE64 debe codificar exactamente 32 bytes en Base64.');
    }
    if (localDataKeyBase64 && localDataKeyBase64 === localBlindIndexKeyBase64) {
      errors.push('LOCAL_DATA_KEY_BASE64 y LOCAL_BLIND_INDEX_KEY_BASE64 deben ser claves distintas.');
    }
  }

  const s3CleanupMode = required(source, 'S3_CLEANUP_MODE', errors);
  if (!['mock', 's3'].includes(s3CleanupMode)) {
    errors.push('S3_CLEANUP_MODE debe ser mock o s3.');
  }

  if (nodeEnv === 'production') {
    if (databaseSslMode !== 'verify-full') {
      errors.push('Producción exige DATABASE_SSL_MODE=verify-full.');
    }
    if (encryptionMode !== 'kms') {
      errors.push('Producción exige ENCRYPTION_MODE=kms; el cifrado local está prohibido.');
    }
    if (otpMode !== 'twilio') errors.push('Producción exige OTP_MODE=twilio.');
    if (otpMockCode) errors.push('Producción no puede definir OTP_MOCK_CODE.');
    if (s3CleanupMode !== 's3') errors.push('Producción exige S3_CLEANUP_MODE=s3 para procesar eliminaciones.');
    if (!source.AWS_KMS_BLIND_INDEX_KEY_ARN?.trim()) errors.push('Producción exige AWS_KMS_BLIND_INDEX_KEY_ARN.');
    if (!redisTlsRequired) errors.push('Producción exige REDIS_TLS_REQUIRED=true.');
    if (localDataKeyBase64 || localBlindIndexKeyBase64) {
      errors.push('Producción no puede contener claves locales de cifrado.');
    }
    if (!source.AWS_KMS_KEY_ARN?.trim()) errors.push('Producción exige AWS_KMS_KEY_ARN.');
    if (!source.TWILIO_ACCOUNT_SID?.trim()) errors.push('Producción exige TWILIO_ACCOUNT_SID.');
    if (!source.TWILIO_AUTH_TOKEN?.trim()) errors.push('Producción exige TWILIO_AUTH_TOKEN.');
    if (!source.TWILIO_VERIFY_SERVICE_SID?.trim()) errors.push('Producción exige TWILIO_VERIFY_SERVICE_SID.');
  }

  const appPort = integer(source, 'APP_PORT', errors, 1, 65535);
  const apiPrefix = required(source, 'API_PREFIX', errors).replace(/^\/+|\/+$/g, '');
  if (!apiPrefix || !/^[A-Za-z0-9/_-]+$/.test(apiPrefix)) {
    errors.push('API_PREFIX debe ser una ruta simple, por ejemplo api/v1.');
  }
  const databasePoolMax = integer(source, 'DATABASE_POOL_MAX', errors, 1, 100);
  const databasePoolTimeoutSeconds = integer(source, 'DATABASE_POOL_TIMEOUT_SECONDS', errors, 1, 120);
  const rateLimitTtlMs = integer(source, 'RATE_LIMIT_TTL_MS', errors, 1000, 3600000);
  const rateLimitMaxRequests = integer(source, 'RATE_LIMIT_MAX_REQUESTS', errors, 1, 100000);
  const awsRegion = required(source, 'AWS_REGION', errors);
  const awsS3PrivateBucket = required(source, 'AWS_S3_PRIVATE_BUCKET', errors);
  const awsS3PresignUploadTtlSeconds = integer(source, 'AWS_S3_PRESIGN_UPLOAD_TTL_SECONDS', errors, 30, 3600);
  const awsS3PresignDownloadTtlSeconds = integer(source, 'AWS_S3_PRESIGN_DOWNLOAD_TTL_SECONDS', errors, 30, 3600);
  const jwtAccessTtlSeconds = integer(source, 'JWT_ACCESS_TTL_SECONDS', errors, 60, 86400);
  const jwtRefreshTtlSeconds = integer(source, 'JWT_REFRESH_TTL_SECONDS', errors, 3600, 7776000);
  const otpCodeTtlSeconds = integer(source, 'OTP_CODE_TTL_SECONDS', errors, 60, 900);
  const otpMaxRequestsPerHour = integer(source, 'OTP_MAX_REQUESTS_PER_HOUR', errors, 1, 20);
  const otpMaxFailedAttemptsRaw = integer(source, 'OTP_MAX_FAILED_ATTEMPTS', errors, 5, 5);
  const assistanceNotificationMode = (source.ASSISTANCE_NOTIFICATION_MODE?.trim() || (nodeEnv === 'production' ? 'twilio' : 'mock')) as AssistanceNotificationMode;
  if (!['mock', 'twilio'].includes(assistanceNotificationMode)) errors.push('ASSISTANCE_NOTIFICATION_MODE debe ser mock o twilio.');
  const assistanceActionTokenTtlSeconds = source.ASSISTANCE_ACTION_TOKEN_TTL_SECONDS?.trim()
    ? integer(source, 'ASSISTANCE_ACTION_TOKEN_TTL_SECONDS', errors, 60, 86400) : 86400;
  const assistanceRequestMaxPerHour = source.ASSISTANCE_REQUEST_MAX_PER_HOUR?.trim()
    ? integer(source, 'ASSISTANCE_REQUEST_MAX_PER_HOUR', errors, 1, 20) : 3;
  const twilioSmsFrom = source.TWILIO_SMS_FROM?.trim() || undefined;
  const twilioWhatsappFrom = source.TWILIO_WHATSAPP_FROM?.trim() || undefined;
  const publicApiBaseUrl = source.PUBLIC_API_BASE_URL?.trim() || undefined;
  if (twilioSmsFrom && !/^\+[1-9]\d{7,14}$/.test(twilioSmsFrom)) errors.push('TWILIO_SMS_FROM debe tener formato E.164.');
  if (twilioWhatsappFrom && !/^\+[1-9]\d{7,14}$/.test(twilioWhatsappFrom)) errors.push('TWILIO_WHATSAPP_FROM debe tener formato E.164.');
  if (assistanceNotificationMode === 'twilio') {
    if (!source.TWILIO_ACCOUNT_SID?.trim() || !source.TWILIO_AUTH_TOKEN?.trim()) errors.push('ASSISTANCE_NOTIFICATION_MODE=twilio exige TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN.');
    if (!twilioSmsFrom) errors.push('ASSISTANCE_NOTIFICATION_MODE=twilio exige TWILIO_SMS_FROM en formato E.164 para el canal SMS de respaldo.');
  }
  if (publicApiBaseUrl && !isUrl(publicApiBaseUrl, ['https:', 'http:'])) errors.push('PUBLIC_API_BASE_URL debe ser una URL HTTP/HTTPS válida.');
  if (nodeEnv === 'production' && assistanceNotificationMode !== 'twilio') errors.push('Producción exige ASSISTANCE_NOTIFICATION_MODE=twilio.');
  if (nodeEnv === 'production' && (!publicApiBaseUrl || !publicApiBaseUrl.startsWith('https://'))) errors.push('Producción exige PUBLIC_API_BASE_URL HTTPS para enlaces seguros de proveedor.');
  const otpLockMinutes = integer(source, 'OTP_LOCK_MINUTES', errors, 1, 60);
  const maxVehiclesPerUser = source.MAX_VEHICLES_PER_USER?.trim()
    ? integer(source, 'MAX_VEHICLES_PER_USER', errors, 1, 100)
    : 10;
  const vehiclePhotoMaxBytes = source.VEHICLE_PHOTO_MAX_BYTES?.trim()
    ? integer(source, 'VEHICLE_PHOTO_MAX_BYTES', errors, 1024, 20 * 1024 * 1024)
    : 5 * 1024 * 1024;
  const documentExpiringSoonDays = source.DOCUMENT_EXPIRING_SOON_DAYS?.trim()
    ? integer(source, 'DOCUMENT_EXPIRING_SOON_DAYS', errors, 1, 365)
    : 30;
  const fcmMode = (source.FCM_MODE?.trim() || (nodeEnv === 'production' ? 'firebase' : 'mock')) as FcmMode;
  if (!['mock', 'firebase'].includes(fcmMode)) errors.push('FCM_MODE debe ser mock o firebase.');
  const firebaseServiceAccountBase64 = source.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim() || undefined;
  const firebaseProjectId = source.FIREBASE_PROJECT_ID?.trim() || undefined;
  if (fcmMode === 'firebase') {
    if (!firebaseServiceAccountBase64) errors.push('FCM_MODE=firebase exige FIREBASE_SERVICE_ACCOUNT_BASE64.');
    else { try { JSON.parse(Buffer.from(firebaseServiceAccountBase64, 'base64').toString('utf8')); } catch { errors.push('FIREBASE_SERVICE_ACCOUNT_BASE64 debe contener una cuenta de servicio JSON válida en Base64.'); } }
    if (!firebaseProjectId) errors.push('FCM_MODE=firebase exige FIREBASE_PROJECT_ID.');
  }

  if (errors.length > 0) {
    throw new Error(`Configuración inválida. La aplicación no puede iniciar:\n- ${[...new Set(errors)].join('\n- ')}`);
  }

  return {
    nodeEnv: nodeEnv as NodeEnvironment,
    appPort,
    apiPrefix,
    appTimezone: 'America/Managua',
    logLevel: source.LOG_LEVEL?.trim() || 'info',
    databaseUrl,
    databasePoolMax,
    databasePoolTimeoutSeconds,
    databaseSslMode: databaseSslMode as DatabaseSslMode,
    databaseCaCertPath,
    redisUrl,
    redisTlsRequired,
    corsOrigins,
    rateLimitTtlMs,
    rateLimitMaxRequests,
    awsRegion,
    awsS3PrivateBucket,
    awsS3PresignUploadTtlSeconds,
    awsS3PresignDownloadTtlSeconds,
    awsKmsKeyArn: source.AWS_KMS_KEY_ARN?.trim() || undefined,
    awsKmsBlindIndexKeyArn: source.AWS_KMS_BLIND_INDEX_KEY_ARN?.trim() || undefined,
    s3CleanupMode: s3CleanupMode as S3CleanupMode,
    encryptionMode: encryptionMode as EncryptionMode,
    localDataKeyBase64,
    localBlindIndexKeyBase64,
    otpMode: otpMode as OtpMode,
    otpMockCode,
    otpCodeTtlSeconds,
    otpMaxRequestsPerHour,
    otpMaxFailedAttempts: otpMaxFailedAttemptsRaw as 5,
    otpLockMinutes,
    consentPolicyVersion,
    twilioAccountSid: source.TWILIO_ACCOUNT_SID?.trim() || undefined,
    twilioAuthToken: source.TWILIO_AUTH_TOKEN?.trim() || undefined,
    twilioVerifyServiceSid: source.TWILIO_VERIFY_SERVICE_SID?.trim() || undefined,
    assistanceNotificationMode, twilioSmsFrom, twilioWhatsappFrom, publicApiBaseUrl,
    assistanceActionTokenTtlSeconds, assistanceRequestMaxPerHour,
    jwtAccessSecret,
    jwtRefreshSecret,
    jwtAccessTtlSeconds,
    jwtRefreshTtlSeconds,
    maxVehiclesPerUser,
    vehiclePhotoMaxBytes,
    documentExpiringSoonDays,
    fcmMode,
    firebaseServiceAccountBase64,
    firebaseProjectId,
  };
}
