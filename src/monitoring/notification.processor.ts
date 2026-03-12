import { Inject, Injectable, Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { NotificationLogRepository } from '../persistence/repositories/notification-log.repository';
import { NotificationReason } from '@prisma/client';
import { SearchResultRepository } from '../persistence/repositories/search-result.repository';
import { UserRepository } from '../persistence/repositories/user.repository';
import { TelegramService } from '../telegram/telegram.service';

interface NotificationJobData {
  subscriptionId: string;
  searchResultId: string;
  userId: string;
  reason: NotificationReason;
}

@Processor('notification')
@Injectable()
export class NotificationProcessor {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly notificationLogs: NotificationLogRepository,
    private readonly results: SearchResultRepository,
    private readonly users: UserRepository,
    @Inject(TelegramService) private readonly telegram: TelegramService,
  ) {}

  @Process('send-notification')
  async handleSendNotification(job: Job<NotificationJobData>) {
    const { subscriptionId, searchResultId, userId, reason } = job.data;
    const result = await this.results.findById(searchResultId);
    if (!result) {
      return;
    }

    const user = await this.users.findById(userId);
    if (!user) {
      this.logger.warn(`User ${userId} not found, skipping notification`);
      return;
    }

    await this.notificationLogs.logNotification({
      subscriptionId,
      searchResultId,
      userId,
      priceAtSend: result.price,
      reason,
    });

    try {
      await this.telegram.sendOfferNotification(user.telegramId, result, reason);
    } catch (err) {
      this.logger.error('Failed to send notification to Telegram', err as Error);
    }
  }
}

