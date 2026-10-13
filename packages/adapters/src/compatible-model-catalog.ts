import type { SecretStore } from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor, OpenAiCompatibleModelConfig, ThinkingLevel } from "@rakazo/contracts";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  ThinkingLevelSchema,
  thinkingLevelsReason,
  usableModelId,
} from "@rakazo/contracts";
import {
  chooseModelCredential,
  credentialEnablesModel,
  newestModelCredentialOrder,
  type PrismaClient,
} from "@rakazo/db";
import { openAiCompatibleModelConfig } from "./openai-compatible-models.js";
import { listPiCatalog, type PiCatalogEntry } from "./pi-models.js";
import { type OpenAiCompatibleStoredSecret, parseModelSecret } from "./pi-oauth.js";
import { OPENAI_COMPATIBLE_CATALOG_MODEL_ID } from "./pi-openai-compatible-provider.js";

/** One selectable OpenAI-compatible model as the credential chooser would run it. */
export type CompatibleCatalogModel = {
  modelId: string;
  credentialId: string;
  secretId: string;
  baseUrl: string;
  config: OpenAiCompatibleModelConfig;
  /** Exact-model space preference effort, else the model's own default. */
  defaultThinkingLevel: ThinkingLevel | null;
};

const credentialSelect = {
  id: true,
  provider: true,
  secretId: true,
  enabledModelIds: true,
  supportsImages: true,
  updatedAt: true,
  createdAt: true,
} as const;

/**
 * Every OpenAI-compatible model this actor can select in the space. Each saved
 * id is resolved with `chooseModelCredential` exactly as a run would, and is
 * listed only when that chosen credential enables and configures it; a
 * credential the chooser shadows never contributes its metadata.
 */
export async function compatibleCatalogModelsForSpace(
  prisma: Pick<PrismaClient, "spaceModelPreference" | "userModelCredential" | "secret">,
  secretStore: Pick<SecretStore, "load">,
  scope: Pick<Actor, "userId" | "spaceId">,
): Promise<CompatibleCatalogModel[]> {
  const [credentials, preferences] = await Promise.all([
    prisma.userModelCredential.findMany({
      where: { userId: scope.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
      select: credentialSelect,
      orderBy: newestModelCredentialOrder,
    }),
    prisma.spaceModelPreference.findMany({
      where: {
        userId: scope.userId,
        spaceId: scope.spaceId,
        credential: { provider: OPENAI_COMPATIBLE_PROVIDER_ID },
      },
      select: {
        id: true,
        modelId: true,
        thinkingLevel: true,
        isDefault: true,
        updatedAt: true,
        credential: { select: credentialSelect },
      },
    }),
  ]);

  const seen = new Set<string>();
  const choices: Array<{
    modelId: string;
    credential: (typeof credentials)[number];
    preferenceEffort: string | null;
  }> = [];
  for (const owner of credentials) {
    if (owner.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) continue;
    for (const modelId of owner.enabledModelIds) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      const choice = chooseModelCredential({
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        modelId,
        preferences,
        credentials,
      });
      if (!choice) continue;
      const credential =
        choice.source === "preference" ? choice.preference.credential : choice.credential;
      if (!credentialEnablesModel(credential, modelId)) continue;
      choices.push({
        modelId,
        credential,
        preferenceEffort:
          choice.source === "preference" && usableModelId(choice.preference.modelId) === modelId
            ? choice.preference.thinkingLevel
            : null,
      });
    }
  }
  if (choices.length === 0) return [];

  const secrets = await prisma.secret.findMany({
    where: {
      id: { in: [...new Set(choices.map((choice) => choice.credential.secretId))] },
      userId: scope.userId,
      spaceId: null,
    },
    select: { id: true, ciphertext: true },
  });
  const ciphertextById = new Map(secrets.map((secret) => [secret.id, secret.ciphertext]));
  const parsedBySecretId = new Map<string, Promise<OpenAiCompatibleStoredSecret | undefined>>();
  const readSecret = (secretId: string) => {
    let parsed = parsedBySecretId.get(secretId);
    if (!parsed) {
      parsed = (async () => {
        const ciphertext = ciphertextById.get(secretId);
        if (!ciphertext) return undefined;
        try {
          const secret = parseModelSecret(await secretStore.load(ciphertext, secretId));
          return secret.kind === "openai_compatible" ? secret : undefined;
        } catch (error) {
          if (error instanceof SecretStoreUnavailableError) throw error;
          return undefined;
        }
      })();
      parsedBySecretId.set(secretId, parsed);
    }
    return parsed;
  };

  const models: CompatibleCatalogModel[] = [];
  for (const choice of choices) {
    const secret = await readSecret(choice.credential.secretId);
    if (!secret) continue;
    const config = openAiCompatibleModelConfig(secret, choice.credential, choice.modelId);
    if (!config) continue;
    const preferenceEffort = ThinkingLevelSchema.safeParse(choice.preferenceEffort);
    models.push({
      modelId: choice.modelId,
      credentialId: choice.credential.id,
      secretId: choice.credential.secretId,
      baseUrl: secret.baseUrl,
      config,
      defaultThinkingLevel: preferenceEffort.success
        ? preferenceEffort.data
        : config.defaultThinkingLevel,
    });
  }
  return models;
}

/**
 * Replace the process-wide OpenAI-compatible placeholders in a catalog with
 * this actor's selectable models, at the provider's position. The single
 * placeholder stays only when nothing is selectable, so connection setup
 * remains discoverable; an enabled `custom` id is an ordinary row.
 */
export function withCompatibleCatalogEntries(
  catalog: readonly PiCatalogEntry[],
  models: readonly CompatibleCatalogModel[],
): PiCatalogEntry[] {
  const placeholder = listPiCatalog().find(
    (entry) =>
      entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID &&
      entry.id === OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
  );
  const compatibleEntries: PiCatalogEntry[] = [];
  if (placeholder && models.length === 0) compatibleEntries.push(placeholder);
  if (placeholder && models.length > 0) {
    const { placeholder: _placeholder, ...template } = placeholder;
    for (const model of models) {
      compatibleEntries.push({
        ...template,
        id: model.modelId,
        label: model.modelId,
        reasoning: thinkingLevelsReason(model.config.thinkingLevels),
        thinkingLevels: [...model.config.thinkingLevels],
        defaultThinkingLevel: model.defaultThinkingLevel,
      });
    }
  }
  const entries: PiCatalogEntry[] = [];
  let inserted = false;
  for (const entry of catalog) {
    if (entry.provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
      entries.push(entry);
      continue;
    }
    if (inserted) continue;
    inserted = true;
    entries.push(...compatibleEntries);
  }
  if (!inserted) entries.push(...compatibleEntries);
  return entries;
}
