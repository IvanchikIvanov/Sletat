import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Subscription } from '@prisma/client';

@Injectable()
export class SubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  upsertForProfile(input: {
    userId: string;
    profileId: string;
    minPrice?: number | null;
    maxPrice?: number | null;
    priceDropThresholdPercent?: number | null;
    maxNotificationsPerDay?: number | null;
  }): Promise<Subscription> {
    const { userId, profileId, ...rest } = input;
    return this.prisma.subscription.upsert({
      where: {
        profileId_userId: {
          profileId,
          userId,
        },
      },
      create: {
        userId,
        profileId,
        minPrice: rest.minPrice ?? undefined,
        maxPrice: rest.maxPrice ?? undefined,
        priceDropThresholdPercent: rest.priceDropThresholdPercent ?? undefined,
        maxNotificationsPerDay: rest.maxNotificationsPerDay ?? undefined,
      },
      update: {
        minPrice: rest.minPrice ?? undefined,
        maxPrice: rest.maxPrice ?? undefined,
        priceDropThresholdPercent: rest.priceDropThresholdPercent ?? undefined,
        maxNotificationsPerDay: rest.maxNotificationsPerDay ?? undefined,
        isActive: true,
      },
    });
  }

  findActive(): Promise<Subscription[]> {
    return this.prisma.subscription.findMany({
      where: { isActive: true },
      include: {
        profile: true,
        latestResult: true,
      },
    });
  }

  findById(id: string): Promise<Subscription | null> {
    return this.prisma.subscription.findUnique({ where: { id } });
  }

  async deactivate(id: string): Promise<void> {
    await this.prisma.subscription.update({
      where: { id },
      data: { isActive: false },
    });
  }
}

