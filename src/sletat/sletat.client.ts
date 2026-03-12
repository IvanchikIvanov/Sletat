import { SletatClaimInfo, SletatDictionaryItem, SletatHotelItem, SletatNormalizedRequest, SletatSearchOffer, SletatShowcaseItem } from './sletat.types';
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

  actualizeOffer(externalOfferId: string): Promise<SletatSearchOffer | null>;

  createClaim(offer: SletatSearchOffer, profileId: string, userId: string): Promise<SletatClaimInfo>;

  getClaimInfo(claimId: string): Promise<SletatClaimInfo>;

  getPayments(claimId: string): Promise<{ url: string; type: string }[]>;

  loadShowcaseReview(townFromId?: number, currencyAlias?: string): Promise<SletatShowcaseItem[]>;
}

