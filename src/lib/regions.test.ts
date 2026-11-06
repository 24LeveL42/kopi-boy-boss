import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  countByRegion,
  filterByRegion,
  loadRiderRegions,
  normalizeRegions,
  parseRegionFilter,
  PICK_A_REGION_MESSAGE,
  REGION_CODES,
  REGION_COLOURS,
  REGION_LABEL,
  riderRegionsSaveMessage,
  setRiderRegionsWith,
  toRegion,
  validateRiderRegions,
} from "./regions.ts";

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const RIDER = "11111111-2222-4333-8444-555555555555";

// --- Codes, labels, colours ---

test("the four regions, in order, with the Customer app's colours", () => {
  assert.deepEqual([...REGION_CODES], ["north", "south", "east", "west"]);
  assert.deepEqual(REGION_LABEL, { north: "North", south: "South", east: "East", west: "West" });
  assert.deepEqual(
    Object.fromEntries(REGION_CODES.map((c) => [c, REGION_COLOURS[c].text])),
    { north: "#1d4ed8", south: "#9a3412", east: "#be123c", west: "#0e7490" },
  );
});

test("the tag always shows the word, not just the colour", () => {
  const tag = src("../components/RegionTag.tsx");
  assert.match(tag, /\{REGION_LABEL\[region\]\}/);
  assert.match(tag, /NO_REGION_LABEL/);
  assert.match(tag, /RIDER_NO_REGIONS_LABEL/);
});

test("toRegion keeps only exact codes", () => {
  assert.equal(toRegion("east"), "east");
  for (const v of [null, undefined, "", "East", "central", 3]) assert.equal(toRegion(v), null);
});

// --- Merchants filter and counts ---

const merchants = [
  { id: "a", region: "north" },
  { id: "b", region: "north" },
  { id: "c", region: "west" },
  { id: "d", region: null },
  { id: "e", region: "central" },
];

test("counts per region; no postal code or an unmapped sector counts as no region", () => {
  assert.deepEqual(countByRegion(merchants), { all: 5, north: 2, south: 0, east: 0, west: 1, none: 2 });
  assert.deepEqual(countByRegion([]), { all: 0, north: 0, south: 0, east: 0, west: 0, none: 0 });
});

test("All keeps every merchant, including ones with no region", () => {
  assert.deepEqual(filterByRegion(merchants, "all").map((m) => m.id), ["a", "b", "c", "d", "e"]);
});

test("a region keeps only its own merchants", () => {
  assert.deepEqual(filterByRegion(merchants, "north").map((m) => m.id), ["a", "b"]);
  assert.deepEqual(filterByRegion(merchants, "south"), []);
});

test("?region= parses safely; anything unknown means All", () => {
  assert.equal(parseRegionFilter("west"), "west");
  assert.equal(parseRegionFilter(" WEST "), "west");
  for (const v of [undefined, "", "all", "central", "none", ["north"]]) assert.equal(parseRegionFilter(v), "all");
});

// --- Rider regions: validation ---

test("validate: at least one region, known codes only, fixed order, no duplicates", () => {
  assert.deepEqual(validateRiderRegions(["west", "north", "west"]), { ok: true, regions: ["north", "west"] });
  assert.deepEqual(validateRiderRegions([" East "]), { ok: true, regions: ["east"] });
  assert.deepEqual(validateRiderRegions([]), { ok: false, message: PICK_A_REGION_MESSAGE });
  assert.deepEqual(validateRiderRegions(["", "  "]), { ok: false, message: PICK_A_REGION_MESSAGE });
  assert.deepEqual(validateRiderRegions("north"), { ok: false, message: PICK_A_REGION_MESSAGE });
  assert.equal(validateRiderRegions(["north", "central"]).ok, false);
  assert.match((validateRiderRegions(["central"]) as { message: string }).message, /Unknown region/);
  assert.deepEqual(normalizeRegions(["south", "SOUTH", 7, null]), ["south"]);
});

// --- Rider regions: loading ---

type Call = { table: string; columns: string; column: string; ids: string[] };

