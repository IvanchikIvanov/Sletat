import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PersistenceModule } from '../persistence/persistence.module';

@Module({
  imports: [PersistenceModule],
  controllers: [HealthController],
})
export class HealthModule {}

