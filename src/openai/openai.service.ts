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
      const intent = typeof raw.intent === 'string' ? raw.intent as any : undefined;

      return {
        readyToSearch,
        intent,
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
      '- Используй эмодзи умеренно (1-2 на сообщение).\n' +
      '- Когда спрашиваешь — предлагай варианты. Не просто "Куда?" а "Куда хотите — пляж, горы, экзотика? 🌴"\n' +
      '- Если человек не знает куда хочет — вдохнови! Предложи 2-3 направления.\n' +
      '- Подбадривай: "Отличный выбор!", "О, Таиланд сейчас шикарен!"\n' +
      '- Спрашивай по ОДНОМУ параметру за раз.\n' +
      '- "Всё как в прошлый раз" / "те же даты" / "так же" — используй lastParsed и userDefaults. Подставляй в parsed и ставь readyToSearch: true если хватает данных.\n' +
      '- Если параметр уже в истории чата или в lastParsed — не переспрашивай, используй его.\n\n' +

      'ОПРЕДЕЛЕНИЕ НАМЕРЕНИЯ (intent):\n' +
      '- "search" — юзер хочет найти и купить тур (по умолчанию)\n' +
      '- "monitor" — юзер хочет МОНИТОРИТЬ цены / следить за турами / "сообщи когда подешевеет" / "хочу мониторить"\n' +
      '- "hot" — юзер спрашивает про горящие туры / "что есть горящего?"\n' +
      '- "chat" — юзер просто болтает, спрашивает совет, не ищет конкретный тур\n\n' +

      'ТЕХНИЧЕСКИЕ ПРАВИЛА:\n' +
      `Сегодня ${today}. Система сама резолвит названия в ID. Тебе нужно собрать:\n` +
      '1. departureCity — город вылета. ВСЕГДА СПРАШИВАЙ если не знаешь. Не подставляй дефолты молча.\n' +
      '2. country/resort/destinationMode — куда. destinationMode: "visa_free"|"any"|"specific".\n' +
      '3. Даты: dateFrom и dateTo (YYYY-MM-DD). СПРАШИВАЙ если не указаны. Если "скоро"/"ближайшие" — уточни конкретнее.\n' +
      '4. Ночи: nightsFrom, nightsTo. СПРАШИВАЙ если не указаны.\n' +
      '5. adults — количество взрослых. СПРАШИВАЙ если не указано.\n\n' +

      'СЦЕНАРИИ:\n' +
      '- "горящие туры" / "что есть?" → intent: "hot". Уточни город вылета если не знаешь.\n' +
      '- "мониторь" / "следи" / "сообщи когда" → intent: "monitor". Собери параметры как для поиска.\n' +
      '- "без визы" / "любая страна" → destinationMode: "visa_free" или "any".\n' +
      '- "не знаю куда" / "удиви" → предложи 2-3 направления из горящих/сезонных.\n' +
      '- Конкретный запрос → собери все данные.\n\n' +

      'ГОТОВНОСТЬ К ПОИСКУ:\n' +
      'readyToSearch: true ТОЛЬКО когда есть ВСЕ обязательные параметры:\n' +
      '- departureCity (город вылета)\n' +
      '- country ИЛИ resort ИЛИ destinationMode\n' +
      '- dateFrom + dateTo ИЛИ nightsFrom + nightsTo\n' +
      '- adults (количество взрослых)\n' +
      'Если не хватает ЛЮБОГО — readyToSearch: false, в clarificationMessage задай ОДИН вопрос.\n\n';

    if (memoryContext?.userFacts?.length) {
      prompt +=
        'ЧТО ТЫ ЗНАЕШЬ О ПОЛЬЗОВАТЕЛЕ (из памяти):\n' +
        memoryContext.userFacts.map((f, i) => `${i + 1}. ${f}`).join('\n') + '\n' +
        'Если знаешь город вылета — уточни: "В прошлый раз летели из X, верно?". Не подставляй молча!\n' +
        'Если знаешь семью — уточни: "Снова вдвоём?" или "С детками?"\n\n';
    }

    if (dialogContext?.parsed && Object.keys(dialogContext.parsed).length > 0) {
      prompt +=
        'УЖЕ СОБРАНО В ДИАЛОГЕ:\n' +
        JSON.stringify(dialogContext.parsed, null, 2) + '\n' +
        'Объедини с новым сообщением. Не теряй собранные поля.\n\n';
    }

    if (memoryContext?.userDefaults && Object.keys(memoryContext.userDefaults).length > 0) {
      prompt +=
        'ПРОШЛЫЕ ПОИСКИ ЮЗЕРА (для справки):\n' +
        JSON.stringify(memoryContext.userDefaults, null, 2) + '\n' +
        'Используй при "всё как в прошлый раз" / "те же даты" / "так же". Подставляй эти значения в parsed.\n\n';
    }

    if (memoryContext?.lastParsed && Object.keys(memoryContext.lastParsed).length > 0) {
      prompt +=
        'ПОСЛЕДНИЙ УСПЕШНЫЙ ПОИСК (полный parsed):\n' +
        JSON.stringify(memoryContext.lastParsed, null, 2) + '\n' +
        'Если юзер говорит "как в прошлый раз", "те же даты", "всё так же" — используй эти данные для parsed.\n\n';
    }

    if (memoryContext?.userPreferences?.length) {
      prompt +=
        'ПРЕДПОЧТЕНИЯ:\n' +
        memoryContext.userPreferences.map((p, i) => `${i + 1}. ${p}`).join('\n') + '\n' +
        'Учитывай как подсказку для рекомендаций.\n\n';
    }

    if (memoryContext?.relevantKnowledge?.length) {
      prompt +=
        'СПРАВКА (актуальные данные):\n' +
        memoryContext.relevantKnowledge.map((k, i) => `${i + 1}. ${k}`).join('\n') + '\n' +
        'Используй для рекомендаций.\n\n';
    }

    prompt +=
      'ФОРМАТ ОТВЕТА — строго JSON без комментариев:\n' +
      '{"readyToSearch": boolean, "intent": "search"|"monitor"|"hot"|"chat", "clarificationMessage": "живой текст или null", "parsed": {' +
      'departureCity, country, resort, destinationMode, hotelCategory, mealType, adults, children, childrenAges, ' +
      'dateFrom, dateTo, nightsFrom, nightsTo, budgetMin, budgetMax, currency, preferences}}';

    return prompt;
  }
}
