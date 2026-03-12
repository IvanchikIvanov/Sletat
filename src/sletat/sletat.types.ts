export interface SletatDictionaryItem {
  id: string;
  code: string;
  name: string;
}

export interface SletatNormalizedRequest {
  departureCityId?: string;
  countryId?: string;
  resortId?: string;
  mealId?: string;
  hotelCategory?: string;
  adults: number;
  children: number;
  childrenAges?: number[];
  dateFrom?: string;
  dateTo?: string;
  nightsFrom?: number;
  nightsTo?: number;
  budgetMin?: number;
  budgetMax?: number;
  currency?: string;
}

export interface SletatSearchOffer {
  externalOfferId: string;
  hotelName: string;
  countryName: string;
  resortName?: string;
  mealName?: string;
  roomName?: string;
  departureCity?: string;
  dateFrom?: string;
  dateTo?: string;
  nights?: number;
  price: number;
  currency: string;
}

export interface SletatClaimInfo {
  claimId: string;
  status: string;
  paymentUrl?: string;
}

export interface SletatShowcaseItem {
  countryId: string;
  countryName: string;
  hotelName?: string;
  starName?: string;
  resortName?: string;
  mealName?: string;
  minPrice: string;
  minPriceDate?: string;
  nights?: number;
  offerId?: string;
}

