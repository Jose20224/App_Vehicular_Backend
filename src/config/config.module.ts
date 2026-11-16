import { Global, Module } from '@nestjs/common';
import type { AppEnvironment } from './environment';
import { validateEnvironment } from './environment';

export const APP_ENVIRONMENT = Symbol('APP_ENVIRONMENT');

export class AppConfigService {
  constructor(readonly value: AppEnvironment) {}
}

@Global()
@Module({
  providers: [
    {
      provide: APP_ENVIRONMENT,
      useFactory: (): AppEnvironment => validateEnvironment(process.env),
    },
    {
      provide: AppConfigService,
      useFactory: (environment: AppEnvironment) => new AppConfigService(environment),
      inject: [APP_ENVIRONMENT],
    },
  ],
  exports: [APP_ENVIRONMENT, AppConfigService],
})
export class AppConfigModule {}
