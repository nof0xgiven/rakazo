import type * as Adapters from "@rakazo/adapters";
import { serializeModelSecret } from "@rakazo/adapters";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeOpenAiCompatibleEndpoint,
  probeOpenAiCompatibleEndpoint,
} from "./model-discovery.js";

const discover = vi.hoisted(() => vi.fn());

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  discoverOpenAiCompatibleModels: discover,
}));

const actor = { userId: "owner", spaceId: "space-1" };
const longId = `long-${"x".repeat(300)}`;

type Credential = {
  id: string;
  userId: string;
  provider: string;
  secretId: string;
  enabledModelIds: string[];
  updatedAt: Date;
  createdAt: Date;
};

function compatibleSecret(baseUrl: string, apiKey?: string) {
  return serializeModelSecret({
    kind: "openai_compatible",
    format: "canonical",
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    models: [],
  });
}

function fixture() {
  const credentials: Credential[] = [
    {
      id: "cred-a",
      userId: "owner",
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      secretId: "secret-a",
      enabledModelIds: ["model-a", longId],
      updatedAt: new Date("2026-10-02"),
      createdAt: new Date("2026-10-01"),
    },
    {
      id: "cred-b",
      userId: "owner",
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      secretId: "secret-b",
      enabledModelIds: ["model-b"],
      updatedAt: new Date("2026-10-01"),
      createdAt: new Date("2026-10-01"),
    },
    {
      id: "cred-other",
      userId: "intruder",
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      secretId: "secret-other",
      enabledModelIds: [longId],
      updatedAt: new Date("2026-10-03"),
      createdAt: new Date("2026-10-03"),
    },
  ];
  const secrets = [
    {
      id: "secret-a",
      userId: "owner",
      spaceId: null,
      ciphertext: compatibleSecret("http://127.0.0.1:8000/v1", "saved-key-a"),
    },
    {
      id: "secret-b",
      userId: "owner",
      spaceId: null,
      ciphertext: compatibleSecret("http://127.0.0.1:9000/v1", "saved-key-b"),
    },
    {
      id: "secret-other",
      userId: "intruder",
      spaceId: null,
      ciphertext: compatibleSecret("http://127.0.0.1:8000/v1", "intruder-key"),
    },
  ];
  const load = vi.fn(async (ciphertext: string) => ciphertext);
  const prisma = {
    userModelCredential: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; provider: string } }) =>
          credentials.find(
            (credential) =>
              credential.id === where.id &&
              credential.userId === where.userId &&
              credential.provider === where.provider,
          ) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string; provider: string } }) =>
        credentials.filter(
          (credential) =>
            credential.userId === where.userId && credential.provider === where.provider,
        ),
      ),
    },
    spaceModelPreference: { findMany: vi.fn(async () => []) },
    secret: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; spaceId: null } }) =>
          secrets.find((secret) => secret.id === where.id && secret.userId === where.userId) ??
          null,
      ),
    },
  };
  return { deps: { prisma, secrets: { load } } as never, load };
}

