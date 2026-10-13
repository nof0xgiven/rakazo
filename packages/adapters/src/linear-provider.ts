import type {
  IssueTrackerComment,
  IssueTrackerErrorCode,
  IssueTrackerEvent,
  IssueTrackerEventSeed,
  IssueTrackerIdentity,
  IssueTrackerIssue,
  IssueTrackerOption,
  IssueTrackerOptionKind,
  IssueTrackerProvider,
  Page,
} from "@rakazo/adapter-kit";
import { canonicalOccurrence, IssueTrackerError, issueTrackerEventKey } from "@rakazo/adapter-kit";
import { createSafeRemoteFetch } from "./remote-mcp.js";

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
export const LINEAR_PUBLIC_HOSTS: readonly string[] = Object.freeze(["linear.app"]);

const PAGE_SIZE = 50;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;
const RATE_LIMIT_MARGIN_MS = 1_000;
const RATE_LIMIT_MAX_HORIZON_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_RESET_HEADERS = [
  "x-ratelimit-requests-reset",
  "x-ratelimit-endpoint-requests-reset",
  "x-ratelimit-complexity-reset",
] as const;

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const ISSUE_FIELDS =
  "id identifier title description url createdAt updatedAt labelIds team { id } project { id } assignee { id } state { id }";
const COMMENT_FIELDS = `id body url createdAt user { id } issue { ${ISSUE_FIELDS} }`;

type Operation = { name: string; query: string };

function operation(name: string, signature: string, selection: string): Operation {
  return { name, query: `query ${name}${signature} { ${selection} }` };
}

const LIST_ARGS = "first: $first, after: $after, filter: $filter";

const IDENTITY = operation("LinearIdentity", "", "viewer { id } organization { id name }");
const TEAMS = operation(
  "LinearTeams",
  "($first: Int!, $after: String, $filter: TeamFilter)",
  `teams(${LIST_ARGS}) { nodes { id name } ${PAGE_INFO} }`,
);
const TEAM_RELATIONS = {
  projects: operation(
    "LinearTeamProjects",
    "($teamId: String!, $first: Int!, $after: String, $filter: ProjectFilter)",
    `team(id: $teamId) { projects(${LIST_ARGS}) { nodes { id name } ${PAGE_INFO} } }`,
  ),
  assignees: operation(
    "LinearTeamMembers",
    "($teamId: String!, $first: Int!, $after: String, $filter: UserFilter)",
    `team(id: $teamId) { members(${LIST_ARGS}) { nodes { id name } ${PAGE_INFO} } }`,
  ),
  states: operation(
    "LinearTeamStates",
    "($teamId: String!, $first: Int!, $after: String, $filter: WorkflowStateFilter)",
    `team(id: $teamId) { states(${LIST_ARGS}) { nodes { id name } ${PAGE_INFO} } }`,
  ),
} as const;
const TEAM_RELATION_FIELDS = { projects: "projects", assignees: "members", states: "states" } as const;
const LABELS = operation(
  "LinearLabels",
  "($first: Int!, $after: String, $filter: IssueLabelFilter)",
  `issueLabels(${LIST_ARGS}) { nodes { id name isGroup archivedAt } ${PAGE_INFO} }`,
);
const ISSUES = operation(
  "LinearIssues",
  "($first: Int!, $after: String, $filter: IssueFilter)",
  `issues(${LIST_ARGS}, orderBy: updatedAt, includeArchived: true) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} }`,
);
const COMMENTS = operation(
  "LinearComments",
  "($first: Int!, $after: String, $filter: CommentFilter)",
  `comments(${LIST_ARGS}, orderBy: createdAt, includeArchived: true) { nodes { ${COMMENT_FIELDS} } ${PAGE_INFO} }`,
);
const ISSUE = operation("LinearIssue", "($id: String!)", `issue(id: $id) { ${ISSUE_FIELDS} }`);
const COMMENT = operation("LinearComment", "($id: String!)", `comment(id: $id) { ${COMMENT_FIELDS} }`);

type Json = Record<string, unknown>;
type Missing = { missing: "forbidden" | "not_found" };
type RequestContext = { cursor?: boolean; resourceRoot?: string };

function failure(code: IssueTrackerErrorCode, retryAt: string | null = null): IssueTrackerError {
  return new IssueTrackerError({ code, retryAt });
}

function invalid(): IssueTrackerError {
  return failure("invalid_response");
}

function record(value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
  return value as Json;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw invalid();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return text(value);
}

function relationId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return nonEmptyString(record(value).id);
}

function timestamp(value: unknown): string {
  return canonicalOccurrence(nonEmptyString(value));
}

