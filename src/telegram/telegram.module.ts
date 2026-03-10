import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { AppConfigService } from '../config/config.service';
import { ConfigModule } from '../config/config.module';
import { TelegramUpdate } from './telegram.update';
import { TelegramService } from './telegram.service';
import { PersistenceModule } from '../persistence/persistence.module';
import { OpenAiModule } from '../openai/openai.module';
import { SearchModule } from '../search/search.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { BookingModule } from '../booking/booking.module';

@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    OpenAiModule,
    SearchModule,
    SubscriptionsModule,
    BookingModule,
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        token: config.telegramToken,
        launchOptions: config.telegramUsePolling ? {} : false,
      }),
    }),
  ],
  providers: [TelegramUpdate, TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}

