-- CreateTable
CREATE TABLE "Knowledge" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector(1536),
    "category" TEXT NOT NULL DEFAULT 'tourism',
    "source" TEXT NOT NULL DEFAULT 'web',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Knowledge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Knowledge_category_idx" ON "Knowledge"("category");
