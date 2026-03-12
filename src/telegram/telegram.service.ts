import { Injectable } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { InjectBot } from 'nestjs-telegraf';
import { NotificationReason, SearchResult } from '@prisma/client';
import { encodeBookCallback, encodeWatchCallback } from './telegram.types';
import { SletatShowcaseItem } from '../sletat/sletat.types';

@Injectable()
export class TelegramService {
  constructor(@InjectBot() private readonly bot: Telegraf) {}

  async sendSearchResults(
    chatId: number,
    payload: {
      profileId: string;
      profileName: string;
      offers: {
        id: string;
        hotelName?: string | null;
        countryName?: string | null;
        resortName?: string | null;
        mealName?: string | null;
        dateFrom?: Date | null;
        dateTo?: Date | null;
        nights?: number | null;
        price: number;
        currency: string;
        externalOfferId: string;
      }[];
    },
  ) {
    if (!payload.offers.length) {
      await this.bot.telegram.sendMessage(
        chatId,
        'Ничего не нашлось по этому запросу, попробуй уточнить параметры.',
      );
      return;
    }

    const [best, ...rest] = payload.offers;
    const lines = [
      `Профиль: ${payload.profileName}`,
      '',
      this.formatOfferLine(best),
      '',
      'Другие варианты:',
      ...rest.slice(0, 4).map((o, i) => `${i + 2}) ${this.formatOfferLine(o)}`),
    ];

    await this.bot.telegram.sendMessage(chatId, lines.join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Следить за ценой',
              callback_data: encodeWatchCallback(payload.profileId),
            },
          ],
          [
            {
              text: 'Бронировать лучший вариант',
              callback_data: encodeBookCallback(best.id, payload.profileId),
            },
          ],
        ],
      },
    });
  }

  async sendOfferNotification(
    telegramId: string,
    result: SearchResult,
    reason: NotificationReason,
  ) {
    const chatId = Number(telegramId);
    const reasonText =
      reason === NotificationReason.PRICE_DROP
        ? 'Цена понизилась!'
        : 'Появился вариант в твоём бюджете!';

    const text = `${reasonText}\n\n${this.formatOfferLine({
      hotelName: result.hotelName,
      countryName: result.countryName,
      resortName: result.resortName,
      mealName: result.mealName,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
      nights: result.nights,
      price: result.price,
      currency: result.currency,
      id: result.id,
      externalOfferId: result.externalOfferId,
    })}`;

    await this.bot.telegram.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Бронировать',
              callback_data: encodeBookCallback(result.id),
            },
          ],
        ],
      },
    });
  }

  async sendMessage(telegramId: string, text: string): Promise<void> {
    const chatId = Number(telegramId);
    await this.bot.telegram.sendMessage(chatId, text);
  }

  async sendShowcaseResults(chatId: number, items: SletatShowcaseItem[], title: string) {
    if (!items.length) {
      await this.bot.telegram.sendMessage(chatId, 'Горящих предложений по этому направлению сейчас нет.');
      return;
    }

    const lines = [title, ''];
    for (const item of items.slice(0, 10)) {
      const parts: string[] = [];
      if (item.hotelName) parts.push(item.hotelName);
      if (item.starName) parts.push(item.starName);
      if (item.resortName) parts.push(item.resortName);
      if (item.mealName) parts.push(item.mealName);
      if (item.nights) parts.push(`${item.nights} н.`);
      if (item.minPriceDate) parts.push(`от ${item.minPriceDate}`);
      parts.push(`от ${item.minPrice}`);
      lines.push(`• ${item.countryName}: ${parts.join(', ')}`);
    }

    await this.bot.telegram.sendMessage(chatId, lines.join('\n'));
  }

  private formatOfferLine(o: {
    hotelName?: string | null;
    countryName?: string | null;
    resortName?: string | null;
    mealName?: string | null;
    dateFrom?: Date | null;
    dateTo?: Date | null;
    nights?: number | null;
    price: number;
    currency: string;
    id?: string;
    externalOfferId?: string;
  }): string {
    const parts: string[] = [];
    if (o.hotelName) parts.push(o.hotelName);
    if (o.countryName) parts.push(o.countryName);
    if (o.resortName) parts.push(o.resortName);
    if (o.mealName) parts.push(o.mealName);
    if (o.nights) parts.push(`${o.nights} ночей`);
    if (o.dateFrom && o.dateTo) {
      parts.push(
        `${o.dateFrom.toISOString().slice(0, 10)}–${o.dateTo
          .toISOString()
          .slice(0, 10)}`,
      );
    }
    parts.push(`${o.price} ${o.currency}`);
    return parts.join(', ');
  }
}

