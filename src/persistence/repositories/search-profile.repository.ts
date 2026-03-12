import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SearchProfile } from '@prisma/client';

export interface UpsertSearchProfileInput {
  userId: string;
  name: string;
  departureCityCode?: string | null;
  countryCode?: string | null;
  resortCode?: string | null;
  hotelCategory?: string | null;
  mealCode?: string | null;
  adults?: number | null;
  children?: number | null;
  childrenAges?: number[] | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  nightsFrom?: number | null;
  nightsTo?: number | null;
  budgetMin?: number | null;
  budgetMax?: number | null;
  currency?: string | null;
}

@Injectable()
export class SearchProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  findById(id: string): Promise<SearchProfile | null> {
    return this.prisma.searchProfile.findUnique({ where: { id } });
  }

  findByUser(userId: string): Promise<SearchProfile[]> {
    return this.prisma.searchProfile.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  findLatestByUser(userId: string): Promise<SearchProfile | null> {
    return this.prisma.searchProfile.findFirst({
      where: { userId, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async upsertForUser(input: UpsertSearchProfileInput): Promise<SearchProfile> {
    const { userId, name, childrenAges, ...rest } = input;

    const data = {
      ...rest,
      adults: rest.adults != null ? Number(rest.adults) : undefined,
      children: rest.children != null ? Number(rest.children) : undefined,
      nightsFrom: rest.nightsFrom != null ? Number(rest.nightsFrom) : undefined,
      nightsTo: rest.nightsTo != null ? Number(rest.nightsTo) : undefined,
      budgetMin: rest.budgetMin != null ? Number(rest.budgetMin) : undefined,
      budgetMax: rest.budgetMax != null ? Number(rest.budgetMax) : undefined,
      childrenAges: childrenAges ? (childrenAges as unknown as any) : undefined,
    };

    const existing = await this.prisma.searchProfile.findFirst({
      where: { userId, name },
    });

    if (!existing) {
      return this.prisma.searchProfile.create({
        data: { userId, name, ...data },
      });
    }

    return this.prisma.searchProfile.update({
      where: { id: existing.id },
      data,
    });
  }
}

