// test/push-log.test.js — 推送流水（D1 push_log，2026-09-08）。
// 每一条发出去的 APNs 都要留一行，成败都留：通知在手机上点掉就没了，console 日志
// 几小时也滚没了，这张表是事后唯一能回答「当初推的是什么、该跳去哪」的地方。
// 所以这里逐条钉的是「每种早退/失败都得有行」，而不只是成功路径。
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { fakeEnv, fakeD1, coreSql } from "./fakes.js";
import {
  coreWritePushLog, coreListPushLog, corePushLogStats, coreCleanupPushLog,
  corePutPushToken, coreGetPushToken,
} from "../../functions/lib/core-db.js";
import { sendPush } from "../src/push.js";

const SCOPE = "users/anon-abc/";

// 真 P-256 私钥：让 apnsJwt 走完整的 WebCrypto 签名，不绕过。
let PEM;
async function makePem() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

// APNs 齐活的 env（KEY_ID 每个用例换一个，绕开 push.js 里的 JWT 模块级缓存）。
let keyN = 0;
const pushEnv = (extra = {}) => ({
  ...fakeEnv(),
  CORE: fakeD1(coreSql()),
  APNS_KEY_P8: PEM, APNS_KEY_ID: "KEY" + ++keyN, APNS_TEAM_ID: "TEAM1",
  ...extra,
});

const apnsReply = (status, body = "", headers = {}) =>
  vi.fn(async () => new Response(body, { status, headers }));

const only = async (env) => (await coreListPushLog(env)).rows[0];

