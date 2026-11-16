import { Global, Module } from '@nestjs/common';
import { AccountStorageCleanupService } from './account-storage-cleanup.service';
import { FieldCryptoService } from './field-crypto.service';

@Global()
@Module({
  providers: [FieldCryptoService, AccountStorageCleanupService],
  exports: [FieldCryptoService, AccountStorageCleanupService],
})
export class SecurityModule {}
