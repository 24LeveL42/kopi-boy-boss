import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The merchant subscription is S$29.95 a month. The business is not
 * GST-registered, so no app text may mention or imply GST.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const FILES = walk(SRC).map((path) => ({ rel: relative(SRC, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }));

test("the Subscriptions page shows S$29.95/month", () => {
  const page = FILES.find((f) => f.rel === "app/subscriptions/page.tsx")!;
  assert.match(page.text, /S\$29\.95\/month/);
});

test("no app text shows an old subscription price or mentions GST", () => {
  for (const f of FILES) {
    assert.doesNotMatch(f.text, /29\.90?\b(?!\d)|\$29\.9(?!5)/, `${f.rel}: old price`);
    assert.doesNotMatch(f.text, /\bGST\b/i, `${f.rel}: GST wording`);
  }
});
