-- CreateEnum
CREATE TYPE "DealDirection" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "RateType" AS ENUM ('OFFICIAL', 'PARALLEL');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MovementType" ADD VALUE 'TRADE_BUY';
ALTER TYPE "MovementType" ADD VALUE 'TRADE_SELL';

-- AlterTable
ALTER TABLE "treasury_movements" ADD COLUMN     "dealId" TEXT;

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "currencyId" TEXT NOT NULL,
    "direction" "DealDirection" NOT NULL,
    "rateType" "RateType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "lockedRate" DECIMAL(18,6) NOT NULL,
    "lydEquivalent" DECIMAL(18,2) NOT NULL,
    "amountUsdEquivalent" DECIMAL(18,2) NOT NULL,
    "sourceRateId" TEXT NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requiresDualApproval" BOOLEAN NOT NULL,
    "lockExpiresAt" TIMESTAMP(3) NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "rejectedReason" TEXT,
    "executedById" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transactions_clientId_createdAt_idx" ON "transactions"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_branchId_status_idx" ON "transactions"("branchId", "status");

-- AddForeignKey
ALTER TABLE "treasury_movements" ADD CONSTRAINT "treasury_movements_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_currencyId_fkey" FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_sourceRateId_fkey" FOREIGN KEY ("sourceRateId") REFERENCES "exchange_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_executedById_fkey" FOREIGN KEY ("executedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
