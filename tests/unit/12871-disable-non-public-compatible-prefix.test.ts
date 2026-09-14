/**
 * #12871 -- `disableNonPublicModels` rejected every model of a compatible
 * provider because the published-model lookup used the operator-facing
 * *prefix* where the synced/custom stores are keyed by the raw provider id.
 *
 * A compatible provider node stores its discovered inventory under the node
 * UUID:
 *   key_value[namespace='syncedAvailableModels', key='openai-compatible-chat-<uuid>:<connId>']
 * but the public catalog advertises (and the operator calls) the model under
 * the configured prefix:
 *   "codebuddy/glm-5.2"
 *
 * `getPublishedModelLookupTarget()` returned the prefix verbatim, so
 * `getSyncedAvailableModelsByConnection("codebuddy")` ran
 * `LIKE 'codebuddy:%'` -> 0 rows -> `discovered === false` -> 403
 * "Model ... is not allowed for this API key". The whole provider vanished
 * from /v1/models, while the unprefixed alias kept working (it resolves to the
 * UUID form, which is exactly why the bug hid so long).
 *
 * The same mismatch hits a built-in provider's *alias* (`cmd` -> `command-code`),
 * which is why only `command-code/deepseek/...` survived the catalog loop --
 * its `root` happened to start with the real provider id `deepseek`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-12871-dnp-prefix-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "dnp-prefix-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const nodesDb = await import("../../src/lib/db/providers/nodes.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");

const PREFIX = "codebuddy-12871";
const NODE_ID = "openai-compatible-chat-9808d707-0000-4000-8000-000000020871";
const CONNECTION_ID = "6bb57832-0000-4000-8000-000000020871";
const MODEL_ID = "glm-5.2";
const OTHER_MODEL_ID = "hidden-noindex-model";

async function resetStorage() {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedCompatibleProvider() {
  await nodesDb.createProviderNode({
    id: NODE_ID,
    type: "openai-compatible",
    name: "CodeBuddy 12871",
    prefix: PREFIX,
    apiType: "chat",
    baseUrl: "https://example.test/v1",
  });
  await providersDb.createProviderConnection({
    id: CONNECTION_ID,
    provider: NODE_ID,
    authType: "apikey",
    apiKey: "sk-test-12871",
    name: "main",
    isActive: true,
    testStatus: "active",
    priority: 1,
    providerSpecificData: { prefix: PREFIX, baseUrl: "https://example.test/v1" },
  });

  // Discovered inventory is keyed by the raw node id, never by the prefix.
  await modelsDb.replaceSyncedAvailableModelsForConnection(NODE_ID, CONNECTION_ID, [
    { id: MODEL_ID, name: "GLM-5.2", source: "imported" },
    { id: OTHER_MODEL_ID, name: "Hidden", source: "imported" },
  ]);
}

/** Create a key with disableNonPublicModels enabled (the reported setup). */
async function createDisabledKey() {
  const created = await apiKeysDb.createApiKey("DNP Prefix Key", "machine-dnp-prefix");
  await apiKeysDb.updateApiKeyPermissions(created.id, { disableNonPublicModels: true });
  apiKeysDb.clearApiKeyCaches();
  return created;
}

test.after(() => {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("prefix form `<prefix>/<model>` is allowed for a compatible provider (#12871)", async () => {
  await resetStorage();
  await seedCompatibleProvider();
  const created = await createDisabledKey();

  const allowed = await apiKeysDb.isModelAllowedForKey(created.key, `${PREFIX}/${MODEL_ID}`);

  assert.equal(
    allowed,
    true,
    `"${PREFIX}/${MODEL_ID}" must be treated as a published model: the prefix must be ` +
      `resolved to the provider node id before querying syncedAvailableModels. ` +
      `Before #12871 the prefix was passed through verbatim, so the LIKE lookup ` +
      `matched nothing and the model was rejected as non-public.`
  );
});

test("raw node-id form `<nodeId>/<model>` stays allowed (#12871)", async () => {
  await resetStorage();
  await seedCompatibleProvider();
  const created = await createDisabledKey();

  const allowed = await apiKeysDb.isModelAllowedForKey(created.key, `${NODE_ID}/${MODEL_ID}`);
  assert.equal(allowed, true, "the raw node-id form must keep working");
});

test("an undiscovered model under the prefix stays rejected (#12871)", async () => {
  await resetStorage();
  await seedCompatibleProvider();
  const created = await createDisabledKey();

  const allowed = await apiKeysDb.isModelAllowedForKey(created.key, `${PREFIX}/not-a-real-model`);
  assert.equal(
    allowed,
    false,
    "disableNonPublicModels must still reject models absent from the discovered inventory"
  );
});

test("a built-in provider alias resolves to its registry id (#12871)", async () => {
  await resetStorage();
  // Seed the discovered inventory under the *registry id* of a built-in provider,
  // exactly like the real store does (`command-code:<connId>`).
  await modelsDb.replaceSyncedAvailableModelsForConnection("command-code", CONNECTION_ID, [
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", source: "imported" },
  ]);
  const created = await createDisabledKey();

  const viaAlias = await apiKeysDb.isModelAllowedForKey(
    created.key,
    "cmd/deepseek/deepseek-v4-pro"
  );
  const viaId = await apiKeysDb.isModelAllowedForKey(
    created.key,
    "command-code/deepseek/deepseek-v4-pro"
  );

  assert.equal(viaId, true, "the registry-id form must be treated as published");
  assert.equal(
    viaAlias,
    true,
    "the alias form `cmd/...` must resolve to `command-code` before the synced-store " +
      "lookup; before #12871 the alias was passed through verbatim and the model was " +
      "rejected as non-public"
  );
});
