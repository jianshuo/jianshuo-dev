#!/usr/bin/env bash
# Build locally, sync to the VPS, reinstall prod deps, restart the service.
# First-time provisioning (node, caddy, user, dirs, units) is in deploy/provision.sh.
#
# 重启守卫（2026-09-08）：systemctl restart 会杀掉正在写的书——9/8 上午《嘟嘟和山上的
# 灯塔》14 页 14 图全写完、差一步发布，被一次发版 restart 杀在终点线上。以前靠人记得
# 「发版前看一眼有没有任务在跑」，今天两次发版都没看。现在不靠人：
#   · 同步（dist/public/bin/skills）永远做——不影响运行中的进程；
#   · restart 只在 VPS 的 inflight/ 为空时做（每单开工落一个 JSON，引擎返回即删；
#     见 src/inflight.ts）。非空 → 默认不重启、退出码 2、列出在跑的书；
#   · WAIT_FOR_IDLE=1  等到空窗自动重启（每 30s 看一次，最多 MAX_WAIT_MIN 分钟）；
#   · FORCE_RESTART=1  立刻重启——新代码启动时会把被杀的书续跑，但前一条腿烧掉的
#     轮数收不回，非紧急别用。
set -euo pipefail

VPS="${VPS:-root@66.42.45.128}"
REMOTE="${REMOTE:-/opt/claude-agent}"
MAX_WAIT_MIN="${MAX_WAIT_MIN:-90}"

cd "$(dirname "$0")"
echo "▸ build"
npm run build

echo "▸ sync → $VPS:$REMOTE"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude workspace --exclude '*.log' \
  dist public bin package.json package-lock.json deploy \
  "$VPS:$REMOTE/"

echo "▸ sync skills → $VPS:$REMOTE/.claude/skills"
rsync -az --delete skills/ "$VPS:$REMOTE/.claude/skills/"
ssh "$VPS" "chown -R claude-agent:claude-agent $REMOTE/.claude/skills"

# 在跑的书：inflight/ 里每个 json 一单（写书=jobId.json，修书=slug__ts.json）。
inflight_list() {
  ssh "$VPS" "ls $REMOTE/inflight/*.json 2>/dev/null | xargs -r -n1 basename" || true
}
busy="$(inflight_list)"
if [ -n "$busy" ] && [ "${FORCE_RESTART:-0}" != "1" ]; then
  if [ "${WAIT_FOR_IDLE:-0}" = "1" ]; then
    echo "▸ 有书在跑，等空窗（最多 ${MAX_WAIT_MIN} 分钟）："; echo "$busy" | sed 's/^/    /'
    deadline=$(( $(date +%s) + MAX_WAIT_MIN * 60 ))
    while [ -n "$busy" ]; do
      if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "✗ 等了 ${MAX_WAIT_MIN} 分钟还在跑，放弃重启。代码已同步；空窗后手动：ssh $VPS systemctl restart claude-agent"
        exit 2
      fi
      sleep 30
      busy="$(inflight_list)"
    done
    echo "  空窗了，继续重启"
  else
    echo "✗ 有书在跑，不重启（代码已同步，正在跑的进程仍是旧版）："
    echo "$busy" | sed 's/^/    /'
    echo "  等空窗后：ssh $VPS 'cd $REMOTE && npm ci --omit=dev && systemctl restart claude-agent'"
    echo "  或：WAIT_FOR_IDLE=1 ./deploy.sh   （自动等）"
    echo "  或：FORCE_RESTART=1 ./deploy.sh   （立刻杀，启动后自动续跑，费一条腿的轮数）"
    exit 2
  fi
fi

echo "▸ install + restart"
ssh "$VPS" "cd $REMOTE && npm ci --omit=dev && systemctl restart claude-agent && sleep 1 && systemctl --no-pager --lines=8 status claude-agent | head -12"
echo "✓ deployed"
