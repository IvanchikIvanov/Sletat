import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SearchRequest, SearchRequestStatus } from '@prisma/client';

@Injectable()
export class SearchRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  createPending(data: {
    userId: string;
    profileId?: string | null;
    rawText: string;
    parsedJson?: unknown;
  }): Promise<SearchRequest> {
    return this.prisma.searchRequest.create({
      data: {
        userId: data.userId,
        profileId: data.profileId ?? undefined,
        rawText: data.rawText,
        parsedJson: data.parsedJson as any,
        status: SearchRequestStatus.PENDING,
      },
    });
  }

  markSuccess(id: string, parsedJson: unknown): Promise<SearchRequest> {
    return this.prisma.searchRequest.update({
      where: { id },
      data: {
        status: SearchRequestStatus.SUCCESS,
        parsedJson: parsedJson as any,
        errorMessage: null,
      },
    });
  }

  markFailed(id: string, errorMessage: string): Promise<SearchRequest> {
    return this.prisma.searchRequest.update({
      where: { id },
      data: {
        status: SearchRequestStatus.FAILED,
        errorMessage,
      },
    });
  }
}

