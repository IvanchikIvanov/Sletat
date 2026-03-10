import { ParsedTourRequest } from '../../openai/dto/tour-request.schema';

export class SearchFromTextResult {
  profileId!: string;
  profileName!: string;
  offers!: {
    id: string;
    hotelName?: string | null;
    countryName?: string | null;
    resortName?: string | null;
    mealName?: string | null;
    dateFrom?: Date | null;
    dateTo?: Date | null;
    nights?: number | null;
    price: number;
    currency: string;
    externalOfferId: string;
  }[];
}

export interface SearchContext {
  userId: string;
  rawText: string;
  parsed: ParsedTourRequest;
}

