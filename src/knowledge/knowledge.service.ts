import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { PrismaService } from '../persistence/prisma.service';
import { AppConfigService } from '../config/config.service';
import { WebSearchService } from './web-search.service';

interface KnowledgeRow {
  id: string;
  text: string;
  similarity: number;
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private readonly openai: OpenAI;
  private readonly embeddingModel: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly webSearch: WebSearchService,
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

  /**
   * Получить страны без визы для вылета из указанного города.
   * Сохраняет результат в базу знаний.
   */
  async getVisaFreeCountriesForDeparture(departureCity: string): Promise<string[]> {
    const countries = await this.webSearch.getVisaFreeCountries(departureCity);

    const text = `Страны без визы для россиян при вылете из ${departureCity}: ${countries.join(', ')}`;
    await this.saveKnowledgeExtended({
      text,
      category: 'countries',
      subcategory: 'visa_free',
      source: 'web',
      metadata: { departureCity, countries },
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    return countries;
  }

  async saveKnowledge(
    text: string,
    category: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.saveKnowledgeExtended({ text, category, source: 'web', metadata });
  }

  async saveKnowledgeExtended(params: {
    text: string;
    category: string;
    subcategory?: string;
    source?: string;
    sourceUrl?: string;
    metadata?: Record<string, unknown>;
    expiresAt?: Date;
  }): Promise<void> {
    try {
      const embedding = await this.generateEmbedding(params.text);
      const vectorLiteral = `[${embedding.join(',')}]`;

      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "Knowledge" ("id", "text", "embedding", "category", "subcategory", "source", "sourceUrl", "metadata", "expiresAt", "createdAt", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2::vector, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())`,
        params.text,
        vectorLiteral,
        params.category,
        params.subcategory ?? null,
        params.source ?? 'web',
        params.sourceUrl ?? null,
        params.metadata ? JSON.stringify(params.metadata) : '{}',
        params.expiresAt ?? null,
      );

      this.logger.debug(`Saved knowledge: ${params.category}/${params.subcategory ?? '-'}`);
    } catch (error) {
      this.logger.warn('Failed to save knowledge (non-critical)', error);
    }
  }

  async findKnowledgeBySubcategory(
    category: string,
    subcategory: string,
    searchText?: string,
    limit = 5,
  ): Promise<string[]> {
    try {
      if (searchText) {
        const embedding = await this.generateEmbedding(searchText);
        const vectorLiteral = `[${embedding.join(',')}]`;

        const rows = await this.prisma.$queryRawUnsafe<KnowledgeRow[]>(
          `SELECT "id", "text", 1 - ("embedding" <=> $1::vector) AS similarity
           FROM "Knowledge"
           WHERE "category" = $2 AND "subcategory" = $3
             AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
           ORDER BY "embedding" <=> $1::vector
           LIMIT $4`,
          vectorLiteral,
          category,
          subcategory,
          limit,
        );

        return rows.filter((r) => r.similarity > 0.3).map((r) => r.text);
      }

      const rows = await this.prisma.$queryRawUnsafe<{ text: string }[]>(
        `SELECT "text" FROM "Knowledge"
         WHERE "category" = $1 AND "subcategory" = $2
           AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
         ORDER BY "createdAt" DESC
         LIMIT $3`,
        category,
        subcategory,
        limit,
      );

      return rows.map((r) => r.text);
    } catch (error) {
      this.logger.warn('Failed to find knowledge by subcategory (non-critical)', error);
      return [];
    }
  }

  async cleanupExpired(): Promise<number> {
    try {
      const result = await this.prisma.$executeRawUnsafe(
        `DELETE FROM "Knowledge" WHERE "expiresAt" IS NOT NULL AND "expiresAt" < NOW()`,
      );
      this.logger.log(`Cleaned up ${result} expired knowledge entries`);
      return result;
    } catch (error) {
      this.logger.warn('Failed to cleanup expired knowledge', error);
      return 0;
    }
  }

  /**
   * Найти релевантные знания по запросу (семантический поиск).
   */
  async findRelevantKnowledge(
    query: string,
    category?: string,
    limit = 5,
  ): Promise<string[]> {
    try {
      const embedding = await this.generateEmbedding(query);
      const vectorLiteral = `[${embedding.join(',')}]`;

      let sql = `SELECT "id", "text", 1 - ("embedding" <=> $1::vector) AS similarity
         FROM "Knowledge"
         WHERE ("expiresAt" IS NULL OR "expiresAt" > NOW())`;
      const params: unknown[] = [vectorLiteral];
      let paramIndex = 2;

      if (category) {
        sql += ` AND "category" = $${paramIndex}`;
        params.push(category);
        paramIndex++;
      }

      sql += ` ORDER BY "embedding" <=> $1::vector LIMIT $${paramIndex}`;
      params.push(limit);

      const rows = await this.prisma.$queryRawUnsafe<KnowledgeRow[]>(sql, ...params);

      return rows
        .filter((r) => r.similarity > 0.3)
        .map((r) => r.text);
    } catch (error) {
      this.logger.warn('Failed to retrieve knowledge (non-critical)', error);
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
}
