import { Inject, Injectable, Logger } from '@nestjs/common';
import { SletatClient } from './sletat.client';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';
import { SletatNormalizedRequest, SletatSearchOffer, SletatDictionaryItem, SletatShowcaseItem } from './sletat.types';
import { REDIS_CLIENT } from '../persistence/redis.provider';
import type Redis from 'ioredis';

const CACHE_TTL_SECONDS = 60 * 60;

@Injectable()
export class SletatService {
  private readonly logger = new Logger(SletatService.name);

  constructor(
    @Inject('SLETAT_CLIENT') private readonly client: SletatClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async getCountryIdsByNames(
    names: string[],
    townFromId = 832,
  ): Promise<string[]> {
    const countries = await this.getCountriesForCity(townFromId);
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const name of names) {
      const id = this.findDictionaryId(countries, name);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }

    return ids;
  }

  findDictionaryId(items: SletatDictionaryItem[], query?: string | null): string | undefined {
    const value = query?.trim().toLowerCase();
    if (!value) return undefined;
    const exact = items.find((i) => i.name.toLowerCase() === value || i.code.toLowerCase() === value);
    if (exact) return exact.id;
    const partial = items.find((i) => i.name.toLowerCase().includes(value) || value.includes(i.name.toLowerCase()));
    return partial?.id;
  }

  async getDepartureCities(): Promise<SletatDictionaryItem[]> {
    return this.getCached('sletat:departureCities', () => this.client.loadDepartureCities());
  }

  async getCountries(): Promise<SletatDictionaryItem[]> {
    return this.getCached('sletat:countries', () => this.client.loadCountries());
  }

  async getCountriesForCity(townFromId: number): Promise<SletatDictionaryItem[]> {
    return this.getCached(`sletat:countries:${townFromId}`, () => this.client.loadCountries(townFromId));
  }

  async getMeals(): Promise<SletatDictionaryItem[]> {
    return this.getCached('sletat:meals', () => this.client.loadMeals());
  }

  async getHotels(): Promise<SletatDictionaryItem[]> {
    return this.getCached('sletat:hotels', () => this.client.loadHotels());
  }

  async getShowcaseReview(townFromId = 832, currencyAlias = 'RUB'): Promise<SletatShowcaseItem[]> {
    return this.getCached(
      `sletat:showcase:${townFromId}:${currencyAlias}`,
      () => this.client.loadShowcaseReview(townFromId, currencyAlias),
    );
  }

  /**
   * Нормализация запроса с использованием кэшированных словарей.
   * Не дёргает API на каждый запрос — берёт из Redis.
   */
  async normalizeRequest(parsed: ParsedTourRequest): Promise<SletatNormalizedRequest> {
    const [departures, meals] = await Promise.all([
      this.getDepartureCities(),
      this.getMeals(),
    ]);

    const departureCityId = this.findDictionaryId(departures, parsed.departureCity);
    const townFromId = departureCityId ? Number(departureCityId) : 832;
    const countries = await this.getCountriesForCity(townFromId);

    return {
      departureCityId,
      countryId: this.findDictionaryId(countries, parsed.country ?? parsed.resort),
      resortId: undefined,
      mealId: this.findDictionaryId(meals, parsed.mealType),
      hotelCategory: parsed.hotelCategory,
      adults: parsed.adults ?? 2,
      children: parsed.children ?? 0,
      childrenAges: parsed.childrenAges,
      dateFrom: parsed.dateFrom ?? undefined,
      dateTo: parsed.dateTo ?? undefined,
      nightsFrom: parsed.nightsFrom ?? undefined,
      nightsTo: parsed.nightsTo ?? undefined,
      budgetMin: parsed.budgetMin ?? undefined,
      budgetMax: parsed.budgetMax ?? undefined,
      currency: parsed.currency ?? 'RUB',
    };
  }

  async searchTours(request: SletatNormalizedRequest): Promise<SletatSearchOffer[]> {
    return this.client.searchTours(request);
  }

  async actualizeOffer(externalOfferId: string): Promise<SletatSearchOffer | null> {
    return this.client.actualizeOffer(externalOfferId);
  }

  async createClaim(offer: SletatSearchOffer, profileId: string, userId: string) {
    return this.client.createClaim(offer, profileId, userId);
  }

  async getClaimInfo(claimId: string) {
    return this.client.getClaimInfo(claimId);
  }

  async getPayments(claimId: string) {
    return this.client.getPayments(claimId);
  }

  private async getCached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
    const value = await loader();
    await this.redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
    return value;
  }
}

