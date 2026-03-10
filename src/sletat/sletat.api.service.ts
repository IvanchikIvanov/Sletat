import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';
import { SletatClient } from './sletat.client';
import {
  SletatClaimInfo,
  SletatDictionaryItem,
  SletatNormalizedRequest,
  SletatSearchOffer,
} from './sletat.types';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

type HttpMethod = 'GET' | 'POST';
type Protocol = 'json' | 'xml';

@Injectable()
export class SletatApiService implements SletatClient {
  private readonly logger = new Logger(SletatApiService.name);

  constructor(private readonly config: AppConfigService) {}

  async loadDepartureCities(): Promise<SletatDictionaryItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_DEPARTURE_CITIES', this.config.sletat.protocol, {});
    return this.mapDictionary(payload, ['departures', 'departureCities', 'cities']);
  }

  async loadCountries(): Promise<SletatDictionaryItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_COUNTRIES', this.config.sletat.protocol, {});
    return this.mapDictionary(payload, ['countries']);
  }

  async loadMeals(): Promise<SletatDictionaryItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_MEALS', this.config.sletat.protocol, {});
    return this.mapDictionary(payload, ['meals', 'foodTypes']);
  }

  async loadHotels(): Promise<SletatDictionaryItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_HOTELS', this.config.sletat.protocol, {});
    return this.mapDictionary(payload, ['hotels']);
  }

  async normalizeRequest(parsed: ParsedTourRequest): Promise<SletatNormalizedRequest> {
    const [departures, countries, meals] = await Promise.all([
      this.loadDepartureCities(),
      this.loadCountries(),
      this.loadMeals(),
    ]);

    return {
      departureCityId: this.findDictionaryId(departures, parsed.departureCity),
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
    const payload = await this.callSearchApi(
      'SLETAT_ENDPOINT_SEARCH',
      this.config.sletat.protocol,
      this.toSearchParams(request),
    );
    return this.mapOffers(payload);
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
    if (protocol === 'json' || text.startsWith('{') || text.startsWith('[')) {
      return this.parseJson(text);
    }
    return this.parseXmlFlat(text);
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
        (res) => {
          let responseBody = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            responseBody += chunk;
          });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 500, body: responseBody });
          });
        },
      );

      req.on('error', (err) => reject(err));
      if (body) req.write(body);
      req.end();
    });
  }

  private toSearchParams(request: SletatNormalizedRequest): Record<string, unknown> {
    return {
      departureCityId: request.departureCityId,
      countryId: request.countryId,
      resortId: request.resortId,
      mealId: request.mealId,
      hotelCategory: request.hotelCategory,
      adults: request.adults,
      children: request.children,
      childrenAges: request.childrenAges?.join(','),
      dateFrom: request.dateFrom,
      dateTo: request.dateTo,
      nightsFrom: request.nightsFrom,
      nightsTo: request.nightsTo,
      budgetMin: request.budgetMin,
      budgetMax: request.budgetMax,
      currency: request.currency,
    };
  }

  private mapOffers(payload: Record<string, unknown>): SletatSearchOffer[] {
    return this.pickArray(payload, ['offers', 'results', 'tours', 'data'])
      .map((item) => ({
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
      }))
      .filter((item) => item.externalOfferId && item.hotelName && item.price > 0);
  }

  private mapDictionary(payload: Record<string, unknown>, keys: string[]) {
    return this.pickArray(payload, keys)
      .map((item) => ({
        id: String(item.id ?? item.code ?? ''),
        code: String(item.code ?? item.id ?? ''),
        name: String(item.name ?? item.title ?? ''),
      }))
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
        const nested = (value as Record<string, unknown>).items;
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
