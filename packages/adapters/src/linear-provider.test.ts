import { createHmac } from "node:crypto";
import type { IssueTrackerEvent, IssueTrackerIssue, IssueTrackerProvider } from "@rakazo/adapter-kit";
import { IssueTrackerError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinearEmulator, type LinearEmulator } from "./linear-emulator.js";
import { createLinearProvider, LINEAR_GRAPHQL_ENDPOINT, LINEAR_PUBLIC_HOSTS } from "./linear-provider.js";

const API_KEY = "lin_api_synthetic_key_0123456789";
const ORG = "org-synthetic-1";
const VIEWER = "user-viewer-1";
const TEAM = "team-alpha";
const BASE = Date.parse("2026-03-01T00:00:00.000Z");
const FROM = "2026-02-28T00:00:00.000Z";
const THROUGH = "2026-03-02T00:00:00.000Z";

function setup(): { emulator: LinearEmulator; provider: IssueTrackerProvider } {
  const emulator = createLinearEmulator({ now: () => new Date(BASE) });
  emulator.addWorkspace({ organizationId: ORG, organizationName: "Synthetic Org", viewerId: VIEWER, apiKey: API_KEY });
  emulator.addTeam({ id: TEAM, name: "Alpha", key: "ALP" });
  emulator.addTeam({ id: "team-beta", name: "Beta" });
  return { emulator, provider: createLinearProvider({ fetch: emulator.fetch }) };
}

const signal = () => new AbortController().signal;