function parseIssue(value: unknown): IssueTrackerIssue {
  const node = record(value);
  if (!Array.isArray(node.labelIds)) throw invalid();
  const teamId = relationId(node.team);
  if (teamId === null) throw invalid();
  return {
    id: nonEmptyString(node.id),
    identifier: nonEmptyString(node.identifier),
    title: text(node.title),
    description: nullableText(node.description),
    url: nullableText(node.url),
    createdAt: timestamp(node.createdAt),
    updatedAt: timestamp(node.updatedAt),
    teamId,
    projectId: relationId(node.project),
    assigneeId: relationId(node.assignee),
    stateId: relationId(node.state),
    labelIds: [...new Set(node.labelIds.map(nonEmptyString))].sort(),
  };
}

function parseComment(node: Json): IssueTrackerComment {
  return {
    id: nonEmptyString(node.id),
    body: text(node.body),
    url: nullableText(node.url),
    createdAt: timestamp(node.createdAt),
    authorId: relationId(node.user),
  };
}

function parseConnection(
  value: unknown,
  cursor: string | undefined,
): { nodes: unknown[]; nextCursor: string | null } {
  const connection = record(value);
  if (!Array.isArray(connection.nodes)) throw invalid();
  const pageInfo = record(connection.pageInfo);
  if (typeof pageInfo.hasNextPage !== "boolean") throw invalid();
  if (!pageInfo.hasNextPage) return { nodes: connection.nodes, nextCursor: null };
  const endCursor = pageInfo.endCursor;
  if (typeof endCursor !== "string" || endCursor.length === 0 || endCursor === cursor) {
    throw invalid();
  }
  return { nodes: connection.nodes, nextCursor: endCursor };
}

function parseOptions(
  value: unknown,
  cursor: string | undefined,
  keep: (node: Json) => boolean = () => true,
): Page<IssueTrackerOption> {
  const { nodes, nextCursor } = parseConnection(value, cursor);
  const items: IssueTrackerOption[] = [];
  for (const entry of nodes) {
    const node = record(entry);
    const option = { id: nonEmptyString(node.id), name: text(node.name) };
    if (keep(node)) items.push(option);
  }
  return { items, nextCursor };
}

function errorKinds(error: Json): string[] {
  const extensions = error.extensions;
  if (typeof extensions !== "object" || extensions === null) return [];
  const raw = [
    "code" in extensions ? extensions.code : undefined,
    "type" in extensions ? extensions.type : undefined,
  ];
  return raw
    .filter((value): value is string => typeof value === "string")
    .map((value) =>
      value
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toUpperCase()
        .replace(/[\s-]+/g, "_"),
    );
}

const UNAVAILABLE_CODES: Record<string, true> = {
  INTERNAL_ERROR: true,
  INTERNAL_SERVER_ERROR: true,
  LOCK_TIMEOUT: true,
  NETWORK_ERROR: true,
  BOOTSTRAP_ERROR: true,
  SERVICE_UNAVAILABLE: true,
};

const FAILURE_PRIORITY: IssueTrackerErrorCode[] = [
  "auth",
  "rate_limit",
  "invalid_cursor",
  "unavailable",
  "invalid_response",
];

function classifyErrors(
  errors: unknown[],
  headers: Headers,
  context: RequestContext,
): IssueTrackerError | Missing {
  const codes = new Set<IssueTrackerErrorCode>();
  let missing: Missing["missing"] | null = null;
  for (const entry of errors) {
    if (typeof entry !== "object" || entry === null) {
      codes.add("invalid_response");
      continue;
    }
    const error = entry as Json;
    const kinds = errorKinds(error);
    const is = (kind: string) => kinds.includes(kind);
    const pathRoot = Array.isArray(error.path) ? error.path[0] : undefined;
    const onResource = context.resourceRoot !== undefined && pathRoot === context.resourceRoot;
    if (is("AUTHENTICATION_ERROR")) codes.add("auth");
    else if (is("RATELIMITED")) codes.add("rate_limit");
    else if (is("FORBIDDEN")) {
      if (onResource) missing = "forbidden";
      else codes.add("auth");
    } else if (
      is("ENTITY_NOT_FOUND") ||
      is("NOT_FOUND") ||
      (typeof error.message === "string" && error.message.startsWith("Entity not found"))
    ) {
      if (onResource) missing ??= "not_found";
      else codes.add("invalid_response");
    } else if (is("INVALID_INPUT") && context.cursor) codes.add("invalid_cursor");
    else if (kinds.some((kind) => UNAVAILABLE_CODES[kind])) codes.add("unavailable");
    else codes.add("invalid_response");
  }
  const code = FAILURE_PRIORITY.find((candidate) => codes.has(candidate));
  if (code === "rate_limit") return failure("rate_limit", rateLimitRetryAt(headers));
  if (code) return failure(code);
  if (missing) return { missing };
  return invalid();
}

