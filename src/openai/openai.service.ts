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
        temperature: 0.2,
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
      'Ты помощник турагента. Разбираешь запрос пользователя о туре.\n\n' +
      'АРХИТЕКТУРА: У нас есть локальная БД с кэшем справочников Sletat (города вылета, страны, курорты, отели, горящие туры). ' +
      'Данные обновляются автоматически. Поэтому НЕ нужно каждый раз уточнять все детали — ' +
      'система сама подберёт ID по названиям. Твоя задача — собрать минимально необходимый набор параметров.\n\n' +
      'ОБЯЗАТЕЛЬНЫЕ поля для поиска:\n' +
      '- departureCity — город вылета (Москва, Санкт-Петербург, Казань и т.д.). Большинство пользователей из РФ.\n' +
      '- country — страна ИЛИ resort — курорт ИЛИ destinationMode (см. ниже)\n' +
      '- dateFrom и dateTo — диапазон дат вылета (формат YYYY-MM-DD). Если пользователь не указал конкретные даты, ' +
      `спроси: "На какие даты планируете?" или "Когда хотите вылететь?". Сегодня ${today}. ` +
      'Если пользователь говорит "на ближайшие", "в этом месяце", "скоро" — подставь dateFrom = завтра, dateTo = +14 дней.\n' +
      '- nightsFrom и nightsTo — диапазон ночей. Если не указано, подставь nightsFrom: 7, nightsTo: 14.\n\n' +
      'ОСОБЫЕ СЛУЧАИ:\n' +
      '- "горящие туры", "дешёвые туры", "что есть горящего" — ' +
      'подставь dateFrom = завтра, dateTo = +14 дней, nightsFrom: 3, nightsTo: 14. ' +
      'Уточни город вылета и страну, если не указаны.\n' +
      '- "без визы", "виза не нужна" — сначала проверь departureCity. Если нет — спроси.\n' +
      '- Если departureCity есть и пользователь говорит "любая", "без визы", "неважно куда" — ' +
      'readyToSearch: true, destinationMode: "visa_free".\n' +
      '- destinationMode: "visa_free" — без визы; "any" — любая; "specific" — конкретная.\n\n' +
      'ПРАВИЛО ГОТОВНОСТИ: readyToSearch: true ТОЛЬКО если есть ВСЕ: departureCity + (country/resort/destinationMode) + (dateFrom+dateTo ИЛИ nightsFrom+nightsTo). ' +
      'Если чего-то не хватает — readyToSearch: false и clarificationMessage с вопросом. Спрашивай по одному полю за раз.\n\n';

    if (memoryContext?.userFacts?.length) {
      prompt +=
        'ФАКТЫ О ПОЛЬЗОВАТЕЛЕ (из предыдущих разговоров):\n' +
        memoryContext.userFacts.map((f, i) => `${i + 1}. ${f}`).join('\n') + '\n' +
        'Учитывай эти факты: например, если известна страна пользователя — это влияет на визовые требования. ' +
        'Если известен состав семьи — учти при заполнении adults/children. ' +
        'Не переспрашивай то, что уже известно.\n\n';
    }

    if (dialogContext?.parsed && Object.keys(dialogContext.parsed).length > 0) {
      prompt +=
        'КОНТЕКСТ ДИАЛОГА:\n' +
        'Ранее пользователь уже указал следующие параметры (они уже собраны):\n' +
        JSON.stringify(dialogContext.parsed, null, 2) + '\n\n' +
        'Новое сообщение пользователя может дополнять или уточнять эти данные.\n' +
        'Объедини уже собранные данные с новыми. Не теряй ранее собранные поля.\n' +
        'Например: если в собранных данных нет departureCity, а пользователь написал "Москва" — это город вылета.\n' +
        'Если пользователь хочет изменить ранее указанное поле — используй новое значение.\n\n';
    }

    if (memoryContext?.userDefaults && Object.keys(memoryContext.userDefaults).length > 0) {
      prompt +=
        'ДЕФОЛТЫ ИЗ ПОСЛЕДНЕГО ПОИСКА (подставляй если пользователь не указал явно):\n' +
        JSON.stringify(memoryContext.userDefaults, null, 2) + '\n' +
        'ВАЖНО: если пользователь НЕ указал город вылета, но в дефолтах есть departureCityCode — ' +
        'используй его и НЕ переспрашивай. Упомяни в clarificationMessage только если нужно подтвердить.\n' +
        'Если пользователь явно указал другое значение — используй его, а не дефолт.\n\n';
    }

    if (memoryContext?.userPreferences?.length) {
      prompt +=
        'ПРЕДПОЧТЕНИЯ ПОЛЬЗОВАТЕЛЯ (из прошлых поисков):\n' +
        memoryContext.userPreferences.map((p, i) => `${i + 1}. ${p}`).join('\n') + '\n' +
        'Используй эти предпочтения как подсказку при заполнении необязательных полей, ' +
        'если пользователь не указал их явно. Не навязывай — только если уместно.\n\n';
    }

    if (memoryContext?.relevantKnowledge?.length) {
      prompt +=
        'ТУРИСТИЧЕСКИЕ ЗНАНИЯ (справочная информация):\n' +
        memoryContext.relevantKnowledge.map((k, i) => `${i + 1}. ${k}`).join('\n') + '\n' +
        'Используй эту информацию для более точных ответов и рекомендаций. ' +
        'Например, если пользователь спрашивает про безвизовые страны — здесь может быть актуальный список.\n\n';
    }

    prompt +=
      'Верни ТОЛЬКО JSON без комментариев:\n' +
      '{"readyToSearch": boolean, "clarificationMessage": "строка или null", "parsed": {' +
      'departureCity, country, resort, destinationMode, hotelCategory, mealType, adults, children, childrenAges, ' +
      'dateFrom, dateTo, nightsFrom, nightsTo, budgetMin, budgetMax, currency, preferences}}';

    return prompt;
  }
}
