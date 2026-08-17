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
    let snapshot = { open: false, data: null, error: null, sessionId: null, plan: null, tokenUsage: null, sessionStats: null };
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
    const REFRESH_MS = 30000;
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
        ].join("\n");
        document.head.appendChild(style);
      }
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      const timer = ctx.get("timer");

      // 数据拉取：light 模式只取 git（按钮角标用，省去 MCP/skills 开销）
      async function fetchHud(sessionId, light) {
        if (typeof sessionId !== "string") return;
        try {
          const query = "session=" + encodeURIComponent(sessionId) + (light ? "&light=1" : "");
          const res = await fetch("/api/dsh-hud?" + query, { cache: "no-store" });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          emit({ data, error: null, sessionId });
        } catch (error) {
          emit({ error: error instanceof Error ? error.message : String(error), data: null });
        }
      }

      async function fetchDiff(sessionId, path) {
        const query = "session=" + encodeURIComponent(sessionId) + "&path=" + encodeURIComponent(path);
        const res = await fetch("/api/dsh-hud/diff?" + query, { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        return data && data.diff ? data.diff : "(无 diff)";
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

          // 订阅官方投影（session 级 seat 才有 useProjection）：plan / token 用量 / 会话统计 / 上下文占用
          const useProjection = props.useProjection;
          const planProj = typeof useProjection === "function" ? useProjection("plan") : undefined;
          const tokenProj = typeof useProjection === "function" ? useProjection("tokenUsage") : undefined;
          const statsProj = typeof useProjection === "function" ? useProjection("sessionStats") : undefined;
          const pressureProj = typeof useProjection === "function" ? useProjection("contextPressure") : undefined;

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
            emit({ plan: planBrief, tokenUsage: tokenBrief, sessionStats: statsBrief });
          }, [planProj, tokenProj, statsProj, pressureProj]);

          // 面板关闭时轻量轮询 git 数字（按钮角标常驻可见）
          react.useEffect(() => {
            if (snap.open || typeof current !== "string") return;
            fetchHud(current, true);
            if (timer !== undefined) return timer.interval(() => fetchHud(current, true), REFRESH_MS);
          }, [snap.open, current]);

          const git = snap.data && snap.data.git;
          const count = git && Array.isArray(git.files) ? git.files.length : 0;

          const toggle = () => {
            const next = !snap.open;
            emit({ open: next });
            if (next) fetchHud(sessionId, false);
          };

          return react.createElement("button", {
            type: "button",
            onClick: toggle,
            title: snap.open ? "关闭 HUD 面板" : "HUD：Git 状态 / MCP / 技能" + (count > 0 ? "（" + count + " 个文件未提交）" : ""),
            style: {
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              border: "none",
              borderRadius: "999px",
              cursor: "pointer",
              padding: "2px 10px",
              fontSize: "13px",
              lineHeight: "20px",
              fontWeight: 500,
              background: snap.open ? "var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.15))" : "transparent",
              color: snap.open ? "var(--dsw-alias-state-warn-label, #b8860b)" : "var(--dsw-alias-text-secondary, #666)",
              position: "relative",
            },
          },
            "📊 HUD",
            count > 0 ? react.createElement("span", {
              style: {
                position: "absolute",
                top: "-2px",
                right: "-2px",
                minWidth: "14px",
                height: "14px",
                borderRadius: "7px",
                background: "var(--dsw-alias-state-warn-primary, #e8a13a)",
                color: "#fff",
                fontSize: "10px",
                lineHeight: "14px",
                textAlign: "center",
                padding: "0 3px",
                boxSizing: "border-box",
              },
            }, String(count)) : null
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
            if (timer !== undefined) return timer.interval(() => fetchHud(current, false), REFRESH_MS);
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
            if (status === "??") return "#999";
            if (status === "A") return "#3fb950";
            if (status === "D" || status === "U") return "#f85149";
            if (status === "R") return "#58a6ff";
            return "#e8a13a";
          };

          const refresh = () => fetchHud(current, false);

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

          const renderFileRow = (file) => {
            const summary = file.new
              ? react.createElement("span", { style: { color: "#999", marginLeft: "auto", flexShrink: 0 } }, "new")
              : file.add + file.del > 0
                ? react.createElement("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: "10px" } },
                    react.createElement("span", { style: { color: "#3fb950" } }, "+" + file.add),
                    " ",
                    react.createElement("span", { style: { color: "#f85149" } }, "-" + file.del)
                  )
                : null;
            const isOpen = expanded[file.path] === true;
            return react.createElement("div", { key: file.path },
              react.createElement("div", {
                onClick: () => toggleDiff(file.path),
                title: file.untracked ? "未跟踪文件" : "点击查看 diff",
                style: {
                  display: "flex", gap: "6px", fontSize: "11px", lineHeight: "20px",
                  whiteSpace: "nowrap", cursor: file.untracked ? "default" : "pointer",
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
          const group = (title, key, list) => list.length === 0
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
                  isCollapsed ? null : list.map(renderFileRow)
                );
              })();

          return react.createElement("div", {
            style: {
              // 高度随内容自适应；上限 = 视口 − 顶部 64 − 输入区实测高度 − 16 余量，
              // 输入区多高（含多行输入/附件展开）面板就停在哪，内容再长也盖不到对话栏
              position: "fixed", top: "64px", right: "12px", width: width + "px",
              maxHeight: "calc(100vh - 64px - " + composerH + "px - 16px)", overflowY: "auto",
              background: "var(--dsw-alias-bg-elevated, #ffffff)",
              color: "var(--dsw-alias-text-primary, #1f2328)",
              border: "1px solid var(--dsw-alias-border-strong, rgba(0,0,0,0.12))",
              borderRadius: "10px", boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
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
                          react.createElement("span", { style: { color: "#58a6ff" } }, "↑ " + fmtTokens(tokenUsage.input)),
                          "  ",
                          react.createElement("span", { style: { color: "#d2a8ff" } }, "↓ " + fmtTokens(tokenUsage.output)),
                          tokenUsage.cacheHit !== null
                            ? react.createElement("span", { style: { color: "#3fb950", marginLeft: "5px" } }, "缓存 " + tokenUsage.cacheHit + "%")
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
                            ? react.createElement("span", { style: { color: sessionStats.contextPercent > 80 ? "#f85149" : "#999" } }, " · ctx " + sessionStats.contextPercent + "%")
                            : null
                        )
                      : null
                  )
                )
              : null,

            git === null
              ? react.createElement("div", { style: { fontSize: "12px", color: "#999", marginTop: "6px" } }, "⎇ 不是 Git 仓库")
              : git === undefined
                ? react.createElement("div", { style: { fontSize: "12px", color: "#999", marginTop: "6px" } }, "⎇ Git 状态不可用")
                : section("git", "Git", git.files.length,
                    react.createElement("div", null,
                      react.createElement("div", { style: { fontSize: "12px", fontWeight: 500 } },
                        "⎇ " + git.branch,
                        (git.ahead > 0 || git.behind > 0)
                          ? react.createElement("span", { style: { color: "#999", fontWeight: 400, marginLeft: "5px" } }, "↑" + git.ahead + " ↓" + git.behind)
                          : null,
                        git.files.length > 0
                          ? react.createElement("span", { style: { color: "#e8a13a", marginLeft: "5px" } }, git.files.length + " 个未提交")
                          : react.createElement("span", { style: { color: "#3fb950", marginLeft: "5px" } }, "干净")
                      ),
                      group("未暂存", "unstaged", unstaged),
                      group("已暂存", "staged", staged),
                      group("未跟踪", "untracked", untracked),
                      commits.length > 0
                        ? section("commits", "提交", commits.length,
                            react.createElement("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
                              commits.map((c, index) => react.createElement("li", {
                                key: index,
                                style: { fontSize: "11px", lineHeight: "19px", display: "flex", gap: "6px", alignItems: "baseline" },
                              },
                                react.createElement("span", { style: { color: "#58a6ff", flexShrink: 0, fontFamily: "monospace" } }, c.hash),
                                react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } }, c.subject),
                                react.createElement("span", { style: { color: "#999", flexShrink: 0, fontSize: "10px" } }, relTime(c.time))
                              ))
                            )
                          )
                        : null
                    )
                  ),

            section("mcp", "MCP", mcp.length,
              mcp.length === 0
                ? react.createElement("div", { style: { fontSize: "12px", color: "#999" } }, "未挂载 MCP 服务器")
                : react.createElement("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
                    mcp.map((server, index) => react.createElement("li", {
                      key: index, style: { fontSize: "12px", lineHeight: "21px", display: "flex", alignItems: "center", gap: "5px" },
                    },
                      react.createElement("span", { style: { color: "#58a6ff" } }, "🔌"),
                      server
                    ))
                  )
            ),

            section("skills", "Skills", skills.length,
              skills.length === 0
                ? react.createElement("div", { style: { fontSize: "12px", color: "#999" } }, "无可用技能")
                : react.createElement("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
                    skills.map((name, index) => react.createElement("li", {
                      key: index, style: { fontSize: "12px", lineHeight: "21px", display: "flex", alignItems: "center", gap: "5px" },
                    },
                      react.createElement("span", { style: { color: "#d2a8ff" } }, "📚"),
                      name
                    ))
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
