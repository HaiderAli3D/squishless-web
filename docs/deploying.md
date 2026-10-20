# Deploying Squishless to Vercel

Squishless is a static site, so it costs nothing to host: the free Vercel **Hobby** plan is
plenty. There is no server code, no database and no environment variable to set.

You can deploy it two ways:

- **A. Connect the GitHub repo** (recommended). Every push makes a preview, and every push
  to `main` updates the live site.
- **B. Deploy from your computer** with the Vercel CLI.

Both use the settings in `vercel.json`, so you don't have to type any build settings.

## Before you start

- A Vercel account (signing up with GitHub is easiest): https://vercel.com/signup
- The code in a GitHub repository (for option A).
- Optional: check that it builds on your machine first, with `npm run build && npm run serve`
  and a look at http://127.0.0.1:8787.

## A. Connect the GitHub repo

1. In the Vercel dashboard, click **Add New... > Project**.
2. Find the `squishless-web` repository and click **Import**. If it isn't listed, use
   **Adjust GitHub App Permissions** to give Vercel access to it.
3. On the configure screen:
   - **Framework Preset:** leave it as **Other**.
   - **Root Directory:** leave it as the repository root (`./`).
   - **Build and Output Settings:** leave them alone. `vercel.json` sets the build command
     (`bash scripts/build-site.sh`), the output directory (`dist`) and the install command.
   - **Environment Variables:** none are needed.
4. Click **Deploy**.

The first build takes a minute or two longer than later ones, because the build script
downloads Go (Vercel's build image doesn't have it). You'll see lines like these in the
build log:

```
[build] no Go >= 1.26.0 installed, using a downloaded Go 1.27.2
[build] building dist/engine/squishless.wasm
[build] precomputing landing hero seams (cmd/heroseams)
[build] done: dist/ (BUILD_ID ...)
```

When it finishes, Vercel shows your site address, something like
`https://squishless-web.vercel.app`. If you want a different `.vercel.app` name, change it
under **Settings > Domains** (see below).

From now on:

- every push to any branch, and every pull request, gets its own **preview** URL;
- every push to `main` updates **production**.

## B. Deploy from your computer (Vercel CLI)

```sh
npm i -g vercel        # once
vercel login           # once
cd squishless-web
vercel                 # first run links the folder to a project, then makes a preview
vercel --prod          # deploy to production
```

The first `vercel` asks a few questions. Accept the defaults; it reads `vercel.json` for
the rest. The build runs on Vercel's servers, not on your machine.

If you prefer to build locally and only upload the result:

```sh
vercel build --prod            # builds into .vercel/output using vercel.json
vercel deploy --prebuilt --prod
```

On Windows, `vercel build` needs Git Bash (or WSL) because the build script is a bash
script.

## Add a custom domain

1. Open your project in Vercel and go to **Settings > Domains**.
2. Type your domain (for example `squishless.example.com` or `example.com`) and click
   **Add**.
3. Vercel then shows the DNS record to create at the company where you bought the domain.
   Typically:
   - for a **subdomain** like `squishless.example.com`: a **CNAME** record named
     `squishless` that points to the target Vercel shows (for example
     `cname.vercel-dns.com`);
   - for a **root domain** like `example.com`: an **A** record named `@` that points to
     the IP address Vercel shows. Vercel will also suggest adding `www.example.com` and
     redirecting one to the other.

   Always copy the exact values from the Vercel screen, because they can differ between
   accounts.
4. Wait for DNS to update. It is usually a few minutes, but it can take up to a day or two.
   The domain shows **Valid Configuration** when it's ready, and Vercel creates the HTTPS
   certificate for you.

Alternatively, you can move the domain's nameservers to Vercel and let it manage the DNS.

## After the first deploy

- **Update the README link.** Search `README.md` for `LIVE_URL` and replace
  `https://squishless.vercel.app` with your real address.
- **Check the headers.** Open the site, press F12, open the **Network** tab, reload, and
  click the page request. Under response headers you should see `content-security-policy`,
  `x-frame-options: DENY` and the others from `vercel.json`. The `squishless.wasm` request
  should have `content-type: application/wasm` and `content-encoding: br`.
- **Check that nothing goes to other sites.** In the same Network tab, every request should
  be to your own domain.
- **Check offline.** Open `/app`, let it load, switch on "Offline" in the Network tab (or
  turn off Wi-Fi) and reload. It should still work.

## What `vercel.json` does

| Setting | Meaning |
| --- | --- |
| `framework: null` | Plain static site, no framework detection |
| `installCommand: echo skip-install` | There are no npm packages to install for the site itself |
| `buildCommand: bash scripts/build-site.sh` | Builds the wasm engine and the site into `dist/` |
| `outputDirectory: dist` | The folder that is published |
| `cleanUrls: true`, `trailingSlash: false` | `/app` serves `app/index.html`, and URLs have no `.html` or trailing slash |
| Headers on every path | Content Security Policy, `Referrer-Policy`, `X-Content-Type-Options`, `Permissions-Policy` (camera, microphone and location off), `Cross-Origin-Opener-Policy`, `X-Frame-Options: DENY` |
| `Cache-Control` for pages | `max-age=0, must-revalidate`, so a new deploy shows up straight away |
| `Cache-Control` for `/engine/`, fonts and `.seams` | one year, `immutable`. Safe, because their URLs carry the build ID and change with each build |
| `Cache-Control` for images and samples | a week, and a day (with `stale-while-revalidate`) |
| `Content-Type` for `*.wasm` | `application/wasm`, so browsers can compile the engine while it downloads |

`scripts/serve.mjs` applies the same headers locally, so what you test is what you deploy.

## Good to know

- **Preview deployments include the `/dev/` test pages** (used by the Playwright tests).
  Production builds remove them: `scripts/postbuild.mjs` drops `dist/dev/` when
  `VERCEL_ENV` is `production`.
- **Vercel Deployment Protection** may ask visitors to log in to see *preview* URLs. That
  is a Vercel setting (**Settings > Deployment Protection**), and production is public.
- **Analytics.** The site has none on purpose, and the privacy promise in the README and
  on the site says so. If you switch on Vercel Web Analytics, update that promise, and add
  the analytics endpoint to the Content Security Policy.
- **Rolling back.** In **Deployments**, open an earlier deployment and choose
  **Promote to Production** (or **Instant Rollback**).
- **Build fails with "automatic install only supports linux-amd64"**: this means the build
  ran on a machine with no Go and not on Linux x64. Install Go from https://go.dev/dl/ on
  that machine, or let Vercel build it.
- **Build fails with "Go download checksum mismatch"**: the download was corrupted or
  changed. Redeploy. If it keeps happening, check `GO_DL_VERSION` and
  `GO_DL_SHA256_LINUX_AMD64` at the top of `scripts/build-site.sh` against
  https://go.dev/dl/.
