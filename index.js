/**
 * dsh-tool-interrupt — host half.
 *
 * Gives the user per-tool-call manual interrupt without ending the session's
 * turn: every dispatched tool call gets its own AbortController via the
 * official `tools/execute` around-dispatch waterfall; aborting it kills only
 * that call, and the user's reason is authored into that call's tool result
 * so the model reads it in the SAME turn and adapts. The step signal (and
 * therefore the session/turn) is never touched.
 *
 * Mechanism (verified against @deepseek-ai/dsh-tools ToolRuntime):
 * - `dispatchScheduledExecution` runs the body behind
 *   `ctx.waterfall('tools/execute', mutableExec, () => dispatchToolBody(exec))`
 *   and explicitly passes a mutable exec, so replacing `exec.signal` with a
 *   per-call controller is the intended wrapper move.
 * - `dispatchToolBody` fuses our wrapper signal with the step signal
 *   (`fuseToolSignals`): our abort stops only this call; the body always
 *   reaches quiescence, and abort outcomes become error RESULTS (never
 *   rejections), so the agent loop commits them and continues the turn.
 *
 * Loopback HTTP surface for the browser half:
 *   GET  /dsh-tool-interrupt/in-flight?sessionId=...  → running calls
 *   POST /dsh-tool-interrupt/interrupt { sessionId, callId, reason }
 */

/** Registry key for one in-flight call. */
function entryKey(sessionId, callId) {
	return `${sessionId}::${callId}`;
}

/** Short, display-only preview of the call arguments (never full secrets). */
function previewArgs(args) {
	if (args === null || args === undefined) return "";
	if (typeof args === "string") return args.length > 160 ? `${args.slice(0, 160)}…` : args;
	try {
		const text = JSON.stringify(args);
		return text.length > 160 ? `${text.slice(0, 160)}…` : text;
	} catch {
		return String(args).slice(0, 160);
	}
}

/** Model-facing result when the interrupt landed before completion. */
function interruptedResult(prior, reason) {
	const base = prior && typeof prior === "object" ? prior : {};
	const additionalContexts = Array.isArray(base.additionalContexts) ? base.additionalContexts : [];
	const hasReason = typeof reason === "string" && reason.trim() !== "";
	const text = hasReason
		? [
			`【用户手动中断】中断理由：${reason.trim()}`,
			"请根据该理由调整后续计划；如认为仍需类似操作，请先说明意图并确认用户同意，不要原样重试。"
		].join("\n")
		: "【用户手动中断】未提供理由";
	return {
		content: [{
			type: "text",
			text
		}],
		isError: true,
		error: {
			message: hasReason ? `tool call interrupted by user: ${reason.trim()}` : "tool call interrupted by user",
			info: { name: "AbortError", code: "USER_INTERRUPTED", ...(hasReason ? { reason: reason.trim() } : {}) }
		},
		...(additionalContexts.length > 0 ? { additionalContexts } : {})
	};
}

/** Model-facing note when the body finished before the interrupt landed. */
function completedWithInterruptNote(prior, reason) {
	const base = prior && typeof prior === "object" ? prior : {};
	const content = Array.isArray(base.content) ? [...base.content] : [];
	content.push({
		type: "text",
		text: `【注意】该调用运行期间用户曾请求中断（理由：${reason}），但调用已先行完成。请结合该理由决定后续动作。`
	});
	return { ...base, content };
}

/** Read and parse a JSON request body. */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const raw = Buffer.concat(chunks).toString("utf8");
				resolve(raw ? JSON.parse(raw) : {});
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

/** Minimal JSON response helper. */
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Host loader entry. */
export function apply(ctx) {
	/** callId-keyed live registry of dispatched tool calls. */
	const inFlight = new Map();

	// Around every dispatched tool body: give the call its own abort signal,
	// track it, and — when the user interrupted it — author the reason into
	// the tool result the model reads in the same turn.
	ctx.on("tools/execute", async (exec, next) => {
		const sessionId = exec.agent?.id ?? "(no-agent)";
		const key = entryKey(sessionId, exec.callId);
		const controller = new AbortController();
		const entry = {
			callId: exec.callId,
			name: exec.name,
			argsPreview: previewArgs(exec.arguments),
			sessionId,
			nested: exec.parent !== undefined,
			startedAt: Date.now(),
			controller,
			interrupted: false,
			reason: ""
		};
		inFlight.set(key, entry);
		exec.signal = controller.signal;
		try {
			const result = await next();
			if (entry.interrupted) {
				return result?.isError === true
					? interruptedResult(result, entry.reason)
					: completedWithInterruptNote(result, entry.reason);
			}
			return result;
		} finally {
			inFlight.delete(key);
		}
	});

	// Wait for the web server service: at cold boot this plugin may load
	// before the webServer service is ready, and a synchronous ctx.get would
	// silently return undefined (no routes). ctx.inject defers registration
	// until the service exists and tears it down with the injection scope.
	ctx.inject(["webServer"], (scope) => {
		const webServer = scope.get("webServer");

		// Route disposers are wired as effect cleanup: a rolled-back or
		// disposed fiber then unregisters its routes, so a reload (HMR or manager
		// cycle) re-registers cleanly instead of dying on "duplicate exact route".
		const disposeInFlight = webServer.register({
		kind: "exact",
		path: "/dsh-tool-interrupt/in-flight",
		handler: async (req, res) => {
			if (req.method !== "GET") {
				writeJson(res, 405, { ok: false, reason: "method-not-allowed" });
				return;
			}
			const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId");
			const calls = [];
			for (const entry of inFlight.values()) {
				if (sessionId && entry.sessionId !== sessionId) continue;
				calls.push({
					callId: entry.callId,
					name: entry.name,
					argsPreview: entry.argsPreview,
					sessionId: entry.sessionId,
					nested: entry.nested,
					startedAt: entry.startedAt,
					interrupted: entry.interrupted,
					reason: entry.interrupted ? entry.reason : undefined
				});
			}
			writeJson(res, 200, { ok: true, calls });
		}
	});

	const disposeInterrupt = webServer.register({
		kind: "exact",
		path: "/dsh-tool-interrupt/interrupt",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				writeJson(res, 405, { ok: false, reason: "method-not-allowed" });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch {
				writeJson(res, 400, { ok: false, reason: "invalid-json" });
				return;
			}
			const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : null;
			const callId = typeof body.callId === "string" && body.callId !== "" ? body.callId : null;
			const reason = typeof body.reason === "string" ? body.reason.trim() : "";
			if (!sessionId || !callId) {
				writeJson(res, 400, { ok: false, reason: "missing-session-id-or-call-id" });
				return;
			}
			const entry = inFlight.get(entryKey(sessionId, callId));
			if (!entry) {
				writeJson(res, 404, { ok: false, reason: "not-running" });
				return;
			}
			entry.interrupted = true;
			entry.reason = reason;
			entry.controller.abort(new Error(`user interrupt${reason !== "" ? `: ${reason}` : ""}`));
			writeJson(res, 200, { ok: true, callId: entry.callId, name: entry.name });
		}
	});

	scope.effect(() => () => {
		disposeInFlight();
		disposeInterrupt();
	}, "dsh-tool-interrupt: routes");
	});
}
