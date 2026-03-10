import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User } from '@prisma/client';

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByTelegramId(telegramId: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { telegramId } });
  }

  async upsertFromTelegram(payload: {
    telegramId: string;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    languageCode?: string | null;
  }): Promise<User> {
    const { telegramId, username, firstName, lastName, languageCode } = payload;
    return this.prisma.user.upsert({
      where: { telegramId },
      create: {
        telegramId,
        username: username ?? undefined,
        firstName: firstName ?? undefined,
        lastName: lastName ?? undefined,
        languageCode: languageCode ?? undefined,
      },
      update: {
        username: username ?? undefined,
        firstName: firstName ?? undefined,
        lastName: lastName ?? undefined,
        languageCode: languageCode ?? undefined,
      },
    });
  }
}

