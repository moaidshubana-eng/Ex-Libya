-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "paidFromTreasury" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "treasuryMovementId" TEXT;
