import express, { Request, Response } from 'express';
import TelegramBot, { Message, SendMessageOptions } from 'node-telegram-bot-api';
import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * MVP Telegram-бот для поиска и мониторинга туров.
 *
 * Что уже реализовано:
 * - прием текста и голосовых сообщений в Telegram
 * - транскрибация голоса через OpenAI Audio API (Whisper / Speech-to-Text)
 * - парсинг запроса в строгий JSON через OpenAI Responses API
 * - нормализация параметров и простая валидация
 * - заглушка интеграции со Sletat Search API
 * - сохранение поисковых профилей в память
 * - фоновый мониторинг и уведомления в Telegram
 * - каркас бронирования / claims flow
 *
 * Что нужно подключить для боевого режима:
 * - реальные ключи и endpoints OpenAI
 * - реальные логин/пароль и контракт с Sletat
 * - PostgreSQL / Redis вместо in-memory storage
 * - Docker / docker-compose / отдельные воркеры
 * - дедупликация, retry, rate limiting, observability
 */

// -----------------------------
// Конфигурация
// -----------------------------

type Config = {
  telegramBotToken: string;
  telegramUsePolling: boolean;
  port: number;
  publicBaseUrl?: string;
  openAiApiKey: string;
  openAiModel: string;
  openAiTranscriptionModel: string;
  sletatLogin: string;
  sletatPassword: string;
  sletatSearchBaseUrl: string;
  sletatClaimsBaseUrl: string;
  monitoringIntervalMs: number;
};

const config: Config = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramUsePolling: (process.env.TELEGRAM_USE_POLLING || 'true') === 'true',
  port: Number(process.env.PORT || 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  openAiApiKey: process.env.OPENAI_API_KEY || '',
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  openAiTranscriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
  sletatLogin: process.env.SLETAT_LOGIN || '',
  sletatPassword: process.env.SLETAT_PASSWORD || '',
  sletatSearchBaseUrl: process.env.SLETAT_SEARCH_BASE_URL || 'https://module.sletat.ru/Main.svc',
  sletatClaimsBaseUrl: process.env.SLETAT_CLAIMS_BASE_URL || 'https://claims.sletat.ru/xmlgate.svc',
  monitoringIntervalMs: Number(process.env.MONITORING_INTERVAL_MS || 1000 * 60 * 30),
};

if (!config.telegramBotToken) {
  throw new Error('TELEGRAM_BOT_TOKEN is required');
}

if (!config.openAiApiKey) {
  console.warn('OPENAI_API_KEY is empty. Voice parsing and NLP will not work in production.');
}

// -----------------------------
// Доменные типы
// -----------------------------

type TravelerComposition = {
  adults: number;
  children: number;
  childAges: number[];
};

type ParsedTourRequest = {
  departureCity?: string | null;
  destination?: string | null;
  destinationMode?: 'specific' | 'any';
  dateFrom?: string | null;
  dateTo?: string | null;
  nightsMin?: number | null;
  nightsMax?: number | null;
  travelers: TravelerComposition;
  budgetTotalRub?: number | null;
  budgetPerPersonRub?: number | null;
  mealType?: string | null;
  starsMin?: number | null;
  starsMax?: number | null;
  directFlightOnly?: boolean | null;
  visaFreeOnly?: boolean | null;
  hotelName?: string | null;
  monitorMarket?: boolean;
  ambiguities: string[];
  missingCriticalFields: string[];
  originalText: string;
};

type NormalizedTourRequest = ParsedTourRequest & {
  departureCityId?: number | null;
  countryId?: number | null;
  mealTypeId?: number | null;
  hotelId?: number | null;
  normalizedHash: string;
};

type TourOffer = {
  externalOfferId: string;
  supplierName: 'sletat';
  hotelName: string;
  country: string;
  resort?: string;
  departureCity: string;
  departureDate: string;
  nights: number;
  adults: number;
  children: number;
  mealType?: string;
  stars?: number;
  priceTotalRub: number;
  oldPriceRub?: number;
  deepLink?: string;
  rawPayload: unknown;
};

type SearchProfile = {
  id: string;
  chatId: number;
  userId: number;
  normalizedRequest: NormalizedTourRequest;
  monitoringEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  lastBestPriceRub?: number;
  notifiedOfferIds: Set<string>;
};

