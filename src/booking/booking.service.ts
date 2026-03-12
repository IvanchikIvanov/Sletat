import { Injectable, Logger } from '@nestjs/common';
import { BookingRepository } from '../persistence/repositories/booking.repository';
import { SearchResultRepository } from '../persistence/repositories/search-result.repository';
import { SletatService } from '../sletat/sletat.service';
import { BookingStatus } from '@prisma/client';

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

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

    const actualized = await this.sletat.actualizeOffer(offer.externalOfferId);
    if (!actualized) {
      this.logger.warn(`Offer ${offer.externalOfferId} is no longer available`);
      throw new Error('Тур больше не доступен. Попробуйте выбрать другой вариант.');
    }

    const offerData = {
      externalOfferId: actualized.externalOfferId,
      hotelName: actualized.hotelName ?? offer.hotelName ?? '',
      countryName: actualized.countryName ?? offer.countryName ?? '',
      resortName: actualized.resortName ?? offer.resortName ?? undefined,
      mealName: actualized.mealName ?? offer.mealName ?? undefined,
      roomName: actualized.roomName ?? offer.roomName ?? undefined,
      departureCity: actualized.departureCity ?? offer.departureCity ?? undefined,
      dateFrom: actualized.dateFrom ?? offer.dateFrom?.toISOString(),
      dateTo: actualized.dateTo ?? offer.dateTo?.toISOString(),
      nights: actualized.nights ?? offer.nights ?? undefined,
      price: actualized.price,
      currency: actualized.currency,
    };

    if (actualized.price !== offer.price) {
      this.logger.log(
        `Price changed for ${offer.externalOfferId}: ${offer.price} -> ${actualized.price} ${offer.currency}`,
      );
      await this.results.updatePrice(offer.id, actualized.price, actualized.currency);
    }

    const booking = await this.bookings.createBooking({
      userId: params.userId,
      profileId: params.profileId ?? null,
      searchResultId: offer.id,
    });

    try {
      const claim = await this.sletat.createClaim(
        offerData,
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

