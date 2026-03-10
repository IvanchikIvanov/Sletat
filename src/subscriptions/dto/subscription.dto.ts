export class SubscriptionSummaryDto {
  id!: string;
  profileName!: string;
  isActive!: boolean;
  minPrice?: number | null;
  maxPrice?: number | null;
  priceDropThresholdPercent!: number;
  maxNotificationsPerDay!: number;
}