type BookingDraft = {
  id: string;
  chatId: number;
  userId: number;
  offer: TourOffer;
  status: 'new' | 'actualized' | 'claim_created' | 'payment_pending' | 'paid' | 'failed';
  createdAt: string;
  updatedAt: string;
  externalClaimId?: string;
  paymentUrl?: string;
};

type SletatDictionaryItem = {
  id: number;
  name: string;
};

// -----------------------------
// In-memory storage (для MVP)
// -----------------------------

class InMemoryDb {
  public profiles = new Map<string, SearchProfile>();
  public drafts = new Map<string, BookingDraft>();

  upsertProfile(profile: SearchProfile): SearchProfile {
    this.profiles.set(profile.id, profile);
    return profile;
  }

  findProfilesByChat(chatId: number): SearchProfile[] {
    return [...this.profiles.values()].filter((p) => p.chatId === chatId);
  }

  getActiveProfiles(): SearchProfile[] {
    return [...this.profiles.values()].filter((p) => p.monitoringEnabled);
  }

  getProfile(id: string): SearchProfile | undefined {
    return this.profiles.get(id);
  }

  saveDraft(draft: BookingDraft): BookingDraft {
    this.drafts.set(draft.id, draft);
    return draft;
  }

  getDraft(id: string): BookingDraft | undefined {
    return this.drafts.get(id);
  }
}

const db = new InMemoryDb();

// -----------------------------
// Утилиты
// -----------------------------

const nowIso = () => new Date().toISOString();
const randomId = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stableHash(input: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseJsonSafe<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

// -----------------------------
// OpenAI client
// -----------------------------

class OpenAiService {
  private http: AxiosInstance;

  constructor(private apiKey: string) {
    this.http = axios.create({
      baseURL: 'https://api.openai.com/v1',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: 60_000,
    });
  }

  async transcribeTelegramVoice(filePath: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is missing');
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('model', config.openAiTranscriptionModel);
    form.append('response_format', 'text');

    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...form.getHeaders(),
      },
      timeout: 60_000,
    });

    return String(response.data || '').trim();
  }

  async parseTourRequestToJson(text: string): Promise<ParsedTourRequest> {
    if (!this.apiKey) {
      return this.fallbackParse(text);
    }

    const schema = {
      name: 'tour_request',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['travelers', 'ambiguities', 'missingCriticalFields', 'originalText'],
        properties: {
          departureCity: { type: ['string', 'null'] },
          destination: { type: ['string', 'null'] },
          destinationMode: { type: 'string', enum: ['specific', 'any'] },
          dateFrom: { type: ['string', 'null'] },
          dateTo: { type: ['string', 'null'] },
          nightsMin: { type: ['number', 'null'] },
          nightsMax: { type: ['number', 'null'] },
          travelers: {
            type: 'object',
            additionalProperties: false,
            required: ['adults', 'children', 'childAges'],
            properties: {
              adults: { type: 'number' },
              children: { type: 'number' },
              childAges: { type: 'array', items: { type: 'number' } },
            },
          },
          budgetTotalRub: { type: ['number', 'null'] },
          budgetPerPersonRub: { type: ['number', 'null'] },
          mealType: { type: ['string', 'null'] },
          starsMin: { type: ['number', 'null'] },
          starsMax: { type: ['number', 'null'] },
          directFlightOnly: { type: ['boolean', 'null'] },
          visaFreeOnly: { type: ['boolean', 'null'] },
          hotelName: { type: ['string', 'null'] },
          monitorMarket: { type: 'boolean' },
          ambiguities: { type: 'array', items: { type: 'string' } },
          missingCriticalFields: { type: 'array', items: { type: 'string' } },
          originalText: { type: 'string' },
        },
      },
      strict: true,
    };

    const prompt = [
      'Ты парсер туристических запросов для Telegram-бота.',
      'Нужно преобразовать пользовательский запрос в строгий JSON.',
      'Не фантазируй. Если поле неизвестно, ставь null.',
      'Если пользователь говорит "куда угодно", destinationMode = "any".',
      'Если пользователь просит следить, мониторить, уведомлять, сообщать при появлении цены, monitorMarket = true.',
      'Выделяй ambiguities для неоднозначных фрагментов.',
      'Выделяй missingCriticalFields, если для поиска не хватает важных параметров.',
      'Дата должна быть строкой в ISO-виде, только если она явно понятна.',
      'Валюта бюджета по умолчанию — рубли, если не сказано иное.',
      `Пользовательский текст: ${text}`,
    ].join('\n');

    const response = await this.http.post('/responses', {
      model: config.openAiModel,
      input: prompt,
      text: {
        format: {
          type: 'json_schema',
          name: schema.name,
          schema: schema.schema,
          strict: true,
        },
      },
    });

    const outputText = response.data?.output_text;
    if (!outputText) {
      throw new Error('OpenAI response missing output_text');
    }

    const parsed = parseJsonSafe<ParsedTourRequest>(outputText);
    if (!parsed) {
      throw new Error(`Failed to parse OpenAI JSON: ${outputText}`);
    }

    return parsed;
  }

  private fallbackParse(text: string): ParsedTourRequest {
    const lowered = text.toLowerCase();
    const budgetMatch = lowered.match(/до\s*(\d{2,7})\s*(?:₽|руб|р|тыс|тысяч)?/i);
    const budgetValue = budgetMatch ? Number(budgetMatch[1]) : null;

    const adultsMatch = lowered.match(/(\d+)\s*(?:взросл|человек|чел)/i);
    const adults = adultsMatch ? Number(adultsMatch[1]) : 2;

    const nightsMatch = lowered.match(/на\s*(\d+)\s*(?:дн|дня|дней|ноч|ночи|ночей)/i);
    const nights = nightsMatch ? Number(nightsMatch[1]) : null;

    return {
      departureCity: null,
      destination: lowered.includes('куда угодно') ? null : null,
      destinationMode: lowered.includes('куда угодно') ? 'any' : 'specific',
      dateFrom: null,
      dateTo: null,
      nightsMin: nights,
      nightsMax: nights,
      travelers: {
        adults,
        children: 0,
        childAges: [],
      },
      budgetTotalRub: budgetValue,
      budgetPerPersonRub: null,
      mealType: null,
      starsMin: null,
      starsMax: null,
      directFlightOnly: null,
      visaFreeOnly: null,
      hotelName: null,
      monitorMarket: lowered.includes('следи') || lowered.includes('монитор') || lowered.includes('уведом'),
      ambiguities: [],
      missingCriticalFields: ['departureCity'],
      originalText: text,
    };
  }
}

