import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BUDGET_LIMITS, UpdateBudget } from "../updates/src/budget.js";

class SqlCursor {
  constructor(rows = []) { this.rows = rows; }
  [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
}

function context() {
  const database = new DatabaseSync(":memory:");
  let writeStatements = 0;
  const sql = {
    exec(query, ...bindings) {
      const operation = query.trimStart().split(/\s+/u)[0].toUpperCase();
      if (operation === "CREATE") {
        database.exec(query);
        return new SqlCursor();
      }
      const statement = database.prepare(query);
      if (operation === "SELECT") return new SqlCursor(statement.all(...bindings));
      statement.run(...bindings);
      writeStatements += 1;
      return new SqlCursor();
    },
  };
  const storage = {
    sql,
    transactionSync(callback) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = callback();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { ctx: { storage }, database, writes: () => writeStatements };
}

function reservation(kind, bytes) {
  return new Request("https://budget.invalid/reserve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, bytes }),
  });
}

function row(database) {
  return database.prepare("SELECT * FROM update_budget WHERE singleton = 1").get();
}

test("lookup quotas are atomic and denied reservations do not write", async () => {
  const state = context();
  const budget = new UpdateBudget(state.ctx);
  budget.now = () => Date.parse("2026-09-10T12:00:00Z");
  const responses = await Promise.all(Array.from({ length: 110 }, () => budget.fetch(reservation("lookup", 0))));
  assert.equal(responses.filter((response) => response.status === 200).length, BUDGET_LIMITS.lookupDaily);
  assert.equal(responses.filter((response) => response.status === 429).length, 10);
  assert.equal(row(state.database).lookup_daily, 100);
  assert.equal(state.writes(), 100);

  const writesBeforeDenial = state.writes();
  const denied = await budget.fetch(reservation("lookup", 0));
  assert.equal(denied.status, 429);
  assert.equal(state.writes(), writesBeforeDenial);
});

test("UTC day and month counters reset without losing the other period", async () => {
  const state = context();
  const budget = new UpdateBudget(state.ctx);
  budget.now = () => Date.parse("2026-09-30T23:59:59Z");
  assert.equal((await budget.fetch(reservation("lookup", 0))).status, 200);
  budget.now = () => Date.parse("2026-10-01T00:00:00Z");
  assert.equal((await budget.fetch(reservation("lookup", 0))).status, 200);
  assert.equal(row(state.database).day_key, "2026-10-01");
  assert.equal(row(state.database).month_key, "2026-10");
  assert.equal(row(state.database).lookup_daily, 1);
  assert.equal(row(state.database).lookup_monthly, 1);
});

test("download count and byte reservations commit together", async () => {
  const state = context();
  const budget = new UpdateBudget(state.ctx);
  budget.now = () => Date.parse("2026-09-10T00:00:00Z");
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await budget.fetch(reservation("download", 125_000_000))).status, 200);
  }
  const writesBeforeDenial = state.writes();
  const denied = await budget.fetch(reservation("download", 125_000_000));
  assert.equal(denied.status, 429);
  assert.match(denied.headers.get("retry-after"), /^\d+$/);
  assert.equal(state.writes(), writesBeforeDenial);
  assert.equal(row(state.database).download_bytes_monthly, 500_000_000);
});

test("storage failure returns 503 and does not claim a reservation", async () => {
  const state = context();
  const budget = new UpdateBudget(state.ctx);
  state.ctx.storage.transactionSync = () => { throw new Error("disk unavailable"); };
  const response = await budget.fetch(reservation("lookup", 0));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "budget_unavailable" });
});

test("invalid internal reservation is rejected before SQL writes", async () => {
  const state = context();
  const budget = new UpdateBudget(state.ctx);
  const response = await budget.fetch(reservation("download", 192 * 1024 * 1024 + 1));
  assert.equal(response.status, 400);
  assert.equal(state.writes(), 0);
});
