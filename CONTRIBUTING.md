# Contributing to Squishless

Thanks for wanting to help! Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/HaiderAli3D/squishless-web/issues) and include:

- your browser and device (for example "Safari 18, iPhone 14");
- what you did, what you expected and what happened;
- the photo size (in pixels) if it's about resizing. Please don't attach private photos;
  a sample photo or a screenshot is enough.

## Making a change

1. Read [docs/architecture.md](docs/architecture.md) for the tour, and
   [ARCHITECTURE.md](ARCHITECTURE.md) for the exact interfaces. If your change alters an
   interface, update ARCHITECTURE.md in the same pull request.
2. Build and run it locally (you need Go, Node 22+ and bash):

   ```sh
   npm run build && npm run serve    # http://127.0.0.1:8787
   ```

3. Run the tests:

   ```sh
   go vet ./... && go test ./...
   node scripts/wasm-smoke.mjs
   npx playwright test               # or --project=chromium while working
   ```

4. Open a pull request with a short description and, for UI changes, a screenshot.

## House rules

- **Privacy first.** No requests to other sites, no analytics, no cookies, no CDNs. Fonts
  and all other files are self-hosted.
- **Keep it plain.** HTML, CSS and ES modules, with no framework, bundler or npm runtime
  dependency.
- **Respect the Content Security Policy:** no inline `<script>`, no `style="..."`
  attributes and no `eval`. Setting `element.style` from JavaScript is fine.
- **No `<select>` elements.** Use segmented controls, radio groups or a custom listbox.
- **Use the design system.** Check `/styleguide.html` and the class index at the top of
  `site/assets/css/base.css` before adding new styles, and use the tokens in `tokens.css`.
- **Test on phones too.** The Playwright projects include Pixel 7 and iPhone 14 emulation,
  and everything should work by touch and by keyboard.

## Licence

The licence for the project's own code has not been chosen yet (see the README). Please
mention in your pull request that you agree to your contribution being released under the
licence the project adopts.