const openAiService = new OpenAiService(config.openAiApiKey);

// -----------------------------
// Sletat dictionaries and API stub
// -----------------------------

class SletatService {
  private dictionariesLoaded = false;
  private departureCities: SletatDictionaryItem[] = [
    { id: 1, name: 'Москва' },
    { id: 2, name: 'Санкт-Петербург' },
    { id: 3, name: 'Казань' },
    { id: 4, name: 'Екатеринбург' },
  ];
  private countries: SletatDictionaryItem[] = [
    { id: 10, name: 'Турция' },
    { id: 11, name: 'Египет' },
    { id: 12, name: 'ОАЭ' },
    { id: 13, name: 'Таиланд' },
  ];
  private meals: SletatDictionaryItem[] = [
    { id: 101, name: 'AI' },
    { id: 102, name: 'UAI' },
    { id: 103, name: 'BB' },
    { id: 104, name: 'HB' },
  ];
  private hotels: SletatDictionaryItem[] = [
    { id: 501, name: 'Rixos Premium Belek' },
    { id: 502, name: 'Sunrise Arabian Beach Resort' },
    { id: 503, name: 'Titanic Deluxe Lara' },
  ];

  async ensureDictionariesLoaded(): Promise<void> {
    if (this.dictionariesLoaded) return;

    // TODO: Подключить реальные методы словарей Sletat.
    // На MVP-скелете держим локальную заглушку.
    this.dictionariesLoaded = true;
  }

