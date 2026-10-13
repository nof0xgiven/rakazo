import type { ModelConfigurationUsage, ThinkingLevel } from "@rakazo/contracts";
import {
  MODEL_CONFIGURATION_CONFLICT_MESSAGES,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ThinkingLevelSchema,
  usableModelId,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { chooseModelCredential, lockModelConfigurationOwner } from "./model-credentials.js";
import { withTransactionRetry } from "./transaction-retry.js";

/**
 * Every write that changes model enablement, model references or which
 * credential a reference resolves to runs here. The owner lock is the first
 * statement and the isolation is ReadCommitted so a waiter sees what the
 * previous holder committed.
 */
export async function withModelConfigurationOwnerLock<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx) => {
        await lockModelConfigurationOwner(tx, userId);
        return fn(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    ),
  );
}

export type ModelConfigurationConflictReason =
  | "models_in_use"
  | "model_connection_in_use"
  | "model_effort_in_use";

const USAGE_KIND_ORDER: Record<ModelConfigurationUsage["kind"], number> = {
  default: 0,
  bot: 1,
  routine: 2,
  backup: 3,
  run: 4,
  steering: 5,
};

function compareText(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function sortModelConfigurationUsages(
  usages: readonly ModelConfigurationUsage[],
): ModelConfigurationUsage[] {
  const unique = new Map<string, ModelConfigurationUsage>();
  for (const usage of usages) unique.set(modelReferenceKey(usage), usage);
  return [...unique.values()].sort(
    (left, right) =>
      USAGE_KIND_ORDER[left.kind] - USAGE_KIND_ORDER[right.kind] ||
      compareText(left.spaceName, right.spaceName) ||
      compareText(left.spaceId, right.spaceId) ||
      compareText(left.name, right.name) ||
      compareText(left.id, right.id),
  );
}

/** Thrown inside an owner-locked transaction so every tentative write rolls back. */
export class ModelConfigurationConflictError extends Error {
  readonly reason: ModelConfigurationConflictReason;
  readonly usages: ModelConfigurationUsage[];
  constructor(
    reason: ModelConfigurationConflictReason,
    usages: readonly ModelConfigurationUsage[],
    message: string = MODEL_CONFIGURATION_CONFLICT_MESSAGES[reason],
  ) {
    super(message);
    this.name = "ModelConfigurationConflictError";
    this.reason = reason;
    this.usages = sortModelConfigurationUsages(usages);
  }
}

export type CompatibleModelReference = ModelConfigurationUsage;

/** A bot without its own model; it runs the space default with this explicit effort. */
export type DefaultFollowerBot = {
  spaceId: string;
  spaceName: string;
  id: string;
  name: string;
  thinkingLevel: ThinkingLevel;
};

/** An explicit effort some primary in the space can run with and hand to a backup on failover. */
export type SpacePrimaryEffort = { spaceId: string; thinkingLevel: ThinkingLevel };

export type CompatibleModelReferences = {
  references: CompatibleModelReference[];
  followers: DefaultFollowerBot[];
  primaryEfforts: SpacePrimaryEffort[];
};

export function modelReferenceKey(
  reference: Pick<ModelConfigurationUsage, "kind" | "spaceId" | "id">,
) {
  return `${reference.kind}:${reference.spaceId}:${reference.id}`;
}

export function parseStoredThinkingLevel(value: string | null | undefined): ThinkingLevel | null {
  const parsed = ThinkingLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type ReferenceReader = Pick<
  Prisma.TransactionClient,
  | "spaceMember"
  | "spaceModelPreference"
  | "bot"
  | "routine"
  | "spaceBackupModel"
  | "run"
  | "steeringMessage"
>;

/**
 * Persistent OpenAI-compatible references the owner can see across their
 * spaces: active defaults, bot overrides (archived too), routine overrides
 * (inactive too), backups, pinned nonterminal runs and pinned steering not yet
 * attached to a run. Bots following the space default are returned separately
 * when they carry an explicit effort.
 */
export async function loadCompatibleModelReferences(
  tx: ReferenceReader,
  userId: string,
  options: { spaceIds?: readonly string[] } = {},
): Promise<CompatibleModelReferences> {
  const memberships = await tx.spaceMember.findMany({
    where: { userId, ...(options.spaceIds ? { spaceId: { in: [...options.spaceIds] } } : {}) },
    select: { spaceId: true, space: { select: { name: true } } },
  });
  if (memberships.length === 0) return { references: [], followers: [], primaryEfforts: [] };
  const spaceNames = new Map(
    memberships.map((membership) => [membership.spaceId, membership.space.name]),
  );
  const spaceId = { in: [...spaceNames.keys()] };
  const provider = OPENAI_COMPATIBLE_PROVIDER_ID;
  const effortSelect = { spaceId: true, thinkingLevel: true } as const;
  const effortRows = { userId, spaceId, thinkingLevel: { not: null } };
  const effortDistinct: ("spaceId" | "thinkingLevel")[] = ["spaceId", "thinkingLevel"];
  const [
    defaults,
    bots,
    followers,
    routines,
    backups,
    runs,
    steering,
    botEfforts,
    routineEfforts,
    preferenceEfforts,
  ] = await Promise.all([
    tx.spaceModelPreference.findMany({
      where: { userId, spaceId, isDefault: true, credential: { provider } },
      select: { id: true, spaceId: true, modelId: true, thinkingLevel: true },
    }),
    tx.bot.findMany({
      where: { userId, spaceId, modelProvider: provider, modelId: { not: null } },
      select: { id: true, spaceId: true, name: true, modelId: true, thinkingLevel: true },
    }),
    tx.bot.findMany({
      where: {
        userId,
        spaceId,
        thinkingLevel: { not: null },
        OR: [{ modelProvider: null }, { modelId: null }],
      },
      select: { id: true, spaceId: true, name: true, thinkingLevel: true },
    }),
    tx.routine.findMany({
      where: { userId, spaceId, modelProvider: provider, modelId: { not: null } },
      select: { id: true, spaceId: true, name: true, modelId: true, thinkingLevel: true },
    }),
    tx.spaceBackupModel.findMany({
      where: { userId, spaceId, provider },
      select: { spaceId: true, modelId: true },
    }),
    tx.run.findMany({
      where: {
        userId,
        spaceId,
        modelPinned: true,
        status: { in: [...ACTIVE_RUN_STATUSES] },
        modelProvider: provider,
        modelId: { not: null },
      },
      select: {
        id: true,
        spaceId: true,
        modelId: true,
        thinkingLevel: true,
        bot: { select: { name: true } },
      },
    }),
    tx.steeringMessage.findMany({
      where: {
        userId,
        runId: null,
        modelProvider: provider,
        modelId: { not: null },
        bot: { spaceId },
      },
      select: {
        id: true,
        modelId: true,
        thinkingLevel: true,
        bot: { select: { name: true, spaceId: true } },
      },
    }),
    tx.bot.findMany({ where: effortRows, select: effortSelect, distinct: effortDistinct }),
    tx.routine.findMany({ where: effortRows, select: effortSelect, distinct: effortDistinct }),
    tx.spaceModelPreference.findMany({
      where: effortRows,
      select: effortSelect,
      distinct: effortDistinct,
    }),
  ]);
  const references: CompatibleModelReference[] = [];
  const add = (
    kind: CompatibleModelReference["kind"],
    row: {
      spaceId: string;
      id: string;
      name: string;
      modelId: string | null;
      thinkingLevel: string | null;
    },
  ) => {
    const modelId = usableModelId(row.modelId);
    if (!modelId) return;
    references.push({
      kind,
      spaceId: row.spaceId,
      spaceName: spaceNames.get(row.spaceId) ?? "",
      id: row.id,
      name: row.name,
      modelId,
      thinkingLevel: parseStoredThinkingLevel(row.thinkingLevel),
    });
  };
  for (const row of defaults) {
    add("default", { ...row, name: spaceNames.get(row.spaceId) ?? "" });
  }
  for (const row of bots) add("bot", row);
  for (const row of routines) add("routine", row);
  for (const row of backups) {
    add("backup", {
      spaceId: row.spaceId,
      id: row.modelId,
      name: row.modelId,
      modelId: row.modelId,
      thinkingLevel: null,
    });
  }
  for (const row of runs) add("run", { ...row, name: row.bot.name });
  for (const row of steering) {
    add("steering", { ...row, spaceId: row.bot.spaceId, name: row.bot.name });
  }
  const primaryEfforts = new Map<string, SpacePrimaryEffort>();
  for (const row of [
    ...botEfforts,
    ...routineEfforts,
    ...preferenceEfforts,
    ...references.filter((reference) => reference.kind === "run" || reference.kind === "steering"),
  ]) {
    const thinkingLevel = parseStoredThinkingLevel(row.thinkingLevel);
    if (thinkingLevel) {
      primaryEfforts.set(`${row.spaceId}:${thinkingLevel}`, {
        spaceId: row.spaceId,
        thinkingLevel,
      });
    }
  }
  return {
    references,
    primaryEfforts: [...primaryEfforts.values()],
    followers: followers.flatMap((row) => {
      const thinkingLevel = parseStoredThinkingLevel(row.thinkingLevel);
      return thinkingLevel
        ? [
            {
              spaceId: row.spaceId,
              spaceName: spaceNames.get(row.spaceId) ?? "",
              id: row.id,
              name: row.name,
              thinkingLevel,
            },
          ]
        : [];
    }),
  };
}

export type CompatibleReferenceBinding = {
  credentialId: string | null;
  /** Effort saved on the space preference that owns exactly this model id. */
  preferenceThinkingLevel: ThinkingLevel | null;
};

type BindingReader = Pick<Prisma.TransactionClient, "spaceModelPreference" | "userModelCredential">;

/** Credential each reference resolves to in its own space, by the regular chooser. */
export async function resolveCompatibleReferenceBindings(
  tx: BindingReader,
  userId: string,
  references: readonly Pick<CompatibleModelReference, "spaceId" | "modelId">[],
): Promise<CompatibleReferenceBinding[]> {
  if (references.length === 0) return [];
  const provider = OPENAI_COMPATIBLE_PROVIDER_ID;
  const [preferences, credentials] = await Promise.all([
    tx.spaceModelPreference.findMany({
      where: {
        userId,
        spaceId: { in: [...new Set(references.map((reference) => reference.spaceId))] },
        credential: { provider },
      },
      include: { credential: true },
    }),
    tx.userModelCredential.findMany({ where: { userId, provider } }),
  ]);
  const preferencesBySpace = new Map<string, typeof preferences>();
  for (const preference of preferences) {
    const list = preferencesBySpace.get(preference.spaceId) ?? [];
    list.push(preference);
    preferencesBySpace.set(preference.spaceId, list);
  }
  return references.map((reference) => {
    const choice = chooseModelCredential({
      provider,
      modelId: reference.modelId,
      preferences: preferencesBySpace.get(reference.spaceId) ?? [],
      credentials,
    });
    if (!choice) return { credentialId: null, preferenceThinkingLevel: null };
    if (choice.source === "credential") {
      return { credentialId: choice.credential.id, preferenceThinkingLevel: null };
    }
    const { preference } = choice;
    return {
      credentialId: preference.credential.id,
      preferenceThinkingLevel:
        usableModelId(preference.modelId) === reference.modelId
          ? parseStoredThinkingLevel(preference.thinkingLevel)
          : null,
    };
  });
}

export type CompatibleReferenceBindingSnapshot = {
  references: CompatibleModelReference[];
  credentialIds: (string | null)[];
};

export async function snapshotCompatibleReferenceBindings(
  tx: ReferenceReader & BindingReader,
  userId: string,
  options: { spaceIds?: readonly string[]; references?: CompatibleModelReference[] } = {},
): Promise<CompatibleReferenceBindingSnapshot> {
  const references =
    options.references ?? (await loadCompatibleModelReferences(tx, userId, options)).references;
  const bindings = await resolveCompatibleReferenceBindings(tx, userId, references);
  return { references, credentialIds: bindings.map((binding) => binding.credentialId) };
}

/**
 * Rereads the transaction's tentative state: a reference that resolved to a
 * credential must still resolve to the same one, whatever re-ranked it
 * (timestamps, default flags, exact-model preferences). `exclude` drops the
 * default row the writer deliberately changed.
 */
export async function assertCompatibleReferenceBindingsUnchanged(
  tx: BindingReader,
  userId: string,
  snapshot: CompatibleReferenceBindingSnapshot,
  exclude: (reference: CompatibleModelReference) => boolean = () => false,
): Promise<void> {
  const checked = snapshot.references.flatMap((reference, index) => {
    const before = snapshot.credentialIds[index];
    return before && !exclude(reference) ? [{ reference, before }] : [];
  });
  const after = await resolveCompatibleReferenceBindings(
    tx,
    userId,
    checked.map((item) => item.reference),
  );
  const rebound = checked.flatMap((item, index) =>
    after[index]?.credentialId === item.before ? [] : [item.reference],
  );
  if (rebound.length > 0) {
    throw new ModelConfigurationConflictError("model_connection_in_use", rebound);
  }
}
