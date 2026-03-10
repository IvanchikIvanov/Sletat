import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { PersistenceModule } from '../persistence/persistence.module';
import { SletatModule } from '../sletat/sletat.module';

@Module({
  imports: [PersistenceModule, SletatModule],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}

