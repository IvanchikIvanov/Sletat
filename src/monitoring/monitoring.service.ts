import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { AppConfigService } from '../config/config.service';
import { SubscriptionRepository } from '../persistence/repositories/subscription.repository';
import { UserRepository } from '../persistence/repositories/user.repository';

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private intervalId: NodeJS.Timeout | null = null;
  private proactiveIntervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly subscriptions: SubscriptionRepository,
    private readonly users: UserRepository,
    @InjectQueue('monitoring') private readonly monitoringQueue: Queue,
  ) {}

  startInterval() {
    if (this.intervalId) {
      return;
    }
    const intervalMs = this.config.monitoringIntervalMs;
    this.logger.log(`Starting monitoring interval: every ${intervalMs} ms`);
    this.intervalId = setInterval(() => {
      this.scheduleMonitoringTick().catch((err) =>
        this.logger.error('Failed to schedule monitoring tick', err as Error),
      );
    }, intervalMs);

    if (!this.proactiveIntervalId) {
      const proactiveMs = 4 * 60 * 60 * 1000;
      this.logger.log(`Starting proactive check interval: every ${proactiveMs} ms`);
      this.proactiveIntervalId = setInterval(() => {
        this.scheduleProactiveCheck().catch((err) =>
          this.logger.error('Failed to schedule proactive check', err as Error),
        );
      }, proactiveMs);
    }
  }

  async scheduleMonitoringTick() {
    const all = await this.subscriptions.findActive();
    this.logger.log(`Scheduling monitoring for ${all.length} active subscriptions`);
    for (const sub of all) {
      await this.monitoringQueue.add(
        'check-subscription',
        {
          subscriptionId: sub.id,
          profileId: sub.profileId,
          userId: sub.userId,
        },
        { removeOnComplete: true, removeOnFail: true },
      );
    }
  }

  async scheduleProactiveCheck() {
    const activeSubs = await this.subscriptions.findActive();
    const userIds = [...new Set(activeSubs.map((s) => s.userId))];

    this.logger.log(`Scheduling proactive check for ${userIds.length} users with subscriptions`);

    for (const userId of userIds) {
      await this.monitoringQueue.add(
        'proactive-check',
        { userId },
        { removeOnComplete: true, removeOnFail: true },
      );
    }
  }
}

