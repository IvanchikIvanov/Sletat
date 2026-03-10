import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { PersistenceModule } from '../persistence/persistence.module';
import { SletatModule } from '../sletat/sletat.module';

@Module({
  imports: [PersistenceModule, SletatModule],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}

