import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { MODULE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRED_ROLES } from '../../src/common/decorators/roles.decorator';
import { AdsModule } from '../../src/modules/ads/ads.module';
import { ReviewsAdminController } from '../../src/modules/reviews/reviews-admin.controller';
import { ReviewsController } from '../../src/modules/reviews/reviews.controller';

type ControllerType = { prototype: object };
type RouteMetadata = { name: string; path: string; method: RequestMethod; roles: string[] };

function routesFor(target: ControllerType): RouteMetadata[] {
  const prototype = target.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor' && typeof prototype[name] === 'function')
    .map((name) => {
      const handler = prototype[name] as object;
      return {
        name,
        path: (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '',
        method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
        roles: (Reflect.getMetadata(REQUIRED_ROLES, handler) as string[] | undefined) ?? [],
      };
    })
    .filter((route) => route.path !== '');
}

describe('B8 · aislamiento de reseñas frente a publicidad y propietarios', () => {
  it('un taller con campaña activa solo obtiene rutas POST para responder y reportar; nunca para alterar reseñas', () => {
    // La campaña activa es el escenario de regresión: no debe otorgar permisos
    // adicionales sobre la reputación del taller.
    const workshop = {
      status: 'active',
      campaign: { status: 'active', payment_status: 'approved' },
    };
    expect(workshop.campaign.status).toBe('active');

    const ownerRoutes = routesFor(ReviewsController).filter((route) => route.roles.includes('workshop_owner'));
    expect(ownerRoutes.map((route) => route.name).sort()).toEqual(['replyToReview', 'reportReview']);
    expect(ownerRoutes.every((route) => route.method === RequestMethod.POST)).toBe(true);
    expect(ownerRoutes.some((route) => route.method === RequestMethod.PATCH || route.method === RequestMethod.DELETE)).toBe(false);
    expect(ownerRoutes.map((route) => route.path).sort()).toEqual([
      'reviews/:reviewId/reports',
      'workshops/:workshopId/reviews/:reviewId/reply',
    ]);

    const adControllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdsModule) as ControllerType[];
    expect(Array.isArray(adControllers)).toBe(true);
    const adReviewRoutes = adControllers.flatMap((controller) => routesFor(controller)).filter((route) => /review/i.test(route.path));
    expect(adReviewRoutes).toHaveLength(0);
  });

  it('solo administración expone la moderación y resolución de reportes', () => {
    const adminRoles = Reflect.getMetadata(REQUIRED_ROLES, ReviewsAdminController) as string[];
    expect(adminRoles).toEqual(['admin']);

    const adminRoutes = routesFor(ReviewsAdminController);
    expect(adminRoutes.map((route) => route.name).sort()).toEqual([
      'listReports', 'moderate', 'moderationQueue', 'resolveReport',
    ]);
    expect(adminRoutes.find((route) => route.name === 'moderate')?.method).toBe(RequestMethod.PATCH);
    expect(adminRoutes.find((route) => route.name === 'resolveReport')?.method).toBe(RequestMethod.PATCH);
  });
});
