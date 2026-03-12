import { Injectable, Logger } from '@nestjs/common';
import { FactExtractorService } from './fact-extractor.service';
import { UserPreferencesService } from '../preferences/user-preferences.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { SletatService } from '../sletat/sletat.service';
import { SearchProfileRepository } from '../persistence/repositories/search-profile.repository';
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
    private readonly profiles: SearchProfileRepository,
  ) {}

  async getContextForQuery(userId: string, query: string): Promise<MemoryContext> {
    const [userFacts, userPreferences, relevantKnowledge, userDefaults] = await Promise.all([
      this.factExtractor.getUserFacts(userId, query),
      this.preferences.findRelevantPreferences(userId, query),
      this.knowledge.findRelevantKnowledge(query),
      this.getUserDefaults(userId),
    ]);

    return { userFacts, userPreferences, relevantKnowledge, userDefaults };
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
   * Получить дефолтные параметры из последнего профиля поиска.
   * Используется для подстановки в промпт OpenAI, чтобы не переспрашивать.
   */
  async getUserDefaults(userId: string): Promise<Record<string, string> | null> {
    const profile = await this.profiles.findLatestByUser(userId);
    if (!profile) return null;

    const defaults: Record<string, string> = {};
    if (profile.departureCityCode) defaults.departureCityCode = profile.departureCityCode;
    if (profile.countryCode) defaults.lastCountryCode = profile.countryCode;
    if (profile.mealCode) defaults.lastMealCode = profile.mealCode;
    if (profile.hotelCategory) defaults.lastHotelCategory = profile.hotelCategory;
    if (profile.adults) defaults.lastAdults = String(profile.adults);
    if (profile.children) defaults.lastChildren = String(profile.children);
    if (profile.name) defaults.lastProfileName = profile.name;

    return Object.keys(defaults).length > 0 ? defaults : null;
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
