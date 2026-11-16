import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { AppConfigService } from '../config/config.module';

@Injectable()
export class AccountStorageCleanupService {
  private readonly logger = new Logger(AccountStorageCleanupService.name);
  private readonly s3?: S3Client;

  constructor(private readonly config: AppConfigService) {
    if (config.value.s3CleanupMode === 's3') {
      this.s3 = new S3Client({ region: config.value.awsRegion });
    }
  }

  async deleteUserObjects(userId: string): Promise<'deleted' | 'simulated'> {
    if (this.config.value.s3CleanupMode === 'mock') return 'simulated';
    if (!this.s3) throw new Error('Cliente S3 no inicializado.');

    const prefixes = [`users/${userId}/`, `exports/${userId}/`];
    try {
      for (const prefix of prefixes) await this.deletePrefix(prefix);
      return 'deleted';
    } catch {
      this.logger.error(JSON.stringify({ event: 'account_storage_cleanup_failed', user_id: userId }));
      throw new ServiceUnavailableException({
        code: 'ACCOUNT_DELETION_PENDING',
        message: 'La cuenta quedó protegida y la eliminación de archivos está pendiente. Repite la solicitud para completar el proceso.',
        details: {},
      });
    }
  }

  private async deletePrefix(prefix: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const page = await this.s3!.send(new ListObjectVersionsCommand({
        Bucket: this.config.value.awsS3PrivateBucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }));
      const objects: ObjectIdentifier[] = [
        ...(page.Versions ?? []).map((item) => ({ Key: item.Key!, VersionId: item.VersionId })),
        ...(page.DeleteMarkers ?? []).map((item) => ({ Key: item.Key!, VersionId: item.VersionId })),
      ].filter((item) => Boolean(item.Key));

      if (objects.length > 0) {
        const deleted = await this.s3!.send(new DeleteObjectsCommand({
          Bucket: this.config.value.awsS3PrivateBucket,
          Delete: { Objects: objects, Quiet: true },
        }));
        if (deleted.Errors?.length) throw new Error('S3 no pudo eliminar todas las versiones solicitadas.');
      }

      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker || versionIdMarker);
  }
}
