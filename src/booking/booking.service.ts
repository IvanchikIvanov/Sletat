import { Injectable } from '@nestjs/common';
import { BookingRepository } from '../persistence/repositories/booking.repository';
import { SearchResultRepository } from '../persistence/repositories/search-result.repository';
import { SletatService } from '../sletat/sletat.service';
import { BookingStatus } from '@prisma/client';

@Injectable()
export class BookingService {
  constructor(
    private readonly bookings: BookingRepository,
    private readonly results: SearchResultRepository,
    private readonly sletat: SletatService,
  ) {}

  async createBookingFromOffer(params: {
    userId: string;
    profileId?: string | null;
    offerId: string;
  }): Promise<{
    bookingId: string;
    claimId?: string;
    status: BookingStatus;
    paymentUrl?: string;
  }> {
    const offer = await this.results.findById(params.offerId);
    if (!offer) {
      throw new Error('Offer not found');
    }

    const booking = await this.bookings.createBooking({
      userId: params.userId,
      profileId: params.profileId ?? null,
      searchResultId: offer.id,
    });

    try {
      const claim = await this.sletat.createClaim(
        {
          externalOfferId: offer.externalOfferId,
          hotelName: offer.hotelName ?? '',
          countryName: offer.countryName ?? '',
          resortName: offer.resortName ?? undefined,
          mealName: offer.mealName ?? undefined,
          roomName: offer.roomName ?? undefined,
          departureCity: offer.departureCity ?? undefined,
          dateFrom: offer.dateFrom?.toISOString(),
          dateTo: offer.dateTo?.toISOString(),
          nights: offer.nights ?? undefined,
          price: offer.price,
          currency: offer.currency,
        },
        params.profileId ?? '',
        params.userId,
      );

      await this.bookings.updateStatus(booking.id, BookingStatus.CONFIRMED, null, claim.claimId);

      return {
        bookingId: booking.id,
        claimId: claim.claimId,
        status: BookingStatus.CONFIRMED,
        paymentUrl: claim.paymentUrl,
      };
    } catch (err) {
      await this.bookings.updateStatus(
        booking.id,
        BookingStatus.FAILED,
        (err as Error).message,
      );
      throw err;
    }
  }
}

