import { Injectable } from '@nestjs/common';
import { Telegraf } from 'telegraf';
import { InjectBot } from 'nestjs-telegraf';
import { NotificationReason, SearchResult } from '@prisma/client';
import {
  encodeBookCallback,
  encodeWatchCallback,
  encodePageCallback,
  buildTourLink,
} from './telegram.types';
import { SletatShowcaseItem } from '../sletat/sletat.types';

const OFFERS_PER_PAGE = 3;

export interface SearchOffer {
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
}

export interface SearchResultPayload {
  profileId: string;
  profileName: string;
  offers: SearchOffer[];
}

@Injectable()
export class TelegramService {
  constructor(@InjectBot() private readonly bot: Telegraf) {}

  async sendSearchResults(chatId: number, payload: SearchResultPayload) {
    if (!payload.offers.length) {
      await this.bot.telegram.sendMessage(
        chatId,
        'Ничего не нашлось по этому запросу, попробуй уточнить параметры.',
      );
      return;
    }

    await this.sendResultsPage(chatId, payload, 0);
  }

  async sendResultsPage(
    chatId: number,
    payload: SearchResultPayload,
    page: number,
    editMessageId?: number,
  ) {
    const total = payload.offers.length;
    const totalPages = Math.ceil(total / OFFERS_PER_PAGE);
    const start = page * OFFERS_PER_PAGE;
    const pageOffers = payload.offers.slice(start, start + OFFERS_PER_PAGE);

    const lines: string[] = [
      `🔍 Найдено ${total} ${this.pluralTours(total)} по запросу «${payload.profileName}»`,
      `📄 Страница ${page + 1} из ${totalPages}`,
      '',
    ];

    for (let i = 0; i < pageOffers.length; i++) {
      const o = pageOffers[i];
      const num = start + i + 1;
      lines.push(`${num}) ${this.formatOfferCard(o)}`);
    }

    const keyboard: { text: string; callback_data: string; url?: string }[][] = [];

    for (const o of pageOffers) {
      const row: { text: string; callback_data: string; url?: string }[] = [];
      const link = buildTourLink(o.externalOfferId);
      if (link) {
        row.push({ text: '🔗 Подробнее', callback_data: `noop`, url: link });
      }
      row.push({
        text: '📝 Бронировать',
        callback_data: encodeBookCallback(o.id, payload.profileId),
      });
      keyboard.push(row);
    }

    const navRow: { text: string; callback_data: string }[] = [];
    if (page > 0) {
      navRow.push({ text: '⬅️ Назад', callback_data: encodePageCallback(payload.profileId, page - 1) });
    }
    if (page < totalPages - 1) {
      navRow.push({ text: '➡️ Далее', callback_data: encodePageCallback(payload.profileId, page + 1) });
    }
    if (navRow.length) keyboard.push(navRow);

    keyboard.push([
      { text: '👀 Следить за ценой', callback_data: encodeWatchCallback(payload.profileId) },
    ]);

    const msgText = lines.join('\n');
    const markup = { inline_keyboard: keyboard };

    if (editMessageId) {
      try {
        await this.bot.telegram.editMessageText(chatId, editMessageId, undefined, msgText, {
          reply_markup: markup,
        });
        return;
      } catch {
        // fallback to new message
      }
    }

    await this.bot.telegram.sendMessage(chatId, msgText, { reply_markup: markup });
  }

  async sendOfferNotification(
    telegramId: string,
    result: SearchResult,
    reason: NotificationReason,
  ) {
    const chatId = Number(telegramId);
    const reasonText =
      reason === NotificationReason.PRICE_DROP
        ? '📉 Цена понизилась!'
        : '💰 Появился вариант в твоём бюджете!';

    const card = this.formatOfferCard({
      hotelName: result.hotelName,
      countryName: result.countryName,
      resortName: result.resortName,
      mealName: result.mealName,
      dateFrom: result.dateFrom,
      dateTo: result.dateTo,
      nights: result.nights,
      price: result.price,
      currency: result.currency,
      externalOfferId: result.externalOfferId,
    });

    const keyboard: { text: string; callback_data: string; url?: string }[][] = [];
    const link = buildTourLink(result.externalOfferId);
    const actionRow: { text: string; callback_data: string; url?: string }[] = [];
    if (link) {
      actionRow.push({ text: '🔗 Подробнее', callback_data: 'noop', url: link });
    }
    actionRow.push({ text: '📝 Бронировать', callback_data: encodeBookCallback(result.id) });
    keyboard.push(actionRow);

    await this.bot.telegram.sendMessage(chatId, `${reasonText}\n\n${card}`, {
      reply_markup: { inline_keyboard: keyboard },
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

  private formatOfferCard(o: {
    hotelName?: string | null;
    countryName?: string | null;
    resortName?: string | null;
    mealName?: string | null;
    dateFrom?: Date | null;
    dateTo?: Date | null;
    nights?: number | null;
    price: number;
    currency: string;
    externalOfferId?: string;
  }): string {
    const lines: string[] = [];

    if (o.hotelName) {
      lines.push(`🏨 ${o.hotelName}`);
    }

    const location: string[] = [];
    if (o.countryName) location.push(o.countryName);
    if (o.resortName) location.push(o.resortName);
    if (location.length) lines.push(`📍 ${location.join(', ')}`);

    if (o.mealName) lines.push(`🍽 ${o.mealName}`);

    const dateInfo: string[] = [];
    if (o.nights) dateInfo.push(`${o.nights} ночей`);
    if (o.dateFrom) {
      const from = o.dateFrom instanceof Date ? o.dateFrom.toISOString().slice(0, 10) : String(o.dateFrom).slice(0, 10);
      dateInfo.push(`с ${from}`);
    }
    if (dateInfo.length) lines.push(`📅 ${dateInfo.join(', ')}`);

    lines.push(`💰 ${o.price.toLocaleString('ru-RU')} ${o.currency}`);

    return lines.join('\n');
  }

  private pluralTours(n: number): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'тур';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'тура';
    return 'туров';
  }
}
