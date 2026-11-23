import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'is_public_route';
export const Public = () => SetMetadata(IS_PUBLIC, true);