  async normalize(parsed: ParsedTourRequest): Promise<NormalizedTourRequest> {
    await this.ensureDictionariesLoaded();

    const departureCityId = this.findByName(this.departureCities, parsed.departureCity);
    const countryId = this.findByName(this.countries, parsed.destination);
    const mealTypeId = this.findByName(this.meals, parsed.mealType);
    const hotelId = this.findByName(this.hotels, parsed.hotelName);

    const normalized: NormalizedTourRequest = {
      ...parsed,
      departureCityId,
      countryId,
      mealTypeId,
      hotelId,
      normalizedHash: stableHash({
        departureCityId,
        countryId,
        mealTypeId,
        hotelId,
        destinationMode: parsed.destinationMode,
        dateFrom: parsed.dateFrom,
        dateTo: parsed.dateTo,
        nightsMin: parsed.nightsMin,
        nightsMax: parsed.nightsMax,
        travelers: parsed.travelers,
        budgetTotalRub: parsed.budgetTotalRub,
        budgetPerPersonRub: parsed.budgetPerPersonRub,
        mealType: parsed.mealType,
        starsMin: parsed.starsMin,
        starsMax: parsed.starsMax,
        directFlightOnly: parsed.directFlightOnly,
        visaFreeOnly: parsed.visaFreeOnly,
      }),
    };

    return normalized;
  }

  private findByName(items: SletatDictionaryItem[], value?: string | null): number | null {
    if (!value) return null;
    const match = items.find((item) => item.name.toLowerCase() === value.toLowerCase().trim());
    return match?.id || null;
  }

  hasEnoughToSearch(normalized: NormalizedTourRequest): boolean {
    const hasDeparture = Boolean(normalized.departureCity || normalized.departureCityId);
    const hasDuration = Boolean(normalized.nightsMin || normalized.dateFrom || normalized.dateTo);
    const hasTravelers = normalized.travelers.adults > 0;

    return hasDeparture && hasDuration && hasTravelers;
  }

  async searchTours(normalized: NormalizedTourRequest): Promise<TourOffer[]> {
    // TODO: заменить на реальные вызовы Sletat Search API.
    // Сейчас возвращаем правдоподобную заглушку для прототипа.

    const baseOffers: TourOffer[] = [
      {
        externalOfferId: 'slt_1',
        supplierName: 'sletat',
        hotelName: normalized.destination === 'Египет' ? 'Sunrise Arabian Beach Resort' : 'Titanic Deluxe Lara',
        country: normalized.destination || 'Турция',
        resort: normalized.destination === 'Египет' ? 'Шарм-эль-Шейх' : 'Белек',
        departureCity: normalized.departureCity || 'Москва',
        departureDate: normalized.dateFrom || new Date(Date.now() + 1000 * 60 * 60 * 24 * 10).toISOString().slice(0, 10),
        nights: normalized.nightsMin || 5,
        adults: normalized.travelers.adults,
        children: normalized.travelers.children,
        mealType: normalized.mealType || 'AI',
        stars: normalized.starsMin || 5,
        priceTotalRub: Math.max(35_000, normalized.budgetTotalRub ? Math.min(normalized.budgetTotalRub + 10_000, 95_000) : 89_000),
        oldPriceRub: 102_000,
        deepLink: 'https://example.com/tour/1',
        rawPayload: { mock: true },
      },
      {
        externalOfferId: 'slt_2',
        supplierName: 'sletat',
        hotelName: normalized.destination === 'Египет' ? 'Rixos Sharm El Sheikh' : 'Rixos Premium Belek',
        country: normalized.destination || 'Турция',
        resort: normalized.destination === 'Египет' ? 'Шарм-эль-Шейх' : 'Белек',
        departureCity: normalized.departureCity || 'Москва',
        departureDate: normalized.dateFrom || new Date(Date.now() + 1000 * 60 * 60 * 24 * 12).toISOString().slice(0, 10),
        nights: (normalized.nightsMax || normalized.nightsMin || 6),
        adults: normalized.travelers.adults,
        children: normalized.travelers.children,
        mealType: normalized.mealType || 'AI',
        stars: 5,
        priceTotalRub: Math.max(42_000, normalized.budgetTotalRub ? Math.min(normalized.budgetTotalRub + 25_000, 130_000) : 119_000),
        oldPriceRub: 142_000,
        deepLink: 'https://example.com/tour/2',
        rawPayload: { mock: true },
      },
      {
        externalOfferId: 'slt_3',
        supplierName: 'sletat',
        hotelName: normalized.destination === 'Египет' ? 'Baron Resort Sharm El Sheikh' : 'IC Hotels Green Palace',
        country: normalized.destination || 'Турция',
        resort: normalized.destination === 'Египет' ? 'Шарм-эль-Шейх' : 'Анталья',
        departureCity: normalized.departureCity || 'Москва',
        departureDate: normalized.dateFrom || new Date(Date.now() + 1000 * 60 * 60 * 24 * 15).toISOString().slice(0, 10),
        nights: normalized.nightsMin || 7,
        adults: normalized.travelers.adults,
        children: normalized.travelers.children,
        mealType: normalized.mealType || 'UAI',
        stars: 5,
        priceTotalRub: Math.max(48_000, normalized.budgetTotalRub ? Math.min(normalized.budgetTotalRub + 30_000, 145_000) : 132_000),
        oldPriceRub: 150_000,
        deepLink: 'https://example.com/tour/3',
        rawPayload: { mock: true },
      },
    ];

    const filtered = baseOffers.filter((offer) => {
      if (normalized.budgetTotalRub && offer.priceTotalRub > normalized.budgetTotalRub * 1.3) {
        return false;
      }
      if (normalized.starsMin && (offer.stars || 0) < normalized.starsMin) {
        return false;
      }
      return true;
    });

    return filtered.sort((a, b) => a.priceTotalRub - b.priceTotalRub).slice(0, 5);
  }

