#!/usr/bin/env bash
# Builds the static site into dist/:
#   - finds Go (PATH, then ~/.local/gosdk, then the dev machine's SDK), or downloads a
#     pinned release into a cache dir (Vercel's build image has no Go);
#   - copies site/ to dist/;
#   - builds dist/engine/squishless.wasm (GOOS=js GOARCH=wasm);
#   - copies the matching wasm_exec.js and appends cmd/wasm/glue.js to it;
#   - computes BUILD_ID and runs scripts/postbuild.mjs (if present).
# The build happens in a temporary folder (.dist-build-*) that replaces dist/ only when
# it is complete, and builds take turns (lock dir .build-lock), so a server or test run
# reading dist/ never sees a half-built site and parallel builds do not break each other.
# Works on Linux and in Git Bash on Windows. See ARCHITECTURE.md "Build pipeline conventions".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Pinned Go release downloaded when no suitable Go is installed (linux-amd64 only).
GO_DL_VERSION="1.27.2"
GO_DL_SHA256_LINUX_AMD64="ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5"

log() { printf '[build] %s\n' "$*"; }
die() { printf '[build] error: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is required"

# Minimum Go version from go.mod ("go 1.26.0").
GO_MIN="$(sed -n 's/^go \([0-9][0-9.]*\).*/\1/p' go.mod | head -n1)"
[ -n "$GO_MIN" ] || die "cannot read the go version from go.mod"

# version_ge A B: true when version A >= B (dotted numbers).
version_ge() {
	[ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$2" ]
}

# go_ok BIN: BIN runs and is at least GO_MIN.
go_ok() {
	local v
	v="$("$1" env GOVERSION 2>/dev/null)" || return 1
	v="${v#go}"
	v="${v%%[!0-9.]*}" # strip suffixes like "rc1" or " X:..."
	[ -n "$v" ] && version_ge "$v" "$GO_MIN"
}

find_go() {
	local c
	for c in "$(command -v go 2>/dev/null || true)" \
		"$HOME/.local/gosdk/go/bin/go" \
		"/c/Users/mrhai/.local/gosdk/go/bin/go"; do
		[ -n "$c" ] || continue
		for b in "$c" "$c.exe"; do
			if [ -x "$b" ] && go_ok "$b"; then
				printf '%s\n' "$b"
				return 0
			fi
		done
	done
	return 1
}

cache_dir() {
	if [ -n "${GO_INSTALL_DIR:-}" ]; then
		printf '%s\n' "$GO_INSTALL_DIR"
	elif [ -n "${VERCEL_CACHE_DIR:-}" ]; then
		printf '%s\n' "$VERCEL_CACHE_DIR/squishless-go"
	elif [ -d "$ROOT/node_modules" ]; then
		printf '%s\n' "$ROOT/node_modules/.cache/squishless-go"
	else
		printf '%s\n' "${TMPDIR:-/tmp}/squishless-go"
	fi
}

install_go() {
	local os arch dir tgz url sum
	os="$(uname -s)"
	arch="$(uname -m)"
	[ "$os" = "Linux" ] && { [ "$arch" = "x86_64" ] || [ "$arch" = "amd64" ]; } ||
		die "no Go >= $GO_MIN found and automatic install only supports linux-amd64 ($os $arch); install Go from https://go.dev/dl/"
	dir="$(cache_dir)/go$GO_DL_VERSION"
	if [ -x "$dir/go/bin/go" ] && go_ok "$dir/go/bin/go"; then
		log "using cached Go $GO_DL_VERSION in $dir" >&2
		printf '%s\n' "$dir/go/bin/go"
		return 0
	fi
	command -v curl >/dev/null 2>&1 || die "curl is required to download Go"
	mkdir -p "$dir"
	tgz="$dir/go.tar.gz"
	url="https://go.dev/dl/go$GO_DL_VERSION.linux-amd64.tar.gz"
	log "downloading $url" >&2
	curl -fsSL --retry 3 -o "$tgz" "$url"
	if command -v sha256sum >/dev/null 2>&1; then
		sum="$(sha256sum "$tgz" | cut -d' ' -f1)"
	else
		sum="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tgz")"
	fi
	[ "$sum" = "$GO_DL_SHA256_LINUX_AMD64" ] || { rm -f "$tgz"; die "Go download checksum mismatch ($sum)"; }
	rm -rf "$dir/go"
	tar -C "$dir" -xzf "$tgz"
	rm -f "$tgz"
	go_ok "$dir/go/bin/go" || die "downloaded Go does not run"
	printf '%s\n' "$dir/go/bin/go"
}

GO="$(find_go || true)"
if [ -z "$GO" ]; then
	log "no Go >= $GO_MIN installed, using a downloaded Go $GO_DL_VERSION"
	GO="$(install_go)"
	# Keep module and build caches next to the cached toolchain (survives Vercel builds).
	CACHE_ROOT="$(dirname "$(dirname "$(dirname "$GO")")")"
	export GOMODCACHE="${GOMODCACHE:-$CACHE_ROOT/mod}"
	export GOCACHE="${GOCACHE:-$CACHE_ROOT/build}"
fi
export GOTOOLCHAIN=local
log "using $("$GO" version) ($GO)"

GOROOT_DIR="$("$GO" env GOROOT)"
if command -v cygpath >/dev/null 2>&1; then
	GOROOT_DIR="$(cygpath -u "$GOROOT_DIR")"
fi
WASM_EXEC=""
for p in "$GOROOT_DIR/lib/wasm/wasm_exec.js" "$GOROOT_DIR/misc/wasm/wasm_exec.js"; do
	if [ -f "$p" ]; then
		WASM_EXEC="$p"
		break
	fi
done
[ -n "$WASM_EXEC" ] || die "wasm_exec.js not found in $GOROOT_DIR"

# --- one build at a time, into a temporary folder ---
LOCK="$ROOT/.build-lock"
OUT=".dist-build-$$"
lock_acquired=0
cleanup() {
	rm -rf "$ROOT/$OUT" 2>/dev/null || true
	if [ "$lock_acquired" = 1 ]; then rm -rf "$LOCK" 2>/dev/null || true; fi
}
trap cleanup EXIT
waited=0
until mkdir "$LOCK" 2>/dev/null; do
	# A lock older than 15 minutes was left by a build that was killed.
	if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
		log "removing a stale build lock"
		rm -rf "$LOCK"
		continue
	fi
	[ "$waited" = 0 ] && log "another build is running; waiting for it"
	waited=$((waited + 1))
	[ "$waited" -le 900 ] || die "timed out waiting for the build lock $LOCK"
	sleep 1
done
lock_acquired=1
rm -rf .dist-build-* .dist-old-* 2>/dev/null || true

# Fresh $OUT from site/.
mkdir -p "$OUT"
cp -R site/. "$OUT/"
mkdir -p "$OUT/engine"

ENGINE_VERSION="1.0.0"
COMMIT="${VERCEL_GIT_COMMIT_SHA:-$(git rev-parse --verify -q HEAD 2>/dev/null || true)}"
if [ -n "$COMMIT" ]; then
	ENGINE_VERSION="$ENGINE_VERSION+${COMMIT:0:12}"
fi

log "building dist/engine/squishless.wasm"
GOOS=js GOARCH=wasm "$GO" build -trimpath \
	-ldflags="-s -w -X main.version=$ENGINE_VERSION" \
	-o "$OUT/engine/squishless.wasm" ./cmd/wasm

{
	cat "$WASM_EXEC"
	cat cmd/wasm/glue.js
} >"$OUT/engine/wasm_exec.js"

# --- Landing team step: precomputed hero seams + gallery images (cmd/heroseams) ---
# Writes dist/assets/landing/ (hero photos, .seams files, gallery) and the lossless
# test fixtures in dist/dev/landing/ (dist/dev/ is dropped from production builds).
log "precomputing landing hero seams (cmd/heroseams)"
"$GO" run ./cmd/heroseams -samples site/samples -out "$OUT/assets/landing" -dev "$OUT/dev/landing"
# --- end Landing team step ---

# BUILD_ID: first 12 hex of a sha256 over the engine files and every site file
# (path + content, sorted by path, so it is stable across machines).
BUILD_ID="$(OUT="$OUT" node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p);
  }
};
walk("site");
// Engine files are hashed under their dist/ names (the build folder name varies).
const engine = ["engine/squishless.wasm", "engine/wasm_exec.js"].map((f) => ["dist/" + f, path.join(process.env.OUT, f)]);
const list = [...engine, ...files.map((f) => [f.split(path.sep).join("/"), f]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))];
const h = crypto.createHash("sha256");
for (const [name, file] of list) { h.update(name + "\0"); h.update(fs.readFileSync(file)); h.update("\0"); }
process.stdout.write(h.digest("hex").slice(0, 12));
')"
log "BUILD_ID=$BUILD_ID"

