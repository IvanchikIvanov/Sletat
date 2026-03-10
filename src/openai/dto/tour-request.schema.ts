export type DestinationMode = 'specific' | 'visa_free' | 'any';

export interface ParsedTourRequest {
  departureCity?: string;
  country?: string;
  resort?: string;
  /** Режим назначения: конкретная страна, без визы, или любая */
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

