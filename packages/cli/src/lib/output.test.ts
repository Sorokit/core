import { test } from "node:test";
import assert from "node:assert/strict";

import { printResult, printError } from "./output.js";

function captureConsole(fn: () => void, stream: "log" | "error"): string {
  const original = console[stream];
  let captured = "";
  console[stream] = (msg: string) => {
    captured = msg;
  };
  try {
    fn();
  } finally {
    console[stream] = original;
  }
  return captured;
}

test("printResult --json emits valid JSON matching the input", () => {
  const output = captureConsole(() => printResult({ a: 1, b: "two" }, true), "log");
  assert.deepEqual(JSON.parse(output), { a: 1, b: "two" });
});

test("printResult (human) renders each field on its own line", () => {
  const output = captureConsole(() => printResult({ hash: "abc", status: "success" }, false), "log");
  assert.match(output, /hash: abc/);
  assert.match(output, /status: success/);
});

test("printResult (human) renders nested objects indented", () => {
  const output = captureConsole(
    () => printResult({ balances: [{ assetCode: "XLM", balance: "100" }] }, false),
    "log",
  );
  assert.match(output, /balances:/);
  assert.match(output, /assetCode: XLM/);
});

test("printResult (human) prints '(none)' for an empty array", () => {
  const output = captureConsole(() => printResult([], false), "log");
  assert.equal(output, "(none)");
});

test("printError --json wraps the message in an error field", () => {
  const output = captureConsole(() => printError("boom", true), "error");
  assert.deepEqual(JSON.parse(output), { error: "boom" });
});

test("printError (human) prefixes the message with 'Error:'", () => {
  const output = captureConsole(() => printError("boom", false), "error");
  assert.equal(output, "Error: boom");
});
