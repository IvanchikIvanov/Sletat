import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SletatClient } from './sletat.client';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';
import { SletatNormalizedRequest, SletatOrderTourist, SletatSearchOffer, SletatDictionaryItem, SletatHotelItem, SletatShowcaseItem } from './sletat.types';
import { CacheRepository } from '../persistence/repositories/cache.repository';
import { REDIS_CLIENT } from '../persistence/redis.provider';
import type Redis from 'ioredis';

const CACHE_TTL_SECONDS = 60 * 60;

@Injectable()
export class SletatService implements OnModuleInit {
  private readonly logger = new Logger(SletatService.name);

  constructor(
    @Inject('SLETAT_CLIENT') private readonly client: SletatClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly cache: CacheRepository,
  ) {}

  async onModuleInit() {
    this.preloadDictionaries().catch((err) =>
      this.logger.warn(`Failed to preload dictionaries: ${err.message}`),
    );
  }

  private async preloadDictionaries() {
    this.logger.log('Preloading Sletat dictionaries into cache...');
    const [departures] = await Promise.all([
      this.getDepartureCities(),
      this.getMeals(),
      this.getShowcaseReview(832),
    ]);
    if (departures.length) {
      const popularIds = [832, 1264, 1265];
      await Promise.all(
        popularIds.map((id) => this.getCountriesForCity(id).catch(() => [])),
      );
    }
    this.logger.log(`Preloaded ${departures.length} departure cities + countries + showcase`);
  }

  // ─── Справочники (Redis-кэш + API) ───

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

  async getCities(countryId: number): Promise<SletatDictionaryItem[]> {
    return this.getCached(`sletat:cities:${countryId}`, () => this.client.loadCities(countryId));
  }

  async getHotels(countryId: number): Promise<SletatHotelItem[]> {
    return this.getCached(`sletat:hotels:${countryId}`, () => this.client.loadHotels(countryId));
  }

  async getHotelStars(countryId: number): Promise<SletatDictionaryItem[]> {
    return this.getCached(`sletat:stars:${countryId}`, () => this.client.loadHotelStars(countryId));
  }

  async getTemplates(templatesList = 'shared', type = 0): Promise<Array<{ id: number; name: string; departureCity: string }>> {
    return this.client.loadTemplates(templatesList, type);
  }

  async getShowcaseReview(townFromId = 832, currencyAlias = 'RUB', templateName?: string): Promise<SletatShowcaseItem[]> {
    const cacheKey = `sletat:showcase:${townFromId}:${currencyAlias}:${templateName ?? 'default'}`;
    return this.getCached(
      cacheKey,
      () => this.client.loadShowcaseReview(townFromId, currencyAlias, templateName),
    );
  }

  async getCountriesForShowcase(townFromId: number, templateName?: string): Promise<SletatDictionaryItem[]> {
    return this.client.loadCountriesForShowcase(townFromId, templateName);
  }

  // ─── Горящие туры (из БД) ───

  async getHotDealsFromDb(townFromId = 832) {
    return this.cache.getHotDeals(townFromId);
  }

  async getHotDealsForCountryFromDb(countryId: string, townFromId = 832) {
    return this.cache.getHotDealsForCountry(countryId, townFromId);
  }

  async getHotDealsForCountry(
    countryName: string,
    departureCityName?: string,
  ): Promise<SletatShowcaseItem[]> {
    const departures = await this.getDepartureCities();
    const depId = departureCityName
      ? this.findDictionaryId(departures, departureCityName)
      : undefined;
    const townFromId = depId ? Number(depId) : 832;

    const showcase = await this.getShowcaseReview(townFromId);
    const lower = countryName.trim().toLowerCase();
    return showcase.filter(
      (item) => item.countryName.toLowerCase().includes(lower) || lower.includes(item.countryName.toLowerCase()),
    );
  }

  async getHotDealsAll(departureCityName?: string): Promise<SletatShowcaseItem[]> {
    const departures = await this.getDepartureCities();
    const depId = departureCityName
      ? this.findDictionaryId(departures, departureCityName)
      : undefined;
    const townFromId = depId ? Number(depId) : 832;
    return this.getShowcaseReview(townFromId);
  }

  // ─── Поиск по БД-кэшу ───

  async findCountryInDb(name: string) {
    let found = await this.cache.findCountryByName(name);
    if (found) return found;
    const lower = name.trim().toLowerCase();
    const aliases: Record<string, string> = {
      тай: 'Таиланд',
      тайланд: 'Таиланд',
      турция: 'Турция',
      египет: 'Египет',
      вьетнам: 'Вьетнам',
    };
    const canonical = aliases[lower] ?? aliases[lower.replace(/и$/, '')];
    if (canonical) return this.cache.findCountryByName(canonical);
    return null;
  }

