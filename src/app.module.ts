import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PersistenceModule } from './persistence/persistence.module';
import { OpenAiModule } from './openai/openai.module';
import { SletatModule } from './sletat/sletat.module';
import { SearchModule } from './search/search.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { BookingModule } from './booking/booking.module';
import { TelegramModule } from './telegram/telegram.module';
import { HealthModule } from './health/health.module';
import { DialogModule } from './dialog/dialog.module';
import { PreferencesModule } from './preferences/preferences.module';

@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    OpenAiModule,
    SletatModule,
    SearchModule,
    SubscriptionsModule,
    MonitoringModule,
    BookingModule,
    TelegramModule,
    HealthModule,
    DialogModule,
    PreferencesModule,
  ],
})
export class AppModule {}

