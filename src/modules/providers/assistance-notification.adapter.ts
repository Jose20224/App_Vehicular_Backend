import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/config.module';

export type AssistanceMessageChannel = 'sms' | 'whatsapp';
export interface AssistanceNotification {
  to: string;
  channel: AssistanceMessageChannel;
  body: string;
}
export interface AssistanceNotificationResult {
  provider: 'mock' | 'twilio';
  message_id: string;
  channel: AssistanceMessageChannel;
}
export interface AssistanceNotificationAdapter {
  send(message: AssistanceNotification): Promise<AssistanceNotificationResult>;
}
export const ASSISTANCE_NOTIFICATION_ADAPTER = Symbol('ASSISTANCE_NOTIFICATION_ADAPTER');

@Injectable()
export class MockAssistanceNotificationAdapter implements AssistanceNotificationAdapter {
  private readonly logger = new Logger(MockAssistanceNotificationAdapter.name);
  async send(message: AssistanceNotification): Promise<AssistanceNotificationResult> {
    // No se escriben números telefónicos ni contenido personal en logs.
    this.logger.log(`Notificación simulada preparada (canal=${message.channel}, destino_protegido=true, bytes=${Buffer.byteLength(message.body)}).`);
    return { provider: 'mock', message_id: `mock-${Date.now()}`, channel: message.channel };
  }
}

@Injectable()
export class TwilioAssistanceNotificationAdapter implements AssistanceNotificationAdapter {
  constructor(private readonly config: AppConfigService) {}

  async send(message: AssistanceNotification): Promise<AssistanceNotificationResult> {
    const { twilioAccountSid, twilioAuthToken, twilioSmsFrom, twilioWhatsappFrom } = this.config.value;
    if (!twilioAccountSid || !twilioAuthToken) throw new InternalServerErrorException({
      code: 'ASSISTANCE_NOTIFICATION_NOT_CONFIGURED', message: 'El adaptador Twilio no está configurado.', details: {},
    });
    const useWhatsapp = message.channel === 'whatsapp' && Boolean(twilioWhatsappFrom);
    const from = useWhatsapp ? twilioWhatsappFrom : twilioSmsFrom;
    if (!from) throw new Error('TWILIO_SENDER_NOT_CONFIGURED');
    const to = useWhatsapp ? `whatsapp:${message.to}` : message.to;
    const sender = useWhatsapp ? `whatsapp:${from}` : from;
    const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
    const form = new URLSearchParams({ To: to, From: sender, Body: message.body });
    const auth = Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as { sid?: string; code?: number; message?: string };
    if (!response.ok || !payload.sid) {
      // No se propaga texto remoto que pueda contener teléfonos o datos del mensaje.
      throw new Error(`TWILIO_MESSAGE_FAILED_${response.status}_${payload.code ?? 'UNKNOWN'}`);
    }
    return { provider: 'twilio', message_id: payload.sid, channel: useWhatsapp ? 'whatsapp' : 'sms' };
  }
}
