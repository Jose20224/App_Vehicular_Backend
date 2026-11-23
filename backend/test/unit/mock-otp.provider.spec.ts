import { MockOtpProvider } from '../../src/modules/auth/providers/mock-otp.provider';
import type { AppConfigService } from '../../src/config/config.module';

describe('MockOtpProvider', () => {
  it('aprueba una sola vez el código simulado', async () => {
    const provider = new MockOtpProvider({
      value: { otpMockCode: '123456', otpCodeTtlSeconds: 300 },
    } as AppConfigService);

    await provider.request('+50588881234', 'sms');
    await expect(provider.verify('+50588881234', '123456')).resolves.toBe(true);
    await expect(provider.verify('+50588881234', '123456')).resolves.toBe(false);
  });

  it('rechaza el código incorrecto sin consumir el challenge vigente', async () => {
    const provider = new MockOtpProvider({
      value: { otpMockCode: '123456', otpCodeTtlSeconds: 300 },
    } as AppConfigService);

    await provider.request('+50588881234', 'whatsapp');
    await expect(provider.verify('+50588881234', '000000')).resolves.toBe(false);
    await expect(provider.verify('+50588881234', '123456')).resolves.toBe(true);
  });

  it('rechaza challenges vencidos', async () => {
    const now = Date.now();
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const provider = new MockOtpProvider({
        value: { otpMockCode: '123456', otpCodeTtlSeconds: 60 },
      } as AppConfigService);
      await provider.request('+50588881234', 'sms');
      dateNow.mockReturnValue(now + 60_001);
      await expect(provider.verify('+50588881234', '123456')).resolves.toBe(false);
    } finally {
      dateNow.mockRestore();
    }
  });
});