function rateLimitRetryAt(headers: Headers): string {
  const now = Date.now();
  const horizon = now + RATE_LIMIT_MAX_HORIZON_MS;
  const candidates: number[] = [];
  for (const name of RATE_LIMIT_RESET_HEADERS) {
    const value = headers.get(name)?.trim();
    if (!value || !/^\d+$/.test(value)) continue;
    const reset = Number(value);
    if (Number.isSafeInteger(reset) && reset > 0 && reset <= horizon) candidates.push(reset);
  }
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const deadline = /^\d+(\.\d+)?$/.test(retryAfter)
      ? now + Number(retryAfter) * 1000
      : Date.parse(retryAfter);
    if (Number.isFinite(deadline) && deadline <= horizon) candidates.push(deadline);
  }
  const deadline =
    candidates.length > 0
      ? Math.max(now, ...candidates) + RATE_LIMIT_MARGIN_MS
      : now + RATE_LIMIT_FALLBACK_MS;
  return new Date(Math.ceil(deadline)).toISOString();
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBounded(response: Response, signal: AbortSignal, overflow: AbortController): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    overflow.abort();
    await discard(response);
    throw invalid();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        overflow.abort();
        throw invalid();
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw invalid();
  }
}

function sanitizedFailure(error: unknown, caller: AbortSignal): unknown {
  if (caller.aborted) return caller.reason;
  if (error instanceof IssueTrackerError) return error;
  return failure("unavailable");
}

