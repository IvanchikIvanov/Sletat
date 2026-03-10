export interface ExtractedFact {
  fact: string;
  category: 'personal' | 'family' | 'travel' | 'preferences';
  key: string;
}
