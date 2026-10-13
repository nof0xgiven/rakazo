import { createHmac } from "node:crypto";
import type { IssueTrackerComment, IssueTrackerIssue } from "@rakazo/adapter-kit";
import { LINEAR_GRAPHQL_ENDPOINT } from "./linear-provider.js";

export type LinearEmulatorFailure =
  | { kind: "http"; status: number; headers?: Record<string, string> }
  | {
      kind: "graphql";
      code: string;
      extensions?: Record<string, unknown>;
      status?: number;
      headers?: Record<string, string>;
    }
  | { kind: "malformed" }
  | { kind: "oversize" }
  | { kind: "delay"; ms: number; until?: Promise<void> };

export type LinearEmulatorWebhookInput = {
  signingSecret: string;
  type: "Issue" | "Comment";
  action: "create" | "update" | "remove";
  entityId: string;
  timestampMs?: number;
  deliveryId?: string;
  organizationId?: string;
};

export interface LinearEmulator {
  fetch: typeof fetch;
  addWorkspace(input: {
    organizationId: string;
    organizationName: string;
    viewerId: string;
    apiKey: string;
  }): void;
  addTeam(input: { id: string; name: string; key?: string }): void;
  addProject(input: { id: string; name: string; teamIds: string[] }): void;
  addMember(input: { id: string; name: string; teamIds: string[] }): void;
  addState(input: { id: string; name: string; teamId: string }): void;
  addLabel(input: {
    id: string;
    name: string;
    teamId: string | null;
    isGroup?: boolean;
    archived?: boolean;
  }): void;
  createIssue(input: Partial<IssueTrackerIssue> & { teamId: string; title: string }): IssueTrackerIssue;
  updateIssue(id: string, patch: Partial<Omit<IssueTrackerIssue, "id" | "createdAt">>): IssueTrackerIssue;
  deleteIssue(id: string): void;
  createComment(input: { issueId: string | null; body: string; authorId?: string | null }): IssueTrackerComment;
  archiveComment(id: string): void;
  revokeKey(apiKey: string): void;
  forbid(entityId: string): void;
  failNext(failure: LinearEmulatorFailure, scope?: { operation?: string }): void;
  webhook(input: LinearEmulatorWebhookInput): { body: string; headers: Record<string, string> };
  requests(): Array<{ operation: string; variables: unknown; authorization: string | null }>;
  advance(ms: number): void;
  reset(): void;
}

type Json = Record<string, unknown>;
type Workspace = { organizationId: string; organizationName: string; viewerId: string; revoked: boolean };
type Team = { id: string; name: string; key: string; issueCount: number };
type Named = { id: string; name: string; teamIds: string[] };
type Label = { id: string; name: string; teamId: string | null; isGroup: boolean; archived: boolean };
type StoredComment = IssueTrackerComment & { issueId: string | null; updatedAt: string; archived: boolean };
type Reply = { status: number; body: Json; headers?: Record<string, string> };

const ORGANIZATION_SLUG = "emulator";
const MAX_PAGE_SIZE = 250;
const OVERSIZE_CHUNK_BYTES = 1024 * 1024;
const OVERSIZE_CHUNKS = 17;
const COMPARATORS: Record<string, true> = {
  eq: true,
  neq: true,
  in: true,
  nin: true,
  gt: true,
  gte: true,
  lt: true,
  lte: true,
  null: true,
};

class FilterShapeError extends Error {}

