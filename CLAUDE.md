# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Lumi is an Electron + React + TypeScript desktop client for New API. It displays account usage and published model pricing, reads local Codex/Claude sessions, and directly configures Codex CLI and Claude Code CLI (not Claude Desktop). The UI and primary documentation are Chinese. Published desktop targets are Windows x64 and macOS Apple Silicon ARM64; Linux is covered by checks but has no supported release package.

## Commands

Run commands from the repository root. Use Node.js 24+ and npm 11+; `.nvmrc` and `package.json` record the toolchain. Node 24 is also needed for built-in SQLite support.

```bash
npm ci --ignore-scripts
npm run setup:electron
npm run dev
```

This is the controlled install sequence used by CI. `setup:electron` downloads the desktop runtime explicitly; omitting it can cause local Chromium-backed tests to skip coverage. npm/Electron download caches live under `.cache/`.

| Command | Purpose / prerequisite |
| --- | --- |
| `npm run dev` | Builds Electron/native code, starts Vite at `http://127.0.0.1:5173`, then launches Electron. |
| `npm run dev:web` | Renderer/public-information preview only; no desktop credentials or tool configuration. |
| `npm run typecheck` | Strict TypeScript checking across renderer, Electron, shared code, tests, and Vite config. There is no lint script. |
| `npm test` | Runs `pretest`, then `tsx --test --test-concurrency=4 tests/*.test.ts` using Node's built-in test runner. No production build is required. |
| `npm run build` | Typecheck → Vite renderer build → esbuild Electron/native build → dependency-license generation. |
| `npm run preview` | Previews the built renderer after a build. |
| `npm run test:desktop` | Hidden Electron smoke of the checkout; run `npm run build` first and leave `LUMI_DEV_URL` unset. |
| `npm run dist` | Rebuilds and creates the platform installer; local packaging does not publish. |
| `npm run dist:dir` | Rebuilds and creates an unpacked application directory. |
| `npm run verify:release` | Verifies the current full installer and packaged assets against the current build; regenerates `SHA256SUMS.txt`. |
| `npm run prepare:release` | Validates version/changelog consistency and a clean tracked tree, then archives HEAD and writes source ZIP/release notes under `release/`. |
| `npm run check:secrets` | Checks indexed Git blobs, not untracked files or unstaged working-tree bytes. |
| `npm run check:history` | Checks history reachable from HEAD. |

Vite reloads renderer changes, but `dev` is **not** an Electron watch/restart loop: restart it after main-process, preload, or native changes. On macOS, building also compiles/signs `native/macos/UsageMenuBar.swift` and requires Apple command-line tools/SDK; release packaging requires an ARM64 host.

### Targeted tests

Direct Node invocations bypass npm's `pretest` lifecycle. Prepare `.test-data/` first; fixtures may assume that parent exists. Put Node test-selection flags before the test filename.

```bash
npm run pretest
node --import tsx --test tests/core.test.ts
node --import tsx --test --test-name-pattern="site URLs are normalized" tests/core.test.ts
```

Tests use isolated fixtures under `.test-data/`, sometimes real hidden Electron/Chromium windows, temporary Git repositories, or disk-backed SQLite indexes. Use local mocks and fake credentials, not real accounts, CLI configuration directories, or paid model calls. Headless Linux checks use `xvfb-run -a npm test` with the Chromium sandbox configured as in `.github/workflows/ci.yml`; do not substitute `--no-sandbox`.

Development isolates Lumi's application data but **not** the user's CLI home. For fixture-driven desktop runs, `LUMI_TEST_DATA` redirects app/session data and `LUMI_TEST_HOME` redirects CLI config/session services. The official desktop smoke runner sets both. It launches `electron .` against `dist/` and `dist-electron/`, not the packaged executable.

### Packaging and hooks

`verify:release` supports Windows x64/macOS ARM64 full releases, not Linux or a fresh `dist:dir` alone; it checks archive integrity rather than launching/installing the package. `LUMI_RELEASE_DIR` selects the output for packaging **and** verification, so use the same value for both. It does not redirect `prepare:release`, which always writes to `release/`. See `docs/RELEASING.md` for platform and tag-release requirements.

Optional repository hooks:

```bash
git config --local core.hooksPath .githooks
```

