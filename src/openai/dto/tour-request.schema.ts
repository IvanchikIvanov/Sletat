export interface ParsedTourRequest {
  departureCity?: string;
  country?: string;
  resort?: string;
  hotelCategory?: string;
  mealType?: string;
  adults?: number;
  children?: number;
  childrenAges?: number[];
  dateFrom?: string;
  dateTo?: string;
  nightsFrom?: number;
  nightsTo?: number;
  budgetMin?: number;
  budgetMax?: number;
  currency?: string;
  preferences?: string;
}

