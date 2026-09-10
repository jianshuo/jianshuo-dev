// src/cover-sweeper.ts — 补封面任务（2026-09-10）。队列机制见 cover-queue.ts 头注释。
//
// 三种跑法（都是 systemd 拉起，见 deploy/cover-*.{service,path,timer}）：
//   node dist/cover-sweeper.js run              # path 单元：pending/ 非空就跑；timer：半小时搬一次到点的
//   node dist/cover-sweeper.js audit            # 每天一次：把书架上/工作目录里没封面的书排进队列（只入队不处理）
//   node dist/cover-sweeper.js enqueue <slug>   # 人工入队
//
// 每个条目的处理顺序：线上已有封面 → 只补 book.json 标记；paint 结果目录里有这本书刚画好
// 没传的孤儿图 → 直接用；否则按 cover.prompt.json / cover.prompt.txt / 默认版式提示词调
// paint。429 → waiting（到点自动回来，不计次）；其他失败三次 → failed + 告警。
// 中途被杀：paintJobId 已落盘，下次接着等那个任务，不重画。
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type CoverItem, enqueueCover, ensureCoverQueue, listCoverItems, moveCoverItem, removeCoverItem,
  saveCoverItem, wakeDueCovers,
} from "./cover-queue.js";

const execFileP = promisify(execFile);