async function failureOf(promise: Promise<unknown>): Promise<IssueTrackerError> {
  const error = await promise.then(
    () => {
      throw new Error("expected failure");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(IssueTrackerError);
  return error as IssueTrackerError;
}

async function allChanges(
  provider: IssueTrackerProvider,
  collection: "issues" | "comments",
): Promise<{ events: IssueTrackerEvent[]; pages: number }> {
  const events: IssueTrackerEvent[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await provider.changes(API_KEY, { collection, from: FROM, through: THROUGH, cursor }, signal());
    events.push(...page.items);
    pages += 1;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { events, pages };
}

function scriptedFetch(
  respond: (body: { operationName: string; variables: Record<string, unknown> }) => Response,
): typeof fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) =>
    respond(JSON.parse(String(init?.body)) as { operationName: string; variables: Record<string, unknown> })) as typeof fetch;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function issueSeed(issue: IssueTrackerIssue) {
  return {
    kind: "issue.updated" as const,
    entityId: issue.id,
    issueId: issue.id,
    occurredAt: issue.updatedAt,
    issue,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createLinearProvider", () => {
  it("exports the fixed endpoint and public hosts", () => {
    expect(LINEAR_GRAPHQL_ENDPOINT).toBe("https://api.linear.app/graphql");
    expect(LINEAR_PUBLIC_HOSTS).toEqual(["linear.app"]);
  });

  it("closes the owned default transport", async () => {
    const provider = createLinearProvider();
    await provider.close();
    await provider.close();
    expect((await failureOf(provider.identity(API_KEY, signal()))).failure.code).toBe("unavailable");
  });

  it("reads identity with the raw personal key", async () => {
    const { emulator, provider } = setup();
    await expect(provider.identity(API_KEY, signal())).resolves.toEqual({
      organizationId: ORG,
      organizationName: "Synthetic Org",
      viewerId: VIEWER,
    });
    expect(emulator.requests()).toEqual([{ operation: "LinearIdentity", variables: {}, authorization: API_KEY }]);
  });

  it("pages more than two issue pages and emits a creation per issue", async () => {
    const { emulator, provider } = setup();
    for (let index = 0; index < 125; index += 1) {
      emulator.advance(1000);
      emulator.createIssue({ teamId: TEAM, title: `Issue ${index}` });
    }
    const { events, pages } = await allChanges(provider, "issues");
    expect(pages).toBe(3);
    expect(events).toHaveLength(125);
    expect(new Set(events.map((event) => event.key)).size).toBe(125);
    expect(events.every((event) => event.kind === "issue.created")).toBe(true);
    const issueRequests = emulator.requests().filter((entry) => entry.operation === "LinearIssues");
    expect(issueRequests).toHaveLength(3);
    expect(issueRequests[0]!.variables).toEqual({
      first: 50,
      filter: { updatedAt: { gte: FROM, lte: THROUGH } },
    });
    for (const entry of issueRequests.slice(1)) {
      expect(entry.variables).toEqual({
        first: 50,
        after: expect.any(String),
        filter: { updatedAt: { gte: FROM, lte: THROUGH } },
      });
    }
  });

  it("emits creation plus update occurrences only when updatedAt differs", async () => {
    const { emulator, provider } = setup();
    const untouched = emulator.createIssue({ teamId: TEAM, title: "Untouched" });
    const edited = emulator.createIssue({ teamId: TEAM, title: "Edited", labelIds: ["label-b", "label-a"] });
    emulator.advance(2500);
    const after = emulator.updateIssue(edited.id, { stateId: "state-done" });
    const { events } = await allChanges(provider, "issues");
    expect(events.map((event) => event.key).sort()).toEqual(
      [
        `issue.created:${untouched.id}`,
        `issue.created:${edited.id}`,
        `issue.updated:${edited.id}:${BASE + 2500}`,
      ].sort(),
    );
    const update = events.find((event) => event.kind === "issue.updated")!;
    expect(update.occurredAt).toBe(after.updatedAt);
    expect(update.issue).toMatchObject({
      id: edited.id,
      teamId: TEAM,
      stateId: "state-done",
      labelIds: ["label-a", "label-b"],
      createdAt: new Date(BASE).toISOString(),
      url: `https://linear.app/emulator/issue/${edited.identifier}`,
    });
    const creation = events.find((event) => event.key === `issue.created:${edited.id}`)!;
    expect(creation.occurredAt).toBe(new Date(BASE).toISOString());
  });

  it("keeps distinct issues with equal timestamps across page boundaries", async () => {
    const { emulator, provider } = setup();
    const created = Array.from({ length: 60 }, (_, index) =>
      emulator.createIssue({ teamId: TEAM, title: `Same instant ${index}` }),
    );
    expect(new Set(created.map((issue) => issue.createdAt)).size).toBe(1);
    const { events, pages } = await allChanges(provider, "issues");
    expect(pages).toBe(2);
    expect(new Set(events.map((event) => event.key))).toEqual(
      new Set(created.map((issue) => `issue.created:${issue.id}`)),
    );
  });

  it("emits comment creations with parent issues and skips non-issue comments", async () => {
    const { emulator, provider } = setup();
    const issue = emulator.createIssue({ teamId: TEAM, title: "Parent", projectId: "project-1" });
    emulator.advance(1000);
    const comment = emulator.createComment({ issueId: issue.id, body: "Synthetic comment", authorId: "user-2" });
    emulator.createComment({ issueId: null, body: "Project update comment" });
    const { events } = await allChanges(provider, "comments");
    expect(events).toEqual([
      {
        kind: "comment.created",
        key: `comment.created:${comment.id}`,
        occurredAt: comment.createdAt,
        issue: expect.objectContaining({ id: issue.id, projectId: "project-1" }),
        comment,
      },
    ]);
    const request = emulator.requests().find((entry) => entry.operation === "LinearComments")!;
    expect(request.variables).toEqual({ first: 50, filter: { createdAt: { gte: FROM, lte: THROUGH } } });
  });

  it("lists options with team scoping, label exclusions and id restriction", async () => {
    const { emulator, provider } = setup();
    emulator.addProject({ id: "project-1", name: "Roadmap", teamIds: [TEAM] });
    emulator.addProject({ id: "project-2", name: "Other", teamIds: ["team-beta"] });
    emulator.addMember({ id: "user-1", name: "Synthetic Member", teamIds: [TEAM] });
    emulator.addState({ id: "state-1", name: "Todo", teamId: TEAM });
    emulator.addState({ id: "state-2", name: "Beta todo", teamId: "team-beta" });
    emulator.addLabel({ id: "label-global", name: "Bug", teamId: null });
    emulator.addLabel({ id: "label-team", name: "Alpha only", teamId: TEAM });
    emulator.addLabel({ id: "label-other", name: "Beta only", teamId: "team-beta" });
    emulator.addLabel({ id: "label-group", name: "Group", teamId: null, isGroup: true });
    emulator.addLabel({ id: "label-archived", name: "Old", teamId: TEAM, archived: true });

    expect((await provider.options(API_KEY, { kind: "teams" }, signal())).items).toEqual([
      { id: TEAM, name: "Alpha" },
      { id: "team-beta", name: "Beta" },
    ]);
    expect(await provider.options(API_KEY, { kind: "projects", teamId: TEAM }, signal())).toEqual({
      items: [{ id: "project-1", name: "Roadmap" }],
      nextCursor: null,
    });
    expect((await provider.options(API_KEY, { kind: "assignees", teamId: TEAM }, signal())).items).toEqual([
      { id: "user-1", name: "Synthetic Member" },
    ]);
    expect((await provider.options(API_KEY, { kind: "states", teamId: TEAM }, signal())).items).toEqual([
      { id: "state-1", name: "Todo" },
    ]);
    expect((await provider.options(API_KEY, { kind: "labels", teamId: TEAM }, signal())).items).toEqual([
      { id: "label-global", name: "Bug" },
      { id: "label-team", name: "Alpha only" },
    ]);
    expect(
      (
        await provider.options(
          API_KEY,
          { kind: "labels", teamId: TEAM, ids: ["label-team", "label-other", "label-group"] },
          signal(),
        )
      ).items,
    ).toEqual([{ id: "label-team", name: "Alpha only" }]);
    expect(
      (await provider.options(API_KEY, { kind: "teams", ids: ["team-beta", "team-missing"] }, signal())).items,
    ).toEqual([{ id: "team-beta", name: "Beta" }]);
    expect(await provider.options(API_KEY, { kind: "teams", ids: [] }, signal())).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await provider.options(API_KEY, { kind: "states", teamId: "team-missing" }, signal())).toEqual({
      items: [],
      nextCursor: null,
    });
    const labelRequest = emulator.requests().find((entry) => entry.operation === "LinearLabels")!;
    expect(labelRequest.variables).toEqual({
      first: 50,
      filter: { or: [{ team: { null: true } }, { team: { id: { eq: TEAM } } }] },
    });
  });

  it("pages options and keeps filtered-empty pages pageable", async () => {
    const { emulator, provider } = setup();
    for (let index = 0; index < 50; index += 1) {
      emulator.addLabel({ id: `label-${String(index).padStart(3, "0")}`, name: `Group ${index}`, teamId: null, isGroup: true });
    }
    emulator.addLabel({ id: "label-zzz", name: "Usable", teamId: TEAM });
    const first = await provider.options(API_KEY, { kind: "labels", teamId: TEAM }, signal());
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await provider.options(
      API_KEY,
      { kind: "labels", teamId: TEAM, cursor: first.nextCursor! },
      signal(),
    );
    expect(second).toEqual({ items: [{ id: "label-zzz", name: "Usable" }], nextCursor: null });
  });

  it("hydrates an issue seed keeping the signed after-state", async () => {
    const { emulator, provider } = setup();
    const created = emulator.createIssue({ teamId: TEAM, title: "Before" });
    emulator.advance(1000);
    const signed = emulator.updateIssue(created.id, { title: "Signed" });
    emulator.advance(1000);
    emulator.updateIssue(created.id, { title: "Newer", teamId: "team-beta" });
    const event = await provider.hydrate(API_KEY, issueSeed(signed), signal());
    expect(event).toEqual({
      kind: "issue.updated",
      key: `issue.updated:${created.id}:${BASE + 1000}`,
      occurredAt: signed.updatedAt,
      issue: signed,
      comment: null,
    });
    expect(emulator.requests().at(-1)).toMatchObject({ operation: "LinearIssue", variables: { id: created.id } });
  });

  it("hydrates comments directly and falls back to an archived lookup", async () => {
    const { emulator, provider } = setup();
    const issue = emulator.createIssue({ teamId: TEAM, title: "Parent" });
    emulator.advance(1000);
    const direct = emulator.createComment({ issueId: issue.id, body: "Direct" });
    const archived = emulator.createComment({ issueId: issue.id, body: "Archived" });
    emulator.archiveComment(archived.id);
    const seed = (comment: typeof direct) => ({
      kind: "comment.created" as const,
      entityId: comment.id,
      issueId: issue.id,
      occurredAt: comment.createdAt,
      comment,
    });

    expect(await provider.hydrate(API_KEY, seed(direct), signal())).toMatchObject({
      key: `comment.created:${direct.id}`,
      comment: direct,
      issue: { id: issue.id },
    });
    const before = emulator.requests().length;
    expect(await provider.hydrate(API_KEY, seed(archived), signal())).toMatchObject({
      kind: "comment.created",
      key: `comment.created:${archived.id}`,
      comment: archived,
      issue: { id: issue.id },
    });
    expect(emulator.requests().slice(before)).toEqual([
      { operation: "LinearComment", variables: { id: archived.id }, authorization: API_KEY },
      {
        operation: "LinearComments",
        variables: { first: 1, filter: { id: { eq: archived.id } } },
        authorization: API_KEY,
      },
    ]);
    const missing = { ...seed(direct), entityId: "comment-missing", comment: { ...direct, id: "comment-missing" } };
    expect(await provider.hydrate(API_KEY, missing, signal())).toBeNull();
    expect(await provider.hydrate(API_KEY, { ...seed(direct), issueId: "issue-other" }, signal())).toBeNull();
  });

  it("returns null for missing or forbidden resources but throws auth for key failure", async () => {
    const { emulator, provider } = setup();
    const visible = emulator.createIssue({ teamId: TEAM, title: "Visible" });
    const hidden = emulator.createIssue({ teamId: TEAM, title: "Hidden" });
    const deleted = emulator.createIssue({ teamId: TEAM, title: "Deleted" });
    const comment = emulator.createComment({ issueId: hidden.id, body: "On hidden issue" });
    emulator.forbid(hidden.id);
    emulator.deleteIssue(deleted.id);
    expect(await provider.hydrate(API_KEY, issueSeed(hidden), signal())).toBeNull();
    expect(await provider.hydrate(API_KEY, issueSeed(deleted), signal())).toBeNull();
    const before = emulator.requests().length;
    expect(
      await provider.hydrate(
        API_KEY,
        { kind: "comment.created", entityId: comment.id, issueId: hidden.id, occurredAt: comment.createdAt, comment },
        signal(),
      ),
    ).toBeNull();
    expect(emulator.requests().slice(before).map((entry) => entry.operation)).toEqual(["LinearComment"]);
    expect((await allChanges(provider, "issues")).events.map((event) => event.issue.id)).toEqual([visible.id]);
    emulator.forbid(TEAM);
    expect((await provider.options(API_KEY, { kind: "projects", teamId: TEAM }, signal())).items).toEqual([]);

    emulator.revokeKey(API_KEY);
    for (const call of [
      provider.identity(API_KEY, signal()),
      provider.hydrate(API_KEY, issueSeed(visible), signal()),
      provider.changes(API_KEY, { collection: "issues", from: FROM, through: THROUGH }, signal()),
      provider.options(API_KEY, { kind: "states", teamId: TEAM }, signal()),
    ]) {
      expect((await failureOf(call)).failure).toEqual({ code: "auth", retryAt: null });
    }
    expect((await failureOf(provider.identity("lin_api_unknown", signal()))).failure.code).toBe("auth");
    expect((await failureOf(provider.identity("bad\nkey", signal()))).failure.code).toBe("auth");
  });

  it.each([401, 403])("maps HTTP %i to auth", async (status) => {
    const { emulator, provider } = setup();
    emulator.failNext({ kind: "http", status });
    expect((await failureOf(provider.identity(API_KEY, signal()))).failure).toEqual({ code: "auth", retryAt: null });
  });

  it.each([500, 502, 503])("maps HTTP %i to unavailable", async (status) => {
    const { emulator, provider } = setup();
    emulator.failNext({ kind: "http", status });
    expect((await failureOf(provider.identity(API_KEY, signal()))).failure.code).toBe("unavailable");
  });

  it("maps transport failures to unavailable", async () => {
    const provider = createLinearProvider({
      fetch: (async () => {
        throw new TypeError(`connect ECONNREFUSED with ${API_KEY}`);
      }) as typeof fetch,
    });
    const error = await failureOf(provider.identity(API_KEY, signal()));
    expect(error.failure).toEqual({ code: "unavailable", retryAt: null });
    expect(error.cause).toBeUndefined();
  });

  it("rejects GraphQL errors returned with HTTP 200 and partial data", async () => {
    const { emulator, provider } = setup();
    emulator.createIssue({ teamId: TEAM, title: "Present" });
    emulator.failNext({ kind: "graphql", code: "INTERNAL_ERROR" }, { operation: "LinearIssues" });
    const unavailable = await failureOf(
      provider.changes(API_KEY, { collection: "issues", from: FROM, through: THROUGH }, signal()),
    );
    expect(unavailable.failure.code).toBe("unavailable");
    emulator.failNext({ kind: "graphql", code: "SOMETHING_UNEXPECTED" });
    expect((await failureOf(provider.identity(API_KEY, signal()))).failure.code).toBe("invalid_response");

    const partial = createLinearProvider({
      fetch: scriptedFetch(() =>
        json(200, {
          data: { viewer: { id: VIEWER }, organization: { id: ORG, name: "Synthetic Org" } },
          errors: [{ message: "Field failed", path: ["organization", "name"], extensions: { code: "INTERNAL_ERROR" } }],
        }),
      ),
    });
    expect((await failureOf(partial.identity(API_KEY, signal()))).failure.code).toBe("unavailable");
  });

  it("rejects malformed and oversized responses", async () => {
    const { emulator, provider } = setup();
    emulator.failNext({ kind: "malformed" });
    expect((await failureOf(provider.identity(API_KEY, signal()))).failure.code).toBe("invalid_response");
    emulator.failNext({ kind: "oversize" });
    expect((await failureOf(provider.identity(API_KEY, signal()))).failure.code).toBe("invalid_response");

    let declaredCancelled = false;
    const declared = createLinearProvider({
      fetch: (async () =>
        new Response(
          new ReadableStream({
            cancel() {
              declaredCancelled = true;
            },
          }),
          { status: 200, headers: { "content-length": String(16 * 1024 * 1024 + 1) } },
        )) as typeof fetch,
    });
    expect((await failureOf(declared.identity(API_KEY, signal()))).failure.code).toBe("invalid_response");
    expect(declaredCancelled).toBe(true);

    for (const body of [[], { data: null }, { data: { viewer: { id: "" }, organization: { id: ORG, name: "x" } } }]) {
      const provider = createLinearProvider({ fetch: scriptedFetch(() => json(200, body)) });
      expect((await failureOf(provider.identity(API_KEY, signal()))).failure.code).toBe("invalid_response");
    }
    const badDate = createLinearProvider({
      fetch: scriptedFetch(() =>
        json(200, {
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-1",
                  identifier: "ALP-1",
                  title: "Bad",
                  description: null,
                  url: null,
                  createdAt: "not a date",
                  updatedAt: "2026-03-01T00:00:00.000Z",
                  labelIds: [],
                  team: { id: TEAM },
                  project: null,
                  assignee: null,
                  state: null,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
    });
    expect(
      (await failureOf(badDate.changes(API_KEY, { collection: "issues", from: FROM, through: THROUGH }, signal())))
        .failure.code,
    ).toBe("invalid_response");
  });

  it("rejects incomplete pagination", async () => {
    for (const pageInfo of [
      { hasNextPage: true, endCursor: null },
      { hasNextPage: true, endCursor: "" },
      { hasNextPage: true, endCursor: "cursor-same" },
      { hasNextPage: "yes", endCursor: "cursor-next" },
    ]) {
      const provider = createLinearProvider({
        fetch: scriptedFetch(() => json(200, { data: { issues: { nodes: [], pageInfo } } })),
      });
      const error = await failureOf(
        provider.changes(
          API_KEY,
          { collection: "issues", from: FROM, through: THROUGH, cursor: "cursor-same" },
          signal(),
        ),
      );
      expect(error.failure.code).toBe("invalid_response");
    }
  });

  it.each([
    { type: "AuthenticationError", status: 400, cursor: undefined, code: "auth" },
    { type: "authentication error", status: 400, cursor: undefined, code: "auth" },
    { type: "Forbidden", status: 200, cursor: undefined, code: "auth" },
    { type: "Ratelimited", status: 400, cursor: undefined, code: "rate_limit" },
    { type: "InvalidInput", status: 400, cursor: "cursor-1", code: "invalid_cursor" },
    { type: "InvalidInput", status: 400, cursor: undefined, code: "invalid_response" },
    { type: "InternalError", status: 200, cursor: undefined, code: "unavailable" },
    { type: "LockTimeout", status: 200, cursor: undefined, code: "unavailable" },
    { type: "NetworkError", status: 200, cursor: undefined, code: "unavailable" },
    { type: "UsageLimitExceeded", status: 200, cursor: undefined, code: "invalid_response" },
  ])("classifies type-only $type errors as $code", async ({ type, status, cursor, code }) => {
    const provider = createLinearProvider({
      fetch: scriptedFetch(() =>
        json(status, {
          data: null,
          errors: [{ message: "Upstream", extensions: { type, userPresentableMessage: "Upstream" } }],
        }),
      ),
    });
    const error = await failureOf(
      provider.changes(API_KEY, { collection: "issues", from: FROM, through: THROUGH, cursor }, signal()),
    );
    expect(error.failure.code).toBe(code);
  });

  it("treats type-only resource denial and absence as missing", async () => {
    for (const extensions of [{ type: "Forbidden" }, { type: "InvalidInput" }]) {
      const provider = createLinearProvider({
        fetch: scriptedFetch(() =>
          json(200, {
            data: { issue: null },
            errors: [{ message: extensions.type === "Forbidden" ? "Forbidden" : "Entity not found: Issue", path: ["issue"], extensions }],
          }),
        ),
      });
      const issue: IssueTrackerIssue = {
        id: "issue-1",
        identifier: "ALP-1",
        title: "Synthetic",
        description: null,
        url: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:01.000Z",
        teamId: TEAM,
        projectId: null,
        assigneeId: null,
        stateId: null,
        labelIds: [],
      };
      expect(await provider.hydrate(API_KEY, issueSeed(issue), signal())).toBeNull();
    }
  });

  it("maps a rejected cursor to invalid_cursor", async () => {
    const { provider } = setup();
    const error = await failureOf(
      provider.changes(API_KEY, { collection: "comments", from: FROM, through: THROUGH, cursor: "%%%" }, signal()),
    );
    expect(error.failure).toEqual({ code: "invalid_cursor", retryAt: null });
  });

  describe("rate limits", () => {
    const now = Date.parse("2026-03-01T12:00:00.000Z");

    async function retryAt(response: () => Response): Promise<string | null> {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const provider = createLinearProvider({ fetch: scriptedFetch(response) });
      const error = await failureOf(provider.identity(API_KEY, signal()));
      expect(error.failure.code).toBe("rate_limit");
      return error.failure.retryAt;
    }

    const ratelimited = (headers: Record<string, string>) => () =>
      json(400, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, headers);

    it("uses one second beyond the latest reset header even on HTTP 400", async () => {
      expect(
        await retryAt(
          ratelimited({
            "X-RateLimit-Requests-Reset": String(now + 10_000),
            "X-RateLimit-Endpoint-Requests-Reset": String(now + 30_000),
            "X-RateLimit-Complexity-Reset": String(now + 20_000),
          }),
        ),
      ).toBe(new Date(now + 31_000).toISOString());
    });

    it("includes Retry-After seconds and HTTP dates", async () => {
      expect(
        await retryAt(ratelimited({ "X-RateLimit-Requests-Reset": String(now + 5_000), "Retry-After": "45" })),
      ).toBe(new Date(now + 46_000).toISOString());
      expect(
        await retryAt(() =>
          json(429, {}, { "Retry-After": new Date(now + 120_000).toUTCString() }),
        ),
      ).toBe(new Date(now + 121_000).toISOString());
    });

    it("ignores invalid headers and falls back to sixty seconds", async () => {
      expect(
        await retryAt(
          ratelimited({
            "X-RateLimit-Requests-Reset": "soon",
            "X-RateLimit-Complexity-Reset": "-5",
            "X-RateLimit-Endpoint-Requests-Reset": String(now + 365 * 24 * 60 * 60 * 1000),
            "Retry-After": "never",
          }),
        ),
      ).toBe(new Date(now + 60_000).toISOString());
      expect(await retryAt(() => json(429, {}))).toBe(new Date(now + 60_000).toISOString());
    });

    it("never schedules a retry in the past", async () => {
      expect(await retryAt(ratelimited({ "X-RateLimit-Requests-Reset": String(now - 30_000) }))).toBe(
        new Date(now + 1_000).toISOString(),
      );
    });

    it("prefers auth over rate limit and recognizes emulator rate limits", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      const both = createLinearProvider({
        fetch: scriptedFetch(() =>
          json(400, {
            errors: [
              { message: "limited", extensions: { code: "RATELIMITED" } },
              { message: "no", extensions: { type: "authentication error" } },
            ],
          }),
        ),
      });
      expect((await failureOf(both.identity(API_KEY, signal()))).failure.code).toBe("auth");
      const { emulator, provider } = setup();
      emulator.failNext({
        kind: "graphql",
        code: "RATELIMITED",
        headers: { "X-RateLimit-Requests-Reset": String(now + 2_000) },
      });
      expect((await failureOf(provider.identity(API_KEY, signal()))).failure).toEqual({
        code: "rate_limit",
        retryAt: new Date(now + 3_000).toISOString(),
      });
    });
  });

  it("propagates caller aborts instead of mapping them to provider failures", async () => {
    const { emulator, provider } = setup();
    const pre = new AbortController();
    const preReason = new Error("phase ended");
    pre.abort(preReason);
    await expect(provider.identity(API_KEY, pre.signal)).rejects.toBe(preReason);
    expect(emulator.requests()).toHaveLength(0);

    emulator.failNext({ kind: "delay", ms: 60_000, until: new Promise<void>(() => undefined) });
    const controller = new AbortController();
    const reason = new Error("shutdown");
    const pending = provider.identity(API_KEY, controller.signal);
    await vi.waitFor(() => expect(emulator.requests()).toHaveLength(1));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);

    let markStarted!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const streamed = createLinearProvider({
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"data":'));
              markStarted();
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    const bodyController = new AbortController();
    const bodyReason = new Error("body aborted");
    const reading = streamed.identity(API_KEY, bodyController.signal);
    await bodyStarted;
    bodyController.abort(bodyReason);
    await expect(reading).rejects.toBe(bodyReason);
  });

  it("never exposes the credential or upstream content in failures", async () => {
    const secretBody = `upstream detail ${API_KEY}`;
    const responses = [
      () => json(400, { errors: [{ message: secretBody, extensions: { code: "AUTHENTICATION_ERROR" } }] }),
      () => json(200, { errors: [{ message: secretBody, extensions: { code: "INTERNAL_ERROR" } }] }),
      () => json(400, { errors: [{ message: secretBody, extensions: { code: "RATELIMITED" } }] }),
      () => new Response(secretBody, { status: 200 }),
      () => new Response(secretBody, { status: 404 }),
      () => json(502, { message: secretBody }),
    ];
    for (const response of responses) {
      const provider = createLinearProvider({ fetch: scriptedFetch(response) });
      const error = await failureOf(provider.identity(API_KEY, signal()));
      expect(Object.keys(error.failure).sort()).toEqual(["code", "retryAt"]);
      const rendered = `${String(error)} ${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
      expect(rendered).not.toContain(API_KEY);
      expect(rendered).not.toContain("upstream detail");
      expect(error.cause).toBeUndefined();
    }
  });
});

describe("createLinearEmulator webhooks", () => {
  it("signs Issue deliveries exactly like Linear", () => {
    const { emulator } = setup();
    const issue = emulator.createIssue({
      teamId: TEAM,
      title: "Hooked",
      description: "Body",
      projectId: "project-1",
      assigneeId: VIEWER,
      stateId: "state-1",
      labelIds: ["label-1"],
    });
    const { body, headers } = emulator.webhook({
      signingSecret: "whsec-synthetic",
      type: "Issue",
      action: "create",
      entityId: issue.id,
      deliveryId: "delivery-1",
    });
    expect(headers["Linear-Signature"]).toBe(createHmac("sha256", "whsec-synthetic").update(body).digest("hex"));
    expect(headers["Linear-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["Linear-Delivery"]).toBe("delivery-1");
    expect(headers["Linear-Event"]).toBe("Issue");
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      action: "create",
      type: "Issue",
      organizationId: ORG,
      webhookTimestamp: BASE,
      data: {
        id: issue.id,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        identifier: issue.identifier,
        title: "Hooked",
        description: "Body",
        url: issue.url,
        teamId: TEAM,
        projectId: "project-1",
        assigneeId: VIEWER,
        stateId: "state-1",
        labelIds: ["label-1"],
      },
    });
  });

  it("signs Comment deliveries with overrides", () => {
    const { emulator } = setup();
    const issue = emulator.createIssue({ teamId: TEAM, title: "Parent" });
    const comment = emulator.createComment({ issueId: issue.id, body: "Hello", authorId: "user-7" });
    const first = emulator.webhook({ signingSecret: "s", type: "Comment", action: "create", entityId: comment.id });
    const second = emulator.webhook({
      signingSecret: "s",
      type: "Comment",
      action: "create",
      entityId: comment.id,
      timestampMs: 1234,
      organizationId: "org-other",
    });
    expect(first.headers["Linear-Delivery"]).not.toBe(second.headers["Linear-Delivery"]);
    expect(first.headers["Linear-Event"]).toBe("Comment");
    expect(JSON.parse(first.body)).toMatchObject({
      data: {
        id: comment.id,
        body: "Hello",
        createdAt: comment.createdAt,
        issueId: issue.id,
        userId: "user-7",
        url: comment.url,
      },
    });
    expect(JSON.parse(second.body)).toMatchObject({ webhookTimestamp: 1234, organizationId: "org-other" });
    expect(comment.url?.startsWith(`https://${LINEAR_PUBLIC_HOSTS[0]}/`)).toBe(true);
  });

  it("resets state, clock and request log", async () => {
    const { emulator, provider } = setup();
    emulator.advance(5000);
    emulator.createIssue({ teamId: TEAM, title: "Gone" });
    await provider.identity(API_KEY, signal());
    emulator.reset();
    expect(emulator.requests()).toEqual([]);
    expect((await failureOf(provider.identity(API_KEY, signal()))).failure.code).toBe("auth");
    emulator.addWorkspace({ organizationId: ORG, organizationName: "Synthetic Org", viewerId: VIEWER, apiKey: API_KEY });
    emulator.addTeam({ id: TEAM, name: "Alpha" });
    expect(emulator.createIssue({ teamId: TEAM, title: "Fresh" }).createdAt).toBe(new Date(BASE).toISOString());
    expect((await allChanges(provider, "issues")).events).toHaveLength(1);
  });
});