beforeEach(async () => { PEM = PEM || await makePem(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("sendPush 每条路径都落一行流水", () => {
  it("APNs 未配置 → unconfigured，照样留行（不是黑洞）", async () => {
    const env = pushEnv({ APNS_KEY_P8: "" });
    expect(await sendPush(env, SCOPE, { title: "标题", body: "正文", source: "mine" })).toBe(false);
    const r = await only(env);
    expect(r.result).toBe("unconfigured");
    expect(r.title).toBe("标题");
    expect(r.source).toBe("mine");
  });

  it("用户没登记设备 → no-token", async () => {
    const env = pushEnv();
    expect(await sendPush(env, SCOPE, { title: "标题", source: "ops" })).toBe(false);
    const r = await only(env);
    expect(r.result).toBe("no-token");
    expect(r.source).toBe("ops");
  });

  it("APNs 受理 → ok，apns-id 进 detail，link 原样留住", async () => {
    const env = pushEnv();
    await corePutPushToken(env, SCOPE, "devtok", "prod", Date.now());
    vi.stubGlobal("fetch", apnsReply(200, "", { "apns-id": "AB-12" }));

    expect(await sendPush(env, SCOPE, {
      title: "文章已生成", body: "《小记》挖好了", link: "voicedrop://article/xyz", source: "mine",
    })).toBe(true);

    const r = await only(env);
    expect(r.result).toBe("ok");
    expect(r.detail).toBe("apns-id=AB-12");
    expect(r.link).toBe("voicedrop://article/xyz");   // 事后能点回去的那一列
    expect(r.pushEnv).toBe("prod");
    expect(r.userSub).toBe(SCOPE);
  });

  it("APNs 拒收 → rejected，状态码和响应正文都留在 detail", async () => {
    const env = pushEnv();
    await corePutPushToken(env, SCOPE, "devtok", "dev", Date.now());
    vi.stubGlobal("fetch", apnsReply(403, '{"reason":"ExpiredProviderToken"}'));

    expect(await sendPush(env, SCOPE, { title: "标题", source: "ops" })).toBe(false);
    const r = await only(env);
    expect(r.result).toBe("rejected");
    expect(r.detail).toContain("403");
    expect(r.detail).toContain("ExpiredProviderToken");
  });

  it("410 → gone，且失效 token 被清掉", async () => {
    const env = pushEnv();
    await corePutPushToken(env, SCOPE, "devtok", "prod", Date.now());
    vi.stubGlobal("fetch", apnsReply(410));

    expect(await sendPush(env, SCOPE, { title: "标题", source: "feed" })).toBe(false);
    expect((await only(env)).result).toBe("gone");
    expect(await coreGetPushToken(env, SCOPE)).toBe(false);
  });

  it("没给 source → 退回 threadId；两个都没有 → other", async () => {
    const env = pushEnv();
    await sendPush(env, SCOPE, { title: "甲", threadId: "user-feedback" });
    await sendPush(env, SCOPE, { title: "乙" });
    const { rows } = await coreListPushLog(env);
    expect(rows.map((r) => r.source)).toEqual(["other", "user-feedback"]);   // 倒序
  });

  it("D1 不可用也不影响推送本身（记流水绝不成为新故障点）", async () => {
    const env = pushEnv({ CORE: null });
    vi.stubGlobal("fetch", apnsReply(200, "", { "apns-id": "X" }));
    // 无 CORE ⇒ 读不到 push token ⇒ 本就推不出去；关键是它安静返回 false，不抛。
    await expect(sendPush(env, SCOPE, { title: "标题" })).resolves.toBe(false);
  });
});

describe("后台读取：倒序 / 翻页 / 过滤 / 统计 / 清理", () => {
  const seed = async (env, n, source, sub = SCOPE) => {
    for (let i = 0; i < n; i++)
      await coreWritePushLog(env, { ts: 1000 + i, userSub: sub, source, title: `t${i}`, result: "ok" });
  };

  it("时间倒序，cursor 一页页翻到底且不重不漏", async () => {
    const env = pushEnv();
    await seed(env, 5, "mine");
    const p1 = await coreListPushLog(env, { limit: 2 });
    expect(p1.rows.map((r) => r.title)).toEqual(["t4", "t3"]);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await coreListPushLog(env, { limit: 2, cursor: p1.nextCursor });
    expect(p2.rows.map((r) => r.title)).toEqual(["t2", "t1"]);
    const p3 = await coreListPushLog(env, { limit: 2, cursor: p2.nextCursor });
    expect(p3.rows.map((r) => r.title)).toEqual(["t0"]);
    expect(p3.nextCursor).toBe(0);   // 到底了
  });

  it("按来源、按收件人分别筛得出来", async () => {
    const env = pushEnv();
    await seed(env, 2, "mine");
    await seed(env, 3, "ops", "users/admin/");
    expect((await coreListPushLog(env, { source: "ops" })).rows.length).toBe(3);
    expect((await coreListPushLog(env, { userSub: SCOPE })).rows.length).toBe(2);
  });

  it("统计给出总数、24 小时内、来源与结果分布", async () => {
    const env = pushEnv();
    await coreWritePushLog(env, { ts: Date.now(), userSub: SCOPE, source: "mine", title: "新", result: "ok" });
    await coreWritePushLog(env, { ts: Date.now(), userSub: SCOPE, source: "ops", title: "新2", result: "rejected" });
    await coreWritePushLog(env, { ts: Date.now() - 3 * 86400000, userSub: SCOPE, source: "mine", title: "旧", result: "ok" });
    const st = await corePushLogStats(env);
    expect(st.total).toBe(3);
    expect(st.last24h).toBe(2);
    expect(st.bySource.find((x) => x.source === "mine").n).toBe(2);
    expect(st.byResult.find((x) => x.result === "rejected").n).toBe(1);
  });

  it("清理只删 cutoff 之前的行", async () => {
    const env = pushEnv();
    await coreWritePushLog(env, { ts: 1000, userSub: SCOPE, title: "旧", result: "ok" });
    await coreWritePushLog(env, { ts: 9000, userSub: SCOPE, title: "新", result: "ok" });
    await coreCleanupPushLog(env, 5000);
    const { rows } = await coreListPushLog(env);
    expect(rows.map((r) => r.title)).toEqual(["新"]);
  });

  it("D1 不可用 → 列表/统计返回 null（不是空数组，后台好区分「没数据」和「后端挂了」）", async () => {
    expect(await coreListPushLog({ CORE: null })).toBeNull();
    expect(await corePushLogStats({ CORE: null })).toBeNull();
  });
});
