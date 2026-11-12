import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * docs/supabase-realtime-applications.sql run for real in PGlite: adds only
 * the two application tables, is safe to re-run, leaves other tables, RLS and
 * grants alone, does nothing without the publication, and its UNDO works.
 */

const SQL = readFileSync(new URL("../../docs/supabase-realtime-applications.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`section not found: ${start}`);
  return text.slice(a + start.length, b);
}

const CHECK = between(SQL, "-- CHECK AFTERWARDS", "-- UNDO")
  .split("\n")
  .filter((l) => /^-- select /.test(l))
  .map((l) => l.replace(/^-- /, ""))[0];

const UNDO = between(SQL, "-- UNDO-BEGIN", "-- UNDO-END")
  .split("\n")
  .filter((l) => l.startsWith("-- "))
  .map((l) => l.slice(3))
  .join("\n");

const TABLES = `
  create table public.cook_applications (id uuid primary key, status text);
  create table public.rider_applications (id uuid primary key, status text);
  create table public.orders (id uuid primary key);
  alter table public.cook_applications enable row level security;
`;

async function published(db: PGlite): Promise<string[]> {
  const { rows } = await db.query<{ tablename: string }>(
    "select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename"
  );
  return rows.map((r) => r.tablename);
}

describe("supabase-realtime-applications.sql", () => {
  it("adds exactly the two application tables, alongside what's already published", async () => {
    const db = new PGlite();
    await db.exec(TABLES + "create publication supabase_realtime for table public.orders;");
    await db.exec(SQL);
    assert.deepEqual(await published(db), ["cook_applications", "orders", "rider_applications"]);
    const check = await db.query<{ tablename: string }>(CHECK);
    assert.deepEqual(check.rows.map((r) => r.tablename), ["cook_applications", "rider_applications"]);
    await db.close();
  });

  it("is safe to re-run and skips a table that is already in", async () => {
    const db = new PGlite();
    await db.exec(TABLES + "create publication supabase_realtime for table public.rider_applications;");
    await db.exec(SQL);
    await db.exec(SQL);
    assert.deepEqual(await published(db), ["cook_applications", "rider_applications"]);
    await db.close();
  });

  it("changes nothing else: RLS stays as it was", async () => {
    const db = new PGlite();
    await db.exec(TABLES + "create publication supabase_realtime;");
    const rls = "select relname, relrowsecurity from pg_class where relname in ('cook_applications','rider_applications') order by relname";
    const before = (await db.query(rls)).rows;
    await db.exec(SQL);
    assert.deepEqual((await db.query(rls)).rows, before);
    await db.close();
  });

  it("does nothing (and doesn't fail) when the publication doesn't exist", async () => {
    const db = new PGlite();
    await db.exec(TABLES);
    await db.exec(SQL);
    const { rows } = await db.query("select 1 from pg_publication where pubname = 'supabase_realtime'");
    assert.equal(rows.length, 0);
    await db.close();
  });

  it("UNDO removes only the two tables and is safe to re-run", async () => {
    const db = new PGlite();
    await db.exec(TABLES + "create publication supabase_realtime for table public.orders;");
    await db.exec(SQL);
    await db.exec(UNDO);
    await db.exec(UNDO);
    assert.deepEqual(await published(db), ["orders"]);
    await db.close();
  });

  it("the file only touches the publication (no RLS, grants, triggers or table changes)", () => {
    const run = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(run, /\b(grant|revoke|policy|trigger|create table|alter table|drop table|row level security)\b/i);
    assert.match(run, /alter publication supabase_realtime add table/);
  });
});