  async actualizeOffer(offer: TourOffer): Promise<TourOffer> {
    // TODO: вызвать ActualizePrice или эквивалентный метод Sletat.
    return {
      ...offer,
      priceTotalRub: offer.priceTotalRub,
    };
  }

  async createClaim(offer: TourOffer, userId: number): Promise<{ claimId: string; paymentUrl?: string }> {
    // TODO: подключить реальный Sletat Claims / Online Payment API.
    return {
      claimId: `claim_${userId}_${Date.now()}`,
      paymentUrl: `https://example.com/pay/${offer.externalOfferId}`,
    };
  }
}

const sletatService = new SletatService();

// -----------------------------
// Presentation helpers
// -----------------------------

function formatParsedSummary(parsed: NormalizedTourRequest): string {
  const chunks = [
    parsed.departureCity ? `Вылет: ${parsed.departureCity}` : 'Вылет: не указан',
    parsed.destinationMode === 'any' ? 'Направление: куда угодно' : `Направление: ${parsed.destination || 'не указано'}`,
    parsed.nightsMin ? `Ночей: от ${parsed.nightsMin}${parsed.nightsMax && parsed.nightsMax !== parsed.nightsMin ? ` до ${parsed.nightsMax}` : ''}` : 'Ночей: не указано',
    `Туристы: ${parsed.travelers.adults} взр. + ${parsed.travelers.children} детей`,
    parsed.budgetTotalRub ? `Бюджет: до ${parsed.budgetTotalRub.toLocaleString('ru-RU')} ₽` : 'Бюджет: не ограничен',
    parsed.mealType ? `Питание: ${parsed.mealType}` : null,
    parsed.starsMin ? `Звезды: от ${parsed.starsMin}` : null,
  ].filter(Boolean);

  return chunks.join('\n');
}

function formatOfferCard(offer: TourOffer): string {
  const oldPrice = offer.oldPriceRub ? `\nСтарая цена: <s>${offer.oldPriceRub.toLocaleString('ru-RU')} ₽</s>` : '';
  return [
    `<b>${escapeHtml(offer.country)}${offer.resort ? `, ${escapeHtml(offer.resort)}` : ''}</b>`,
    `${'⭐'.repeat(offer.stars || 0)} ${escapeHtml(offer.hotelName)}`,
    `Вылет: ${escapeHtml(offer.departureCity)}, ${escapeHtml(offer.departureDate)}`,
    `Ночей: ${offer.nights}`,
    `Туристы: ${offer.adults} взр. + ${offer.children} детей`,
    offer.mealType ? `Питание: ${escapeHtml(offer.mealType)}` : null,
    `Цена: <b>${offer.priceTotalRub.toLocaleString('ru-RU')} ₽</b>${oldPrice}`,
  ].filter(Boolean).join('\n');
}

