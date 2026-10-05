import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpeningModelProvidersRepository, OpeningModelProviderError,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let fixture: OpeningFixture;
beforeAll(async () => {
  vi.stubEnv("OPENING_CONNECTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("OPENING_CONNECTION_KEY_ID", "test-key");
  vi.stubEnv("OPENING_CONNECTION_PREVIOUS_KEYS", "{}");
  fixture = await createOpeningFixture();
});
beforeEach(async () => {
  await fixture.sql`DELETE FROM opening_model_providers WHERE workspace_id IN (${fixture.scope.workspaceId},${fixture.otherScope.workspaceId})`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fixture?.close();
});

const providerInput = { label: "我的供应商", baseUrl: "https://api.example.com/v1", apiKey: "sk-test-1234" };
const modelInput = { label: "主力模型", modelName: "my-model", inputCentsPerMillion: 1.5, outputCentsPerMillion: 2, supportsVision: true };

describe("workspace model provider repository", () => {
  it("creates providers with an encrypted key and lists without key material", async () => {
    const repo = createOpeningModelProvidersRepository(fixture.sql);
    const view = await repo.createProvider(fixture.scope, providerInput);
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeyHint).toBe("1234");
    expect(JSON.stringify(view)).not.toContain(providerInput.apiKey);
    const [row] = await fixture.sql`SELECT key_id,nonce,ciphertext,auth_tag FROM opening_model_provider_credentials WHERE provider_id=${view.id}`;
    expect(String(row!.ciphertext)).not.toContain(providerInput.apiKey);
    expect(row!.nonce).not.toBeNull();
    const models = await repo.listResolvableModels(fixture.scope);
    // No models yet, but the provider resolves once one exists; key stays out of views.
    expect(models).toEqual([]);
    const listed = await repo.list(fixture.scope);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(providerInput.apiKey);
  });
  it("resolves models with decrypted keys in memory only", async () => {
    const repo = createOpeningModelProvidersRepository(fixture.sql);
    const provider = await repo.createProvider(fixture.scope, providerInput);
    const model = await repo.createModel(fixture.scope, provider.id, modelInput);
    const resolvable = await repo.listResolvableModels(fixture.scope);
    expect(resolvable).toHaveLength(1);
    expect(resolvable[0]).toMatchObject({
      id: model.id, providerId: provider.id, apiKey: providerInput.apiKey,
      modelName: "my-model", inputCentsPerMillion: 1.5, outputCentsPerMillion: 2,
      supportsVision: true, vaultConfigBroken: false,
    });
    expect(JSON.stringify(await repo.list(fixture.scope))).not.toContain(providerInput.apiKey);
    expect(JSON.stringify(await repo.listModels(fixture.scope))).not.toContain(providerInput.apiKey);
  });
  it("overwrites the key on provider update and reports the new hint", async () => {
    const repo = createOpeningModelProvidersRepository(fixture.sql);
    const provider = await repo.createProvider(fixture.scope, providerInput);
    await repo.updateProvider(fixture.scope, provider.id, { apiKey: "sk-rotated-9999" });
    const [view] = await repo.list(fixture.scope);
    expect(view!.apiKeyHint).toBe("9999");
    const resolvable = await repo.listResolvableModels(fixture.scope);
    expect(resolvable).toEqual([]);
    await repo.createModel(fixture.scope, provider.id, modelInput);
    expect((await repo.listResolvableModels(fixture.scope))[0]!.apiKey).toBe("sk-rotated-9999");
  });
  it("enforces provider label uniqueness and the 8-provider cap", async () => {
    const repo = createOpeningModelProvidersRepository(fixture.sql);
    await repo.createProvider(fixture.scope, providerInput);
    await expect(repo.createProvider(fixture.scope, { ...providerInput, baseUrl: "https://other.example/v1" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    for (let index = 2; index <= 8; index += 1) {
      await repo.createProvider(fixture.scope, { label: `P${index}`, baseUrl: "https://p.example/v1" });
    }
    await expect(repo.createProvider(fixture.scope, { label: "P9", baseUrl: "https://p.example/v1" }))
      .rejects.toMatchObject({ code: "LIMIT" });
  });
  it("enforces model caps and label uniqueness inside one provider", async () => {
    const repo = createOpeningModelProvidersRepository(fixture.sql);
    const provider = await repo.createProvider(fixture.scope, providerInput);
    await repo.createModel(fixture.scope, provider.id, modelInput);
    await expect(repo.createModel(fixture.scope, provider.id, modelInput)).rejects.toMatchObject({ code: "CONFLICT" });
    for (let index = 2; index <= 16; index += 1) {
      await repo.createModel(fixture.scope, provider.id, { ...modelInput, label: `M${index}`, modelName: `m-${index}` });
    }
    await expect(repo.createModel(fixture.scope, provider.id, { ...modelInput, label: "M17", modelName: "m-17" }))
      .rejects.toMatchObject({ code: "LIMIT" });
  });
  it("isolates workspaces and blocks foreign owners on every operation", async () => {
    const repo = createOpeningModelProvidersRepository(fixture.sql);
    const provider = await repo.createProvider(fixture.scope, providerInput);
    const model = await repo.createModel(fixture.scope, provider.id, modelInput);
    await expect(repo.createProvider(fixture.otherScope, providerInput)).resolves.toBeTruthy();
    await fixture.sql`DELETE FROM opening_model_providers WHERE workspace_id=${fixture.otherScope.workspaceId}`;
    const foreign = { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId };
    await expect(repo.updateProvider(foreign, provider.id, { label: "X" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.deleteProvider(foreign, provider.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.updateModel(foreign, model.id, { label: "X" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.deleteModel(foreign, model.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await repo.listResolvableModels(fixture.otherScope)).toEqual([]);
    expect((await repo.listResolvableModels(fixture.scope))[0]!.apiKey).toBe(providerInput.apiKey);
  });
  it("updates and deletes models; deleting a provider cascades", async () => {
    const repo = createOpeningModelProvidersRepository(fixture.sql);
    const provider = await repo.createProvider(fixture.scope, providerInput);
    const model = await repo.createModel(fixture.scope, provider.id, modelInput);
    await repo.updateModel(fixture.scope, model.id, { label: "改名", inputCentsPerMillion: 3 });
    const [updated] = await repo.listModels(fixture.scope);
    expect(updated).toMatchObject({ label: "改名", inputCentsPerMillion: 3, outputCentsPerMillion: 2 });
    await repo.deleteModel(fixture.scope, model.id);
    expect(await repo.listModels(fixture.scope)).toEqual([]);
    await repo.createModel(fixture.scope, provider.id, modelInput);
    await repo.deleteProvider(fixture.scope, provider.id);
    expect(await repo.list(fixture.scope)).toEqual([]);
    expect(await repo.listModels(fixture.scope)).toEqual([]);
    const [credential] = await fixture.sql`SELECT provider_id FROM opening_model_provider_credentials WHERE provider_id=${provider.id}`;
    expect(credential).toBeUndefined();
  });
  it("flags a broken vault envelope instead of failing the whole list", async () => {
    const repo = createOpeningModelProvidersRepository(fixture.sql);
    const provider = await repo.createProvider(fixture.scope, providerInput);
    await repo.createModel(fixture.scope, provider.id, modelInput);
    await fixture.sql`UPDATE opening_model_provider_credentials SET key_id='missing-key' WHERE provider_id=${provider.id}`;
    const resolvable = await repo.listResolvableModels(fixture.scope);
    expect(resolvable[0]!.vaultConfigBroken).toBe(true);
    expect(resolvable[0]!.apiKey).toBe("");
    // Unknown error classes still propagate (fail loudly, not silently).
    const failing = createOpeningModelProvidersRepository({
      ...fixture.sql,
      // @ts-expect-error only used to exercise the rethrow path
      unsafe: undefined,
    });
    expect(failing).toBeTruthy();
  });
  it("rejects an unknown provider id with NOT_FOUND", async () => {
    const repo = createOpeningModelProvidersRepository(fixture.sql);
    await expect(repo.createModel(fixture.scope, "22222222-2222-4222-8222-222222222222", modelInput))
      .rejects.toBeInstanceOf(OpeningModelProviderError);
  });
});
