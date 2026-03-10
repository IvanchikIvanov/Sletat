import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

export type DataLoaderJobType =
  | 'load-sletat-dictionaries'
  | 'load-visa-free'
  | 'enrich-countries'
  | 'cleanup-expired';

@Injectable()
export class DataLoaderService {
  private readonly logger = new Logger(DataLoaderService.name);
  private intervalsStarted = false;

  constructor(
    @InjectQueue('data-loader') private readonly queue: Queue,
  ) {}

  startScheduledJobs() {
    if (this.intervalsStarted) return;
    this.intervalsStarted = true;

    this.logger.log('Starting data loader scheduled jobs');

    this.scheduleJob('load-sletat-dictionaries', 24 * 60 * 60 * 1000, 10_000);
    this.scheduleJob('load-visa-free', 7 * 24 * 60 * 60 * 1000, 30_000);
    this.scheduleJob('enrich-countries', 7 * 24 * 60 * 60 * 1000, 60_000);
    this.scheduleJob('cleanup-expired', 24 * 60 * 60 * 1000, 5_000);
  }

  async triggerJob(type: DataLoaderJobType): Promise<void> {
    await this.queue.add(type, { triggeredAt: new Date().toISOString() }, {
      removeOnComplete: true,
      removeOnFail: true,
    });
    this.logger.log(`Manually triggered job: ${type}`);
  }

  private scheduleJob(type: DataLoaderJobType, intervalMs: number, initialDelayMs: number) {
    setTimeout(() => {
      this.triggerJob(type).catch((err) =>
        this.logger.error(`Failed initial trigger for ${type}`, err),
      );

      setInterval(() => {
        this.triggerJob(type).catch((err) =>
          this.logger.error(`Failed scheduled trigger for ${type}`, err),
        );
      }, intervalMs);
    }, initialDelayMs);
  }
}
