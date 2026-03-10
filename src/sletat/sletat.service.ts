import { Inject, Injectable } from '@nestjs/common';
import { SletatClient } from './sletat.client';
import { ParsedTourRequest } from '../openai/dto/tour-request.schema';
import { SletatNormalizedRequest, SletatSearchOffer, SletatDictionaryItem } from './sletat.types';
import { REDIS_CLIENT } from '../persistence/redis.provider';
import type Redis from 'ioredis';

const CACHE_TTL_SECONDS = 60 * 60; // 1 час

@Injectable()
export class SletatService {
  constructor(
    @Inject('SLETAT_CLIENT') private readonly client: SletatClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** Получить ID стран Sletat по списку названий (для visa-free поиска) */
  async getCountryIdsByNames(
    names: string[],
    townFromId = 832,
  ): Promise<string[]> {
    const countries = await this.client.loadCountries(townFromId);
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const name of names) {
      const id = this.findDictionaryId(countries, name);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }

    return ids;
  }

  private findDictionaryId(items: SletatDictionaryItem[], query?: string | null): string | undefined {
    const value = query?.trim().toLowerCase();
    if (!value) return undefined;
    const exact = items.find((i) => i.name.toLowerCase() === value || i.code.toLowerCase() === value);
    if (exact) return exact.id;
    const partial = items.find((i) => i.name.toLowerCase().includes(value) || value.includes(i.name.toLowerCase()));
    return partial?.id;
  }

  async getDepartureCities() {
    return this.getCached('sletat:departureCities', () => this.client.loadDepartureCities());
  }

  async getCountries() {
    return this.getCached('sletat:countries', () => this.client.loadCountries());
  }

  async getMeals() {
    return this.getCached('sletat:meals', () => this.client.loadMeals());
  }

  async getHotels() {
    return this.getCached('sletat:hotels', () => this.client.loadHotels());
  }

  async normalizeRequest(parsed: ParsedTourRequest): Promise<SletatNormalizedRequest> {
    return this.client.normalizeRequest(parsed);
  }

  async searchTours(request: SletatNormalizedRequest): Promise<SletatSearchOffer[]> {
    return this.client.searchTours(request);
  }

  async actualizeOffer(externalOfferId: string): Promise<SletatSearchOffer | null> {
    return this.client.actualizeOffer(externalOfferId);
  }

  async createClaim(offer: SletatSearchOffer, profileId: string, userId: string) {
    return this.client.createClaim(offer, profileId, userId);
  }

  async getClaimInfo(claimId: string) {
    return this.client.getClaimInfo(claimId);
  }

  async getPayments(claimId: string) {
    return this.client.getPayments(claimId);
  }

  private async getCached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = await this.redis.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
    const value = await loader();
    await this.redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
    return value;
  }
}

