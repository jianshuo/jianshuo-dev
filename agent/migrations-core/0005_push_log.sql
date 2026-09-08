-- 推送流水：每一条发出去的 APNs 都在这里留一行（2026-09-08）。
-- 起因：通知在手机上点掉就没了，事后无从知道当初推的是什么、该跳去哪。
-- 写入点是 agent/src/push.js 的 sendPush()——全站 17 个推送调用（含 2 处运维报警）
-- 都收口在那一个函数，所以在那里写就是 100% 覆盖，调用方一行不用改。
-- 不用 R2：llmlogs/<日期>/ 那套被 list({delimiter}) 的扫描截断坑过（admin/llm 停在
-- 07-13）。这里要的是「按时间倒序翻页 + 按用户/来源筛」，正是 D1 的本行。
CREATE TABLE push_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  user_sub  TEXT NOT NULL,          -- 推给谁（users/<sub>/）
  source    TEXT,                   -- 来源：mine/book/ops/feedback/topup/devicelink/referral/transfer/feed/...
  title     TEXT NOT NULL,
  body      TEXT,
  link      TEXT,                   -- voicedrop:// 深链或 https 直链——事后能点回去的那一列
  thread_id TEXT,
  -- 投递结果。把「压根没发」和「发了但手机没显示」彻底分开：
  -- ok=APNs 受理 / no-token=该用户没登记设备 / gone=410 已清 / rejected=APNs 拒收
  -- / unconfigured=密钥或绑定没配 / error=异常。
  result    TEXT NOT NULL,
  detail    TEXT,                   -- ok 时是 apns-id；失败时是状态码与响应正文
  push_env  TEXT                    -- 'dev' | 'prod'
);
CREATE INDEX idx_push_log_ts   ON push_log(ts DESC);
CREATE INDEX idx_push_log_user ON push_log(user_sub, ts DESC);
