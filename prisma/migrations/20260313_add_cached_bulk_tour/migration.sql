-- CreateTable
CREATE TABLE "CachedBulkTour" (
    "id" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "countryName" TEXT NOT NULL,
    "townFromId" INTEGER NOT NULL,
    "hotelName" TEXT,
    "resortName" TEXT,
    "mealName" TEXT,
    "starName" TEXT,
    "dateFrom" TEXT,
    "dateTo" TEXT,
    "nights" INTEGER,
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "offerId" TEXT,
    "sourceId" TEXT,
    "requestId" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CachedBulkTour_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CachedBulkTour_countryId_townFromId_idx" ON "CachedBulkTour"("countryId", "townFromId");

-- CreateIndex
CREATE INDEX "CachedBulkTour_countryId_idx" ON "CachedBulkTour"("countryId");

-- CreateIndex
CREATE INDEX "CachedBulkTour_townFromId_idx" ON "CachedBulkTour"("townFromId");

-- CreateIndex
CREATE INDEX "CachedBulkTour_fetchedAt_idx" ON "CachedBulkTour"("fetchedAt");
