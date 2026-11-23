import { CatalogsController } from '../../src/modules/catalogs/catalogs.controller';
import type { CatalogsService } from '../../src/modules/catalogs/catalogs.service';

describe('CatalogsController ETag', () => {
  it('responde 304 cuando el estado de catálogos no cambió', async () => {
    const catalogs = {
      getCatalogStatus: jest.fn().mockResolvedValue({
        etag: '"catalog-status-current"', catalogs: { departments: { version: '3', etag: '"departments-3"', updated_at: null } },
      }),
    } as unknown as CatalogsService;
    const controller = new CatalogsController(catalogs);
    const response = {
      setHeader: jest.fn(), status: jest.fn().mockReturnThis(), end: jest.fn(), json: jest.fn(),
    };

    await controller.status('"catalog-status-current"', response as never);

    expect(response.setHeader).toHaveBeenCalledWith('ETag', '"catalog-status-current"');
    expect(response.status).toHaveBeenCalledWith(304);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveBeenCalled();
  });

  it('responde 304 para un catálogo cuando coincide If-None-Match', async () => {
    const catalogs = {
      getCatalog: jest.fn().mockResolvedValue({ catalog: 'service-types', catalogVersion: '8', etag: '"service-types-8"', items: [] }),
    } as unknown as CatalogsService;
    const controller = new CatalogsController(catalogs);
    const response = {
      setHeader: jest.fn(), status: jest.fn().mockReturnThis(), end: jest.fn(), json: jest.fn(),
    };

    await controller.getCatalog('service-types', undefined, undefined, 'W/"service-types-8"', response as never);

    expect(response.status).toHaveBeenCalledWith(304);
    expect(response.end).toHaveBeenCalledTimes(1);
    expect(response.json).not.toHaveBeenCalled();
  });
});
