import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

export interface RequestWithId extends Request {
  requestId: string;
  user?: AuthenticatedUser;
}

export function requestIdMiddleware(request: Request, response: Response, next: NextFunction): void {
  const candidate = request.header('x-request-id');
  const requestId = candidate && /^[A-Za-z0-9._:-]{1,100}$/.test(candidate)
    ? candidate
    : `req_${randomUUID()}`;

  (request as RequestWithId).requestId = requestId;
  response.setHeader('x-request-id', requestId);
  next();
}