function buildOfferKeyboard(profileId: string, offer: TourOffer) {
  return {
    inline_keyboard: [
      [
        { text: 'Следить за запросом', callback_data: `watch:${profileId}` },
        { text: 'Хочу этот тур', callback_data: `book:${offer.externalOfferId}:${profileId}` },
      ],
    ],
  };
}

// -----------------------------
// Bot service
// -----------------------------

class TourBotService {
  constructor(private bot: TelegramBot) {}

  async handleStart(msg: Message): Promise<void> {
    await this.bot.sendMessage(
      msg.chat.id,
      [
        'Привет! Я помогу найти и мониторить туры.',
        '',
        'Можно написать текстом или отправить голосовое сообщение, например:',
        '«Найди тур в Египет на 5 ночей из Москвы на двоих до 120000 рублей и следи за ценой»',
      ].join('\n'),
    );
  }

  async handleHelp(msg: Message): Promise<void> {
    await this.bot.sendMessage(
      msg.chat.id,
      [
        'Что я умею:',
        '/start — начать работу',
        '/help — помощь',
        '/subscriptions — мои подписки',
        '',
        'Пример запроса:',
        'Найди мне тур в Турцию на 6 ночей из Казани, 2 взрослых, all inclusive, до 150000 рублей',
      ].join('\n'),
    );
  }

  async handleSubscriptions(msg: Message): Promise<void> {
    const profiles = db.findProfilesByChat(msg.chat.id);
    if (!profiles.length) {
      await this.bot.sendMessage(msg.chat.id, 'У вас пока нет активных подписок.');
      return;
    }

    const text = profiles
      .map((p, index) => {
        const req = p.normalizedRequest;
        return [
          `${index + 1}. ${req.destinationMode === 'any' ? 'Куда угодно' : req.destination || 'Направление не указано'}`,
          `   Вылет: ${req.departureCity || 'не указан'}`,
          `   Бюджет: ${req.budgetTotalRub ? `${req.budgetTotalRub.toLocaleString('ru-RU')} ₽` : 'без лимита'}`,
          `   Мониторинг: ${p.monitoringEnabled ? 'включен' : 'выключен'}`,
          `   ID: ${p.id}`,
        ].join('\n');
      })
      .join('\n\n');

    await this.bot.sendMessage(msg.chat.id, text);
  }

  async handleTextMessage(msg: Message): Promise<void> {
    const text = msg.text?.trim();
    if (!text) return;

    if (text.startsWith('/start')) return this.handleStart(msg);
    if (text.startsWith('/help')) return this.handleHelp(msg);
    if (text.startsWith('/subscriptions')) return this.handleSubscriptions(msg);

    await this.bot.sendMessage(msg.chat.id, 'Понял запрос, обрабатываю...');
    await this.processUserText(msg.chat.id, msg.from?.id || msg.chat.id, text);
  }

  async handleVoiceMessage(msg: Message): Promise<void> {
    if (!msg.voice) return;
    const userId = msg.from?.id || msg.chat.id;
    const fileId = msg.voice.file_id;

    await this.bot.sendMessage(msg.chat.id, 'Получил голосовое сообщение, распознаю текст...');

    const tempDir = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `${fileId}.ogg`);