Pre-commit checks staged changes; pre-push checks the reachable history of pushed refs. These hooks do not run tests/typechecking. Build/package/test outputs, local research, sessions, screenshots, and application data are ignored; historical results in `docs/VALIDATION.md` are not evidence that a new build has been validated.

## Architecture and change boundaries

- **Built-in plugins:** `plugins/manifests.ts` contains static metadata; `shared/contracts/` and `shared/plugin-host.ts` define scoped capabilities and lifecycle. Main/renderer registries are separate (`electron/host/plugins.ts`, `src/host/renderer-registry.ts`). NewAPI, Codex, Widget and Tray are the four configurable product plugins; Workbench, Usage, Models, Tokens and Tools are fixed uniform system surfaces. New API contributes their concrete content and owns account/protocol/token services and dedicated-token policy. Local sessions, CLI formatting adapters, desktop projections and the default theme have independent modules. Retain generation guards, immediate disposal of revoked motion children, Settings drafts, and operation locks around tool preview/apply/restore/install. Shared Dashboard/AppContext still have migration work; see `docs/PLUGINS.md`.

- **Privileged runtime:** `electron/main.ts` composes services for networking, encrypted settings, CLI configuration, local sessions, desktop panels, and updates. `electron/preload.ts` exposes a fixed, typed `window.lumi` API. `shared/types.ts` defines its DTOs/contracts and defaults. Main-process handlers validate arguments and sender window/frame/origin; renderer code does not get arbitrary IPC, filesystem, or network access. A new operation usually spans the shared contract, preload, validated main handler/service, and browser fallback.
- **Renderer adapter:** Use `src/bridge.ts`, which selects `window.lumi` or a restricted browser implementation. Browser mode persists nonsecret preferences and reads public status through Vite's `/_lumi/public-status` endpoint; authenticated operations, local sessions, and configuration writes are desktop-only. Browser preview is not desktop integration coverage. The default `https://api.example.com` site is a placeholder and must not produce requests.
- **Persistence:** `electron/services/store.ts` serializes atomic settings writes in Electron's user-data directory and encrypts credentials with `safeStorage`; configuration backups use the same system-encryption boundary. There is no plaintext fallback when secure storage is unavailable. Account read caches and bounded, redacted application logs remain process-memory only; cache cleanup is not a settings/backups/tool-data reset.
- **App state:** `src/App.tsx` owns `AppContext`, lazy page navigation (no router), bootstrap, dashboard queries, and preference updates. Bootstrap returns local settings first; tool config inspection follows asynchronously. Preferences update optimistically but persist through a serialized queue. Request/version guards reject stale results: range changes within one account retain the prior dashboard until replacement, while account changes clear it immediately. Preserve those distinctions when adding async work.
- **Site selections:** `src/selections.ts` and `shared/selections.ts` route persisted page/filter choices through `{selection: {siteId, values}}`. Use the explicit site-scoped patch rather than separate component storage. Account/site scope must also govern caches, config previews, and panel snapshots, not just React page keys.
- **Desktop surfaces:** `widget.html`/`src/widget.tsx` and `tray.html`/`src/tray.tsx` are separate renderers with restricted preloads, not consumers of the main AppContext. They receive formatted usage snapshots and limited actions, never the main window's account/config privileges. macOS uses a Swift/AppKit menu-bar helper with constrained stdin/stdout messages; it does not read credentials or contact sites. Windows and macOS updater services are separate from the New API account client.
- **Styling:** `src/main.tsx` imports global cascade layers in order: `styles.css` → `workbench.css` → `select.css` → `theme.css` → `updates-trends.css` → `filters-tools-motion.css` → `platform-logs.css`. Later layers intentionally override earlier ones. Widget/tray have their own styles. Reuse `src/components/BrandIcon.tsx` for existing model/tool brand assets.

## Data and lifecycle invariants

### Online usage and pricing

`plugins/provider.newapi/services/client.ts` captures site/account scope for requests (`electron/services/new-api.ts` remains a compatibility export); `read-cache.ts` provides process-local TTL caching and in-flight request coalescing. Cache keys include site/address, credential scope, and query. Writes, logout, and forced refresh invalidate relevant reads; invalidated in-flight results must not repopulate caches or update another account. Failures are not cached. Public requests have no credentials, redirects are rejected, and TLS verification stays enabled.