function fakeFrom(result: (call: Call) => { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => ({
      select: (columns: string) => ({
        in: async (column: string, ids: string[]) => {
          const call = { table, columns, column, ids };
          calls.push(call);
          return result(call);
        },
      }),
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

test("loadRiderRegions groups rows by rider, in the fixed order", async () => {
  const { client, calls } = fakeFrom(() => ({
    data: [
      { user_id: "r1", region: "west" },
      { user_id: "r1", region: "north" },
      { user_id: "r2", region: "east" },
      { user_id: "r2", region: "bogus" },
    ],
    error: null,
  }));
  const load = await loadRiderRegions(client, ["r1", "r2", "r3", "r1"]);
  assert.ok(load.ok);
  assert.deepEqual(load.byRider.get("r1"), ["north", "west"]);
  assert.deepEqual(load.byRider.get("r2"), ["east"]);
  assert.equal(load.byRider.get("r3"), undefined, "a rider with no rows has no entry (shown as Not set)");
  assert.deepEqual(calls, [{ table: "rider_regions", columns: "user_id, region", column: "user_id", ids: ["r1", "r2", "r3"] }]);
});

test("a failed read is an error, never an empty list", async () => {
  const { client } = fakeFrom(() => ({ data: null, error: { message: "permission denied for table rider_regions" } }));
  assert.deepEqual(await loadRiderRegions(client, ["r1"]), { ok: false, error: "permission denied for table rider_regions" });

  const throwing = { from: () => { throw new Error("network down"); } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(await loadRiderRegions(throwing as any, ["r1"]), { ok: false, error: "network down" });
});

test("a failure in a later batch still fails the whole read", async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `r${i}`);
  const { client, calls } = fakeFrom((call) =>
    call.ids.includes("r199") ? { data: null, error: { message: "timeout" } } : { data: [], error: null },
  );
  assert.deepEqual(await loadRiderRegions(client, ids), { ok: false, error: "timeout" });
  assert.equal(calls.length, 2);
});

// --- Rider regions: saving through admin_set_rider_regions ---

function fakeRpc(response: { error: { code?: string; message: string } | null } | Error) {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      if (response instanceof Error) throw response;
      return { data: null, ...response };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

test("saving calls admin_set_rider_regions with the cleaned list", async () => {
  const { client, calls } = fakeRpc({ error: null });
  assert.deepEqual(await setRiderRegionsWith(client, RIDER, ["west", "north"]), { ok: true, regions: ["north", "west"] });
  assert.deepEqual(calls, [{ fn: "admin_set_rider_regions", args: { p_rider: RIDER, p_regions: ["north", "west"] } }]);
});

test("nothing is sent with no region, an unknown region or a bad rider id", async () => {
  const { client, calls } = fakeRpc({ error: null });
  assert.deepEqual(await setRiderRegionsWith(client, RIDER, []), { ok: false, message: PICK_A_REGION_MESSAGE });
  assert.equal((await setRiderRegionsWith(client, RIDER, ["central"])).ok, false);
  assert.equal((await setRiderRegionsWith(client, "not-a-uuid", ["north"])).ok, false);
  assert.equal((await setRiderRegionsWith(client, null, ["north"])).ok, false);
  assert.equal(calls.length, 0);
});

test("database errors come back as clear messages, never thrown", async () => {
  const cases: [{ code?: string; message: string }, RegExp][] = [
    [{ code: "42501", message: "Only admins can change a rider's regions." }, /Only admins/],
    [{ code: "42501", message: "Only riders and rider applicants have ride regions." }, /isn't a rider/],
    [{ code: "22023", message: "Pick at least one region." }, /at least one region/],
    [{ code: "22023", message: "Unknown region. Use north, south, east or west." }, /Unknown region/],
    [{ code: "PGRST202", message: "Could not find the function" }, /isn't available yet/],
    [{ code: "XX000", message: "something odd" }, /Couldn't save the regions: something odd/],
  ];
  for (const [error, expected] of cases) {
    const { client } = fakeRpc({ error });
    const result = await setRiderRegionsWith(client, RIDER, ["north"]);
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, expected);
  }
  const { client } = fakeRpc(new Error("fetch failed"));
  assert.match(((await setRiderRegionsWith(client, RIDER, ["north"])) as { message: string }).message, /Couldn't reach/);
  assert.match(riderRegionsSaveMessage(null), /Couldn't save/);
});

// --- Screens ---

const MERCHANTS = src("../app/merchants/page.tsx");
const RIDERS = src("../app/riders/page.tsx");
const RIDER_EDIT = src("../app/riders/[id]/edit/page.tsx");
const ACTIONS = src("./actions.ts");

test("Merchants list: Region column, filter with counts, region read through the named columns", () => {
  assert.match(MERCHANTS, /\{ label: "Region" \}/);
  assert.match(MERCHANTS, /<MerchantRegion key="r" region=\{k\.region\} \/>/);
  assert.match(MERCHANTS, /<RegionFilterBar active=\{regionFilter\} counts=\{regionCounts\}/);
  assert.match(MERCHANTS, /countByRegion\(allKitchens\)/, "counts come from every merchant, not the filtered list");
});

test("Riders list: Regions column, Edit regions link, and a failed read shows an error", () => {
  assert.match(RIDERS, /\{ label: "Regions" \}/);
  assert.match(RIDERS, /<RiderRegions key="rg" regions=\{riderRegions\} \/>/);
  assert.match(RIDERS, /regions\.ok \? \(regions\.byRider\.get\(r\.id\) \?\? \[\]\) : "error"/);
  assert.match(RIDERS, /\{!regions\.ok && <LoadError what="rider regions"/);
  assert.match(RIDERS, /href=\{`\/riders\/\$\{r\.id\}\/edit`\}/);
});

test("Rider edit: no form over a failed read; saves only through the guarded action", () => {
  const gate = RIDER_EDIT.indexOf("if (!regions.ok)");
  const form = RIDER_EDIT.indexOf("<RiderRegionsForm");
  assert.ok(gate > 0 && gate < form, "the failed-read check must come before the form");
  assert.match(RIDER_EDIT.slice(gate, form), /<LoadError[\s\S]*return|return \([\s\S]*<LoadError/);
  assert.match(RIDER_EDIT, /if \(profile\.error\)/);

  const fn = ACTIONS.slice(ACTIONS.indexOf("export async function setRiderRegions"));
  assert.match(fn, /^export async function setRiderRegions\([^)]*\): Promise<SaveResult> \{\s*const \{ supabase \} = await assertAdmin\(\);/);
  assert.match(fn, /setRiderRegionsWith\(supabase, riderId, regions\)/);
  assert.match(fn, /return result;/);

  const form_ = src("../components/RiderRegionsForm.tsx");
  assert.match(form_, /type="checkbox"/);
  assert.match(form_, /setRiderRegions\(riderId, picked\)/);
  assert.doesNotMatch(form_, /\.rpc\(|createClient/, "the form never calls the database itself");
});

test("Boss never writes kitchens.region or rider_regions directly", () => {
  // The only kitchens write in Boss is MerchantEditForm's upsert, and it never mentions region.
  assert.doesNotMatch(src("../components/MerchantEditForm.tsx"), /region/i);
  assert.doesNotMatch(src("../lib/kitchen-columns.ts").split("MERCHANT_EDIT_KITCHEN_COLUMNS =")[1], /region/);
  for (const path of ["../app/merchants/page.tsx", "../app/riders/page.tsx", "../app/riders/[id]/edit/page.tsx", "./actions.ts", "./regions.ts"]) {
    const text = src(path);
    assert.doesNotMatch(text, /from\("kitchens"\)\s*\.(insert|update|upsert|delete)/, path);
    assert.doesNotMatch(text, /from\("rider_regions"\)\s*\.(insert|update|upsert|delete)/, path);
  }
  assert.match(src("./regions.ts"), /\.rpc\("admin_set_rider_regions"/);
});
