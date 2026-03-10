import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { PrismaService } from '../persistence/prisma.service';
import { AppConfigService } from '../config/config.service';
import { ExtractedFact } from './dto/user-fact.dto';

const EXTRACTION_PROMPT = `Ты анализируешь сообщение пользователя туристического бота.
Извлеки ТОЛЬКО явные факты о пользователе (не о туре, который он ищет).

Категории:
- personal: страна проживания, город, язык, день рождения, имя
- family: состав семьи, количество детей, возраст детей, семейное положение
- travel: наличие загранпаспорта, визы, любимые/нелюбимые страны, страх перелётов, аллергии
- preferences: предпочитаемый бюджет, тип отдыха (пляж/экскурсии/горы), тип питания, категория отелей

Ключи для дедупликации (key):
- country_of_origin, city_of_origin, birthday, language
- children_count, family_size, marital_status
- passport_type, fear_of_flying, allergies, favorite_countries, disliked_countries
- preferred_budget, preferred_vacation_type, preferred_meal, preferred_hotel_stars

Верни JSON-массив. Если фактов нет — верни [].
Пример: [{"fact": "Пользователь из Казахстана", "category": "personal", "key": "country_of_origin"}]

ВАЖНО: извлекай только то, что пользователь явно сообщил. Не додумывай.`;

interface FactRow {
  id: string;
  fact: string;
  similarity: number;
}

@Injectable()
export class FactExtractorService {
  private readonly logger = new Logger(FactExtractorService.name);
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

  async extractAndSaveFacts(userId: string, message: string): Promise<void> {
    try {
      const facts = await this.extractFacts(message);
      if (!facts.length) return;

      for (const fact of facts) {
        await this.upsertFact(userId, fact);
      }

      this.logger.log(`Extracted ${facts.length} fact(s) for user ${userId}`);
    } catch (error) {
      this.logger.warn('Fact extraction failed (non-critical)', error);
    }
  }

  async getUserFacts(userId: string, query?: string, limit = 10): Promise<string[]> {
    try {
      if (query) {
        return this.getFactsBySimilarity(userId, query, limit);
      }
      return this.getAllFacts(userId, limit);
    } catch (error) {
      this.logger.warn('Failed to retrieve user facts (non-critical)', error);
      return [];
    }
  }

  async getUserFactByKey(userId: string, key: string): Promise<string | null> {
    try {
      const row = await this.prisma.userFact.findUnique({
        where: { userId_key: { userId, key } },
      });
      return row?.fact ?? null;
    } catch (error) {
      this.logger.warn('Failed to retrieve user fact by key (non-critical)', error);
      return null;
    }
  }

  private async extractFacts(message: string): Promise<ExtractedFact[]> {
    const completion = await this.openai.chat.completions.create({
      model: this.config.openAi.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return [];

    const parsed = JSON.parse(content);
    const facts: ExtractedFact[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.facts)
        ? parsed.facts
        : [];

    return facts.filter(
      (f) => f.fact && f.category && f.key,
    );
  }

  private async upsertFact(userId: string, fact: ExtractedFact): Promise<void> {
    const embedding = await this.generateEmbedding(fact.fact);
    const vectorLiteral = `[${embedding.join(',')}]`;

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "UserFact" ("id", "userId", "fact", "category", "key", "embedding", "confidence", "source", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::vector, 1.0, 'dialog', NOW(), NOW())
       ON CONFLICT ("userId", "key")
       DO UPDATE SET "fact" = $2, "category" = $3, "embedding" = $5::vector, "updatedAt" = NOW()`,
      userId,
      fact.fact,
      fact.category,
      fact.key,
      vectorLiteral,
    );
  }

  private async getFactsBySimilarity(
    userId: string,
    query: string,
    limit: number,
  ): Promise<string[]> {
    const embedding = await this.generateEmbedding(query);
    const vectorLiteral = `[${embedding.join(',')}]`;

    const rows = await this.prisma.$queryRawUnsafe<FactRow[]>(
      `SELECT "id", "fact", 1 - ("embedding" <=> $1::vector) AS similarity
       FROM "UserFact"
       WHERE "userId" = $2
       ORDER BY "embedding" <=> $1::vector
       LIMIT $3`,
      vectorLiteral,
      userId,
      limit,
    );

    return rows.filter((r) => r.similarity > 0.2).map((r) => r.fact);
  }

  private async getAllFacts(userId: string, limit: number): Promise<string[]> {
    const rows = await this.prisma.userFact.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: { fact: true },
    });

    return rows.map((r) => r.fact);
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: this.embeddingModel,
      input: text,
    });
    return response.data[0].embedding;
  }
}
