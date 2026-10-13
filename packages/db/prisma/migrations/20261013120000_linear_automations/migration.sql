-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "linearEventId" TEXT;

-- CreateTable
CREATE TABLE "linear_sources" (
    "connectionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "organizationName" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "webhookSecretId" TEXT,
    "webhookRevision" INTEGER NOT NULL DEFAULT 0,
    "monitoringSince" TIMESTAMP(3),
    "issuesThrough" TIMESTAMP(3),
    "commentsThrough" TIMESTAMP(3),
    "issueWindowEnd" TIMESTAMP(3),
    "commentWindowEnd" TIMESTAMP(3),
    "issueCursor" TEXT,
    "commentCursor" TEXT,
    "nextPollAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3),
    "rateLimitedUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linear_sources_pkey" PRIMARY KEY ("connectionId")
);

-- CreateTable
CREATE TABLE "routine_linear_triggers" (
    "routineId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "events" TEXT[],
    "projectId" TEXT,
    "assigneeId" TEXT,
    "stateId" TEXT,
    "labelIds" TEXT[],
    "revision" INTEGER NOT NULL DEFAULT 1,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "routine_linear_triggers_pkey" PRIMARY KEY ("routineId")
);

-- CreateTable
CREATE TABLE "linear_events" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "sourceGeneration" INTEGER NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "transport" TEXT NOT NULL,
    "deliveryId" TEXT,
    "seed" JSONB,
    "snapshot" JSONB,
    "status" TEXT NOT NULL,
    "afterRoutineId" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,

    CONSTRAINT "linear_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "linear_sources_webhookSecretId_key" ON "linear_sources"("webhookSecretId");

-- CreateIndex
CREATE INDEX "linear_sources_nextSyncAt_connectionId_idx" ON "linear_sources"("nextSyncAt", "connectionId");

-- CreateIndex
CREATE INDEX "routine_linear_triggers_connectionId_routineId_idx" ON "routine_linear_triggers"("connectionId", "routineId");

-- CreateIndex
CREATE INDEX "linear_events_connectionId_status_nextAttemptAt_id_idx" ON "linear_events"("connectionId", "status", "nextAttemptAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "linear_events_connectionId_eventKey_key" ON "linear_events"("connectionId", "eventKey");

-- CreateIndex
CREATE INDEX "runs_linearEventId_idx" ON "runs"("linearEventId");

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_linearEventId_fkey" FOREIGN KEY ("linearEventId") REFERENCES "linear_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linear_sources" ADD CONSTRAINT "linear_sources_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linear_sources" ADD CONSTRAINT "linear_sources_webhookSecretId_fkey" FOREIGN KEY ("webhookSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_linear_triggers" ADD CONSTRAINT "routine_linear_triggers_routineId_fkey" FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "routine_linear_triggers" ADD CONSTRAINT "routine_linear_triggers_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "linear_sources"("connectionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linear_events" ADD CONSTRAINT "linear_events_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "linear_sources"("connectionId") ON DELETE CASCADE ON UPDATE CASCADE;
