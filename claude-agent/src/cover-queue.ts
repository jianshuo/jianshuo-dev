// src/cover-queue.ts — 「补封面」队列（2026-09-10）。
//
// 背景：封面是写书 skill 的最后一步，而书是边写边发的。引擎在章节写完、封面画完之间
// 倒下（撞配额/换腿/重启），书架上就多一本没封面的书；paint 出图又和 codex 写书腿共用
// 同一个 ChatGPT Plus 额度池，一本书最后几分钟同时要发末章、画封面，额度恰在这里打穿。
// 近 14 天 96 本书里 16 本首发没封面，全在 9/2 之后。
//
// 办法：封面从写书流程里整个摘出来。写书/修书收尾时往 pending/ 丢一个 <slug>.json
// （这就是 dirty 标记），systemd path 单元盯着 pending/ 非空就拉起 cover-sweeper；跑完
// 队列清空即退出，没新书什么都不发生。撞 429 的条目挪到 waiting/ 并记 notBefore（按
// paint 报的 resets_at），半小时一次的 timer 把到点的搬回 pending/。三次非配额失败进
// failed/ 并告警。
//
// 不变量：一次 sweep 结束时 pending/ 必须为空——path 单元在服务退出后会重新检查目录，
// 留东西在 pending/ 就是死循环。
//
// 纯文件操作、不 import server.ts，可单测。
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CoverState = "pending" | "waiting" | "failed";
export const COVER_STATES: readonly CoverState[] = ["pending", "waiting", "failed"];

export type CoverItem = {
  slug: string;
  reason: string;          // book-done / revise-done / audit-shelf / audit-workdir / manual
  enqueuedAt: number;
  attempts: number;        // 非配额失败的次数（429 不计）
  paintJobId?: string;     // 已提交的 paint 任务号——中途被杀下次接着等它，不重画
  notBefore?: number;      // waiting 里的到点时间（ms）
  lastError?: string;
  note?: string;
};

export function coverQueueDir(root: string, state: CoverState): string {
  return join(root, state);
}

export function coverItemPath(root: string, state: CoverState, slug: string): string {
  return join(root, state, `${slug}.json`);
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,99}$/.test(slug);
}

export async function ensureCoverQueue(root: string): Promise<void> {
  await Promise.all(COVER_STATES.map((s) => mkdir(coverQueueDir(root, s), { recursive: true })));
}

async function readItem(path: string): Promise<CoverItem | null> {
  try {
    const j = JSON.parse(await readFile(path, "utf8"));
    if (!j || typeof j.slug !== "string") return null;
    return j as CoverItem;
  } catch {
    return null;
  }
}

async function findState(root: string, slug: string): Promise<CoverState | null> {
  for (const s of COVER_STATES) {
    const it = await readItem(coverItemPath(root, s, slug));
    if (it) return s;
  }
  return null;
}

export async function saveCoverItem(root: string, state: CoverState, item: CoverItem): Promise<void> {
  await mkdir(coverQueueDir(root, state), { recursive: true });
  const p = coverItemPath(root, state, item.slug);
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(item, null, 2) + "\n", { mode: 0o644 });
  await rename(tmp, p);
}

export async function removeCoverItem(root: string, state: CoverState, slug: string): Promise<void> {
  try { await unlink(coverItemPath(root, state, slug)); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
}

export async function moveCoverItem(root: string, from: CoverState, to: CoverState, item: CoverItem): Promise<void> {
  await saveCoverItem(root, to, item);
  if (from !== to) await removeCoverItem(root, from, item.slug);
}

/** 排进队列。已在 pending 就不动；在 waiting/failed 就搬回 pending（书变了，值得马上再看一眼），attempts 清零。 */
export async function enqueueCover(root: string, slug: string, reason: string): Promise<"queued" | "already-pending" | "requeued"> {
  if (!isValidSlug(slug)) throw new Error(`bad slug: ${slug}`);
  await ensureCoverQueue(root);
  const cur = await findState(root, slug);
  if (cur === "pending") return "already-pending";
  const prev = cur ? await readItem(coverItemPath(root, cur, slug)) : null;
  const item: CoverItem = {
    slug,
    reason,
    enqueuedAt: Date.now(),
    attempts: 0,
    ...(prev?.paintJobId ? { paintJobId: prev.paintJobId } : {}),
  };
  await saveCoverItem(root, "pending", item);
  if (cur) await removeCoverItem(root, cur, slug);
  return cur ? "requeued" : "queued";
}

/** 列出某状态下的条目，按入队时间先来先处理；坏文件跳过不拖累别人。 */
export async function listCoverItems(root: string, state: CoverState): Promise<CoverItem[]> {
  let names: string[];
  try { names = await readdir(coverQueueDir(root, state)); } catch { return []; }
  const out: CoverItem[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const it = await readItem(join(coverQueueDir(root, state), n));
    if (it) out.push(it);
  }
  return out.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

/** 把 waiting 里到点的搬回 pending。返回搬了哪些 slug。 */
export async function wakeDueCovers(root: string, now = Date.now()): Promise<string[]> {
  const woke: string[] = [];
  for (const it of await listCoverItems(root, "waiting")) {
    if ((it.notBefore ?? 0) <= now) {
      const { notBefore: _drop, ...rest } = it;
      await moveCoverItem(root, "waiting", "pending", rest);
      woke.push(it.slug);
    }
  }
  return woke;
}
