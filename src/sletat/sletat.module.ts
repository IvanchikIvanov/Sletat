import { Module } from '@nestjs/common';
import { SletatService } from './sletat.service';
import { SletatMockService } from './sletat.mock.service';
import { SletatApiService } from './sletat.api.service';
import { ConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/config.service';
import { RedisModule } from '../persistence/redis.module';

@Module({
  imports: [ConfigModule, RedisModule],
  providers: [
    SletatService,
    SletatMockService,
    SletatApiService,
    {
      provide: 'SLETAT_CLIENT',
      useFactory: (config: AppConfigService, mock: SletatMockService, api: SletatApiService) =>
        config.sletat.mode === 'api' ? api : mock,
      inject: [AppConfigService, SletatMockService, SletatApiService],
    },
  ],
  exports: [SletatService],
})
export class SletatModule {}

