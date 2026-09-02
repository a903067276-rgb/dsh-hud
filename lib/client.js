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
    // 刷新策略（2026-08-19）：事件驱动——换目录 / git 有变化（fs.watch → SSE）自动刷新，
    // 其余手动点刷新按钮；窗口聚焦时补一次即时刷新。无轮询。
    // client 侧节流：同类请求最小间隔（ms），防轮询/点击风暴高频触发 host git 子进程
    const FETCH_MIN_INTERVAL_MS = 300;
    const lastFetchAt = { light: 0, full: 0 };
    // 进行中标记：面板打开瞬间的双 full fetch 合并入口（同一会话的 full 拉取在途时跳过第二次）
    let fullFetchInFlight = null; // 在途 full 拉取的 sessionId
    const WIDTH_MIN = 200;
    const WIDTH_MAX = 480;
    const WIDTH_DEFAULT = 240;
    // 面板位置（2026-08-31）：官方 0.1.2 新增回合导航条 TurnNavigator（页面最右侧竖排
    // 横线 mark，宽 28px、垂直居中、最多 420px 高），与 HUD 面板默认位置（right:12）
    // 重叠——HUD 打开会盖住官方的回合定位条。改默认位置：左侧贴侧边栏（官方侧边栏
    // 280px + 12px 间距），同时支持拖动 + localStorage 记住位置。
    const POS_DEFAULT = { x: 292, y: 64 };
    const readPanelPos = () => {
      try {
        const raw = window.localStorage.getItem("dsh-hud-pos");
        if (raw) {
          const p = JSON.parse(raw);
          if (typeof p.x === "number" && typeof p.y === "number") return p;
        }
      } catch (error) { /* ignore */ }
      return POS_DEFAULT;
    };
    const writePanelPos = (pos) => {
      try { window.localStorage.setItem("dsh-hud-pos", JSON.stringify(pos)); } catch (error) { /* ignore */ }
    };
    // 关注仓库列表（localStorage 持久化，换行分隔绝对路径，2026-08-20 由逗号改换行：
    // 逗号要分中英文，换行无歧义；读取兼容旧逗号数据）：host 聚合显示跨目录 git
    // ── 官方线性 SVG 图标（2026-08-19 UI 规范化：16 viewBox / stroke=currentColor / 1.5 线宽圆头，对齐官方 Icon*Outline 风格，不用 emoji）──
    // 行业通用图标（feather 标准路径：git-branch / server / zap，16 viewBox 缩放）
    const ICON_GIT = ["M6 3v9a3 3 0 0 0 3 3h3", "M12 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M18 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"];
    const ICON_SERVER = ["M3.5 3.5h9v5h-9z", "M3.5 11.5h9v5h-9z", "M6 6v0M6 14v0"];
    const ICON_SKILLS = ["M13 2L3.5 14h6.5l-1 8 9.5-12h-6.5z"];
    // 状态行图标（2026-08-21，界面图标不用 emoji，全部线性 SVG）
    const ICON_GEAR = ["M8 2v1.6", "M8 12.4V14", "M2 8h1.6", "M12.4 8H14", "M3.7 3.7l1.2 1.2", "M11.1 11.1l1.2 1.2", "M12.3 3.7l-1.2 1.2", "M4.9 11.1l-1.2 1.2", "M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z"];
    const ICON_WALLET = ["M2.5 5.5V11a1.5 1.5 0 0 0 1.5 1.5h8.5A1.5 1.5 0 0 0 14 11V6a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 1 2.5 3 1.5 1.5 0 0 1 4 1.5h7", "M10.5 8.6a1 1 0 1 0 2 0 1 1 0 0 0-2 0z"];
    const ICON_CHECKLIST = ["M3 3h10a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7A1.5 1.5 0 0 1 3 3z", "M6 6.5h4", "M6 9h4", "M6 11.5h2"];
    const ICON_WARN = ["M8 2.5L14.5 13.5h-13z", "M8 6.5v3.5", "M8 11.7v.3"];
    const icon = (paths, size, color) => react.createElement("svg", {
      width: size || 13, height: size || 13, viewBox: "0 0 16 16", fill: "none",
      stroke: color || "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
      style: { flexShrink: 0, verticalAlign: "-2px" },
    }, paths.map((d, i) => react.createElement("path", { key: i, d: d })));

    // 解析：换行/逗号都认（逗号只为兼容旧 localStorage），去空白去空行
    const parseRepos = (raw) => raw ? raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean) : [];
    const readExtraRepos = () => {
      try {
        return parseRepos(window.localStorage.getItem("dsh-hud-repos")).join("\n");
      } catch (error) { return ""; }
    };
    const writeExtraRepos = (value) => {
      try { window.localStorage.setItem("dsh-hud-repos", parseRepos(value).join("\n")); } catch (error) { /* ignore */ }
    };

    // ── 官方设置卡片壳（2026-09-02，视觉对齐 dsh 0.1.2 host PluginCard；key 须与宿主命名空间一致）──
    const CARD_CSS = ".dsh-settings-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;transition:border-color .16s,background .16s}.dsh-settings-card:hover{border-color:var(--dsw-alias-label-dimmed)}.dsh-settings-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.dsh-settings-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}.dsh-settings-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.dsh-settings-headtext{display:flex;flex-direction:column;flex:1;min-width:0;gap:4px}.dsh-settings-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.dsh-settings-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.dsh-settings-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.dsh-settings-open .dsh-settings-chevron{transform:rotate(180deg)}.dsh-settings-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:10px 0 8px}.dsh-settings-body input,.dsh-settings-body textarea,.dsh-settings-body select{box-sizing:border-box;max-width:100%;min-width:0}";
    let cardCssInjected = false;
    function injectCardCss() {
      if (typeof document === "undefined" || cardCssInjected) return;
      cardCssInjected = true;
      if (document.getElementById("dsh-settings-card-style") !== null) return;
      const tag = document.createElement("style");
      tag.id = "dsh-settings-card-style";
      tag.textContent = CARD_CSS;
      document.head.appendChild(tag);
    }
    function SettingsCardShell(props) {
      const [open, setOpen] = react.useState(false);
      return react.createElement("li", { className: "dsh-settings-card" + (open ? " dsh-settings-open" : "") },
        react.createElement("button", {
          type: "button", className: "dsh-settings-head", "aria-expanded": open,
          onClick: () => setOpen(!open),
          "aria-label": (open ? "折叠" : "展开") + "：" + props.title,
        },
          react.createElement("span", { className: "dsh-settings-headtext" },
            react.createElement("span", { className: "dsh-settings-name" }, props.title),
            react.createElement("span", { className: "dsh-settings-desc" }, props.desc)
          ),
          react.createElement("svg", { className: "dsh-settings-chevron", width: "14", height: "14", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" },
            react.createElement("path", { d: "M4 6.5 8 10.5 12 6.5" })
          )
        ),
        open ? react.createElement("div", { className: "dsh-settings-body" }, props.children) : null
      );
    }

    // 设置面板插件卡片（settings.plugin.item，2026-08-18）：关注仓库配置
    // 保存反馈统一口径（2026-08-21）：按钮短暂变绿"✓ 已保存" + 按钮旁绿字
    function HudSettingsCard(props) {
      const [value, setValue] = react.useState(readExtraRepos);
      const [saved, setSaved] = react.useState(false);
      const savedTimer = react.useRef(null);
      const save = () => {
        writeExtraRepos(value);
        // 通知主面板刷新（共享 storage 事件；面板在其它标签页时也生效）
        try { window.dispatchEvent(new Event("dsh-hud-repos-changed")); } catch (error) { /* ignore */ }
        setSaved(true);
        if (savedTimer.current !== null) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => { setSaved(false); savedTimer.current = null; }, 2000);
      };
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        // 分区内容统一头部标题（2026-08-21，标题 = 分区名，样式对齐 memory/backup 的 h3）
        // 分区内容统一头部标题（2026-08-21，标题 = 分区名，样式对齐 memory/backup 的 h3）；卡片壳内不重复标题
        props && props.inCard ? null : react.createElement("h3", { style: { margin: 0, fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "HUD"),
        react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" } },
          "关注仓库：每行一个绝对路径，跨目录 git 仓库会一起显示在 HUD 面板"
        ),
        react.createElement("textarea", {
          value: value,
          rows: 3,
          placeholder: "每行一个，如：\n/Users/me/projects/other\n/Users/me/projects/another",
          onChange: (e) => setValue(e.target.value),
          style: {
            width: "100%", boxSizing: "border-box", background: "transparent",
            border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))",
            color: "var(--dsw-alias-label-primary)", borderRadius: "6px",
            fontSize: "12px", padding: "5px 8px", resize: "vertical", fontFamily: "inherit",
          },
        }),
        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
          react.createElement("button", {
            type: "button",
            onClick: save,
            style: {
              alignSelf: "flex-start", border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))",
              background: "transparent",
              color: saved ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-secondary)",
              borderColor: saved ? "var(--dsw-alias-state-success-primary)" : undefined,
              borderRadius: "6px", cursor: "pointer", fontSize: "12px", padding: "4px 14px",
            },
          }, saved ? "✓ 已保存" : "保存"),
          saved
            ? react.createElement("span", { style: { fontSize: "12px", color: "var(--dsw-alias-state-success-primary)" } }, "已保存，面板已刷新")
            : null
        )
      );
    }

    function apply(ctx) {
      // 官方 dsw 风格开关按钮（2026-08-18，对齐 plan-switch 样板）：28px 图标按钮
      // （2026-08-21：原 theme-fix 的 body 伪 token 映射已随代码换真 token 全部删除）
      if (!document.getElementById("dsh-hud-style")) {
        const style = document.createElement("style");
        style.id = "dsh-hud-style";
        style.textContent = [
          ".dsh-hud-toggle-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;padding:0;position:relative;}",
          ".dsh-hud-toggle-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));}",
          // 面板打开：黄色系高亮（激活语义 = warn 黄，2026-08-21 定案）
          ".dsh-hud-toggle-btn.is-open{background:var(--dsw-alias-state-warn-tertiary,rgba(255,180,0,0.15));color:var(--dsw-alias-state-warn-label,#b8860b);}",
          // 未提交数角标
          ".dsh-hud-badge{position:absolute;top:-2px;right:-2px;min-width:14px;height:14px;border-radius:7px;background:var(--dsw-alias-state-warn-primary,#e8a13a);color:#fff;font-size:10px;line-height:14px;text-align:center;padding:0 3px;box-sizing:border-box;pointer-events:none;}",
          // 输入行模型选择器宽度上限（2026-08-21 官方响应式 bug 的插件侧修复）：
          // 模型名变长（如 flash-vision-exp）时 trailing 放不下会整体换行，
          // 输入框被撑成两行；截断模型名保持单行（悬停 title 可见全名）。
          // [data-phase] 是官方 InputBar 卡片的稳定属性；Workspace/plan 等
          // 短标签不受影响。DSH 官方修复后可删除本条。
          "[data-phase] button[aria-haspopup=\"menu\"]{max-width:min(190px,40cqw);}",
        ].join("\n");
        document.head.appendChild(style);
      }
      injectCardCss();
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      const timer = ctx.get("timer");

      // light 轮询上次未提交总数（变化检测：变了立即补 full）
      let lastLightCount = -1;
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
            // 2026-08-24 修复（v1.2.15 回归）：light payload 只有 count，若 emit({data}) 会把
            // 面板完整数据覆盖成只含 count 的对象 → 面板内容清空。改短合并只更新角标计数
            // （store 顶层 count 字段），面板数据仅在 full 响应落地时替换。
            emit({ count: data.count });
          } else {
            emit({ data, error: null, sessionId, count: undefined });
          }
        } catch (error) {
          if (snapshot.sessionId !== sessionId) return;
          // 2026-08-24：light 请求失败不砸面板（面板打开时 30s 轮询也可能发 light；
          // 旧逻辑 data:null 会清空面板，light 失败 30s 后自动重试即可）
          if (light) return;
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

          // 面板关闭时拉一次角标（后续靠 fs.watch → SSE tick 事件驱动，见下方 EventSource）
          react.useEffect(() => {
            if (snap.open || typeof current !== "string") return;
            fetchHud(current, true);
          }, [snap.open, current]);

          const git = snap.data && snap.data.git;
          // 角标计数（2026-08-24 修：light 响应只更新顶层 count，不再覆盖 data.count）：
          // 优先 snap.count（light 轮询更新），其次兼容旧字段 snap.data.count，最后回退 git 聚合
          const lightCount = snap.count !== undefined && Array.isArray(snap.count)
            ? snap.count.reduce(function (n, r) { return n + (r && r.count ? r.count : 0) }, 0)
            : (snap.data && Array.isArray(snap.data.count)
              ? snap.data.count.reduce(function (n, r) { return n + (r && r.count ? r.count : 0) }, 0)
              : undefined);
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
          // 关注仓库配置版本（设置面板保存后自增 → 重建 EventSource 带上新 repos）
          const [reposVersion, setReposVersion] = react.useState(0);
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
          // 面板位置：默认左侧（避开官方右侧回合导航条），拖动记忆（2026-08-31）
          const [pos, setPos] = react.useState(readPanelPos);
          const drag = react.useRef(null);
          const posRef = react.useRef(pos);
          // 输入区（官方 composer seat）实测高度：面板上限 = 视口 − 顶部 64 − 输入区 − 16 余量，
          // 输入框多高（含多行输入/附件展开）面板就自动停在哪，永不遮挡对话栏
          const [composerH, setComposerH] = react.useState(152);
          const snap = react.useSyncExternalStore(subscribe, getSnapshot);
          // 状态驱动展开（2026-08-19 修复：必须在组件内且 snap 声明之后——fetchHud 在
          // apply 顶层作用域无 setCollapsed，此前 ReferenceError 导致面板空白）
          react.useEffect(() => {
            const repos = snap.data && snap.data.git && Array.isArray(snap.data.git.repos) ? snap.data.git.repos : [];
            if (repos.length === 0) return;
            const next = {};
            for (const r of repos) {
              // 统一规则（2026-08-19）：有未提交文件的仓库展开，其余（含主目录）收起
              const n = Array.isArray(r.files) ? r.files.length : 0;
              next["repo-" + r.name] = n === 0;
            }
            if (Object.keys(next).length > 0) setCollapsed(function (old) { return { ...old, ...next } });
          }, [snap.data]);
          const useSessions = props.useSessions;
          const current = typeof useSessions === "function" ? useSessions((s) => s && s.current) : undefined;

          react.useEffect(() => {
            const onMove = (event) => {
              const r = resize.current;
              if (r !== null) {
                const next = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, r.startWidth - (event.clientX - r.startX)));
                setWidth(next);
                return;
              }
              const d = drag.current;
              if (d === null) return;
              // 边界夹紧：留 8px 边距，超出视口也拖得回来
              const next = {
                x: Math.max(8, Math.min(window.innerWidth - width - 8, d.originX + (event.clientX - d.startX))),
                y: Math.max(8, Math.min(window.innerHeight - 96, d.originY + (event.clientY - d.startY))),
              };
              posRef.current = next;
              setPos(next);
            };
            const onUp = () => {
              if (resize.current !== null) {
                resize.current = null;
                try { window.localStorage.setItem("dsh-hud-width", String(width)); } catch (error) { /* ignore */ }
              }
              if (drag.current !== null) {
                drag.current = null;
                writePanelPos(posRef.current);
              }
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
          }, [snap.open, current]);

          // 事件驱动刷新（2026-08-19，替代轮询）：host fs.watch 监听文件系统变化 → SSE tick
          react.useEffect(() => {
            if (typeof current !== "string") return;
            const repos = readExtraRepos();
            const es = new EventSource("/api/dsh-hud/events?session=" + encodeURIComponent(current) + (repos !== "" ? "&repos=" + encodeURIComponent(repos) : ""));
            // 事件驱动一律 full 拉取（闭包捕获的 snap.open 是旧值，判断会永远走 light）
            es.onmessage = () => fetchHud(current, false);
            es.onerror = () => { /* EventSource 自动重连 */ };
            return () => es.close();
          }, [current, reposVersion]);

          // 关注仓库配置变更（设置面板保存后）→ 立即刷新 + 重建 EventSource
          react.useEffect(() => {
            const onReposChanged = () => {
              if (typeof current === "string") fetchHud(current, snap.open ? false : true);
              setReposVersion((v) => v + 1);
            };
            window.addEventListener("dsh-hud-repos-changed", onReposChanged);
            return () => window.removeEventListener("dsh-hud-repos-changed", onReposChanged);
          }, [snap.open, current]);

          // 30s light 轮询兜底（2026-08-24 修复 hud #8）：host watcher 设上限后，
          // 超出 cap 的深层目录变化改由轮询发现——light 只查 git 计数（角标开销小，
          // 一次 shell 统计全部子仓库），light 发现总数变化会自动补 full（见 fetchHud）。
          // 间隔 30s 与服务端防刷窗口匹配（"正常客户端轮询间隔 ≥ 30s"）；页面不可见时不轮询。
          react.useEffect(() => {
            if (typeof current !== "string") return;
            const id = setInterval(() => {
              if (document.visibilityState !== "visible") return;
              fetchHud(current, true);
            }, 30000);
            return () => clearInterval(id);
          }, [current]);

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

          // 挂载时修正出界位置（窗口缩小后旧位置可能超出视口；必须放在条件 return 之前）
          react.useEffect(() => {
            const x = Math.max(8, Math.min(window.innerWidth - width - 8, pos.x));
            const y = Math.max(8, Math.min(window.innerHeight - 96, pos.y));
            if (x !== pos.x || y !== pos.y) setPos({ x, y });
          }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

          // 拖动面板（2026-08-31）：标题栏为拖拽把手；关闭按钮等其他可点元素不触发
          const startDrag = (event) => {
            if (event.target && event.target.closest && event.target.closest("button")) return;
            drag.current = { startX: event.clientX, startY: event.clientY, originX: pos.x, originY: pos.y };
            event.preventDefault();
          };

          const git = snap.data && snap.data.git;
          const mcp = snap.data && Array.isArray(snap.data.mcp) ? snap.data.mcp : [];
          const skills = snap.data && Array.isArray(snap.data.skills) ? snap.data.skills : [];
          const version = snap.data && typeof snap.data.version === "string" ? snap.data.version : null;
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
                react.createElement("span", { style: { fontSize: "10px", color: "var(--dsw-alias-label-tertiary, #999)", width: "12px", flexShrink: 0 } }, isCollapsed ? "▸" : "▾"),
                react.createElement("span", {
                  style: {
                    fontSize: "12px", fontWeight: 700,
                    color: "var(--dsw-alias-label-primary)",
                    textTransform: "uppercase", letterSpacing: "0.4px",
                  },
                }, title),
                count !== null
                  ? react.createElement("span", {
                      style: {
                        fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-tertiary, #999)",
                        background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.15))", borderRadius: "8px", padding: "0 6px",
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
              });            }
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
                  display: "flex", gap: "6px", fontSize: "12px", lineHeight: "21px",
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
                      background: "var(--dsw-alias-bg-overlay, #f6f8fa)", padding: "6px 8px", borderRadius: "6px",
                      margin: "2px 0 4px", maxHeight: "180px", overflowY: "auto",
                      color: "var(--dsw-alias-label-primary, #1f2328)",
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
                      fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)",
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
              // 位置（2026-08-31）：默认左侧贴侧边栏（避开官方右侧回合导航条），可拖动记忆
              position: "fixed", top: pos.y + "px", left: pos.x + "px", width: width + "px",
              maxHeight: "calc(100vh - 64px - " + composerH + "px - 16px)", overflowY: "auto",
              background: "var(--dsw-specific-sidebar-fill)",
              color: "var(--dsw-alias-label-primary)",
              border: "1px solid var(--dsw-alias-border-l1)",
              borderRadius: "10px",
              boxShadow: "var(--dsw-shadow-lv2, 0 12px 32px rgba(0,0,0,0.18))",
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
            react.createElement("div", {
              onMouseDown: startDrag,
              title: "拖动调整位置",
              style: { display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "move", userSelect: "none" },
            },
              react.createElement("span", { style: { fontSize: "15px", fontWeight: 700, color: "var(--dsw-alias-label-primary)" } }, "HUD"),
              react.createElement("button", {
                type: "button", onClick: close, onMouseDown: (e) => e.stopPropagation(), title: "关闭",
                style: { border: "none", background: "transparent", color: "var(--dsw-alias-label-secondary, #666)", cursor: "pointer", fontSize: "15px", lineHeight: "18px", padding: "0 4px" },
              }, "✕")
            ),

            // ── 状态行：当前模型 + plan 状态（图标走模块级 ICON_*，2026-08-21）──
            react.createElement("div", {
              style: {
                display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
                fontSize: "11px", color: "var(--dsw-alias-label-secondary, #666)",
                marginTop: "6px", paddingBottom: "6px",
                borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))",
              },
            },
              react.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "3px" } },
                icon(ICON_GEAR, 11), modelName),
              // DSH 版本号（2026-08-20）：host 跑 `dsh --version` 返回，状态行常驻显示
              version !== null
                ? react.createElement("span", {
                    title: "DSH 版本",
                    style: { display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--dsw-alias-label-tertiary, #999)" },
                  }, "v" + version.replace(/^v/, ""))
                : null,
              // 官方余额（自动拉取；数据未到/失败/无凭据显示 --）
              // 注意：snap.data 未加载时 balance 是 undefined，必须用 != null 宽松判断
              react.createElement("span", {
                title: balance != null
                  ? "官方余额 · 含赠金 ¥" + balance.granted + " · 充值 ¥" + balance.toppedUp
                  : "余额不可用（无 DEEPSEEK_API_KEY 凭据或网络失败）",
                style: { display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--dsw-alias-state-success-primary)" },
              },
                icon(ICON_WALLET, 11), balance != null
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
                  }, icon(ICON_CHECKLIST, 10), "Plan 开")
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
                      ? react.createElement("div", { style: { fontSize: "11px", lineHeight: "18px", color: "var(--dsw-alias-label-secondary, #666)" } },
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
                      style: { fontSize: "12px", lineHeight: "21px", display: "flex", gap: "6px", alignItems: "baseline" },
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
              ? react.createElement("div", { style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary)", marginTop: "6px", display: "flex", alignItems: "center", gap: "5px" } }, icon(ICON_GIT, 13), "不是 Git 仓库")
              : git === undefined
                ? react.createElement("div", { style: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary)", marginTop: "6px", display: "flex", alignItems: "center", gap: "5px" } }, icon(ICON_GIT, 13), "Git 状态不可用")
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
                        react.createElement("div", { style: { fontSize: "13px", fontWeight: 500 } },
                          icon(ICON_GIT, 13), " " + (repo.name !== undefined ? repo.name + " · " : "") + repo.branch,
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
                                  style: { fontSize: "12px", lineHeight: "21px", display: "flex", gap: "6px", alignItems: "baseline" },
                                },
                                  react.createElement("span", { style: { color: "var(--dsw-alias-state-business-primary)", flexShrink: 0, fontFamily: "monospace" } }, c.hash),
                                  react.createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 } }, c.subject),
                                  react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", flexShrink: 0, fontSize: "11px" } }, relTime(c.time))
                                ))
                              )
                            )
                          : null
                      );
                    };
                    if (repos === null) return section("git", "Git", totalCount, repoBody(git, true));
                    // 分级（2026-08-19）：工作区仓库在 GIT 区块；关注仓库独立区块（与 GIT 平级标题）
                    const workRepos = repos.filter((r) => !r.extra);
                    const extraRepos = repos.filter((r) => r.extra === true);
                    const workCount = workRepos.reduce(function (n, r) { return n + (Array.isArray(r.files) ? r.files.length : 0) }, 0);
                    const extraCount = extraRepos.reduce(function (n, r) { return n + (Array.isArray(r.files) ? r.files.length : 0) }, 0);
                    // 缩进层级（2026-08-19）：当前仓库顶格 / 子仓库缩 14px / 关注仓库条目顶格、其子仓库缩 14px
                    const repoBlock = (repo, indent) => {
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
                            fontSize: "13px", paddingLeft: indent || 0,
                          },
                        },
                          react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", width: "12px", flexShrink: 0 } }, isCollapsed ? "▸" : "▾"),
                          react.createElement("span", { style: { fontWeight: repo.active || (repo.files || []).length > 0 ? 600 : 400, color: repo.active ? "var(--dsw-alias-label-primary)" : (repo.files || []).length > 0 ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-label-tertiary)" } },
                            repo.name,
                            repo.active
                              ? react.createElement("span", { style: { background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06))", borderRadius: "8px", padding: "0 6px", marginLeft: "6px", fontSize: "10px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", fontWeight: 500 } }, "当前")
                              : null
                          ),
                          react.createElement("span", {
                            style: (repo.files || []).length > 0
                              ? { marginLeft: "auto", flexShrink: 0, background: "var(--dsw-alias-state-warn-primary, #e8a13a)", color: "#fff", borderRadius: "7px", fontSize: "11px", lineHeight: "16px", minWidth: "18px", textAlign: "center", padding: "0 4px", boxSizing: "border-box" }
                              : { marginLeft: "auto", flexShrink: 0, color: "var(--dsw-alias-state-success-primary)", fontSize: "11px" },
                          }, (repo.files || []).length > 0 ? (repo.files || []).length : "✓")
                        ),
                        isCollapsed ? null : repoBody(repo, repo.active)
                      );
                    };
                    // 会话目录非 git 时（2026-08-20 修复）：可能只有关注仓库 → 只渲染关注仓库区块，
                    // 不出现空壳 GIT 标题（计数为 0 且无内容）
                    const gitSection = workRepos.length > 0
                      ? section("git", "Git", workCount,
                          react.createElement("div", null,
                            workRepos.map((r) => repoBlock(r, r.active ? 0 : 14))
                          )
                        )
                      : null;
                    // 关注仓库 = 独立区块（与 GIT/MCP/SKILLS 平级标题）
                    const extraSection = extraRepos.length > 0
                      ? section("extra", "关注仓库", extraCount,
                          react.createElement("div", null,
                            extraRepos.map((r) => repoBlock(r, r.parent ? 14 : 0))
                          )
                        )
                      : null;
                    return react.createElement(react.Fragment, null, gitSection, extraSection);
                  })(),

            section("mcp", "MCP", mcp.length,
              mcp.length === 0
                ? react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" } }, "未挂载 MCP 服务器")
                : react.createElement("ul", { style: { listStyle: "none", margin: 0, padding: 0 } },
                    mcp.map((server, index) => react.createElement("li", {
                      key: index, style: { fontSize: "12px", lineHeight: "21px", display: "flex", alignItems: "center", gap: "5px" },
                    },
                      react.createElement("span", { style: { color: "var(--dsw-alias-state-business-primary)", display: "inline-flex" } }, icon(ICON_SERVER, 12)),
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
                      react.createElement("span", { style: { color: "var(--dsw-alias-label-primary-bluish)", display: "inline-flex" } }, icon(ICON_SKILLS, 12)),
                      name
                    ))
                  )
            ),

            react.createElement("div", {
              style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "10px", paddingTop: "7px", borderTop: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))" },
            },
              react.createElement("span", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", display: "inline-flex", alignItems: "center", gap: "3px" } },
                error !== null
                  ? react.createElement(react.Fragment, null, icon(ICON_WARN, 10), error)
                  : "更新于 " + stamp),
              react.createElement("button", {
                type: "button", onClick: refresh, title: "立即刷新",
                style: { border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))", background: "transparent", color: "var(--dsw-alias-label-secondary, #666)", borderRadius: "5px", cursor: "pointer", fontSize: "11px", padding: "1px 8px" },
              }, "刷新")
            )
          );
        }
      ));
    // 设置侧边栏页 + 插件卡片（设置双入口统一口径 2026-08-21）
    // 2026-08-19 修复：此块必须在 apply 内部（slots 是 apply 里的 ctx.get 结果），
    // 08:43 commit 1dd0da7 误放顶层 → ReferenceError: slots is not defined
    if (slots !== undefined) {
      slots.inject("settings.section", () => slots.register(
        { name: "settings.section", id: "dsh-hud-settings", order: 35, label: "HUD" },
        () => react.createElement(HudSettingsCard)
      ));
      slots.inject("settings.plugin.item", () => slots.register(
        { name: "settings.plugin.item", key: "hud", id: "dsh-hud" },
        () => react.createElement(SettingsCardShell, { title: "HUD", desc: "状态面板：git 状态 / MCP / 技能 / 用量，及关注仓库配置" },
          react.createElement(HudSettingsCard, { inCard: true }))
      ));
    }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
