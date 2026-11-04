import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { safeRedirectPath } from "./safe-redirect.ts";

const ORIGIN = "https://boss.kopiboy.example";

const ATTACKS: unknown[] = [
  null,
  undefined,
  "",
  42,
  ["/merchants"],
  "evil.com",
  "//evil.com",
  "///evil.com",
  "////evil.com",
  "/\\evil.com",
  "\\\\evil.com",
  "\\/evil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  "/\r/evil.com",
  " /merchants",
  "/merchants ",
  "/\u0000/evil.com",
  "/ /evil.com",
  "http://evil.com",
  "https://evil.com",
  "https:evil.com",
  "HTTP://EVIL.COM",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "/javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "/%2F%2Fevil.com",
  "/%2f%2fevil.com",
  "%2F%2Fevil.com",
  "%2Fmerchants",
  "/%5Cevil.com",
  "/%5cevil.com",
  "/%252F%252Fevil.com",
  "/%25252F%25252Fevil.com",
  "/%2525252F%2525252Fevil.com",
  "/%09/evil.com",
  "/%0A/evil.com",
  "/%00",
  "/%E0%A4%A",
  "/%",
  "@evil.com",
  ".evil.com",
  ":pw@evil.com",
  "/auth/callback?next=//evil.com",
  "/" + "a".repeat(3000),
];

test("every attack string falls back to /", () => {
  for (const attack of ATTACKS) {
    assert.equal(safeRedirectPath(attack, ORIGIN), "/", `should refuse ${JSON.stringify(attack)}`);
  }
});

test("attack strings can't leave the origin even when joined the old way", () => {
  for (const attack of ATTACKS) {
    const target = new URL(safeRedirectPath(attack, ORIGIN), ORIGIN);
    assert.equal(target.origin, ORIGIN, JSON.stringify(attack));
  }
});

test("ordinary in-app paths pass through", () => {
  for (const path of ["/", "/merchants", "/orders?view=map&rider=abc", "/complaints/123#top", "/merchants/abc/edit"]) {
    assert.equal(safeRedirectPath(path, ORIGIN), path);
  }
});

test("the result is the parsed path, not the raw input", () => {
  assert.equal(safeRedirectPath("/orders/../merchants", ORIGIN), "/merchants");
  // Strict on purpose: every decoded form must also be safe, so even an
  // encoded space is refused. No admin path contains one.
  assert.equal(safeRedirectPath("/a%20b", ORIGIN), "/");
});

test("a bad origin falls back to /", () => {
  assert.equal(safeRedirectPath("/merchants", "not a url"), "/");
});

test("auth callback uses safeRedirectPath and no longer joins origin + next", () => {
  const route = readFileSync(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8");
  assert.match(route, /safeRedirectPath\(searchParams\.get\("next"\), origin\)/);
  assert.doesNotMatch(route, /\$\{origin\}\$\{next\}/);
});
