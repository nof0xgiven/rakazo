import { ORPCError } from "@orpc/server";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import {
  assertAllowedOpenAiCompatibleUrl,
  describeOpenAiCompatibleModels,
  discoverOpenAiCompatibleModels,
  parseModelSecret,
  sameOpenAiCompatibleEndpoint,
} from "@rakazo/adapters";
import type { Actor, OpenAiCompatibleDiscoveredModel } from "@rakazo/contracts";
import {
  OPENAI_COMPATIBLE_MODEL_ID_MAX_LENGTH,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import { findModelCredential } from "@rakazo/db";
import type { RouterDeps } from "./router.js";

type DiscoveryDeps = Pick<RouterDeps, "prisma" | "secrets">;
type Scope = Pick<Actor, "userId" | "spaceId">;
type SavedConnection = { secretId: string; enabledModelIds: string[] };
type DiscoveryResult = { models: OpenAiCompatibleDiscoveredModel[] };

async function requestedConnection(
  deps: DiscoveryDeps,
  actor: Scope,
  credentialId: string | undefined,
): Promise<SavedConnection | null> {
  if (credentialId === undefined) {
    return findModelCredential(deps.prisma, actor, OPENAI_COMPATIBLE_PROVIDER_ID);
  }
  const credential = await deps.prisma.userModelCredential.findFirst({
    where: { id: credentialId, userId: actor.userId, provider: OPENAI_COMPATIBLE_PROVIDER_ID },
    select: { secretId: true, enabledModelIds: true },
  });
  if (!credential) throw new ORPCError("NOT_FOUND", { message: "Model connection not found" });
  return credential;
}

async function savedEndpoint(
  deps: DiscoveryDeps,
  actor: Scope,
  connection: SavedConnection,
): Promise<{ baseUrl: string; apiKey?: string } | null> {
  const secret = await deps.prisma.secret.findFirst({
    where: { id: connection.secretId, userId: actor.userId, spaceId: null },
    select: { id: true, ciphertext: true },
  });
  if (!secret) return null;
  try {
    const parsed = parseModelSecret(await deps.secrets.load(secret.ciphertext, secret.id));
    return parsed.kind === "openai_compatible" ? parsed : null;
  } catch (error) {
    if (error instanceof SecretStoreUnavailableError) {
      throw new ORPCError("SERVICE_UNAVAILABLE", { cause: error });
    }
    return null;
  }
}

/**
 * An explicit `apiKey` wins, and `""` means keyless. Otherwise the requested
 * (or chosen) saved connection lends its key only to its own normalized endpoint.
 */
export async function probeOpenAiCompatibleEndpoint(
  deps: DiscoveryDeps,
  actor: Scope,
  input: { baseUrl: string; apiKey?: string; credentialId?: string },
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  const connection = await requestedConnection(deps, actor, input.credentialId);
  let apiKey = input.apiKey;
  if (apiKey === undefined && connection) {
    const saved = await savedEndpoint(deps, actor, connection);
    if (saved && sameOpenAiCompatibleEndpoint(input.baseUrl, saved.baseUrl)) apiKey = saved.apiKey;
  }
  try {
    const models = await discoverOpenAiCompatibleModels(
      apiKey ? { baseUrl: input.baseUrl, apiKey } : { baseUrl: input.baseUrl },
      undefined,
      signal,
    );
    return { models };
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Could not list models",
    });
  }
}

/** Local catalog suggestions for exact ids; never contacts the endpoint. */
export async function describeOpenAiCompatibleEndpoint(
  deps: DiscoveryDeps,
  actor: Scope,
  input: { baseUrl: string; credentialId?: string; modelIds: string[] },
): Promise<DiscoveryResult> {
  let baseUrl: string;
  try {
    baseUrl = assertAllowedOpenAiCompatibleUrl(input.baseUrl).href;
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "Invalid model server URL",
    });
  }
  const connection = await requestedConnection(deps, actor, input.credentialId);
  const modelIds = [...new Set(input.modelIds.map((modelId) => modelId.trim()))];
  if (modelIds.includes("")) {
    throw new ORPCError("BAD_REQUEST", { message: "Model id is required" });
  }
  const longIds = modelIds.filter(
    (modelId) => modelId.length > OPENAI_COMPATIBLE_MODEL_ID_MAX_LENGTH,
  );
  if (longIds.length > 0) {
    const saved = connection ? await savedEndpoint(deps, actor, connection) : null;
    const enabled =
      connection && saved && sameOpenAiCompatibleEndpoint(baseUrl, saved.baseUrl)
        ? connection.enabledModelIds
        : [];
    if (longIds.some((modelId) => !enabled.includes(modelId))) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Model ids must be at most ${OPENAI_COMPATIBLE_MODEL_ID_MAX_LENGTH} characters`,
      });
    }
  }
  return { models: describeOpenAiCompatibleModels(modelIds.map((id) => ({ id }))) };
}
