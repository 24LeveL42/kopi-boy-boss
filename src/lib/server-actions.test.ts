import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const FILES = walk(SRC).map((path) => ({ path, rel: relative(SRC, path).replace(/\\/g, "/"), text: readFileSync(path, "utf8") }));
const isUseServer = (text: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["'];?/.test(text);
const ACTION_FILES = FILES.filter((f) => isUseServer(f.text));

/** Exported async functions with the text that starts their body. */
function actions(text: string) {
  return [...text.matchAll(/export async function (\w+)\s*\([^)]*\)[^{]*\{([\s\S]{0,200})/g)].map((m) => ({ name: m[1], body: m[2] }));
}

const FIRST_LINE = /^\s*(const \{[^}]*\} = )?await assertAdmin\(\);/;

test("action files found: actions.ts and message-actions.ts", () => {
  assert.deepEqual(ACTION_FILES.map((f) => f.rel).sort(), ["lib/actions.ts", "lib/message-actions.ts"]);
});

test("every server action calls assertAdmin() as its first statement", () => {
  for (const file of ACTION_FILES) {
    for (const { name, body } of actions(file.text)) {
      assert.match(body, FIRST_LINE, `${file.rel}: ${name} must start with assertAdmin()`);
    }
  }
});

test("server action files export nothing but async functions (no unguarded exports)", () => {
  for (const file of ACTION_FILES) {
    const exports = [...file.text.matchAll(/^export\s+(?!async function)(.*)$/gm)].map((m) => m[1]);
    assert.deepEqual(exports, [], `${file.rel} has other exports`);
  }
});

test("exactly the 10 known actions exist (a new one must be added here on purpose)", () => {
  const names = ACTION_FILES.flatMap((f) => actions(f.text).map((a) => a.name)).sort();
  assert.deepEqual(names, [
    "approveCookApplication",
    "approveRiderApplication",
    "deleteTestPartner",
    "rejectCookApplication",
    "rejectRiderApplication",
    "replyToAdminMessage",
    "setAdminMessageStatus",
    "setComplaintThreadStatus",
    "setPartnerActive",
    "unblockMessageSender",
  ]);
});

test("the only route handler is the sign-in callback, and it stays admin-free", () => {
  const routes = FILES.filter((f) => /\/route\.tsx?$/.test(f.rel)).map((f) => f.rel);
  assert.deepEqual(routes, ["app/auth/callback/route.ts"]);
});

test("requireAdmin is gone; every admin page gates on getViewer + hasAdminRole", () => {
  for (const f of FILES) assert.doesNotMatch(f.text, /\brequireAdmin\b/, `${f.rel} still uses requireAdmin`);
  const pages = FILES.filter((f) => /^app\/.*page\.tsx$/.test(f.rel) && f.rel !== "app/login/page.tsx");
  assert.equal(pages.length, 18);
  for (const p of pages) {
    assert.match(p.text, /await getViewer\(\);\s*\n\s*if \(!user\) return <LoginForm \/>;/, `${p.rel}: login gate`);
    assert.match(p.text, /if \(!\(await hasAdminRole\(supabase\)\)\) return <NotAuthorized \/>;/, `${p.rel}: admin gate`);
    assert.doesNotMatch(p.text, /\.role !== "admin"/, `${p.rel}: reads profiles.role directly`);
  }
});

test("deleteTestPartner returns its report; it only throws via assertAdmin", () => {
  const src = ACTION_FILES.find((f) => f.rel === "lib/actions.ts")!.text;
  const body = src.slice(src.indexOf("export async function deleteTestPartner"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 2);
  assert.match(fn, /Promise<DeleteReport>/);
  assert.match(fn, /return report;/);
  assert.doesNotMatch(fn, /throw /);
});
