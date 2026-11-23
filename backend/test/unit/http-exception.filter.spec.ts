import { BadRequestException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';

describe('HttpExceptionFilter', () => {
  it('serializa errores de validación con el contrato uniforme y request_id', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const request = { requestId: 'req_test_123', path: '/api/v1/example', method: 'POST' };
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;
    const filter = new HttpExceptionFilter();

    filter.catch(new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'La solicitud contiene datos no válidos.',
      details: { errors: [{ property: 'name', constraints: ['name debe ser una cadena'] }] },
    }), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith({
      code: 'VALIDATION_ERROR',
      message: 'La solicitud contiene datos no válidos.',
      details: { errors: [{ property: 'name', constraints: ['name debe ser una cadena'] }] },
      request_id: 'req_test_123',
    });
  });

  it('no filtra detalles internos de errores 500', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ requestId: 'req_internal', path: '/health', method: 'GET' }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;

    new HttpExceptionFilter().catch(new Error('secret database connection string'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'Ocurrió un error interno. Inténtalo nuevamente más tarde.',
      details: {},
      request_id: 'req_internal',
    });
  });
});
