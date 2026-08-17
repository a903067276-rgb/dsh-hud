#!/bin/bash
# DSH 自重启脚本 —— 供 DSH 内部 agent 调用，也适用人工（替代旧的 /tmp/dsh-restart.sh）
# 调用方式（关键：调用方 shell 必须先 nohup 脱离，再让脚本去杀）:
#   nohup bash ~/.dsh/restart-self.sh > /dev/null 2>&1 & disown
# 设计要点（防「自己搞死自己」）:
#   1. 本脚本全程脱离 DSH 进程树（nohup 防 SIGHUP），DSH 被杀了本脚本照跑
#   2. 只杀 LISTEN 状态的 3080 监听者（-sTCP:LISTEN）——lsof 不加过滤会把
#      Chrome 等客户端连接一起杀；也禁用 pkill -f（误杀执行命令的 shell）
#   3. 开头 sleep 2：给调用方 shell 时间安全退出/回复完用户再动手杀
#   4. 杀完等端口释放 → 起新进程（绝对路径）→ curl 轮询验证 200，结果写日志
# 日志: /tmp/dsh-restart.log（本脚本）/ /tmp/dsh-web.log（DSH 本体）
LOG=/tmp/dsh-restart.log
DSH=/Users/xinbanzhuan/.npm-global/bin/dsh
PORT=3080

{
  echo "=== $(date '+%F %T') restart begin ==="
  echo "old listener: $(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')"

  # 0. 缓冲期：让调用方 shell 先退出
  sleep 2

  # 1. 杀旧监听者（只杀 LISTEN，不动客户端连接）
  lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null

  # 2. 等端口释放（最多 20 秒）
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1 || break
    sleep 1
  done

  # 3. 起新进程（绝对路径，不依赖 PATH；禁用 npx/npm exec 方式——会卡交互提示）
  nohup "$DSH" web > /tmp/dsh-web.log 2>&1 &

  # 4. 等健康（最多 60 秒，200 即成功）
  code=""
  for _ in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null)
    [ "$code" = "200" ] && break
    sleep 2
  done

  echo "new listener: $(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')"
  echo "final http_code: ${code:-none}"
  echo "=== restart end ==="
} >> "$LOG" 2>&1
