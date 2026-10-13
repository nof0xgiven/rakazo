import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  IssueTrackerComment,
  IssueTrackerEventSeed,
  IssueTrackerIssue,
  JobPublisher,
  SecretStore,
} from "@rakazo/adapter-kit";
import { canonicalOccurrence, linearSyncJob } from "@rakazo/adapter-kit";
import {
  eligibleLinearTriggerWhere,
  LINEAR_PUBLIC_HOSTS,
  lockLinearSources,
  recordLinearEvent,
} from "@rakazo/adapters";
import { LINEAR_CONNECTOR_ID } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { withTransactionRetry } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { readBoundedBytes } from "./http-body.js";

export const LINEAR_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
export const LINEAR_WEBHOOK_TOLERANCE_MS = 60_000;
const LINEAR_WEBHOOK_SECRET_KIND = "webhook";
const MAX_DELIVERY_ID_LENGTH = 200;
const MAX_PROVIDER_ID_LENGTH = 100;
const MAX_URL_LENGTH = 2048;
const SECRET_CACHE_MAX = 1_000;
const SECRET_CACHE_TTL_MS = 30_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export const LINEAR_WEBHOOK_RESPONSE_BUDGET_MS = 4_000;
const COMMIT_RESERVE_MS = 250;
const MIN_TRANSACTION_MS = 250;

class IngressDeadlineExceeded extends Error {}

function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new IngressDeadlineExceeded()),
      Math.max(0, deadline - Date.now()),
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type LinearWebhookDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  jobs: Pick<JobPublisher, "enqueue">;
};

export function linearWebhookPath(connectionId: string): string {
  return `/api/integrations/linear/${connectionId}/webhook`;
}

export function hasValidLinearSignature(
  signature: string | undefined,
  secret: string,
  raw: Uint8Array,
): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected);
}

class MalformedDelivery extends Error {}

function malformed(): never {
  throw new MalformedDelivery();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : malformed();
}

function providerId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROVIDER_ID_LENGTH
    ? value
    : malformed();
}

function nullableProviderId(value: unknown): string | null {
  return value === null || value === undefined ? null : providerId(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : malformed();
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) malformed();
  try {
    return canonicalOccurrence(value);
  } catch {
    return malformed();
  }
}

function linearUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    LINEAR_PUBLIC_HOSTS.includes(url.hostname)
    ? url.toString()
    : null;
}

function issueSeed(
  action: "create" | "update",
  envelopeUrl: unknown,
  data: Record<string, unknown>,
): IssueTrackerEventSeed | null {
  const issue: IssueTrackerIssue = {
    id: providerId(data.id),
    identifier: providerId(data.identifier),
    title: text(data.title),
    description:
      data.description === null || data.description === undefined ? null : text(data.description),
    url: linearUrl(envelopeUrl) ?? linearUrl(data.url),
    createdAt: timestamp(data.createdAt),
    updatedAt: timestamp(data.updatedAt),
    teamId: providerId(data.teamId),
    projectId: nullableProviderId(data.projectId),
    assigneeId: nullableProviderId(data.assigneeId),
    stateId: nullableProviderId(data.stateId),
    labelIds: Array.isArray(data.labelIds) ? data.labelIds.map(providerId) : malformed(),
  };
  if (action === "update" && issue.updatedAt === issue.createdAt) return null;
  return {
    kind: action === "create" ? "issue.created" : "issue.updated",
    entityId: issue.id,
    issueId: issue.id,
    occurredAt: action === "create" ? issue.createdAt : issue.updatedAt,
    issue,
  };
}

function commentSeed(
  envelopeUrl: unknown,
  data: Record<string, unknown>,
): IssueTrackerEventSeed | null {
  const id = providerId(data.id);
  if (data.issueId === null || data.issueId === undefined) return null;
  const issueId = providerId(data.issueId);
  const comment: IssueTrackerComment = {
    id,
    body: text(data.body),
    url: linearUrl(envelopeUrl) ?? linearUrl(data.url),
    createdAt: timestamp(data.createdAt),
    authorId: nullableProviderId(data.userId),
  };
  return { kind: "comment.created", entityId: id, issueId, occurredAt: comment.createdAt, comment };
}

function extractSeed(
  type: string,
  action: string,
  envelope: Record<string, unknown>,
): IssueTrackerEventSeed | null {
  if (type === "Issue" && (action === "create" || action === "update")) {
    return issueSeed(action, envelope.url, record(envelope.data));
  }
  if (type === "Comment" && action === "create")
    return commentSeed(envelope.url, record(envelope.data));
  return null;
}

type CachedSecret = {
  secretId: string;
  ciphertext: string;
  plaintext: Promise<string>;
  expires: number;
};

