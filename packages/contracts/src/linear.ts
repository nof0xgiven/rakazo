import * as z from "zod";
import { ConnectionStatus, Id, IsoDate } from "./ids.js";

export const LINEAR_CONNECTOR_ID = "linear";
export const LINEAR_PROVIDER = "linear";
export const LINEAR_AUTOMATION_CAPABILITY = "automation_triggers";

export const LINEAR_EVENT_KINDS = ["issue.created", "issue.updated", "comment.created"] as const;
export const LinearEventKindSchema = z.enum(LINEAR_EVENT_KINDS);
export type LinearEventKind = z.infer<typeof LinearEventKindSchema>;

export const LINEAR_MAX_LABELS = 20;

export const LinearProviderId = z.string().min(1).max(100);

export const LinearTriggerSchema = z
  .object({
    connectionId: Id,
    teamId: LinearProviderId,
    events: z.array(LinearEventKindSchema).min(1).max(3),
    projectId: LinearProviderId.nullable().default(null),
    assigneeId: LinearProviderId.nullable().default(null),
    stateId: LinearProviderId.nullable().default(null),
    labelIds: z.array(LinearProviderId).max(LINEAR_MAX_LABELS).default([]),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.events).size !== value.events.length) {
      ctx.addIssue({ code: "custom", message: "Choose each event once", path: ["events"] });
    }
    if (new Set(value.labelIds).size !== value.labelIds.length) {
      ctx.addIssue({ code: "custom", message: "Choose each label once", path: ["labelIds"] });
    }
  })
  .transform((value) => ({
    ...value,
    events: LINEAR_EVENT_KINDS.filter((kind) => value.events.includes(kind)),
    labelIds: [...value.labelIds].sort(),
  }));
export type LinearTrigger = z.output<typeof LinearTriggerSchema>;
export type LinearTriggerInput = z.input<typeof LinearTriggerSchema>;

export const LinearOptionSchema = z.object({ id: z.string(), name: z.string() });
export type LinearOption = z.infer<typeof LinearOptionSchema>;

export const LinearOptionsSchema = z.object({
  items: z.array(LinearOptionSchema),
  nextCursor: z.string().nullable(),
});
export type LinearOptions = z.infer<typeof LinearOptionsSchema>;

export const LINEAR_OPTION_KINDS = ["teams", "projects", "assignees", "states", "labels"] as const;
export const LinearOptionKindSchema = z.enum(LINEAR_OPTION_KINDS);
export type LinearOptionKind = z.infer<typeof LinearOptionKindSchema>;

export const LINEAR_ERROR_CODES = ["auth", "rate_limit", "unavailable", "invalid_response"] as const;
export const LinearErrorCodeSchema = z.enum(LINEAR_ERROR_CODES);
export type LinearErrorCode = z.infer<typeof LinearErrorCodeSchema>;

export const LinearMonitoringSchema = z.enum(["idle", "polling", "error"]);
export type LinearMonitoring = z.infer<typeof LinearMonitoringSchema>;

export const LinearConnectionStatusSchema = z.object({
  connectionId: Id,
  revision: z.number().int(),
  organizationName: z.string(),
  viewerId: z.string(),
  connectionStatus: ConnectionStatus,
  monitoring: LinearMonitoringSchema,
  webhookConfigured: z.boolean(),
  webhookUrl: z.string().nullable(),
  lastPolledAt: IsoDate.nullable(),
  lastWebhookAt: IsoDate.nullable(),
  lastEventAt: IsoDate.nullable(),
  nextPollAt: IsoDate.nullable(),
  nextSyncAt: IsoDate.nullable(),
  rateLimitedUntil: IsoDate.nullable(),
  errorCode: LinearErrorCodeSchema.nullable(),
});
export type LinearConnectionStatus = z.infer<typeof LinearConnectionStatusSchema>;

const LinearSecretInput = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => !/[\r\n]/.test(value), "Remove line breaks");

export const LinearConnectInputSchema = z
  .object({
    apiKey: LinearSecretInput,
    displayName: z.string().trim().min(1).max(80),
    connectionId: Id.optional(),
    expectedRevision: z.number().int().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.connectionId === undefined) !== (value.expectedRevision === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Reconnect needs the connection and its revision",
        path: ["expectedRevision"],
      });
    }
  });
export type LinearConnectInput = z.infer<typeof LinearConnectInputSchema>;

export const LinearOptionsInputSchema = z
  .object({
    connectionId: Id,
    kind: LinearOptionKindSchema,
    teamId: LinearProviderId.optional(),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "teams" && value.teamId !== undefined) {
      ctx.addIssue({ code: "custom", message: "Teams take no team", path: ["teamId"] });
    }
    if (value.kind !== "teams" && value.teamId === undefined) {
      ctx.addIssue({ code: "custom", message: "Choose a team", path: ["teamId"] });
    }
  });
export type LinearOptionsInput = z.infer<typeof LinearOptionsInputSchema>;

export const LinearConfigureWebhookInputSchema = z.object({
  connectionId: Id,
  expectedRevision: z.number().int(),
  signingSecret: LinearSecretInput.nullable(),
});
export type LinearConfigureWebhookInput = z.infer<typeof LinearConfigureWebhookInputSchema>;
