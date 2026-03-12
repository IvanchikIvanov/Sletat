import { Injectable, Logger } from '@nestjs/common';
import { BookingRepository } from '../persistence/repositories/booking.repository';
import { SearchResultRepository } from '../persistence/repositories/search-result.repository';
import { UserRepository } from '../persistence/repositories/user.repository';
import { SletatService } from '../sletat/sletat.service';
import { BookingStatus } from '@prisma/client';

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly bookings: BookingRepository,
    private readonly results: SearchResultRepository,
    private readonly users: UserRepository,
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

    if (!offer.sourceId || !offer.requestId) {
      throw new Error(
        'Для передачи заявки менеджеру нужен тур из поиска. Запусти новый поиск и выбери тур из результатов.',
      );
    }

    const actualized = await this.sletat.actualizeOffer({
      offerId: offer.externalOfferId,
      sourceId: offer.sourceId,
      requestId: offer.requestId,
    });
    if (!actualized) {
      this.logger.warn(`Offer ${offer.externalOfferId} is no longer available`);
      throw new Error('Тур больше не доступен. Попробуйте выбрать другой вариант.');
    }

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
      const user = await this.users.findById(params.userId);
      const touristName =
        user?.firstName || user?.lastName
          ? [user.firstName, user.lastName].filter(Boolean).join(' ')
          : user?.username
            ? `@${user.username}`
            : 'Пользователь Telegram';
      const touristComment = user?.username ? `Telegram: @${user.username}` : 'Заявка из Telegram-бота';

      const offerForClaim = {
        ...actualized,
        sourceId: actualized.sourceId ?? offer.sourceId ?? '',
        requestId: actualized.requestId ?? offer.requestId ?? '',
        countryName: actualized.countryName ?? offer.countryName ?? '',
        departureCity: actualized.departureCity ?? offer.departureCity ?? '',
      };
      const claim = await this.sletat.createClaim(offerForClaim, {
        name: touristName,
        email: 'telegram@noreply.local',
        phone: '+0',
        comment: touristComment,
      });

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

