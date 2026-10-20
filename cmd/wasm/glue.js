
// --- Squishless glue (cmd/wasm/glue.js, appended by scripts/build-site.sh) ---
// A Go function cannot throw into its JS caller, so the engine's raw functions return
// an Error object on failure. When the Go program starts it hands its raw API to
// __squishlessInstall, which installs globalThis.squishless with wrappers that throw.
(() => {
	"use strict";
	const g = globalThis;
	g.__squishlessInstall = (raw) => {
		const throwing = (fn) => function (...args) {
			const r = fn(...args);
			if (r instanceof Error) throw r;
			return r;
		};
		g.squishless = Object.freeze({
			version: raw.version,
			resize: throwing(raw.resize),
			seamOrder: throwing(raw.seamOrder),
		});
	};
})();
