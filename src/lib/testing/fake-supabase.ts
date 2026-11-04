/**
 * In-memory stand-in for the Supabase client, for `node --test` only.
 * Records every auth/rpc/table call in order. Answers come from `respond`:
 * keys are "auth.getUser", "rpc.<fn>" or "<table>.<op>" (op = select |
 * update | delete | insert). A value can be one result or an array used
 * in turn, one per call (the last one repeats).
 */
import type { AnyClient } from "../admin-guard.ts";

export type Result = { data: unknown; error: { message: string } | null; count?: number | null };
export type Call = {
  kind: "auth" | "rpc" | "table";
  name: string;
  op?: string;
  args?: unknown;
  values?: unknown;
  filters: [string, unknown][];
  columns?: string;
};

export const ok = (data: unknown): Result => ({ data, error: null });
export const fail = (message: string): Result => ({ data: null, error: { message } });

export function fakeSupabase(respond: Record<string, Result | Result[]>) {
  const calls: Call[] = [];
  const used: Record<string, number> = {};
  const answer = (key: string): Result => {
    const r = respond[key];
    if (r === undefined) return { data: null, error: null };
    if (!Array.isArray(r)) return r;
    const i = used[key] ?? 0;
    used[key] = i + 1;
    return r[Math.min(i, r.length - 1)];
  };

  const client = {
    auth: {
      getUser() {
        calls.push({ kind: "auth", name: "getUser", filters: [] });
        const r = answer("auth.getUser");
        return Promise.resolve({ data: { user: (r.data as unknown) ?? null }, error: r.error });
      },
    },
    rpc(name: string, args?: unknown) {
      calls.push({ kind: "rpc", name, args, filters: [] });
      return Promise.resolve(answer(`rpc.${name}`));
    },
    from(table: string) {
      const call: Call = { kind: "table", name: table, op: "select", filters: [] };
      let settled: Result | null = null;
      const settle = () => {
        if (!settled) {
          calls.push(call);
          settled = answer(`${table}.${call.op}`);
        }
        return settled;
      };
      const builder = {
        select(columns?: string) {
          if (call.op === "select") call.columns = columns;
          return builder;
        },
        update(values: unknown) {
          call.op = "update";
          call.values = values;
          return builder;
        },
        insert(values: unknown) {
          call.op = "insert";
          call.values = values;
          return builder;
        },
        delete() {
          call.op = "delete";
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        in(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        maybeSingle() {
          return Promise.resolve(settle());
        },
        single() {
          return Promise.resolve(settle());
        },
        then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(settle()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { calls, client: client as unknown as AnyClient };
}
