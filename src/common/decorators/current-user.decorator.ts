import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestWithId } from '../middleware/request-id.middleware';

export interface AuthenticatedUser {
  id: string;
  role: 'user' | 'workshop_owner' | 'provider_owner' | 'admin';
  device_id: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<Request & RequestWithId>();
    return request.user as AuthenticatedUser;
  },
);
