import { linearSyncJob } from "@rakazo/adapter-kit";
import type { LinearEmulator } from "@rakazo/adapters";
import type { AppHandles } from "../../../../apps/api/src/app.ts";

export const LINEAR_FIXTURE_PATH = "/__e2e/linear";

const WORKSPACE = {
  organizationId: "org-e2e-0000",
  organizationName: "Rakazo E2E",
  viewerId: "user-e2e-viewer",
  apiKey: "lin_api_e2e_synthetic_key_0000000000",
};

type FixtureAction =
  | { action: "team"; id: string; name: string }
  | {
      action: "createIssue";
      teamId: string;
      title: string;
      stateId?: string | null;
      projectId?: string | null;
      assigneeId?: string | null;
      labelIds?: string[];
    }
  | {
      action: "updateIssue";
      id: string;
      patch: { title?: string; stateId?: string | null; labelIds?: string[] };
    }
  | { action: "createComment"; issueId: string; body: string }
  | { action: "pollNow" }
  | {
      action: "webhook";
      connectionId: string;
      signingSecret: string;
      type: "Issue" | "Comment";
      webhookAction: "create" | "update" | "remove";
      entityId: string;
    };

export function seedLinearEmulator(emulator: LinearEmulator): void {
  emulator.addWorkspace(WORKSPACE);
}

export async function handleLinearFixture(
  request: Request,
  emulator: LinearEmulator,
  handles: AppHandles,
  apiOrigin: string,
): Promise<Response> {
  if (request.method === "GET") return Response.json({ apiKey: WORKSPACE.apiKey });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const input = (await request.json()) as FixtureAction;
  switch (input.action) {
    case "team": {
      emulator.addTeam({ id: input.id, name: input.name });
      emulator.addState({ id: `${input.id}-todo`, name: "Todo", teamId: input.id });
      emulator.addState({ id: `${input.id}-done`, name: "Done", teamId: input.id });
      emulator.addProject({ id: `${input.id}-project`, name: "Checkout", teamIds: [input.id] });
      emulator.addMember({ id: `${input.id}-member`, name: "Alex Doe", teamIds: [input.id] });
      emulator.addLabel({ id: `${input.id}-bug`, name: "Bug", teamId: input.id });
      emulator.addLabel({ id: `${input.id}-urgent`, name: "Urgent", teamId: input.id });
      return Response.json({ ok: true });
    }
    case "createIssue":
      return Response.json(
        emulator.createIssue({
          teamId: input.teamId,
          title: input.title,
          stateId: input.stateId ?? null,
          projectId: input.projectId ?? null,
          assigneeId: input.assigneeId ?? null,
          labelIds: input.labelIds ?? [],
        }),
      );
    case "updateIssue":
      return Response.json(emulator.updateIssue(input.id, input.patch));
    case "createComment":
      return Response.json(emulator.createComment({ issueId: input.issueId, body: input.body }));
    case "pollNow": {
      const sources = await handles.prisma.linearSource.findMany({
        where: { monitoringSince: { not: null } },
        select: { connectionId: true },
      });
      const now = new Date();
      await handles.prisma.linearSource.updateMany({
        where: { connectionId: { in: sources.map((source) => source.connectionId) } },
        data: { nextPollAt: now, nextSyncAt: now },
      });
      for (const source of sources) {
        await handles.jobs.enqueue(linearSyncJob({ connectionId: source.connectionId }));
      }
      return Response.json({ sources: sources.length });
    }
    case "webhook": {
      const signed = emulator.webhook({
        signingSecret: input.signingSecret,
        type: input.type,
        action: input.webhookAction,
        entityId: input.entityId,
      });
      const delivered = await handles.app.fetch(
        new Request(
          `${apiOrigin}/api/integrations/linear/${encodeURIComponent(input.connectionId)}/webhook`,
          { method: "POST", headers: signed.headers, body: signed.body },
        ),
      );
      return Response.json({ status: delivered.status });
    }
    default:
      return new Response(null, { status: 400 });
  }
}
