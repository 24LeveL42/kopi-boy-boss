import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildApprovalEmail,
  DEFAULT_PARTNER_APP_URL,
  LEGAL_LINE,
  maskEmail,
  partnerWelcomeUrl,
  RESEND_ENDPOINT,
  sendApprovalEmail,
  SUPPORT_EMAIL,
  type EmailDeps,
} from "./approval-email.ts";
import { approveAndNotify } from "./approvals.ts";
import { fakeSupabase, fail, ok } from "./testing/fake-supabase.ts";

const KEY = "re_test_SECRET_key_123";
const ENV = { RESEND_API_KEY: KEY, EMAIL_FROM: "Kopi Boy <hello@mail.kopi-boy.com>" };
const WELCOME = `${DEFAULT_PARTNER_APP_URL}/welcome`;

type FetchCall = { url: string; init: RequestInit; body: Record<string, unknown> };

/** Fake fetch + log. `reply` decides each response (default: 200 with an id). */
function harness(env: Record<string, string | undefined> = ENV, reply?: (call: FetchCall) => Promise<Response> | Response) {
  const fetches: FetchCall[] = [];
  const logs: string[] = [];
  const deps: EmailDeps = {
    env,
    timeoutMs: 50,
    log: {
      info: (...a) => logs.push(a.join(" ")),
      warn: (...a) => logs.push(a.join(" ")),
      error: (...a) => logs.push(a.join(" ")),
    },
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url: String(url), init, body: JSON.parse(String(init.body)) };
      fetches.push(call);
      return reply ? reply(call) : new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    }) as unknown as typeof fetch,
  };
  return { deps, fetches, logs };
}

const cookArgs = {
  table: "cook_applications" as const,
  role: "cook" as const,
  applicationId: "app-1",
  applicantUserId: "user-1",
  reviewerId: "admin-1",
};
const riderArgs = { ...cookArgs, table: "rider_applications" as const, role: "rider" as const, applicationId: "app-9" };

/** A database where the approval succeeds and this call is the one that approves. */
function approvingDb(overrides: Record<string, ReturnType<typeof ok> | ReturnType<typeof ok>[]> = {}) {
  return fakeSupabase({
    "profiles.select": [ok({ role: "customer" }), ok({ full_name: "Siti Rahmah" })],
    "profiles.update": ok([{ id: "user-1" }]),
    "cook_applications.update": ok([{ id: "app-1" }]),
    "rider_applications.update": ok([{ id: "app-9" }]),
    "cook_applications.select": ok({ business_name: "Siti's Kitchen" }),
    "rpc.admin_user_emails": ok([{ id: "user-1", email: "siti@example.com" }]),
    ...overrides,
  });
}

const statusWrites = (calls: ReturnType<typeof fakeSupabase>["calls"]) =>
  calls.filter((c) => c.op === "update" && /_applications$/.test(c.name));

// ---------------------------------------------------------------- sending

