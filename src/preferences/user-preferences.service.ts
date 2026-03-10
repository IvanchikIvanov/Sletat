import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { PrismaService } from '../persistence/prisma.service';
import { AppConfigService } from '../config/config.service';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';

interface PreferenceRow {
  id: string;
  text: string;
  similarity: number;
}

@Injectable()
export class UserPreferencesService {
  private readonly logger = new Logger(UserPreferencesService.name);
  private readonly openai: OpenAI;
  private readonly embeddingModel: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {
    const agent = this.config.openAi.proxyUrl
      ? new HttpsProxyAgent(this.config.openAi.proxyUrl)
      : undefined;

    this.openai = new OpenAI({
      apiKey: this.config.openAi.apiKey,
      ...(agent && { httpAgent: agent, httpsAgent: agent }),
    });

    this.embeddingModel = this.config.embeddingModel;
  }

  async savePreferenceFromSearch(
    userId: string,
    parsed: ParsedTourRequest,
  ): Promise<void> {
    const text = this.buildPreferenceText(parsed);
    if (!text) return;

    try {
      const embedding = await this.generateEmbedding(text);
      const vectorLiteral = `[${embedding.join(',')}]`;

      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "UserPreference" ("id", "userId", "text", "embedding", "category", "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3::vector, 'search', NOW())`,
        userId,
        text,
        vectorLiteral,
      );

      this.logger.log(`Saved preference for user ${userId}`);
    } catch (error) {
      this.logger.warn('Failed to save user preference (non-critical)', error);
    }
  }

  async findRelevantPreferences(
    userId: string,
    queryText: string,
    limit = 5,
  ): Promise<string[]> {
    try {
      const embedding = await this.generateEmbedding(queryText);
      const vectorLiteral = `[${embedding.join(',')}]`;

      const rows = await this.prisma.$queryRawUnsafe<PreferenceRow[]>(
        `SELECT "id", "text", 1 - ("embedding" <=> $1::vector) AS similarity
         FROM "UserPreference"
         WHERE "userId" = $2
         ORDER BY "embedding" <=> $1::vector
         LIMIT $3`,
        vectorLiteral,
        userId,
        limit,
      );

      return rows
        .filter((r) => r.similarity > 0.3)
        .map((r) => r.text);
    } catch (error) {
      this.logger.warn('Failed to retrieve preferences (non-critical)', error);
      return [];
    }
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: this.embeddingModel,
      input: text,
    });
    return response.data[0].embedding;
  }

  private buildPreferenceText(parsed: ParsedTourRequest): string | null {
    const parts: string[] = [];

    if (parsed.departureCity) parts.push(`вылет из ${parsed.departureCity}`);
    if (parsed.country) parts.push(`страна: ${parsed.country}`);
    if (parsed.resort) parts.push(`курорт: ${parsed.resort}`);
    if (parsed.hotelCategory) parts.push(`${parsed.hotelCategory} звёзд`);
    if (parsed.mealType) parts.push(`питание: ${parsed.mealType}`);
    if (parsed.adults) parts.push(`${parsed.adults} взрослых`);
    if (parsed.children && parsed.children > 0) {
      parts.push(`${parsed.children} детей`);
    }
    if (parsed.dateFrom) parts.push(`с ${parsed.dateFrom}`);
    if (parsed.dateTo) parts.push(`по ${parsed.dateTo}`);
    if (parsed.nightsFrom || parsed.nightsTo) {
      parts.push(`${parsed.nightsFrom ?? '?'}–${parsed.nightsTo ?? '?'} ночей`);
    }
    if (parsed.budgetMin || parsed.budgetMax) {
      const cur = parsed.currency ?? 'RUB';
      parts.push(
        `бюджет ${parsed.budgetMin ?? '?'}–${parsed.budgetMax ?? '?'} ${cur}`,
      );
    }
    if (parsed.preferences) parts.push(parsed.preferences);

    if (parts.length === 0) return null;
    return parts.join(', ');
  }
}