    try {
      const fileUrl = await this.bot.getFileLink(fileId);
      const response = await axios.get<ArrayBuffer>(fileUrl, { responseType: 'arraybuffer', timeout: 60_000 });
      fs.writeFileSync(tempFilePath, Buffer.from(response.data));

      const transcript = await openAiService.transcribeTelegramVoice(tempFilePath);
      await this.bot.sendMessage(msg.chat.id, `Распознал: «${transcript}»`);
      await this.processUserText(msg.chat.id, userId, transcript);
    } catch (error) {
      console.error('Voice processing failed', error);
      await this.bot.sendMessage(msg.chat.id, 'Не удалось обработать голосовое сообщение. Попробуйте текстом.');
    } finally {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {
        // ignore
      }
    }
  }

  private async processUserText(chatId: number, userId: number, text: string): Promise<void> {
    const parsed = await openAiService.parseTourRequestToJson(text);
    const normalized = await sletatService.normalize(parsed);

    if (normalized.ambiguities.length > 0) {
      await this.bot.sendMessage(
        chatId,
        `Есть неоднозначности: ${normalized.ambiguities.join(', ')}. Я постараюсь подобрать наиболее вероятный вариант.`,
      );
    }

    if (!sletatService.hasEnoughToSearch(normalized)) {
      const missing = normalized.missingCriticalFields.length
        ? normalized.missingCriticalFields.join(', ')
        : 'город вылета, длительность или состав туристов';
      await this.bot.sendMessage(
        chatId,
        `Для запуска поиска не хватает данных: ${missing}.\nПример: «Египет, вылет из Москвы, 2 взрослых, 5 ночей, до 120000 рублей».`,
      );
      return;
    }

    const profile: SearchProfile = {
      id: randomId('profile'),
      chatId,
      userId,
      normalizedRequest: normalized,
      monitoringEnabled: Boolean(normalized.monitorMarket),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      notifiedOfferIds: new Set<string>(),
    };

    db.upsertProfile(profile);

    await this.bot.sendMessage(
      chatId,
      `Ищу туры по параметрам:\n\n${formatParsedSummary(normalized)}\n\nМониторинг: ${profile.monitoringEnabled ? 'включен' : 'выключен'}`,
    );

    const offers = await sletatService.searchTours(normalized);
    if (!offers.length) {
      await this.bot.sendMessage(
        chatId,
        'Подходящих туров сейчас не нашлось. Могу сохранить запрос и следить за рынком, когда появятся варианты.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: 'Следить за рынком', callback_data: `watch:${profile.id}` }]],
          },
        },
      );
      return;
    }

    for (const offer of offers) {
      await this.bot.sendMessage(chatId, formatOfferCard(offer), {
        parse_mode: 'HTML',
        reply_markup: buildOfferKeyboard(profile.id, offer),
      } as SendMessageOptions);
    }
  }

  async handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
    const data = query.data;
    const message = query.message;
    if (!data || !message) return;

    const [action, arg1, arg2] = data.split(':');

    try {
      if (action === 'watch' && arg1) {
        const profile = db.getProfile(arg1);
        if (!profile) {
          await this.bot.answerCallbackQuery(query.id, { text: 'Подписка не найдена.' });
          return;
        }
        profile.monitoringEnabled = true;
        profile.updatedAt = nowIso();
        db.upsertProfile(profile);
        await this.bot.answerCallbackQuery(query.id, { text: 'Мониторинг включен.' });
        await this.bot.sendMessage(message.chat.id, 'Готово. Я буду следить за рынком и писать, если появится подходящий тур или цена снизится.');
        return;
      }

      if (action === 'book' && arg1 && arg2) {
        const profile = db.getProfile(arg2);
        if (!profile) {
          await this.bot.answerCallbackQuery(query.id, { text: 'Профиль поиска не найден.' });
          return;
        }

        const offers = await sletatService.searchTours(profile.normalizedRequest);
        const selectedOffer = offers.find((offer) => offer.externalOfferId === arg1);
        if (!selectedOffer) {
          await this.bot.answerCallbackQuery(query.id, { text: 'Тур больше не найден.' });
          return;
        }

        const actualized = await sletatService.actualizeOffer(selectedOffer);
        const claim = await sletatService.createClaim(actualized, profile.userId);
        const draft: BookingDraft = {
          id: randomId('booking'),
          chatId: profile.chatId,
          userId: profile.userId,
          offer: actualized,
          status: claim.paymentUrl ? 'payment_pending' : 'claim_created',
          createdAt: nowIso(),
          updatedAt: nowIso(),
          externalClaimId: claim.claimId,
          paymentUrl: claim.paymentUrl,
        };
        db.saveDraft(draft);

        await this.bot.answerCallbackQuery(query.id, { text: 'Заявка создана.' });
        await this.bot.sendMessage(
          message.chat.id,
          [
            'Черновик бронирования создан.',
            `Claim ID: ${claim.claimId}`,
            claim.paymentUrl ? `Ссылка на оплату: ${claim.paymentUrl}` : 'Ссылка на оплату пока недоступна.',
            '',
            'В боевой версии здесь будет полноценный поток online booking через Sletat Claims / Payment API.',
          ].join('\n'),
        );
        return;
      }
    } catch (error) {
      console.error('Callback query failed', error);
      await this.bot.answerCallbackQuery(query.id, { text: 'Произошла ошибка. Попробуйте еще раз.' });
    }
  }

  async runMonitoringCycle(): Promise<void> {
    const activeProfiles = db.getActiveProfiles();
    for (const profile of activeProfiles) {
      try {
        const offers = await sletatService.searchTours(profile.normalizedRequest);
        const bestOffer = offers[0];
        profile.lastCheckedAt = nowIso();

        if (!bestOffer) {
          db.upsertProfile(profile);
          continue;
        }

        const isNewOffer = !profile.notifiedOfferIds.has(bestOffer.externalOfferId);
        const priceDropped = profile.lastBestPriceRub !== undefined && bestOffer.priceTotalRub < profile.lastBestPriceRub;
        const inBudget = profile.normalizedRequest.budgetTotalRub
          ? bestOffer.priceTotalRub <= profile.normalizedRequest.budgetTotalRub
          : true;

        if ((isNewOffer || priceDropped) && inBudget) {
          profile.notifiedOfferIds.add(bestOffer.externalOfferId);
          profile.lastBestPriceRub = bestOffer.priceTotalRub;
          profile.updatedAt = nowIso();
          db.upsertProfile(profile);

          await this.bot.sendMessage(
            profile.chatId,
            `Нашел обновление по вашей подписке:\n\n${formatOfferCard(bestOffer)}`,
            {
              parse_mode: 'HTML',
              reply_markup: buildOfferKeyboard(profile.id, bestOffer),
            } as SendMessageOptions,
          );
        } else {
          if (!profile.lastBestPriceRub) {
            profile.lastBestPriceRub = bestOffer.priceTotalRub;
          }
          db.upsertProfile(profile);
        }
      } catch (error) {
        console.error('Monitoring cycle failed for profile', profile.id, error);
      }

      await sleep(500);
    }
  }
}

