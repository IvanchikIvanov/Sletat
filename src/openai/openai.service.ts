import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { AppConfigService } from '../config/config.service';
import { ParsedTourRequest } from './dto/tour-request.schema';
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

  async parseTourRequest(text: string): Promise<ParsedTourRequest> {
    const systemPrompt =
      'Ты помощник турагента. Твоя задача — разобрать запрос пользователя о туре и вернуть строгий JSON без лишних полей. ' +
      'Не добавляй никаких комментариев, только JSON. Поля: ' +
      'departureCity, country, resort, hotelCategory, mealType, adults, children, childrenAges, dateFrom, dateTo, ' +
      'nightsFrom, nightsTo, budgetMin, budgetMax, currency, preferences.';

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

      const parsed = JSON.parse(content) as Partial<ParsedTourRequest>;
      return parsed;
    } catch (error) {
      this.logger.error('Failed to parse tour request', error as Error);
      throw error;
    }
  }
}

