ALTER TABLE "runs" ADD COLUMN "memorySelection" JSONB;

CREATE TABLE "bot_memory_banks" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "spaceMemoryConfigId" TEXT NOT NULL,
    "bankId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_memory_banks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "memory_retentions" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "content" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "operationId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "state" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memory_retentions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_retentions_state_check" CHECK ("state" IN ('pending', 'processing', 'completed', 'failed')),
    CONSTRAINT "memory_retentions_source_kind_check" CHECK ("sourceKind" IN ('conversation', 'durable')),
    CONSTRAINT "memory_retentions_attempt_count_check" CHECK ("attemptCount" >= 0),
    CONSTRAINT "memory_retentions_claim_lease_check" CHECK (("claimToken" IS NULL) = ("leaseUntil" IS NULL)),
    CONSTRAINT "memory_retentions_pending_check" CHECK ("state" <> 'pending' OR "content" IS NOT NULL),
    CONSTRAINT "memory_retentions_processing_check" CHECK ("state" <> 'processing' OR ("acceptedAt" IS NOT NULL AND "content" IS NULL)),
    CONSTRAINT "memory_retentions_terminal_check" CHECK (
        "state" NOT IN ('completed', 'failed')
        OR ("content" IS NULL AND "nextAttemptAt" IS NULL AND "claimToken" IS NULL AND "leaseUntil" IS NULL)
    )
);

CREATE UNIQUE INDEX "bot_memory_banks_botId_key" ON "bot_memory_banks"("botId");

CREATE INDEX "bot_memory_banks_spaceMemoryConfigId_idx" ON "bot_memory_banks"("spaceMemoryConfigId");

CREATE UNIQUE INDEX "memory_retentions_operationId_key" ON "memory_retentions"("operationId");

CREATE INDEX "memory_retentions_state_nextAttemptAt_id_idx" ON "memory_retentions"("state", "nextAttemptAt", "id");

CREATE INDEX "memory_retentions_bindingId_idx" ON "memory_retentions"("bindingId");

CREATE UNIQUE INDEX "memory_retentions_runId_sourceKey_key" ON "memory_retentions"("runId", "sourceKey");

ALTER TABLE "bot_memory_banks" ADD CONSTRAINT "bot_memory_banks_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bot_memory_banks" ADD CONSTRAINT "bot_memory_banks_spaceMemoryConfigId_fkey" FOREIGN KEY ("spaceMemoryConfigId") REFERENCES "space_memory_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_retentions" ADD CONSTRAINT "memory_retentions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "memory_retentions" ADD CONSTRAINT "memory_retentions_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "bot_memory_banks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
