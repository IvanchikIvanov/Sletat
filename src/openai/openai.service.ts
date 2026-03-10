import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { AppConfigService } from '../config/config.service';
import { ParseTourResponse } from './dto/tour-request.schema';
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

  async parseTourRequest(text: string): Promise<ParseTourResponse> {
    const systemPrompt =
      'Ты помощник турагента. Разбираешь запрос пользователя о туре.\n\n' +
      'ОБЯЗАТЕЛЬНЫЕ поля для поиска:\n' +
      '- departureCity — город вылета (Москва, Санкт-Петербург и т.д.)\n' +
      '- country — страна (Турция, Египет и т.д.) ИЛИ resort — курорт (Анталья, Хургада)\n\n' +
      'Если хотя бы одно обязательное поле отсутствует или неоднозначно — верни readyToSearch: false ' +
      'и clarificationMessage — короткий дружелюбный вопрос на русском, что уточнить. Пиши естественно, не списком.\n\n' +
      'Если всё понятно — readyToSearch: true, clarificationMessage не указывай.\n\n' +
      'Верни ТОЛЬКО JSON без комментариев:\n' +
      '{"readyToSearch": boolean, "clarificationMessage": "строка или null", "parsed": {' +
      'departureCity, country, resort, hotelCategory, mealType, adults, children, childrenAges, ' +
      'dateFrom, dateTo, nightsFrom, nightsTo, budgetMin, budgetMax, currency, preferences}}';

    try {
      const completion = await this.client.chat.completions.create({
        model: this.config.openAi.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
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
}

