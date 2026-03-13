export interface MemoryContext {
  userFacts: string[];
  userPreferences: string[];
  relevantKnowledge: string[];
  userDefaults?: Record<string, string> | null;
  lastParsed?: Record<string, unknown> | null;
}
