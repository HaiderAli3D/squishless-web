#!/usr/bin/env node
// Local static server for dist/ that mimics the Vercel production setup:
// cleanUrls, trailingSlash:false, 404.html with status 404, and the response
// headers from vercel.json (matched with a small subset of path-to-regexp).
// Dependency free. Usage:
//   node scripts/serve.mjs [--dir dist] [--port 8787] [--host 127.0.0.1] [--quiet]
// PORT env var also sets the port (the --port flag wins).

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { dir: 'dist', port: process.env.PORT || '8787', host: '127.0.0.1', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [k, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const val = () => (inline !== undefined ? inline : argv[++i]);
    if (k === '--dir') out.dir = val();
    else if (k === '--port') out.port = val();
    else if (k === '--host') out.host = val();
    else if (k === '--quiet') out.quiet = true;
    else if (k === '--help' || k === '-h') {
      console.log('node scripts/serve.mjs [--dir dist] [--port 8787] [--host 127.0.0.1] [--quiet]');
      process.exit(0);
    } else {
      console.error(`serve: unknown argument ${a}`);
      process.exit(2);
    }
  }
  out.port = Number(out.port);
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
    console.error(`serve: bad port ${out.port}`);
    process.exit(2);
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};
const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json|wasm|xml)|image\/svg\+xml)/;

// ---- path-to-regexp subset -------------------------------------------------
// Supports: literal text, "(regex)" groups (passed through verbatim, nesting ok),
// ":name" params (optionally ":name(regex)"), modifiers ? * + after a param or
// group, and backslash escapes ("\\." in JSON = a literal dot). Matching is
// case-insensitive and allows one optional trailing slash, like path-to-regexp's
// defaults (sensitive:false, strict:false, end:true).
export function compileSource(source) {
  let re = '';
  let i = 0;
  const escape = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const readGroup = () => {
    // at '('; return inner text up to the matching ')'
    let depth = 0;
    const start = i;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '\\') { i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { i++; return source.slice(start + 1, i - 1); } }
    }
    throw new Error(`unbalanced group in source ${source}`);
  };
  const modifier = () => {
    const c = source[i];
    if (c === '?' || c === '*' || c === '+') { i++; return c; }
    return '';
  };
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { re += escape(source[i + 1] ?? ''); i += 2; continue; }
    if (c === '(') { const inner = readGroup(); re += `(${inner})` + modifier(); continue; }
    if (c === ':' && /[A-Za-z0-9_]/.test(source[i + 1] ?? '')) {
      i++;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
      const pattern = source[i] === '(' ? readGroup() : '[^\\/#\\?]+?';
      const mod = modifier();
      // a param after "/" with * or ? makes the slash optional too
      if ((mod === '*' || mod === '?') && re.endsWith('\\/')) {
        re = re.slice(0, -2);
        re += mod === '*' ? `(?:\\/(${pattern}))*` : `(?:\\/(${pattern}))?`;
      } else if (mod === '*' || mod === '+') {
        re += `((?:${pattern})(?:\\/(?:${pattern}))*)${mod === '*' ? '?' : ''}`;
      } else {
        re += `(${pattern})${mod}`;
      }
      continue;
    }
    re += escape(c);
    i++;
  }
  return new RegExp(`^${re}(?:\\/)?$`, 'i');
}

function loadHeaderRules(file) {
  if (!fs.existsSync(file)) return [];
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (cfg.headers || []).map((rule) => ({
    source: rule.source,
    re: compileSource(rule.source),
    headers: rule.headers || [],
  }));
}

// Later rules override earlier ones for the same (case-insensitive) key.
function headersFor(rules, pathname) {
  const out = new Map();
  for (const r of rules) {
    if (!r.re.test(pathname)) continue;
    for (const { key, value } of r.headers) out.set(key.toLowerCase(), [key, value]);
  }
  return out;
}

