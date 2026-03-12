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
    let prompt =
      'Ты помощник турагента. Разбираешь запрос пользователя о туре.\n\n' +
      'ОБЯЗАТЕЛЬНЫЕ поля для поиска:\n' +
      '- departureCity — город вылета (Москва, Сочи, Санкт-Петербург и т.д.). По умолчанию большинство пользователей из РФ.\n' +
      '- country — страна ИЛИ resort — курорт ИЛИ destinationMode (см. ниже)\n\n' +
      'ОСОБЫЕ СЛУЧАИ:\n' +
      '- Если пользователь говорит "без визы", "виза не нужна", "любая страна без визы", "куда угодно без визы" — ' +
      'сначала проверь departureCity. Если город вылета НЕ указан — спроси: "Из какого города планируете вылет?" (большинство из РФ).\n' +
      '- Если departureCity уже есть (например Сочи, Москва) и пользователь говорит "любая", "без визы", "неважно куда" — ' +
      'ставь readyToSearch: true, destinationMode: "visa_free", country можно не указывать — бот сам найдёт страны без визы.\n' +
      '- destinationMode: "visa_free" — пользователь хочет в страну без визы; "any" — любая страна; "specific" — указана конкретная страна.\n\n' +
      'Если хотя бы одно обязательное поле отсутствует (и не подходит особый случай выше) — верни readyToSearch: false ' +
      'и clarificationMessage — короткий дружелюбный вопрос на русском. Пиши естественно, не списком.\n\n' +
      'Если всё понятно — readyToSearch: true, clarificationMessage не указывай.\n\n';

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
