import { Injectable, Logger } from '@nestjs/common';
import { SearchProfileRepository } from '../persistence/repositories/search-profile.repository';
import { SearchRequestRepository } from '../persistence/repositories/search-request.repository';
import { SearchResultRepository } from '../persistence/repositories/search-result.repository';
import { CacheRepository } from '../persistence/repositories/cache.repository';
import { SletatService } from '../sletat/sletat.service';
import { SearchContext, SearchFromTextResult } from './dto/search-request.dto';
import { SletatNormalizedRequest, SletatSearchOffer } from '../sletat/sletat.types';

const MAX_VISA_FREE_COUNTRIES_TO_SEARCH = 5;
const HOT_DEAL_MAX_AGE_MS = 2 * 60 * 60 * 1000;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    private readonly profiles: SearchProfileRepository,
    private readonly requests: SearchRequestRepository,
    private readonly results: SearchResultRepository,
    private readonly sletat: SletatService,
    private readonly cache: CacheRepository,
  ) {}

  async searchFromParsed(context: SearchContext): Promise<SearchFromTextResult> {
    const normalized: SletatNormalizedRequest = await this.sletat.normalizeRequest(
      context.parsed,
    );

    const profileName =
      context.parsed.country ??
      context.parsed.resort ??
      `Профиль от ${new Date().toISOString()}`;

    const profile = await this.profiles.upsertForUser({
      userId: context.userId,
      name: profileName,
      departureCityCode: normalized.departureCityId,
      countryCode: normalized.countryId,
      resortCode: normalized.resortId,
      hotelCategory: normalized.hotelCategory ?? undefined,
      mealCode: normalized.mealId,
      adults: normalized.adults,
      children: normalized.children,
      childrenAges: normalized.childrenAges,
      dateFrom: normalized.dateFrom ? new Date(normalized.dateFrom) : undefined,
      dateTo: normalized.dateTo ? new Date(normalized.dateTo) : undefined,
      nightsFrom: normalized.nightsFrom ?? undefined,
      nightsTo: normalized.nightsTo ?? undefined,
      budgetMin: normalized.budgetMin ?? undefined,
      budgetMax: normalized.budgetMax ?? undefined,
      currency: normalized.currency ?? undefined,
    });

    const request = await this.requests.createPending({
      userId: context.userId,
      profileId: profile.id,
      rawText: context.rawText,
      parsedJson: context.parsed,
    });

    // Шаг 1: Проверяем горящие туры из БД (если запрос подходит)
    const hotDealsOffers = await this.tryHotDealsFromDb(normalized);
    if (hotDealsOffers.length > 0) {
      this.logger.debug(`Found ${hotDealsOffers.length} hot deals from DB cache`);
      await this.requests.markSuccess(request.id, context.parsed);
      const dbResults = await this.results.createManyForProfile(
        profile.id,
        hotDealsOffers.map((o) => this.offerToDbRow(o)),
      );
      return this.buildResult(profile.id, profile.name, dbResults);
    }

    // Шаг 2: Поиск через API Sletat
    const offers = await this.sletat.searchTours(normalized);

    if (!offers.length) {
      await this.requests.markFailed(request.id, 'No offers found');
      return { profileId: profile.id, profileName: profile.name, offers: [] };
    }

    await this.requests.markSuccess(request.id, context.parsed);

    const dbResults = await this.results.createManyForProfile(
      profile.id,
      offers.map((o) => this.offerToDbRow(o)),
    );

    return this.buildResult(profile.id, profile.name, dbResults);
  }

  /**
   * Проверяем, можно ли ответить из кэша горящих туров.
   * Подходит если: есть countryId, данные свежие, и нет жёстких фильтров по отелю/курорту.
   */
  private async tryHotDealsFromDb(normalized: SletatNormalizedRequest): Promise<SletatSearchOffer[]> {
    if (!normalized.countryId) return [];

    const townFromId = normalized.departureCityId ? Number(normalized.departureCityId) : 832;
    const isStale = await this.cache.isStale('hotDeal', HOT_DEAL_MAX_AGE_MS, String(townFromId));
    if (isStale) return [];

    const deals = await this.cache.getHotDealsForCountry(normalized.countryId, townFromId);
    if (!deals.length) return [];

    let filtered = deals;

    if (normalized.budgetMax) {
      filtered = filtered.filter((d) => d.minPrice <= normalized.budgetMax!);
    }
    if (normalized.nightsFrom) {
      filtered = filtered.filter((d) => !d.nights || d.nights >= normalized.nightsFrom!);
    }
    if (normalized.nightsTo) {
      filtered = filtered.filter((d) => !d.nights || d.nights <= normalized.nightsTo!);
    }

    if (!filtered.length) return [];

    return filtered.slice(0, 10).map((d) => ({
      externalOfferId: d.offerId ?? `hot-${d.id}`,
      hotelName: d.hotelName ?? '',
      countryName: d.countryName,
      resortName: d.resortName ?? '',
      mealName: d.mealName ?? '',
      roomName: '',
      departureCity: '',
      dateFrom: d.minPriceDate ?? '',
      dateTo: '',
      nights: d.nights ?? 0,
      price: d.minPrice,
      currency: d.currency,
    }));
  }

  async searchFromParsedWithCountries(
    context: SearchContext,
    countryNames: string[],
  ): Promise<SearchFromTextResult> {
    const baseNormalized = await this.sletat.normalizeRequest(context.parsed);
    const townFromId = baseNormalized.departureCityId
      ? Number(baseNormalized.departureCityId)
      : 832;

    const countryIds = await this.sletat.getCountryIdsByNames(
      countryNames.slice(0, MAX_VISA_FREE_COUNTRIES_TO_SEARCH),
      townFromId,
    );

    if (!countryIds.length) {
      return {
        profileId: '',
        profileName: `Страны без визы из ${context.parsed.departureCity ?? 'РФ'}`,
        offers: [],
      };
    }

    const allOffers: SletatSearchOffer[] = [];
    const seenIds = new Set<string>();

    for (const countryId of countryIds) {
      const req: SletatNormalizedRequest = { ...baseNormalized, countryId };
      const offers = await this.sletat.searchTours(req);
      for (const o of offers) {
        if (!seenIds.has(o.externalOfferId)) {
          seenIds.add(o.externalOfferId);
          allOffers.push(o);
        }
      }
    }

    allOffers.sort((a, b) => a.price - b.price);

    const profileName = `Страны без визы из ${context.parsed.departureCity ?? 'РФ'}`;
    const profile = await this.profiles.upsertForUser({
      userId: context.userId,
      name: profileName,
      departureCityCode: baseNormalized.departureCityId ?? undefined,
      countryCode: countryIds[0],
      resortCode: undefined,
      hotelCategory: baseNormalized.hotelCategory ?? undefined,
      mealCode: baseNormalized.mealId,
      adults: baseNormalized.adults,
      children: baseNormalized.children,
      childrenAges: baseNormalized.childrenAges,
      dateFrom: baseNormalized.dateFrom ? new Date(baseNormalized.dateFrom) : undefined,
      dateTo: baseNormalized.dateTo ? new Date(baseNormalized.dateTo) : undefined,
      nightsFrom: baseNormalized.nightsFrom ?? undefined,
      nightsTo: baseNormalized.nightsTo ?? undefined,
      budgetMin: baseNormalized.budgetMin ?? undefined,
      budgetMax: baseNormalized.budgetMax ?? undefined,
      currency: baseNormalized.currency ?? undefined,
    });

    const request = await this.requests.createPending({
      userId: context.userId,
      profileId: profile.id,
      rawText: context.rawText,
      parsedJson: { ...context.parsed, destinationMode: 'visa_free' },
    });

    if (!allOffers.length) {
      await this.requests.markFailed(request.id, 'No offers found');
      return { profileId: profile.id, profileName: profile.name, offers: [] };
    }

    await this.requests.markSuccess(request.id, context.parsed);

    const dbResults = await this.results.createManyForProfile(
      profile.id,
      allOffers.map((o) => this.offerToDbRow(o)),
    );

    return this.buildResult(profile.id, profile.name, dbResults);
  }

  /**
   * Актуализация тура: проверяет через API Sletat, актуален ли оффер.
   * Возвращает обновлённый оффер или null если тур больше недоступен.
   */
  async actualizeOffer(externalOfferId: string): Promise<SletatSearchOffer | null> {
    const result = await this.sletat.actualizeOffer(externalOfferId);
    if (result) {
      await this.results.updatePrice(externalOfferId, result.price, result.currency);
    }
    return result;
  }

  async searchForProfile(profileId: string) {
    const profile = await this.profiles.findById(profileId);
    if (!profile) {
      throw new Error('Search profile not found');
    }

    const normalized: SletatNormalizedRequest = {
      departureCityId: profile.departureCityCode ?? undefined,
      countryId: profile.countryCode ?? undefined,
      resortId: profile.resortCode ?? undefined,
      mealId: profile.mealCode ?? undefined,
      hotelCategory: profile.hotelCategory ?? undefined,
      adults: profile.adults ?? 2,
      children: profile.children ?? 0,
      childrenAges: (profile.childrenAges as any) ?? undefined,
      dateFrom: profile.dateFrom?.toISOString(),
      dateTo: profile.dateTo?.toISOString(),
      nightsFrom: profile.nightsFrom ?? undefined,
      nightsTo: profile.nightsTo ?? undefined,
      budgetMin: profile.budgetMin ?? undefined,
      budgetMax: profile.budgetMax ?? undefined,
      currency: profile.currency ?? undefined,
    };

    const offers = await this.sletat.searchTours(normalized);
    if (!offers.length) return [];

    const dbResults = await this.results.createManyForProfile(
      profileId,
      offers.map((o) => this.offerToDbRow(o)),
    );

    return dbResults;
  }

  private offerToDbRow(o: SletatSearchOffer) {
    return {
      externalOfferId: o.externalOfferId,
      hotelName: o.hotelName ?? null,
      countryName: o.countryName ?? null,
      resortName: o.resortName ?? null,
      mealName: o.mealName ?? null,
      roomName: o.roomName ?? null,
      departureCity: o.departureCity ?? null,
      dateFrom: o.dateFrom ? new Date(o.dateFrom) : null,
      dateTo: o.dateTo ? new Date(o.dateTo) : null,
      nights: o.nights ?? null,
      price: o.price,
      currency: o.currency,
    };
  }

  private buildResult(profileId: string, profileName: string, dbResults: any[]): SearchFromTextResult {
    return {
      profileId,
      profileName,
      offers: dbResults.map((r) => ({
        id: r.id,
        hotelName: r.hotelName,
        countryName: r.countryName,
        resortName: r.resortName,
        mealName: r.mealName,
        dateFrom: r.dateFrom,
        dateTo: r.dateTo,
        nights: r.nights,
        price: r.price,
        currency: r.currency,
        externalOfferId: r.externalOfferId,
      })),
    };
  }
}
