import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { WebSearchService } from './web-search.service';
import { PersistenceModule } from '../persistence/persistence.module';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [PersistenceModule, ConfigModule],
  providers: [KnowledgeService, WebSearchService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
