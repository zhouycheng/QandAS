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
- Never persist passwords or verification codes. Account changes reject stale callbacks and responses. Catalog filter changes invalidate discovery caches without changing private learning history.

## Platform and interaction

- Keep `useMultiFrameRuntime` false. Check actual tap handling in DevTools.
- Keep `usingComponents: {}` on secondary pages even when components are global.
- Use the shared page header and native navigation. Compute status and capsule insets once per header and update on resize.
- The custom tab bar reserves no space. Tab scroll contents retain bottom clearance and safe-area padding. Each tab updates selection on show. Hit targets stay inside their slot.
- Tab pull refresh shares lifecycle feedback and deduplicates in-flight work. Hidden community entries must retain their component instance and retry on page show or pull refresh, without polling.
- Shared overlays use root-portal, intercept background touch and close on hide. Apply the portal theme at its boundary.
- Isolated components define all classes they use, including pressed and modifier states. WXSS disallows universal selectors and local background-image paths.
- Preserve native input nodes and cursor position. Focused inputs are not rewritten by timer or sync updates. Native textareas must retain touchstart behavior needed for focus.
- Practice pages send sparse view patches while Models retain complete projections. Regress result filters, answer cards and indexed array updates.
- Hover feedback preserves geometry. Practice hover classes inside scroll-view use opacity, not transform.
- All practice modes support swipe navigation when enabled. Persist the swipe toggle and draft behavior in session options; boundary swipes never submit. Keep reading material state by revision and restore the same material position between subquestions.
- Module ordering uses four stable nodes and CSS order. Default `flow` mode uses natural height. Pin the tools above navigation only when they are last in the saved order; otherwise keep their chosen position in the scroll area. `custom` mode fixes stem/response heights, aligns short options to the bottom and scrolls overflow inside each pane. Save mode, ratio and order atomically; flow mode preserves the inactive ratio. Preview uses the unsaved draft and an in-memory session; its floating toggle stays in the same position and becomes the return-to-editor button. Allocate custom preview height after padding, borders, margins and gaps. Reset preserves unrelated preferences and requires saving.
- Answer details follow the response content (inline blanks follow the stem) and obey model disclosure. Keep the legacy TopSheet disabled, with its stored preference readable for compatibility. Unconfirmed immediate multiple choice uses the main confirm button, disabled when empty; deferred feedback retains submission confirmation. Timer and input patches stay sparse.
- Reading questions use a separate workspace: a 64px progress launcher, a 65% initial panel and a 35%–90% WXS resize range. The handle has a 48px hit area and an 8px drag threshold; cancellation restores the starting height. Body scrolling never resizes the panel. Close restores the launcher. Remember material scroll, open state and height by revision, reset question scroll on navigation, and invalidate gestures on resize/hide/question changes. Restore layout and scroll after the keyboard closes. Count confirmed answers for immediate progress and nonempty drafts for deferred progress. Use the shared bottom navigation and four fixed reading tools.
- Avatar selection uses native chooseAvatar and nickname inputs. Equal button dimensions prevent oval avatars. Normalize nullable component values at call sites.
- Account profile editing lives in `page/account`; device-local catalog filters live in `catalog-filters.js`.
- Guest quota and complete snapshots persist atomically; failed storage must not consume quota. Logout retains account-scoped drafts.
- Home greeting and cover use the same time classification. Preserve the three original covers and shared crop window; regenerate runtime crops with the existing script.
- Code block copy, horizontal scroll, template includes and component-isolated styles need runtime checks in addition to compilation.

## Maintenance

Use root `docs/git-workflow.md` for branch, commit and PR rules. Keep generated assets tied to source scripts. Preserve the existing visual hierarchy and breadcrumb density.
