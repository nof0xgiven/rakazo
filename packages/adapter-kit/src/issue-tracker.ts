export type IssueTrackerOption = { id: string; name: string };

export type Page<T> = { items: T[]; nextCursor: string | null };

export type IssueTrackerIdentity = {
  organizationId: string;
  organizationName: string;
  viewerId: string;
};

export type IssueTrackerIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  teamId: string;
  projectId: string | null;
  assigneeId: string | null;
  stateId: string | null;
  labelIds: string[];
};

export type IssueTrackerComment = {
  id: string;
  body: string;
  url: string | null;
  createdAt: string;
  authorId: string | null;
};

export type IssueTrackerEventKind = "issue.created" | "issue.updated" | "comment.created";

export type IssueTrackerEventSeed =
  | {
      kind: "issue.created" | "issue.updated";
      entityId: string;
      issueId: string;
      occurredAt: string;
      issue: IssueTrackerIssue;
    }
  | {
      kind: "comment.created";
      entityId: string;
      issueId: string;
      occurredAt: string;
      comment: IssueTrackerComment;
    };

export type IssueTrackerEvent = {
  kind: IssueTrackerEventKind;
  key: string;
  occurredAt: string;
  issue: IssueTrackerIssue;
  comment: IssueTrackerComment | null;
};

export type IssueTrackerErrorCode =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "invalid_response"
  | "invalid_cursor";

export type IssueTrackerFailure = {
  code: IssueTrackerErrorCode;
  retryAt: string | null;
};

export type IssueTrackerOptionKind = "teams" | "projects" | "assignees" | "states" | "labels";

export interface IssueTrackerProvider {
  identity(credential: string, signal: AbortSignal): Promise<IssueTrackerIdentity>;
  options(
    credential: string,
    input: { kind: IssueTrackerOptionKind; teamId?: string; cursor?: string; ids?: string[] },
    signal: AbortSignal,
  ): Promise<Page<IssueTrackerOption>>;
  changes(
    credential: string,
    input: { collection: "issues" | "comments"; from: string; through: string; cursor?: string },
    signal: AbortSignal,
  ): Promise<Page<IssueTrackerEvent>>;
  hydrate(
    credential: string,
    seed: IssueTrackerEventSeed,
    signal: AbortSignal,
  ): Promise<IssueTrackerEvent | null>;
  close(): Promise<void>;
}

export class IssueTrackerError extends Error {
  readonly failure: IssueTrackerFailure;

  constructor(failure: IssueTrackerFailure) {
    super(`Issue tracker request failed: ${failure.code}`);
    this.name = "IssueTrackerError";
    this.failure = failure;
  }
}

export function isIssueTrackerError(error: unknown): error is IssueTrackerError {
  return error instanceof IssueTrackerError;
}

/** Canonical UTC millisecond timestamp; throws on an unparseable value rather than inventing one. */
export function canonicalOccurrence(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new IssueTrackerError({ code: "invalid_response", retryAt: null });
  return new Date(time).toISOString();
}

/** The one event identity shared by polling and webhooks. */
export function issueTrackerEventKey(
  kind: IssueTrackerEventKind,
  entityId: string,
  occurredAt: string,
): string {
  if (kind === "issue.updated") return `${kind}:${entityId}:${Date.parse(canonicalOccurrence(occurredAt))}`;
  return `${kind}:${entityId}`;
}