// -----------------------------
// Bootstrap
// -----------------------------

const bot = new TelegramBot(config.telegramBotToken, {
  polling: config.telegramUsePolling,
});

const tourBotService = new TourBotService(bot);

bot.onText(/\/start/, async (msg) => tourBotService.handleStart(msg));
bot.onText(/\/help/, async (msg) => tourBotService.handleHelp(msg));
bot.onText(/\/subscriptions/, async (msg) => tourBotService.handleSubscriptions(msg));
bot.on('message', async (msg) => {
  if (msg.voice) return tourBotService.handleVoiceMessage(msg);
  if (msg.text) return tourBotService.handleTextMessage(msg);
});
bot.on('callback_query', async (query) => tourBotService.handleCallbackQuery(query));

const app = express();
const upload = multer({ dest: path.join(process.cwd(), 'uploads') });
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', time: nowIso() });
});

/**
 * Этот endpoint оставлен как задел под webhook, если отключить polling.
 * Для production лучше использовать webhook + reverse proxy.
 */
app.post('/telegram/webhook', async (req: Request, res: Response) => {
  try {
    await bot.processUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error', error);
    res.status(500).json({ ok: false });
  }
});

/**
 * Технический endpoint для ручной проверки мониторинга.
 */
app.post('/internal/monitor/run', async (_req: Request, res: Response) => {
  await tourBotService.runMonitoringCycle();
  res.json({ ok: true });
});

/**
 * Технический endpoint для отладки транскрибации.
 */
app.post('/internal/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'audio file required' });
      return;
    }

    const text = await openAiService.transcribeTelegramVoice(req.file.path);
    res.json({ text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'transcription failed' });
  } finally {
    if (req.file?.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        // ignore
      }
    }
  }
});

app.listen(config.port, () => {
  console.log(`Server started on port ${config.port}`);
  console.log(`Telegram polling: ${config.telegramUsePolling ? 'enabled' : 'disabled'}`);
});

setInterval(async () => {
  await tourBotService.runMonitoringCycle();
}, config.monitoringIntervalMs);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
