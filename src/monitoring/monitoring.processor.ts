import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { SubscriptionRepository } from '../persistence/repositories/subscription.repository';
import { SearchResultRepository } from '../persistence/repositories/search-result.repository';
import { SearchProfileRepository } from '../persistence/repositories/search-profile.repository';
import { NotificationLogRepository } from '../persistence/repositories/notification-log.repository';
import { UserRepository } from '../persistence/repositories/user.repository';
import { NotificationReason } from '@prisma/client';
import { SearchService } from '../search/search.service';
import { SletatService } from '../sletat/sletat.service';
import { TelegramService } from '../telegram/telegram.service';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

interface MonitoringJobData {
  subscriptionId: string;
  profileId: string;
  userId: string;
}

interface ProactiveJobData {
  userId: string;
}

@Processor('monitoring')
export class MonitoringProcessor {
  private readonly logger = new Logger(MonitoringProcessor.name);

  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly results: SearchResultRepository,
    private readonly profiles: SearchProfileRepository,
    private readonly notifications: NotificationLogRepository,
    private readonly users: UserRepository,
    private readonly searchService: SearchService,
    private readonly sletat: SletatService,
    private readonly telegram: TelegramService,
    @InjectQueue('notification') private readonly notificationQueue: Queue,
  ) {}

  @Process('check-subscription')
  async handleCheckSubscription(job: Job<MonitoringJobData>) {
    const { subscriptionId, profileId, userId } = job.data;

    const subscription = await this.subscriptions.findById(subscriptionId);
    if (!subscription || !subscription.isActive) {
      return;
    }

    const profile = await this.profiles.findById(profileId);
    if (!profile) return;

    const newResults = await this.searchService.searchForProfile(profileId);
    if (!newResults.length) {
      return;
    }

    const best = newResults[0];

    const budgetMax = profile.budgetMax ?? subscription.maxPrice;
    if (budgetMax != null && best.price > budgetMax) {
      this.logger.debug(`Skipping notification: price ${best.price} > budget ${budgetMax}`);
      return;
    }

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

  @Process('proactive-check')
  async handleProactiveCheck(job: Job<ProactiveJobData>) {
    const { userId } = job.data;

    try {
      const user = await this.users.findById(userId);
      if (!user) return;

      const latestProfile = await this.profiles.findLatestByUser(userId);
      if (!latestProfile) return;

      const departureCityId = latestProfile.departureCityCode;
      if (!departureCityId) return;

      const showcase = await this.sletat.getShowcaseReview(
        Number(departureCityId),
        latestProfile.currency ?? 'RUB',
      );

      if (!showcase.length) return;

      const budgetMax = latestProfile.budgetMax;
      const matching = showcase.filter((item) => {
        if (!budgetMax) return true;
        const priceNum = parseInt(item.minPrice.replace(/\D/g, ''), 10);
        return Number.isFinite(priceNum) && priceNum <= budgetMax;
      });

      if (!matching.length) return;

      const top3 = matching.slice(0, 3);
      const lines = top3.map(
        (s) => `• ${s.countryName}: от ${s.minPrice}, ${s.hotelName ?? ''} ${s.starName ?? ''}, ${s.nights ?? '?'} ночей`,
      );

      const text = `🔥 Горящие туры по твоим параметрам:\n\n${lines.join('\n')}\n\nНапиши, если хочешь подробнее по какому-то направлению!`;

      await this.telegram.sendMessage(user.telegramId, text);
      this.logger.log(`Sent proactive notification to user ${userId}`);
    } catch (error) {
      this.logger.warn(`Proactive check failed for user ${userId}`, error);
    }
  }
}

