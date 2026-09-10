// 补封面任务纯函数的单测（2026-09-10）。跑法：npm test。
// 钉的性质：默认提示词把书名/副题/作者一字不差写进去并限定「只允许这些文字」；
// 429 判成额度并读出 resets_at；模型被拒/其他失败不当额度；孤儿封面只认竖版、近期、含书名的 done 任务；
// 提示词来源优先级 json > txt > 默认。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultCoverPrompt, classifyPaintFailure, nextNotBefore, pickOrphanCover, readPromptSpec,
} from "../dist/cover-sweeper.js";

const book = { slug: "ai-optical-ledger", title: "算力尽头是光", subtitle: "AI光通信的技术、产能与2026—2028供需账本", author: "蜜蜡", type: "explainary", tint: "#e8eff0", dark: "#286375" };

test("默认提示词：书名/副题/作者一字不差，且限定只允许这些文字，竖版 1024x1536", () => {
  const p = defaultCoverPrompt(book);
  assert.match(p, /「算力尽头是光」/);
  assert.match(p, /「AI光通信的技术、产能与2026—2028供需账本」/);
  assert.match(p, /「蜜蜡」/);
  assert.match(p, /只允许出现/);
  assert.match(p, /1024x1536/);
  assert.match(p, /#e8eff0/);
  const noSub = defaultCoverPrompt({ slug: "x", title: "搞", type: "novel" });
  assert.doesNotMatch(noSub, /副标题/);
  assert.doesNotMatch(noSub, /作者/);
  assert.match(defaultCoverPrompt({ slug: "d", title: "嘟嘟", type: "childrens" }), /童趣/);
});

test("429 判成额度：从 detail 里读 resets_at（秒 → 毫秒），没有 detail 也认 HTTP 429", () => {
  const detail = '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":1788987729,"resets_in_seconds":9279}}';
  const f = classifyPaintFailure({ code: "http_error", message: "HTTP 429" }, detail);
  assert.equal(f.kind, "quota");
  assert.equal(f.resetsAt, 1788987729_000);
  assert.equal(classifyPaintFailure({ code: "http_error", message: "HTTP 429" }).kind, "quota");
  assert.equal(classifyPaintFailure({ code: "http_error", message: "HTTP 429" }).resetsAt, undefined);
});

test("模型被拒 / 其他失败不是额度", () => {
  assert.equal(classifyPaintFailure({ code: "http_error", message: "HTTP 400" }, '{"detail":"The \'gpt-5.4\' model is not supported when using Codex with a ChatGPT account."}').kind, "model");
  assert.equal(classifyPaintFailure({ code: "http_error", message: "HTTP 404" }, "The model `gpt-5.5` does not exist or you do not have access to it.").kind, "model");
  assert.equal(classifyPaintFailure({ code: "missing_image_result", message: "response did not include an image" }).kind, "other");
  assert.equal(classifyPaintFailure({ code: "http_error", message: "HTTP 401" }, '{"error":"refresh_token_invalidated"}').kind, "other");
  assert.equal(classifyPaintFailure(null).kind, "other");
});

test("下次再试时刻：额度按 resets_at+1 分钟、过期的 resets_at 兜底一小时；其他 15 分钟×次数", () => {
  const now = 1_800_000_000_000;
  assert.equal(nextNotBefore({ kind: "quota", resetsAt: now + 9_000_000, message: "" }, 0, now), now + 9_000_000 + 60_000);
  assert.equal(nextNotBefore({ kind: "quota", resetsAt: now - 5, message: "" }, 0, now), now + 3_600_000);
  assert.equal(nextNotBefore({ kind: "quota", message: "" }, 0, now), now + 3_600_000);
  assert.equal(nextNotBefore({ kind: "other", message: "" }, 1, now), now + 900_000);
  assert.equal(nextNotBefore({ kind: "model", message: "" }, 2, now), now + 1_800_000);
});

test("孤儿封面：只认 done + 竖版 + 近期 + 含整个书名（或 xmp book=slug），取最新", () => {
  const now = Date.parse("2026-09-10T08:00:00Z");
  const mk = (over) => ({ id: "j", status: "done", prompt: "封面「算力尽头是光」", params: "{'size': '1024x1536', 'format': 'jpeg'}", doneAt: "2026-09-09T03:22:56Z", resultPath: "/r/j.jpg", ...over });
  const jobs = [
    mk({ id: "old", doneAt: "2026-09-01T00:00:00Z" }),
    mk({ id: "square", params: "{'size': '1024x1024'}" }),
    mk({ id: "failed", status: "failed" }),
    mk({ id: "other-book", prompt: "封面「直布罗陀风云录」" }),
    mk({ id: "older-ok", doneAt: "2026-09-09T01:00:00Z" }),
    mk({ id: "newest" }),
    mk({ id: "by-xmp", prompt: "no title here", xmpMeta: { book: "ai-optical-ledger" }, doneAt: "2026-09-08T12:00:00Z" }),
  ];
  assert.equal(pickOrphanCover(jobs, book, now)?.id, "newest");
  assert.equal(pickOrphanCover(jobs.filter((j) => j.id === "by-xmp"), book, now)?.id, "by-xmp");
  assert.equal(pickOrphanCover(jobs, { slug: "zzz", title: "不存在的书" }, now), null);
  assert.equal(pickOrphanCover(jobs, { slug: "zzz", title: "光" }, now), null, "一个字的书名不做包含匹配");
});

test("提示词来源：cover.prompt.json > cover.prompt.txt > 默认；json 的 image 相对工作目录且必须存在", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cover-spec-"));
  try {
    assert.equal((await readPromptSpec(dir, book)).source, "default");
    await writeFile(join(dir, "cover.prompt.txt"), "  手写提示词  ");
    let s = await readPromptSpec(dir, book);
    assert.equal(s.source, "txt"); assert.equal(s.prompt, "手写提示词");
    await writeFile(join(dir, "cover.prompt.json"), JSON.stringify({ prompt: "json 提示词", image: "ref.png" }));
    s = await readPromptSpec(dir, book);
    assert.equal(s.source, "json"); assert.equal(s.image, undefined, "参考图不存在就不带");
    await writeFile(join(dir, "ref.png"), "x");
    s = await readPromptSpec(dir, book);
    assert.equal(s.image, join(dir, "ref.png"));
    await writeFile(join(dir, "cover.prompt.json"), "{broken");
    assert.equal((await readPromptSpec(dir, book)).source, "txt", "json 坏了退回 txt");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
