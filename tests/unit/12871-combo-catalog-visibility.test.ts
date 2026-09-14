/**
 * Combo ids must stay in the `/v1/models` catalog under
 * `disableNonPublicModels`.
 *
 * Combo ids are bare names (`deepseek-v4-flash`) or the built-in virtual
 * `auto/*` set. Neither has a `provider/model` shape, so the published-model
 * lookup in `isModelAllowedForKey` could never resolve them:
 *
 *   getPublishedModelLookupTarget("deepseek-v4-flash") -> null (no slash)
 *   providerId   = "deepseek-v4-flash"
 *   shortModelId = ""                       (slice(1).join("/") on no slash)
 *   if (!providerId || !shortModelId) return false;   <-- rejected
 *
 * The catalog's key-permission pass runs over every advertised row, so every
 * combo (user-defined and the 38 built-in `auto/*` ids) was dropped from
 * `/v1/models` while remaining routable when sent explicitly.
 *
 * Combo authorisation belongs to the key's `allowedCombos` rules, which are
 * enforced at request time by apiKeyPolicy — not to the published-model gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-catalog-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const combosDb = await import("../../src/lib/db/combos.ts");

async function resetStorage() {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createDisabledKey() {
  const created = await apiKeysDb.createApiKey("Combo Key", "machine-combo-catalog");
  await apiKeysDb.updateApiKeyPermissions(created.id, { disableNonPublicModels: true });
  apiKeysDb.clearApiKeyCaches();
  return created;
}

test.after(() => {
  apiKeysDb.resetApiKeyState();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a user-defined combo name is allowed under disableNonPublicModels", async () => {
  await resetStorage();
  await combosDb.createCombo({
    id: "combo-test-1",
    name: "my-combo",
    data: JSON.stringify({ name: "my-combo", models: [], strategy: "priority" }),
    sortOrder: 1,
  } as never);
  const created = await createDisabledKey();

  const allowed = await apiKeysDb.isModelAllowedForKey(created.key, "my-combo");
  assert.equal(
    allowed,
    true,
    "a registered combo name has no provider/model shape, so the published-model " +
      "lookup can never resolve it and it must be exempted"
  );
});

test("built-in auto/* ids are allowed under disableNonPublicModels", async () => {
  await resetStorage();
  const created = await createDisabledKey();

  for (const id of ["auto", "auto/coding", "auto/best-coding"]) {
    const allowed = await apiKeysDb.isModelAllowedForKey(created.key, id);
    assert.equal(allowed, true, `built-in virtual combo "${id}" must stay advertised`);
  }
});

test("an unknown bare name is still rejected under disableNonPublicModels", async () => {
  await resetStorage();
  const created = await createDisabledKey();

  const allowed = await apiKeysDb.isModelAllowedForKey(created.key, "not-a-registered-combo");
  assert.equal(
    allowed,
    false,
    "the combo exemption must not become a blanket allow for arbitrary bare names"
  );
});

test("a provider-scoped id is unaffected by the combo exemption", async () => {
  await resetStorage();
  const created = await createDisabledKey();

  // No discovered inventory for this provider -> stays rejected.
  const allowed = await apiKeysDb.isModelAllowedForKey(created.key, "aihorde/some-model");
  assert.equal(allowed, false, "provider-scoped ids must still go through the published gate");
});
