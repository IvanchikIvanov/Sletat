import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../persistence/redis.provider';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';

export interface DialogMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DialogContext {
  parsed: ParsedTourRequest;
  messages: DialogMessage[];
  lastClarification?: string;
  updatedAt: string;
}

const CONTEXT_PREFIX = 'dialog:ctx:';
const CONTEXT_TTL = 1800; // 30 min

@Injectable()
export class DialogContextService {
  private readonly logger = new Logger(DialogContextService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(userId: string): Promise<DialogContext | null> {
    const raw = await this.redis.get(`${CONTEXT_PREFIX}${userId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as DialogContext;
    } catch {
      this.logger.warn(`Corrupted dialog context for user ${userId}`);
      return null;
    }
  }

  async save(userId: string, context: DialogContext): Promise<void> {
    context.updatedAt = new Date().toISOString();
    await this.redis.set(
      `${CONTEXT_PREFIX}${userId}`,
      JSON.stringify(context),
      'EX',
      CONTEXT_TTL,
    );
  }

  async clear(userId: string): Promise<void> {
    await this.redis.del(`${CONTEXT_PREFIX}${userId}`);
  }

  mergeParsed(
    previous: ParsedTourRequest,
    incoming: ParsedTourRequest,
  ): ParsedTourRequest {
    const merged = { ...previous };
    for (const [key, value] of Object.entries(incoming)) {
      if (value !== undefined && value !== null && value !== '') {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
    return merged;
  }
}
