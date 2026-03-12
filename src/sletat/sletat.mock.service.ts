import { Injectable, Logger } from '@nestjs/common';
import { SletatClient } from './sletat.client';
import {
  SletatClaimInfo,
  SletatDictionaryItem,
  SletatHotelItem,
  SletatNormalizedRequest,
  SletatOrderTourist,
  SletatSearchOffer,
  SletatShowcaseItem,
} from './sletat.types';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';

@Injectable()
export class SletatMockService implements SletatClient {
  private readonly logger = new Logger(SletatMockService.name);

  // MOCK IMPLEMENTATION
  // TODO: replace with real Sletat API call

  async loadDepartureCities(): Promise<SletatDictionaryItem[]> {
    return [
      { id: '1', code: 'MOW', name: 'Москва' },
      { id: '2', code: 'LED', name: 'Санкт-Петербург' },
      { id: '3', code: 'AER', name: 'Сочи' },
    ];
  }

  async loadCountries(_townFromId?: number): Promise<SletatDictionaryItem[]> {
    return [
      { id: '10', code: 'TR', name: 'Турция' },
      { id: '11', code: 'EG', name: 'Египет' },
      { id: '12', code: 'TH', name: 'Таиланд' },
      { id: '13', code: 'AE', name: 'ОАЭ' },
      { id: '14', code: 'VN', name: 'Вьетнам' },
    ];
  }

  async loadMeals(): Promise<SletatDictionaryItem[]> {
    return [
      { id: '100', code: 'AI', name: 'All Inclusive' },
      { id: '101', code: 'BB', name: 'Завтрак' },
    ];
  }

  async loadHotels(_countryId?: number): Promise<SletatHotelItem[]> {
    return [];
  }

  async loadCities(_countryId: number): Promise<SletatDictionaryItem[]> {
    return [
      { id: '200', code: 'ANT', name: 'Анталья' },
      { id: '201', code: 'BOD', name: 'Бодрум' },
    ];
  }

  async loadHotelStars(_countryId: number): Promise<SletatDictionaryItem[]> {
    return [
      { id: '3', code: '3', name: '3*' },
      { id: '4', code: '4', name: '4*' },
      { id: '5', code: '5', name: '5*' },
    ];
  }

  async normalizeRequest(parsed: ParsedTourRequest): Promise<SletatNormalizedRequest> {
    // MOCK IMPLEMENTATION: простая заглушка, маппит по коду/названию на жёстко заданные значения
    // TODO: replace with real Sletat API call + dictionary-based matching
    const departureCityId = parsed.departureCity?.toLowerCase().includes('моск')
      ? '1'
      : parsed.departureCity?.toLowerCase().includes('питер')
      ? '2'
      : parsed.departureCity?.toLowerCase().includes('сочи')
      ? '3'
      : undefined;

    const countryId = parsed.country?.toLowerCase().includes('турц')
      ? '10'
      : parsed.country?.toLowerCase().includes('егип')
      ? '11'
      : undefined;

    const mealId = parsed.mealType?.toLowerCase().includes('all')
      ? '100'
      : parsed.mealType?.toLowerCase().includes('завтрак')
      ? '101'
      : undefined;

    return {
      departureCityId,
      countryId,
      resortId: undefined,
      mealId,
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
    // MOCK IMPLEMENTATION
    // TODO: replace with real Sletat API call
    this.logger.debug(`Mock searchTours called with: ${JSON.stringify(request)}`);
    return [
      {
        externalOfferId: 'MOCK1',
        sourceId: '970',
        requestId: '343658640',
        hotelName: 'Mock Hotel 5*',
        countryName: 'Турция',
        resortName: 'Анталья',
        mealName: 'All Inclusive',
        roomName: 'Standard',
        departureCity: request.departureCityId === '2' ? 'Санкт-Петербург' : 'Москва',
        dateFrom: request.dateFrom ?? '2025-06-01',
        dateTo: request.dateTo ?? '2025-06-08',
        nights: request.nightsFrom ?? 7,
        price: request.budgetMax ?? 120000,
        currency: request.currency ?? 'RUB',
      },
    ];
  }

  async actualizeOffer(params: {
    offerId: string;
    sourceId: string;
    requestId?: string;
  }): Promise<SletatSearchOffer | null> {
    // MOCK IMPLEMENTATION
    this.logger.debug(`Mock actualizeOffer called for: ${params.offerId}`);
    if (!params.offerId) return null;
    return {
      externalOfferId: params.offerId,
      sourceId: params.sourceId,
      requestId: params.requestId,
      hotelName: 'Mock Hotel 5* (actualized)',
      countryName: 'Турция',
      resortName: 'Анталья',
      mealName: 'All Inclusive',
      roomName: 'Standard',
      departureCity: 'Москва',
      dateFrom: '2025-06-01',
      dateTo: '2025-06-08',
      nights: 7,
      price: 110000,
      currency: 'RUB',
    };
  }

  async createClaim(offer: SletatSearchOffer, tourist: SletatOrderTourist): Promise<SletatClaimInfo> {
    // MOCK IMPLEMENTATION
    this.logger.debug(`Mock createClaim for offer=${offer.externalOfferId}, tourist=${tourist.name}`);
    return {
      claimId: `MOCK-CLAIM-${offer.externalOfferId}`,
      status: 'PENDING',
      paymentUrl: undefined,
    };
  }

  async getClaimInfo(claimId: string): Promise<SletatClaimInfo> {
    // MOCK IMPLEMENTATION
    // TODO: replace with real Sletat API call
    this.logger.debug(`Mock getClaimInfo for claim=${claimId}`);
    return {
      claimId,
      status: 'CONFIRMED',
      paymentUrl: `https://example.com/mock-payment/${claimId}`,
    };
  }

  async getPayments(claimId: string): Promise<{ url: string; type: string }[]> {
    // MOCK IMPLEMENTATION
    // TODO: replace with real Sletat API call
    this.logger.debug(`Mock getPayments for claim=${claimId}`);
    return [
      {
        url: `https://example.com/mock-payment/${claimId}`,
        type: 'card',
      },
    ];
  }

  async loadShowcaseReview(_townFromId?: number, _currencyAlias?: string): Promise<SletatShowcaseItem[]> {
    return [
      {
        countryId: '10',
        countryName: 'Турция',
        hotelName: 'Mock Hotel 5*',
        starName: '5*',
        resortName: 'Анталья',
        mealName: 'AI',
        minPrice: '45000 RUB',
        nights: 7,
      },
    ];
  }
}

