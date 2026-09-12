-- CreateEnum
CREATE TYPE "ClientBalanceMovementType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE');

-- CreateTable
CREATE TABLE "client_balance_movements" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "currencyId" TEXT NOT NULL,
    "type" "ClientBalanceMovementType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "balanceAfter" DECIMAL(18,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "treasuryMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_balance_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_balance_movements_clientId_currencyId_createdAt_idx" ON "client_balance_movements"("clientId", "currencyId", "createdAt");

-- AddForeignKey
ALTER TABLE "client_balance_movements" ADD CONSTRAINT "client_balance_movements_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_balance_movements" ADD CONSTRAINT "client_balance_movements_currencyId_fkey" FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_balance_movements" ADD CONSTRAINT "client_balance_movements_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
