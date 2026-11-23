import { SetMetadata } from '@nestjs/common';

export const REQUIRED_ROLES = 'required_roles';
export type AppRole = 'user' | 'workshop_owner' | 'provider_owner' | 'admin';
export const Roles = (...roles: AppRole[]) => SetMetadata(REQUIRED_ROLES, roles);
