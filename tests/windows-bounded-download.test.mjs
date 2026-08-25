import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { downloadExactFile } from "../scripts/lib/bounded-download.mjs";

function response(chunks, headers = new Headers()) {
  return { ok: true, status: 200, headers, body: Readable.toWeb(Readable.from(chunks)) };
}

test("bounded artifact download accepts only the exact immutable size", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-win-download-"));
  const destination = path.join(temporary, "artifact.partial");
  try {
    const result = await downloadExactFile({ url: "https://invalid.example/exact", destination, expectedBytes: 6, fetchImpl: async () => response([Buffer.from("abc"), Buffer.from("def")]) });
    assert.equal(result.bytes, 6);
    assert.equal(await readFile(destination, "utf8"), "abcdef");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("bounded artifact download cancels an oversized unknown-length stream and deletes the partial", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-win-download-over-"));
  const destination = path.join(temporary, "artifact.partial");
  try {
    await assert.rejects(() => downloadExactFile({ url: "https://invalid.example/oversized", destination, expectedBytes: 4, fetchImpl: async () => response([Buffer.from("1234"), Buffer.from("5")]) }), /exceeded the 4-byte pin/);
    await assert.rejects(() => stat(destination), /ENOENT/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("bounded artifact download rejects any mismatched content-length before writing", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-win-download-length-"));
  const destination = path.join(temporary, "artifact.partial");
  try {
    await assert.rejects(() => downloadExactFile({ url: "https://invalid.example/declared", destination, expectedBytes: 4, fetchImpl: async () => response([Buffer.from("12345")], new Headers({ "content-length": "5" })) }), /content-length differs/);
    await assert.rejects(() => downloadExactFile({ url: "https://invalid.example/truncated", destination, expectedBytes: 4, fetchImpl: async () => response([Buffer.from("123")], new Headers({ "content-length": "3" })) }), /content-length differs/);
    await assert.rejects(() => stat(destination), /ENOENT/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