Reuse `shared/range.ts`, `statistics.ts`, `trends.ts`, `logs.ts`, `usage-quality.ts`, and pricing/catalog helpers rather than recreating calculations in pages:

- Models are ORed within their filter, token IDs are ORed within theirs, and the two dimensions are ANDed. Overview usage, efficiency, activity, and trends share the selected range/filter; account balance is separate.
- Accurate filtered/minute statistics and current overview trends use complete consumption logs, bounded at 10,000 records. Exceeding the limit, missing required token IDs, or inconsistent pagination must fail rather than extrapolate from a partial page. Current overview trends use exact timestamps in at most 30 segments; do not replace them with older hourly aggregates. Menu-bar sampling has distinct semantics.
- Input + output totals must not add cache categories again. Cache hit rate is summed eligible cache-read tokens / corresponding input tokens; throughput is summed output tokens / summed valid duration, including first-token wait. Missing/invalid observations remain unknown, with valid-sample coverage, not zero or an average of per-row percentages.
- Pricing comes from published site rules, channels, and restricted-AST expressions. Preserve conditional/per-request/cache/media distinctions; missing multipliers or required variables mean unknown pricing, not an assumed multiplier of one. Do not hardcode model-name prices/cache TTLs or execute pricing expressions as scripts.

### Local sessions

`electron/services/local-usage.ts` streams session files; `local-session-store.ts` creates temporary SQLite detail indexes containing usage/byte positions/hashes, **not session bodies**. Renderer requests use discovered hashed session IDs, never arbitrary paths. Reading analytics is local/read-only and must not upload bodies or place them in application logs.

Details load a complete call index for a fixed file snapshot, then page calls by 50, content by 20, and raw records in at most 64 KiB chunks. `src/components/LocalSessionDetails.tsx` owns request/snapshot lifecycles: subscribe before loading, guard every response by scope/owner/request token, and release canceled, closed, unmounted, or late-arriving snapshots. Retain bounded pages/chunks rather than whole-session IPC payloads. Append-only additions do not alter an already-open snapshot. The older metadata cursor interface remains for compatibility, not the current details flow.

Local widget scanning continues from byte offsets/incomplete lines and retains recent minute aggregates instead of rereading whole files. It still needs online account/catalog context for balance and pricing; the local data source is not entirely offline. Estimates use actual independent token categories, call time, and configured channel pricing; insufficient metadata remains unknown. Local sessions lack site token IDs and cannot satisfy token-ID filtering.

### Direct CLI configuration

`electron/services/config.ts` coordinates a transaction, not a direct renderer file write. **Preview can already provision/update an online dedicated token** (`Lumi-Codex` / `Lumi-Claude`); it is not entirely side-effect-free. Reuse the token ID/key when switching channels and preserve its restrictions rather than rotating keys or automatically enabling unusable tokens.

Explicit apply rechecks site/account, preview freshness, original files, and running-tool state, then uses encrypted backups, conflict checks, atomic writes, and rollback. Preserve unrelated settings. Codex honors `CODEX_HOME` and active profiles; the current custom-provider flow preserves `auth.json` byte-for-byte. Claude Code merges relevant fields in `~/.claude/settings.json`. Apply/restore may deliberately synchronize Lumi-managed Codex session metadata/indexes; do not confuse that write path with read-only local analytics.

Do not introduce a local proxy/router for model switching, define tool prompts, or force reasoning intensity/default model behavior. Keep those owned by the CLI tool and retain the preview/backup/restore workflow described in `CONTRIBUTING.md`.

## Build and licensing boundaries

Vite emits `dist/`; esbuild emits CommonJS main/preload bundles in `dist-electron/`; macOS adds `dist-native/`. Packaging stages only built assets/resources and a minimal manifest, not source dependencies, research, tests, or user data.

`npm run build` must retain `scripts/generate-notices.mjs`: it collects complete production-dependency LICENSE/NOTICE text into `dist/third-party/` and fails when required text is missing. New runtime dependencies need collectible license text. Vite's public-asset copy also carries reference-project licenses from `public/third-party/`; preserve that distribution chain and the native helper's attribution. See `THIRD_PARTY_NOTICES.md`, `docs/ARCHITECTURE.md`, and `docs/RELEASING.md` for the corresponding design/distribution details.