// ---- file resolution (cleanUrls + trailingSlash:false) ---------------------
async function stat(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

function insideRoot(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Returns { redirect } | { file, st } | null
async function resolve(root, pathname) {
  // trailingSlash:false -> /foo/ redirects to /foo
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return { redirect: pathname.replace(/\/+$/, '') || '/' };
  }
  // cleanUrls: /foo.html -> /foo, /foo/index.html -> /foo, /index.html -> /
  if (/\.html$/i.test(pathname)) {
    let target = pathname.replace(/\.html$/i, '');
    if (/(^|\/)index$/i.test(target)) target = target.replace(/\/?index$/i, '');
    return { redirect: target || '/' };
  }
  const base = path.join(root, pathname);
  if (!insideRoot(root, base)) return null;
  const st = await stat(base);
  if (st && st.isFile()) return { file: base, st };
  for (const cand of [base + '.html', path.join(base, 'index.html')]) {
    const s = await stat(cand);
    if (s && s.isFile()) return { file: cand, st: s };
  }
  return null;
}

// ---- compression cache -----------------------------------------------------
const gzCache = new Map(); // file -> { mtimeMs, buf }
async function gzipped(file, st) {
  const hit = gzCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.buf;
  const raw = await fsp.readFile(file);
  const buf = await new Promise((res, rej) => zlib.gzip(raw, { level: 6 }, (e, b) => (e ? rej(e) : res(b))));
  gzCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, buf });
  return buf;
}

// ---- server ----------------------------------------------------------------
export function createServer({ dir, quiet = false, configFile = path.join(ROOT, 'vercel.json') }) {
  const root = path.resolve(dir);
  const rules = loadHeaderRules(configFile);
  const notFoundFile = path.join(root, '404.html');

  const log = (req, status, t0, note = '') => {
    if (quiet) return;
    const ms = (performance.now() - t0).toFixed(1);
    console.log(`${req.method} ${req.url} ${status} ${ms}ms${note ? ' ' + note : ''}`);
  };

  return http.createServer(async (req, res) => {
    const t0 = performance.now();
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { pathname = null; }
      if (pathname === null || pathname.includes('\0')) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad request');
        return log(req, 400, t0);
      }
      const setHeaders = (p) => {
        for (const [, [k, v]] of headersFor(rules, p)) res.setHeader(k, v);
      };

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        setHeaders(url.pathname);
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed');
        return log(req, 405, t0);
      }

      const found = await resolve(root, pathname);
      if (found && found.redirect) {
        setHeaders(url.pathname);
        res.writeHead(308, { Location: found.redirect + url.search, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Redirecting to ${found.redirect}`);
        return log(req, 308, t0, '-> ' + found.redirect);
      }

      let file, st, status = 200;
      if (found) ({ file, st } = found);
      else {
        status = 404;
        st = await stat(notFoundFile);
        file = st && st.isFile() ? notFoundFile : null;
      }
      setHeaders(url.pathname);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return log(req, 404, t0);
      }

      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', type);
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      res.setHeader('Last-Modified', st.mtime.toUTCString());
      if (status === 200) {
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304);
          res.end();
          return log(req, 304, t0);
        }
      }

      const canGzip = COMPRESSIBLE.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && st.size > 1024;
      if (COMPRESSIBLE.test(type)) res.setHeader('Vary', 'Accept-Encoding');
      if (canGzip) {
        const buf = await gzipped(file, st);
        res.writeHead(status, { 'Content-Encoding': 'gzip', 'Content-Length': buf.length });
        res.end(req.method === 'HEAD' ? undefined : buf);
      } else {
        res.writeHead(status, { 'Content-Length': st.size });
        if (req.method === 'HEAD') res.end();
        else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      }
      log(req, status, t0);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal server error');
      log(req, 500, t0);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.resolve(opts.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`serve: directory not found: ${dir} (run "npm run build" first)`);
    process.exit(1);
  }
  const server = createServer({ dir, quiet: opts.quiet });
  server.on('error', (e) => {
    console.error(`serve: ${e.message}`);
    process.exit(1);
  });
  server.listen(opts.port, opts.host, () => {
    const { port } = server.address();
    console.log(`Serving ${dir} at http://${opts.host}:${port} (Ctrl+C to stop)`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