if [ -f scripts/postbuild.mjs ]; then
	log "running scripts/postbuild.mjs"
	node scripts/postbuild.mjs "$OUT" "$BUILD_ID"
else
	log "scripts/postbuild.mjs not found, skipping (BUILD_ID tokens are left in place)"
fi

node -e '
const fs = require("fs"), zlib = require("zlib");
const kb = (n) => (n / 1024).toFixed(0).padStart(6) + " KiB";
for (const f of process.argv.slice(1)) {
  const b = fs.readFileSync(f);
  const gz = zlib.gzipSync(b, { level: 9 }).length;
  const br = zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  console.log(`[build] ${f}: raw ${kb(b.length)}, gzip ${kb(gz)}, brotli ${kb(br)}`);
}' "$OUT/engine/squishless.wasm" "$OUT/engine/wasm_exec.js"

# Swap the finished build in. Renaming a folder can fail briefly on Windows while a
# server holds a file in it open, so retry; the old dist/ is deleted afterwards.
OLD=".dist-old-$$"
swapped=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
	if [ -e dist ] && ! mv dist "$OLD" 2>/dev/null; then
		sleep 0.5
		continue
	fi
	if mv "$OUT" dist 2>/dev/null; then
		swapped=1
		break
	fi
	sleep 0.5
done
if [ "$swapped" != 1 ]; then
	log "could not rename the build into place; copying it instead"
	rm -rf dist
	cp -R "$OUT" dist
fi
rm -rf "$OLD" 2>/dev/null || true

log "done: dist/ (BUILD_ID $BUILD_ID)"
