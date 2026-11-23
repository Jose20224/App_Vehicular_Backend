import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfigService } from '../config/config.module';

export interface SignedUpload {
  url: string;
  expiresInSeconds: number;
  requiredHeaders: Record<string, string>;
  simulated: boolean;
}

export interface StoredObjectMetadata {
  contentLength?: number;
  contentType?: string;
}

@Injectable()
export class ObjectStorageService {
  private readonly logger = new Logger(ObjectStorageService.name);
  private readonly s3?: S3Client;

  constructor(private readonly config: AppConfigService) {
    if (config.value.s3CleanupMode === 's3') {
      this.s3 = new S3Client({ region: config.value.awsRegion });
    }
  }

  async createUploadUrl(
    key: string,
    contentType: string,
    contentLength: number,
  ): Promise<SignedUpload> {
    const expiresInSeconds = this.config.value.awsS3PresignUploadTtlSeconds;
    const requiredHeaders = { 'Content-Type': contentType, 'Content-Length': String(contentLength) };
    if (!this.s3) {
      return {
        url: `https://s3.mock.invalid/upload/${encodeURIComponent(key)}?expires_in=${expiresInSeconds}`,
        expiresInSeconds,
        requiredHeaders,
        simulated: true,
      };
    }

    try {
      const url = await getSignedUrl(
        this.s3,
        new PutObjectCommand({
          Bucket: this.config.value.awsS3PrivateBucket,
          Key: key,
          ContentType: contentType,
          ContentLength: contentLength,
        }),
        { expiresIn: expiresInSeconds },
      );
      return { url, expiresInSeconds, requiredHeaders, simulated: false };
    } catch {
      this.logger.error('No fue posible generar una URL de subida firmada.');
      throw new ServiceUnavailableException({
        code: 'STORAGE_SIGNING_UNAVAILABLE',
        message: 'El almacenamiento de archivos no está disponible temporalmente.',
        details: {},
      });
    }
  }

  async createDownloadUrl(key: string): Promise<{ url: string; expiresInSeconds: number; simulated: boolean }> {
    const expiresInSeconds = this.config.value.awsS3PresignDownloadTtlSeconds;
    if (!this.s3) {
      return {
        url: `https://s3.mock.invalid/download/${encodeURIComponent(key)}?expires_in=${expiresInSeconds}`,
        expiresInSeconds,
        simulated: true,
      };
    }
    try {
      const url = await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.config.value.awsS3PrivateBucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
      return { url, expiresInSeconds, simulated: false };
    } catch {
      throw new ServiceUnavailableException({
        code: 'STORAGE_SIGNING_UNAVAILABLE',
        message: 'El almacenamiento de archivos no está disponible temporalmente.',
        details: {},
      });
    }
  }

  async headObject(key: string): Promise<StoredObjectMetadata> {
    if (!this.s3) return {};
    try {
      const result = await this.s3.send(new HeadObjectCommand({
        Bucket: this.config.value.awsS3PrivateBucket,
        Key: key,
      }));
      return { contentLength: result.ContentLength, contentType: result.ContentType };
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && '$metadata' in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
      if (statusCode === 404) throw new ConflictException({
        code: 'STORAGE_OBJECT_NOT_FOUND',
        message: 'Todavía no se encuentra el archivo en el almacenamiento. Completa la subida y vuelve a confirmar.',
        details: {},
      });
      throw new ServiceUnavailableException({
        code: 'STORAGE_OBJECT_NOT_VERIFIED',
        message: 'No fue posible verificar el archivo cargado. Confirma nuevamente cuando haya conexión.',
        details: {},
      });
    }
  }

  async getObjectPrefix(key: string, maxBytes = 32): Promise<Buffer | null> {
    if (!this.s3) return null;
    try {
      const result = await this.s3.send(new GetObjectCommand({
        Bucket: this.config.value.awsS3PrivateBucket,
        Key: key,
        Range: `bytes=0-${maxBytes - 1}`,
      }));
      if (!result.Body) throw new Error('S3 no devolvió contenido.');
      const bytes = await result.Body.transformToByteArray();
      return Buffer.from(bytes).subarray(0, maxBytes);
    } catch {
      throw new ServiceUnavailableException({
        code: 'DOCUMENT_FILE_INSPECTION_FAILED',
        message: 'No fue posible verificar el contenido real del archivo. Intenta confirmar la subida nuevamente.',
        details: {},
      });
    }
  }

  async deleteObject(key: string): Promise<void> {
    if (!this.s3) return;
    try {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: this.config.value.awsS3PrivateBucket,
        Key: key,
      }));
    } catch {
      // No se lanza para no revertir una escritura ya confirmada en PostgreSQL.
      // La limpieza durable se implementará con el reconciliador/outbox registrado en F-051.
      this.logger.warn(JSON.stringify({ event: 'storage_cleanup_failed_not_queued' }));
    }
  }
}
