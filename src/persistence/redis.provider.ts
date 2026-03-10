import { Provider } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

export const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService) => {
    const client = new Redis(config.redisUrl);
    client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('Redis error', err);
    });
    return client;
  },
};

