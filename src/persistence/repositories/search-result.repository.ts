import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SearchResult } from '@prisma/client';

@Injectable()
export class SearchResultRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createManyForProfile(
    profileId: string,
    results: Array<
      Omit<
        SearchResult,
        'id' | 'profileId' | 'isActive' | 'foundAt'
      > & { price: number; currency: string }
    >,
  ): Promise<SearchResult[]> {
    await this.prisma.searchResult.updateMany({
      where: { profileId },
      data: { isActive: false },
    });

    const created: SearchResult[] = [];
    for (const r of results) {
      const record = await this.prisma.searchResult.create({
        data: {
          profileId,
          externalOfferId: r.externalOfferId,
          sourceId: (r as any).sourceId ?? null,
          requestId: (r as any).requestId ?? null,
          hotelName: r.hotelName,
          countryName: r.countryName,
          resortName: r.resortName,
          mealName: r.mealName,
          roomName: r.roomName,
          departureCity: r.departureCity,
          dateFrom: r.dateFrom,
          dateTo: r.dateTo,
          nights: r.nights,
          price: r.price,
          currency: r.currency,
          tourUrl: (r as any).tourUrl ?? null,
        },
      });
      created.push(record);
    }
    return created;
  }

  findActiveByProfile(profileId: string): Promise<SearchResult[]> {
    return this.prisma.searchResult.findMany({
      where: { profileId, isActive: true },
      orderBy: { price: 'asc' },
    });
  }

  findById(id: string): Promise<SearchResult | null> {
    return this.prisma.searchResult.findUnique({ where: { id } });
  }

  async updatePrice(id: string, price: number, currency: string, tourUrl?: string | null): Promise<SearchResult> {
    const data: Record<string, unknown> = { price, currency };
    if (tourUrl !== undefined) data.tourUrl = tourUrl;
    return this.prisma.searchResult.update({
      where: { id },
      data,
    });
  }
}