type LoadSigningSecret = (
  connectionId: string,
  secret: { id: string; ciphertext: string },
  deadline: number,
) => Promise<string>;

function createSecretCache(secrets: SecretStore): LoadSigningSecret {
  const cache = new Map<string, CachedSecret>();
  secrets.onChange((ref) => {
    for (const [connectionId, entry] of cache)
      if (entry.ciphertext === ref) cache.delete(connectionId);
  });
  return (connectionId, secret, deadline) => {
    const now = Date.now();
    const cached = cache.get(connectionId);
    let entry =
      cached?.secretId === secret.id &&
      cached.ciphertext === secret.ciphertext &&
      cached.expires > now
        ? cached
        : undefined;
    if (!entry) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), Math.max(0, deadline - now));
      const created: CachedSecret = {
        secretId: secret.id,
        ciphertext: secret.ciphertext,
        plaintext: secrets
          .load(secret.ciphertext, { recordId: secret.id, signal: abort.signal })
          .finally(() => clearTimeout(timer)),
        expires: now + SECRET_CACHE_TTL_MS,
      };
      created.plaintext.catch(() => {
        if (cache.get(connectionId) === created) cache.delete(connectionId);
      });
      entry = created;
    }
    cache.delete(connectionId);
    cache.set(connectionId, entry);
    if (cache.size > SECRET_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return entry.plaintext;
  };
}

type WebhookTarget = {
  connectionId: string;
  userId: string;
  spaceId: string;
  organizationId: string;
  generation: number;
  webhookRevision: number;
  secretId: string;
  signingSecret: string;
};

async function loadTarget(
  deps: LinearWebhookDeps,
  loadSecret: LoadSigningSecret,
  connectionId: string,
  deadline: number,
): Promise<WebhookTarget | null> {
  const source = await deps.prisma.linearSource.findUnique({
    where: { connectionId },
    select: {
      connectionId: true,
      organizationId: true,
      generation: true,
      webhookRevision: true,
      connection: { select: { connectorId: true, status: true, userId: true, spaceId: true } },
      webhookSecret: {
        select: { id: true, ciphertext: true, kind: true, userId: true, spaceId: true },
      },
    },
  });
  const secret = source?.webhookSecret;
  if (
    !source ||
    !secret ||
    source.connection.connectorId !== LINEAR_CONNECTOR_ID ||
    source.connection.status === "revoked" ||
    secret.kind !== LINEAR_WEBHOOK_SECRET_KIND ||
    secret.userId !== source.connection.userId ||
    secret.spaceId !== source.connection.spaceId
  ) {
    return null;
  }
  return {
    connectionId: source.connectionId,
    userId: source.connection.userId,
    spaceId: source.connection.spaceId,
    organizationId: source.organizationId,
    generation: source.generation,
    webhookRevision: source.webhookRevision,
    secretId: secret.id,
    signingSecret: await loadSecret(source.connectionId, secret, deadline),
  };
}

type IngressOutcome = "accepted" | "duplicate" | "ignored" | "gone" | "stale";

async function recordDelivery(
  deps: LinearWebhookDeps,
  target: WebhookTarget,
  seed: IssueTrackerEventSeed,
  deliveryId: string,
  receivedAt: Date,
  deadline: number,
): Promise<IngressOutcome> {
  return withTransactionRetry(() => {
    const budget = deadline - COMMIT_RESERVE_MS - Date.now();
    if (budget < MIN_TRANSACTION_MS) return Promise.reject(new IngressDeadlineExceeded());
    const maxWait = Math.min(1_000, Math.floor(budget / 2));
    const timeout = budget - maxWait;
    return deps.prisma.$transaction(
      async (tx): Promise<IngressOutcome> => {
        await tx.$executeRaw`
          SELECT set_config('statement_timeout', ${String(timeout)}, true),
                 set_config('lock_timeout', ${String(timeout)}, true)
        `;
        const membership = await tx.$queryRaw<Array<{ locked: number }>>`
          SELECT 1 AS locked FROM "space_members"
          WHERE "spaceId" = ${target.spaceId} AND "userId" = ${target.userId}
          FOR SHARE
        `;
        const source = (await lockLinearSources(tx, [target.connectionId])).get(
          target.connectionId,
        );
        if (!source || source.connection.status === "revoked" || source.webhookSecretId === null) {
          return "gone";
        }
        if (
          source.webhookSecretId !== target.secretId ||
          source.webhookRevision !== target.webhookRevision ||
          source.generation !== target.generation ||
          source.organizationId !== target.organizationId ||
          source.connection.userId !== target.userId ||
          source.connection.spaceId !== target.spaceId
        ) {
          return "stale";
        }
        if (
          membership.length === 0 ||
          source.connection.status !== "connected" ||
          source.errorCode === "auth"
        ) {
          return "ignored";
        }
        const occurredAt = new Date(seed.occurredAt);
        if (!source.monitoringSince || occurredAt <= source.monitoringSince) return "ignored";
        const subscription = await tx.routineLinearTrigger.findFirst({
          where: {
            AND: [
              eligibleLinearTriggerWhere({
                connectionId: source.connectionId,
                spaceId: source.connection.spaceId,
                userId: source.connection.userId,
              }),
              { events: { has: seed.kind }, activatedAt: { lt: occurredAt } },
            ],
          },
          select: { routineId: true },
        });
        if (!subscription) return "ignored";
        const result = await recordLinearEvent(tx, source, {
          transport: "webhook",
          seed,
          deliveryId,
          receivedAt,
        });
        if (result !== "ignored") {
          await tx.linearSource.update({
            where: { connectionId: target.connectionId },
            data: { lastWebhookAt: new Date() },
          });
        }
        if (Date.now() > deadline - COMMIT_RESERVE_MS) throw new IngressDeadlineExceeded();
        return result;
      },
      { maxWait, timeout },
    );
  });
}

