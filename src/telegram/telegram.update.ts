import { Ctx, Help, On, Start, Update, Action, Hears, Command } from 'nestjs-telegraf';
import { Context, Input } from 'telegraf';
import { OpenAiService } from '../openai/openai.service';
import { UserRepository } from '../persistence/repositories/user.repository';
import { SearchService } from '../search/search.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { BookingService } from '../booking/booking.service';
import { TelegramService } from './telegram.service';
import { decodeBookCallback, decodeWatchCallback } from './telegram.types';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { IncomingMessage } from 'http';

@Update()
export class TelegramUpdate {
  constructor(
    private readonly openAi: OpenAiService,
    private readonly users: UserRepository,
    private readonly search: SearchService,
    private readonly subscriptions: SubscriptionsService,
    private readonly booking: BookingService,
    private readonly telegram: TelegramService,
  ) {}

  @Start()
  async onStart(@Ctx() ctx: Context) {
    await this.ensureUser(ctx);
    await ctx.reply(
      'Привет! Напиши, какой тур ты ищешь, или отправь голосовое сообщение.',
    );
  }

  @Help()
  async onHelp(@Ctx() ctx: Context) {
    await ctx.reply(
      '/start — начать\n' +
        '/help — помощь\n' +
        '/subscriptions — активные подписки\n' +
        'Просто напиши запрос о туре или отправь голосовое сообщение.',
    );
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
    const text = ctx.message.text;
    const user = await this.ensureUser(ctx);

    const response = await this.openAi.parseTourRequest(text);
    if (!response.readyToSearch && response.clarificationMessage) {
      await ctx.reply(response.clarificationMessage);
      return;
    }

    const result = await this.search.searchFromParsed({
      userId: user.id,
      rawText: text,
      parsed: response.parsed,
    });

    await this.telegram.sendSearchResults(ctx.chat!.id, result);
  }

  @On('voice')
  async onVoice(@Ctx() ctx: Context) {
    if (!ctx.message || !('voice' in ctx.message)) return;
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

    const response = await this.openAi.parseTourRequest(text);
    if (!response.readyToSearch && response.clarificationMessage) {
      await ctx.reply(response.clarificationMessage);
      return;
    }

    const result = await this.search.searchFromParsed({
      userId: user.id,
      rawText: text,
      parsed: response.parsed,
    });

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

