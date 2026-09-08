// 在飞登记的单测（2026-09-08）。跑法：npm test（先 tsc build，再 node --test）。
// 钉的是「崩溃恢复靠的那几条性质」：落盘即完整、坏文件不拖累别人、先来先续、
// 次数封顶、修书 id 的文件名不带 #。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeInflight, removeInflight, listInflight, canRetry, inflightId, inflightPath, INFLIGHT_MAX_ATTEMPTS,
} from "../dist/inflight.js";

const create = (over = {}) => ({
  kind: "create", jobId: "8c396ef2-fded-454a-a7ff-2eebe5794bc2", seed: "嘟嘟住到西班牙海岸的一个小镇",
  scope: "users/anon-ae209/", author: "王建硕", auth: "Bearer anon_x", startedAt: 1788857670898, attempts: 1, ...over,
});
const revise = (over = {}) => ({
  kind: "revise", slug: "dudu-lighthouse", scope: "users/anon-ae209/", author: "王建硕",
  instruction: "把封面换掉", entryTs: 1788860000000, auth: "Bearer anon_x", startedAt: 1788860000000, attempts: 1, ...over,
});

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "inflight-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("写书 id=jobId，修书 id=slug#ts，文件名里 # 换成 __", () => {
  assert.equal(inflightId(create()), "8c396ef2-fded-454a-a7ff-2eebe5794bc2");
  assert.equal(inflightId(revise()), "dudu-lighthouse#1788860000000");
  assert.equal(inflightPath("/x", revise()), "/x/dudu-lighthouse__1788860000000.json");
});

test("落盘后能原样读回，文件 0600，销档后目录空", async () => withDir(async (dir) => {
  const rec = create();
  await writeInflight(dir, rec);
  const st = await stat(inflightPath(dir, rec));
  assert.equal(st.mode & 0o777, 0o600);           // 里面有 bearer
  assert.deepEqual(await listInflight(dir), [rec]);
  await removeInflight(dir, rec);
  assert.deepEqual(await listInflight(dir), []);
  await removeInflight(dir, rec);                   // 再删一次不抛
}));

test("目录不存在 → 空数组（第一次部署、老机器都没有这个目录）", async () => {
  assert.deepEqual(await listInflight("/nonexistent/inflight-dir"), []);
});

test("坏文件、半截文件、非 json 文件都跳过，不拖累别的孤儿", async () => withDir(async (dir) => {
  await writeInflight(dir, create());
  await writeFile(join(dir, "broken.json"), "{ not json");
  await writeFile(join(dir, "wrong-shape.json"), JSON.stringify({ kind: "create" }));
  await writeFile(join(dir, "x.json.tmp"), "{}");   // 写到一半的临时文件
  await writeFile(join(dir, "README"), "hi");
  const got = await listInflight(dir);
  assert.equal(got.length, 1);
  assert.equal(got[0].jobId, create().jobId);
}));

test("多个孤儿按起跑时间升序，先来先续", async () => withDir(async (dir) => {
  await writeInflight(dir, revise({ startedAt: 3000, entryTs: 3000 }));
  await writeInflight(dir, create({ jobId: "b", startedAt: 2000 }));
  await writeInflight(dir, create({ jobId: "a", startedAt: 1000 }));
  assert.deepEqual((await listInflight(dir)).map(inflightId), ["a", "b", "dudu-lighthouse#3000"]);
}));

test("次数封顶：原跑 1 次可续；续到上限就不再试", () => {
  assert.equal(INFLIGHT_MAX_ATTEMPTS, 2);
  assert.equal(canRetry(create({ attempts: 1 })), true);
  assert.equal(canRetry(create({ attempts: 2 })), false);
  assert.equal(canRetry(revise({ attempts: 5 })), false);
});

test("回填 slug 后重写同一文件（不是新文件）", async () => withDir(async (dir) => {
  const rec = create();
  await writeInflight(dir, rec);
  rec.slug = "dudu-lighthouse";
  await writeInflight(dir, rec);
  assert.equal((await readdir(dir)).length, 1);
  assert.equal(JSON.parse(await readFile(inflightPath(dir, rec), "utf8")).slug, "dudu-lighthouse");
}));
