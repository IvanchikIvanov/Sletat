import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { SubscriptionRepository } from '../persistence/repositories/subscription.repository';
import { SearchResultRepository } from '../persistence/repositories/search-result.repository';
import { NotificationLogRepository } from '../persistence/repositories/notification-log.repository';
import { NotificationReason } from '@prisma/client';
import { SearchService } from '../search/search.service';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

interface MonitoringJobData {
  subscriptionId: string;
  profileId: string;
  userId: string;
}

@Processor('monitoring')
export class MonitoringProcessor {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly results: SearchResultRepository,
    private readonly notifications: NotificationLogRepository,
    private readonly searchService: SearchService,
    @InjectQueue('notification') private readonly notificationQueue: Queue,
  ) {}

  @Process('check-subscription')
  async handleCheckSubscription(job: Job<MonitoringJobData>) {
    const { subscriptionId, profileId, userId } = job.data;

    const subscription = await this.subscriptions.findById(subscriptionId);
    if (!subscription || !subscription.isActive) {
      return;
    }

    const newResults = await this.searchService.searchForProfile(profileId);
    if (!newResults.length) {
      return;
    }

    const best = newResults[0];

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await this.notifications.countForSubscriptionSince(
      subscriptionId,
      dayAgo,
    );
    if (recentCount >= subscription.maxNotificationsPerDay) {
      return;
    }

    const hoursBack = 6;
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const recentForOffer = await this.notifications.findRecentForOffer({
      subscriptionId,
      externalOfferId: best.externalOfferId,
      since,
    });

    if (recentForOffer.length) {
      const last = recentForOffer[0];
      const oldPrice = last.priceAtSend;
      const newPrice = best.price;
      const dropPercent = ((oldPrice - newPrice) / oldPrice) * 100;
      if (dropPercent < subscription.priceDropThresholdPercent) {
        return;
      }
    }

    await this.notificationQueue.add(
      'send-notification',
      {
        subscriptionId,
        searchResultId: best.id,
        userId,
        reason: recentForOffer.length ? NotificationReason.PRICE_DROP : NotificationReason.NEW_IN_BUDGET,
      },
      { removeOnComplete: true, removeOnFail: true },
    );
  }
}

