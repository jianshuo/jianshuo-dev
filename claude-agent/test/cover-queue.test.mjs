// 补封面队列的单测（2026-09-10）。跑法：npm test。
// 钉的性质：入队幂等、waiting/failed 再入队会搬回 pending、到点唤醒只搬到点的、坏文件不拖累别人、slug 白名单。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enqueueCover, listCoverItems, moveCoverItem, saveCoverItem, wakeDueCovers, coverQueueDir, isValidSlug,
} from "../dist/cover-queue.js";

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "cover-queue-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("enqueue：新书入 pending；再入队幂等；waiting/failed 里的搬回 pending 且 attempts 清零", () =>
  withDir(async (root) => {
    assert.equal(await enqueueCover(root, "gibraltar", "book-done"), "queued");
    assert.equal(await enqueueCover(root, "gibraltar", "book-done"), "already-pending");
    let [it] = await listCoverItems(root, "pending");
    assert.equal(it.slug, "gibraltar");
    assert.equal(it.attempts, 0);

    it.attempts = 2; it.paintJobId = "job-1"; it.notBefore = Date.now() + 1e6;
    await moveCoverItem(root, "pending", "waiting", it);
    assert.equal((await listCoverItems(root, "pending")).length, 0);
    assert.equal(await enqueueCover(root, "gibraltar", "revise-done"), "requeued");
    [it] = await listCoverItems(root, "pending");
    assert.equal(it.attempts, 0);
    assert.equal(it.paintJobId, "job-1", "在飞的 paint 任务号要带回来，别重画");
    assert.equal(it.reason, "revise-done");
    assert.equal((await listCoverItems(root, "waiting")).length, 0);
  }));

test("wakeDue：只搬到点的，notBefore 字段搬回时去掉", () =>
  withDir(async (root) => {
    const now = 1_800_000_000_000;
    await saveCoverItem(root, "waiting", { slug: "a", reason: "x", enqueuedAt: 1, attempts: 0, notBefore: now - 1 });
    await saveCoverItem(root, "waiting", { slug: "b", reason: "x", enqueuedAt: 2, attempts: 0, notBefore: now + 1 });
    assert.deepEqual(await wakeDueCovers(root, now), ["a"]);
    const pending = await listCoverItems(root, "pending");
    assert.deepEqual(pending.map((p) => p.slug), ["a"]);
    assert.equal(pending[0].notBefore, undefined);
    assert.deepEqual((await listCoverItems(root, "waiting")).map((p) => p.slug), ["b"]);
  }));

test("list：按入队时间排序，坏 JSON 和非 json 文件跳过", () =>
  withDir(async (root) => {
    await saveCoverItem(root, "pending", { slug: "late", reason: "x", enqueuedAt: 20, attempts: 0 });
    await saveCoverItem(root, "pending", { slug: "early", reason: "x", enqueuedAt: 10, attempts: 0 });
    await writeFile(join(coverQueueDir(root, "pending"), "broken.json"), "{not json");
    await writeFile(join(coverQueueDir(root, "pending"), "note.txt"), "x");
    assert.deepEqual((await listCoverItems(root, "pending")).map((p) => p.slug), ["early", "late"]);
    assert.equal((await readdir(coverQueueDir(root, "pending"))).length, 4, "坏文件留着不删，便于人看");
  }));

test("slug 白名单：拒绝路径穿越和大写", async () => {
  assert.equal(isValidSlug("two-chambers-explained"), true);
  assert.equal(isValidSlug("../etc"), false);
  assert.equal(isValidSlug("Foo"), false);
  assert.equal(isValidSlug(""), false);
  await withDir(async (root) => {
    await assert.rejects(() => enqueueCover(root, "../x", "m"), /bad slug/);
  });
});