export function createLinearProvider(options: { fetch?: typeof fetch } = {}): IssueTrackerProvider {
  const owned = options.fetch ? null : createSafeRemoteFetch();
  const transport: (input: string, init: RequestInit) => Promise<Response> = options.fetch ?? owned!;
  let closed = false;

  async function request(
    credential: string,
    op: Operation,
    variables: Json,
    signal: AbortSignal,
    context: RequestContext = {},
  ): Promise<Json | Missing> {
    signal.throwIfAborted();
    if (closed) throw failure("unavailable");
    if (credential.trim().length === 0 || /[\r\n]/.test(credential)) throw failure("auth");
    const overflow = new AbortController();
    const combined = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS), overflow.signal]);
    try {
      const response = await transport(LINEAR_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: credential,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ query: op.query, operationName: op.name, variables }),
        signal: combined,
      });
      const { status, headers } = response;
      if (status === 401 || status === 403) {
        await discard(response);
        throw failure("auth");
      }
      if (status === 429) {
        await discard(response);
        throw failure("rate_limit", rateLimitRetryAt(headers));
      }
      if (status >= 500) {
        await discard(response);
        throw failure("unavailable");
      }
      if (status !== 400 && (status < 200 || status >= 300)) {
        await discard(response);
        throw invalid();
      }
      const raw = await readBounded(response, combined, overflow);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw invalid();
      }
      const body = record(parsed);
      if (body.errors !== undefined) {
        if (!Array.isArray(body.errors)) throw invalid();
        if (body.errors.length > 0) {
          const classified = classifyErrors(body.errors, headers, context);
          if (classified instanceof IssueTrackerError) throw classified;
          return classified;
        }
      }
      if (status === 400) throw invalid();
      return record(body.data);
    } catch (error) {
      throw sanitizedFailure(error, signal);
    }
  }

  function isMissing(value: Json | Missing): value is Missing {
    return typeof value.missing === "string" && Object.keys(value).length === 1;
  }

  async function data(
    credential: string,
    op: Operation,
    variables: Json,
    signal: AbortSignal,
    context?: RequestContext,
  ): Promise<Json> {
    const result = await request(credential, op, variables, signal, context);
    if (isMissing(result)) throw invalid();
    return result;
  }

  async function listOptions(
    credential: string,
    input: { kind: IssueTrackerOptionKind; teamId?: string; cursor?: string; ids?: string[] },
    signal: AbortSignal,
  ): Promise<Page<IssueTrackerOption>> {
    if (input.ids && input.ids.length === 0) return { items: [], nextCursor: null };
    const idFilter = input.ids ? { id: { in: [...new Set(input.ids)] } } : undefined;
    const base = { first: PAGE_SIZE, after: input.cursor };
    const context: RequestContext = { cursor: input.cursor !== undefined };
    if (input.kind === "teams") {
      const result = await data(credential, TEAMS, { ...base, filter: idFilter }, signal, context);
      return parseOptions(result.teams, input.cursor);
    }
    if (!input.teamId) throw new Error("Linear team options require a team");
    if (input.kind === "labels") {
      const scope = { or: [{ team: { null: true } }, { team: { id: { eq: input.teamId } } }] };
      const filter = idFilter ? { and: [scope, idFilter] } : scope;
      const result = await data(credential, LABELS, { ...base, filter }, signal, context);
      return parseOptions(
        result.issueLabels,
        input.cursor,
        (node) => node.isGroup === false && (node.archivedAt === null || node.archivedAt === undefined),
      );
    }
    const result = await request(
      credential,
      TEAM_RELATIONS[input.kind],
      { ...base, teamId: input.teamId, filter: idFilter },
      signal,
      { ...context, resourceRoot: "team" },
    );
    if (isMissing(result) || result.team === null) return { items: [], nextCursor: null };
    return parseOptions(record(result.team)[TEAM_RELATION_FIELDS[input.kind]], input.cursor);
  }

  async function changes(
    credential: string,
    input: { collection: "issues" | "comments"; from: string; through: string; cursor?: string },
    signal: AbortSignal,
  ): Promise<Page<IssueTrackerEvent>> {
    const range = { gte: canonicalOccurrence(input.from), lte: canonicalOccurrence(input.through) };
    const context: RequestContext = { cursor: input.cursor !== undefined };
    const items: IssueTrackerEvent[] = [];
    if (input.collection === "issues") {
      const result = await data(
        credential,
        ISSUES,
        { first: PAGE_SIZE, after: input.cursor, filter: { updatedAt: range } },
        signal,
        context,
      );
      const { nodes, nextCursor } = parseConnection(result.issues, input.cursor);
      for (const node of nodes) {
        const issue = parseIssue(node);
        items.push({
          kind: "issue.created",
          key: issueTrackerEventKey("issue.created", issue.id, issue.createdAt),
          occurredAt: issue.createdAt,
          issue,
          comment: null,
        });
        if (issue.updatedAt !== issue.createdAt) {
          items.push({
            kind: "issue.updated",
            key: issueTrackerEventKey("issue.updated", issue.id, issue.updatedAt),
            occurredAt: issue.updatedAt,
            issue,
            comment: null,
          });
        }
      }
      return { items, nextCursor };
    }
    const result = await data(
      credential,
      COMMENTS,
      { first: PAGE_SIZE, after: input.cursor, filter: { createdAt: range } },
      signal,
      context,
    );
    const { nodes, nextCursor } = parseConnection(result.comments, input.cursor);
    for (const entry of nodes) {
      const node = record(entry);
      const comment = parseComment(node);
      if (node.issue === null || node.issue === undefined) continue;
      const issue = parseIssue(node.issue);
      items.push({
        kind: "comment.created",
        key: issueTrackerEventKey("comment.created", comment.id, comment.createdAt),
        occurredAt: comment.createdAt,
        issue,
        comment,
      });
    }
    return { items, nextCursor };
  }

  async function findComment(credential: string, id: string, signal: AbortSignal): Promise<Json | null> {
    const direct = await request(credential, COMMENT, { id }, signal, { resourceRoot: "comment" });
    if (isMissing(direct)) {
      if (direct.missing === "forbidden") return null;
    } else if (direct.comment !== null && direct.comment !== undefined) {
      return record(direct.comment);
    }
    const archived = await data(
      credential,
      COMMENTS,
      { first: 1, filter: { id: { eq: id } } },
      signal,
    );
    const { nodes } = parseConnection(archived.comments, undefined);
    const match = nodes.map(record).find((node) => node.id === id);
    return match ?? null;
  }

  async function hydrate(
    credential: string,
    seed: IssueTrackerEventSeed,
    signal: AbortSignal,
  ): Promise<IssueTrackerEvent | null> {
    const occurredAt = canonicalOccurrence(seed.occurredAt);
    const key = issueTrackerEventKey(seed.kind, seed.entityId, occurredAt);
    if (seed.kind === "comment.created") {
      const node = await findComment(credential, seed.entityId, signal);
      if (!node) return null;
      if (nonEmptyString(node.id) !== seed.entityId) throw invalid();
      if (node.issue === null || node.issue === undefined) return null;
      const issue = parseIssue(node.issue);
      if (issue.id !== seed.issueId) return null;
      return { kind: seed.kind, key, occurredAt, issue, comment: seed.comment };
    }
    const result = await request(credential, ISSUE, { id: seed.issueId }, signal, {
      resourceRoot: "issue",
    });
    if (isMissing(result) || result.issue === null || result.issue === undefined) return null;
    if (parseIssue(result.issue).id !== seed.issueId) throw invalid();
    return { kind: seed.kind, key, occurredAt, issue: seed.issue, comment: null };
  }

  return {
    async identity(credential, signal): Promise<IssueTrackerIdentity> {
      const result = await data(credential, IDENTITY, {}, signal);
      const organization = record(result.organization);
      return {
        organizationId: nonEmptyString(organization.id),
        organizationName: text(organization.name),
        viewerId: nonEmptyString(record(result.viewer).id),
      };
    },
    options: listOptions,
    changes,
    hydrate,
    async close() {
      if (closed) return;
      closed = true;
      await owned?.close();
    },
  };
}
