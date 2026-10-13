import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { OpenAiCompatibleModelConfig, ThinkingLevel } from "@rakazo/contracts";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { credentialEnablesModel, findModelCredential } from "@rakazo/db";
import { openAiCompatibleModelConfig } from "./openai-compatible-models.js";
import { parseModelSecret, type StoredModelSecret } from "./pi-oauth.js";

type Scope = { userId: string; spaceId: string };

export type CompatibleModelChoiceProblem =
  | "not_connected"
  | "not_enabled"
  | "not_configured"
  | "unsupported_effort"
  | "changed";

const PROBLEM_MESSAGES: Record<CompatibleModelChoiceProblem, string> = {
  not_connected: "Connect an OpenAI-compatible server first.",
  not_enabled: "This model is not enabled for the connection.",
  not_configured: "This model's settings are missing. Open model settings to configure it.",
  unsupported_effort: "This model does not support that reasoning effort.",
  changed: "Model settings changed; try again.",
};

/** A compatible model choice that cannot be saved. Callers map it to BAD_REQUEST. */
export class CompatibleModelChoiceError extends Error {
  readonly problem: CompatibleModelChoiceProblem;
  constructor(problem: CompatibleModelChoiceProblem) {
    super(PROBLEM_MESSAGES[problem]);
    this.name = "CompatibleModelChoiceError";
    this.problem = problem;
  }
}

/** The prepared snapshot no longer matches committed state; prepare again. */
export class StaleCompatibleModelSnapshotError extends Error {
  constructor() {
    super(PROBLEM_MESSAGES.changed);
    this.name = "StaleCompatibleModelSnapshotError";
  }
}

/**
 * Resolution of one compatible model through the regular credential chooser,
 * prepared outside any owner lock (it decrypts). `assertCompatibleModelSnapshot`
 * proves it is still current inside the locked write.
 */
export type CompatibleModelSnapshot = {
  modelId: string;
  credentialId: string;
  secretId: string;
  configurationVersion: number;
  config: OpenAiCompatibleModelConfig;
};

type SnapshotReader = Pick<PrismaClient, "spaceModelPreference" | "userModelCredential" | "secret">;

export async function loadCompatibleModelSnapshot(
  prisma: SnapshotReader,
  secretStore: Pick<SecretStore, "load">,
  scope: Scope,
  modelId: string,
): Promise<CompatibleModelSnapshot> {
  const credential = await findModelCredential(
    prisma,
    scope,
    OPENAI_COMPATIBLE_PROVIDER_ID,
    modelId,
  );
  if (!credential) throw new CompatibleModelChoiceError("not_connected");
  if (!credentialEnablesModel(credential, modelId)) {
    throw new CompatibleModelChoiceError("not_enabled");
  }
  const secret = await prisma.secret.findFirst({
    where: { id: credential.secretId, userId: scope.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) throw new CompatibleModelChoiceError("not_configured");
  let parsed: StoredModelSecret;
  try {
    parsed = parseModelSecret(await secretStore.load(secret.ciphertext, secret.id));
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) throw error;
    throw new CompatibleModelChoiceError("not_configured");
  }
  if (parsed.kind !== "openai_compatible") throw new CompatibleModelChoiceError("not_configured");
  const config = openAiCompatibleModelConfig(parsed, credential, modelId);
  if (!config) throw new CompatibleModelChoiceError("not_configured");
  return {
    modelId,
    credentialId: credential.id,
    secretId: credential.secretId,
    configurationVersion: credential.modelConfigurationVersion,
    config,
  };
}

/**
 * Inside the owner-locked transaction: the chooser must still pick the same
 * credential with the same secret and configuration version, and the model
 * must still be enabled. Throws `StaleCompatibleModelSnapshotError` otherwise.
 */
export async function assertCompatibleModelSnapshot(
  tx: Pick<Prisma.TransactionClient, "spaceModelPreference" | "userModelCredential">,
  scope: Scope,
  snapshot: CompatibleModelSnapshot,
): Promise<void> {
  const credential = await findModelCredential(
    tx,
    scope,
    OPENAI_COMPATIBLE_PROVIDER_ID,
    snapshot.modelId,
  );
  if (
    !credential ||
    credential.id !== snapshot.credentialId ||
    credential.secretId !== snapshot.secretId ||
    credential.modelConfigurationVersion !== snapshot.configurationVersion ||
    !credentialEnablesModel(credential, snapshot.modelId)
  ) {
    throw new StaleCompatibleModelSnapshotError();
  }
}

/** Explicitly submitted effort must be one the model supports; null means default. */
export function assertSupportedCompatibleEffort(
  config: Pick<OpenAiCompatibleModelConfig, "thinkingLevels">,
  thinkingLevel: ThinkingLevel | null | undefined,
): void {
  if (thinkingLevel === undefined || thinkingLevel === null) return;
  if (!config.thinkingLevels.includes(thinkingLevel)) {
    throw new CompatibleModelChoiceError("unsupported_effort");
  }
}

/**
 * Prepare outside the lock, commit inside it; a snapshot that went stale
 * between the two is prepared again a bounded number of times.
 */
export async function withFreshCompatibleSnapshots<P, T>(
  prepare: () => Promise<P>,
  commit: (prepared: P) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const prepared = await prepare();
    try {
      return await commit(prepared);
    } catch (error) {
      if (!(error instanceof StaleCompatibleModelSnapshotError)) throw error;
    }
  }
  throw new CompatibleModelChoiceError("changed");
}
