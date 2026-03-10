import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MonitoringService } from './monitoring.service';
import { MonitoringProcessor } from './monitoring.processor';
import { NotificationProcessor } from './notification.processor';
import { AppConfigService } from '../config/config.service';
import { PersistenceModule } from '../persistence/persistence.module';
import { SearchModule } from '../search/search.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SletatModule } from '../sletat/sletat.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        redis: config.redisUrl,
      }),
    }),
    BullModule.registerQueue(
      { name: 'monitoring' },
      { name: 'notification' },
    ),
    PersistenceModule,
    SearchModule,
    SubscriptionsModule,
    SletatModule,
    TelegramModule,
  ],
  providers: [MonitoringService, MonitoringProcessor, NotificationProcessor],
  exports: [MonitoringService],
})
export class MonitoringModule implements OnModuleInit {
  constructor(private readonly monitoring: MonitoringService) {}

  onModuleInit() {
    this.monitoring.startInterval();
  }
}

