import { Injectable } from '@nestjs/common';
import { SubscriptionRepository } from '../persistence/repositories/subscription.repository';
import { SearchProfileRepository } from '../persistence/repositories/search-profile.repository';
import { SubscriptionSummaryDto } from './dto/subscription.dto';

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly profiles: SearchProfileRepository,
  ) {}

  async enableSubscriptionForProfile(params: {
    userId: string;
    profileId: string;
    minPrice?: number | null;
    maxPrice?: number | null;
    priceDropThresholdPercent?: number | null;
    maxNotificationsPerDay?: number | null;
  }): Promise<SubscriptionSummaryDto> {
    const subscription = await this.subscriptions.upsertForProfile(params);
    const profile = await this.profiles.findById(params.profileId);

    return {
      id: subscription.id,
      profileName: profile?.name ?? 'Профиль',
      isActive: subscription.isActive,
      minPrice: subscription.minPrice,
      maxPrice: subscription.maxPrice,
      priceDropThresholdPercent: subscription.priceDropThresholdPercent,
      maxNotificationsPerDay: subscription.maxNotificationsPerDay,
    };
  }

  async listUserSubscriptions(userId: string): Promise<SubscriptionSummaryDto[]> {
    const profiles = await this.profiles.findByUser(userId);
    const profileMap = new Map(profiles.map((p) => [p.id, p.name]));

    const allActive = await this.subscriptions.findActive();
    const userSubs = allActive.filter((s) => s.userId === userId);

    return userSubs.map((s) => ({
      id: s.id,
      profileName: profileMap.get(s.profileId) ?? 'Профиль',
      isActive: s.isActive,
      minPrice: s.minPrice,
      maxPrice: s.maxPrice,
      priceDropThresholdPercent: s.priceDropThresholdPercent,
      maxNotificationsPerDay: s.maxNotificationsPerDay,
    }));
  }
}

