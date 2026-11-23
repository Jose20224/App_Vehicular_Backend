import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AppConfigService } from '../../../config/config.module';
import type { OtpChannel, OtpProvider } from './otp-provider.interface';

interface TwilioVerifyResponse {
  status?: string;
  message?: string;
}

@Injectable()
export class TwilioVerifyProvider implements OtpProvider {
  constructor(private readonly config: AppConfigService) {}

  async request(phone: string, channel: OtpChannel): Promise<void> {
    await this.call('Verifications', { To: phone, Channel: channel });
  }

  async verify(phone: string, code: string): Promise<boolean> {
    try {
      const response = await this.call('VerificationCheck', { To: phone, Code: code });
      return response.status === 'approved';
    } catch (error) {
      if (error instanceof OtpRejectedError) return false;
      throw error;
    }
  }

  private async call(path: string, fields: Record<string, string>): Promise<TwilioVerifyResponse> {
    const { twilioAccountSid, twilioAuthToken, twilioVerifyServiceSid } = this.config.value;
    if (!twilioAccountSid || !twilioAuthToken || !twilioVerifyServiceSid) {
      throw new ServiceUnavailableException({
        code: 'OTP_PROVIDER_NOT_CONFIGURED',
        message: 'El servicio de verificación no está configurado.',
        details: {},
      });
    }

    const credentials = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');
    const body = new URLSearchParams(fields);
    let response: Response;
    try {
      response = await fetch(
        `https://verify.twilio.com/v2/Services/${twilioVerifyServiceSid}/${path}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body,
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'OTP_PROVIDER_UNAVAILABLE',
        message: 'No fue posible contactar el servicio de verificación. Inténtalo nuevamente.',
        details: {},
      });
    }

    const payload = await response.json().catch(() => ({})) as TwilioVerifyResponse;
    if (!response.ok) {
      // Twilio elimina verificaciones expiradas/aprobadas o con intentos agotados.
      if (path === 'VerificationCheck' && response.status === 404) throw new OtpRejectedError();
      if (response.status === 429 || response.status >= 500) {
        throw new ServiceUnavailableException({
          code: 'OTP_PROVIDER_UNAVAILABLE',
          message: 'El servicio de verificación está temporalmente limitado o no disponible.',
          details: {},
        });
      }
      throw new ServiceUnavailableException({
        code: 'OTP_PROVIDER_ERROR',
        message: 'El servicio de verificación no pudo completar la solicitud.',
        details: {},
      });
    }
    return payload;
  }
}

class OtpRejectedError extends Error {}
