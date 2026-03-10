import { Module, OnModuleInit } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MemoryService } from './memory.service';
import { FactExtractorService } from './fact-extractor.service';
import { DataLoaderService } from './data-loader.service';
import { DataLoaderProcessor } from './data-loader.processor';
import { ConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/config.service';
import { PersistenceModule } from '../persistence/persistence.module';
import { PreferencesModule } from '../preferences/preferences.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { SletatModule } from '../sletat/sletat.module';

@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    PreferencesModule,
    KnowledgeModule,
    SletatModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        redis: config.redisUrl,
      }),
    }),
    BullModule.registerQueue({ name: 'data-loader' }),
  ],
  providers: [MemoryService, FactExtractorService, DataLoaderService, DataLoaderProcessor],
  exports: [MemoryService, FactExtractorService, DataLoaderService],
})
export class MemoryModule implements OnModuleInit {
  constructor(private readonly dataLoader: DataLoaderService) {}

  onModuleInit() {
    this.dataLoader.startScheduledJobs();
  }
}
