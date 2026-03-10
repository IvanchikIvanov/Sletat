import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { AppConfigService } from '../config/config.service';
import { SubscriptionRepository } from '../persistence/repositories/subscription.repository';

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly subscriptions: SubscriptionRepository,
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
}