## Interface plugins

`plugins/interface.default/` owns desktop chrome JSX and shell geometry; App retains data, preferences and navigation. `InterfaceShellProps` is the trusted renderer contract. `src/host/interface.tsx` keeps shell/page nodes stable and applies a selected external `kind: interface` package as scoped, validated CSS. Only one external interface is active; changes/missing packages fall back to default. Recovery lives outside the CSS scope. Preserve Settings drafts/focus/scroll when switching/reloading. External interface v1 has no script, feature contributions, SDK or data permissions; it adjusts existing layout/skin, not arbitrary React replacement. Author selectors/limits: `extensions/README.md`; regression: `tests/interface-plugin-ui.test.ts`.

## Built-in plugins and independent sources

`plugins/manifests.ts` contains metadata only; `electron/host/plugins.ts` and `src/host/renderer-registry.ts` assemble trusted main/renderer implementations separately. Fixed typed IPC remains the security boundary. Workbench, Usage, Models and Tokens are presentation shells with provider-owned content contributions. New API owns its account cards, billing/log views, tokens and dedicated-token policy; local sessions own the independent local Usage view. New API owns concrete Models/Tokens views; Codex/Claude adapters contribute tool-specific options while the Tools system owns transactions; former page/service paths are compatibility exports.

Contributions declare site-bound or independent lifetimes. New API account changes reset only site-bound contributions; Codex and local analytics must survive them. Local filters/tab preferences use nonsecret `sourceSelections`, not active-site selections or online token IDs. Keep plugin sliders from remounting Settings; preserve drafts, focus, dialogs and scroll.

`provider.codex` owns `subscriptionUsage.read`, exposed only through the main-window `readCodexUsage` bridge. It launches a bounded hidden `codex -s read-only -a never app-server` and sends initialization/account/rate-limit reads, never turns, login/logout, purchases or reset redemption. CLI authentication stays CLI-owned. Respect CODEX_HOME and isolated test homes; no real authenticated reads in tests. Windows duration/reset and credits come from the service; absent values remain unknown. Codex subscription limits are independent of New API billing and local tokens. See `docs/PLUGINS.md` for lifecycle/caching details and the current projection/source-selection boundaries.

Desktop surfaces consume headless `usage.present` / `workbench.present` system ports. They never read mounted React state. Disabling a provider or surface invalidates desktop cache identities; re-enabling reacquires a fresh capability. Extra sidebar pages use namespaced `plugin:<manifest.id>:<name>` IDs and declared page lifetimes.

Surface plugin runtimes own restricted panel IPC, windows, caches, refresh timers, theme subscriptions and tray/native-helper resources. Main injects `DesktopSurfaceEnvironment`; the host only notifies active `surface.control` capabilities. Renderer `connections` and `settingsTabs` register namespaced lazy components. Disabling withdraws both immediately, including outgoing motion content; a withdrawn active Settings tab falls back to General while the Settings shell stays mounted. Host General/Logs tabs remain fixed. The sidebar floats below the full-width titlebar on Windows and macOS.

Product manifests declare `settings` groups and view switches; renderer contributions can associate `view` with system content or a namespaced sidebar page, and can provide a custom settings component. Parent switches stop plugin lifecycles; child switches only withdraw display contributions. Store child values separately in `pluginViews`, migrate old feature flags, and keep Settings mounted. NewAPI disable invalidates previews and closes network/cache services; block it during authentication, token writes or configuration transactions.

External directory packages live in `extensions/packages/` separately from compiled builtins. `plugin.json` plus self-contained HTML/JS/CSS/LICENSE are validated by `npm run check:extensions`; packaging exports them beside the installer, never into app.asar. `electron/extensions/host.ts` scans user-data extensions and optional development/resource directories, pins validated bytes, persists separate flags/storage/encrypted secrets, and serves an isolated protocol. `src/host/extensions-registry.tsx` adapts declared contributions into existing slots; `ExtensionFrame` uses an opaque sandbox and the fixed SDK broker. External packages cannot import privileged main or host React modules. Permissions, HTTPS origins, bounded requests, lifecycle/account checks and immediate withdrawal must stay enforced. Changed package digests require re-enabling. Author instructions and SDK types are in `extensions/README.md` and `extensions/sdk/`.
