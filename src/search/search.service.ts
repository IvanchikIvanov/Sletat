import { Injectable } from '@nestjs/common';
import { SearchProfileRepository } from '../persistence/repositories/search-profile.repository';
import { SearchRequestRepository } from '../persistence/repositories/search-request.repository';
import { SearchResultRepository } from '../persistence/repositories/search-result.repository';
import { SletatService } from '../sletat/sletat.service';
import { SearchContext, SearchFromTextResult } from './dto/search-request.dto';
import { SletatNormalizedRequest, SletatSearchOffer } from '../sletat/sletat.types';

const MAX_VISA_FREE_COUNTRIES_TO_SEARCH = 5;

@Injectable()
export class SearchService {
  constructor(
    private readonly profiles: SearchProfileRepository,
    private readonly requests: SearchRequestRepository,
    private readonly results: SearchResultRepository,
    private readonly sletat: SletatService,
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

    const offers = await this.sletat.searchTours(normalized);

    if (!offers.length) {
      await this.requests.markFailed(request.id, 'No offers found');
      return {
        profileId: profile.id,
        profileName: profile.name,
        offers: [],
      };
    }

    await this.requests.markSuccess(request.id, context.parsed);

    const dbResults = await this.results.createManyForProfile(
      profile.id,
      offers.map((o) => ({
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
      })),
    );

    return {
      profileId: profile.id,
      profileName: profile.name,
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

  /**
   * Поиск по нескольким странам (для visa-free: страны без визы).
   */
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
      const req: SletatNormalizedRequest = {
        ...baseNormalized,
        countryId,
      };
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
      allOffers.map((o) => ({
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
      })),
    );

    return {
      profileId: profile.id,
      profileName: profile.name,
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
    if (!offers.length) {
      return [];
    }

    const dbResults = await this.results.createManyForProfile(
      profileId,
      offers.map((o) => ({
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
      })),
    );

    return dbResults;
  }
}

