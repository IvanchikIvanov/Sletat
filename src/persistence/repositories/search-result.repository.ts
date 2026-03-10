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
}

