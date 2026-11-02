# Mini program engineering notes

Read the root `docs/frontend-architecture.md`, `docs/product-rules.md` and `docs/miniapp-page-loading.md` before changing behavior. Human-facing documentation is Chinese; Agent instructions are English.

## Verification

Run from `apps/miniapp`:

```sh
npm --prefix ../../packages/content-format ci
npm --prefix ../../packages/content-format run build
npm ci
npm run build
npm test
```

The build uses the official WeChat npm builder. `tests/compile.check.js` locates the official WXML/WXSS compilers, supplies imported styles and WXS files, and checks diagnostics. WCSC can exit zero on errors: inspect `ERR` output. WCC diagnostics include file, line and column. Report compiler skips separately from successful compilation.

## Boundaries

- Pages own wx APIs, focus, gestures, animation and navigation. ViewModels return data and commands; Models and utils own pure rules; Repositories own HTTP, snapshots, caches and durable drafts.
- Use flat CommonJS files with explicit require paths. Runtime JavaScript remains native. Keep exact npm versions and a lockfile.
- Content comes from the API. Test fixtures stay outside `miniprogram`. Guest snapshots and layout examples are current product behavior.
- Practice sessions keep a fixed device credential, immutable revisions and durable asynchronous progress. Preserve idempotency, acknowledgement sequences, retries, dead letters and the finish barrier.
- Keep grading fields out of the page before their configured reveal point. Submission confirms all nonempty drafts, including other questions.
- Never persist passwords or verification codes. Account changes reject stale callbacks and responses. Profile changes invalidate scope-dependent data.

## Platform and interaction

- Keep `useMultiFrameRuntime` false. Check actual tap handling in DevTools.
- Keep `usingComponents: {}` on secondary pages even when components are global.
- Use the shared page header and native navigation. Compute status and capsule insets once per header and update on resize.
- The custom tab bar reserves no space. Tab scroll contents retain bottom clearance and safe-area padding. Each tab updates selection on show. Hit targets stay inside their slot.
- Shared overlays use root-portal, intercept background touch and close on hide. Apply the portal theme at its boundary.
- Isolated components define all classes they use, including pressed and modifier states. WXSS disallows universal selectors and local background-image paths.
- Preserve native input nodes and cursor position. Focused inputs are not rewritten by timer or sync updates. Native textareas must retain touchstart behavior needed for focus.
- Practice pages send sparse view patches while Models retain complete projections. Regress result filters, answer cards and indexed array updates.
- Hover feedback preserves geometry. Practice hover classes inside scroll-view use opacity, not transform.
- Module ordering uses stable nodes and CSS order. Drag cancellation and failed persistence restore the previous order. Layout reset preserves unrelated preferences.
- Avatar selection uses native chooseAvatar and nickname inputs. Equal button dimensions prevent oval avatars. Normalize nullable component values at call sites.
- Account profile editing lives in `page/account`; local reminder preferences live in `page/reminder`.
- Guest quota and complete snapshots persist atomically; failed storage must not consume quota. Logout retains account-scoped drafts.
- Home greeting and cover use the same time classification. Preserve the three original covers and shared crop window; regenerate runtime crops with the existing script.
- Code block copy, horizontal scroll, template includes and component-isolated styles need runtime checks in addition to compilation.

## Maintenance

Use root `docs/git-workflow.md` for branch, commit and PR rules. Keep generated assets tied to source scripts. Preserve the existing visual hierarchy and breadcrumb density.
