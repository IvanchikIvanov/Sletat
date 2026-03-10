import { Injectable } from '@nestjs/common';
import { NotificationReason, NotificationLog } from '@prisma/client';
import { PrismaService } from '../prisma.service';

@Injectable()
export class NotificationLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async logNotification(input: {
    subscriptionId: string;
    searchResultId: string;
    userId: string;
    priceAtSend: number;
    reason: NotificationReason;
  }): Promise<NotificationLog> {
    return this.prisma.notificationLog.create({
      data: {
        subscriptionId: input.subscriptionId,
        searchResultId: input.searchResultId,
        userId: input.userId,
        priceAtSend: input.priceAtSend,
        reason: input.reason,
      },
    });
  }

  async findRecentForOffer(params: {
    subscriptionId: string;
    externalOfferId: string;
    since: Date;
  }): Promise<NotificationLog[]> {
    return this.prisma.notificationLog.findMany({
      where: {
        subscriptionId: params.subscriptionId,
        sentAt: { gte: params.since },
        searchResult: { externalOfferId: params.externalOfferId },
      },
      include: { searchResult: true },
      orderBy: { sentAt: 'desc' },
    });
  }

  async countForSubscriptionSince(subscriptionId: string, since: Date): Promise<number> {
    return this.prisma.notificationLog.count({
      where: {
        subscriptionId,
        sentAt: { gte: since },
      },
    });
  }
}