// ── 配置（全部可用 env 覆盖，便于本机试跑）──────────────────────────────────
const HOME = process.env.HOME ?? homedir();
const ROOT = process.env.COVER_QUEUE_DIR ?? join(HOME, "cover-queue");
const WORKSPACE = process.env.WORKSPACE ?? join(HOME, "workspace");
const BUILD_MJS = process.env.BUILD_MJS ?? join(HOME, ".claude/skills/wjs-voicedrop-writing-book/build.mjs");
const PAINT_API = (process.env.PAINT_API ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const PAINT_TOKEN = process.env.PAINT_API_TOKEN ?? "";
const PAINT_JOBS_DIR = process.env.PAINT_JOBS_DIR ?? "/opt/paint/data/jobs";
const PAINT_RESULTS_DIR = process.env.PAINT_RESULTS_DIR ?? "/opt/paint/data/results";
const PUBLIC_BASE = (process.env.BOOKS_PUBLIC_BASE ?? "https://jianshuo.dev/voicedrop/books").replace(/\/$/, "");
const ADMIN_PUSH_URL = process.env.ADMIN_PUSH_URL ?? "https://jianshuo.dev/agent/push/admin";
const MAX_ATTEMPTS = Number(process.env.COVER_MAX_ATTEMPTS ?? 3);
const POLL_MS = Number(process.env.COVER_POLL_MS ?? 5000);
const POLL_MAX_MS = Number(process.env.COVER_POLL_MAX_MS ?? 12 * 60 * 1000);
const AUDIT_MAX_AGE_MS = Number(process.env.COVER_AUDIT_MAX_AGE_DAYS ?? 30) * 86400 * 1000;
const ORPHAN_MAX_AGE_MS = Number(process.env.COVER_ORPHAN_MAX_AGE_DAYS ?? 3) * 86400 * 1000;

const log = (m: string) => console.log(`[cover] ${m}`);

// ── 纯函数（单测覆盖）──────────────────────────────────────────────────────

export type BookMeta = {
  slug: string; title?: string; subtitle?: string; author?: string; type?: string;
  tint?: string; dark?: string; cover?: boolean; coverAt?: number; createdAt?: number; hidden?: boolean;
};

/** 没有写手留提示词时的默认封面提示词：照 skill 的「文字为主角」版式，书名/副题/作者一字不差。 */
export function defaultCoverPrompt(book: BookMeta): string {
  const title = (book.title ?? book.slug).trim();
  const sub = (book.subtitle ?? "").trim();
  const author = (book.author ?? "").trim();
  const mood =
    book.type === "childrens" ? "童趣、明亮、可爱，柔和水彩加彩铅质感，色彩明亮温柔" :
    book.type === "novel" ? "随故事基调的沉静书卷气，可以有一个象征性的抽象画面元素" :
    "淡雅、克制、留白充足，像一本认真出版的科普书";
  const palette = book.tint || book.dark
    ? `配色以 ${[book.tint, book.dark].filter(Boolean).join(" 与 ")} 为主，浅色纸底。`
    : "浅暖米纸底，低饱和的一两种主色。";
  const lines = [`书名：「${title}」`];
  if (sub) lines.push(`副标题：「${sub}」`);
  if (author) lines.push(`作者：「${author}」`);
  return [
    `一张竖版图书封面（1024x1536），平面整张封面，不要实体书模型、不要书脊透视。整张封面以文字为主角，背景是${mood}的抽象画面，退为衬托。${palette}`,
    `文字排版：主标题非常大、粗、占据上部约满宽（长了分两行）；${sub ? "副标题约为主标题一半大小、紧跟其下；" : ""}${author ? "作者中等大小、底部居中。" : ""}文字放在抽象背景的空白区之上，清晰可读。`,
    `画面上只允许出现下面这些文字，一字不差，不要多余字符、不要水印、不要乱码：`,
    ...lines,
  ].join("\n");
}

export type PaintFailure = { kind: "quota" | "model" | "other"; resetsAt?: number; message: string };

/** 把 paint 的失败分成三类：额度（等 resets_at）/ 模型被拒（不是我们能修的，按其他失败计次）/ 其他。 */
export function classifyPaintFailure(error: { code?: string; message?: string } | null | undefined, detail?: unknown): PaintFailure {
  const msg = String(error?.message ?? "");
  const code = String(error?.code ?? "");
  const detailStr = typeof detail === "string" ? detail : detail ? JSON.stringify(detail) : "";
  const blob = `${code} ${msg} ${detailStr}`;
  if (/usage_limit|429|rate.?limit/i.test(blob)) {
    let resetsAt: number | undefined;
    const m = detailStr.match(/"resets_at"\s*:\s*(\d{9,13})/);
    if (m) { const n = Number(m[1]); resetsAt = n < 1e12 ? n * 1000 : n; }
    return { kind: "quota", resetsAt, message: msg || "usage limit" };
  }
  // 限定在 model 一词附近（40 字内），泛泛的 /not supported/ 会误伤参数错误；模型号里有小数点，所以用 . 不用 [^.]
  if (/model.{0,40}?(not supported|does not exist|not found)/i.test(blob) || /model_not_found/i.test(blob)) {
    return { kind: "model", message: msg || "model rejected" };
  }
  return { kind: "other", message: msg || code || "paint failed" };
}

/** 下次可以再试的时刻。额度：按 resets_at 加一分钟余量，没有就等一小时；其他：15 分钟 × 次数。 */
export function nextNotBefore(f: PaintFailure, attempts: number, now = Date.now()): number {
  if (f.kind === "quota") return f.resetsAt && f.resetsAt > now ? f.resetsAt + 60_000 : now + 60 * 60_000;
  return now + 15 * 60_000 * Math.max(1, attempts);
}

export type PaintJobRecord = {
  id: string; status: string; prompt?: string; params?: string | Record<string, unknown>;
  createdAt?: string; doneAt?: string; resultPath?: string; xmpMeta?: Record<string, string>;
};

/** 从 paint 的任务记录里挑出这本书「画好了没人传」的孤儿封面：done、竖版、提示词里有整个书名、最近几天内，取最新。 */
export function pickOrphanCover(jobs: PaintJobRecord[], book: BookMeta, now = Date.now(), maxAgeMs = ORPHAN_MAX_AGE_MS): PaintJobRecord | null {
  const title = (book.title ?? "").trim();
  const cands = jobs.filter((j) => {
    if (j.status !== "done" || !j.resultPath) return false;
    const t = Date.parse(j.doneAt ?? j.createdAt ?? "");
    if (!Number.isFinite(t) || now - t > maxAgeMs) return false;
    const params = typeof j.params === "string" ? j.params : JSON.stringify(j.params ?? {});
    if (!/1024x1536/.test(params)) return false;
    if (j.xmpMeta?.book === book.slug) return true;
    return title.length >= 2 && (j.prompt ?? "").includes(title);
  });
  cands.sort((a, b) => Date.parse(b.doneAt ?? b.createdAt ?? "") - Date.parse(a.doneAt ?? a.createdAt ?? ""));
  return cands[0] ?? null;
}

export type PromptSpec = { prompt: string; image?: string; source: "json" | "txt" | "default" };

/** 写手留的提示词优先：cover.prompt.json {prompt, image?} > cover.prompt.txt > 默认版式。 */
export async function readPromptSpec(workdir: string, book: BookMeta): Promise<PromptSpec> {
  try {
    const j = JSON.parse(await readFile(join(workdir, "cover.prompt.json"), "utf8"));
    if (typeof j?.prompt === "string" && j.prompt.trim()) {
      const image = typeof j.image === "string" && j.image.trim() ? join(workdir, j.image.trim()) : undefined;
      return { prompt: j.prompt.trim(), ...(image && existsSync(image) ? { image } : {}), source: "json" };
    }
  } catch { /* 没有或坏了，往下走 */ }
  try {
    const t = (await readFile(join(workdir, "cover.prompt.txt"), "utf8")).trim();
    if (t) return { prompt: t, source: "txt" };
  } catch { /* 没有 */ }
  return { prompt: defaultCoverPrompt(book), source: "default" };
}

// ── 副作用层 ────────────────────────────────────────────────────────────────

const workdirOf = (slug: string) => join(WORKSPACE, `book-${slug}`);

async function readBook(workdir: string): Promise<BookMeta | null> {
  try { return JSON.parse(await readFile(join(workdir, "book.json"), "utf8")); } catch { return null; }
}

async function build(args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileP("node", [BUILD_MJS, ...args], { cwd, env: process.env, maxBuffer: 4 << 20, timeout: 5 * 60_000 });
  if (stderr?.trim()) log(`build.mjs ${args[0]} stderr: ${stderr.trim().slice(0, 300)}`);
  return stdout;
}

async function coverOnline(slug: string): Promise<boolean> {
  try {
    const r = await fetch(`${PUBLIC_BASE}/${slug}/cover.jpg?_=${Date.now()}`, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return r.ok && /image\//.test(r.headers.get("content-type") ?? "");
  } catch { return false; }
}

async function ensureWorkdir(slug: string): Promise<{ workdir: string; book: BookMeta } | null> {
  const workdir = workdirOf(slug);
  let book = await readBook(workdir);
  if (!book) {
    log(`${slug}: 没有工作目录，从线上 _src 拉`);
    try {
      await mkdir(WORKSPACE, { recursive: true });
      await build(["pull", workdir, slug], WORKSPACE);
    } catch (e: any) {
      log(`${slug}: pull 失败 ${String(e?.message ?? e).slice(0, 200)}`);
      return null;
    }
    book = await readBook(workdir);
  }
  return book ? { workdir, book } : null;
}

async function paintHeaders() {
  if (!PAINT_TOKEN) throw new Error("PAINT_API_TOKEN not set");
  return { Authorization: `Bearer ${PAINT_TOKEN}`, "Content-Type": "application/json" };
}

async function submitPaint(spec: PromptSpec, slug: string): Promise<string> {
  const body: Record<string, unknown> = {
    prompt: spec.prompt, size: "1024x1536", format: "jpeg", quality: "high",
    xmp_meta: { book: slug, source: "cover-sweeper" },
  };
  if (spec.image) body.image_b64 = (await readFile(spec.image)).toString("base64");
  const r = await fetch(`${PAINT_API}/api/jobs`, { method: "POST", headers: await paintHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.job_id) throw new Error(`paint submit ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return String(j.job_id);
}

type PaintJob = { job_id: string; status: string; result_url?: string | null; error?: { code?: string; message?: string } | null };

async function getPaint(id: string): Promise<PaintJob> {
  const r = await fetch(`${PAINT_API}/api/jobs/${id}`, { headers: await paintHeaders(), signal: AbortSignal.timeout(30_000) });
  if (r.status === 404) return { job_id: id, status: "failed", error: { code: "not_found", message: "paint job not found" } };
  if (!r.ok) throw new Error(`paint get ${r.status}`);
  return (await r.json()) as PaintJob;
}

async function waitPaint(id: string): Promise<PaintJob> {
  const deadline = Date.now() + POLL_MAX_MS;
  for (;;) {
    const j = await getPaint(id);
    if (j.status === "done" || j.status === "failed") return j;
    if (Date.now() > deadline) return j;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function readPaintDetail(id: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(PAINT_JOBS_DIR, `${id}.json`), "utf8")).error?.detail; } catch { return undefined; }
}

async function listPaintJobs(maxAgeMs: number): Promise<PaintJobRecord[]> {
  let names: string[];
  try { names = await readdir(PAINT_JOBS_DIR); } catch { return []; }
  const out: PaintJobRecord[] = [];
  const cutoff = Date.now() - maxAgeMs;
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const p = join(PAINT_JOBS_DIR, n);
    try {
      const st = await stat(p);
      if (st.mtimeMs < cutoff) continue;
      out.push(JSON.parse(await readFile(p, "utf8")));
    } catch { /* 跳过坏文件 */ }
  }
  return out;
}

async function fetchResult(job: PaintJob, dest: string): Promise<void> {
  const local = join(PAINT_RESULTS_DIR, `${job.job_id}.jpg`);
  if (existsSync(local)) { await copyFile(local, dest); return; }
  if (!job.result_url) throw new Error("no result_url");
  const r = await fetch(job.result_url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`download ${r.status}`);
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}

async function publishCover(workdir: string, slug: string): Promise<void> {
  const out = await build(["asset", workdir, "cover.jpg", "cover.jpg"], workdir);
  log(`${slug}: ${out.trim().split("\n").pop()}`);
}

async function markCoverFlag(workdir: string, book: BookMeta, slug: string): Promise<void> {
  book.cover = true; book.coverAt = Date.now();
  await writeFile(join(workdir, "book.json"), JSON.stringify(book, null, 2) + "\n");
  await build(["index", workdir], workdir);   // index 顺手把 book.json 同步到 _src
  log(`${slug}: 线上已有封面，只补了 book.json 标记`);
}

async function publisherToken(): Promise<string | null> {
  try { return JSON.parse(await readFile(join(HOME, ".config/voicedrop/credentials"), "utf8")).token ?? null; } catch { return null; }
}

async function notifyAdmin(title: string, body: string): Promise<void> {
  try {
    const tok = await publisherToken();
    if (!tok) return;
    const r = await fetch(ADMIN_PUSH_URL, {
      method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title, body }), signal: AbortSignal.timeout(15_000),
    });
    log(`admin-push ${title} status=${r.status}`);
  } catch (e: any) { log(`admin-push failed ${String(e?.message ?? e)}`); }
}

async function park(item: CoverItem, f: PaintFailure): Promise<void> {
  item.lastError = f.message.slice(0, 300);
  if (f.kind === "quota") {
    item.paintJobId = undefined;
    item.notBefore = nextNotBefore(f, item.attempts);
    await moveCoverItem(ROOT, "pending", "waiting", item);
    log(`${item.slug}: 出图额度打穿，等到 ${new Date(item.notBefore).toISOString()} 再试`);
    return;
  }
  item.attempts += 1;
  item.paintJobId = undefined;
  if (item.attempts >= MAX_ATTEMPTS) {
    await moveCoverItem(ROOT, "pending", "failed", item);
    log(`${item.slug}: 失败 ${item.attempts} 次，放弃 → ${f.message.slice(0, 120)}`);
    await notifyAdmin("补封面失败", `${item.slug} · ${item.attempts} 次 · ${f.message.slice(0, 100)}`);
    return;
  }
  item.notBefore = nextNotBefore(f, item.attempts);
  await moveCoverItem(ROOT, "pending", "waiting", item);
  log(`${item.slug}: 失败第 ${item.attempts} 次（${f.message.slice(0, 120)}），${new Date(item.notBefore).toISOString()} 再试`);
}

async function processItem(item: CoverItem): Promise<void> {
  const { slug } = item;
  try {
    const found = await ensureWorkdir(slug);
    if (!found) {
      await park(item, { kind: "other", message: "no workdir and pull failed (old book without _src?)" });
      return;
    }
    const { workdir, book } = found;
    if (await coverOnline(slug)) {
      if (book.cover !== true) await markCoverFlag(workdir, book, slug);
      else log(`${slug}: 线上已有封面，无事可做`);
      await removeCoverItem(ROOT, "pending", slug);
      return;
    }
    const dest = join(workdir, "cover.jpg");
    if (!item.paintJobId) {
      const orphan = pickOrphanCover(await listPaintJobs(ORPHAN_MAX_AGE_MS), book);
      if (orphan?.resultPath && existsSync(orphan.resultPath)) {
        await copyFile(orphan.resultPath, dest);
        log(`${slug}: 捡到 paint 里画好没传的封面 ${orphan.id}`);
        await publishCover(workdir, slug);
        await removeCoverItem(ROOT, "pending", slug);
        return;
      }
      const spec = await readPromptSpec(workdir, book);
      item.paintJobId = await submitPaint(spec, slug);
      item.note = `prompt=${spec.source}`;
      await saveCoverItem(ROOT, "pending", item);   // 先落盘再等：中途被杀下次接着等这个任务
      log(`${slug}: 提交出图 ${item.paintJobId}（提示词来源 ${spec.source}）`);
    } else {
      log(`${slug}: 接着等上次提交的 ${item.paintJobId}`);
    }
    const job = await waitPaint(item.paintJobId);
    if (job.status === "done") {
      await fetchResult(job, dest);
      await publishCover(workdir, slug);
      await removeCoverItem(ROOT, "pending", slug);
      return;
    }
    if (job.status === "failed") {
      await park(item, classifyPaintFailure(job.error, await readPaintDetail(job.job_id)));
      return;
    }
    // 还在跑（超过了本轮等待上限）：留着 jobId，过 5 分钟再来看
    item.notBefore = Date.now() + 5 * 60_000;
    await moveCoverItem(ROOT, "pending", "waiting", item);
    log(`${slug}: paint 还在跑，稍后再看`);
  } catch (e: any) {
    await park(item, { kind: "other", message: String(e?.message ?? e) });
  }
}

async function run(): Promise<void> {
  await ensureCoverQueue(ROOT);
  const woke = await wakeDueCovers(ROOT);
  if (woke.length) log(`到点回队列：${woke.join(", ")}`);
  // 循环取件直到 pending/ 真空：处理一本要一两分钟，期间新到的书要在同一轮接着做，
  // 不能当成「没处理完的残留」。每本只处理一次（done 的会删、失败的会挪走，正常不会再见到）。
  const seen = new Set<string>();
  for (;;) {
    const batch = (await listCoverItems(ROOT, "pending")).filter((p) => !seen.has(p.slug));
    if (!batch.length) break;            // 没活，安静退出
    log(`待处理 ${batch.length} 本：${batch.map((p) => p.slug).join(", ")}`);
    for (const item of batch) { seen.add(item.slug); await processItem(item); }
  }
  // 不变量：pending/ 现在必须为空（path 单元会立刻重查目录）。处理过还留在这里 = 代码有洞，挪走别空转。
  const left = await listCoverItems(ROOT, "pending");
  if (left.length) {
    log(`⚠ pending/ 里还剩 ${left.map((p) => p.slug).join(", ")}，挪到 waiting 防止 path 单元空转`);
    for (const it of left) { it.notBefore = Date.now() + 15 * 60_000; await moveCoverItem(ROOT, "pending", "waiting", it); }
  }
}

/** 每天一次：把没封面的书排进队列。只入队，不处理（处理交给 path 单元拉起的 run，避免两个进程抢同一本）。 */
async function audit(): Promise<void> {
  await ensureCoverQueue(ROOT);
  const now = Date.now();
  let n = 0;
  try {
    const r = await fetch(`${PUBLIC_BASE}/?format=json&_=${now}`, { signal: AbortSignal.timeout(60_000) });
    const books: BookMeta[] = ((await r.json()) as any).books ?? [];
    for (const b of books) {
      if (b.cover === true || !b.slug) continue;
      if (b.createdAt && now - b.createdAt > AUDIT_MAX_AGE_MS) continue;
      const st = await enqueueCover(ROOT, b.slug, "audit-shelf");
      if (st !== "already-pending") { n++; log(`audit: 书架 ${b.slug} 无封面 → ${st}`); }
    }
  } catch (e: any) { log(`audit: 拉书架失败 ${String(e?.message ?? e)}`); }
  // 工作目录里的（含 hidden 的书，书架 JSON 不列）
  let dirs: string[] = [];
  try { dirs = (await readdir(WORKSPACE)).filter((d) => d.startsWith("book-")); } catch { /* 无 */ }
  for (const d of dirs) {
    const book = await readBook(join(WORKSPACE, d));
    if (!book?.slug || book.cover === true) continue;
    if (book.createdAt && now - book.createdAt > AUDIT_MAX_AGE_MS) continue;
    if (!book.createdAt) continue;                 // 没 createdAt = 还没首发（幽灵书拦截同款判据）
    const st = await enqueueCover(ROOT, book.slug, "audit-workdir");
    if (st !== "already-pending") { n++; log(`audit: 工作目录 ${book.slug} 无封面 → ${st}`); }
  }
  log(`audit 完成，入队 ${n} 本`);
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "run";
  if (cmd === "run") return run();
  if (cmd === "audit") return audit();
  if (cmd === "enqueue") {
    const slug = argv[1];
    if (!slug) { console.error("用法：cover-sweeper enqueue <slug>"); process.exit(2); }
    log(`enqueue ${slug} → ${await enqueueCover(ROOT, slug, argv[2] ?? "manual")}`);
    return;
  }
  console.error(`未知命令 ${cmd}（run | audit | enqueue <slug>）`);
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error("[cover] fatal", e); process.exit(1); });
}
