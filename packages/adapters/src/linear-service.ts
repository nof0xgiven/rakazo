import type {
  IssueTrackerFailure,
  IssueTrackerOptionKind,
  IssueTrackerProvider,
  JobPublisher,
  SecretStore,
} from "@rakazo/adapter-kit";
import { isIssueTrackerError, linearSyncJob, linearSyncJobKey, runJobKey } from "@rakazo/adapter-kit";
import type {
  Connection,
  ConnectionStatus,
  LinearConfigureWebhookInput,
  LinearConnectInput,
  LinearConnectionStatus,
  LinearErrorCode,
  LinearOptions,
  LinearOptionsInput,
  LinearTrigger,
} from "@rakazo/contracts";
import {
  LINEAR_AUTOMATION_CAPABILITY,
  LINEAR_CONNECTOR_ID,
  LINEAR_ERROR_CODES,
  LINEAR_PROVIDER,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type {
  Connection as ConnectionRow,
  LinearSource,
  PrismaClient,
  ThreadEvents,
} from "@rakazo/db";
import { IsolationError, lockSpaceForContentCreation, withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { LinearTx } from "./linear-lifecycle.js";
import {
  discardPendingLinearEvents,
  eligibleLinearTriggerWhere,
  linearDatabaseNow,
  linearWebhookUrl,
  lockLinearSources,
  readLinearCredential,
  refreshLinearSourceMonitoring,
} from "./linear-lifecycle.js";
import type { CancelledLinearRuns } from "./linear-run-authorization.js";
import {
  cancelLinearRunsInTransaction,
  publishCancelledLinearRuns,
} from "./linear-run-authorization.js";
import { persistPreparedSecret } from "./secret-persistence.js";

export type LinearActor = { userId: string; spaceId: string };

export type LinearServiceErrorCode = "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "SERVICE_UNAVAILABLE";

export class LinearServiceError extends Error {
  readonly code: LinearServiceErrorCode;

  constructor(code: LinearServiceErrorCode, message: string) {
    super(message);
    this.name = "LinearServiceError";
    this.code = code;
  }
}

export const LINEAR_MESSAGES = {
  checkKey: "Check your Linear API key",
  chooseOption: "Choose an available Linear option",
  unavailable: "Linear is temporarily unavailable",
  changed: "Automation changed. Reload and try again.",
  useApiKey: "Use an API key to connect Linear",
  differentAccount: "This key belongs to a different Linear account",
  reconnect: "Reconnect Linear",
  webhookOrigin: "Webhooks require a public HTTPS API URL.",
} as const;

export interface LinearService {
  connect(actor: LinearActor, input: LinearConnectInput, signal: AbortSignal): Promise<Connection>;
  status(actor: LinearActor, input: { connectionId: string }): Promise<LinearConnectionStatus>;
  options(
    actor: LinearActor,
    input: LinearOptionsInput,
    signal: AbortSignal,
  ): Promise<LinearOptions>;
  configureWebhook(
    actor: LinearActor,
    input: LinearConfigureWebhookInput,
  ): Promise<LinearConnectionStatus>;
  revoke(actor: LinearActor, input: { connectionId: string }): Promise<{ cancelledRunIds: string[] }>;
  validateTrigger(
    actor: LinearActor,
    trigger: LinearTrigger,
    signal: AbortSignal,
  ): Promise<{ sourceRevision: number }>;
}

export type LinearServiceDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  provider: IssueTrackerProvider;
  jobs: JobPublisher;
  apiUrl: string | undefined;
  signal: AbortSignal;
  events?: Pick<ThreadEvents, "notify">;
};

type OwnedLinearSource = LinearSource & { connection: ConnectionRow };

const LINEAR_REQUEST_TIMEOUT_MS = 20_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;

export function connectionCapabilities(connectorId: string): string[] {
  return connectorId === LINEAR_CONNECTOR_ID ? [LINEAR_AUTOMATION_CAPABILITY] : [];
}

function connectionDto(row: {
  id: string;
  connectorId: string;
  provider: string;
  displayName: string;
  status: string;
  createdAt: Date;
}): Connection {
  return {
    id: row.id,
    connectorId: row.connectorId,
    provider: row.provider,
    displayName: row.displayName,
    status: row.status as ConnectionStatus,
    capabilities: connectionCapabilities(row.connectorId),
    createdAt: row.createdAt.toISOString(),
  };
}

async function lockLinearProviderScope(tx: LinearTx, owner: LinearActor): Promise<void> {
  const scope = `space:${owner.spaceId}|user:${owner.userId}|connector:${LINEAR_CONNECTOR_ID}|provider:${LINEAR_PROVIDER}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('connection-provider'), hashtext(${scope}))`;
}

async function lockOwnerMembership(tx: LinearTx, actor: LinearActor): Promise<void> {
  await lockSpaceForContentCreation(tx, actor);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM space_members
    WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
    FOR SHARE`;
  if (rows.length === 0) throw new IsolationError();
}

function boundedSignal(...signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any([...signals, AbortSignal.timeout(LINEAR_REQUEST_TIMEOUT_MS)]);
}

function failureOf(error: unknown): IssueTrackerFailure | null {
  return isIssueTrackerError(error) ? error.failure : null;
}

function safeErrorCode(value: string | null): LinearErrorCode | null {
  return value !== null && (LINEAR_ERROR_CODES as readonly string[]).includes(value)
    ? (value as LinearErrorCode)
    : null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function createLinearService(deps: LinearServiceDeps): LinearService {
  const { prisma, secrets, provider, jobs } = deps;

  async function ownedSource(
    actor: LinearActor,
    connectionId: string,
  ): Promise<OwnedLinearSource | null> {
    const row = await prisma.connection.findFirst({
      where: {
        id: connectionId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        connectorId: LINEAR_CONNECTOR_ID,
      },
      include: { linearSource: true },
    });
    if (!row?.linearSource) return null;
    const { linearSource, ...connection } = row;
    return { ...linearSource, connection };
  }

  async function enqueueSync(connectionId: string): Promise<void> {
    await jobs.enqueue(linearSyncJob({ connectionId })).catch((error) => {
      getLogger().error("linear sync enqueue failed", error, { connectionId });
    });
  }

  async function settleCancelledRuns(cancelled: CancelledLinearRuns | null): Promise<string[]> {
    if (!cancelled) return [];
    await Promise.all([
      publishCancelledLinearRuns({ jobs, events: deps.events }, cancelled),
      ...cancelled.runIds.map((runId) => jobs.cancel(runJobKey(runId)).catch(() => undefined)),
    ]);
    return cancelled.runIds;
  }

  async function cancelSourceRuns(tx: LinearTx, connectionId: string, now: Date) {
    const runs = await tx.run.findMany({
      where: { linearEvent: { connectionId }, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    return cancelLinearRunsInTransaction(tx, runs, now);
  }

  async function recordStoredKeyFailure(
    connectionId: string,
    revision: number,
    failure: IssueTrackerFailure,
  ): Promise<void> {
    if (failure.code !== "auth" && failure.code !== "rate_limit") return;
    await withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        const source = (await lockLinearSources(tx, [connectionId])).get(connectionId);
        if (!source || source.revision !== revision) return;
        if (failure.code === "auth") {
          if (source.connection.status !== "connected") return;
          await tx.connection.update({ where: { id: connectionId }, data: { status: "error" } });
          await tx.linearSource.update({
            where: { connectionId },
            data: {
              revision: { increment: 1 },
              errorCode: "auth",
              errorCount: { increment: 1 },
              nextPollAt: null,
              nextSyncAt: null,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          return;
        }
        const now = await linearDatabaseNow(tx);
        const retryAt = failure.retryAt ? new Date(failure.retryAt) : null;
        const fallback = new Date(now.getTime() + RATE_LIMIT_FALLBACK_MS);
        const candidate =
          retryAt && Number.isFinite(retryAt.getTime()) && retryAt > now ? retryAt : fallback;
        const deadline =
          source.rateLimitedUntil && source.rateLimitedUntil > candidate
            ? source.rateLimitedUntil
            : candidate;
        await tx.linearSource.update({
          where: { connectionId },
          data: {
            rateLimitedUntil: deadline,
            ...(source.nextPollAt && source.nextPollAt < deadline ? { nextPollAt: deadline } : {}),
          },
        });
      }),
    ).catch((error) => {
      getLogger().error("linear metadata failure record failed", error, { connectionId });
    });
  }

  async function storedKeyCall<T>(
    source: OwnedLinearSource,
    signal: AbortSignal,
    call: (credential: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (source.rateLimitedUntil && source.rateLimitedUntil.getTime() > Date.now()) {
      throw new LinearServiceError("SERVICE_UNAVAILABLE", LINEAR_MESSAGES.unavailable);
    }
    const bounded = boundedSignal(signal, deps.signal);
    try {
      const credential = await readLinearCredential(prisma, secrets, source);
      return await call(credential, bounded);
    } catch (error) {
      if (error instanceof LinearServiceError) throw error;
      const failure = failureOf(error);
      if (failure) await recordStoredKeyFailure(source.connectionId, source.revision, failure);
      if (failure?.code === "auth") {
        throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.checkKey);
      }
      if (failure?.code === "invalid_cursor") {
        throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.chooseOption);
      }
      if (failure || bounded.aborted) {
        throw new LinearServiceError("SERVICE_UNAVAILABLE", LINEAR_MESSAGES.unavailable);
      }
      throw error;
    }
  }

  async function assertRevisionUnchanged(connectionId: string, revision: number): Promise<void> {
    const current = await prisma.$transaction(async (tx) =>
      (await lockLinearSources(tx, [connectionId])).get(connectionId),
    );
    if (!current || current.revision !== revision) {
      throw new LinearServiceError("CONFLICT", LINEAR_MESSAGES.changed);
    }
  }

  async function verifyOptionIds(
    credential: string,
    signal: AbortSignal,
    kind: IssueTrackerOptionKind,
    teamId: string | undefined,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const missing = new Set(ids);
    let cursor: string | undefined;
    for (;;) {
      const page = await provider.options(
        credential,
        { kind, ids, ...(teamId ? { teamId } : {}), ...(cursor ? { cursor } : {}) },
        signal,
      );
      for (const item of page.items) missing.delete(item.id);
      if (missing.size === 0 || !page.nextCursor || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
    if (missing.size > 0) {
      throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.chooseOption);
    }
  }

  async function buildStatus(
    source: OwnedLinearSource,
  ): Promise<LinearConnectionStatus> {
    const owner = {
      connectionId: source.connectionId,
      spaceId: source.connection.spaceId,
      userId: source.connection.userId,
    };
    const errorCode = safeErrorCode(source.errorCode);
    const connectionStatus = source.connection.status as ConnectionStatus;
    const eligible =
      connectionStatus === "connected" && source.monitoringSince
        ? await prisma.routineLinearTrigger.count({ where: eligibleLinearTriggerWhere(owner) })
        : 0;
    const monitoring: LinearConnectionStatus["monitoring"] =
      connectionStatus === "error" || errorCode === "auth"
        ? "error"
        : eligible === 0
          ? "idle"
          : errorCode === "unavailable" || errorCode === "invalid_response"
            ? "error"
            : "polling";
    return {
      connectionId: source.connectionId,
      revision: source.revision,
      organizationName: source.organizationName,
      viewerId: source.viewerId,
      connectionStatus,
      monitoring,
      webhookConfigured: source.webhookSecretId !== null,
      webhookUrl: linearWebhookUrl(deps.apiUrl, source.connectionId),
      lastPolledAt: iso(source.lastPolledAt),
      lastWebhookAt: iso(source.lastWebhookAt),
      lastEventAt: iso(source.lastEventAt),
      nextPollAt: iso(source.nextPollAt),
      nextSyncAt: iso(source.nextSyncAt),
      rateLimitedUntil: iso(source.rateLimitedUntil),
      errorCode,
    };
  }

  async function verifyIdentity(apiKey: string, signal: AbortSignal) {
    const bounded = boundedSignal(signal, deps.signal);
    try {
      return await provider.identity(apiKey, bounded);
    } catch (error) {
      const failure = failureOf(error);
      if (failure?.code === "auth") {
        throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.checkKey);
      }
      if (failure || bounded.aborted) {
        throw new LinearServiceError("SERVICE_UNAVAILABLE", LINEAR_MESSAGES.unavailable);
      }
      throw error;
    }
  }

  return {
    async connect(actor, input, signal) {
      const existing = input.connectionId ? await ownedSource(actor, input.connectionId) : null;
      if (input.connectionId) {
        if (!existing) throw new IsolationError();
        if (existing.revision !== input.expectedRevision) {
          throw new LinearServiceError("CONFLICT", LINEAR_MESSAGES.changed);
        }
      }
      const identity = await verifyIdentity(input.apiKey, signal);
      if (
        existing &&
        (identity.organizationId !== existing.organizationId ||
          identity.viewerId !== existing.viewerId)
      ) {
        throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.differentAccount);
      }
      const stored = await secrets.put(input.apiKey, {
        operationId: "linear.connect",
        traceId: "linear.connect",
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal,
      });
      const outcome = await persistPreparedSecret(prisma, secrets, stored, () =>
        withTransactionRetry(() =>
          prisma.$transaction(async (tx) => {
            await lockOwnerMembership(tx, actor);
            await lockLinearProviderScope(tx, actor);
            const secretData = {
              id: stored.id,
              userId: actor.userId,
              spaceId: actor.spaceId,
              kind: "connector",
              ciphertext: stored.ciphertext,
            };
            if (!existing) {
              await tx.secret.create({ data: secretData });
              const connection = await tx.connection.create({
                data: {
                  spaceId: actor.spaceId,
                  userId: actor.userId,
                  connectorId: LINEAR_CONNECTOR_ID,
                  provider: LINEAR_PROVIDER,
                  displayName: input.displayName,
                  status: "connected",
                  secretId: stored.id,
                  metadata: {},
                },
              });
              await tx.linearSource.create({
                data: {
                  connectionId: connection.id,
                  organizationId: identity.organizationId,
                  organizationName: identity.organizationName,
                  viewerId: identity.viewerId,
                },
              });
              return { connection, enqueue: false, cancelled: null };
            }
            const connectionId = existing.connectionId;
            const source = (await lockLinearSources(tx, [connectionId])).get(connectionId);
            if (
              !source ||
              source.connection.spaceId !== actor.spaceId ||
              source.connection.userId !== actor.userId
            ) {
              throw new IsolationError();
            }
            if (source.revision !== input.expectedRevision) {
              throw new LinearServiceError("CONFLICT", LINEAR_MESSAGES.changed);
            }
            if (
              source.organizationId !== identity.organizationId ||
              source.viewerId !== identity.viewerId
            ) {
              throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.differentAccount);
            }
            const previousSecretId = source.connection.secretId;
            await tx.secret.create({ data: secretData });
            const connection = await tx.connection.update({
              where: { id: connectionId },
              data: { displayName: input.displayName, status: "connected", secretId: stored.id },
            });
            if (previousSecretId && previousSecretId !== stored.id) {
              await tx.secret.deleteMany({
                where: { id: previousSecretId, userId: actor.userId, spaceId: actor.spaceId },
              });
            }
            await tx.linearSource.update({
              where: { connectionId },
              data: {
                generation: { increment: 1 },
                organizationName: identity.organizationName,
                errorCode: null,
                errorCount: 0,
                monitoringSince: null,
                issueWindowEnd: null,
                commentWindowEnd: null,
                issueCursor: null,
                commentCursor: null,
                leaseToken: null,
                leaseExpiresAt: null,
              },
            });
            const now = await linearDatabaseNow(tx);
            await tx.$queryRaw`
              SELECT "routineId" FROM routine_linear_triggers
              WHERE "connectionId" = ${connectionId}
              ORDER BY "routineId" FOR UPDATE`;
            await tx.routineLinearTrigger.updateMany({
              where: { connectionId, activatedAt: { not: null } },
              data: { activatedAt: now, revision: { increment: 1 } },
            });
            await discardPendingLinearEvents(tx, connectionId);
            const cancelled = await cancelSourceRuns(tx, connectionId, now);
            const { enqueue } = await refreshLinearSourceMonitoring(tx, connectionId);
            return { connection, enqueue, cancelled };
          }),
        ),
      );
      await settleCancelledRuns(outcome.cancelled);
      if (outcome.enqueue) await enqueueSync(outcome.connection.id);
      return connectionDto(outcome.connection);
    },

    async status(actor, input) {
      const source = await ownedSource(actor, input.connectionId);
      if (!source) throw new IsolationError();
      return buildStatus(source);
    },

    async options(actor, input, signal) {
      const source = await ownedSource(actor, input.connectionId);
      if (!source) throw new IsolationError();
      if (source.connection.status !== "connected") {
        throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.checkKey);
      }
      const page = await storedKeyCall(source, signal, (credential, bounded) =>
        provider.options(
          credential,
          {
            kind: input.kind,
            ...(input.teamId ? { teamId: input.teamId } : {}),
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          bounded,
        ),
      );
      await assertRevisionUnchanged(source.connectionId, source.revision);
      return {
        items: page.items.map((item) => ({ id: item.id, name: item.name })),
        nextCursor: page.nextCursor,
      };
    },

    async configureWebhook(actor, input) {
      const snapshot = await ownedSource(actor, input.connectionId);
      if (!snapshot) throw new IsolationError();
      if (snapshot.revision !== input.expectedRevision) {
        throw new LinearServiceError("CONFLICT", LINEAR_MESSAGES.changed);
      }
      if (input.signingSecret !== null) {
        if (snapshot.connection.status === "revoked") {
          throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.reconnect);
        }
        if (!linearWebhookUrl(deps.apiUrl, snapshot.connectionId)) {
          throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.webhookOrigin);
        }
      }
      const stored =
        input.signingSecret === null
          ? undefined
          : await secrets.put(input.signingSecret, {
              operationId: "linear.configureWebhook",
              traceId: "linear.configureWebhook",
              spaceId: actor.spaceId,
              userId: actor.userId,
              signal: deps.signal,
            });
      await persistPreparedSecret(prisma, secrets, stored, () =>
        withTransactionRetry(() =>
          prisma.$transaction(async (tx) => {
            await lockOwnerMembership(tx, actor);
            await lockLinearProviderScope(tx, actor);
            const connectionId = snapshot.connectionId;
            const source = (await lockLinearSources(tx, [connectionId])).get(connectionId);
            if (
              !source ||
              source.connection.spaceId !== actor.spaceId ||
              source.connection.userId !== actor.userId
            ) {
              throw new IsolationError();
            }
            if (source.revision !== input.expectedRevision) {
              throw new LinearServiceError("CONFLICT", LINEAR_MESSAGES.changed);
            }
            if (stored && source.connection.status === "revoked") {
              throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.reconnect);
            }
            const previousSecretId = source.webhookSecretId;
            if (stored) {
              await tx.secret.create({
                data: {
                  id: stored.id,
                  userId: actor.userId,
                  spaceId: actor.spaceId,
                  kind: "webhook",
                  ciphertext: stored.ciphertext,
                },
              });
            }
            await tx.linearSource.update({
              where: { connectionId },
              data: {
                webhookSecretId: stored ? stored.id : null,
                revision: { increment: 1 },
                webhookRevision: { increment: 1 },
                leaseToken: null,
                leaseExpiresAt: null,
              },
            });
            if (previousSecretId) {
              await tx.secret.deleteMany({
                where: { id: previousSecretId, userId: actor.userId, spaceId: actor.spaceId },
              });
            }
          }),
        ),
      );
      const updated = await ownedSource(actor, input.connectionId);
      if (!updated) throw new IsolationError();
      return buildStatus(updated);
    },

    async revoke(actor, input) {
      const outcome = await withTransactionRetry(() =>
        prisma.$transaction(async (tx) => {
          await lockOwnerMembership(tx, actor);
          await lockLinearProviderScope(tx, actor);
          const source = (await lockLinearSources(tx, [input.connectionId])).get(
            input.connectionId,
          );
          if (
            !source ||
            source.connection.spaceId !== actor.spaceId ||
            source.connection.userId !== actor.userId
          ) {
            const connection = await tx.connection.findFirst({
              where: {
                id: input.connectionId,
                spaceId: actor.spaceId,
                userId: actor.userId,
                connectorId: LINEAR_CONNECTOR_ID,
              },
              select: { id: true, secretId: true },
            });
            if (!connection) return null;
            await tx.connection.update({
              where: { id: connection.id },
              data: { status: "revoked", secretId: null },
            });
            if (connection.secretId) {
              await tx.secret.deleteMany({
                where: { id: connection.secretId, userId: actor.userId, spaceId: actor.spaceId },
              });
            }
            return null;
          }
          const connectionId = source.connectionId;
          const ownedSecretIds = [source.connection.secretId, source.webhookSecretId].filter(
            (id): id is string => Boolean(id),
          );
          await tx.connection.update({
            where: { id: connectionId },
            data: { status: "revoked", secretId: null },
          });
          await tx.linearSource.update({
            where: { connectionId },
            data: {
              generation: { increment: 1 },
              webhookRevision: { increment: 1 },
              webhookSecretId: null,
              errorCode: null,
              errorCount: 0,
            },
          });
          await refreshLinearSourceMonitoring(tx, connectionId);
          const cancelled = await cancelSourceRuns(tx, connectionId, await linearDatabaseNow(tx));
          if (ownedSecretIds.length > 0) {
            await tx.secret.deleteMany({
              where: { id: { in: ownedSecretIds }, userId: actor.userId, spaceId: actor.spaceId },
            });
          }
          return cancelled;
        }),
      );
      await jobs.cancel(linearSyncJobKey(input.connectionId)).catch(() => undefined);
      return { cancelledRunIds: await settleCancelledRuns(outcome) };
    },

    async validateTrigger(actor, trigger, signal) {
      const source = await ownedSource(actor, trigger.connectionId);
      if (source?.connection.status !== "connected") {
        throw new LinearServiceError("BAD_REQUEST", LINEAR_MESSAGES.chooseOption);
      }
      await storedKeyCall(source, signal, async (credential, bounded) => {
        await verifyOptionIds(credential, bounded, "teams", undefined, [trigger.teamId]);
        await Promise.all([
          verifyOptionIds(
            credential,
            bounded,
            "projects",
            trigger.teamId,
            trigger.projectId ? [trigger.projectId] : [],
          ),
          verifyOptionIds(
            credential,
            bounded,
            "assignees",
            trigger.teamId,
            trigger.assigneeId ? [trigger.assigneeId] : [],
          ),
          verifyOptionIds(
            credential,
            bounded,
            "states",
            trigger.teamId,
            trigger.stateId ? [trigger.stateId] : [],
          ),
          verifyOptionIds(credential, bounded, "labels", trigger.teamId, trigger.labelIds),
        ]);
      });
      return { sourceRevision: source.revision };
    },
  };
}
