import { Module } from '@nestjs/common';
import { SletatService } from './sletat.service';
import { SletatMockService } from './sletat.mock.service';
import { ConfigModule } from '../config/config.module';
import { RedisModule } from '../persistence/redis.module';

@Module({
  imports: [ConfigModule, RedisModule],
  providers: [
    SletatService,
    {
      provide: 'SLETAT_CLIENT',
      useClass: SletatMockService,
    },
    {
      provide: SletatMockService,
      useExisting: 'SLETAT_CLIENT',
    },
  ],
  exports: [SletatService],
})
export class SletatModule {}

