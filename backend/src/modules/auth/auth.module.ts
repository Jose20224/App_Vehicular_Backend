import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigModule } from '../../config/config.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OTP_PROVIDER } from './providers/otp-provider.interface';
import { MockOtpProvider } from './providers/mock-otp.provider';
import { TwilioVerifyProvider } from './providers/twilio-verify.provider';
import { AppConfigService } from '../../config/config.module';

@Module({
  imports: [AppConfigModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    MockOtpProvider,
    TwilioVerifyProvider,
    {
      provide: OTP_PROVIDER,
      useFactory: (config: AppConfigService, mock: MockOtpProvider, twilio: TwilioVerifyProvider) =>
        config.value.otpMode === 'mock' ? mock : twilio,
      inject: [AppConfigService, MockOtpProvider, TwilioVerifyProvider],
    },
  ],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
