import { Injectable } from '@nestjs/common';
import { Booking, BookingStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';

@Injectable()
export class BookingRepository {
  constructor(private readonly prisma: PrismaService) {}

  createBooking(input: {
    userId: string;
    profileId?: string | null;
    searchResultId: string;
  }): Promise<Booking> {
    return this.prisma.booking.create({
      data: {
        userId: input.userId,
        profileId: input.profileId ?? undefined,
        searchResultId: input.searchResultId,
      },
    });
  }

  updateStatus(
    id: string,
    status: BookingStatus,
    lastError?: string | null,
    claimId?: string | null,
  ): Promise<Booking> {
    return this.prisma.booking.update({
      where: { id },
      data: {
        status,
        lastError: lastError ?? null,
        claimId: claimId ?? undefined,
      },
    });
  }

  findById(id: string): Promise<Booking | null> {
    return this.prisma.booking.findUnique({ where: { id } });
  }
}

