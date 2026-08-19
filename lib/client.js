window.__ModuleLoader__.load({
  id: "dsh-hud",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    // ─────────────────────────────────────────────────────────────
    // 模块级共享状态：按钮（写开合）与面板（读开合 + 数据）跨组件同步。
    // 不可变快照 + useSyncExternalStore：每次变更产生新对象，React 可靠重渲染。
    // ─────────────────────────────────────────────────────────────
    let snapshot = { open: false, data: null, error: null, sessionId: null, plan: null, tokenUsage: null, sessionStats: null, modelUsage: null };
    const listeners = new Set();
    function getSnapshot() { return snapshot; }
    function subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
    function emit(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    }

    const inject = ["slots", "timer"];
    // 轮询间隔（2026-08-18）：面板打开 10s 全量 / 关闭 15s 轻量计数（1 次 shell，便宜）。
    // 性能优先的简单实现：平时只跑计数，计数变化才补一次全量；窗口聚焦即时刷新。
    const REFRESH_MS_OPEN = 10000;
    const REFRESH_MS_CLOSED = 15000;
    // client 侧节流：同类请求最小间隔（ms），防轮询/点击风暴高频触发 host git 子进程
    const FETCH_MIN_INTERVAL_MS = 300;
    const lastFetchAt = { light: 0, full: 0 };
    // 进行中标记：面板打开瞬间的双 full fetch 合并入口（同一会话的 full 拉取在途时跳过第二次）
    let fullFetchInFlight = null; // 在途 full 拉取的 sessionId
    const WIDTH_MIN = 200;
    const WIDTH_MAX = 480;
    const WIDTH_DEFAULT = 240;

    function apply(ctx) {
      // 主题修复：把插件里使用的、DSH 主题不存在的变量名映射到真实 token，
      // 让 HUD 面板跟随深色/浅色主题（否则全部回退硬编码浅色）。
      if (!document.getElementById("dsh-hud-theme-fix")) {
        const style = document.createElement("style");
        style.id = "dsh-hud-theme-fix";
        style.textContent = [
          "body {",
          "  --dsw-alias-bg-elevated: var(--dsw-alias-bg-overlay);",
          "  --dsw-alias-text-primary: var(--dsw-alias-label-primary);",
          "  --dsw-alias-text-secondary: var(--dsw-alias-label-secondary);",
          "  --dsw-alias-text-tertiary: var(--dsw-alias-label-tertiary);",
          "  --dsw-alias-border-strong: var(--dsw-alias-border-l2);",
          "  --dsw-alias-border-weak: var(--dsw-alias-border-l1);",
          "}",
          // 官方 dsw 风格开关按钮（2026-08-18，对齐 plan-switch 样板）：28px 图标按钮
          ".dsh-hud-toggle-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;padding:0;position:relative;}",
          ".dsh-hud-toggle-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));}",
          // 面板打开：黄色系高亮（沿用 warn 语义）
          ".dsh-hud-toggle-btn.is-open{background:var(--dsw-alias-state-warn-tertiary,rgba(255,180,0,0.15));color:var(--dsw-alias-state-warn-label,#b8860b);}",
          // 未提交数角标
          ".dsh-hud-badge{position:absolute;top:-2px;right:-2px;min-width:14px;height:14px;border-radius:7px;background:var(--dsw-alias-state-warn-primary,#e8a13a);color:#fff;font-size:10px;line-height:14px;text-align:center;padding:0 3px;box-sizing:border-box;pointer-events:none;}",
        ].join("\n");
        document.head.appendChild(style);
      }
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      const timer = ctx.get("timer");

      // light 轮询上次未提交总数（变化检测：变了立即补 full）
      let lastLightCount = -1;
      // 各仓库上次未提交数（变化自动展开用）
      const lastRepoCounts = {};
      // 关注仓库列表（localStorage 持久化，逗号分隔路径）：请求时携带，host 聚合显示
      const readExtraRepos = () => {
        try {
          const raw = window.localStorage.getItem("dsh-hud-repos");
          return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean).join(",") : "";
        } catch (error) { return ""; }
      };
      // 数据拉取：light 模式只取 git（按钮角标用，省去 MCP/skills 开销）
      async function fetchHud(sessionId, light) {
        if (typeof sessionId !== "string") return;
        const kind = light ? "light" : "full";
        // 节流：同类请求 300ms 窗口内只发一次（防轮询/点击风暴高频触发 host git 子进程）
        const now = Date.now();
        if (now - lastFetchAt[kind] < FETCH_MIN_INTERVAL_MS) return;
        // 进行中标记：面板打开瞬间的双 full fetch 合并入口，同一会话的 full 拉取在途时跳过
        if (!light && fullFetchInFlight === sessionId) return;
        lastFetchAt[kind] = now;
        if (!light) fullFetchInFlight = sessionId;
        try {
          const repos = readExtraRepos();
          const query = "session=" + encodeURIComponent(sessionId) + (light ? "&light=1" : "") + (repos !== "" ? "&repos=" + encodeURIComponent(repos) : "");
          const res = await fetch("/api/dsh-hud?" + query, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          // session 切换竞态：响应落地时当前会话已切换（snapshot.sessionId 由按钮组件随 current 更新），丢弃过期数据
          if (snapshot.sessionId !== sessionId) return;
          // 状态变化自动刷新：light 轮询发现未提交总数变化 → 立即补一次 full（面板数据保持最新）
          if (light) {
            const total = Array.isArray(data && data.count)
              ? data.count.reduce(function (n, r) { return n + (r && r.count ? r.count : 0) }, 0)
              : 0;
            if (lastLightCount >= 0 && total !== lastLightCount) fetchHud(sessionId, false);
            lastLightCount = total;
          } else {
            // 变化自动展开（2026-08-18）：full 落地时，未提交数与上次不同的仓库自动展开
            const repos = Array.isArray(data && data.git && data.git.repos) ? data.git.repos : [];
            const next = {};
            let changed = false;
            for (const r of repos) {
              const n = Array.isArray(r.files) ? r.files.length : 0;
              const prev = lastRepoCounts[r.name];
              if (prev !== undefined && prev !== n && n > 0) { next[r.name] = false; changed = true; }
              lastRepoCounts[r.name] = n;
            }
            if (changed) setCollapsed(function (old) { return { ...old, ...next } });
          }
          emit({ data, error: null, sessionId });
        } catch (error) {
          if (snapshot.sessionId !== sessionId) return;
          emit({ error: error instanceof Error ? error.message : String(error), data: null });
        } finally {
          if (!light && fullFetchInFlight === sessionId) fullFetchInFlight = null;
        }
      }

      async function fetchDiff(sessionId, path) {
        const query = "session=" + encodeURIComponent(sessionId) + "&path=" + encodeURIComponent(path);
        // host 侧有 200ms diff 节流：快速连点两个文件可能撞窗口，等窗口过再重试一次
        for (let attempt = 0; ; attempt++) {
          const res = await fetch("/api/dsh-hud/diff?" + query, { cache: "no-store" });
          if (res.status === 429 && attempt === 0) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          return data && data.diff ? data.diff : "(无 diff)";
        }
      }

      function relTime(epochSec) {
        const s = Math.floor(Date.now() / 1000) - epochSec;
        if (s < 60) return s + "秒前";
        if (s < 3600) return Math.floor(s / 60) + "分钟前";
        if (s < 86400) return Math.floor(s / 3600) + "小时前";
        return Math.floor(s / 86400) + "天前";
      }

      function fmtTokens(n) {
        if (typeof n !== "number" || Number.isNaN(n)) return "--";
        if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
        if (n >= 1000) return (n / 1000).toFixed(1) + "k";
        return String(n);
      }

      // 耗时格式：<1min → "12.3s"；<1h → "2m 5s"；≥1h → "1h 2m"
      function fmtDuration(ms) {
        if (typeof ms !== "number" || Number.isNaN(ms) || ms <= 0) return null;
        const s = ms / 1000;
        if (s < 60) return (Math.round(s * 10) / 10) + "s";
        const whole = Math.round(s);
        if (whole < 3600) return Math.floor(whole / 60) + "m " + (whole % 60) + "s";
        return Math.floor(whole / 3600) + "h " + Math.floor((whole % 3600) / 60) + "m";
      }

      // ── 输入框工具行按钮：📊 + 未提交文件数角标 ─────────────────
      slots.inject("conversation.input.left", () => slots.register(
        { name: "conversation.input.left", id: "dsh-hud-toggle" },
        (props) => {
          const snap = react.useSyncExternalStore(subscribe, getSnapshot);
          const useSessions = props.useSessions;
          const current = typeof useSessions === "function" ? useSessions((s) => s && s.current) : undefined;
          const sessionId = props.sessionId;

          // 订阅官方投影（session 级 seat 才有 useProjection）：plan / token 用量 / 会话统计 / 上下文占用 / 分模型用量
          const useProjection = props.useProjection;
          const planProj = typeof useProjection === "function" ? useProjection("plan") : undefined;
          const tokenProj = typeof useProjection === "function" ? useProjection("tokenUsage") : undefined;
          const statsProj = typeof useProjection === "function" ? useProjection("sessionStats") : undefined;
          const pressureProj = typeof useProjection === "function" ? useProjection("contextPressure") : undefined;
          const modelUsageProj = typeof useProjection === "function" ? useProjection("perModelUsage") : undefined;

          // 投影变化 → 提取标量 → 同步到共享状态（面板显示用）
          react.useEffect(() => {
            const planBrief = planProj && typeof planProj === "object"
              ? { active: planProj.active === true, pending: planProj.pending === true }
              : null;
            const tokenBrief = tokenProj && typeof tokenProj === "object"
              ? (function () {
                  const uncached = typeof tokenProj.uncachedInputTokens === "number" ? tokenProj.uncachedInputTokens : 0;
                  const cacheRead = typeof tokenProj.cacheReadTokens === "number" ? tokenProj.cacheReadTokens : 0;
                  const cacheWrite = typeof tokenProj.cacheWriteTokens === "number" ? tokenProj.cacheWriteTokens : 0;
                  const billed = uncached + cacheRead + cacheWrite;
                  return {
                    input: billed,
                    output: typeof tokenProj.outputTokens === "number" ? tokenProj.outputTokens : 0,
                    cacheHit: billed > 0 ? Math.round(cacheRead / billed * 100) : null,
                  };
                })()
              : null;
            const statsBrief = statsProj && typeof statsProj === "object"
              ? {
                  turns: typeof statsProj.turns === "number" ? statsProj.turns : 0,
                  steps: typeof statsProj.steps === "number" ? statsProj.steps : 0,
                  llmMs: typeof statsProj.llmMs === "number" ? statsProj.llmMs : 0,
                  toolMs: typeof statsProj.toolMs === "number" ? statsProj.toolMs : 0,
                  decodeMs: typeof statsProj.decodeMs === "number" ? statsProj.decodeMs : 0,
                  decodeTokens: typeof statsProj.decodeTokens === "number" ? statsProj.decodeTokens : 0,
                  contextPercent: (function () {
                    const used = pressureProj && (typeof pressureProj.projectedTokens === "number"
                      ? pressureProj.projectedTokens
                      : pressureProj.pressureTokens);
                    const window = pressureProj && pressureProj.contextWindow;
                    if (typeof used !== "number" || typeof window !== "number" || window <= 0) return null;
                    return Math.min(100, Math.round(used / window * 100));
                  })(),
                }
              : null;
            emit({ plan: planBrief, tokenUsage: tokenBrief, sessionStats: statsBrief, modelUsage: modelUsageProj && typeof modelUsageProj === "object" ? modelUsageProj : null });
          }, [planProj, tokenProj, statsProj, pressureProj, modelUsageProj]);

          // 记录当前会话到共享状态：fetchHud 落地前据此丢弃过期响应（session 切换竞态修复）
          react.useEffect(() => {
            if (typeof current === "string") emit({ sessionId: current });
          }, [current]);

          // 面板关闭时轻量轮询 git 数字（按钮角标常驻可见）
          react.useEffect(() => {
            if (snap.open || typeof current !== "string") return;
            fetchHud(current, true);
            if (timer !== undefined) return timer.interval(() => fetchHud(current, true), REFRESH_MS_CLOSED);
          }, [snap.open, current]);

          const git = snap.data && snap.data.git;
          // 角标计数：light 数据（count 数组）优先，full 数据按多仓库聚合
          const lightCount = snap.data && Array.isArray(snap.data.count)
            ? snap.data.count.reduce(function (n, r) { return n + (r && r.count ? r.count : 0) }, 0)
            : undefined;
          const count = lightCount !== undefined ? lightCount
            : (git
              ? (Array.isArray(git.repos)
                ? git.repos.reduce(function (n, r) { return n + (Array.isArray(r.files) ? r.files.length : 0) }, 0)
                : (Array.isArray(git.files) ? git.files.length : 0))
              : 0);

          const toggle = () => {
            const next = !snap.open;
            emit({ open: next });
            if (next) fetchHud(sessionId, false);
          };

          // 仪表盘图标（线性风格，对齐官方 Icon 体系）：速度表 = 状态总览
          const hudIcon = react.createElement("svg", {
            width: 14,
            height: 14,
            viewBox: "0 0 16 16",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.5,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            style: { flex: "none", display: "block" },
          },
            react.createElement("path", { d: "M13.5 9.5a5.5 5.5 0 1 0-11 0" }),
            react.createElement("path", { d: "M8 9.5l3.2-3.2" }),
            react.createElement("circle", { cx: 8, cy: 9.5, r: 1, fill: "currentColor", stroke: "none" })
          );

          return react.createElement("button", {
            type: "button",
            className: "dsh-hud-toggle-btn" + (snap.open ? " is-open" : ""),
            onClick: toggle,
            title: snap.open ? "关闭 HUD 面板" : "HUD：Git 状态 / MCP / 技能" + (count > 0 ? "（" + count + " 个文件未提交）" : ""),
            "aria-label": "HUD 状态面板",
          },
            hudIcon,
            count > 0 ? react.createElement("span", { className: "dsh-hud-badge" }, String(count)) : null
          );
        }
      ));

      // ── 右侧浮层面板：Git / MCP / Skills ───────────────────────
      slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "dsh-hud-panel" },
        (props) => {
          // 所有 hooks 必须在条件 return 之前声明（React 规则）
          const [expanded, setExpanded] = react.useState({});
          const [diffs, setDiffs] = react.useState({});
          // 各小节收拢状态
          const [collapsed, setCollapsed] = react.useState({});
          // 面板宽度：默认 240，拖左侧把手调整（200-480），localStorage 记住
          const [width, setWidth] = react.useState(() => {
            try {
              const raw = window.localStorage.getItem("dsh-hud-width");
              const n = raw ? Number(raw) : NaN;
              if (!Number.isNaN(n) && n >= WIDTH_MIN && n <= WIDTH_MAX) return n;
            } catch (error) { /* ignore */ }
            return WIDTH_DEFAULT;
          });
          const resize = react.useRef(null);
          // 输入区（官方 composer seat）实测高度：面板上限 = 视口 − 顶部 64 − 输入区 − 16 余量，
          // 输入框多高（含多行输入/附件展开）面板就自动停在哪，永不遮挡对话栏
          const [composerH, setComposerH] = react.useState(152);
          const snap = react.useSyncExternalStore(subscribe, getSnapshot);
          const useSessions = props.useSessions;
          const current = typeof useSessions === "function" ? useSessions((s) => s && s.current) : undefined;

          react.useEffect(() => {
            const onMove = (event) => {
              const r = resize.current;
              if (r === null) return;
              const next = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, r.startWidth - (event.clientX - r.startX)));
              setWidth(next);
            };
            const onUp = () => {
              if (resize.current === null) return;
              resize.current = null;
              try { window.localStorage.setItem("dsh-hud-width", String(width)); } catch (error) { /* ignore */ }
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
            return () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
          }, [width]);

          react.useEffect(() => {
            if (!snap.open) return;
            fetchHud(current, false);
            if (timer !== undefined) return timer.interval(() => fetchHud(current, false), REFRESH_MS_OPEN);
          }, [snap.open, current]);

          // 窗口聚焦/切回 → 立即刷新（改完文件切回浏览器马上看到，不必等轮询）
          react.useEffect(() => {
            if (typeof current !== "string") return;
            const onVisible = () => {
              if (document.visibilityState !== "visible") return;
              fetchHud(current, !snap.open);
            };
            window.addEventListener("focus", onVisible);
            document.addEventListener("visibilitychange", onVisible);
            return () => {
              window.removeEventListener("focus", onVisible);
              document.removeEventListener("visibilitychange", onVisible);
            };
          }, [snap.open, current]);

          // 追踪输入区高度：打开面板时测量一次并挂 ResizeObserver（输入变多行/附件展开时跟随）
          react.useEffect(() => {
            if (!snap.open) return;
            const seat = typeof document !== "undefined" ? document.querySelector("[data-composer-seat]") : null;
            if (seat === null) return;
            const update = () => setComposerH(seat.offsetHeight > 0 ? seat.offsetHeight : 152);
            update();
            if (typeof ResizeObserver === "undefined") return;
            const ro = new ResizeObserver(update);
            ro.observe(seat);
            return () => ro.disconnect();
          }, [snap.open]);

          if (!snap.open) return null;

          const startResize = (event) => {
            resize.current = { startX: event.clientX, startWidth: width };
            event.preventDefault();
          };

          const git = snap.data && snap.data.git;
          const mcp = snap.data && Array.isArray(snap.data.mcp) ? snap.data.mcp : [];
          const skills = snap.data && Array.isArray(snap.data.skills) ? snap.data.skills : [];
          const model = snap.data && snap.data.model;
          const modelName = model && model.model
            ? model.model.replace("deepseek-v4-", "") + (model.reasoningEffort ? " · " + model.reasoningEffort : "")
            : "—";
          const tokenUsage = snap.tokenUsage;
          const sessionStats = snap.sessionStats;
          const modelUsage = snap.modelUsage;
          const balance = snap.data && snap.data.balance;
          const stamp = new Date().toLocaleTimeString();
          const error = snap.error;
          const close = () => emit({ open: false });

          // 可收拢小节：标题行（箭头 + 标题 + 计数），点击折叠/展开
          const section = (key, title, count, content) => {
            const isCollapsed = collapsed[key] === true;
            const toggle = () => setCollapsed({ ...collapsed, [key]: !isCollapsed });
            return react.createElement("div", { key: "sec-" + key },
              react.createElement("div", {
                onClick: toggle,
                title: isCollapsed ? "展开" : "收起",
                style: {
                  display: "flex", alignItems: "center", gap: "5px",
                  margin: "10px 0 5px", cursor: "pointer", userSelect: "none",
                },
              },
                react.createElement("span", { style: { fontSize: "10px", color: "var(--dsw-alias-text-tertiary, #999)", width: "12px", flexShrink: 0 } }, isCollapsed ? "▸" : "▾"),
                react.createElement("span", {
                  style: {
                    fontSize: "11px", fontWeight: 600,
                    color: "var(--dsw-alias-text-tertiary, #999)",
                    textTransform: "uppercase", letterSpacing: "0.4px",
                  },
                }, title),
                count !== null
                  ? react.createElement("span", {
                      style: {
                        fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-text-tertiary, #999)",
                        background: "rgba(128,128,128,0.15)", borderRadius: "8px", padding: "0 6px",
                      },
                    }, String(count))
                  : null
              ),
              isCollapsed ? null : content
            );
          };

          const statusColor = (status) => {
            if (status === "??") return "var(--dsw-alias-label-tertiary)";
            if (status === "A") return "var(--dsw-alias-state-success-primary)";
            if (status === "D" || status === "U") return "var(--dsw-alias-state-error-primary)";
            if (status === "R") return "var(--dsw-alias-state-business-primary)";
            return "var(--dsw-alias-state-warn-primary)";
          };

          const refresh = () => fetchHud(current, false);
          // 关注仓库输入状态（localStorage 持久化）
          const [extraReposInput, setExtraReposInput] = react.useState(readExtraRepos);
          const saveExtraRepos = () => {
            try { window.localStorage.setItem("dsh-hud-repos", extraReposInput); } catch (error) { /* ignore */ }
            fetchHud(current, false);
          };

          const toggleDiff = (path) => {
            const isOpen = expanded[path] === true;
            if (isOpen) {
              const next = { ...expanded };
              delete next[path];
              setExpanded(next);
              return;
            }
            setExpanded({ ...expanded, [path]: true });
            if (diffs[path] === undefined && typeof current === "string") {
              fetchDiff(current, path).then((text) => {
                setDiffs((prev) => ({ ...prev, [path]: text }));
              }).catch((err) => {
                setDiffs((prev) => ({ ...prev, [path]: "⚠ " + (err instanceof Error ? err.message : String(err)) }));
              });
            }
          };

          const renderFileRow = (file, clickable = true) => {
            const summary = file.new
              ? react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", marginLeft: "auto", flexShrink: 0 } }, "new")
              : file.add + file.del > 0
                ? react.createElement("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: "10px" } },
                    react.createElement("span", { style: { color: "var(--dsw-alias-state-success-primary)" } }, "+" + file.add),
                    " ",
                    react.createElement("span", { style: { color: "var(--dsw-alias-state-error-primary)" } }, "-" + file.del)
                  )
                : null;
            const isOpen = expanded[file.path] === true;
            return react.createElement("div", { key: file.path },
              react.createElement("div", {
                onClick: clickable ? () => toggleDiff(file.path) : undefined,
                title: file.untracked ? "未跟踪文件" : (clickable ? "点击查看 diff" : ""),
                style: {
                  display: "flex", gap: "6px", fontSize: "11px", lineHeight: "20px",
                  whiteSpace: "nowrap", cursor: clickable && !file.untracked ? "pointer" : "default",
                },
              },
                react.createElement("span", { style: { color: statusColor(file.status), width: "20px", flexShrink: 0 } }, file.status),
                react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, file.path),
                summary
              ),
              isOpen && !file.untracked
                ? react.createElement("pre", {
                    style: {
                      whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "10px", lineHeight: "15px",
                      background: "var(--dsw-alias-bg-inset, #f6f8fa)", padding: "6px 8px", borderRadius: "6px",
                      margin: "2px 0 4px", maxHeight: "180px", overflowY: "auto",
                      color: "var(--dsw-alias-text-primary, #1f2328)",
                    },
                  },
                    diffs[file.path] === undefined ? "加载中…" : diffs[file.path]
                  )
                : null
            );
          };

          const files = git && Array.isArray(git.files) ? git.files : [];
          const unstaged = files.filter((f) => f.unstaged === true);
          const staged = files.filter((f) => f.staged === true);
          const untracked = files.filter((f) => f.untracked === true);
          const commits = git && Array.isArray(git.commits) ? git.commits : [];

          // 文件分组（未暂存/已暂存/未跟踪）：标题可折叠
          const group = (title, key, list, clickable = true) => list.length === 0
            ? null
            : (function () {
                const gkey = "g-" + key;
                const isCollapsed = collapsed[gkey] === true;
                const toggle = () => setCollapsed({ ...collapsed, [gkey]: !isCollapsed });
                return react.createElement("div", { key: gkey },
                  react.createElement("div", {
                    onClick: toggle,
                    title: isCollapsed ? "展开" : "收起",
                    style: {
                      display: "flex", alignItems: "center", gap: "4px",
                      fontSize: "10px", color: "var(--dsw-alias-text-tertiary, #999)",
                      margin: "6px 0 2px", cursor: "pointer", userSelect: "none",
                    },
                  },
                    react.createElement("span", { style: { width: "10px", flexShrink: 0 } }, isCollapsed ? "▸" : "▾"),
                    title + " (" + list.length + ")"
                  ),
                  isCollapsed ? null : list.map((f) => renderFileRow(f, clickable))
                );
              })();

          return react.createElement("div", {
            style: {
              // 高度随内容自适应；上限 = 视口 − 顶部 64 − 输入区实测高度 − 16 余量，
              // 输入区多高（含多行输入/附件展开）面板就停在哪，内容再长也盖不到对话栏
              // 面板皮肤对齐官方浮层（sidebar-fill = 官方侧边栏/浮层面板同款填充，深浅主题自动切换）
              position: "fixed", top: "64px", right: "12px", width: width + "px",
              maxHeight: "calc(100vh - 64px - " + composerH + "px - 16px)", overflowY: "auto",
              background: "var(--dsw-specific-sidebar-fill)",
              color: "var(--dsw-alias-label-primary)",
              border: "1px solid var(--dsw-alias-border-l1)",
              borderRadius: "10px",
              boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
              padding: "10px 12px", boxSizing: "border-box", pointerEvents: "auto", zIndex: 100,
            },
          },
            // 左侧宽度拖拽把手
            react.createElement("div", {
              onMouseDown: startResize,
              title: "拖动调整宽度",
              style: {
                position: "absolute", left: "-4px", top: "0", bottom: "0", width: "8px",
                cursor: "ew-resize", borderRadius: "4px",
              },
            }),
            react.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" } },
              react.createElement("span", { style: { fontSize: "13px", fontWeight: 600 } }, "HUD"),
              react.createElement("button", {
                type: "button", onClick: close, title: "关闭",
                style: { border: "none", background: "transparent", color: "var(--dsw-alias-text-secondary, #666)", cursor: "pointer", fontSize: "15px", lineHeight: "18px", padding: "0 4px" },
              }, "✕")
            ),

            // ── 状态行：当前模型 + plan 状态 ──
            react.createElement("div", {
              style: {
                display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
                fontSize: "11px", color: "var(--dsw-alias-text-secondary, #666)",
                marginTop: "6px", paddingBottom: "6px",
                borderBottom: "1px solid var(--dsw-alias-border-weak, rgba(0,0,0,0.06))",
              },
            },
              react.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "3px" } },
                "⚙", modelName),
              // 官方余额（自动拉取；数据未到/失败/无凭据显示 --）
              // 注意：snap.data 未加载时 balance 是 undefined，必须用 != null 宽松判断
              react.createElement("span", {
                title: balance != null
                  ? "官方余额 · 含赠金 ¥" + balance.granted + " · 充值 ¥" + balance.toppedUp
                  : "余额不可用（无 DEEPSEEK_API_KEY 凭据或网络失败）",
                style: { display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--dsw-alias-state-success-primary)" },
              },
                "💰", balance != null
                  ? (balance.currency === "CNY" ? "¥" : balance.currency + " ") + balance.total.toFixed(2)
                  : "--"),
              snap.plan && snap.plan.active
                ? react.createElement("span", {
                    style: {
                      display: "inline-flex", alignItems: "center", gap: "3px",
                      background: "var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.15))",
                      color: "var(--dsw-alias-state-warn-label, #b8860b)",
                      borderRadius: "999px", padding: "0 8px", fontSize: "10px", lineHeight: "16px",
                    },
                  }, "📋 Plan 开")
                : null
            ),

            // ── 用量段：token + 会话统计（两个子节点须包进 Fragment，
            //    section 帮手只收一个 content 参数，多余实参会静默丢失）──
            tokenUsage !== null || sessionStats !== null
              ? section("usage", "用量", null,
                  react.createElement(react.Fragment, null,
                    tokenUsage !== null
                      ? react.createElement("div", { style: { fontSize: "11px", lineHeight: "18px" } },
                          react.createElement("span", { style: { color: "var(--dsw-alias-state-business-primary)" } }, "↑ " + fmtTokens(tokenUsage.input)),
                          "  ",
                          react.createElement("span", { style: { color: "var(--dsw-alias-label-primary-bluish)" } }, "↓ " + fmtTokens(tokenUsage.output)),
                          tokenUsage.cacheHit !== null
                            ? react.createElement("span", { style: { color: "var(--dsw-alias-state-success-primary)", marginLeft: "5px" } }, "缓存 " + tokenUsage.cacheHit + "%")
                            : null
                        )
                      : null,
                    sessionStats !== null
                      ? react.createElement("div", { style: { fontSize: "11px", lineHeight: "18px", color: "var(--dsw-alias-text-secondary, #666)" } },
                          sessionStats.turns > 0 || sessionStats.steps > 0
                            ? sessionStats.turns + " 轮 · " + sessionStats.steps + " 步"
                            : null,
                          fmtDuration(sessionStats.llmMs)
                            ? react.createElement("span", null, " · LLM " + fmtDuration(sessionStats.llmMs))
                            : null,
                          fmtDuration(sessionStats.toolMs)
                            ? react.createElement("span", null, " · 工具 " + fmtDuration(sessionStats.toolMs))
                            : null,
                          sessionStats.decodeMs > 0 && sessionStats.decodeTokens > 0
                            ? react.createElement("span", null, " · " + Math.round(sessionStats.decodeTokens / (sessionStats.decodeMs / 1000)) + " tok/s")
                            : null,
                          sessionStats.contextPercent !== null
                            ? react.createElement("span", { style: { color: sessionStats.contextPercent > 80 ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)" } }, " · ctx " + sessionStats.contextPercent + "%")
                            : null
                        )
                      : null
                  )
                )
              : null,

            // ── 分模型用量：本会话各模型的 token 明细（flash/pro 切换后都保留）──
            modelUsage && Array.isArray(modelUsage.models) && modelUsage.models.length > 0
              ? section("models", "分模型", modelUsage.models.length,
                  react.createElement("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
                    modelUsage.models.map((m, index) => react.createElement("li", {
                      key: index,
                      style: { fontSize: "11px", lineHeight: "19px", display: "flex", gap: "6px", alignItems: "baseline" },
                    },
                      react.createElement("span", { style: { color: "var(--dsw-alias-state-business-primary)", flexShrink: 0 } },
                        (typeof m.model === "string" ? m.model : "unknown").replace("deepseek-v4-", "")),
                      react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", flexShrink: 0, fontSize: "10px" } },
                        (typeof m.requests === "number" ? m.requests : 0) + " 次"),
                      react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } },
                        "↑ " + fmtTokens((m.uncachedInput || 0) + (m.cacheRead || 0)) +
                        " ↓ " + fmtTokens(m.output || 0) +
                        (typeof m.cacheHitPct === "number" ? " · 缓存 " + m.cacheHitPct + "%" : ""))
                    ))
                  )
                )
              : null,

            git === null
              ? react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginTop: "6px" } }, "⎇ 不是 Git 仓库")
              : git === undefined
                ? react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)", marginTop: "6px" } }, "⎇ Git 状态不可用")
                : (function () {
                    // 多仓库聚合（2026-08-18）：repos 数组存在时每仓库一个折叠条目，
                    // 当前激活仓库默认展开、其余收起；文件行仅在当前仓库可点 diff
                    const repos = Array.isArray(git.repos) && git.repos.length > 0 ? git.repos : null;
                    const totalCount = repos
                      ? repos.reduce(function (n, r) { return n + (Array.isArray(r.files) ? r.files.length : 0) }, 0)
                      : git.files.length;
                    const repoBody = (repo, clickable) => {
                      const uf = (repo.files || []).filter((f) => f.unstaged && !f.untracked);
                      const sf = (repo.files || []).filter((f) => f.staged);
                      const tf = (repo.files || []).filter((f) => f.untracked);
                      const cmts = Array.isArray(repo.commits) ? repo.commits : [];
                      return react.createElement("div", null,
                        react.createElement("div", { style: { fontSize: "12px", fontWeight: 500 } },
                          "⎇ " + (repo.name !== undefined ? repo.name + " · " : "") + repo.branch,
                          (repo.ahead > 0 || repo.behind > 0)
                            ? react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontWeight: 400, marginLeft: "5px" } }, "↑" + repo.ahead + " ↓" + repo.behind)
                            : null,
                          (repo.files || []).length > 0
                            ? react.createElement("span", { style: { color: "var(--dsw-alias-state-warn-primary)", marginLeft: "5px" } }, (repo.files || []).length + " 个未提交")
                            : react.createElement("span", { style: { color: "var(--dsw-alias-state-success-primary)", marginLeft: "5px" } }, "干净")
                        ),
                        group("未暂存", "unstaged", uf, clickable),
                        group("已暂存", "staged", sf, clickable),
                        group("未跟踪", "untracked", tf, clickable),
                        cmts.length > 0
                          ? section("commits", "提交", cmts.length,
                              react.createElement("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
                                cmts.map((c, index) => react.createElement("li", {
                                  key: index,
                                  style: { fontSize: "11px", lineHeight: "19px", display: "flex", gap: "6px", alignItems: "baseline" },
                                },
                                  react.createElement("span", { style: { color: "var(--dsw-alias-state-business-primary)", flexShrink: 0, fontFamily: "monospace" } }, c.hash),
                                  react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } }, c.subject),
                                  react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", flexShrink: 0, fontSize: "10px" } }, relTime(c.time))
                                ))
                              )
                            )
                          : null
                      );
                    };
                    if (repos === null) return section("git", "Git", totalCount, repoBody(git, true));
                    return section("git", "Git", totalCount,
                      react.createElement("div", null,
                        repos.map((repo) => {
                          const rkey = "repo-" + repo.name;
                          const isCollapsed = collapsed[rkey] === undefined ? !repo.active : collapsed[rkey] === true;
                          const toggle = () => setCollapsed({ ...collapsed, [rkey]: !isCollapsed });
                          return react.createElement("div", { key: rkey },
                            react.createElement("div", {
                              onClick: toggle,
                              title: isCollapsed ? "展开" : "收起",
                              style: {
                                display: "flex", alignItems: "center", gap: "5px",
                                margin: "4px 0 2px", cursor: "pointer", userSelect: "none",
                                fontSize: "11px",
                              },
                            },
                              react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", width: "12px", flexShrink: 0 } }, isCollapsed ? "▸" : "▾"),
                              react.createElement("span", { style: { fontWeight: repo.active ? 600 : 400, color: repo.active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)" } },
                                repo.name + (repo.active ? " ●" : "")
                              ),
                              react.createElement("span", { style: { marginLeft: "auto", color: (repo.files || []).length > 0 ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-success-primary)", flexShrink: 0 } },
                                (repo.files || []).length > 0 ? (repo.files || []).length + " ⚑" : "✓"
                              )
                            ),
                            isCollapsed ? null : repoBody(repo, repo.active)
                          );
                        })
                      )
                    );
                  })(),

            section("mcp", "MCP", mcp.length,
              mcp.length === 0
                ? react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" } }, "未挂载 MCP 服务器")
                : react.createElement("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
                    mcp.map((server, index) => react.createElement("li", {
                      key: index, style: { fontSize: "12px", lineHeight: "21px", display: "flex", alignItems: "center", gap: "5px" },
                    },
                      react.createElement("span", { style: { color: "var(--dsw-alias-state-business-primary)" } }, "🔌"),
                      server
                    ))
                  )
            ),

            section("skills", "Skills", skills.length,
              skills.length === 0
                ? react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" } }, "无可用技能")
                : react.createElement("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
                    skills.map((name, index) => react.createElement("li", {
                      key: index, style: { fontSize: "12px", lineHeight: "21px", display: "flex", alignItems: "center", gap: "5px" },
                    },
                      react.createElement("span", { style: { color: "var(--dsw-alias-label-primary-bluish)" } }, "📚"),
                      name
                    ))
                  )
            ),

            // ── 关注仓库设置（localStorage 持久化）：跨目录仓库聚合显示 ──
            react.createElement("div", { style: { marginTop: "10px", paddingTop: "7px", borderTop: "1px solid var(--dsw-alias-border-weak, rgba(0,0,0,0.06))" } },
              react.createElement("div", { style: { fontSize: "10px", color: "var(--dsw-alias-text-tertiary, #999)", marginBottom: "4px" } }, "关注仓库（逗号分隔的绝对路径，跨目录 git 一起显示）"),
              react.createElement("div", { style: { display: "flex", gap: "4px" } },
                react.createElement("input", {
                  type: "text", value: extraReposInput, placeholder: "如 /Users/me/projects/other",
                  onChange: (e) => setExtraReposInput(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") saveExtraRepos(); },
                  style: { flex: 1, minWidth: 0, background: "transparent", border: "1px solid var(--dsw-alias-border-strong, rgba(0,0,0,0.12))", color: "var(--dsw-alias-label-primary)", borderRadius: "5px", fontSize: "11px", padding: "2px 6px", boxSizing: "border-box" },
                }),
                react.createElement("button", {
                  type: "button", onClick: saveExtraRepos, title: "保存并刷新",
                  style: { border: "1px solid var(--dsw-alias-border-strong, rgba(0,0,0,0.12))", background: "transparent", color: "var(--dsw-alias-text-secondary, #666)", borderRadius: "5px", cursor: "pointer", fontSize: "11px", padding: "1px 8px", flexShrink: 0 },
                }, "保存")
              )
            ),

            react.createElement("div", {
              style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "10px", paddingTop: "7px", borderTop: "1px solid var(--dsw-alias-border-weak, rgba(0,0,0,0.06))" },
            },
              react.createElement("span", { style: { fontSize: "10px", color: "var(--dsw-alias-text-tertiary, #999)" } },
                error !== null ? "⚠ " + error : "更新于 " + stamp),
              react.createElement("button", {
                type: "button", onClick: refresh, title: "立即刷新",
                style: { border: "1px solid var(--dsw-alias-border-strong, rgba(0,0,0,0.12))", background: "transparent", color: "var(--dsw-alias-text-secondary, #666)", borderRadius: "5px", cursor: "pointer", fontSize: "11px", padding: "1px 8px" },
              }, "刷新")
            )
          );
        }
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
