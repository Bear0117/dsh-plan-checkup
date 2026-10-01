// dsh-plan-checkup, browser half.
// Hand-written in the dsh client-module format (window.__ModuleLoader__.load);
// React and ReactDOM come from the shell's shared module table, so there is no
// build step. The badge sits in the plan review card's toolbar
// (conversation.plan-review.actions). The toolbar clips overflow, so the detail
// panel renders through a portal on document.body (found in M0).
window.__ModuleLoader__.load({
	id: "dsh-plan-checkup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;

		const NS = "plan-checkup";
		const API = "/plan-checkup/api";
		const POLL_MS = 400;
		const POLL_LIMIT_MS = 12000;
		// While a checkup runs, keep polling this long past the host's own budget.
		const POLL_GRACE_MS = 5000;
		// Keep in step with package.json (a unit test checks); the feedback link prefills it.
		const PLUGIN_VERSION = "0.1.0";
		const FEEDBACK_URL = "https://github.com/Bear0117/dsh-plan-checkup/issues/new";

		// ---- Strings ------------------------------------------------------------
		// zh (Simplified) and en follow the dsh UI locale through ctx.locale; the
		// host `lang` setting can force zh-TW, zh-CN or en instead.
		const STRINGS = {
			"zh-TW": {
				badgeLabel: "計畫體檢",
				badgeAria: "{label}：{parts}",
				listSep: "、",
				"level.red": "嚴重",
				"level.orange": "注意",
				"level.amber": "提醒",
				checking: "體檢中…",
				clean: "沒發現問題",
				rulesOnly: "只用規則",
				paused: "體檢暫停",
				unavailable: "無法體檢",
				summary: "{steps} 步，{flagged} 步有標記",
				summaryClean: "{steps} 步，沒有標記",
				"flag.irreversible": "無法復原",
				"flag.external": "影響工作區以外",
				"flag.extra": "需求沒提到",
				"flag.vague": "描述太模糊",
				"flag.no-verification": "沒有驗證步驟",
				"flag.misses-task": "可能漏了需求",
				"plan.no-verification": "有步驟會改程式，但計畫裡沒有跑測試、建置或其他檢查。",
				"plan.misses-task": "計畫可能沒有涵蓋需求的所有部分。",
				ruleHit: "規則命中：{match}",
				mention: "有提到：{match}（前面有否定，交給 {engine} 判斷）",
				step: "第 {n} 步",
				unflagged: "其餘 {count} 步沒有標記",
				unchecked: "第 {from} 步之後超過上限，只跑了規則",
				running: "體檢中 {done}/{total}",
				runningSummary: "檢查中：{done}/{total} 項完成",
				pendingSteps: "還有 {count} 步在檢查…",
				planPending: "整份計畫的檢查還在進行。",
				engineRunning: "{engine} 檢查中…",
				engineOn: "{model} · {seconds} 秒 · {requests} 個請求 · 約 US${cost}",
				engineOnFree: "{model} · {seconds} 秒 · {requests} 個請求",
				engineOff: "只用規則：{reason}",
				enginePartial: "{engine} 部分完成（{done}/{requests}）：{reason}",
				"reason.egress-off": "未開啟外送（allowEgress 為 false）",
				"reason.no-key": "沒有 API 金鑰",
				"reason.no-model": "沒有設定模型（llm.model）",
				"reason.insecure-endpoint": "端點不是 https，也不在 allowHttpHosts 裡",
				"reason.bad-endpoint": "端點設定錯誤",
				"reason.paused-auth": "金鑰無效，暫停 30 分鐘",
				"reason.paused-quota": "額度用完，暫停 15 分鐘",
				"reason.auth": "金鑰無效",
				"reason.quota": "額度用完",
				"reason.busy": "{engine} 忙碌中",
				"reason.timeout": "{engine} 逾時",
				"reason.network": "連不到 {engine}",
				"reason.server": "{engine} 伺服器錯誤",
				"reason.bad-request": "{engine} 拒絕了請求",
				"reason.invalid": "{engine} 回應格式不對",
				"reason.aborted": "已停止",
				"reason.internal": "插件內部錯誤",
				insert: "帶入輸入框",
				inserted: "已帶入，按「要求修改」後會出現在輸入框",
				copy: "複製回饋",
				copied: "已複製",
				copyFailed: "無法複製，請手動選取",
				report: "意見回饋",
				reportTitle: "到 GitHub 回報標錯、漏標或其他建議（開新分頁，只帶入插件版本與引擎）",
				close: "關閉",
				voteUp: "這個標記正確",
				voteDown: "這個標記不對",
				voted: "已記錄",
				"feedback.header": "計畫體檢的提醒（請修改計畫後再交一次）：",
				suggest: "建議：{text}。",
				"feedback.irreversible": "第 {n} 步可能無法復原（{what}）。請加上備份或確認步驟。",
				"feedback.external": "第 {n} 步會影響工作區以外（{what}）。請確認需要這樣做。",
				"feedback.extra": "第 {n} 步需求沒提到（{what}）。不需要就刪掉。",
				"feedback.vague": "第 {n} 步描述太模糊（{what}）。請寫出要改哪裡、怎麼確認有效。",
				"feedback.no-verification": "整份計畫沒有驗證步驟。請加上跑測試或建置的步驟。",
				"feedback.misses-task": "計畫可能漏了需求的某部分。請對照需求補齊。",
				"suggest.backup-first": "先備份，或改成移到暫存位置",
				"suggest.branch-and-pr": "改成推到新分支並開 PR",
				"suggest.stash-first": "先 git stash 或另開分支保留改動",
				"suggest.backup-table": "先備份資料表",
				"suggest.add-where": "加上 WHERE 條件，並先備份",
				"suggest.confirm-scope": "先確認影響範圍，必要時由人手動執行",
				"suggest.confirm-remote": "確認需要動到遠端，或改由人手動執行",
			},
			"zh-CN": {
				badgeLabel: "计划体检",
				badgeAria: "{label}：{parts}",
				listSep: "、",
				"level.red": "严重",
				"level.orange": "注意",
				"level.amber": "提醒",
				checking: "体检中…",
				clean: "没发现问题",
				rulesOnly: "只用规则",
				paused: "体检暂停",
				unavailable: "无法体检",
				summary: "{steps} 步，{flagged} 步有标记",
				summaryClean: "{steps} 步，没有标记",
				"flag.irreversible": "无法恢复",
				"flag.external": "影响工作区以外",
				"flag.extra": "需求没提到",
				"flag.vague": "描述太模糊",
				"flag.no-verification": "没有验证步骤",
				"flag.misses-task": "可能漏了需求",
				"plan.no-verification": "有步骤会改代码，但计划里没有跑测试、构建或其他检查。",
				"plan.misses-task": "计划可能没有覆盖需求的所有部分。",
				ruleHit: "规则命中：{match}",
				mention: "有提到：{match}（前面有否定，交给 {engine} 判断）",
				step: "第 {n} 步",
				unflagged: "其余 {count} 步没有标记",
				unchecked: "第 {from} 步之后超过上限，只跑了规则",
				running: "体检中 {done}/{total}",
				runningSummary: "检查中：{done}/{total} 项完成",
				pendingSteps: "还有 {count} 步在检查…",
				planPending: "整个计划的检查还在进行。",
				engineRunning: "{engine} 检查中…",
				engineOn: "{model} · {seconds} 秒 · {requests} 个请求 · 约 US${cost}",
				engineOnFree: "{model} · {seconds} 秒 · {requests} 个请求",
				engineOff: "只用规则：{reason}",
				enginePartial: "{engine} 部分完成（{done}/{requests}）：{reason}",
				"reason.egress-off": "未开启外发（allowEgress 为 false）",
				"reason.no-key": "没有 API 密钥",
				"reason.no-model": "没有配置模型（llm.model）",
				"reason.insecure-endpoint": "端点不是 https，也不在 allowHttpHosts 里",
				"reason.bad-endpoint": "端点配置错误",
				"reason.paused-auth": "密钥无效，暂停 30 分钟",
				"reason.paused-quota": "额度用完，暂停 15 分钟",
				"reason.auth": "密钥无效",
				"reason.quota": "额度用完",
				"reason.busy": "{engine} 繁忙",
				"reason.timeout": "{engine} 超时",
				"reason.network": "连不上 {engine}",
				"reason.server": "{engine} 服务器错误",
				"reason.bad-request": "{engine} 拒绝了请求",
				"reason.invalid": "{engine} 响应格式不对",
				"reason.aborted": "已停止",
				"reason.internal": "插件内部错误",
				insert: "填入输入框",
				inserted: "已填入，点「要求修改」后会出现在输入框",
				copy: "复制反馈",
				copied: "已复制",
				copyFailed: "无法复制，请手动选取",
				report: "意见反馈",
				reportTitle: "到 GitHub 反馈标错、漏标或其他建议（在新标签页打开，只带上插件版本与引擎）",
				close: "关闭",
				voteUp: "这个标记正确",
				voteDown: "这个标记不对",
				voted: "已记录",
				"feedback.header": "计划体检的提醒（请修改计划后再提交一次）：",
				suggest: "建议：{text}。",
				"feedback.irreversible": "第 {n} 步可能无法恢复（{what}）。请加上备份或确认步骤。",
				"feedback.external": "第 {n} 步会影响工作区以外（{what}）。请确认需要这样做。",
				"feedback.extra": "第 {n} 步需求没提到（{what}）。不需要就删掉。",
				"feedback.vague": "第 {n} 步描述太模糊（{what}）。请写出要改哪里、怎么确认有效。",
				"feedback.no-verification": "整个计划没有验证步骤。请加上跑测试或构建的步骤。",
				"feedback.misses-task": "计划可能漏了需求的某部分。请对照需求补齐。",
				"suggest.backup-first": "先备份，或改成移到临时位置",
				"suggest.branch-and-pr": "改成推到新分支并开 PR",
				"suggest.stash-first": "先 git stash 或另开分支保留改动",
				"suggest.backup-table": "先备份数据表",
				"suggest.add-where": "加上 WHERE 条件，并先备份",
				"suggest.confirm-scope": "先确认影响范围，必要时由人手动执行",
				"suggest.confirm-remote": "确认需要动到远端，或改由人手动执行",
			},
			en: {
				badgeLabel: "Plan checkup",
				badgeAria: "{label}: {parts}",
				listSep: ", ",
				"level.red": "severe",
				"level.orange": "caution",
				"level.amber": "notice",
				checking: "Checking…",
				clean: "No issues found",
				rulesOnly: "Rules only",
				paused: "Checkup paused",
				unavailable: "Checkup unavailable",
				summary: "{steps} steps, {flagged} flagged",
				summaryClean: "{steps} steps, none flagged",
				"flag.irreversible": "Can't be undone",
				"flag.external": "Affects things outside the workspace",
				"flag.extra": "Not asked for",
				"flag.vague": "Too vague",
				"flag.no-verification": "No verification step",
				"flag.misses-task": "May miss part of the request",
				"plan.no-verification": "Some steps change code, but the plan never runs tests, a build, or another check.",
				"plan.misses-task": "The plan may not cover everything the request asks for.",
				ruleHit: "Rule match: {match}",
				mention: "Mentioned: {match} (negated, left to {engine})",
				step: "Step {n}",
				unflagged: "{count} other steps not flagged",
				unchecked: "Steps after {from} exceed the limit; rules only",
				running: "Checking {done}/{total}",
				runningSummary: "Checking: {done} of {total} done",
				pendingSteps: "{count} more steps still being checked…",
				planPending: "The whole-plan checks are still running.",
				engineRunning: "{engine} is checking…",
				engineOn: "{model} · {seconds} s · {requests} requests · about US${cost}",
				engineOnFree: "{model} · {seconds} s · {requests} requests",
				engineOff: "Rules only: {reason}",
				enginePartial: "{engine} partly done ({done}/{requests}): {reason}",
				"reason.egress-off": "Sending is off (allowEgress is false)",
				"reason.no-key": "No API key",
				"reason.no-model": "No model set (llm.model)",
				"reason.insecure-endpoint": "The endpoint is not https and not in allowHttpHosts",
				"reason.bad-endpoint": "The endpoint is misconfigured",
				"reason.paused-auth": "Key rejected; paused for 30 minutes",
				"reason.paused-quota": "Credit used up; paused for 15 minutes",
				"reason.auth": "Key rejected",
				"reason.quota": "Credit used up",
				"reason.busy": "{engine} is busy",
				"reason.timeout": "{engine} timed out",
				"reason.network": "Can't reach {engine}",
				"reason.server": "{engine} server error",
				"reason.bad-request": "{engine} rejected the request",
				"reason.invalid": "Unexpected response from {engine}",
				"reason.aborted": "Stopped",
				"reason.internal": "Plugin error",
				insert: "Put in the message box",
				inserted: "Added. It appears in the message box after you choose Request changes.",
				copy: "Copy feedback",
				copied: "Copied",
				copyFailed: "Couldn't copy; select the text instead",
				report: "Send feedback",
				reportTitle: "Report a wrong or missed flag, or suggest something, on GitHub (opens a new tab; only the plugin version and engine are filled in)",
				close: "Close",
				voteUp: "This flag is right",
				voteDown: "This flag is wrong",
				voted: "Recorded",
				"feedback.header": "Plan checkup notes (please revise the plan and present it again):",
				suggest: " Suggestion: {text}.",
				"feedback.irreversible": "Step {n} may not be undoable ({what}). Add a backup or confirmation step.",
				"feedback.external": "Step {n} affects things outside the workspace ({what}). Confirm it is needed.",
				"feedback.extra": "Step {n} was not asked for ({what}). Remove it if it isn't needed.",
				"feedback.vague": "Step {n} is too vague ({what}). Say what changes and how to check it worked.",
				"feedback.no-verification": "The plan has no verification step. Add a step that runs the tests or the build.",
				"feedback.misses-task": "The plan may miss part of the request. Check it against the request.",
				"suggest.backup-first": "back up first, or move to a temporary location instead",
				"suggest.branch-and-pr": "push to a new branch and open a PR instead",
				"suggest.stash-first": "git stash or keep the changes on a branch first",
				"suggest.backup-table": "back up the table first",
				"suggest.add-where": "add a WHERE clause and back up first",
				"suggest.confirm-scope": "confirm the scope first, or let a person run it",
				"suggest.confirm-remote": "confirm the remote change is needed, or let a person run it",
			},
		};

		function format(template, vars) {
			return String(template).replace(/\{(\w+)\}/g, (all, key) => (vars && vars[key] !== undefined ? String(vars[key]) : all));
		}

		// Pick the string table: an explicit host setting wins; otherwise follow the
		// dsh locale through the injected `t` (its dictionary is registered below).
		function useText(props, lang) {
			const table = lang && lang !== "auto" && STRINGS[lang] ? STRINGS[lang] : null;
			return (key, vars) => {
				if (table) return format(table[key] !== undefined ? table[key] : STRINGS.en[key], vars);
				if (typeof props.t === "function") {
					const value = props.t(key, vars);
					if (typeof value === "string" && value !== key) return format(value, vars);
				}
				return format(STRINGS["zh-CN"][key] !== undefined ? STRINGS["zh-CN"][key] : key, vars);
			};
		}

		// ---- Data ---------------------------------------------------------------
		function useCheckup(callId, sessionId) {
			const [state, setState] = React.useState({ phase: "loading" });
			React.useEffect(() => {
				if (callId === undefined || callId === null) {
					setState({ phase: "unknown" });
					return undefined;
				}
				let cancelled = false;
				let timer = null;
				let limit = POLL_LIMIT_MS;
				const started = Date.now();
				const query = "callId=" + encodeURIComponent(String(callId)) + (sessionId ? "&sessionId=" + encodeURIComponent(String(sessionId)) : "");
				const poll = async () => {
					try {
						const response = await fetch(API + "/result?" + query);
						const body = await response.json().catch(() => null);
						if (cancelled) return;
						if (response.status === 200 && body && body.result) {
							setState({ phase: "done", result: body.result });
							return;
						}
						if (response.status === 404) {
							setState({ phase: "unknown" });
							return;
						}
						// A running checkup sends what it has so far; the host finishes within its budget.
						if (response.status === 202 && body && body.partial) {
							const budget = body.partial.engine && body.partial.engine.budgetMs;
							if (typeof budget === "number") limit = Math.max(POLL_LIMIT_MS, budget + POLL_GRACE_MS);
							setState({ phase: "running", result: body.partial });
						}
					} catch (error) {
						if (cancelled) return;
					}
					if (Date.now() - started > limit) {
						setState({ phase: "unknown" });
						return;
					}
					timer = setTimeout(poll, POLL_MS);
				};
				poll();
				return () => {
					cancelled = true;
					if (timer) clearTimeout(timer);
				};
			}, [callId, sessionId]);
			return state;
		}

		// Render `code` spans in a one-line label; everything else stays text.
		function inline(text) {
			const parts = String(text).split("`");
			if (parts.length < 3) return text;
			return parts.map((part, i) => (i % 2 === 1 && i < parts.length - 1
				? h("code", { key: i, style: s.code }, part)
				: h(React.Fragment, { key: i }, i % 2 === 1 ? "`" + part : part)));
		}

		function vote(callId, step, flag, value) {
			return fetch(API + "/feedback", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ callId: String(callId), step, flag, vote: value }),
			}).then((response) => response.ok).catch(() => false);
		}

		// Deterministic feedback text: one line per flag, and each rule's suggestion
		// once (a force push raises two flags from the same rule).
		function feedbackText(result, tx) {
			const lines = [tx("feedback.header")];
			for (const step of result.steps) {
				const suggested = new Set();
				for (const flag of step.flags) {
					const rule = flag.rules && flag.rules[0];
					let what = rule ? rule.match : step.firstLine;
					if (what.length > 60) what = what.slice(0, 59) + "…";
					let line = "- " + tx("feedback." + flag.kind, { n: step.index, what });
					if (rule && rule.suggestion && !suggested.has(rule.id)) {
						suggested.add(rule.id);
						line += tx("suggest", { text: tx("suggest." + rule.suggestion) });
					}
					lines.push(line);
				}
			}
			for (const flag of result.plan.flags) lines.push("- " + tx("feedback." + flag.kind));
			return lines.join("\n");
		}

		// Results from before M1.5 have no engine label; they all came from Jev.
		function engineLabel(engine) {
			return (engine && engine.label) || "Jev";
		}

		// The feedback form gets the plugin version and the engine, never any plan text.
		function feedbackUrl(engine) {
			const used = !engine || engine.state === "off" || engine.state === "error"
				? "rules only"
				: [engine.kind, engine.model || engine.label].filter(Boolean).join(": ");
			return FEEDBACK_URL + "?template=feedback.yml&plugin-version=" + encodeURIComponent(PLUGIN_VERSION) + "&engine=" + encodeURIComponent(used);
		}

		function reasonText(tx, reason, label) {
			if (!reason) return "";
			const key = "reason." + reason;
			const text = tx(key, { engine: label });
			return text === key ? String(reason) : text;
		}

		// ---- Styles ---------------------------------------------------------------
		const COLORS = {
			red: "var(--dsw-alias-state-error-primary, #e5484d)",
			orange: "var(--dsw-alias-state-warn-primary, #f08c00)",
			amber: "#c9a227",
			muted: "var(--dsw-alias-label-tertiary, #8a8f98)",
		};
		const s = {
			wrap: { display: "inline-flex", alignItems: "center" },
			badge: {
				display: "inline-flex", alignItems: "center", gap: "6px", font: "inherit", fontSize: "12px", lineHeight: "20px",
				padding: "0 9px", borderRadius: "999px", border: "1px solid var(--dsw-alias-border-l2, #d4d7dc)",
				background: "transparent", color: "var(--dsw-alias-label-secondary, inherit)", cursor: "pointer", whiteSpace: "nowrap",
			},
			count: (color) => ({ display: "inline-flex", alignItems: "center", gap: "3px", color, fontWeight: 600, fontVariantNumeric: "tabular-nums" }),
			dot: (color) => ({ width: "7px", height: "7px", borderRadius: "50%", background: color, flex: "none" }),
			panel: {
				position: "fixed", zIndex: 1000, width: "min(26rem, calc(100vw - 24px))", maxHeight: "min(70vh, 34rem)", overflowY: "auto",
				background: "var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base, #fff))", color: "var(--dsw-alias-label-primary, inherit)",
				border: "1px solid var(--dsw-alias-border-l2, #d4d7dc)", borderRadius: "var(--dsw-radius-lg, 10px)",
				boxShadow: "var(--dsw-elevation-panel, 0 8px 28px rgba(0,0,0,.16))", fontSize: "13px", lineHeight: "1.6",
				display: "grid", gridTemplateColumns: "minmax(0, 1fr)",
			},
			head: { padding: "12px 14px", borderBottom: "1px solid var(--dsw-alias-border-l1, #e6e8eb)", display: "grid", gap: "2px" },
			headRow: { display: "flex", alignItems: "center", gap: "8px" },
			title: { fontWeight: 600, flex: 1, minWidth: 0 },
			meta: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #8a8f98)", fontVariantNumeric: "tabular-nums" },
			closeBtn: { font: "inherit", fontSize: "16px", lineHeight: "20px", border: "none", background: "transparent", color: "var(--dsw-alias-label-tertiary, #8a8f98)", cursor: "pointer", padding: "0 4px" },
			planWarn: { margin: "10px 14px 0", padding: "8px 10px", borderRadius: "8px", background: "var(--dsw-alias-state-warn-tertiary, rgba(240,140,0,.1))", display: "grid", gap: "2px" },
			list: { listStyle: "none", margin: 0, padding: "4px 0" },
			item: { display: "grid", gridTemplateColumns: "3.6em minmax(0, 1fr)", gap: "8px", padding: "9px 14px", borderBottom: "1px solid var(--dsw-alias-border-l1, #e6e8eb)" },
			stepNo: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #8a8f98)", paddingTop: "1px", fontVariantNumeric: "tabular-nums" },
			stepBody: { display: "grid", gap: "5px", minWidth: 0, overflowWrap: "anywhere" },
			flags: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" },
			pill: (color) => ({ display: "inline-flex", alignItems: "center", gap: "5px", padding: "0 8px", borderRadius: "999px", fontSize: "12px", lineHeight: "20px", border: "1px solid " + color, color }),
			voteBtn: { font: "inherit", fontSize: "12px", lineHeight: "18px", border: "1px solid var(--dsw-alias-border-l1, #e6e8eb)", background: "transparent", borderRadius: "6px", padding: "0 5px", cursor: "pointer", color: "var(--dsw-alias-label-tertiary, #8a8f98)" },
			rule: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #8a8f98)", fontFamily: "var(--dsw-font-mono, ui-monospace, Consolas, monospace)" },
			more: { padding: "9px 14px", color: "var(--dsw-alias-label-tertiary, #8a8f98)", fontSize: "12px" },
			foot: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", padding: "10px 14px 14px", borderTop: "1px solid var(--dsw-alias-border-l1, #e6e8eb)" },
			action: { font: "inherit", fontSize: "12px", lineHeight: "24px", padding: "0 12px", borderRadius: "7px", border: "1px solid var(--dsw-alias-border-l2, #d4d7dc)", background: "transparent", color: "inherit", cursor: "pointer" },
			note: { fontSize: "12px", color: "var(--dsw-alias-label-secondary, inherit)" },
			report: { marginLeft: "auto", fontSize: "12px", lineHeight: "24px", color: "var(--dsw-alias-label-tertiary, #8a8f98)", textDecoration: "none" },
			code: { fontFamily: "var(--dsw-font-mono, ui-monospace, Consolas, monospace)", fontSize: "12px", padding: "0 4px", borderRadius: "4px", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))" },
		};

		// ---- Components ------------------------------------------------------------
		function Counts({ counts, tx }) {
			const parts = [];
			for (const level of ["red", "orange", "amber"]) {
				if (counts[level] > 0) parts.push(h("span", { key: level, style: s.count(COLORS[level]), title: tx("level." + level) }, h("span", { style: s.dot(COLORS[level]) }), counts[level]));
			}
			return h(React.Fragment, null, parts);
		}

		function countsLabel(counts, tx) {
			return ["red", "orange", "amber"].filter((level) => counts[level] > 0)
				.map((level) => tx("level." + level) + " " + counts[level]).join(tx("listSep"));
		}

		function FlagPill({ flag, tx }) {
			const color = COLORS[flag.level] || COLORS.muted;
			const p = typeof flag.p === "number" ? " " + flag.p.toFixed(2) : "";
			return h("span", { style: s.pill(color), title: (flag.sources || []).join(" + ") }, h("span", { style: s.dot(color) }), tx("flag." + flag.kind) + p);
		}

		function VoteButtons({ callId, step, flag, tx }) {
			const [done, setDone] = React.useState(false);
			if (done) return h("span", { style: s.meta }, tx("voted"));
			const send = (value) => { vote(callId, step, flag, value).then(() => setDone(true)); };
			return h(React.Fragment, null,
				h("button", { type: "button", style: s.voteBtn, title: tx("voteUp"), "aria-label": tx("voteUp"), onClick: () => send("up") }, "👍"),
				h("button", { type: "button", style: s.voteBtn, title: tx("voteDown"), "aria-label": tx("voteDown"), onClick: () => send("down") }, "👎"),
			);
		}

		function EngineLine({ engine, tx }) {
			if (!engine) return null;
			const label = engineLabel(engine);
			if (engine.state === "running") return h("span", { style: s.meta }, tx("engineRunning", { engine: label }));
			if (engine.state === "on") {
				// A local model costs nothing per token, so the cost is left out.
				return h("span", { style: s.meta }, tx(engine.costUsd > 0 ? "engineOn" : "engineOnFree", {
					model: engine.answeredModel || engine.model,
					seconds: (engine.latencyMs / 1000).toFixed(1),
					requests: engine.requests,
					cost: (engine.costUsd || 0).toFixed(4),
				}));
			}
			if (engine.state === "partial") {
				const first = engine.errors && engine.errors[0];
				return h("span", { style: s.meta }, tx("enginePartial", { engine: label, done: engine.completed, requests: engine.requests, reason: reasonText(tx, first ? first.kind : "", label) }));
			}
			return h("span", { style: s.meta }, tx("engineOff", { reason: reasonText(tx, engine.reason, label) }));
		}

		function Details({ result, anchor, tx, onClose, inputActions, callId }) {
			const panelRef = React.useRef(null);
			const [position, setPosition] = React.useState({ top: 0, left: 0 });
			const [note, setNote] = React.useState(null);
			const [showAll, setShowAll] = React.useState(false);

			// A running checkup grows the panel, so each new result re-places it.
			React.useLayoutEffect(() => {
				const place = () => {
					if (!anchor || !panelRef.current) return;
					const a = anchor.getBoundingClientRect();
					const p = panelRef.current.getBoundingClientRect();
					const margin = 12;
					let left = Math.min(a.right - p.width, window.innerWidth - p.width - margin);
					left = Math.max(margin, left);
					let top = a.top - p.height - 8;
					if (top < margin) top = Math.min(a.bottom + 8, window.innerHeight - p.height - margin);
					setPosition({ top: Math.max(margin, top), left });
				};
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
				};
			}, [anchor, showAll, result]);

			React.useEffect(() => {
				const onKey = (event) => { if (event.key === "Escape") onClose(); };
				const onPointer = (event) => {
					if (panelRef.current && !panelRef.current.contains(event.target) && !(anchor && anchor.contains(event.target))) onClose();
				};
				document.addEventListener("keydown", onKey);
				document.addEventListener("pointerdown", onPointer, true);
				return () => {
					document.removeEventListener("keydown", onKey);
					document.removeEventListener("pointerdown", onPointer, true);
				};
			}, [anchor, onClose]);

			const running = result.pending === true;
			const label = engineLabel(result.engine);
			const progress = (result.engine && result.engine.progress) || { done: 0, total: 0 };
			const noted = (step) => step.flags.length > 0 || step.mentions.length > 0;
			const flagged = result.steps.filter(noted);
			const waiting = result.steps.filter((step) => !noted(step) && step.pending);
			const others = result.steps.filter((step) => !noted(step) && !step.pending);
			const unchecked = result.steps.find((step) => !step.checked);
			const text = feedbackText(result, tx);
			// Feedback waits for the finished result, so it never leaves out plan-level notes.
			const hasFeedback = !running && result.counts.red + result.counts.orange + result.counts.amber > 0;

			const insert = () => {
				try {
					if (inputActions && typeof inputActions.setDraft === "function") {
						inputActions.setDraft(text);
						setNote(tx("inserted"));
					}
				} catch (error) {
					setNote(String(error && error.message ? error.message : error));
				}
			};
			const copy = () => {
				const done = () => setNote(tx("copied"));
				try {
					navigator.clipboard.writeText(text).then(done, () => setNote(tx("copyFailed")));
				} catch (error) {
					setNote(tx("copyFailed"));
				}
			};

			const ruleLines = (step) => {
				const seen = new Set();
				const lines = [];
				for (const flag of step.flags) {
					for (const rule of flag.rules || []) {
						if (seen.has(rule.id)) continue;
						seen.add(rule.id);
						lines.push(h("span", { key: "r" + rule.id, style: s.rule }, tx("ruleHit", { match: rule.match })));
					}
				}
				return lines;
			};

			const stepItem = (step) => h("li", { key: step.index, style: s.item, "data-plan-checkup-step": step.index },
				h("span", { style: s.stepNo }, tx("step", { n: step.index })),
				h("span", { style: s.stepBody },
					h("span", null, inline(step.firstLine)),
					step.flags.length > 0 || step.pending ? h("span", { style: s.flags },
						step.flags.map((flag) => h(React.Fragment, { key: flag.kind },
							h(FlagPill, { flag, tx }),
							h(VoteButtons, { callId, step: step.index, flag: flag.kind, tx }),
						)),
						step.pending ? h("span", { style: s.meta }, tx("checking")) : null,
					) : null,
					ruleLines(step),
					step.mentions.map((mention) => h("span", { key: "m" + mention.id, style: s.rule }, tx("mention", { match: mention.match, engine: label }))),
				),
			);

			return h("div", {
				ref: panelRef, role: "dialog", "aria-label": tx("badgeLabel"), "data-plan-checkup": "panel",
				style: Object.assign({}, s.panel, { top: position.top + "px", left: position.left + "px" }),
			},
				h("div", { style: s.head },
					h("div", { style: s.headRow },
						h("span", { style: s.title }, running
							? tx("runningSummary", { done: progress.done, total: progress.total })
							: result.counts.flaggedSteps > 0 || result.plan.flags.length > 0
								? tx("summary", { steps: result.totalSteps, flagged: result.counts.flaggedSteps })
								: tx("summaryClean", { steps: result.totalSteps })),
						h("button", { type: "button", style: s.closeBtn, "aria-label": tx("close"), onClick: onClose }, "×"),
					),
					h(EngineLine, { engine: result.engine, tx }),
				),
				result.plan.pending ? h("div", { style: s.more }, tx("planPending")) : null,
				result.plan.flags.map((flag) => h("div", { key: flag.kind, style: s.planWarn },
					h("span", { style: s.flags }, h(FlagPill, { flag, tx }), h(VoteButtons, { callId, step: null, flag: flag.kind, tx })),
					h("span", null, tx("plan." + flag.kind)),
				)),
				h("ol", { style: s.list }, flagged.map(stepItem), showAll ? others.map(stepItem) : null),
				waiting.length > 0 ? h("div", { style: s.more, role: "status" }, tx("pendingSteps", { count: waiting.length })) : null,
				!showAll && others.length > 0 ? h("button", { type: "button", style: Object.assign({}, s.more, { border: "none", background: "transparent", textAlign: "left", cursor: "pointer", font: "inherit", fontSize: "12px" }), onClick: () => setShowAll(true) }, tx("unflagged", { count: others.length }) + " ›") : null,
				unchecked ? h("div", { style: s.more }, tx("unchecked", { from: unchecked.index - 1 })) : null,
				h("div", { style: s.foot },
					hasFeedback && inputActions && typeof inputActions.setDraft === "function" ? h("button", { type: "button", style: s.action, onClick: insert, "data-plan-checkup": "insert" }, tx("insert")) : null,
					hasFeedback ? h("button", { type: "button", style: s.action, onClick: copy, "data-plan-checkup": "copy" }, tx("copy")) : null,
					note ? h("span", { style: s.note, role: "status" }, note) : null,
					h("a", { href: feedbackUrl(result.engine), target: "_blank", rel: "noopener noreferrer", style: s.report, title: tx("reportTitle"), "data-plan-checkup": "report" }, tx("report") + " ↗"),
				),
			);
		}

		function PlanCheckupBadge(props) {
			const review = props.review;
			const callId = review ? review.callId : undefined;
			const state = useCheckup(callId, props.sessionId);
			const [open, setOpen] = React.useState(false);
			const anchorRef = React.useRef(null);
			const lang = state.result ? state.result.lang : "auto";
			const tx = useText(props, lang);

			let content;
			let label;
			let clickable = false;
			if (state.phase === "loading") {
				content = label = tx("checking");
			} else if (state.phase === "unknown" || !state.result || state.result.failed) {
				content = label = tx("unavailable");
			} else if (state.phase === "running") {
				// Rule flags and finished steps show while the engine works through the rest.
				const result = state.result;
				const progress = (result.engine && result.engine.progress) || { done: 0, total: 0 };
				const total = result.counts.red + result.counts.orange + result.counts.amber;
				const name = tx("running", { done: progress.done, total: progress.total });
				clickable = true;
				label = total > 0 ? tx("badgeAria", { label: name, parts: countsLabel(result.counts, tx) }) : name;
				content = h(React.Fragment, null, h("span", null, name), total > 0 ? h(Counts, { counts: result.counts, tx }) : null);
			} else {
				const result = state.result;
				const total = result.counts.red + result.counts.orange + result.counts.amber;
				const rulesOnly = !result.engine || result.engine.state === "off" || result.engine.state === "error";
				const name = rulesOnly ? tx("rulesOnly") : tx("badgeLabel");
				clickable = true;
				label = tx("badgeAria", { label: name, parts: total > 0 ? countsLabel(result.counts, tx) : tx("clean") });
				content = h(React.Fragment, null,
					h("span", null, name),
					total > 0 ? h(Counts, { counts: result.counts, tx }) : h("span", { style: { color: "var(--dsw-alias-state-success-primary, #2f9e44)" } }, tx("clean")),
				);
			}

			const badge = h("button", {
				ref: anchorRef, type: "button", style: Object.assign({}, s.badge, clickable ? null : { cursor: "default" }),
				"aria-label": label, title: label,
				"data-plan-checkup": "badge", "aria-expanded": open ? "true" : "false", "aria-haspopup": "dialog",
				onClick: () => { if (clickable) setOpen(!open); },
			}, content);

			return h("span", { style: s.wrap },
				badge,
				open && clickable ? ReactDOM.createPortal(h(Details, {
					result: state.result, anchor: anchorRef.current, tx, onClose: () => setOpen(false),
					inputActions: props.inputActions, callId,
				}), document.body) : null,
			);
		}

		const inject = ["slots", "locale"];
		function apply(ctx) {
			// zh and en dictionaries follow the dsh UI locale; zh-TW is reachable through the host `lang` setting.
			if (ctx.locale && typeof ctx.locale.register === "function") {
				ctx.effect(() => ctx.locale.register(NS, { zh: STRINGS["zh-CN"], en: STRINGS.en }), "plan-checkup: dictionaries");
			}
			ctx.slots.inject("conversation.plan-review.actions", () => ctx.slots.register({
				name: "conversation.plan-review.actions",
				id: "dsh-plan-checkup",
				order: 200,
				locale: NS,
				label: "Plan checkup",
			}, PlanCheckupBadge));
		}

		exports.apply = apply;
		exports.inject = inject;
		// Pure helpers, exported for the unit tests only.
		exports.__internals = { STRINGS, format, feedbackText, feedbackUrl, PLUGIN_VERSION };
		return module.exports;
	}
});
