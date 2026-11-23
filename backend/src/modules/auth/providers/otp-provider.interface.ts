export type OtpChannel = 'sms' | 'whatsapp';

export interface OtpProvider {
  request(phone: string, channel: OtpChannel): Promise<void>;
  verify(phone: string, code: string): Promise<boolean>;
}

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');
