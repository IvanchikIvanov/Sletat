export type DestinationMode = 'specific' | 'visa_free' | 'any';
export type UserIntent = 'search' | 'monitor' | 'hot' | 'chat';

export interface ParsedTourRequest {
  departureCity?: string;
  country?: string;
  resort?: string;
  destinationMode?: DestinationMode;
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

export interface ParseTourResponse {
  readyToSearch: boolean;
  intent?: UserIntent;
  clarificationMessage?: string;
  parsed: ParsedTourRequest;
}

export interface DialogMessageDto {
  role: 'user' | 'assistant';
  content: string;
}

export interface PreviousDialogContext {
  parsed: ParsedTourRequest;
  messages: DialogMessageDto[];
}

