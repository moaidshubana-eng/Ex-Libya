-- CreateEnum
CREATE TYPE "RemittanceProvider" AS ENUM ('WESTERN_UNION', 'MONEYGRAM');

-- CreateEnum
CREATE TYPE "RemittanceDirection" AS ENUM ('SEND', 'RECEIVE');

-- CreateEnum
CREATE TYPE "RemittanceCustomerType" AS ENUM ('INTERNAL', 'EXTERNAL');

-- CreateTable
CREATE TABLE "remittances" (
    "id" TEXT NOT NULL,
    "provider" "RemittanceProvider" NOT NULL,
    "direction" "RemittanceDirection" NOT NULL,
    "customerType" "RemittanceCustomerType" NOT NULL,
    "clientId" TEXT,
    "externalCustomerName" TEXT,
    "externalCustomerPhone" TEXT,
    "counterpartyName" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "countryCode" TEXT,
    "principalAmount" DECIMAL(18,2) NOT NULL,
    "currencyId" TEXT NOT NULL,
    "cost" DECIMAL(18,2) NOT NULL,
    "saleValue" DECIMAL(18,2) NOT NULL,
    "profit" DECIMAL(18,2) NOT NULL,
    "branchId" TEXT,
    "isVoided" BOOLEAN NOT NULL DEFAULT false,
    "voidReason" TEXT,
    "voidedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remittances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "remittances_provider_direction_createdAt_idx" ON "remittances"("provider", "direction", "createdAt");

-- CreateIndex
CREATE INDEX "remittances_branchId_createdAt_idx" ON "remittances"("branchId", "createdAt");

-- AddForeignKey
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_currencyId_fkey" FOREIGN KEY ("currencyId") REFERENCES "currencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remittances" ADD CONSTRAINT "remittances_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
