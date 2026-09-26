import test from "node:test";
import assert from "node:assert/strict";
import { decimal } from "../src/lib/stock.js";

test("decimal preserves inventory precision", () => {
  assert.equal(decimal("100.125").add(decimal("0.375")).toString(), "100.5");
});

test("negative inventory changes can be represented for ledger validation", () => {
  assert.equal(decimal("10").sub(decimal("12")).toString(), "-2");
});