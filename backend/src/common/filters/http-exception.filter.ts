import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as Sentry from '@sentry/nestjs';
import { safeRequestPath, type RequestWithId } from '../middleware/request-id.middleware';

interface ErrorPayload {
  code: string;
  message: string;
  details: unknown;
  request_id: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request & RequestWithId>();
    const response = context.getResponse<Response>();
    const requestId = request.requestId ?? 'unknown';
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const body = exception instanceof HttpException ? exception.getResponse() : undefined;
    const bodyObject = typeof body === 'object' && body !== null
      ? body as Record<string, unknown>
      : undefined;

    const code = typeof bodyObject?.code === 'string'
      ? bodyObject.code
      : this.codeForStatus(status);
    const message = typeof bodyObject?.message === 'string'
      ? bodyObject.message
      : this.messageForStatus(status);
    const details = bodyObject?.details ?? (
      Array.isArray(bodyObject?.message) ? { errors: bodyObject.message } : {}
    );

    const payload: ErrorPayload = {
      code,
      message,
      details,
      request_id: requestId,
    };

    if (status >= 500) {
      Sentry.withScope((scope) => {
        scope.setTag('request_id', requestId);
        scope.setTag('http.status_code', String(status));
        Sentry.captureException(exception);
      });
      this.logger.error(JSON.stringify({
        event: 'http_exception',
        request_id: requestId,
        status_code: status,
        path: safeRequestPath(request),
        method: request.method,
      }));
    }

    response.status(status).json(payload);
  }

  private codeForStatus(status: number): string {
    const codes: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'AUTH_REQUIRED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      413: 'REQUEST_BODY_TOO_LARGE',
      422: 'UNPROCESSABLE_ENTITY',
      429: 'RATE_LIMIT_EXCEEDED',
      503: 'SERVICE_UNAVAILABLE',
    };
    return codes[status] ?? 'INTERNAL_ERROR';
  }

  private messageForStatus(status: number): string {
    const messages: Record<number, string> = {
      400: 'La solicitud contiene datos no válidos.',
      401: 'Se requiere autenticación válida.',
      403: 'No tienes permiso para realizar esta operación.',
      404: 'No se encontró el recurso solicitado.',
      409: 'La operación entra en conflicto con el estado actual.',
      413: 'La solicitud supera el tamaño permitido.',
      422: 'No fue posible procesar la solicitud.',
      429: 'Has enviado demasiadas solicitudes. Inténtalo nuevamente más tarde.',
      503: 'El servicio no está disponible temporalmente.',
    };
    return messages[status] ?? 'Ocurrió un error interno. Inténtalo nuevamente más tarde.';
  }
}
