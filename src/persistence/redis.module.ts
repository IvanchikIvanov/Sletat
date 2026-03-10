import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { RedisProvider } from './redis.provider';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisProvider],
  exports: [RedisProvider],
})
export class RedisModule {}

