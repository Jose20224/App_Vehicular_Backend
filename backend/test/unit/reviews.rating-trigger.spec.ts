import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('B8 · agregados transaccionales de reputación', () => {
  const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20261113150000_b8_reviews_ratings/migration.sql'), 'utf8');

  it('refuerza el período de seis meses incluso ante inserciones SQL concurrentes', () => {
    expect(migration).toContain('enforce_review_six_month_cooldown');
    expect(migration).toContain("INTERVAL '6 months'");
    expect(migration).toContain('FOR UPDATE');
  });

  it('solo cuenta reseñas publicadas que no estén retiradas', () => {
    expect(migration).toContain("r.status = 'published'");
    expect(migration).toContain('r.deleted_at IS NULL');
    expect(migration).toContain('ROUND(AVG(r.rating)::numeric, 2)');
    expect(migration).toContain('COUNT(*)::integer AS review_count');
  });

  it('bloquea cambios directos del promedio y total fuera del trigger de reseñas', () => {
    expect(migration).toContain('workshop_rating_summary_is_managed_by_reviews');
    expect(migration).toContain("current_setting('app.review_rating_recalc', TRUE) IS DISTINCT FROM 'on'");
  });

  it('exige usuario administrador activo para aprobar, rechazar o retirar reseñas', () => {
    expect(migration).toContain('only_active_admin_can_moderate_reviews');
    expect(migration).toContain("u.role::text = 'admin'");
    expect(migration).toContain("u.status::text = 'active'");
  });
});
