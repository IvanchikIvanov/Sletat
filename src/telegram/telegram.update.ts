import { Ctx, Help, On, Start, Update, Action, Command, InjectBot } from 'nestjs-telegraf';
import { Context, Telegraf } from 'telegraf';
import { OpenAiService } from '../openai/openai.service';
import { UserRepository } from '../persistence/repositories/user.repository';
import { SearchService } from '../search/search.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { BookingService } from '../booking/booking.service';
import { TelegramService } from './telegram.service';
import { DialogContextService } from '../dialog/dialog-context.service';
import { MemoryService } from '../memory/memory.service';
import { SletatService } from '../sletat/sletat.service';
import { decodeBookCallback, decodeWatchCallback } from './telegram.types';
import { ParseTourResponse } from '../openai/dto/tour-request.schema';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { IncomingMessage } from 'http';

/** Определить страну по городу вылета (для обновления defaultCountry) */
function inferCountryFromCity(city: string): string | null {
  const lower = city.toLowerCase().trim();
  const russianCities = [
    'москва', 'сочи', 'санкт-петербург', 'спб', 'питер', 'казань', 'краснодар',
    'екатеринбург', 'новосибирск', 'минеральные воды', 'ростов', 'самара',
    'воронеж', 'нижний новгород', 'уфа', 'красноярск', 'пермь', 'волгоград',
    'саратов', 'тюмень', 'толмачево', 'домодедово', 'шереметьево', 'внуково',
  ];
  if (russianCities.some((c) => lower.includes(c) || c.includes(lower))) {
    return 'Россия';
  }
  return null;
}

