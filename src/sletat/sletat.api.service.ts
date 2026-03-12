import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';
import { SletatClient } from './sletat.client';
import {
  SletatClaimInfo,
  SletatDictionaryItem,
  SletatHotelItem,
  SletatNormalizedRequest,
  SletatSearchOffer,
  SletatShowcaseItem,
} from './sletat.types';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { IncomingMessage } from 'http';

type HttpMethod = 'GET' | 'POST';
type Protocol = 'json' | 'xml';

@Injectable()
export class SletatApiService implements SletatClient {
  private readonly logger = new Logger(SletatApiService.name);

  constructor(private readonly config: AppConfigService) {}

  async loadDepartureCities(): Promise<SletatDictionaryItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_DEPARTURE_CITIES', this.config.sletat.protocol, {});
    const result = this.mapDictionary(payload, ['GetDepartCitiesResult', 'departures', 'departureCities', 'cities', 'DepartCityList']);
    if (!result.length) {
      this.logger.warn(`loadDepartureCities returned 0 items. Payload keys: ${Object.keys(payload).join(', ')}`);
      const topVal = payload.GetDepartCitiesResult ?? payload;
      if (typeof topVal === 'object' && topVal !== null) {
        this.logger.debug(`DepartCities payload: ${JSON.stringify(topVal).slice(0, 500)}`);
      }
    }
    return result;
  }

  async loadCountries(townFromId = 832): Promise<SletatDictionaryItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_COUNTRIES', this.config.sletat.protocol, {
      townFromId,
    });
    const result = this.mapDictionary(payload, ['GetCountriesResult', 'countries', 'CountryList']);
    if (!result.length) {
      this.logger.warn(`loadCountries(${townFromId}) returned 0 items. Payload keys: ${Object.keys(payload).join(', ')}`);
      const topVal = payload.GetCountriesResult ?? payload;
      if (typeof topVal === 'object' && topVal !== null) {
        this.logger.debug(`Payload structure: ${JSON.stringify(topVal).slice(0, 500)}`);
      }
    }
    return result;
  }

  async loadMeals(): Promise<SletatDictionaryItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_MEALS', this.config.sletat.protocol, {});
    return this.mapDictionary(payload, ['GetMealsResult', 'meals', 'foodTypes']);
  }

  async loadHotels(countryId?: number): Promise<SletatHotelItem[]> {
    const params: Record<string, unknown> = {};
    if (countryId) params.countryId = countryId;
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_HOTELS', this.config.sletat.protocol, params);
    return this.mapHotels(payload);
  }

  async loadCities(countryId: number): Promise<SletatDictionaryItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_CITIES', this.config.sletat.protocol, { countryId });
    return this.mapDictionary(payload, ['GetCitiesResult', 'cities', 'resorts']);
  }

  async loadHotelStars(countryId: number): Promise<SletatDictionaryItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_HOTEL_STARS', this.config.sletat.protocol, { countryId });
    return this.mapDictionary(payload, ['GetHotelStarsResult', 'stars', 'hotelStars']);
  }

  async loadShowcaseReview(townFromId = 832, currencyAlias = 'RUB'): Promise<SletatShowcaseItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_SHOWCASE_REVIEW', this.config.sletat.protocol, {
      townFromId,
      currencyAlias,
      countryToursCount: 1,
      showcase: 1,
    });
    return this.mapShowcase(payload);
  }

  async normalizeRequest(parsed: ParsedTourRequest): Promise<SletatNormalizedRequest> {
    const [departures, meals] = await Promise.all([
      this.loadDepartureCities(),
      this.loadMeals(),
    ]);
    const departureCityId = this.findDictionaryId(departures, parsed.departureCity);
    const townFromId = departureCityId ? Number(departureCityId) : 832;
    const countries = await this.loadCountries(townFromId);

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
    const params = this.toSearchParams(request);

    this.logger.debug(`Search params: cityFromId=${params.cityFromId}, countryId=${params.countryId}, ` +
      `dates=${params.s_departFrom}-${params.s_departTo}, nights=${params.s_nightsMin}-${params.s_nightsMax}`);

    const firstPayload = await this.callSearchApi(
      'SLETAT_ENDPOINT_SEARCH',
      this.config.sletat.protocol,
      params,
    );

    let offers = this.mapOffers(firstPayload);
    if (offers.length > 0) {
      this.logger.debug(`Found ${offers.length} offers on first request`);
      return offers;
    }

    const requestId = this.extractRequestId(firstPayload);
    if (!requestId) {
      this.logger.warn('No requestId in GetTours response, cannot poll');
      return offers;
    }

    this.logger.debug(`Polling with requestId=${requestId}`);
    const maxAttempts = 5;
    const pollDelayMs = 3000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.sleep(pollDelayMs);

      const pollPayload = await this.callSearchApi(
        'SLETAT_ENDPOINT_SEARCH',
        this.config.sletat.protocol,
        { ...params, requestId, updateResult: 1 },
      );

      offers = this.mapOffers(pollPayload);
      if (offers.length > 0) {
        this.logger.debug(`Found ${offers.length} offers on poll attempt ${attempt + 1}`);
        return offers;
      }
    }

    this.logger.warn(`No offers after ${maxAttempts} poll attempts`);
    return offers;
  }

  private extractRequestId(payload: Record<string, unknown>): string | undefined {
    const top = payload.GetToursResult ?? payload;
    const data = (typeof top === 'object' && top !== null)
      ? ((top as Record<string, unknown>).Data ?? (top as Record<string, unknown>).data ?? top)
      : top;
    if (typeof data === 'object' && data !== null) {
      const d = data as Record<string, unknown>;
      const id = d.requestId ?? d.RequestId;
      if (id !== undefined && id !== null && id !== 0 && id !== '0') {
        return String(id);
      }
    }
    return undefined;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async actualizeOffer(externalOfferId: string): Promise<SletatSearchOffer | null> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_ACTUALIZE', this.config.sletat.protocol, {
      offerId: externalOfferId,
      sourceId: externalOfferId,
    });
    return this.mapOffers(payload)[0] ?? null;
  }

  async createClaim(offer: SletatSearchOffer, profileId: string, userId: string): Promise<SletatClaimInfo> {
    const payload = await this.callClaimsApi('SLETAT_ENDPOINT_CLAIM_CREATE', this.config.sletat.claimsProtocol, {
      offerId: offer.externalOfferId,
      profileId,
      userId,
      price: offer.price,
      currency: offer.currency,
    }, 'POST');

    return this.mapClaim(payload, offer.externalOfferId);
  }

  async getClaimInfo(claimId: string): Promise<SletatClaimInfo> {
    const payload = await this.callClaimsApi('SLETAT_ENDPOINT_CLAIM_INFO', this.config.sletat.claimsProtocol, { claimId }, 'GET');
    return this.mapClaim(payload, claimId);
  }

  async getPayments(claimId: string): Promise<{ url: string; type: string }[]> {
    const payload = await this.callClaimsApi('SLETAT_ENDPOINT_PAYMENTS', this.config.sletat.claimsProtocol, { claimId }, 'GET');

    const links = this.pickArray(payload, ['payments', 'paymentLinks', 'links'])
      .map((item) => ({
        url: String(item.url ?? item.href ?? item.link ?? ''),
        type: String(item.type ?? item.paymentType ?? 'unknown'),
      }))
      .filter((it) => it.url);

    if (links.length) return links;

    const single = this.pickObject(payload, ['payment', 'link']);
    const url = String(single?.url ?? single?.href ?? single?.link ?? '');
    return url ? [{ url, type: String(single?.type ?? 'unknown') }] : [];
  }

  private async callSearchApi(endpointEnv: string, protocol: Protocol, params: Record<string, unknown>) {
    const endpoint = this.config.getString(endpointEnv);
    const url = new URL(endpoint, this.config.sletat.searchBaseUrl).toString();
    return this.request(url, protocol, 'GET', params);
  }

  private async callClaimsApi(
    endpointEnv: string,
    protocol: Protocol,
    params: Record<string, unknown>,
    method: HttpMethod,
  ) {
    const endpoint = this.config.getString(endpointEnv);
    const url = new URL(endpoint, this.config.sletat.claimsBaseUrl).toString();
    return this.request(url, protocol, method, params);
  }

  private async request(
    url: string,
    protocol: Protocol,
    method: HttpMethod,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const withAuth: Record<string, unknown> = {
      login: this.config.sletat.login,
      password: this.config.sletat.password,
      ...params,
    };

    const headers: Record<string, string> = {
      Accept: protocol === 'json' ? 'application/json' : 'application/xml,text/xml',
    };

    let finalUrl = url;
    let body: string | undefined;

    if (method === 'GET') {
      const u = new URL(url);
      Object.entries(withAuth).forEach(([k, v]) => {
        if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
      });
      finalUrl = u.toString();
    } else if (protocol === 'json') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(withAuth);
    } else {
      headers['Content-Type'] = 'application/xml';
      body = this.buildXml(withAuth);
    }

    this.logger.debug(`Sletat request: ${method} ${finalUrl}`);
    const response = await this.sendHttpRequest(finalUrl, method, headers, body);

    if (response.statusCode >= 400) {
      throw new Error(`Sletat API ${response.statusCode}: ${response.body.slice(0, 500)}`);
    }

    const text = response.body.trim();
    if (!text) return {};
    let parsed: Record<string, unknown>;
    if (protocol === 'json' || text.startsWith('{') || text.startsWith('[')) {
      parsed = this.parseJson(text);
    } else {
      parsed = this.parseXmlFlat(text);
    }

    const topResult = Object.values(parsed).find(
      (v) => typeof v === 'object' && v !== null && 'IsError' in (v as Record<string, unknown>),
    ) as Record<string, unknown> | undefined;
    if (topResult?.IsError === true) {
      const msg = String(topResult.ErrorMessage ?? 'Unknown Sletat API error');
      this.logger.error(`Sletat API error: ${msg}`);
      throw new Error(`Sletat API: ${msg}`);
    }

    return parsed;
  }

  private async sendHttpRequest(
    url: string,
    method: HttpMethod,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ statusCode: number; body: string }> {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: `${parsed.pathname}${parsed.search}`,
          method,
          headers,
        },
        (res: IncomingMessage) => {
          let responseBody = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            responseBody += chunk;
          });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 500, body: responseBody });
          });
        },
      );

      req.on('error', (err: Error) => reject(err));
      if (body) req.write(body);
      req.end();
    });
  }

  private toSearchParams(request: SletatNormalizedRequest): Record<string, unknown> {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() + 1 * 86400000);
    const defaultTo = new Date(now.getTime() + 30 * 86400000);

    const formatDate = (d: Date) =>
      d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\./g, '/');

    const dateFrom = request.dateFrom
      ? formatDate(new Date(request.dateFrom))
      : formatDate(defaultFrom);
    const dateTo = request.dateTo
      ? formatDate(new Date(request.dateTo))
      : formatDate(defaultTo);

    return {
      cityFromId: request.departureCityId ?? 832,
      countryId: request.countryId,
      cities: request.resortId,
      meals: request.mealId,
      stars: request.hotelCategory,
      s_adults: request.adults ?? 2,
      s_kids: request.children ?? 0,
      s_kids_ages: request.childrenAges?.join(','),
      s_nightsMin: request.nightsFrom ?? 3,
      s_nightsMax: request.nightsTo ?? 14,
      s_departFrom: dateFrom,
      s_departTo: dateTo,
      s_priceMin: request.budgetMin,
      s_priceMax: request.budgetMax,
      currencyAlias: request.currency ?? 'RUB',
      s_showcase: 'true',
      groupBy: 'hotel',
      requestId: 0,
      pageSize: 10,
      pageNumber: 1,
      updateResult: 0,
      includeDescriptions: 1,
      includeOilTaxesAndVisa: 1,
      s_hotelIsNotInStop: 'true',
      s_hasTickets: 'true',
      s_ticketsIncluded: 'true',
    };
  }

  private mapOffers(payload: Record<string, unknown>): SletatSearchOffer[] {
    const raw = this.pickArray(payload, [
      'GetToursResult',
      'ActualizePriceResult',
      'offers',
      'results',
      'tours',
      'data',
    ]);
    return raw
      .map((item) => this.normalizeOfferItem(item) as unknown as SletatSearchOffer)
      .filter((item) => item.externalOfferId && item.hotelName && Number(item.price) > 0);
  }

  private normalizeOfferItem(item: Record<string, unknown> | unknown[]): Record<string, unknown> {
    if (Array.isArray(item)) {
      const priceStr = String(item[15] ?? '');
      const priceMatch = priceStr.match(/[\d\s]+/);
      const priceFromStr = priceMatch ? parseInt(priceMatch[0].replace(/\s/g, ''), 10) : 0;
      const price = Number(item[42] ?? item[86] ?? (priceFromStr || 0));
      return {
        externalOfferId: String(item[0] ?? item[1] ?? ''),
        hotelName: String(item[7] ?? item[60] ?? ''),
        countryName: String(item[31] ?? ''),
        resortName: String(item[19] ?? item[62] ?? ''),
        mealName: String(item[10] ?? item[63] ?? ''),
        roomName: String(item[9] ?? item[65] ?? ''),
        departureCity: String(item[33] ?? ''),
        dateFrom: String(item[12] ?? ''),
        dateTo: String(item[13] ?? ''),
        nights: this.optionalNumber(item[14]),
        price: Number.isFinite(price) ? price : priceFromStr,
        currency: String(item[43] ?? (priceStr.includes('RUB') ? 'RUB' : 'RUB')) as string,
      };
    }
    return {
      externalOfferId: String(item.externalOfferId ?? item.offerId ?? item.id ?? ''),
      hotelName: String(item.hotelName ?? item.hotel ?? ''),
      countryName: String(item.countryName ?? item.country ?? ''),
      resortName: this.optionalString(item.resortName ?? item.resort),
      mealName: this.optionalString(item.mealName ?? item.meal),
      roomName: this.optionalString(item.roomName ?? item.room),
      departureCity: this.optionalString(item.departureCity ?? item.departure),
      dateFrom: this.optionalString(item.dateFrom ?? item.startDate),
      dateTo: this.optionalString(item.dateTo ?? item.endDate),
      nights: this.optionalNumber(item.nights),
      price: Number(item.price ?? item.totalPrice ?? 0),
      currency: String(item.currency ?? 'RUB'),
    };
  }

  private mapDictionary(payload: Record<string, unknown>, keys: string[]) {
    return this.pickArray(payload, keys)
      .map((item) => {
        const id = item.id ?? item.Id ?? item.code ?? item.Code;
        const name = item.name ?? item.Name ?? item.title ?? item.Title;
        return {
          id: String(id ?? ''),
          code: String(item.code ?? item.Code ?? id ?? ''),
          name: String(name ?? ''),
        };
      })
      .filter((item) => item.id && item.name);
  }

  private mapClaim(payload: Record<string, unknown>, fallbackId: string): SletatClaimInfo {
    const claim = this.pickObject(payload, ['claim', 'result', 'data']) ?? payload;
    return {
      claimId: String(claim.claimId ?? claim.id ?? fallbackId),
      status: String(claim.status ?? claim.state ?? 'PENDING'),
      paymentUrl: this.optionalString(claim.paymentUrl ?? claim.url),
    };
  }

  private mapHotels(payload: Record<string, unknown>): SletatHotelItem[] {
    const raw = this.pickArray(payload, ['GetHotelsResult', 'hotels', 'Hotels']);
    return raw.map((item) => ({
      id: String(item.Id ?? item.id ?? ''),
      name: String(item.Name ?? item.name ?? ''),
      starId: this.optionalString(item.StarId ?? item.starId),
      starName: this.optionalString(item.StarName ?? item.starName),
      townId: this.optionalString(item.TownId ?? item.townId),
      rating: this.optionalNumber(item.Rating ?? item.rating),
      photosCount: this.optionalNumber(item.PhotosCount ?? item.photosCount) ?? 0,
    })).filter((h) => h.id && h.name);
  }

  private mapShowcase(payload: Record<string, unknown>): SletatShowcaseItem[] {
    const raw = this.pickArray(payload, ['GetShowcaseReviewResult', 'data', 'Data']);
    return raw
      .map((item) => ({
        countryId: String(item.CountryId ?? item.countryId ?? ''),
        countryName: String(item.CountryName ?? item.countryName ?? ''),
        hotelName: this.optionalString(item.HotelName ?? item.hotelName),
        starName: this.optionalString(item.StarName ?? item.starName),
        resortName: this.optionalString(item.ResortName ?? item.resortName),
        mealName: this.optionalString(item.MealName ?? item.mealName),
        minPrice: String(item.MinPrice ?? item.minPrice ?? ''),
        minPriceDate: this.optionalString(item.MinPriceDate ?? item.minPriceDate),
        nights: this.optionalNumber(item.Nights ?? item.nights),
        offerId: this.optionalString(item.OfferId ?? item.offerId),
      }))
      .filter((item) => item.countryId && item.countryName);
  }

  private parseJson(text: string): Record<string, unknown> {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return { data: parsed };
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as Record<string, unknown>;
  }

  private parseXmlFlat(text: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    const scalarRe = /<([a-zA-Z0-9_:-]+)>([^<]+)<\/\1>/g;
    let scalarMatch: RegExpExecArray | null = null;
    while ((scalarMatch = scalarRe.exec(text)) !== null) {
      result[scalarMatch[1]] = scalarMatch[2].trim();
    }

    const blocks: string[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let itemMatch: RegExpExecArray | null = null;
    while ((itemMatch = itemRe.exec(text)) !== null) {
      blocks.push(itemMatch[1]);
    }

    if (blocks.length) {
      const items = blocks.map((block) => {
        const item: Record<string, unknown> = {};
        const kvRe = /<([a-zA-Z0-9_:-]+)>([^<]*)<\/\1>/g;
        let kvMatch: RegExpExecArray | null = null;
        while ((kvMatch = kvRe.exec(block)) !== null) {
          item[kvMatch[1]] = kvMatch[2].trim();
        }
        return item;
      });
      result.items = items;
      result.data = items;
      result.offers = items;
      result.cities = items;
      result.countries = items;
      result.meals = items;
      result.hotels = items;
    }

    return result;
  }

  private buildXml(params: Record<string, unknown>) {
    const fields = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `<${k}>${String(v)}</${k}>`)
      .join('');
    return `<request>${fields}</request>`;
  }

  private pickArray(payload: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = payload[key];
      if (Array.isArray(value)) {
        return value.filter((x): x is Record<string, unknown> => typeof x === 'object' && !!x);
      }
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        let nested = v.items ?? v.Data ?? v.data;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          const inner = (nested as Record<string, unknown>).aaData ?? (nested as Record<string, unknown>).data;
          nested = inner;
        }
        if (Array.isArray(nested)) {
          return nested.filter((x): x is Record<string, unknown> => typeof x === 'object' && !!x);
        }
      }
    }
    return [];
  }

  private pickObject(payload: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = payload[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
    return null;
  }

  private findDictionaryId(items: SletatDictionaryItem[], query?: string | null): string | undefined {
    const value = query?.trim().toLowerCase();
    if (!value) return undefined;
    const exact = items.find((i) => i.name.toLowerCase() === value || i.code.toLowerCase() === value);
    if (exact) return exact.id;
    const partial = items.find((i) => i.name.toLowerCase().includes(value) || value.includes(i.name.toLowerCase()));
    return partial?.id;
  }

  private optionalString(v: unknown): string | undefined {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t || undefined;
  }

  private optionalNumber(v: unknown): number | undefined {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
}
