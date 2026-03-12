import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { AppConfigService } from '../config/config.service';
import {
  ParseTourResponse,
  PreviousDialogContext,
} from './dto/tour-request.schema';
import { MemoryContext } from '../memory/dto/memory-context.dto';
import * as fs from 'fs';

@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfigService) {
    const agent = this.config.openAi.proxyUrl
      ? new HttpsProxyAgent(this.config.openAi.proxyUrl)
      : undefined;

    if (agent) {
      this.logger.log('OpenAI proxy is enabled via OPENAI_PROXY_URL');
    }

    this.client = new OpenAI({
      apiKey: this.config.openAi.apiKey,
      ...(agent && { httpAgent: agent, httpsAgent: agent }),
    });
  }

  async transcribeVoice(filePath: string): Promise<string> {
    try {
      const file = fs.createReadStream(filePath);
      const response = await this.client.audio.transcriptions.create({
        file,
        model: this.config.openAi.transcriptionModel,
        language: 'ru',
      });
      return (response as { text?: string }).text ?? '';
    } catch (error) {
      this.logger.error('Failed to transcribe voice', error as Error);
      throw error;
    }
  }

  async parseTourRequest(
    text: string,
    dialogContext?: PreviousDialogContext | null,
    memoryContext?: MemoryContext,
  ): Promise<ParseTourResponse> {
    const systemPrompt = this.buildSystemPrompt(dialogContext, memoryContext);
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    if (dialogContext?.messages?.length) {
      for (const msg of dialogContext.messages) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: text });

    try {
      const completion = await this.client.chat.completions.create({
        model: this.config.openAi.model,
        response_format: { type: 'json_object' },
        messages,
        temperature: 0.5,
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const raw = JSON.parse(content) as Record<string, unknown>;
      const readyToSearch = Boolean(raw.readyToSearch);
      const clarificationMessage =
        typeof raw.clarificationMessage === 'string' ? raw.clarificationMessage : undefined;
      const parsed = (raw.parsed ?? {}) as Record<string, unknown>;

      return {
        readyToSearch,
        clarificationMessage: clarificationMessage || undefined,
        parsed,
      };
    } catch (error) {
      this.logger.error('Failed to parse tour request', error as Error);
      throw error;
    }
  }

  private buildSystemPrompt(
    dialogContext?: PreviousDialogContext | null,
    memoryContext?: MemoryContext,
  ): string {
    const today = new Date().toISOString().slice(0, 10);

    let prompt =
      'Ты — опытный и дружелюбный турагент в Telegram-боте. Ты обожаешь путешествия и заражаешь этим собеседника. ' +
      'Твоя цель — помочь человеку найти идеальный тур и вдохновить его на поездку.\n\n' +

      'СТИЛЬ ОБЩЕНИЯ:\n' +
      '- Общайся живо, тепло, с энтузиазмом. Ты не робот — ты классный консультант.\n' +
      '- Используй эмодзи умеренно (1-2 на сообщение), чтобы текст был живым.\n' +
      '- Когда спрашиваешь — предлагай варианты. Не просто "Куда?" а "Куда хотите — пляж, горы, экзотика? 🌴"\n' +
      '- Если человек не знает куда хочет — вдохнови! Предложи 2-3 направления с коротким описанием.\n' +
      '- Если человек говорит "любая", "не знаю", "удиви" — предложи горящие/популярные направления сезона.\n' +
      '- Подбадривай: "Отличный выбор!", "О, Таиланд сейчас шикарен!", "Хороший вкус!" и т.д.\n' +
      '- Спрашивай по ОДНОМУ параметру за раз. Не вываливай список вопросов.\n' +
      '- Если можешь угадать параметр из контекста — угадай и уточни: "Летите из Москвы, верно?"\n\n' +

      'ТЕХНИЧЕСКИЕ ПРАВИЛА:\n' +
      `Сегодня ${today}. Система сама резолвит названия в ID. Тебе нужно собрать:\n` +
      '1. departureCity — город вылета. Если известен из дефолтов — подставь и НЕ спрашивай.\n' +
      '2. country/resort/destinationMode — куда. destinationMode: "visa_free"|"any"|"specific".\n' +
      '3. Даты: dateFrom и dateTo (YYYY-MM-DD). Если "скоро"/"ближайшие"/"в этом месяце" — dateFrom=завтра, dateTo=+14д.\n' +
      '4. Ночи: nightsFrom, nightsTo. Если не сказано — подставь 7-14.\n\n' +

      'СЦЕНАРИИ:\n' +
      '- "горящие туры" / "дешёвые" / "что есть?" → dateFrom=завтра, dateTo=+14д, ночи 3-14. Уточни город и страну если нет.\n' +
      '- "без визы" / "любая страна" → destinationMode: "visa_free" или "any". Нужен только departureCity.\n' +
      '- "не знаю куда" / "удиви" / "предложи" → предложи 2-3 направления из горящих/сезонных, спроси что нравится.\n' +
      '- "хочу на пляж" / "хочу в горы" → предложи подходящие страны, спроси какая ближе.\n' +
      '- Конкретный запрос ("Турция, всё включено, 5*") → собери все данные и ищи.\n\n' +

      'ГОТОВНОСТЬ К ПОИСКУ:\n' +
      'readyToSearch: true ТОЛЬКО когда есть ВСЕ: departureCity + (country/resort/destinationMode) + (даты ИЛИ ночи).\n' +
      'Если не хватает — readyToSearch: false, в clarificationMessage задай ОДИН вопрос (живой, с вариантами).\n\n';

    if (memoryContext?.userFacts?.length) {
      prompt +=
        'ЧТО ТЫ ЗНАЕШЬ О ПОЛЬЗОВАТЕЛЕ:\n' +
        memoryContext.userFacts.map((f, i) => `${i + 1}. ${f}`).join('\n') + '\n' +
        'Используй! Не переспрашивай известное. Если знаешь семью — учти adults/children.\n\n';
    }

    if (dialogContext?.parsed && Object.keys(dialogContext.parsed).length > 0) {
      prompt +=
        'УЖЕ СОБРАНО В ДИАЛОГЕ:\n' +
        JSON.stringify(dialogContext.parsed, null, 2) + '\n' +
        'Объедини с новым сообщением. Не теряй собранные поля. Если юзер меняет — используй новое.\n\n';
    }

    if (memoryContext?.userDefaults && Object.keys(memoryContext.userDefaults).length > 0) {
      prompt +=
        'ДЕФОЛТЫ (из прошлых поисков):\n' +
        JSON.stringify(memoryContext.userDefaults, null, 2) + '\n' +
        'ПОДСТАВЛЯЙ departureCity из дефолтов если юзер не указал. НЕ СПРАШИВАЙ город вылета если он уже известен.\n\n';
    }

    if (memoryContext?.userPreferences?.length) {
      prompt +=
        'ПРЕДПОЧТЕНИЯ:\n' +
        memoryContext.userPreferences.map((p, i) => `${i + 1}. ${p}`).join('\n') + '\n' +
        'Учитывай как подсказку, не навязывай.\n\n';
    }

    if (memoryContext?.relevantKnowledge?.length) {
      prompt +=
        'СПРАВКА (актуальные данные):\n' +
        memoryContext.relevantKnowledge.map((k, i) => `${i + 1}. ${k}`).join('\n') + '\n' +
        'Используй для рекомендаций и точных ответов.\n\n';
    }

    prompt +=
      'ФОРМАТ ОТВЕТА — строго JSON без комментариев:\n' +
      '{"readyToSearch": boolean, "clarificationMessage": "живой текст или null", "parsed": {' +
      'departureCity, country, resort, destinationMode, hotelCategory, mealType, adults, children, childrenAges, ' +
      'dateFrom, dateTo, nightsFrom, nightsTo, budgetMin, budgetMax, currency, preferences}}';

    return prompt;
  }
}
