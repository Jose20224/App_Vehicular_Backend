import { SetMetadata } from '@nestjs/common';

export const RESOURCE_OWNER = 'resource_owner';
export type OwnedResource = 'vehicle' | 'vehicle_document' | 'insurance_policy' | 'workshop' | 'assistance_provider' | 'assistance_request';
export const ResourceOwner = (resource: OwnedResource, idParam = 'id') =>
  SetMetadata(RESOURCE_OWNER, { resource, idParam });
