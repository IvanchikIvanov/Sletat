import { SletatClaimInfo, SletatDictionaryItem, SletatHotelItem, SletatNormalizedRequest, SletatOrderTourist, SletatSearchOffer, SletatShowcaseItem } from './sletat.types';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';

export interface SletatClient {
  loadDepartureCities(): Promise<SletatDictionaryItem[]>;
  loadCountries(townFromId?: number): Promise<SletatDictionaryItem[]>;
  loadCities(countryId: number): Promise<SletatDictionaryItem[]>;
  loadMeals(): Promise<SletatDictionaryItem[]>;
  loadHotels(countryId?: number): Promise<SletatHotelItem[]>;
  loadHotelStars(countryId: number): Promise<SletatDictionaryItem[]>;

  normalizeRequest(parsed: ParsedTourRequest): Promise<SletatNormalizedRequest>;

  searchTours(request: SletatNormalizedRequest): Promise<SletatSearchOffer[]>;

  searchToursBulk(request: SletatNormalizedRequest, opts?: { pageSize?: number }): Promise<SletatSearchOffer[]>;

  searchHotToursBulk(params: { cityFromId: number; countryId: number; templateName: string; pageSize?: number }): Promise<SletatSearchOffer[]>;

  actualizeOffer(params: { offerId: string; sourceId: string; requestId?: string }): Promise<SletatSearchOffer | null>;

  createClaim(offer: SletatSearchOffer, tourist: SletatOrderTourist): Promise<SletatClaimInfo>;

  getClaimInfo(claimId: string): Promise<SletatClaimInfo>;

  getPayments(claimId: string): Promise<{ url: string; type: string }[]>;

  loadShowcaseReview(townFromId?: number, currencyAlias?: string, templateName?: string): Promise<SletatShowcaseItem[]>;

  loadCountriesForShowcase(townFromId: number, templateName?: string): Promise<SletatDictionaryItem[]>;

  loadTemplates(templatesList?: string, type?: number): Promise<Array<{ id: number; name: string; departureCity: string }>>;
}