function syntheticId(prefix: string, sequence: number): string {
  return `${prefix}-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function graphqlError(message: string, code: string, path?: string[]): Json {
  return {
    message,
    ...(path ? { path } : {}),
    extensions: {
      type: code.toLowerCase().replace(/(?:^|_)([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
      userError: code !== "AUTHENTICATION_ERROR",
      userPresentableMessage: message,
    },
  };
}

function errorReply(status: number, message: string, code: string, path?: string[]): Reply {
  return { status, body: { data: null, errors: [graphqlError(message, code, path)] } };
}

function comparable(value: unknown): unknown {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return value;
}

function compare(field: unknown, operator: string, expected: unknown): boolean {
  if (operator === "null") return (field === null || field === undefined) === expected;
  if (operator === "in" || operator === "nin") {
    if (!Array.isArray(expected)) throw new FilterShapeError(operator);
    return expected.includes(field) === (operator === "in");
  }
  const left = comparable(field);
  const right = comparable(expected);
  if (operator === "eq") return left === right;
  if (operator === "neq") return left !== right;
  let order: number;
  if (typeof left === "number" && typeof right === "number") order = left - right;
  else if (typeof left === "string" && typeof right === "string") order = left < right ? -1 : left > right ? 1 : 0;
  else return false;
  if (operator === "gt") return order > 0;
  if (operator === "gte") return order >= 0;
  if (operator === "lt") return order < 0;
  return order <= 0;
}

function matchesFilter(value: Json | null, filter: unknown): boolean {
  if (filter === undefined || filter === null) return true;
  if (typeof filter !== "object" || Array.isArray(filter)) throw new FilterShapeError("filter");
  for (const [key, condition] of Object.entries(filter as Json)) {
    if (key === "and" || key === "or") {
      if (!Array.isArray(condition)) throw new FilterShapeError(key);
      const results = condition.map((entry) => matchesFilter(value, entry));
      if (key === "and" ? !results.every(Boolean) : !results.some(Boolean)) return false;
      continue;
    }
    if (value === null) return false;
    if (!(key in value)) throw new FilterShapeError(key);
    if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
      throw new FilterShapeError(key);
    }
    const field = value[key];
    const entries = Object.entries(condition as Json);
    const operators = entries.filter(([operator]) => COMPARATORS[operator]);
    for (const [operator, expected] of operators) {
      if (!compare(field, operator, expected)) return false;
    }
    const nested = Object.fromEntries(entries.filter(([operator]) => !COMPARATORS[operator]));
    if (Object.keys(nested).length === 0) continue;
    if (typeof field !== "object" || field === null) return false;
    if (!matchesFilter(field as Json, nested)) return false;
  }
  return true;
}

function decodeCursor(cursor: string): string[] | null {
  try {
    const key: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(key) && key.every((part) => typeof part === "string") ? key : null;
  } catch {
    return null;
  }
}

function compareKeys(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? "";
    const b = right[index] ?? "";
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function paginate<T>(
  items: T[],
  sortKey: (item: T) => string[],
  variables: Json,
  toNode: (item: T) => unknown,
): Json | null {
  const first = typeof variables.first === "number" ? Math.min(variables.first, MAX_PAGE_SIZE) : MAX_PAGE_SIZE;
  const sorted = items
    .map((item) => ({ item, key: sortKey(item) }))
    .sort((a, b) => compareKeys(a.key, b.key));
  let start = 0;
  if (typeof variables.after === "string") {
    const after = decodeCursor(variables.after);
    if (!after) return null;
    start = sorted.findIndex((entry) => compareKeys(entry.key, after) > 0);
    if (start < 0) start = sorted.length;
  }
  const page = sorted.slice(start, start + first);
  const last = page.at(-1);
  return {
    nodes: page.map((entry) => toNode(entry.item)),
    pageInfo: {
      hasNextPage: start + page.length < sorted.length,
      endCursor: last ? Buffer.from(JSON.stringify(last.key)).toString("base64url") : null,
    },
  };
}

function isoNow(clock: () => number): string {
  return new Date(clock()).toISOString();
}

export function createLinearEmulator(options: { now?: () => Date } = {}): LinearEmulator {
  let offset = 0;
  const clock = () => (options.now?.() ?? new Date()).getTime() + offset;
  const workspaces = new Map<string, Workspace>();
  const teams = new Map<string, Team>();
  const projects = new Map<string, Named>();
  const members = new Map<string, Named>();
  const states = new Map<string, { id: string; name: string; teamId: string }>();
  const labels = new Map<string, Label>();
  const issues = new Map<string, IssueTrackerIssue>();
  const deletedIssues = new Map<string, IssueTrackerIssue>();
  const comments = new Map<string, StoredComment>();
  const forbidden = new Set<string>();
  const failures: Array<{ failure: LinearEmulatorFailure; operation?: string }> = [];
  const log: Array<{ operation: string; variables: unknown; authorization: string | null }> = [];
  let issueSequence = 0;
  let commentSequence = 0;
  let deliverySequence = 0;

  const issueNode = (issue: IssueTrackerIssue): Json => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    labelIds: [...issue.labelIds],
    team: { id: issue.teamId },
    project: issue.projectId ? { id: issue.projectId } : null,
    assignee: issue.assigneeId ? { id: issue.assigneeId } : null,
    state: issue.stateId ? { id: issue.stateId } : null,
  });

  const commentNode = (comment: StoredComment): Json => {
    const issue = comment.issueId ? issues.get(comment.issueId) : undefined;
    return {
      id: comment.id,
      body: comment.body,
      url: comment.url,
      createdAt: comment.createdAt,
      user: comment.authorId ? { id: comment.authorId } : null,
      issue: issue ? issueNode(issue) : null,
    };
  };

  const commentHidden = (comment: StoredComment) =>
    forbidden.has(comment.id) || (comment.issueId !== null && forbidden.has(comment.issueId));

  const teamRelation = (variables: Json, field: "projects" | "members" | "states"): Reply => {
    const teamId = variables.teamId;
    if (typeof teamId !== "string") return errorReply(400, "Argument Validation Error", "INVALID_INPUT");
    if (forbidden.has(teamId)) return errorReply(200, "Forbidden", "FORBIDDEN", ["team"]);
    const team = teams.get(teamId);
    if (!team) return errorReply(400, "Entity not found: Team", "INVALID_INPUT", ["team"]);
    const options: Array<{ id: string; name: string }> =
      field === "states"
        ? [...states.values()].filter((state) => state.teamId === teamId)
        : [...(field === "projects" ? projects : members).values()].filter((entry) =>
            entry.teamIds.includes(teamId),
          );
    const connection = paginate(
      options.filter((option) => !forbidden.has(option.id) && matchesFilter({ id: option.id }, variables.filter)),
      (option) => [option.id],
      variables,
      (option) => ({ id: option.id, name: option.name }),
    );
    if (!connection) return errorReply(400, "Invalid cursor", "INVALID_INPUT");
    return { status: 200, body: { data: { team: { [field]: connection } } } };
  };

  const listReply = (field: string, connection: Json | null): Reply =>
    connection
      ? { status: 200, body: { data: { [field]: connection } } }
      : errorReply(400, "Invalid cursor", "INVALID_INPUT");

  const handlers: Record<string, (variables: Json, workspace: Workspace, query: string) => Reply> = {
    LinearIdentity: (_variables, workspace) => ({
      status: 200,
      body: {
        data: {
          viewer: { id: workspace.viewerId },
          organization: { id: workspace.organizationId, name: workspace.organizationName },
        },
      },
    }),
    LinearTeams: (variables) =>
      listReply(
        "teams",
        paginate(
          [...teams.values()].filter(
            (team) => !forbidden.has(team.id) && matchesFilter({ id: team.id }, variables.filter),
          ),
          (team) => [team.id],
          variables,
          (team) => ({ id: team.id, name: team.name }),
        ),
      ),
    LinearTeamProjects: (variables) => teamRelation(variables, "projects"),
    LinearTeamMembers: (variables) => teamRelation(variables, "members"),
    LinearTeamStates: (variables) => teamRelation(variables, "states"),
    LinearLabels: (variables) =>
      listReply(
        "issueLabels",
        paginate(
          [...labels.values()].filter(
            (label) =>
              !label.archived &&
              !forbidden.has(label.id) &&
              matchesFilter(
                { id: label.id, team: label.teamId ? { id: label.teamId } : null },
                variables.filter,
              ),
          ),
          (label) => [label.id],
          variables,
          (label) => ({ id: label.id, name: label.name, isGroup: label.isGroup, archivedAt: null }),
        ),
      ),
    LinearIssues: (variables, _workspace, query) => {
      if (!/\bincludeArchived:\s*true\b/.test(query)) {
        return errorReply(400, "includeArchived is required", "INVALID_INPUT");
      }
      return listReply(
        "issues",
        paginate(
          [...issues.values()].filter(
            (issue) =>
              !forbidden.has(issue.id) &&
              matchesFilter(
                { id: issue.id, createdAt: issue.createdAt, updatedAt: issue.updatedAt },
                variables.filter,
              ),
          ),
          (issue) => [issue.updatedAt, issue.id],
          variables,
          issueNode,
        ),
      );
    },
    LinearComments: (variables, _workspace, query) => {
      if (!/\bincludeArchived:\s*true\b/.test(query)) {
        return errorReply(400, "includeArchived is required", "INVALID_INPUT");
      }
      return listReply(
        "comments",
        paginate(
          [...comments.values()].filter(
            (comment) =>
              !commentHidden(comment) &&
              matchesFilter({ id: comment.id, createdAt: comment.createdAt }, variables.filter),
          ),
          (comment) => [comment.createdAt, comment.id],
          variables,
          commentNode,
        ),
      );
    },
    LinearIssue: (variables) => {
      const id = variables.id;
      if (typeof id !== "string") return errorReply(400, "Argument Validation Error", "INVALID_INPUT");
      if (forbidden.has(id)) return errorReply(200, "Forbidden", "FORBIDDEN", ["issue"]);
      const issue = issues.get(id);
      if (!issue) return errorReply(400, "Entity not found: Issue", "INVALID_INPUT", ["issue"]);
      return { status: 200, body: { data: { issue: issueNode(issue) } } };
    },
    LinearComment: (variables) => {
      const id = variables.id;
      if (typeof id !== "string") return errorReply(400, "Argument Validation Error", "INVALID_INPUT");
      const comment = comments.get(id);
      if (comment && commentHidden(comment)) {
        return errorReply(200, "Forbidden", "FORBIDDEN", ["comment"]);
      }
      if (!comment || comment.archived) {
        return errorReply(400, "Entity not found: Comment", "INVALID_INPUT", ["comment"]);
      }
      return { status: 200, body: { data: { comment: commentNode(comment) } } };
    },
  };

  const jsonResponse = (reply: Reply): Response =>
    new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json; charset=utf-8", ...reply.headers },
    });

  const wait = async (failure: { ms: number; until?: Promise<void> }, signal: AbortSignal | null | undefined) => {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let pending = failure.until ? 2 : 1;
      const settle = () => {
        pending -= 1;
        if (pending > 0) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(settle, failure.ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      failure.until?.then(settle, settle);
    });
  };

  const serve = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url !== LINEAR_GRAPHQL_ENDPOINT || method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const authorization = headers.get("authorization");
    const rawBody = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.text() : "";
    let payload: Json;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("body");
      payload = parsed as Json;
    } catch {
      return jsonResponse(errorReply(400, "Body must be a JSON object", "GRAPHQL_PARSE_FAILED"));
    }
    const query = typeof payload.query === "string" ? payload.query : "";
    const operation = typeof payload.operationName === "string" ? payload.operationName : "";
    const variables =
      typeof payload.variables === "object" && payload.variables !== null && !Array.isArray(payload.variables)
        ? (payload.variables as Json)
        : {};
    log.push({ operation, variables: structuredClone(variables), authorization });

    const index = failures.findIndex((entry) => !entry.operation || entry.operation === operation);
    const injected = index >= 0 ? failures.splice(index, 1)[0]!.failure : null;
    if (injected?.kind === "delay") await wait(injected, init?.signal);
    if (injected?.kind === "http") {
      return new Response(JSON.stringify({ errors: [{ message: "Emulated HTTP failure" }] }), {
        status: injected.status,
        headers: { "content-type": "application/json", ...injected.headers },
      });
    }
    if (injected?.kind === "malformed") {
      return new Response('{"data": {"viewer": ', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (injected?.kind === "oversize") {
      const chunk = new Uint8Array(OVERSIZE_CHUNK_BYTES).fill(0x20);
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent === 0) controller.enqueue(new TextEncoder().encode('{"data":'));
            if (sent >= OVERSIZE_CHUNKS) {
              controller.enqueue(new TextEncoder().encode("null}"));
              controller.close();
              return;
            }
            sent += 1;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    const declared = /^\s*query\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)?.[1];
    const handler = handlers[operation];
    let reply: Reply;
    if (!handler || declared !== operation) {
      reply = errorReply(400, "Unknown operation", "GRAPHQL_VALIDATION_FAILED");
    } else {
      const workspace = authorization ? workspaces.get(authorization) : undefined;
      if (!workspace || workspace.revoked) {
        reply = errorReply(400, "Authentication required, not authenticated", "AUTHENTICATION_ERROR");
      } else {
        try {
          reply = handler(variables, workspace, query);
        } catch (error) {
          if (!(error instanceof FilterShapeError)) throw error;
          reply = errorReply(400, "Argument Validation Error", "INVALID_INPUT");
        }
      }
    }
    if (injected?.kind === "graphql") {
      const errors = [
        {
          message: "Emulated GraphQL failure",
          extensions: { code: injected.code, ...injected.extensions },
        },
      ];
      reply = {
        status: injected.status ?? (injected.code === "RATELIMITED" ? 400 : 200),
        body: { data: reply.body.data ?? null, errors },
        headers: injected.headers,
      };
    }
    return jsonResponse(reply);
  };

  const requireIssue = (id: string): IssueTrackerIssue => {
    const issue = issues.get(id);
    if (!issue) throw new Error(`Unknown emulated issue ${id}`);
    return issue;
  };

  const defaultOrganization = (): string => {
    const first = workspaces.values().next();
    if (first.done) throw new Error("Linear emulator has no workspace");
    return first.value.organizationId;
  };

  const webhookData = (input: LinearEmulatorWebhookInput): { data: Json; url: string | null; at: string } => {
    if (input.type === "Issue") {
      const issue = issues.get(input.entityId) ?? deletedIssues.get(input.entityId);
      if (!issue) throw new Error(`Unknown emulated issue ${input.entityId}`);
      return {
        data: {
          id: issue.id,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          url: issue.url,
          teamId: issue.teamId,
          projectId: issue.projectId,
          assigneeId: issue.assigneeId,
          stateId: issue.stateId,
          labelIds: [...issue.labelIds],
        },
        url: issue.url,
        at: input.action === "create" ? issue.createdAt : issue.updatedAt,
      };
    }
    const comment = comments.get(input.entityId);
    if (!comment) throw new Error(`Unknown emulated comment ${input.entityId}`);
    return {
      data: {
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        issueId: comment.issueId,
        userId: comment.authorId,
        url: comment.url,
      },
      url: comment.url,
      at: input.action === "create" ? comment.createdAt : comment.updatedAt,
    };
  };

  return {
    fetch: serve as typeof fetch,
    addWorkspace(input) {
      workspaces.set(input.apiKey, {
        organizationId: input.organizationId,
        organizationName: input.organizationName,
        viewerId: input.viewerId,
        revoked: false,
      });
    },
    addTeam(input) {
      const key = input.key ?? (input.name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "TEAM");
      teams.set(input.id, { id: input.id, name: input.name, key, issueCount: 0 });
    },
    addProject(input) {
      projects.set(input.id, { id: input.id, name: input.name, teamIds: [...input.teamIds] });
    },
    addMember(input) {
      members.set(input.id, { id: input.id, name: input.name, teamIds: [...input.teamIds] });
    },
    addState(input) {
      states.set(input.id, { ...input });
    },
    addLabel(input) {
      labels.set(input.id, {
        id: input.id,
        name: input.name,
        teamId: input.teamId,
        isGroup: input.isGroup ?? false,
        archived: input.archived ?? false,
      });
    },
    createIssue(input) {
      const team = teams.get(input.teamId);
      if (!team) throw new Error(`Unknown emulated team ${input.teamId}`);
      issueSequence += 1;
      team.issueCount += 1;
      const now = isoNow(clock);
      const identifier = input.identifier ?? `${team.key}-${team.issueCount}`;
      const issue: IssueTrackerIssue = {
        id: input.id ?? syntheticId("11111111", issueSequence),
        identifier,
        title: input.title,
        description: input.description ?? null,
        url: input.url === undefined ? `https://linear.app/${ORGANIZATION_SLUG}/issue/${identifier}` : input.url,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? input.createdAt ?? now,
        teamId: input.teamId,
        projectId: input.projectId ?? null,
        assigneeId: input.assigneeId ?? null,
        stateId: input.stateId ?? null,
        labelIds: [...(input.labelIds ?? [])],
      };
      issues.set(issue.id, issue);
      return structuredClone(issue);
    },
    updateIssue(id, patch) {
      const current = requireIssue(id);
      const next: IssueTrackerIssue = {
        ...current,
        ...patch,
        labelIds: [...(patch.labelIds ?? current.labelIds)],
        updatedAt: patch.updatedAt ?? isoNow(clock),
      };
      issues.set(id, next);
      return structuredClone(next);
    },
    deleteIssue(id) {
      deletedIssues.set(id, requireIssue(id));
      issues.delete(id);
    },
    createComment(input) {
      const issue = input.issueId === null ? null : requireIssue(input.issueId);
      commentSequence += 1;
      const id = syntheticId("22222222", commentSequence);
      const createdAt = isoNow(clock);
      const comment: StoredComment = {
        id,
        body: input.body,
        url: issue?.url ? `${issue.url}#comment-${id.slice(-8)}` : null,
        createdAt,
        authorId: input.authorId ?? null,
        issueId: issue?.id ?? null,
        updatedAt: createdAt,
        archived: false,
      };
      comments.set(id, comment);
      return { id, body: comment.body, url: comment.url, createdAt, authorId: comment.authorId };
    },
    archiveComment(id) {
      const comment = comments.get(id);
      if (!comment) throw new Error(`Unknown emulated comment ${id}`);
      comment.archived = true;
    },
    revokeKey(apiKey) {
      const workspace = workspaces.get(apiKey);
      if (workspace) workspace.revoked = true;
    },
    forbid(entityId) {
      forbidden.add(entityId);
    },
    failNext(failure, scope) {
      failures.push({ failure, operation: scope?.operation });
    },
    webhook(input) {
      const { data, url, at } = webhookData(input);
      deliverySequence += 1;
      const body = JSON.stringify({
        action: input.action,
        type: input.type,
        createdAt: at,
        data,
        url,
        organizationId: input.organizationId ?? defaultOrganization(),
        webhookTimestamp: input.timestampMs ?? clock(),
        webhookId: syntheticId("33333333", 1),
      });
      return {
        body,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Linear-Delivery": input.deliveryId ?? syntheticId("44444444", deliverySequence),
          "Linear-Event": input.type,
          "Linear-Signature": createHmac("sha256", input.signingSecret).update(body).digest("hex"),
          "User-Agent": "Linear-Webhook",
        },
      };
    },
    requests() {
      return log.map((entry) => ({ ...entry, variables: structuredClone(entry.variables) }));
    },
    advance(ms) {
      offset += ms;
    },
    reset() {
      offset = 0;
      for (const store of [workspaces, teams, projects, members, states, labels, issues, deletedIssues, comments]) {
        store.clear();
      }
      forbidden.clear();
      failures.length = 0;
      log.length = 0;
      issueSequence = 0;
      commentSequence = 0;
      deliverySequence = 0;
    },
  };
}
