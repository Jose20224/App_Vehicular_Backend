import { Controller, Get, Headers, Param, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiNotModifiedResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { CatalogsService } from './catalogs.service';

@ApiTags('Catálogos')
@Controller('catalogs')
export class CatalogsController {
  constructor(private readonly catalogs: CatalogsService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'Consultar en una sola respuesta las versiones y ETag de todos los catálogos.' })
  @ApiOkResponse({ description: 'Mapa de catálogos y sus versiones actuales.' })
  @ApiNotModifiedResponse({ description: 'Ningún catálogo ha cambiado desde la última consulta.' })
  @ApiHeader({ name: 'If-None-Match', required: false })
  async status(@Headers('if-none-match') ifNoneMatch: string | undefined, @Res() response: Response): Promise<void> {
    const result = await this.catalogs.getCatalogStatus();
    response.setHeader('ETag', result.etag);
    response.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    if (this.matchesEtag(ifNoneMatch, result.etag)) { response.status(304).end(); return; }
    response.status(200).json({ catalogs: result.catalogs });
  }

  @Public()
  @Get(':name')
  @ApiOperation({ summary: 'Descargar un catálogo público con ETag y versión para caché local.' })
  @ApiOkResponse({ description: 'Catálogo y versión vigentes; incluye el header ETag.' })
  @ApiNotModifiedResponse({ description: 'El catálogo no cambió desde el ETag enviado.' })
  @ApiQuery({ name: 'brand_id', required: false, description: 'Filtro para vehicle-models.' })
  @ApiQuery({ name: 'department_id', required: false, description: 'Filtro para municipalities.' })
  @ApiHeader({ name: 'If-None-Match', required: false })
  async getCatalog(
    @Param('name') name: string,
    @Query('brand_id') brandId: string | undefined,
    @Query('department_id') departmentId: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.catalogs.getCatalog(name, { brandId, departmentId });
    response.setHeader('ETag', result.etag);
    response.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    if (this.matchesEtag(ifNoneMatch, result.etag)) { response.status(304).end(); return; }
    response.status(200).json({ catalog: result.catalog, catalog_version: result.catalogVersion, items: result.items });
  }

  private matchesEtag(header: string | undefined, etag: string): boolean {
    if (!header) return false;
    return header.split(',').some((candidate) => {
      const value = candidate.trim();
      return value === '*' || value === etag || value.replace(/^W\//, '') === etag;
    });
  }
}
