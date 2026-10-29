// dsh-tool-interrupt — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules and executed through the vendored cordis
// Loader's lazy-CJS module table (window.__ModuleLoader__.load).
//
// UI strategy: REPLACE the native stop behavior of the session-header 后台任务
// menu. A capture-phase click interceptor hijacks the first press of a row's
// stop button (`button[data-kill-state]`, two-press native kill) when the row
// maps to an in-flight model tool call: a minimal "为何中断" dialog opens — one
// textarea (optional reason) and two buttons. Confirm interrupts ONLY that
// call; the reason returns to the model as that call's tool result and the
// turn keeps going. Rows that do not map (plain background jobs) fall through
// to the native two-press kill unchanged.

window.__ModuleLoader__.load({
	id: 'dsh-tool-interrupt',
	factory: (require) => {
		var React = require('react')
		var h = React.createElement

		// ============ shared state ============
		let dialogOpen = false
		/** The in-flight call the user asked to interrupt: {sessionId, callId, name}. */
		let dialogTarget = null
		const listeners = new Set()
		/** Cached in-flight top-level calls, refreshed by the background poller. */
		let cachedCalls = []

		function subscribe(fn) {
			listeners.add(fn)
			return () => listeners.delete(fn)
		}

		function notify() {
			listeners.forEach((fn) => {
				try { fn() } catch (e) { /* ignore */ }
			})
		}

		function openDialog(target) {
			dialogTarget = target
			dialogOpen = true
			notify()
		}

		function closeDialog() {
			dialogOpen = false
			dialogTarget = null
			notify()
		}

		function fetchInFlight() {
			return fetch('/dsh-tool-interrupt/in-flight')
				.then((r) => r.json())
				.catch(() => ({ ok: false, calls: [] }))
		}

		function postInterrupt(sessionId, callId, reason) {
			return fetch('/dsh-tool-interrupt/interrupt', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ sessionId: sessionId, callId: callId, reason: reason }),
			})
				.then((r) => r.json())
				.catch(() => ({ ok: false }))
		}

		// ============ native stop interception (jobs menu row stop) ============
		// The session-header 后台任务 menu renders one two-press stop button per
		// running row: `button[data-kill-state]` (idle → armed → kill through the
		// job controller). We hijack the FIRST press when the row maps to an
		// in-flight model tool call; other rows keep the native behavior.

		var STOP_TITLE_PREFIXES = ['停止任务 ', 'Stop task ']

		function rowLabelOf(btn) {
			var title = btn.getAttribute('title') || btn.getAttribute('aria-label') || ''
			for (var i = 0; i < STOP_TITLE_PREFIXES.length; i++) {
				var p = STOP_TITLE_PREFIXES[i]
				if (title.startsWith(p)) return title.slice(p.length)
			}
			return title
		}

		/** Unescape the JSON-stringified args preview back to raw text. */
		function unescapePreview(preview) {
			return String(preview || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, ' ')
		}

		function matchesCall(call, label) {
			if (!label) return false
			var hay = unescapePreview(call.argsPreview).replace(/["\\]/g, '')
			var long = label.replace(/["\\]/g, '').slice(0, 40)
			if (long && hay.indexOf(long) >= 0) return true
			var short = label.replace(/["\\]/g, '').slice(0, 12)
			return !!short && hay.indexOf(short) >= 0
		}

		function onClickCapture(e) {
			if (e.defaultPrevented) return
			var target = e.target
			var btn = target && target.closest ? target.closest('button[data-kill-state]') : null
			if (!btn) return
			if (btn.getAttribute('data-kill-state') !== 'idle') return
			// Synchronous decision from the poller cache: hijack only when this
			// row maps to a live model tool call; else let the native kill run.
			var label = rowLabelOf(btn)
			var hit = null
			for (var i = 0; i < cachedCalls.length; i++) {
				if (matchesCall(cachedCalls[i], label)) { hit = cachedCalls[i]; break }
			}
			// eslint-disable-next-line no-console
			console.info('[dsh-tool-interrupt] stop pressed', { label: label, cached: cachedCalls.length, matched: hit ? hit.callId : null })
			if (!hit) return
			e.preventDefault()
			e.stopPropagation()
			e.stopImmediatePropagation()
			openDialog(hit)
		}

		// ============ interrupt dialog ============
		function InterruptDialog() {
			var forceState = React.useReducer(function (x) { return x + 1 }, 0)
			var force = forceState[1]
			var reasonState = React.useState('')
			var reason = reasonState[0]
			var setReason = reasonState[1]
			var open = dialogOpen

			React.useEffect(() => subscribe(force), [])

			// Clear the draft each time the dialog opens.
			React.useEffect(() => {
				if (open) setReason('')
			}, [open])

			if (!open) return null

			var submit = function () {
				var t = dialogTarget
				closeDialog()
				if (!t) return
				postInterrupt(t.sessionId, t.callId, reason)
			}

			var onKeyDown = function (e) {
				if (e.key === 'Escape') {
					e.preventDefault()
					closeDialog()
				} else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
					e.preventDefault()
					submit()
				}
			}

			return h('div', { className: 'dti-mask', onClick: closeDialog },
				h('div', {
					className: 'dti-card',
					onClick: function (e) { e.stopPropagation() },
					role: 'dialog',
					'aria-label': '为何中断',
				},
					h('div', { className: 'dti-title' }, '为何中断'),
					h('textarea', {
						className: 'dti-reason',
						value: reason,
						placeholder: '填写理由或直接提交……',
						onChange: function (e) { setReason(e.target.value) },
						onKeyDown: onKeyDown,
						rows: 3,
						spellCheck: false,
						autoFocus: true,
					}),
					h('div', { className: 'dti-actions' },
						h('button', { className: 'dti-act dti-cancel', onClick: closeDialog }, '取消'),
						h('button', { className: 'dti-act dti-stop', onClick: submit }, '中断'),
					),
				),
			)
		}

		// ============ plugin entry ============
		function apply(ctx) {
			ctx.effect(() => {
				var tag = document.createElement('style')
				tag.textContent = [
					// Theme: raw DSH alias tokens only — the theme system provides
					// light/dark values for every one of them (verified against the
					// shipped Theme service catalog), so both modes stay correct.
					'.dti-mask { position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.45); pointer-events:auto; }',
					'.dti-card { width:min(420px,92vw); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); box-shadow:var(--dsw-elevation-prominent); padding:20px; display:flex; flex-direction:column; gap:14px; pointer-events:auto; font-family:inherit; }',
					'.dti-title { font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }',
					'.dti-reason { width:100%; box-sizing:border-box; min-height:88px; resize:vertical; background:transparent; color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md); padding:10px 12px; font-size:13px; line-height:1.6; font-family:inherit; outline:none; }',
					'.dti-reason::placeholder { color:var(--dsw-alias-label-tertiary); }',
					'.dti-reason:focus { border-color:var(--dsw-alias-brand-primary); }',
					'.dti-actions { display:flex; justify-content:flex-end; gap:8px; }',
					'.dti-act { height:30px; padding:0 16px; border-radius:var(--dsw-radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:1px solid transparent; }',
					'.dti-act.dti-cancel { background:transparent; color:var(--dsw-alias-label-secondary); border-color:var(--dsw-alias-border-l2); }',
					'.dti-act.dti-cancel:hover { color:var(--dsw-alias-label-primary); }',
					// Destructive primary mirrors the shipped jobs stop-armed style:
					// error accent as text/border over a light error tint — readable
					// in both light and dark themes without hard-coded colors.
					'.dti-act.dti-stop { color:var(--dsw-alias-state-error-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }',
					'.dti-act.dti-stop:hover { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent); }',
				].join('\n')
				document.head.append(tag)
				return () => tag.remove()
			}, 'dsh-tool-interrupt: styles')

			// Background poller keeping the in-flight cache warm so the click
			// interceptor can decide synchronously.
			ctx.effect(() => {
				var timer = setInterval(function () {
					if (document.hidden) return
					fetchInFlight().then(function (j) {
						cachedCalls = (j && Array.isArray(j.calls)) ? j.calls.filter(function (c) { return !c.nested }) : []
					})
				}, 1000)
				return function () { clearInterval(timer) }
			}, 'dsh-tool-interrupt: poller')

			// Capture-phase interception of the jobs-menu row stop button.
			ctx.effect(() => {
				document.addEventListener('click', onClickCapture, true)
				return function () { document.removeEventListener('click', onClickCapture, true) }
			}, 'dsh-tool-interrupt: stop interception')

			var slots = ctx.slots
			if (!slots) return

			slots.inject('shell.overlay', () => slots.register(
				{ name: 'shell.overlay', id: 'tool-interrupt-dialog' },
				InterruptDialog,
			), 'dsh-tool-interrupt: dialog')
		}

		return {
			inject: ['slots'],
			apply: apply,
		}
	},
})
