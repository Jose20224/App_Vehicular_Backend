import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { catchError, finalize, Observable, throwError } from 'rxjs';
import type { RequestWithId } from '../middleware/request-id.middleware';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestLoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request & RequestWithId>();
    const startedAt = Date.now();
    let statusCode = 500;

    return next.handle().pipe(
      catchError((error: unknown) => {
        statusCode = (error as { status?: number })?.status ?? 500;
        return throwError(() => error);
      }),
      finalize(() => {
        const response = context.switchToHttp().getResponse<{ statusCode?: number }>();
        statusCode = response.statusCode ?? statusCode;
        this.logger.log(JSON.stringify({
          event: 'http_request',
          request_id: request.requestId ?? 'unknown',
          method: request.method,
          path: request.path,
          status_code: statusCode,
          duration_ms: Date.now() - startedAt,
        }));
      }),
    );
  }
}
