import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { UserRepository } from './repositories/user.repository';
import { SearchProfileRepository } from './repositories/search-profile.repository';
import { SearchRequestRepository } from './repositories/search-request.repository';
import { SearchResultRepository } from './repositories/search-result.repository';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { NotificationLogRepository } from './repositories/notification-log.repository';
import { BookingRepository } from './repositories/booking.repository';
import { RedisModule } from './redis.module';

@Global()
@Module({
  imports: [RedisModule],
  providers: [
    PrismaService,
    UserRepository,
    SearchProfileRepository,
    SearchRequestRepository,
    SearchResultRepository,
    SubscriptionRepository,
    NotificationLogRepository,
    BookingRepository,
  ],
  exports: [
    PrismaService,
    UserRepository,
    SearchProfileRepository,
    SearchRequestRepository,
    SearchResultRepository,
    SubscriptionRepository,
    NotificationLogRepository,
    BookingRepository,
  ],
})
export class PersistenceModule {}

