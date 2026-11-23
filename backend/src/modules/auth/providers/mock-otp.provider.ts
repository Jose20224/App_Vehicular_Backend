import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../config/config.module';
import type { OtpChannel, OtpProvider } from './otp-provider.interface';

@Injectable()
export class MockOtpProvider implements OtpProvider {
  private readonly challenges = new Map<string, { code: string; expiresAt: number }>();

  constructor(private readonly config: AppConfigService) {}

  async request(phone: string, _channel: OtpChannel): Promise<void> {
    this.removeExpired();
    this.challenges.set(phone, {
      code: this.config.value.otpMockCode ?? '',
      expiresAt: Date.now() + this.config.value.otpCodeTtlSeconds * 1000,
    });
  }

  async verify(phone: string, code: string): Promise<boolean> {
    this.removeExpired();
    const challenge = this.challenges.get(phone);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      this.challenges.delete(phone);
      return false;
    }
    if (challenge.code !== code) return false;
    // Imita el comportamiento de Twilio Verify: una verificación aprobada
    // no puede reutilizarse para emitir más sesiones.
    this.challenges.delete(phone);
    return true;
  }

  private removeExpired(): void {
    const now = Date.now();
    for (const [phone, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(phone);
    }
  }
}
