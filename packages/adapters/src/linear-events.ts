import { createHash } from "node:crypto";
import type {
  IssueTrackerComment,
  IssueTrackerEvent,
  IssueTrackerEventKind,
  IssueTrackerEventSeed,
  IssueTrackerIssue,
} from "@rakazo/adapter-kit";
import { canonicalOccurrence, IssueTrackerError, issueTrackerEventKey } from "@rakazo/adapter-kit";
import { formatUntrustedDeliveryPayload } from "@rakazo/core";
import { Prisma, type RoutineLinearTrigger } from "@rakazo/db";
import {
  eligibleLinearTriggerWhere,
  type LinearTx,
  type LockedLinearSource,
} from "./linear-lifecycle.js";
import { LINEAR_PUBLIC_HOSTS } from "./linear-provider.js";

export type RoutineLinearTriggerRow = Pick<
  RoutineLinearTrigger,
  "teamId" | "events" | "projectId" | "assigneeId" | "stateId" | "labelIds" | "activatedAt"
>;

const EVENT_LABELS: Record<IssueTrackerEventKind, string> = {
  "issue.created": "[Linear Event: issue.created]",
  "issue.updated": "[Linear Event: issue.updated]",
  "comment.created": "[Linear Event: comment.created]",
};

const TITLE_LIMIT = 1_000;
const DESCRIPTION_LIMIT = 12_000;
const COMMENT_BODY_LIMIT = 8_000;
const NAME_LIMIT = 200;
const URL_LIMIT = 2_048;

type EventIdentity = {
  kind: IssueTrackerEventKind;
  key: string;
  entityId: string;
  issueId: string;
  occurredAt: Date;
};

function eventIdentity(event: IssueTrackerEvent): EventIdentity {
  if (!(event.kind in EVENT_LABELS)) invalidResponse();
  const entityId = event.kind === "comment.created" ? event.comment?.id : event.issue.id;
  if (!entityId) invalidResponse();
  const occurredAt = canonicalOccurrence(event.occurredAt);
  return {
    kind: event.kind,
    key: issueTrackerEventKey(event.kind, entityId, occurredAt),
    entityId,
    issueId: event.issue.id,
    occurredAt: new Date(occurredAt),
  };
}

function seedIdentity(seed: IssueTrackerEventSeed): EventIdentity {
  if (!(seed.kind in EVENT_LABELS)) invalidResponse();
  const occurredAt = canonicalOccurrence(seed.occurredAt);
  return {
    kind: seed.kind,
    key: issueTrackerEventKey(seed.kind, seed.entityId, occurredAt),
    entityId: seed.entityId,
    issueId: seed.issueId,
    occurredAt: new Date(occurredAt),
  };
}

function invalidResponse(): never {
  throw new IssueTrackerError({ code: "invalid_response", retryAt: null });
}

/** Authorized observation of a webhook seed. The signed after-state or comment body is never replaced. */
export function linearSnapshotFromSeed(
  seed: IssueTrackerEventSeed,
  observed: IssueTrackerEvent,
): IssueTrackerEvent | null {
  const identity = seedIdentity(seed);
  if (observed.issue.id !== seed.issueId || observed.kind !== seed.kind) return null;
  if (seed.kind === "comment.created") {
    if (observed.comment?.id !== seed.entityId) return null;
    return {
      kind: seed.kind,
      key: identity.key,
      occurredAt: identity.occurredAt.toISOString(),
      issue: observed.issue,
      comment: seed.comment,
    };
  }
  return {
    kind: seed.kind,
    key: identity.key,
    occurredAt: identity.occurredAt.toISOString(),
    issue: seed.issue,
    comment: null,
  };
}

export function parseLinearSeed(value: Prisma.JsonValue | null): IssueTrackerEventSeed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seed = value as Record<string, unknown>;
  if (typeof seed.kind !== "string" || !(seed.kind in EVENT_LABELS)) return null;
  if (typeof seed.entityId !== "string" || typeof seed.issueId !== "string") return null;
  if (typeof seed.occurredAt !== "string") return null;
  if (seed.kind === "comment.created" ? !isObject(seed.comment) : !isObject(seed.issue)) return null;
  return value as unknown as IssueTrackerEventSeed;
}

export function parseLinearSnapshot(value: Prisma.JsonValue | null): IssueTrackerEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (typeof event.kind !== "string" || !(event.kind in EVENT_LABELS)) return null;
  if (typeof event.key !== "string" || typeof event.occurredAt !== "string") return null;
  if (!isObject(event.issue)) return null;
  if (event.kind === "comment.created" && !isObject(event.comment)) return null;
  return value as unknown as IssueTrackerEvent;
}

function isObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(value: IssueTrackerEvent | IssueTrackerEventSeed): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