  async findResortInDb(name: string, countryId: string) {
    return this.cache.findResortByName(name, countryId);
  }

  async findHotelInDb(name: string, countryId?: string) {
    return this.cache.findHotelByName(name, countryId);
  }

  async findDepartureCityInDb(name: string) {
    return this.cache.findDepartureCityByName(name);
  }

  async getResortsFromDb(countryId: string) {
    return this.cache.getResorts(countryId);
  }

  async getHotelsFromDb(countryId: string, opts?: { starName?: string; resortId?: string }) {
    return this.cache.getHotels(countryId, opts);
  }

  async getDbFreshness(table: 'country' | 'resort' | 'hotel' | 'hotDeal' | 'meal' | 'departureCity', maxAgeMs: number, key?: string) {
    return this.cache.isStale(table, maxAgeMs, key);
  }

  // ─── Нормализация запроса ───

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

  async normalizeRequest(parsed: ParsedTourRequest): Promise<SletatNormalizedRequest> {
    const [departures, meals] = await Promise.all([
      this.getDepartureCities(),
      this.getMeals(),
    ]);

    const departureCityId = this.findDictionaryId(departures, parsed.departureCity);
    const townFromId = departureCityId ? Number(departureCityId) : 832;
    const countries = await this.getCountriesForCity(townFromId);

    this.logger.debug(`normalizeRequest: departures=${departures.length}, countries=${countries.length}, ` +
      `parsed.country="${parsed.country}", parsed.resort="${parsed.resort}"`);

    let countryId = this.findDictionaryId(countries, parsed.country ?? parsed.resort);

    if (!countryId && (parsed.country || parsed.resort)) {
      const dbCountry = await this.findCountryInDb(parsed.country ?? parsed.resort ?? '');
      if (dbCountry) {
        countryId = dbCountry.id;
        this.logger.debug(`Found country in DB cache: ${dbCountry.name} (id=${dbCountry.id})`);
      }
    }

    if (!countryId && (parsed.country || parsed.resort)) {
      this.logger.warn(`Could not resolve country: "${parsed.country ?? parsed.resort}" ` +
        `from ${countries.length} countries (townFromId=${townFromId})`);
    }

    let resortId: string | undefined;
    if (countryId && parsed.resort) {
      const cachedResort = await this.findResortInDb(parsed.resort, countryId);
      if (cachedResort) {
        resortId = cachedResort.id;
      } else {
        try {
          const resorts = await this.getCities(Number(countryId));
          resortId = this.findDictionaryId(resorts, parsed.resort);
        } catch {
          this.logger.warn(`Failed to load resorts for country ${countryId}`);
        }
      }
    }

    return {
      departureCityId,
      countryId,
      resortId,
      mealId: this.findDictionaryId(meals, parsed.mealType),
      hotelCategory: parsed.hotelCategory,
      adults: this.toInt(parsed.adults, 2),
      children: this.toInt(parsed.children, 0),
      childrenAges: parsed.childrenAges?.map(Number),
      dateFrom: parsed.dateFrom ?? undefined,
      dateTo: parsed.dateTo ?? undefined,
      nightsFrom: this.toIntOrUndef(parsed.nightsFrom),
      nightsTo: this.toIntOrUndef(parsed.nightsTo),
      budgetMin: this.toIntOrUndef(parsed.budgetMin),
      budgetMax: this.toIntOrUndef(parsed.budgetMax),
      currency: parsed.currency ?? 'RUB',
    };
  }

  async searchTours(request: SletatNormalizedRequest): Promise<SletatSearchOffer[]> {
    return this.client.searchTours(request);
  }

  async searchToursBulk(request: SletatNormalizedRequest, opts?: { pageSize?: number }): Promise<SletatSearchOffer[]> {
    return this.client.searchToursBulk(request, opts);
  }

  async searchHotToursBulk(params: { cityFromId: number; countryId: number; templateName: string; pageSize?: number }): Promise<SletatSearchOffer[]> {
    return this.client.searchHotToursBulk(params);
  }

  async actualizeOffer(params: {
    offerId: string;
    sourceId: string;
    requestId?: string;
  }): Promise<SletatSearchOffer | null> {
    return this.client.actualizeOffer(params);
  }

  async createClaim(offer: SletatSearchOffer, tourist: SletatOrderTourist) {
    return this.client.createClaim(offer, tourist);
  }

  async getClaimInfo(claimId: string) {
    return this.client.getClaimInfo(claimId);
  }

  async getPayments(claimId: string) {
    return this.client.getPayments(claimId);
  }

  private toInt(value: unknown, fallback: number): number {
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
  }

  private toIntOrUndef(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  }

  private async getCached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
    const value = await loader();
    const isEmpty = Array.isArray(value) && value.length === 0;
    if (!isEmpty) {
      await this.redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
    }
    return value;
  }
}