@Update()
export class TelegramUpdate {
  private botId: number | null = null;
  private botUsername: string | null = null;

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly openAi: OpenAiService,
    private readonly users: UserRepository,
    private readonly search: SearchService,
    private readonly subscriptions: SubscriptionsService,
    private readonly booking: BookingService,
    private readonly telegram: TelegramService,
    private readonly dialogCtx: DialogContextService,
    private readonly memory: MemoryService,
    private readonly sletat: SletatService,
  ) {
    this.bot.telegram.getMe().then((me) => {
      this.botId = me.id;
      this.botUsername = me.username?.toLowerCase() ?? null;
    }).catch(() => {});
  }

  private isGroupChat(ctx: Context): boolean {
    const chatType = ctx.chat?.type;
    return chatType === 'group' || chatType === 'supergroup';
  }

  private isBotMentioned(ctx: Context, text: string): boolean {
    if (!this.isGroupChat(ctx)) return true;

    const msg = ctx.message;
    if (msg && 'reply_to_message' in msg && msg.reply_to_message) {
      const replyFrom = msg.reply_to_message.from;
      if (replyFrom && this.botId && replyFrom.id === this.botId) return true;
    }

    if (this.botUsername && text.toLowerCase().includes(`@${this.botUsername}`)) {
      return true;
    }

    if (msg && 'entities' in msg && msg.entities) {
      for (const entity of msg.entities) {
        if (entity.type === 'mention') {
          const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
          if (this.botUsername && mention === `@${this.botUsername}`) return true;
        }
      }
    }

    return false;
  }

  private stripBotMention(text: string): string {
    if (!this.botUsername) return text;
    return text.replace(new RegExp(`@${this.botUsername}`, 'gi'), '').trim();
  }

  @Start()
  async onStart(@Ctx() ctx: Context) {
    const user = await this.ensureUser(ctx);
    await this.dialogCtx.clear(user.id);

    const name = ctx.from?.first_name ?? 'друг';

    await ctx.reply(
      `Привет, ${name}! 👋 Я твой персональный турагент.\n\n` +
      '🌍 Вот что я умею:\n\n' +

      '✈️ ПОИСК ТУРОВ\n' +
      'Просто напиши, куда и когда хочешь поехать — я найду лучшие предложения. Например:\n' +
      '• «Хочу в Турцию на 7 ночей в мае»\n' +
      '• «Дешёвые туры в Египет из Москвы»\n' +
      '• «5 звёзд, всё включено, на двоих»\n\n' +

      '🔥 ГОРЯЩИЕ ТУРЫ\n' +
      'Напиши /hot — покажу самые выгодные предложения прямо сейчас.\n' +
      'Или просто скажи «что есть горящего?» — подберу!\n\n' +

      '🤔 НЕ ЗНАЕШЬ КУДА?\n' +
      'Не проблема! Скажи:\n' +
      '• «Хочу на пляж, но не знаю куда»\n' +
      '• «Предложи что-нибудь интересное»\n' +
      '• «Куда поехать без визы?»\n' +
      '• «Удиви меня!»\n' +
      'Я предложу направления, расскажу про сезон и помогу выбрать.\n\n' +

      '🎤 ГОЛОСОВЫЕ СООБЩЕНИЯ\n' +
      'Можешь просто наговорить запрос голосом — я пойму!\n\n' +

      '👀 МОНИТОРИНГ ЦЕН\n' +
      'Хочешь следить за ценой? Просто скажи:\n' +
      '• «Мониторь Турцию из Москвы на июль»\n' +
      '• «Следи за ценами в Египет»\n' +
      '• «Сообщи когда подешевеет»\n' +
      'Или нажми кнопку «Следить» после поиска. Я буду проверять цены и сообщу о скидках!\n\n' +

      '🧠 Я ЗАПОМИНАЮ\n' +
      'Я помню твой город вылета, предпочтения и прошлые поиски. Чем больше общаемся — тем точнее подбираю.\n\n' +

      '📋 КОМАНДЫ:\n' +
      '/start — начать сначала\n' +
      '/hot — горящие туры\n' +
      '/subscriptions — мои подписки на мониторинг\n' +
      '/help — краткая справка\n\n' +

      'Ну что, куда полетим? ✈️',
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context) {
    await ctx.reply(
      '📋 Команды:\n' +
      '/start — полная инструкция + сброс диалога\n' +
      '/hot — горящие туры\n' +
      '/subscriptions — активные подписки на мониторинг\n' +
      '/help — эта справка\n\n' +
      'Или просто напиши что хочешь — текстом или голосом 🎤',
    );
  }

  @Command('hot')
  async onHot(@Ctx() ctx: Context) {
    const user = await this.ensureUser(ctx);

    const depCity = await this.resolveUserDepartureCity(user.id);
    if (!depCity) {
      await this.dialogCtx.save(user.id, {
        parsed: {},
        messages: [],
        lastClarification: '__awaiting_departure_for_hot__',
        updatedAt: new Date().toISOString(),
      });
      await ctx.reply(
        'Из какого города ты вылетаешь? ✈️\n' +
        'Напиши, например: Москва, Санкт-Петербург, Казань...',
      );
      return;
    }

    await this.sendHotDeals(ctx, depCity.id, depCity.name);
  }

  private async sendHotDeals(ctx: Context, depCityId: string, depCityName: string) {
    const dbDeals = await this.sletat.getHotDealsFromDb(Number(depCityId));
    if (dbDeals.length > 0) {
      const lines = [`🔥 Горящие туры из ${depCityName}:`, ''];
      for (const d of dbDeals.slice(0, 15)) {
        const parts: string[] = [];
        if (d.hotelName) parts.push(d.hotelName);
        if (d.starName) parts.push(d.starName);
        if (d.resortName) parts.push(d.resortName);
        if (d.mealName) parts.push(d.mealName);
        if (d.nights) parts.push(`${d.nights} н.`);
        if (d.minPriceDate) parts.push(`от ${d.minPriceDate}`);
        parts.push(`от ${d.minPrice} ${d.currency}`);
        lines.push(`• ${d.countryName}: ${parts.join(', ')}`);
      }
      await ctx.reply(lines.join('\n'));
      return;
    }

    const items = await this.sletat.getHotDealsAll();
    await this.telegram.sendShowcaseResults(ctx.chat!.id, items, `🔥 Горящие туры из ${depCityName}:`);
  }

  private async resolveUserDepartureCity(userId: string): Promise<{ id: string; name: string } | null> {
    const profile = await this.memory.getUserDefaults(userId);
    if (profile?.departureCityCode) {
      const name = profile.departureCity ?? profile.departureCityCode;
      return { id: profile.departureCityCode, name };
    }
    return null;
  }

  @Command('subscriptions')
  async onSubscriptions(@Ctx() ctx: Context) {
    const user = await this.ensureUser(ctx);
    const subs = await this.subscriptions.listUserSubscriptions(user.id);
    if (!subs.length) {
      await ctx.reply('Активных подписок пока нет.');
      return;
    }
    const lines = subs.map(
      (s, i) =>
        `${i + 1}) ${s.profileName} — ${s.isActive ? 'активна' : 'выключена'}, ` +
        `${s.minPrice ?? '-'}–${s.maxPrice ?? '-'} руб., падение ${s.priceDropThresholdPercent}%`,
    );
    await ctx.reply(lines.join('\n'));
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    if (!ctx.message || !('text' in ctx.message)) return;
    const rawText = ctx.message.text;

    if (!this.isBotMentioned(ctx, rawText)) return;

    const text = this.stripBotMention(rawText);
    if (!text) return;

    const user = await this.ensureUser(ctx);

    const previous = await this.dialogCtx.get(user.id);
    if (previous?.lastClarification === '__awaiting_departure_for_hot__') {
      await this.dialogCtx.clear(user.id);
      const depCity = await this.sletat.findDepartureCityInDb(text.trim());
      if (!depCity) {
        await ctx.reply(
          `Не нашёл город «${text.trim()}» в списке доступных. Попробуй ещё раз или напиши /hot позже.`,
        );
        return;
      }
      this.memory.extractFactsFromMessage(user.id, `Мой город вылета: ${depCity.name}`).catch(() => {});
      await this.sendHotDeals(ctx, depCity.id, depCity.name);
      return;
    }

    if (previous?.lastClarification === '__awaiting_departure_for_monitor__') {
      await this.dialogCtx.clear(user.id);
      const depCity = await this.sletat.findDepartureCityInDb(text.trim());
      if (!depCity) {
        await ctx.reply(
          `Не нашёл город «${text.trim()}». Попробуй ещё раз или напиши запрос заново.`,
        );
        return;
      }
      this.memory.extractFactsFromMessage(user.id, `Мой город вылета: ${depCity.name}`).catch(() => {});
      await ctx.reply(`Запомнил — вылет из ${depCity.name}. Теперь напиши, что хочешь мониторить 👀`);
      return;
    }

    await this.handleTourRequest(ctx, user.id, text);
  }

  @On('voice')
  async onVoice(@Ctx() ctx: Context) {
    if (!ctx.message || !('voice' in ctx.message)) return;

    if (this.isGroupChat(ctx)) {
      const msg = ctx.message;
      const isReplyToBot = 'reply_to_message' in msg && msg.reply_to_message?.from?.id === this.botId;
      if (!isReplyToBot) return;
    }

    const user = await this.ensureUser(ctx);

    const fileId = ctx.message.voice.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);

    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const tmpPath = path.join(tmpDir, `${fileId}.oga`);

    await new Promise<void>((resolve, reject) => {
      const writer = fs.createWriteStream(tmpPath);
      https
        .get(fileLink.href, (response: IncomingMessage) => {
          if (response.statusCode && response.statusCode >= 400) {
            reject(new Error(`Failed to download voice file: ${response.statusCode}`));
            return;
          }
          response.pipe(writer);
          writer.on('finish', () => resolve());
          writer.on('error', (err: Error) => reject(err));
        })
        .on('error', (err: Error) => reject(err));
    });

    const text = await this.openAi.transcribeVoice(tmpPath);
    await ctx.reply(`Распознал: "${text}"`);

    await this.handleTourRequest(ctx, user.id, text);
  }

  private async handleTourRequest(
    ctx: Context,
    userId: string,
    text: string,
  ): Promise<void> {
    const previous = await this.dialogCtx.get(userId);
    const memoryCtx = await this.memory.getContextForQuery(userId, text);

    const response: ParseTourResponse = await this.openAi.parseTourRequest(
      text,
      previous ? { parsed: previous.parsed, messages: previous.messages } : null,
      memoryCtx,
    );

    this.memory.extractFactsFromMessage(userId, text).catch(() => {});

    const intent = response.intent ?? 'search';

    if (intent === 'hot') {
      const depCity = await this.resolveUserDepartureCity(userId);
      if (depCity) {
        await this.dialogCtx.clear(userId);
        await this.sendHotDeals(ctx, depCity.id, depCity.name);
        return;
      }
      if (response.parsed.departureCity) {
        const found = await this.sletat.findDepartureCityInDb(response.parsed.departureCity);
        if (found) {
          await this.dialogCtx.clear(userId);
          this.memory.extractFactsFromMessage(userId, `Мой город вылета: ${found.name}`).catch(() => {});
          await this.sendHotDeals(ctx, found.id, found.name);
          return;
        }
      }
      await this.dialogCtx.save(userId, {
        parsed: response.parsed,
        messages: [],
        lastClarification: '__awaiting_departure_for_hot__',
        updatedAt: new Date().toISOString(),
      });
      await ctx.reply(
        response.clarificationMessage ??
        'Из какого города ты вылетаешь? ✈️\nНапиши, например: Москва, Санкт-Петербург, Казань...',
      );
      return;
    }

    if (intent === 'chat') {
      const mergedParsed = previous
        ? this.dialogCtx.mergeParsed(previous.parsed, response.parsed)
        : response.parsed;

      const messages = previous?.messages ? [...previous.messages] : [];
      messages.push({ role: 'user', content: text });
      if (response.clarificationMessage) {
        messages.push({ role: 'assistant', content: response.clarificationMessage });
      }

      await this.dialogCtx.save(userId, {
        parsed: mergedParsed,
        messages,
        lastClarification: response.clarificationMessage,
        updatedAt: new Date().toISOString(),
      });

      await ctx.reply(response.clarificationMessage ?? 'Расскажи подробнее, чем могу помочь? 😊');
      return;
    }

    if (!response.readyToSearch && response.clarificationMessage) {
      const mergedParsed = previous
        ? this.dialogCtx.mergeParsed(previous.parsed, response.parsed)
        : response.parsed;

      const messages = previous?.messages ? [...previous.messages] : [];
      messages.push({ role: 'user', content: text });
      messages.push({ role: 'assistant', content: response.clarificationMessage });

      await this.dialogCtx.save(userId, {
        parsed: mergedParsed,
        messages,
        lastClarification: response.clarificationMessage,
        updatedAt: new Date().toISOString(),
      });

      await ctx.reply(response.clarificationMessage);
      return;
    }

    const finalParsed = previous
      ? this.dialogCtx.mergeParsed(previous.parsed, response.parsed)
      : response.parsed;

    await this.dialogCtx.clear(userId);

    let result;

    if (
      finalParsed.destinationMode === 'visa_free' &&
      finalParsed.departureCity
    ) {
      const userCountry = await this.memory.getUserCountry(userId);
      const countries = await this.memory.getVisaFreeCountries(
        finalParsed.departureCity,
        userCountry,
      );
      result = await this.search.searchFromParsedWithCountries(
        { userId, rawText: text, parsed: finalParsed },
        countries,
      );
    } else {
      result = await this.search.searchFromParsed({
        userId,
        rawText: text,
        parsed: finalParsed,
      });
    }

    this.memory.saveSearchPreference(userId, finalParsed).catch(() => {});

    if (finalParsed.departureCity) {
      const country = inferCountryFromCity(finalParsed.departureCity);
      if (country) {
        this.users.updateDefaultCountry(userId, country).catch(() => {});
      }
    }

    if (intent === 'monitor' && result.profileId) {
      const sub = await this.subscriptions.enableSubscriptionForProfile({
        userId,
        profileId: result.profileId,
        priceDropThresholdPercent: 15,
        maxNotificationsPerDay: 5,
      });
      await this.telegram.sendSearchResults(ctx.chat!.id, result);
      await ctx.reply(
        `👀 Мониторинг включён для "${sub.profileName}"!\n` +
        'Буду следить за ценами и сообщу, когда появится выгодное предложение.',
      );
      return;
    }

    await this.telegram.sendSearchResults(ctx.chat!.id, result);
  }

  @Action(/^watch:.+/)
  async onWatch(@Ctx() ctx: Context) {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const data = ctx.callbackQuery.data;
    const decoded = decodeWatchCallback(data);
    if (!decoded) return;
    const user = await this.ensureUser(ctx);

    const sub = await this.subscriptions.enableSubscriptionForProfile({
      userId: user.id,
      profileId: decoded.profileId,
      priceDropThresholdPercent: 15,
      maxNotificationsPerDay: 5,
    });

    await ctx.answerCbQuery('Подписка на мониторинг включена');
    await ctx.reply(
      `Буду мониторить профиль "${sub.profileName}" и сообщать о выгодных предложениях.`,
    );
  }

  @Action(/^book:.+/)
  async onBook(@Ctx() ctx: Context) {
    if (!ctx.callbackQuery || !('data' in ctx.callbackQuery)) return;
    const data = ctx.callbackQuery.data;
    const decoded = decodeBookCallback(data);
    if (!decoded) return;

    const user = await this.ensureUser(ctx);

    const result = await this.booking.createBookingFromOffer({
      userId: user.id,
      profileId: decoded.profileId,
      offerId: decoded.offerId,
    });

    const paymentText = result.paymentUrl
      ? `Ссылка на оплату: ${result.paymentUrl}`
      : 'Заявка создана, менеджер свяжется с тобой.';

    await ctx.answerCbQuery('Начинаем бронирование');
    await ctx.reply(
      `Бронирование создано. Статус: ${result.status}.\n${paymentText}`,
    );
  }

  private async ensureUser(ctx: Context) {
    const from = ctx.from;
    if (!from) {
      throw new Error('No from in context');
    }
    const user = await this.users.upsertFromTelegram({
      telegramId: String(from.id),
      username: from.username,
      firstName: from.first_name,
      lastName: from.last_name,
      languageCode: from.language_code,
    });
    return user;
  }
}
