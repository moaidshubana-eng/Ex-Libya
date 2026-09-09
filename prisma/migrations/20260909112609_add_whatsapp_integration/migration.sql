-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('FREE_TEXT', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "MessageIntent" AS ENUM ('RATE_INQUIRY', 'HUMAN_HANDOFF', 'OTHER');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('RECEIVED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "intent" "MessageIntent",
    "waPhoneNumber" TEXT NOT NULL,
    "clientId" TEXT,
    "templateName" TEXT,
    "body" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "errorMessage" TEXT,
    "providerMessageId" TEXT,
    "relatedDealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whatsapp_messages_clientId_createdAt_idx" ON "whatsapp_messages"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "whatsapp_messages_waPhoneNumber_createdAt_idx" ON "whatsapp_messages"("waPhoneNumber", "createdAt");

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_relatedDealId_fkey" FOREIGN KEY ("relatedDealId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