beforeEach(() => {
  discover.mockReset();
  discover.mockResolvedValue([{ modelId: "model-a", capabilities: null }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("models.probeOpenAiCompatible", () => {
  it("reuses the chosen connection's key only for its own normalized endpoint", async () => {
    const { deps } = fixture();
    const result = await probeOpenAiCompatibleEndpoint(deps, actor, {
      baseUrl: "http://127.0.0.1:8000/",
    });
    expect(discover).toHaveBeenLastCalledWith(
      { baseUrl: "http://127.0.0.1:8000/", apiKey: "saved-key-a" },
      undefined,
      undefined,
    );
    expect(JSON.stringify(result)).not.toContain("saved-key");

    await probeOpenAiCompatibleEndpoint(deps, actor, { baseUrl: "http://127.0.0.1:9000/v1" });
    expect(discover).toHaveBeenLastCalledWith(
      { baseUrl: "http://127.0.0.1:9000/v1" },
      undefined,
      undefined,
    );
  });

  it("uses only the requested owned connection", async () => {
    const { deps } = fixture();
    await probeOpenAiCompatibleEndpoint(deps, actor, {
      baseUrl: "http://127.0.0.1:9000",
      credentialId: "cred-b",
    });
    expect(discover).toHaveBeenLastCalledWith(
      { baseUrl: "http://127.0.0.1:9000", apiKey: "saved-key-b" },
      undefined,
      undefined,
    );
    await probeOpenAiCompatibleEndpoint(deps, actor, {
      baseUrl: "http://127.0.0.1:8000/v1",
      credentialId: "cred-b",
    });
    expect(discover).toHaveBeenLastCalledWith(
      { baseUrl: "http://127.0.0.1:8000/v1" },
      undefined,
      undefined,
    );
  });

  it("lets an explicit key or explicit keyless choice win without loading the saved key", async () => {
    const { deps, load } = fixture();
    await probeOpenAiCompatibleEndpoint(deps, actor, {
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "",
    });
    expect(discover).toHaveBeenLastCalledWith(
      { baseUrl: "http://127.0.0.1:8000/v1" },
      undefined,
      undefined,
    );
    await probeOpenAiCompatibleEndpoint(deps, actor, {
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "typed-key",
    });
    expect(discover).toHaveBeenLastCalledWith(
      { baseUrl: "http://127.0.0.1:8000/v1", apiKey: "typed-key" },
      undefined,
      undefined,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects another account's connection without probing or revealing it", async () => {
    const { deps, load } = fixture();
    const attempt = probeOpenAiCompatibleEndpoint(deps, actor, {
      baseUrl: "http://127.0.0.1:8000/v1",
      credentialId: "cred-other",
    });
    await expect(attempt).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Model connection not found",
    });
    expect(discover).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it("reports listing failures as bad requests", async () => {
    const { deps } = fixture();
    discover.mockRejectedValueOnce(new Error("Model server returned 401."));
    await expect(
      probeOpenAiCompatibleEndpoint(deps, actor, { baseUrl: "http://127.0.0.1:8000/v1" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Model server returned 401." });
  });
});

describe("models.describeOpenAiCompatible", () => {
  it("suggests settings locally without contacting the endpoint", async () => {
    const { deps } = fixture();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await describeOpenAiCompatibleEndpoint(deps, actor, {
      baseUrl: "http://127.0.0.1:8000/v1",
      modelIds: [" gpt-4o ", "gpt-4o", "my-local-model"],
    });
    expect(result).toEqual({
      models: [
        { modelId: "gpt-4o", capabilities: expect.objectContaining({ thinkingLevels: ["off"] }) },
        { modelId: "my-local-model", capabilities: null },
      ],
    });
    expect(discover).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("describes a long id only when enabled on the owned same-endpoint connection", async () => {
    const { deps } = fixture();
    await expect(
      describeOpenAiCompatibleEndpoint(deps, actor, {
        baseUrl: "http://127.0.0.1:8000",
        credentialId: "cred-a",
        modelIds: [longId],
      }),
    ).resolves.toEqual({ models: [{ modelId: longId, capabilities: null }] });
    await expect(
      describeOpenAiCompatibleEndpoint(deps, actor, {
        baseUrl: "http://127.0.0.1:8001/v1",
        credentialId: "cred-a",
        modelIds: [longId],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      describeOpenAiCompatibleEndpoint(deps, actor, {
        baseUrl: "http://127.0.0.1:9000/v1",
        credentialId: "cred-b",
        modelIds: [longId],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      describeOpenAiCompatibleEndpoint(deps, actor, {
        baseUrl: "http://127.0.0.1:8000/v1",
        credentialId: "cred-other",
        modelIds: ["model-a"],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(discover).not.toHaveBeenCalled();
  });

  it("rejects blank ids and blocked endpoints", async () => {
    const { deps } = fixture();
    await expect(
      describeOpenAiCompatibleEndpoint(deps, actor, {
        baseUrl: "http://127.0.0.1:8000/v1",
        modelIds: ["  "],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      describeOpenAiCompatibleEndpoint(deps, actor, {
        baseUrl: "http://169.254.169.254/v1",
        modelIds: ["gpt-4o"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
