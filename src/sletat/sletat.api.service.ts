import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';
import { SletatClient } from './sletat.client';
import {
  SletatClaimInfo,
  SletatDictionaryItem,
  SletatHotelItem,
  SletatLoadStateItem,
  SletatNormalizedRequest,
  SletatOrderTourist,
  SletatSearchOffer,
  SletatShowcaseItem,
  SletatTemplateItem,
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

  async getLoadState(requestId: string): Promise<SletatLoadStateItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_LOAD_STATE', this.config.sletat.protocol, {
      requestId,
    });
    const raw = this.pickArray(payload, ['GetLoadStateResult', 'Data', 'LoadState']);
    return raw.map((item) => ({
      Id: Number(item.Id ?? item.id ?? 0),
      Name: String(item.Name ?? item.name ?? ''),
      IsProcessed: Boolean(item.IsProcessed ?? item.isProcessed ?? false),
      RowsCount: Number(item.RowsCount ?? item.rowsCount ?? 0),
    }));
  }

  async loadTemplates(templatesList = 'shared', type = 0): Promise<SletatTemplateItem[]> {
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_TEMPLATES', this.config.sletat.protocol, {
      templatesList,
      type,
    });
    const top = payload.GetTemplatesResult ?? payload;
    const data = (top as Record<string, unknown>)?.Data ?? (top as Record<string, unknown>)?.data;
    const templates = (data && typeof data === 'object' && 'templates' in data)
      ? (data as Record<string, unknown>).templates
      : Array.isArray(data) ? data : [];
    if (!Array.isArray(templates)) return [];
    return templates.map((t: Record<string, unknown>) => ({
      id: Number(t.id ?? t.Id ?? 0),
      name: String(t.name ?? t.Name ?? ''),
      departureCity: String(t.departureCity ?? t.DepartureCity ?? ''),
    })).filter((t) => t.id > 0 && t.name);
  }

  async loadShowcaseReview(townFromId = 832, currencyAlias = 'RUB', templateName?: string): Promise<SletatShowcaseItem[]> {
    const params: Record<string, unknown> = { townFromId, currencyAlias, countryToursCount: 1, showcase: 1 };
    if (templateName) params.templateName = templateName;
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_SHOWCASE_REVIEW', this.config.sletat.protocol, params);
    return this.mapShowcase(payload);
  }

  async loadCountriesForShowcase(townFromId: number, templateName?: string): Promise<SletatDictionaryItem[]> {
    const params: Record<string, unknown> = { townFromId, showcase: 1 };
    if (templateName) params.templateName = templateName;
    const payload = await this.callSearchApi('SLETAT_ENDPOINT_COUNTRIES', this.config.sletat.protocol, params);
    return this.mapDictionary(payload, ['GetCountriesResult', 'countries', 'CountryList']);
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
    let requestId = this.extractRequestId(firstPayload);
    if (offers.length > 0) {
      this.logger.debug(`Found ${offers.length} offers on first request`);
      return this.attachRequestId(offers, requestId);
    }

    if (!requestId) {
      this.logger.warn('No requestId in GetTours response, cannot poll');
      return offers;
    }

    // По гайду: отслеживать статус только через GetLoadState (не GetTours)
    const pollDelayMs = 1500;
    const maxWaitMs = 120_000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      await this.sleep(pollDelayMs);

      const loadState = await this.getLoadState(requestId);
      const allProcessed = loadState.length > 0 && loadState.every((s) => s.IsProcessed);
      const hasRows = loadState.some((s) => s.RowsCount > 0);

      if (allProcessed || hasRows) {
        const resultPayload = await this.callSearchApi(
          'SLETAT_ENDPOINT_SEARCH',
          this.config.sletat.protocol,
          { ...params, requestId, updateResult: 1 },
        );
        offers = this.mapOffers(resultPayload);
        if (offers.length > 0) {
          this.logger.debug(`Found ${offers.length} offers after GetLoadState poll`);
          return this.attachRequestId(offers, requestId);
        }
        if (allProcessed) break;
      }
    }

    this.logger.warn('No offers after GetLoadState polling (timeout or empty result)');
    return offers;
  }

  private readonly BULK_CAP = 2500;

  /** Массовая выгрузка: GetTours + GetLoadState, пагинация, авто-дробление при total >= 2500 */
  async searchToursBulk(
    request: SletatNormalizedRequest,
    opts?: { pageSize?: number },
  ): Promise<SletatSearchOffer[]> {
    return this.searchToursBulkInternal(request, opts ?? {}, 0);
  }

  private async searchToursBulkInternal(
    request: SletatNormalizedRequest,
    opts: { pageSize?: number },
    depth: number,
  ): Promise<SletatSearchOffer[]> {
    const pageSize = opts.pageSize ?? 2500;
    const baseParams = this.toSearchParams(request);
    const params = { ...baseParams, pageSize, pageNumber: 1, updateResult: 0 };

    const firstPayload = await this.callSearchApi(
      'SLETAT_ENDPOINT_SEARCH',
      this.config.sletat.protocol,
      params,
    );

    const requestId = this.extractRequestId(firstPayload);
    if (!requestId) {
      return this.mapOffers(firstPayload);
    }

    const pollDelayMs = 1500;
    const maxWaitMs = 120_000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      await this.sleep(pollDelayMs);
      const loadState = await this.getLoadState(requestId);
      const allProcessed = loadState.length > 0 && loadState.every((s) => s.IsProcessed);
      const hasRows = loadState.some((s) => s.RowsCount > 0);

      if (allProcessed || hasRows) {
        const allOffers: SletatSearchOffer[] = [];
        let pageNumber = 1;
        let lastTotal = 0;

        for (;;) {
          const resultPayload = await this.callSearchApi(
            'SLETAT_ENDPOINT_SEARCH',
            this.config.sletat.protocol,
            { ...baseParams, requestId, updateResult: 1, pageSize, pageNumber },
          );
          const pageOffers = this.mapOffers(resultPayload);
          allOffers.push(...this.attachRequestId(pageOffers, requestId));

          const total = this.extractTotalRecords(resultPayload);
          lastTotal = total ?? 0;
          if (pageOffers.length < pageSize || allOffers.length >= lastTotal) break;
          pageNumber++;
        }

        if (lastTotal >= this.BULK_CAP && depth < 3) {
          const split = this.trySplitSlice(request, lastTotal, depth);
          if (split) {
            const [reqA, reqB] = split;
            const [offersA, offersB] = await Promise.all([
              this.searchToursBulkInternal(reqA, opts, depth + 1),
              this.searchToursBulkInternal(reqB, opts, depth + 1),
            ]);
            const seen = new Set<string>();
            return [...offersA, ...offersB].filter((o) => {
              const key = `${o.externalOfferId}-${o.sourceId}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          }
        }

        return allOffers;
      }
    }

    this.logger.warn('Bulk search timeout');
    return [];
  }

  private parseRuDate(s: string): Date {
    const [d, m, y] = s.split(/[./]/).map(Number);
    return new Date(y, (m ?? 1) - 1, d ?? 1);
  }

  private trySplitSlice(
    request: SletatNormalizedRequest,
    total: number,
    depth: number,
  ): [SletatNormalizedRequest, SletatNormalizedRequest] | null {
    const formatDate = (d: Date) =>
      d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\./g, '/');

    if (depth === 0 && request.dateFrom && request.dateTo) {
      const from = this.parseRuDate(request.dateFrom);
      const to = this.parseRuDate(request.dateTo);
      const midTime = (from.getTime() + to.getTime()) / 2;
      const mid = new Date(midTime);
      const midNext = new Date(mid.getTime() + 86400000);
      if (mid.getTime() <= from.getTime() || midNext.getTime() >= to.getTime()) return null;
      this.logger.debug(`Bulk split by dates: ${formatDate(from)}-${formatDate(mid)} | ${formatDate(midNext)}-${formatDate(to)}`);
      return [
        { ...request, dateFrom: formatDate(from), dateTo: formatDate(mid) },
        { ...request, dateFrom: formatDate(midNext), dateTo: formatDate(to) },
      ];
    }

    if (depth === 1 && request.nightsFrom != null && request.nightsTo != null) {
      const min = request.nightsFrom;
      const max = request.nightsTo;
      const mid = Math.floor((min + max) / 2);
      if (mid <= min || mid + 1 > max) return null;
      this.logger.debug(`Bulk split by nights: ${min}-${mid} | ${mid + 1}-${max}`);
      return [
        { ...request, nightsFrom: min, nightsTo: mid },
        { ...request, nightsFrom: mid + 1, nightsTo: max },
      ];
    }

    if (depth === 2 && request.dateFrom && request.dateTo) {
      const from = this.parseRuDate(request.dateFrom);
      const to = this.parseRuDate(request.dateTo);
      const third = (to.getTime() - from.getTime()) / 3;
      const m1 = new Date(from.getTime() + third);
      const m2 = new Date(from.getTime() + 2 * third);
      const m2Next = new Date(m2.getTime() + 86400000);
      if (m1.getTime() <= from.getTime() || m2Next.getTime() >= to.getTime()) return null;
      this.logger.debug(`Bulk split by dates (depth 2): finer ranges`);
      return [
        { ...request, dateFrom: formatDate(from), dateTo: formatDate(m1) },
        { ...request, dateFrom: formatDate(m2Next), dateTo: formatDate(to) },
      ];
    }

    return null;
  }

  /** Массовая выгрузка горящих: GetTours с s_showcase=true, templateName. Без GetLoadState — данные из кеша. */
  async searchHotToursBulk(params: {
    cityFromId: number;
    countryId: number;
    templateName: string;
    pageSize?: number;
  }): Promise<SletatSearchOffer[]> {
    const pageSize = params.pageSize ?? 2500;
    const baseParams = {
      cityFromId: params.cityFromId,
      countryId: params.countryId,
      templateName: params.templateName,
      s_showcase: 'true',
      s_nightsMin: 3,
      s_nightsMax: 14,
      currencyAlias: 'RUB',
      groupBy: 'hotel',
      requestId: 0,
      pageSize,
      pageNumber: 1,
      updateResult: 0,
      includeDescriptions: 1,
      includeOilTaxesAndVisa: 1,
    };

    const firstPayload = await this.callSearchApi(
      'SLETAT_ENDPOINT_SEARCH',
      this.config.sletat.protocol,
      baseParams,
    );

    const requestId = this.extractRequestId(firstPayload);
    if (!requestId) {
      return this.mapOffers(firstPayload);
    }

    const allOffers: SletatSearchOffer[] = [];
    let pageNumber = 1;

    for (;;) {
      const resultPayload = await this.callSearchApi(
        'SLETAT_ENDPOINT_SEARCH',
        this.config.sletat.protocol,
        { ...baseParams, requestId, updateResult: 1, pageSize, pageNumber },
      );
      const pageOffers = this.mapOffers(resultPayload);
      allOffers.push(...this.attachRequestId(pageOffers, requestId));

      const total = this.extractTotalRecords(resultPayload);
      if (pageOffers.length < pageSize || allOffers.length >= (total ?? 0)) break;
      pageNumber++;
    }

    return allOffers;
  }

  private extractTotalRecords(payload: Record<string, unknown>): number | undefined {
    const top = payload.GetToursResult ?? payload;
    const data = (typeof top === 'object' && top !== null)
      ? ((top as Record<string, unknown>).Data ?? (top as Record<string, unknown>).data ?? top)
      : top;
    if (typeof data === 'object' && data !== null) {
      const d = data as Record<string, unknown>;
      const total = d.iTotalDisplayRecords ?? d.iTotalRecords ?? d.totalRecords;
      if (typeof total === 'number' && Number.isFinite(total)) return total;
    }
    return undefined;
  }

  private attachRequestId(offers: SletatSearchOffer[], requestId?: string): SletatSearchOffer[] {
    if (!requestId) return offers;
    return offers.map((o) => ({ ...o, requestId }));
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

  async actualizeOffer(params: {
    offerId: string;
    sourceId: string;
    requestId?: string;
  }): Promise<SletatSearchOffer | null> {
    const apiParams: Record<string, unknown> = {
      offerId: params.offerId,
      sourceId: params.sourceId,
      currencyAlias: 'RUB',
      showcase: 0,
      detailed: 1,
    };
    if (params.requestId) apiParams.requestId = params.requestId;

    const maxRetries = 3;
    const retryDelayMs = 2000;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const payload = await this.callSearchApi(
          'SLETAT_ENDPOINT_ACTUALIZE',
          this.config.sletat.protocol,
          apiParams,
        );
        const result = this.mapOffers(payload)[0] ?? null;
        if (result) return result;

        const top = payload.ActualizePriceResult ?? payload;
        const isError = (top as Record<string, unknown>)?.IsError ?? (top as Record<string, unknown>)?.isError;
        const errMsg = String((top as Record<string, unknown>)?.ErrorMessage ?? (top as Record<string, unknown>)?.errorMessage ?? '');
        if (isError && errMsg) {
          throw new Error(`Sletat API: ${errMsg}`);
        }
        return null;
      } catch (err) {
        lastError = err as Error;
        const msg = lastError.message ?? '';
        const isRetryable =
          msg.includes('временно недоступен') ||
          msg.includes('Сервис временно') ||
          msg.includes('timeout') ||
          msg.includes('ETIMEDOUT');
        if (isRetryable && attempt < maxRetries - 1) {
          this.logger.warn(`ActualizePrice attempt ${attempt + 1} failed, retrying: ${msg}`);
          await this.sleep(retryDelayMs * (attempt + 1));
        } else {
          throw err;
        }
      }
    }
    throw lastError ?? new Error('ActualizePrice failed');
  }

  async createClaim(offer: SletatSearchOffer, tourist: SletatOrderTourist): Promise<SletatClaimInfo> {
    if (!offer.sourceId || !offer.requestId) {
      throw new Error('Для передачи заявки менеджеру нужен тур из поиска (sourceId, requestId). Запусти новый поиск.');
    }

    const payload = await this.callSearchApi('SLETAT_ENDPOINT_CLAIM_CREATE', this.config.sletat.protocol, {
      searchRequestId: offer.requestId,
      offerId: offer.externalOfferId,
      sourceId: offer.sourceId,
      user: tourist.name,
      email: tourist.email,
      phone: tourist.phone,
      info: tourist.comment ?? '',
      countryName: offer.countryName ?? 'Не указано',
      cityFromName: offer.departureCity ?? 'Не указано',
      currencyAlias: offer.currency ?? 'RUB',
    });

    const top = payload.SaveTourOrderResult ?? payload;
    const isError = (top as Record<string, unknown>)?.IsError ?? (top as Record<string, unknown>)?.isError;
    if (isError) {
      const errMsg = String((top as Record<string, unknown>)?.ErrorMessage ?? 'SaveTourOrder failed');
      throw new Error(`Sletat API: ${errMsg}`);
    }

    return {
      claimId: `order-${offer.externalOfferId}`,
      status: 'PENDING',
      paymentUrl: undefined,
    };
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
      ? formatDate(this.parseRuDate(request.dateFrom))
      : formatDate(defaultFrom);
    const dateTo = request.dateTo
      ? formatDate(this.parseRuDate(request.dateTo))
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
    if (raw.length > 0) {
      const first = raw[0];
      if (Array.isArray(first)) {
        this.logger.debug(`First offer is array[${first.length}], sample keys at end: [${first.length - 3}]=${first[first.length - 3]}, [${first.length - 2}]=${first[first.length - 2]}, [${first.length - 1}]=${first[first.length - 1]}`);
      } else {
        const keys = Object.keys(first);
        const tourUrlKey = keys.find(k => k.toLowerCase().includes('toururl') || k.toLowerCase().includes('tour_url'));
        this.logger.debug(`First offer keys (${keys.length}): ${keys.slice(0, 20).join(', ')}${keys.length > 20 ? '...' : ''}${tourUrlKey ? `, TourUrl key found: ${tourUrlKey}=${first[tourUrlKey]}` : ', no TourUrl key'}`);
      }
    }
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
        externalOfferId: String(item[0] ?? ''),
        sourceId: this.optionalString(item[1]),
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
        tourUrl: this.optionalString(item[87] ?? item[88]),
      };
    }
    return {
      externalOfferId: String(item.externalOfferId ?? item.offerId ?? item.id ?? ''),
      sourceId: this.optionalString(item.sourceId ?? item.SourceId),
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
      tourUrl: this.optionalString(item.TourUrl ?? item.tourUrl ?? item.tour_url),
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