test("approving a merchant sends exactly one email, to the applicant, with Reply-To and an idempotency key", async () => {
  const { client, calls } = approvingDb();
  const { deps, fetches } = harness();
  const result = await approveAndNotify(client, cookArgs, deps);

  assert.equal(fetches.length, 1);
  const [{ url, init, body }] = fetches;
  assert.equal(url, RESEND_ENDPOINT);
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${KEY}`);
  assert.equal(headers["Idempotency-Key"], "approval/cook_applications/app-1");
  assert.deepEqual(body.to, ["siti@example.com"]);
  assert.equal(body.from, "Kopi Boy <hello@mail.kopi-boy.com>");
  assert.equal(body.reply_to, SUPPORT_EMAIL);
  assert.equal(body.subject, "You're approved: welcome to Kopi Boy, Siti's Kitchen!");
  assert.match(String(body.text), /^Hi Siti,/);
  assert.match(String(body.html), /href="https:\/\/kopi-boy-partner-cgpt-version\.vercel\.app\/welcome"/);

  assert.deepEqual(result, { tone: "ok", notice: "Approved. Welcome email sent.", email: "sent" });
  assert.equal(statusWrites(calls).length, 1);
  assert.ok(calls.some((c) => c.kind === "rpc" && c.name === "admin_user_emails"));
});

test("approving a rider sends the rider email with its own idempotency key", async () => {
  const { client } = approvingDb({ "rpc.admin_user_emails": ok([{ id: "user-1", email: "ravi@example.com" }]) });
  const { deps, fetches } = harness();
  const result = await approveAndNotify(client, riderArgs, deps);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].body.subject, "You're approved: welcome to the Kopi Boy rider team!");
  assert.equal((fetches[0].init.headers as Record<string, string>)["Idempotency-Key"], "approval/rider_applications/app-9");
  assert.equal(result.email, "sent");
});

test("approving again (already approved, 0 rows changed) sends nothing", async () => {
  const { client } = approvingDb({ "cook_applications.update": ok([]) });
  const { deps, fetches } = harness();
  const result = await approveAndNotify(client, cookArgs, deps);
  assert.equal(fetches.length, 0);
  assert.deepEqual(result, { tone: "ok", notice: "Already approved earlier. No new email sent.", email: "skipped" });
});

test("two approvals of the same application send one email between them", async () => {
  const { client } = approvingDb({ "cook_applications.update": [ok([{ id: "app-1" }]), ok([])] });
  const { deps, fetches } = harness();
  await approveAndNotify(client, cookArgs, deps);
  await approveAndNotify(client, cookArgs, deps);
  assert.equal(fetches.length, 1);
});

test("a failed approval (DB error) still throws, and sends nothing", async () => {
  const { client } = approvingDb({ "cook_applications.update": fail("denied") });
  const { deps, fetches } = harness();
  await assert.rejects(approveAndNotify(client, cookArgs, deps), { message: "Couldn't approve application: denied" });
  assert.equal(fetches.length, 0);
});

// ------------------------------------------------- email failures never fail approval

const failureCases: [string, Record<string, string | undefined>, ((c: FetchCall) => Promise<Response> | Response) | undefined, RegExp][] = [
  ["RESEND_API_KEY missing", { EMAIL_FROM: ENV.EMAIL_FROM }, undefined, /RESEND_API_KEY missing/],
  ["EMAIL_FROM missing", { RESEND_API_KEY: KEY }, undefined, /EMAIL_FROM missing/],
  ["fetch throws (network down)", ENV, () => Promise.reject(new TypeError("fetch failed")), /couldn't reach Resend/],
  [
    "Resend is too slow (timeout)",
    ENV,
    (c) =>
      new Promise<Response>((_, reject) => {
        c.init.signal!.addEventListener("abort", () => reject(c.init.signal!.reason));
      }),
    /Resend timed out/,
  ],
  [
    "Resend 403: domain not verified",
    ENV,
    () => new Response(JSON.stringify({ statusCode: 403, message: "The mail.kopi-boy.com domain is not verified." }), { status: 403 }),
    /Resend said \(403\): The mail\.kopi-boy\.com domain is not verified\./,
  ],
  ["Resend 500 with a non-JSON body", ENV, () => new Response("oops", { status: 500 }), /Resend said \(500\): HTTP 500/],
];

for (const [label, env, reply, reason] of failureCases) {
  test(`approval still succeeds when the email fails: ${label}`, async () => {
    const { client, calls } = approvingDb();
    const { deps, logs } = harness(env, reply);
    const result = await approveAndNotify(client, cookArgs, deps);
    assert.equal(result.tone, "warn");
    assert.match(result.notice, /^Approved\. Email not sent: /);
    assert.match(result.notice, reason);
    assert.notEqual(result.email, "sent");
    assert.equal(statusWrites(calls).length, 1, "the application was still marked approved");
    assert.ok(logs.some((l) => l.includes("[approval-email]") && l.includes("cook app=app-1")), "logged");
  });
}

test("no email address on file (RPC empty or erroring) -> skipped, no fetch, approval kept", async () => {
  for (const rpc of [ok([]), fail("function admin_user_emails does not exist")]) {
    const { client, calls } = approvingDb({ "rpc.admin_user_emails": rpc });
    const { deps, fetches } = harness();
    const result = await approveAndNotify(client, cookArgs, deps);
    assert.equal(fetches.length, 0);
    assert.equal(result.notice, "Approved. Email not sent: no email address on file.");
    assert.equal(statusWrites(calls).length, 1);
  }
});

test("sendApprovalEmail never throws, even if the fake fetch blows up synchronously", async () => {
  const { deps } = harness();
  deps.fetch = (() => {
    throw new Error("boom");
  }) as unknown as typeof fetch;
  const outcome = await sendApprovalEmail({ kind: "rider", to: "a@b.co", idempotencyKey: "k", ref: "rider app=x" }, deps);
  assert.equal(outcome.status, "failed");
});

test("the API key never appears in logs or in the admin notice", async () => {
  for (const [, env, reply] of failureCases) {
    const { client } = approvingDb();
    const { deps, logs } = harness(env, reply);
    const result = await approveAndNotify(client, cookArgs, deps);
    assert.ok(!logs.join("\n").includes(KEY));
    assert.ok(!result.notice.includes(KEY));
  }
  const { client } = approvingDb();
  const { deps, logs } = harness();
  await approveAndNotify(client, cookArgs, deps);
  const all = logs.join("\n");
  assert.ok(!all.includes(KEY));
  assert.ok(!all.includes("siti@example.com"), "full address is masked");
  assert.match(all, /to=s\*\*\*@example\.com/);
});

// ---------------------------------------------------------------- templates

const merchant = buildApprovalEmail("merchant", { name: "Siti Rahmah", businessName: "Siti's Kitchen", partnerUrl: WELCOME });
const rider = buildApprovalEmail("rider", { name: "Ravi Kumar", partnerUrl: WELCOME });

test("both emails have one button to Partner, the support email, Reply wording and the legal line", () => {
  for (const email of [merchant, rider]) {
    for (const part of [email.html, email.text]) {
      assert.ok(part.includes(WELCOME));
      assert.ok(part.includes(SUPPORT_EMAIL));
      assert.ok(part.includes("Just reply to this email"));
      assert.ok(part.includes(LEGAL_LINE));
      assert.ok(part.includes("KOPIE BOY (UEN 53535194A)"));
    }
    assert.equal(email.html.match(/<a href="https:/g)?.length, 1, "exactly one button link");
    assert.ok(email.text.trim().length > 100);
  }
});

test("merchant email: the approved subscription and rider wording, nothing promised for free", () => {
  for (const part of [merchant.html, merchant.text]) {
    assert.ok(part.includes("0% commission"));
    assert.ok(
      part.includes(
        "Your subscription is S$29.95/month, with no commission. We&#39;ll tell you your billing dates in writing before your first payment."
      ) ||
        part.includes(
          "Your subscription is S$29.95/month, with no commission. We'll tell you your billing dates in writing before your first payment."
        )
    );
    assert.ok(part.includes("If a rider delivers your order, you pay the rider the delivery fee you agree with them."));
    assert.doesNotMatch(part, /\bfree\b|first month|trial/i);
  }
});

test("rider email: free app, paid by the merchant", () => {
  assert.ok(rider.text.includes("The rider app is free to use."));
  assert.ok(rider.text.includes("You're paid by the merchant for each delivery."));
  assert.equal(rider.subject, "You're approved: welcome to the Kopi Boy rider team!");
});

test("no email mentions GST, an old price, or a free first month", () => {
  for (const email of [merchant, rider]) {
    const all = `${email.subject}\n${email.html}\n${email.text}`;
    assert.doesNotMatch(all, /\bGST\b/i);
    assert.doesNotMatch(all, /first month|free month|month free|trial/i);
    assert.doesNotMatch(all, /29\.90?\b(?!\d)|\$29\.9(?!5)/);
  }
});

test("names are HTML-escaped; missing names fall back politely", () => {
  const e = buildApprovalEmail("merchant", { name: "<b>Ali</b>", businessName: "Tom & <Jerry>", partnerUrl: WELCOME });
  assert.ok(!e.html.includes("<b>Ali"));
  assert.ok(e.html.includes("&lt;b&gt;Ali"));
  assert.ok(e.html.includes("Tom &amp; &lt;Jerry&gt;"));
  const blank = buildApprovalEmail("merchant", { name: null, businessName: "  ", partnerUrl: WELCOME });
  assert.match(blank.text, /^Hi there,/);
  assert.ok(blank.text.includes("your business has been approved"));
});

test("PARTNER_APP_URL: default, trailing slash stripped, non-https ignored", () => {
  assert.equal(partnerWelcomeUrl(undefined), WELCOME);
  assert.equal(partnerWelcomeUrl(""), WELCOME);
  assert.equal(partnerWelcomeUrl("https://partner.kopi-boy.com/"), "https://partner.kopi-boy.com/welcome");
  assert.equal(partnerWelcomeUrl("http://evil.example"), WELCOME);
  assert.equal(partnerWelcomeUrl("javascript:alert(1)"), WELCOME);
});

test("PARTNER_APP_URL from env is used for the button", async () => {
  const { deps, fetches } = harness({ ...ENV, PARTNER_APP_URL: "https://partner.kopi-boy.com" });
  await sendApprovalEmail({ kind: "rider", to: "r@x.co", idempotencyKey: "k", ref: "r" }, deps);
  assert.ok(String(fetches[0].body.html).includes('href="https://partner.kopi-boy.com/welcome"'));
});

test("maskEmail keeps only the first letter and the domain", () => {
  assert.equal(maskEmail("siti@example.com"), "s***@example.com");
  assert.equal(maskEmail("nope"), "***");
});

// ------------------------------------------ reject never emails; key stays server-side

const SRC = fileURLToPath(new URL("..", import.meta.url));
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}
const FILES = new Map(walk(SRC).map((p) => [resolve(p), readFileSync(p, "utf8")]));
const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");
const isDirective = (text: string, d: string) => new RegExp(`^\\s*(\\/\\/[^\\n]*\\n|\\/\\*[\\s\\S]*?\\*\\/\\s*)*["']${d}["']`).test(text);

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (FILES.has(resolve(candidate))) return resolve(candidate);
  }
  return null;
}
/** Runtime imports only (type-only imports are erased from the bundle). */
function runtimeImports(path: string): string[] {
  const text = FILES.get(path)!;
  return [...text.matchAll(/^import\s+(?!type\s)[\s\S]*?from\s+["']([^"']+)["']/gm)]
    .map((m) => resolveImport(path, m[1]))
    .filter((p): p is string => p !== null);
}

test("reject actions never touch the email code", () => {
  const actions = FILES.get(resolve(join(SRC, "lib/actions.ts")))!;
  for (const name of ["rejectCookApplication", "rejectRiderApplication"]) {
    const start = actions.indexOf(`export async function ${name}`);
    const body = actions.slice(start, actions.indexOf("\n}\n", start));
    assert.doesNotMatch(body, /approveAndNotify|sendApprovalEmail|approval-email/, name);
  }
});

test("the email module is reachable only from the server: no client file imports it, even indirectly", () => {
  const emailModule = resolve(join(SRC, "lib/approval-email.ts"));
  const approvals = resolve(join(SRC, "lib/approvals.ts"));
  for (const [path, text] of FILES) {
    if (!isDirective(text, "use client")) continue;
    const seen = new Set<string>();
    const stack = [path];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      // A "use server" file reaches the client only as action references, not code.
      if (p !== path && isDirective(FILES.get(p)!, "use server")) continue;
      assert.ok(p !== emailModule && p !== approvals, `${rel(path)} pulls ${rel(p)} into the client bundle`);
      stack.push(...runtimeImports(p));
    }
  }
});

test("approval-email.ts is imported only by approvals.ts, and approvals.ts only by the actions file", () => {
  const importers = (target: string) =>
    [...FILES.keys()].filter((p) => runtimeImports(p).includes(resolve(join(SRC, target)))).map(rel).sort();
  assert.deepEqual(importers("lib/approval-email.ts"), ["lib/approvals.ts"]);
  assert.deepEqual(importers("lib/approvals.ts"), ["lib/actions.ts"]);
});

test("no NEXT_PUBLIC_ variant of the email settings exists anywhere", () => {
  for (const [path, text] of FILES) {
    assert.doesNotMatch(text, /NEXT_PUBLIC_(RESEND|EMAIL|PARTNER_APP)/, rel(path));
  }
});

test("built client JavaScript (if a build exists) contains no Resend key name or endpoint", (t) => {
  const staticDir = fileURLToPath(new URL("../../.next/static", import.meta.url));
  if (!existsSync(staticDir)) return t.skip("no .next/static (run `npm run build` first)");
  const all = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? all(join(dir, n)) : [join(dir, n)]));
  for (const file of all(staticDir).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes("RESEND_API_KEY"), file);
    assert.ok(!text.includes("api.resend.com"), file);
  }
});
