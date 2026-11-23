import { ConflictException } from '@nestjs/common';
import { ReviewsService } from '../../src/modules/reviews/reviews.service';

describe('B8 · período de enfriamiento de reseñas', () => {
  it('rechaza un segundo intento del mismo usuario y taller dentro de seis meses', async () => {
    const tx = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: '00000000-0000-7000-8000-000000000001' }])
        .mockResolvedValueOnce([{ has_recent_review: true }]),
      review: { create: jest.fn() },
      vehicle: { findFirst: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)),
    };
    const service = new ReviewsService(prisma as never);

    await expect(service.createReview('00000000-0000-7000-8000-000000000002', {
      workshop_id: '00000000-0000-7000-8000-000000000001',
      rating: 5,
      comment: 'Buen servicio.',
    })).rejects.toBeInstanceOf(ConflictException);

    expect(tx.review.create).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
