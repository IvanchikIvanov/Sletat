import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
  CachedCountry,
  CachedResort,
  CachedHotel,
  CachedHotDeal,
  CachedDepartureCity,
  CachedMeal,
  Prisma,
} from '@prisma/client';

@Injectable()
export class CacheRepository {
  private readonly logger = new Logger(CacheRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Departure Cities ───

  async upsertDepartureCity(data: {
    id: string;
    name: string;
    countryId?: string;
    isDefault?: boolean;
    isPopular?: boolean;
  }): Promise<void> {
    await this.prisma.cachedDepartureCity.upsert({
      where: { id: data.id },
      create: { ...data, fetchedAt: new Date() },
      update: { ...data, fetchedAt: new Date() },
    });
  }

  async getAllDepartureCities(): Promise<CachedDepartureCity[]> {
    return this.prisma.cachedDepartureCity.findMany({ orderBy: { name: 'asc' } });
  }

  async findDepartureCityByName(name: string): Promise<CachedDepartureCity | null> {
    const lower = name.trim().toLowerCase();
    const all = await this.getAllDepartureCities();
    return all.find((c) => c.name.toLowerCase() === lower) ?? null;
  }

  // ─── Countries ───

  async upsertCountry(data: {
    id: string;
    name: string;
    alias?: string;
    isVisa?: boolean;
    flags?: number;
    rank?: number;
    townFromId?: number;
  }): Promise<void> {
    const townFromId = data.townFromId ?? 832;
    await this.prisma.cachedCountry.upsert({
      where: { id_townFromId: { id: data.id, townFromId } },
      create: { ...data, townFromId, fetchedAt: new Date() },
      update: { ...data, townFromId, fetchedAt: new Date() },
    });
  }

  async getCountries(townFromId = 832): Promise<CachedCountry[]> {
    return this.prisma.cachedCountry.findMany({
      where: { townFromId },
      orderBy: { name: 'asc' },
    });
  }

  async findCountryByName(name: string, townFromId = 832): Promise<CachedCountry | null> {
    const lower = name.trim().toLowerCase();
    const all = await this.getCountries(townFromId);
    return all.find((c) => c.name.toLowerCase() === lower || c.alias?.toLowerCase() === lower) ?? null;
  }

  async getCountryFreshness(townFromId = 832): Promise<Date | null> {
    const first = await this.prisma.cachedCountry.findFirst({
      where: { townFromId },
      orderBy: { fetchedAt: 'desc' },
      select: { fetchedAt: true },
    });
    return first?.fetchedAt ?? null;
  }

  // ─── Resorts (Cities) ───

  async upsertResort(data: {
    id: string;
    name: string;
    countryId: string;
    isPopular?: boolean;
    parentId?: string;
  }): Promise<void> {
    await this.prisma.cachedResort.upsert({
      where: { id: data.id },
      create: { ...data, fetchedAt: new Date() },
      update: { ...data, fetchedAt: new Date() },
    });
  }

  async getResorts(countryId: string): Promise<CachedResort[]> {
    return this.prisma.cachedResort.findMany({
      where: { countryId },
      orderBy: { name: 'asc' },
    });
  }

  async findResortByName(name: string, countryId: string): Promise<CachedResort | null> {
    const lower = name.trim().toLowerCase();
    const all = await this.getResorts(countryId);
    return all.find((r) => r.name.toLowerCase().includes(lower) || lower.includes(r.name.toLowerCase())) ?? null;
  }

  async getResortFreshness(countryId: string): Promise<Date | null> {
    const first = await this.prisma.cachedResort.findFirst({
      where: { countryId },
      orderBy: { fetchedAt: 'desc' },
      select: { fetchedAt: true },
    });
    return first?.fetchedAt ?? null;
  }

  // ─── Hotels ───

  async upsertHotel(data: {
    id: string;
    name: string;
    countryId: string;
    resortId?: string;
    starId?: string;
    starName?: string;
    rating?: number;
    photosCount?: number;
  }): Promise<void> {
    await this.prisma.cachedHotel.upsert({
      where: { id: data.id },
      create: { ...data, fetchedAt: new Date() },
      update: { ...data, fetchedAt: new Date() },
    });
  }

  async getHotels(countryId: string, opts?: { starName?: string; resortId?: string }): Promise<CachedHotel[]> {
    const where: Prisma.CachedHotelWhereInput = { countryId };
    if (opts?.starName) where.starName = opts.starName;
    if (opts?.resortId) where.resortId = opts.resortId;
    return this.prisma.cachedHotel.findMany({ where, orderBy: { name: 'asc' } });
  }

  async findHotelByName(name: string, countryId?: string): Promise<CachedHotel | null> {
    const lower = name.trim().toLowerCase();
    const where: Prisma.CachedHotelWhereInput = {};
    if (countryId) where.countryId = countryId;
    const hotels = await this.prisma.cachedHotel.findMany({ where });
    return hotels.find((h) => h.name.toLowerCase().includes(lower)) ?? null;
  }

  async getHotelFreshness(countryId: string): Promise<Date | null> {
    const first = await this.prisma.cachedHotel.findFirst({
      where: { countryId },
      orderBy: { fetchedAt: 'desc' },
      select: { fetchedAt: true },
    });
    return first?.fetchedAt ?? null;
  }

  async getHotelCount(countryId: string): Promise<number> {
    return this.prisma.cachedHotel.count({ where: { countryId } });
  }

  // ─── Meals ───

  async upsertMeal(data: { id: string; name: string }): Promise<void> {
    await this.prisma.cachedMeal.upsert({
      where: { id: data.id },
      create: { ...data, fetchedAt: new Date() },
      update: { ...data, fetchedAt: new Date() },
    });
  }

  async getAllMeals(): Promise<CachedMeal[]> {
    return this.prisma.cachedMeal.findMany({ orderBy: { name: 'asc' } });
  }

  // ─── Hot Deals ───

  async replaceHotDeals(townFromId: number, deals: Omit<CachedHotDeal, 'id' | 'fetchedAt'>[]): Promise<number> {
    await this.prisma.cachedHotDeal.deleteMany({ where: { townFromId } });
    if (!deals.length) return 0;
    const data = deals.map((d) => ({ ...d, fetchedAt: new Date() }));
    const result = await this.prisma.cachedHotDeal.createMany({ data });
    return result.count;
  }

  async getHotDeals(townFromId = 832): Promise<CachedHotDeal[]> {
    return this.prisma.cachedHotDeal.findMany({
      where: { townFromId },
      orderBy: { minPrice: 'asc' },
    });
  }

  async getHotDealsForCountry(countryId: string, townFromId = 832): Promise<CachedHotDeal[]> {
    return this.prisma.cachedHotDeal.findMany({
      where: { countryId, townFromId },
      orderBy: { minPrice: 'asc' },
    });
  }

  async getHotDealsFreshness(townFromId = 832): Promise<Date | null> {
    const first = await this.prisma.cachedHotDeal.findFirst({
      where: { townFromId },
      orderBy: { fetchedAt: 'desc' },
      select: { fetchedAt: true },
    });
    return first?.fetchedAt ?? null;
  }

  // ─── Freshness check ───

  async isStale(table: 'country' | 'resort' | 'hotel' | 'hotDeal' | 'meal' | 'departureCity', maxAgeMs: number, key?: string): Promise<boolean> {
    let fetchedAt: Date | null = null;

    switch (table) {
      case 'departureCity': {
        const row = await this.prisma.cachedDepartureCity.findFirst({ orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
        fetchedAt = row?.fetchedAt ?? null;
        break;
      }
      case 'country':
        fetchedAt = await this.getCountryFreshness(key ? Number(key) : 832);
        break;
      case 'resort':
        fetchedAt = key ? await this.getResortFreshness(key) : null;
        break;
      case 'hotel':
        fetchedAt = key ? await this.getHotelFreshness(key) : null;
        break;
      case 'hotDeal':
        fetchedAt = await this.getHotDealsFreshness(key ? Number(key) : 832);
        break;
      case 'meal': {
        const row = await this.prisma.cachedMeal.findFirst({ orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true } });
        fetchedAt = row?.fetchedAt ?? null;
        break;
      }
    }

    if (!fetchedAt) return true;
    return Date.now() - fetchedAt.getTime() > maxAgeMs;
  }
}