export async function recordLinearEvent(
  tx: LinearTx,
  source: LockedLinearSource,
  input:
    | { transport: "poll"; event: IssueTrackerEvent; receivedAt: Date }
    | { transport: "webhook"; seed: IssueTrackerEventSeed; deliveryId: string; receivedAt: Date },
): Promise<"accepted" | "duplicate" | "ignored"> {
  const identity = input.transport === "poll" ? eventIdentity(input.event) : seedIdentity(input.seed);
  const existing = await tx.linearEvent.findUnique({
    where: {
      connectionId_eventKey: { connectionId: source.connectionId, eventKey: identity.key },
    },
    select: {
      id: true,
      status: true,
      sourceGeneration: true,
      entityId: true,
      issueId: true,
      seed: true,
      snapshot: true,
    },
  });
  if (existing) {
    if (
      input.transport === "poll" &&
      existing.status === "pending" &&
      existing.sourceGeneration === source.generation &&
      existing.snapshot === null &&
      existing.entityId === identity.entityId &&
      existing.issueId === identity.issueId
    ) {
      const seed = parseLinearSeed(existing.seed);
      const snapshot = seed ? linearSnapshotFromSeed(seed, input.event) : null;
      if (snapshot) {
        await tx.linearEvent.updateMany({
          where: {
            id: existing.id,
            status: "pending",
            sourceGeneration: source.generation,
            snapshot: { equals: Prisma.DbNull },
          },
          data: { snapshot: jsonValue(snapshot), nextAttemptAt: input.receivedAt },
        });
      }
    }
    return "duplicate";
  }

  if (!source.monitoringSince || identity.occurredAt <= source.monitoringSince) return "ignored";
  const subscription = await tx.routineLinearTrigger.findFirst({
    where: {
      AND: [
        eligibleLinearTriggerWhere({
          connectionId: source.connectionId,
          spaceId: source.connection.spaceId,
          userId: source.connection.userId,
        }),
        { events: { has: identity.kind }, activatedAt: { lt: identity.occurredAt } },
      ],
    },
    select: { routineId: true },
  });
  if (!subscription) return "ignored";

  await tx.linearEvent.create({
    data: {
      connectionId: source.connectionId,
      sourceGeneration: source.generation,
      eventKey: identity.key,
      kind: identity.kind,
      entityId: identity.entityId,
      issueId: identity.issueId,
      occurredAt: identity.occurredAt,
      receivedAt: input.receivedAt,
      transport: input.transport,
      deliveryId: input.transport === "webhook" ? input.deliveryId : null,
      seed: input.transport === "webhook" ? jsonValue(input.seed) : Prisma.DbNull,
      snapshot: input.transport === "poll" ? jsonValue(input.event) : Prisma.DbNull,
      status: "pending",
      nextAttemptAt: input.receivedAt,
    },
  });
  await tx.linearSource.updateMany({
    where: {
      connectionId: source.connectionId,
      OR: [{ lastEventAt: null }, { lastEventAt: { lt: identity.occurredAt } }],
    },
    data: { lastEventAt: identity.occurredAt },
  });
  if (input.transport === "webhook") {
    await tx.linearSource.updateMany({
      where: {
        connectionId: source.connectionId,
        OR: [{ nextSyncAt: null }, { nextSyncAt: { gt: input.receivedAt } }],
      },
      data: { nextSyncAt: input.receivedAt },
    });
  }
  return "accepted";
}

export function matchLinearTrigger(
  trigger: RoutineLinearTriggerRow,
  event: IssueTrackerEvent,
): boolean {
  if (!trigger.activatedAt) return false;
  const occurredAt = Date.parse(event.occurredAt);
  if (!Number.isFinite(occurredAt) || occurredAt <= trigger.activatedAt.getTime()) return false;
  if (!trigger.events.includes(event.kind)) return false;
  const issue = event.issue;
  if (issue.teamId !== trigger.teamId) return false;
  if (trigger.projectId !== null && issue.projectId !== trigger.projectId) return false;
  if (trigger.assigneeId !== null && issue.assigneeId !== trigger.assigneeId) return false;
  if (trigger.stateId !== null && issue.stateId !== trigger.stateId) return false;
  return trigger.labelIds.every((labelId) => issue.labelIds.includes(labelId));
}

export function buildLinearTaskPrompt(routinePrompt: string, event: IssueTrackerEvent): string {
  const label = EVENT_LABELS[event.kind];
  if (!label) invalidResponse();
  return [
    routinePrompt.trim(),
    formatUntrustedDeliveryPayload(label, {
      event: event.kind,
      occurredAt: event.occurredAt,
      issue: issuePayload(event.issue),
      comment: event.comment ? commentPayload(event.comment) : null,
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function issuePayload(issue: IssueTrackerIssue) {
  const identifier = bounded(issue.identifier, NAME_LIMIT);
  const title = bounded(issue.title, TITLE_LIMIT);
  const description = issue.description === null ? null : bounded(issue.description, DESCRIPTION_LIMIT);
  return {
    id: issue.id,
    identifier: identifier.value,
    identifierTruncated: identifier.truncated,
    title: title.value,
    titleTruncated: title.truncated,
    description: description?.value ?? null,
    descriptionTruncated: description?.truncated ?? false,
    url: linearPublicUrl(issue.url),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    teamId: issue.teamId,
    projectId: issue.projectId,
    assigneeId: issue.assigneeId,
    stateId: issue.stateId,
    labelIds: issue.labelIds,
  };
}

function commentPayload(comment: IssueTrackerComment) {
  const body = bounded(comment.body, COMMENT_BODY_LIMIT);
  return {
    id: comment.id,
    body: body.value,
    bodyTruncated: body.truncated,
    url: linearPublicUrl(comment.url),
    createdAt: comment.createdAt,
    authorId: comment.authorId,
  };
}

function bounded(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) return { value, truncated: false };
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return { value, truncated: false };
  return { value: codePoints.slice(0, limit).join(""), truncated: true };
}

function linearPublicUrl(value: string | null): string | null {
  if (!value || value.length > URL_LIMIT) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!LINEAR_PUBLIC_HOSTS.includes(url.hostname)) return null;
  return url.href;
}

export function linearRunNonce(connectionId: string, routineId: string, eventKey: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([connectionId, routineId, eventKey]))
    .digest("base64url");
  return `linear:${digest}`;
}
