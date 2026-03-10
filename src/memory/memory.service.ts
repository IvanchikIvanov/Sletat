import { Injectable, Logger } from '@nestjs/common';
import { FactExtractorService } from './fact-extractor.service';
import { UserPreferencesService } from '../preferences/user-preferences.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { SletatService } from '../sletat/sletat.service';
import { MemoryContext } from './dto/memory-context.dto';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly factExtractor: FactExtractorService,
    private readonly preferences: UserPreferencesService,
    private readonly knowledge: KnowledgeService,
    private readonly sletat: SletatService,
  ) {}

  async getContextForQuery(userId: string, query: string): Promise<MemoryContext> {
    const [userFacts, userPreferences, relevantKnowledge] = await Promise.all([
      this.factExtractor.getUserFacts(userId, query),
      this.preferences.findRelevantPreferences(userId, query),
      this.knowledge.findRelevantKnowledge(query),
    ]);

    return { userFacts, userPreferences, relevantKnowledge };
  }

  async extractFactsFromMessage(userId: string, message: string): Promise<void> {
    return this.factExtractor.extractAndSaveFacts(userId, message);
  }

  async saveSearchPreference(userId: string, parsed: ParsedTourRequest): Promise<void> {
    return this.preferences.savePreferenceFromSearch(userId, parsed);
  }

  async getUserCountry(userId: string): Promise<string | null> {
    return this.factExtractor.getUserFactByKey(userId, 'country_of_origin');
  }

  /**
   * Get visa-free countries, cross-referenced with Sletat availability.
   * 1. Check Knowledge base for cached visa-free list matching user's citizenship
   * 2. Fallback to existing web search / static list
   * 3. Filter by countries actually available in Sletat
   */
  async getVisaFreeCountries(
    departureCity: string,
    userCountry?: string | null,
  ): Promise<string[]> {
    const citizenship = userCountry ?? 'Россия';

    const cached = await this.knowledge.findKnowledgeBySubcategory(
      'countries',
      'visa_free',
      citizenship,
    );

    let visaFreeNames: string[];

    if (cached.length > 0) {
      visaFreeNames = this.parseCountryList(cached[0]);
      this.logger.debug(`Found cached visa-free list for ${citizenship}: ${visaFreeNames.length} countries`);
    } else {
      visaFreeNames = await this.knowledge.getVisaFreeCountriesForDeparture(departureCity);
      this.logger.debug(`Loaded visa-free via fallback for ${departureCity}: ${visaFreeNames.length} countries`);
    }

    try {
      const sletatCountries = await this.sletat.getCountries();
      const sletatNames = new Set(sletatCountries.map((c) => c.name.toLowerCase()));

      const available = visaFreeNames.filter((name) => sletatNames.has(name.toLowerCase()));

      if (available.length > 0) {
        this.logger.debug(`Filtered to ${available.length} countries available in Sletat`);
        return available;
      }
    } catch (error) {
      this.logger.warn('Could not cross-reference with Sletat countries, returning full list', error);
    }

    return visaFreeNames;
  }

  private parseCountryList(text: string): string[] {
    const colonIdx = text.indexOf(':');
    if (colonIdx === -1) return [];
    const listPart = text.slice(colonIdx + 1).trim();
    return listPart
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
