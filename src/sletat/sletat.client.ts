import { SletatClaimInfo, SletatDictionaryItem, SletatNormalizedRequest, SletatSearchOffer } from './sletat.types';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';

export interface SletatClient {
  loadDepartureCities(): Promise<SletatDictionaryItem[]>;
  loadCountries(): Promise<SletatDictionaryItem[]>;
  loadMeals(): Promise<SletatDictionaryItem[]>;
  loadHotels(): Promise<SletatDictionaryItem[]>;

  normalizeRequest(parsed: ParsedTourRequest): Promise<SletatNormalizedRequest>;

  searchTours(request: SletatNormalizedRequest): Promise<SletatSearchOffer[]>;

  actualizeOffer(externalOfferId: string): Promise<SletatSearchOffer | null>;

  createClaim(offer: SletatSearchOffer, profileId: string, userId: string): Promise<SletatClaimInfo>;

  getClaimInfo(claimId: string): Promise<SletatClaimInfo>;

  getPayments(claimId: string): Promise<{ url: string; type: string }[]>;
}

