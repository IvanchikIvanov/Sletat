import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import { Inject } from '@nestjs/common';
import { REDIS_CLIENT } from '../persistence/redis.provider';
import type Redis from 'ioredis';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  getHealth() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('db')
  async getDbHealth() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }

  @Get('redis')
  async getRedisHealth() {
    const pong = await this.redis.ping();
    return { status: pong === 'PONG' ? 'ok' : 'degraded' };
  }
}

