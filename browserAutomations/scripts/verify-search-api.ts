/**
 * Smoke-check Brave/Bing Search API wiring.
 * Skips cleanly when no API key is set (does not read/print secrets).
 *
 * Run: npx tsx scripts/verify-search-api.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import {
  hasAnySearchPath,
  hasSearchApiKey,
  htmlSearchEnabled,
  leadSearchProviderMode,
  resolveApiProviders,
  searchWeb,
  shouldAttemptHtmlSearch,
} from "../lib/leads/search-api.js";

function testProviderResolution() {
  const mode = leadSearchProviderMode();
  assert.ok(
    ["auto", "brave", "bing", "html", "off"].includes(mode),
    `unexpected mode ${mode}`,
  );
  const providers = resolveApiProviders();
  console.log(
    `ok provider mode=${mode} apis=[${providers.join(",") || "none"}]` +
      ` html=${shouldAttemptHtmlSearch()} (LEAD_HTML_SEARCH=${htmlSearchEnabled()})` +
      ` anyPath=${hasAnySearchPath()}`,
  );
}

async function testLiveSearchIfKeyed() {
  if (!hasSearchApiKey()) {
    console.log(
      "skip live search: set BRAVE_SEARCH_API_KEY or BING_SEARCH_API_KEY to smoke-test",
    );
    return;
  }

  const result = await searchWeb("Lanatus Systems official site", {
    count: 3,
  });
  assert.equal(typeof result.query, "string");
  assert.ok(result.provider === "brave" || result.provider === "bing");
  // Do not fail hard on empty hits (index variance) — just require a successful call shape
  assert.ok(Array.isArray(result.hits));
  for (const h of result.hits) {
    assert.ok(/^https?:\/\//i.test(h.url), `bad url: ${h.url}`);
  }
  console.log(
    `ok live ${result.provider}: ${result.hits.length} hit(s)` +
      (result.hits[0] ? ` top=${result.hits[0].url}` : ""),
  );
}

async function main() {
  testProviderResolution();
  await testLiveSearchIfKeyed();
  console.log("verify-search-api: done");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