function ignored(c: Context) {
  return c.json({ ok: true, ignored: true });
}

export function mountLinearWebhookHttpRoutes(app: Hono, deps: LinearWebhookDeps): void {
  const loadSecret = createSecretCache(deps.secrets);

  app.post("/api/integrations/linear/:connectionId/webhook", async (c) => {
    const receivedAt = new Date();
    const deadline = receivedAt.getTime() + LINEAR_WEBHOOK_RESPONSE_BUDGET_MS;
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);
    const badRequest = () => c.json({ error: "Bad request" }, 400);
    const notFound = () => c.json({ error: "Not found" }, 404);
    const unavailable = () => c.json({ error: "Service unavailable" }, 503);

    const upload = new AbortController();
    const uploadTimer = setTimeout(() => upload.abort(), LINEAR_WEBHOOK_RESPONSE_BUDGET_MS);
    let raw: Uint8Array | null;
    try {
      raw = await readBoundedBytes(c.req.raw, LINEAR_WEBHOOK_MAX_BODY_BYTES, upload.signal);
    } catch (error) {
      if (upload.signal.aborted) return unavailable();
      throw error;
    } finally {
      clearTimeout(uploadTimer);
    }
    if (raw === null) return c.json({ error: "Payload too large" }, 413);

    let target: WebhookTarget | null;
    try {
      target = await beforeDeadline(
        loadTarget(deps, loadSecret, c.req.param("connectionId"), deadline),
        deadline,
      );
    } catch (error) {
      getLogger().error("linear webhook target unavailable", error);
      return unavailable();
    }
    if (!target) return notFound();
    if (!hasValidLinearSignature(c.req.header("linear-signature"), target.signingSecret, raw)) {
      return unauthorized();
    }

    let envelope: Record<string, unknown>;
    try {
      envelope = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
    } catch {
      return badRequest();
    }

    const webhookTimestamp = envelope.webhookTimestamp;
    if (typeof webhookTimestamp !== "number" || !Number.isFinite(webhookTimestamp)) {
      return badRequest();
    }
    const age = Date.now() - webhookTimestamp;
    if (age < -LINEAR_WEBHOOK_TOLERANCE_MS) return unauthorized();
    if (envelope.organizationId !== target.organizationId) return unauthorized();
    if (age > LINEAR_WEBHOOK_TOLERANCE_MS) return ignored(c);

    const deliveryId = c.req.header("linear-delivery");
    if (!deliveryId || deliveryId.length > MAX_DELIVERY_ID_LENGTH) return badRequest();
    const eventType = envelope.type;
    const action = envelope.action;
    if (
      typeof eventType !== "string" ||
      typeof action !== "string" ||
      c.req.header("linear-event") !== eventType
    ) {
      return badRequest();
    }

    let seed: IssueTrackerEventSeed | null;
    try {
      seed = extractSeed(eventType, action, envelope);
    } catch (error) {
      if (error instanceof MalformedDelivery) return badRequest();
      throw error;
    }
    if (!seed) return ignored(c);

    let outcome: IngressOutcome;
    try {
      outcome = await recordDelivery(deps, target, seed, deliveryId, receivedAt, deadline);
    } catch (error) {
      getLogger().error("linear webhook record failed", error);
      return unavailable();
    }
    if (outcome === "gone") return notFound();
    if (outcome === "stale") return unavailable();
    if (outcome === "ignored") return ignored(c);
    if (outcome === "accepted") {
      void deps.jobs
        .enqueue(linearSyncJob({ connectionId: target.connectionId }))
        .catch((error: unknown) => {
          getLogger().error("linear sync enqueue error", error);
        });
    }
    return c.json({ ok: true });
  });
}
