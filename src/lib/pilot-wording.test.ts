import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PILOT_TERMS, PILOT_TERMS_VERSION } from "./pilot-terms.ts";

/**
 * Kopi Boy is free for merchants during the pilot: the S$29.95 subscription
 * and the founding merchant offer are cancelled. No user-visible text (JSX
 * text, string literals with words in them: email copy, page titles,
 * notices) may offer a subscription price, a founding offer, a free trial or
 * a commission promise other than the Pilot Partner Terms. The business is
 * not GST-registered, so no copy may mention GST either.
 *
 * Identifiers, routes and SQL names (merchant_subscriptions, /subscriptions,
 * billing_settings) are not copy and are not checked: they have no spaces.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** The user-visible text in a source file: JSX text and string literals that contain a space. */
function visibleCopy(source: string): string[] {
  const code = source
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, " ") // block and JSX comments
    .replace(/(?<![:"'`\w\\])\/\/[^\n]*/g, " "); // line comments (not the // in https://)
  const out: string[] = [];
  for (const m of code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? "";
    if (/\s/.test(s.trim())) out.push(s);
  }
  for (const m of code.matchAll(/>([^<>{}]*[A-Za-z0-9$][^<>{}]*)</g)) {
    const s = m[1].trim();
    if (s) out.push(s);
  }
  return out;
}

const FILES = walk(SRC).map((path) => {
  const text = readFileSync(path, "utf8");
  return { rel: relative(SRC, path).replace(/\\/g, "/"), text, copy: visibleCopy(text) };
});

/** Wording that belongs to the cancelled subscription / founding offer. */
const CANCELLED = [
  /29\.9\d?/, // S$29.95, 29.90
  /\bfounding\b/i,
  /free trial|trial ends|\btrial\b/i,
  /3 months free|three months free|free (first|1st) month|first month free/i,
  /\b0% commission|zero commission|no commission/i,
  /\bsubscription is\b|\bmonthly subscription\b|\/month\b/i,
  /\b2[12] March\b|\b2[12] Mar 2027\b|2027-03-2[12]/i,
  /payment due|billing dates/i,
];

test("visibleCopy finds JSX text and sentences, not identifiers, routes, SQL names or comments", () => {
  const sample = `
    // founding merchants get 3 months free
    /* Your subscription is S$29.95/month */
    const t = supabase.from("merchant_subscriptions").select("founding_number");
    const href = "/subscriptions";
    const body = "Your subscription is S$29.95/month.";
    <p title="founding offer">S$29.95/month after a free trial</p>
    {/* zero commission */}
  `;
  const copy = visibleCopy(sample);
  assert.ok(copy.includes("Your subscription is S$29.95/month."));
  assert.ok(copy.includes("founding offer"));
  assert.ok(copy.includes("S$29.95/month after a free trial"));
  assert.ok(!copy.some((s) => /merchant_subscriptions|founding_number|^\/subscriptions$|3 months free|zero commission/.test(s)), copy.join(" | "));
});

test("no user-visible copy offers the cancelled subscription, a founding offer or a trial", () => {
  const hits: string[] = [];
  for (const f of FILES) {
    for (const s of f.copy) {
      for (const re of CANCELLED) if (re.test(s)) hits.push(`${f.rel}: "${s}" (${re})`);
    }
  }
  assert.deepEqual(hits, []);
});

test("no user-visible copy mentions GST", () => {
  for (const f of FILES) {
    for (const s of f.copy) assert.doesNotMatch(s, /\bGST\b/i, `${f.rel}: GST wording`);
  }
});

test("the Billing page is 'Billing (off)' and shows 'Billing: OFF · Pilot terms v1'", () => {
  const page = FILES.find((f) => f.rel === "app/subscriptions/page.tsx")!;
  assert.ok(page.copy.includes("Billing (off)"));
  assert.match(page.text, /Billing: OFF · \{PILOT_TERMS_VERSION\}/);
  assert.equal(PILOT_TERMS_VERSION, "Pilot terms v1");
  const loading = FILES.find((f) => f.rel === "app/subscriptions/loading.tsx")!;
  assert.match(loading.text, /title="Billing \(off\)"/);
  const sidebar = FILES.find((f) => f.rel === "components/ops/OpsSidebar.tsx")!;
  assert.match(sidebar.text, /label: "Billing \(off\)", href: "\/subscriptions"/);
});

test("the Pilot Partner Terms say the five agreed things", () => {
  assert.equal(PILOT_TERMS.length, 5);
  const all = PILOT_TERMS.join(" ");
  assert.match(all, /No subscription, registration fee or setup fee/);
  assert.match(all, /Customers pay the merchant directly/);
  assert.match(all, /15% of food sales after discounts, excluding the delivery fee, never higher/);
  assert.match(all, /At least 30 days' written notice/);
  assert.match(all, /leave at any time with no penalty/);
});
