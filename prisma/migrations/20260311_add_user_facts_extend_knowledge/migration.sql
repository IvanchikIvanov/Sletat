-- AlterTable: extend Knowledge with new columns
ALTER TABLE "Knowledge" ADD COLUMN "subcategory" TEXT;
ALTER TABLE "Knowledge" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "Knowledge" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "Knowledge" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "Knowledge_category_subcategory_idx" ON "Knowledge"("category", "subcategory");

-- CreateTable
CREATE TABLE "UserFact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fact" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT,
    "embedding" vector(1536),
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "source" TEXT NOT NULL DEFAULT 'dialog',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserFact_userId_idx" ON "UserFact"("userId");

-- CreateIndex
CREATE INDEX "UserFact_category_idx" ON "UserFact"("category");

-- CreateIndex (unique constraint for deduplication)
CREATE UNIQUE INDEX "UserFact_userId_key_key" ON "UserFact"("userId", "key");

-- AddForeignKey
ALTER TABLE "UserFact" ADD CONSTRAINT "UserFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
