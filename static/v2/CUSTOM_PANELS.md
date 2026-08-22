# Custom panels

How a panel written by somebody else — fetched from the collector, enabled by an
operator — becomes a real panel in the v2 interface, alongside the built-in ones.

This is the successor to v1's widget system. It is not a port of it: v1 widgets
are written against v1's DOM and its global JS objects, v2 shares neither, and
the v1 interface is being retired. Nothing here is concerned with running an
existing widget. What *is* reused is the half of the old system that was never
about v1 at all — the collector, the cache, the versioning and the admin CRUD in
`widget_manager.go`, which is a package manager and is already written.

Status: design agreed, implementation not started. Section 8 lists the decisions
still open; everything else here is settled.

---

## 1. What a custom panel is

A registry entry like any other, whose body is a sandboxed iframe.

That sentence carries most of the design. Because it is a registry entry it
inherits, with no code of its own: dock placement, drag-and-drop between docks,
floating and minimising, the minimal view, the collapse state, the mobile sheet
and tab bar, the Layout panel's show/hide switch and placement control, in-dock
resizing, and per-panel zoom. A v1 widget hand-rolled fixed positioning, a drag
handler, a collapse chevron, a close button and a `max-width: 1024px` rule to
hide itself on a phone — roughly 40 % of every widget file. None of that is
written again.

Because the body is a sandboxed frame, the panel cannot reach the parent DOM,
the parent's storage, the admin session cookie, or another panel. It talks to
the receiver over one channel, and hiding it in the Layout panel stops the code
running rather than hiding a div.

### What it is deliberately *not*

Not an extension. Extensions (`extensions/ExtensionWindow.jsx`) float and only
float, never join the dock layout, and are transient workspaces — a decoder you
open, work with and close. Custom panels are panels.

Not an overlay. There is no fixed-position layer for third-party HTML in v2.

---

## 2. The bundle

One HTML string. That is what the collector's `html_content` field is, what the
admin editor at `static/admin.html` edits (CodeMirror, drag-and-drop, version
history), and what `widget-ai.sh`'s assistant writes. Any other packaging —
a JSON envelope, an archive — breaks that toolchain and buys nothing.

```html
<template id="ubersdr-panel">
<script type="application/ubersdr-panel+json">
{
  "ui": 2,
  "schema": 1,
  "title": "World clocks",
  "icon": "Clock",
  "group": "settings",
  "dock": "left",
  "defaultOpen": true,
  "minimal": true,
  "fill": false,
  "height": 180,
  "uses": {
    "topics":   ["tuning", "session"],
    "commands": ["tune"],
    "run":      ["freq_step_up"],
    "audio":    false
  }
}
</script>

<style>
  .grid { display: grid; gap: 6px; }
</style>

<div class="grid" id="clocks"></div>

<script>
  const sdr = await ubersdr.ready();
  sdr.on('tuning', (t) => render(t));
  const home = sdr.store.all().home;
</script>
</template>
```

### 2.1 The `<template>` wrapper

Everything is inside one `<template id="ubersdr-panel">`, and that is not
cosmetic — it is what stops a bundle doing anything on an interface that does not
understand it. See §2.6.

### 2.2 The manifest block

`type="application/ubersdr-panel+json"` is not a type any browser executes, so
the block is inert wherever the document ends up, and the `<template>` around it
makes the whole bundle inert besides (§2.6). Its *presence* is also the
discriminator: a collector record that parses as a panel is a panel, one that
does not is a legacy v1 widget. Anything holding the content can answer the
question for itself, which is what keeps the two interfaces from loading each
other's records (§2.6) without either of them coordinating.

The collector indexes that answer in a `ui_version` column so a *listing* can
answer it too, and derives the value from the content rather than accepting it
from a client — so the content stays the single source of truth. See §3.4.

| Key | Required | Meaning |
|---|---|---|
| `ui` | yes | Which interface this panel is written for. `2` today. See §3.4. |
| `schema` | yes | Manifest format version. `1` today. |
| `title` | yes | Header text, mobile tab label, Layout panel row. |
| `icon` | yes | A key of the `Icon` map — see §2.3. |
| `group` | yes | A `GROUPS` id — see §2.4. |
| `dock` | no | `left` \| `right` \| `bottom`. Default `left`. |
| `defaultOpen` | no | Ships collapsed when `false`. Default `true`. |
| `defaultHidden` | no | Ships hidden but listed in the Layout panel. Default `false`. |
| `minimal` | no | Panel offers a minimal view; the header shows the toggle and the frame is told. Default `false`. |
| `fill` | no | Body stretches to the dock height. Only bites in the bottom dock. Default `false`. |
| `weight` | no | Share of the bottom dock's width. Default `1`. |
| `height` | no | Initial body height in px, before the frame reports its own. |
| `uses` | no | Declared capabilities. Documentation, not a permission grant — see §5. |

**The author does not choose the id.** The registry id is `x:<collector uuid>`,
derived from the immutable record. An author-chosen id could collide with a
built-in (`receiver`, `layout`) or with another widget, and editing it would
orphan every stored layout that referenced it.

**`dock`, `defaultOpen`, `defaultHidden`, `minimal`, `fill`, `weight` and
`height` are first-run defaults only** — exactly the status `mobile` and `touch`
have in `panels/registry.jsx`, never consulted again once a layout is stored.
Otherwise publishing v4 of a panel silently rearranges every operator's dock.

### 2.3 Icons

Built-in panels write `icon: <Icon.Radio />` — a React element from the `Icon`
object in `components/icons.jsx:25-181`. Every entry there renders through the
one `Svg` wrapper at the top of that file: 24-unit viewBox, `size = 16` default,
`currentColor`, one stroke weight. That is why a panel icon looks right in the
dock header, the mobile tab row, the Layout panel row and `NoticeIcon` without
any of them styling it — it inherits colour and size from wherever it is drawn.

A manifest therefore names one: `"icon": "Bars"` → `Icon[name]` → `<Icon.Bars />`.
Same wrapper, same inheritance, indistinguishable from a built-in.

Three consequences:

- **The keys become a published contract.** Once a manifest out on the collector
  says `"Bars"`, renaming that key in `icons.jsx` breaks that panel on every
  instance that has it enabled. Rule: **add, never rename.** Nothing in that file
  hints today that the keys are external; it needs a line saying so.
- **Unknown or missing needs a real fallback**, never a blank or a throw. There
  is no generic "panel" glyph today — `Plug` means Extensions, `Sliders` means
  Events — so one is added deliberately rather than borrowing a name that
  already means something.
- **Authors need the list.** The admin editor shows a picker (a fixed set of
  16 px SVGs, so a grid), and the assistant's brief carries the names or it will
  invent them.

Held in reserve, not shipped: `"icon": { "path": "M4 4v16h16" }`, a path string
rendered inside the same `Svg` wrapper. It inherits size, colour and stroke, and
cannot carry script or styling, so it needs no markup sanitising. Only if the
fixed set proves limiting.

### 2.4 Groups

`group` names an id from `GROUPS` in `panels/groups.jsx` — how panels are sorted
into the phone's tab row. The loader appends the panel's id to that group's
`panels` list at registry-build time.

The fallback already exists and is correct: `groupsFor()` collects anything not
named in any group via `ungrouped()` and rides it along with the **last** group,
"rather than being lost". So an unknown or missing `group` still leaves the panel
reachable on a phone.

Two notes on that file:

- `SOLO` is `'multipad'` and is not a group. A manifest can name a group and
  nothing else; the phone's home slot is not claimable.
- The header comment says a panel the registry has but the groups do not name
  "is a bug rather than a default". That stops being true once custom panels
  exist, and needs updating, or the next reader will treat a working fallback as
  an error path.

### 2.5 What executes

Not the file as written. The parent assembles the `srcdoc`:

1. the runtime preamble — the `ubersdr` client library, inlined from the app
   bundle, so there is no extra fetch and it is version-locked to the app;
2. the base stylesheet and the theme variables resolved from `lib/uiColors.js`,
   so a panel looks native without copying colours;
3. the bundle's contents — the inside of the `<template>`, unwrapped.

The server does the unwrapping: `/api/v2/panels/{id}` serves the inner content,
since it has already parsed the record to extract the manifest. The client never
sees the wrapper, and the stored form stays inert everywhere (§2.6).

---

### 2.6 Neither interface loads the other's records

The collector is one service shared by every instance, and it will hold v1
widgets and v2 panels side by side for as long as anybody is still running v1.
Both directions have to be safe.

**v2 never loads a v1 widget — by construction.** A record with no manifest is
not a panel. `handlePostEnabled` already fetches each newly added widget before
accepting the list and returns a 502 with a per-id message; a record that will
not parse as a panel is refused there, and it never appears in
`/api/v2/panels`. Nothing extra is needed.

The one case to handle is an operator upgrading with legacy ids already in
`server.enabled_widgets`. Those are **logged at startup and surfaced in admin as
unavailable, not silently dropped** — `refreshAll()` auto-evicts on a collector
404 because the record is genuinely gone, but a v1 widget still exists and the
operator may yet downgrade. Removing it is their decision.

**v1 never renders a v2 panel — because the stored bundle is inert.** This is the
direction that cannot be fixed with code, because the instances at risk are other
operators' installations running the *old* build, which will happily inject
whatever `html_content` holds. Injected raw into a v1 page, an unwrapped bundle
would apply its `<style>` to the whole document (panel CSS is written for a frame
and is not scoped), render its markup as a stray block wherever `WidgetsHTML`
lands, and — depending on the browser — fail its script noisily.

`<template>` content is parsed into an inert `DocumentFragment`: not rendered,
styles not applied, scripts not executed. So a bundle injected into any page that
does not know how to unwrap it produces **literally nothing** — no leaked CSS, no
stray markup, no script. That protection needs no cooperation from the instance
doing the injecting, which is exactly why the wrapper is part of the stored form
rather than something the loader adds.

Belt and braces for instances running new code: `AssembleHTML`
(widget_manager.go:415) skips any cached entry whose manifest parsed, and logs
that it did. One `if` in the loop, reading the same in-memory flag the v2 path
reads, so an operator gets a log line rather than a widget that silently renders
nothing.

**The admin browse list cannot tell them apart from a listing alone**, because
`html_content` is absent from list responses and present only when fetching a
single widget (`WidgetMeta`, widget_manager.go:30 and collector widgets.go:94).
Nothing depends on it for correctness — the operator finds out at enable time,
with a specific error rather than a silent failure — but it is the one gap the
content-based check cannot close, and §3.4 closes it with a derived column on the
collector.

## 3. Delivery

### 3.1 Why not injection

`handleV2IndexPage` (main.go:4038) templates the v2 shell, and it is tempting to
put the manifests in it — the cache is in memory at request time and the registry
would then be complete before the first render.

It does not work. Electron loads `proxy.localOrigin + '/v2/'`
(`clients/electron/main.js:334`), served by its own proxy from the staged
`ui/v2` directory (`clients/electron/proxy.js:46`); Capacitor loads
`www/v2/index.html` from the app bundle. Neither ever reaches `v2IndexTemplate`.
Anything Go templates into the shell exists in a browser and nowhere else, so
custom panels would be invisible in the desktop client, Android and iOS.

Delivery is by endpoint. §4.1 covers what replaces the property injection was
buying.

### 3.2 The endpoints

Both read the in-memory cache `widget_manager` already maintains. No collector
call on the request path.

**`GET /api/v2/panels`** — manifests only, in `server.enabled_widgets` order:

```json
{
  "etag": "…",
  "panels": [
    {
      "id": "x:9f3ca1b2…",
      "version": 7,
      "manifest": { "schema": 1, "title": "World clocks", "…": "…" },
      "name": "World clocks",
      "callsign": "M9PSY",
      "instanceId": "…",
      "description": "Clocks for the places you work"
    }
  ]
}
```

One ETag over the `(id, version)` set, so the lifecycle poll is a 304 and costs
nothing.

**`GET /api/v2/panels/{id}`** — the bundle, `ETag` = the record's version, 404
when the panel is not enabled.

Split rather than one call: bodies run 15–100 KB each, so ten inline is about a
megabyte on every boot and every poll, and `Section` only mounts an open panel's
body (`components/Section.jsx:341`, `{state.open && …}`) — most are never needed.
It also lets bodies cache hard on version while the list stays fresh.

Both need whatever CORS treatment the other v2 APIs give Capacitor's
`capacitor://localhost` origin. Electron is same-origin through its proxy.

`/api/description` already carries `enabled_widgets` (main.go:4862, via
`GetEnabledWidgetsSummary`), but it is `{widget_id, name, is_public}` for v1's
toast — not enough to build a registry from, on a response that is already large
and served to everything on a different clock. It is left alone.

### 3.3 Server-side changes

`widget_manager.go` keeps its shape. Manifests are parsed **once, at cache
time** — in `refreshAll()` (line 194) and `AddToCache()` (line 338), which
already fetch only when the version has changed — and the parsed struct is
stored on `widgetCacheEntry` beside `HTML`. Everything downstream reads a struct;
nothing parses per request.

A record whose manifest is absent or will not parse is not a v2 panel. That is
the discriminator, and it is also the error to report: `handlePostEnabled()`
(line 525) already fetches each newly added widget before accepting the list and
returns a 502 with a per-id message on failure. A bad manifest belongs in that
same path — refusing at enable time with "this is not a v2 panel" beats a panel
that silently never appears.

`MaxEnabledWidgets = 10` stays, and now doubles as the frame budget.

The collector needs **no change at all**: same `html_content`, same version
counter, same CRUD, same public/private.

`widget-ai.sh` needs no infrastructure change either — it already publishes
through `/admin/widgets/*` on trusted-host auth. Only its brief changes: this
document plus `BRIDGE_API.md`.

---

### 3.4 Collector changes

The design needs none — manifest presence is the discriminator and the collector
stores one opaque string. Two things are worth doing anyway, and one of them is
not optional if anybody is to author a panel at all.

#### The `ui_version` column

Manifest presence answers "is this a panel" for anything holding the content. It
cannot answer it for a *listing*: `handleListWidgets` and friends return
`WidgetMeta`, which has no `html_content` (widgets.go:94), so the admin browse UI
would have to fetch every record to label one. That is the single gap left by
§2.6.

So: a nullable `ui_version INTEGER` on `widgets` (main.go:2021), exposed on
`WidgetMeta` and `Widget`, with a `?ui=` filter on the list endpoints. NULL means
a v1 widget — the right value for every row that exists today.

**The interface, not the manifest format.** These are two axes and only one of
them decides whether a panel will run. A panel written for a future v3 interface
could use manifest schema 1 and be perfectly parseable by v2, which would accept
it and then break at runtime on a v3-only API. So the column records
`manifest.ui` — the interface the panel is written for — and the manifest's own
`schema` stays inside the manifest, where the enabling instance parses it anyway
and can refuse an unknown value with a message (§8.4). The collector does not
need to know manifest formats exist.

Manifest format changes should be additive in any case, so an instance that does
not know a newer `schema` ignores the fields it does not recognise, exactly as
§4.3 requires of every other unknown value.

**Derive it, do not accept it.** The collector sets the column at create and
update by parsing the content it was given, not from a field the client sends. A
declared field is a second source of truth, and the first time one says "panel"
while the content has no manifest, the browse list starts lying. Derived, the
content stays authoritative and the column is only an index over it — and writers
need no API change at all.

A record whose manifest omits `ui` but is otherwise valid derives `2`, the first
interface to have panels.

Skew is safe in both directions: an instance on older code ignores the field, and
a collector on older code simply does not send it, while the content check keeps
working everywhere.

**Migration.** `ALTER TABLE widgets ADD COLUMN ui_version INTEGER` leaves every
existing row NULL, which already means "not a panel" — no populate step is
needed. What the migration should do instead is one derive pass over all rows,
parsing each `html_content` and setting the column where a manifest is found: the
table is small, it is a single scan, and it means the column is true rather than
assumed on day one. A bundle stored during development would otherwise be
mislabelled by a blanket default. Follow the `widgets.description` migration
already at main.go:2050 — `pragma_table_info` check, `ALTER`, log.

**Every write derives, not just creates.** `handleCreateWidget` (widgets.go:792)
*and* `handleUpdateWidget` (widgets.go:923), which is where the content is
already being parsed for validation. Creates-only breaks the common case: an
author converts an existing v1 widget into a panel by editing it, and that row
stays mislabelled for good. The same applies in reverse.

`widget_versions` needs no column of its own. Restoring an old version goes
through the update path, so the derive runs against the content actually being
written.

**Panels are opt-in, and the filter is only on lists.** The default excludes
them, which is what keeps every deployed instance correct without knowing
anything about it:

- **No param → `ui_version IS NULL`.** Legacy widgets only. That is byte for byte
  today's result set and always will be, because every row that exists now is
  legacy. The currently-shipped UberSDR asks for nothing and therefore never sees
  a panel it cannot run — it does not need to know panels exist. This is the same
  principle `BRIDGE_API.md` states for the page API: feature-detect on
  capabilities, never on version numbers. The client declares what it can run;
  the collector does not guess.
- **`?ui=2`** → panels for the v2 interface. A v2 instance asks for exactly that
  and a v3-only panel is invisible to it, which is the whole point of recording
  the interface rather than the manifest format.
- **`?ui=2,3`** → a comma list, for an interface that can run more than one
  generation of panel. A v3 instance able to run v2 panels says so; one that
  cannot asks `?ui=3` and gets only its own. Whether v3 keeps the v2 contract is
  v3's business to declare, not the collector's to assume.
- **`?ui=any`** → everything, what the collector's own website asks for.
- **Never filter `/api/widgets/:id` or `/api/widgets/:id/versions`, and never
  default-filter them either.** This is load-bearing in both directions.
  UberSDR's `fetchWidgetVersion` polls the versions endpoint and treats a 404 as
  `errWidgetGone`, which makes `refreshAll()` drop that id from
  `server.enabled_widgets` *and rewrite the operator's config YAML*. A default of
  legacy-only on that path would delete a new instance's own enabled panels from
  its configuration on the next refresh tick.

An alternative considered and rejected: defaulting the filter from the caller's
reported version, which the collector could do — `resolveInstanceSecret`
(widgets.go:214) already looks the caller up and `instances.version` is stored.
It needs semver parsing of a TEXT column, a defined fallback for unparseable or
stale values, and it guesses at a capability the client is perfectly able to
state. Opt-in is simpler and cannot be wrong.

#### Validation, which currently rejects a valid panel

`validateWidgetJS` (widgets.go:411) writes each `<script>` block to a temp `.js`
file and runs `node --check`. Two consequences:

- **`scriptTagRe` matches typed scripts.** `(?is)<script[^>]*>(.*?)</script>`
  (widgets.go:24) does not look at `type`, so the manifest block is handed to
  `node --check` as JavaScript. `{"schema": 1, …}` is a syntax error at statement
  position, so **every panel bundle is rejected today**. The regex needs to skip
  any `<script>` carrying a `type` that is not JavaScript.
- **A `.js` temp file is CommonJS, so top-level `await` is a syntax error.** The
  panel API is asynchronous — `await ubersdr.ready()` is the first line of almost
  every panel — so this must be checked as a module: a `.mjs` temp file, or
  `--input-type=module`.

Worth checking rather than assuming: whether the configured `tidy` binary is
tidy-html5 and therefore knows `<template>`. An HTML4-era tidy will report it as
an unknown element.

The rest of `validateWidgetHTML` (widgets.go:276) stays as it is. Its rejections —
external `<script src>`, external stylesheets, `<base href>`, `meta refresh`,
external form actions, full-document structural tags — were written to protect a
host page from injected markup. Most of them stop mattering once a panel runs in
a frame of its own, but they remain a reasonable bar for third-party code an
operator cannot review, and the fragment rule is exactly right for a bundle.

#### Collector work items — **done**

Implemented in `~/repos/ubersdr-aux/collector`: `panel_manifest.go` (new) holds
the parser, the derive pass and the filter; `main.go` the column and migration;
`widgets.go` the wiring. Tests are `panel_manifest_test.go` and
`widgets_ui_test.go`.

1. **Schema** — `ALTER TABLE widgets ADD COLUMN ui_version INTEGER`, following
   the `widgets.description` migration pattern at main.go:2050. No populate: NULL
   already means legacy.
2. **Derive helper** — parse `html_content` for the `<template>` + manifest
   block, return `manifest.ui` (defaulting to `2` when the manifest is otherwise
   valid but omits it) or NULL. One function, used by everything below.
3. **Migration pass** — run the helper over every existing row once, so the
   column is true rather than assumed on day one.
4. **Write paths** — call the helper in `handleCreateWidget` (widgets.go:792)
   and `handleUpdateWidget` (widgets.go:923), where the content is already being
   parsed for validation. Both, not just create.
5. **Validation branch** — legacy rows keep today's path byte for byte. Panels
   get: `scriptTagRe` skipping `<script>` with a non-JavaScript `type`, and
   `node --check` in module mode (`.mjs` or `--input-type=module`). Without both,
   every panel bundle is rejected today.
6. **Expose** — `ui_version` on `WidgetMeta` (widgets.go:94) and `Widget`.
7. **Filter** — the opt-in `?ui=` param on `handleListWidgets`,
   `handleListMyWidgets` and `handleListWidgetsWithInstances`. Absent → legacy
   only. **Not** on `handleGetWidget` or `handleListWidgetVersions`.
8. **Collector website** — `static/widgets.html` / `widgets.js` ask for
   `?ui=any` and label the two kinds.
9. **Check** — whether the configured `tidy` is tidy-html5 and accepts
   `<template>`. **Answered: yes.** tidy 5.6.0 parses it without complaint, and
   the "moved `<style>` tag to `<head>`" warning it emits for a bundle is already
   in `tidyFalsePositivePatterns`. No change was needed.

Every one of these is safe against currently-running instances: the default
result set is unchanged, validation never runs on read (widgets.go:857, 863, 991,
997 are the only call sites, all on write), and the legacy validation path is
untouched.

## 4. Integration into v2

### 4.1 The registry, and the reconcile hazard

`PANELS` in `panels/registry.jsx` becomes `[...BUILT_IN, ...fromManifests]`,
built once at module init.

The hazard is `reconcile()` in `layout/LayoutContext.jsx`. It filters every
stored id through `PANEL_BY_ID` — floats (line 214), weights (237), heights
(243), dock order (249) — and **drops** what it does not recognise, and the
pruned result is what gets persisted. If manifests arrive over `fetch` after
mount, then on every single load the custom panels are briefly unknown, get
pruned out of the layout, and the pruning is saved. One reload and the operator's
arrangement is gone.

Two measures, and both are wanted:

**Seed the registry synchronously from a `localStorage` manifest cache**, on the
pattern `bridge/settings.js` and `lib/announce.js` already use — its own store,
read at module init — then fetch the endpoint and revalidate.

The timing works out exactly. A stored layout can only mention a custom panel if
some earlier load knew about it, and that load also wrote the cache. So the seed
is populated precisely when there is something to protect. On a first-ever load
the cache is empty, but so is the stored layout. No blocking fetch before
`root.render()`, no added startup round-trip.

This cache must stay `localStorage` — its whole job is to be readable
*synchronously* before `LayoutProvider` reconciles, which IndexedDB cannot do.

**Make `reconcile()` non-destructive**: park unknown ids rather than dropping
them. `localStorage` is unavailable in private mode and can be cleared, and
silently persisting a pruned layout is data loss whatever caused it. Worth fixing
on its own merits, independent of this feature.

Changes arriving after boot then have two safe paths and never touch registry
deletion:

- a panel added → lands through reconcile's existing new-panel placement
  (LayoutContext.jsx:267), which puts it at its declared position rather than at
  the bottom of an existing user's dock;
- a panel removed → `requires` goes false. It leaves the docks, the Layout panel
  and the mobile tabs, and its stored placement is left intact so re-enabling
  restores it.

### 4.2 `requires`

`requires` for a custom panel tests **one thing: is this panel in the enabled set
the endpoint returned.** Not whether its body has loaded.

Gating on load state would drop the row out of the Layout panel at exactly the
moment somebody is there working out why a panel is not showing, and it
contradicts the rule that a failed body must be visible. Loading and failure are
`CustomPanel`'s own business, rendered inside a panel that is already listed and
already switchable.

### 4.3 Manifest → registry entry

Validation degrades, never throws. This code runs before the first render, so
anything that throws is a white screen for the whole receiver.

- unknown `dock` → the default; unknown `icon` → the fallback glyph; unknown
  `group` → the existing last-group fallback; missing `title` → the id;
- ids are namespaced `x:<uuid>` so a panel can never claim `receiver` or
  `layout`;
- on id collision, drop — `PANEL_BY_ID` is a map and a duplicate would silently
  shadow a real panel;
- **one bad manifest costs exactly one panel.**

### 4.4 `CustomPanel`

The entry's `Component` closes over its manifest and renders `CustomPanel`,
which:

1. fetches the body from `/api/v2/panels/{id}` on first mount — free laziness,
   since `Section` does not mount a closed panel's body. Ten enabled panels with
   one open is one fetch.
2. assembles the `srcdoc` (§2.5) and mounts
   `<iframe sandbox="allow-scripts">`.
3. after `load`, creates a `MessageChannel` and hands one port over in a single
   `postMessage`. The frame must not be able to speak before the parent is
   listening, and the handover is where the parent stamps the panel's identity —
   a frame never asserts its own id.
4. renders loading and error states itself. **A body that fails to fetch shows
   the panel with a "could not load" body rather than vanishing**: a panel that
   silently disappears is indistinguishable from one the operator removed, and
   the operator goes looking in admin for something that is not wrong.
5. relays height (a `ResizeObserver` inside the frame), theme changes, and the
   `minimal` prop.

Every frame sits inside an error boundary.

### 4.5 The panel host

Custom panels are **not** bridge clients, and this matters:
`bridge/host.js:36` caps clients at `MAX_CLIENTS = 8`; `bridge/settings.js` gives
the operator a switch to refuse outside clients entirely; and the attached count
feeds an on-page badge meaning "something outside this page is driving my
receiver". Ten panels would blow the cap, misreport the badge, and all die the
moment an operator turned the bridge off — a setting about browser extensions,
not about panels they installed themselves.

`createHost(deps)` is DOM-free and fully dependency-injected, which is exactly
right. Stand up a **second host instance** for panels:

- the same `snapshot` / `command` / `run` functions `BridgeHost.jsx` already
  supplies;
- a `postMessage`-to-port transport instead of the `CustomEvent` pair;
- `enabled: () => true`;
- its own client cap and its own accounting, invisible to the external-clients
  badge.

Panels then speak the documented protocol — `bridge/client.js` with a swapped
transport — and get every topic and every command for free. Near-zero new
protocol surface.

### 4.6 Hiding is a kill switch

`LayoutPanel.jsx:58` iterates `PANELS.filter((p) => p.id !== 'layout' && applies(p))`
and gives every entry a `Switch` bound to `setSectionHidden` plus a placement
`Segmented`. A custom panel gets that row with no new code.

And "off" means off, not `display: none`. `Dock.jsx:220`,
`FloatingLayer.jsx:129` and `MobileShell.jsx:162` all filter on
`sections[id].hidden` **before** rendering, so `panel.Component` never mounts:
no body fetch, no `srcdoc`, no port. The third-party code does not run. That is
worth saying in the UI copy.

Two independent "off"s result, and they compose correctly as long as stored
state is never deleted:

- **operator, server-side** — the enabled list. Removed → `requires` false → the
  panel leaves the docks *and* the Layout panel, because it is not a thing on
  this receiver any more.
- **user, per-browser** — the switch, in `sections[id].hidden`.

Because `hidden` is keyed on id and unknown ids are parked rather than pruned, a
panel the operator removes and later re-enables comes back **still hidden**.
That is right — the user said no and nothing has asked them since — but it will
be reported as a bug, so it is deliberate.

Which makes id stability load-bearing: the collector UUID, never the name. A
version bump keeps the switch where the user left it; a rename does not
resurrect a panel they turned off.

### 4.7 Provenance in the Layout panel

`widgetCacheEntry` already caches `Name`, `Callsign`, `InstanceID`,
`Description` and `Version`, and the list endpoint carries them. The Layout row
for a custom panel shows at least author callsign and version.

Whether to leave the switch on is a trust question about code pulled off a shared
collector; "who wrote this and what is it" is fair to ask, and that row is the
only place it gets asked. A divider and a heading separate the custom entries
from the built-in ones, which otherwise differ only by position in the list.

### 4.8 Lifecycle

`refreshAll()` already polls versions every `widgetCacheTTL` (15 min) and evicts
on 404. The page hears about it by polling `/api/v2/panels` and comparing — the
set ETag makes that a 304 in the common case.

- **version changed** → remount that frame with a new `srcdoc` and a fresh port.
  In-frame state is lost, which is the correct semantics for an update.
- **panel gone** → `requires` false, per §4.1.

---

## 5. The panel API

`ubersdr` in the frame is `bridge/client.js` over the port, plus `store` and
`height`. `BRIDGE_API.md` is therefore most of the author documentation already:
the topics (`tuning`, `audio`, `signal`, `spectrum`, `session`, `page`, `layout`,
`modes`, `bands`, `functions`), the commands, and `run`.

```js
const sdr = await ubersdr.ready();      // resolves once the port has arrived

sdr.receiver                            // the descriptor: id, callsign, url, …
sdr.on('tuning', (t) => …)              // subscribe; patches merged for you
await sdr.get('signal')
await sdr.command('tune', { frequency: 14074000, mode: 'usb' })
await sdr.run('freq_step_up')

sdr.store.all()                         // snapshot, resolved before ready()
sdr.store.set('home', 'IO91')           // fire-and-forget
await sdr.fetch('/api/cty/countries')   // receiver API, via the parent

sdr.height(180)                         // or let the ResizeObserver do it
sdr.minimal                             // and an event when it changes
```

### 5.1 Capability: parity with a built-in panel

**A custom panel can do anything a built-in panel can do.** That is the rule, and
it settles what would otherwise be several decisions:

- **`run` gets the full catalogue, unfiltered** — including the hardware
  functions `rot_dial`, `rot_stop`, `rot_left_*`, `rot_right_*`, `ant_next`,
  `ant_prev`, `ant_ground`, `ant_select_N` (`controls/functions.js:405-475`).
  `run` does not check `needs` today in any case (`BridgeHost.jsx:277` calls
  `runFunction` directly; `isUnavailable` is only a display helper for mapping
  rows). The real gate on those is the **stored operator password** — a rotator
  function without one "logs to the SDR Control panel and returns like any
  other". So a custom panel calling `rot_dial` does exactly what `RotatorPanel`
  does: works if the user has authenticated for that hardware, no-ops if not. It
  inherits the gate; it cannot obtain one.
- **The audio port is in.** `ScopePanel` and `SpectrogramPanel` read audio, so a
  custom panel can. Note what `BRIDGE_API.md` says about it: taken ahead of
  volume, mute and ducking, and at the receiver's sample rate, not 48 kHz.
- **Notices are in.**
- **`uses` is a declaration, not a permission grant.** Nothing to consent to, no
  dialog. It stays in the manifest for the operator to read and the host to use
  as a hint.

Tuning is per-session and affects nobody else: each session allocates its own
SSRC and creates its own radiod channel (`radiod.go:374`, `allocateSSRC` in
`session.go`). A panel that retunes you is annoying, not a shared-resource
problem, and hiding it stops it.

### 5.2 The one deviation from parity

`sdr.fetch` goes through the parent, which is same-origin, so strict parity means
`credentials: 'include'` — which makes `/admin/*` reachable whenever the operator
happens to be signed into admin in that browser.

No built-in panel calls admin endpoints, so **denying `/admin/*`** costs a custom
panel nothing an author would notice, and it is the difference between a bad
panel being annoying and a bad panel taking the receiver. One denylist line, not
an allowlist to maintain forever.

For everything else `sdr.fetch` behaves as a page fetch. A panel can also call
plain `fetch()` itself for third-party APIs that send permissive CORS — an
opaque origin is not network-dead, it just sends `Origin: null` and no cookies —
and WebSockets are not CORS-governed at all, so a panel can likely open the
receiver's own WS directly. (Whether those handlers validate `Origin` is worth
checking.)

### 5.3 Storage

A `sandbox="allow-scripts"` frame has an opaque origin, so `localStorage`,
`sessionStorage` and IndexedDB all **throw** on access — not "return empty",
throw — and cookies are blocked. The `srcdoc` is rebuilt on every mount, so even
in-memory state dies when a panel is collapsed and reopened. Without a
parent-held store, a clocks panel cannot remember which cities you picked.

**Panel data lives in the parent's IndexedDB**, namespaced by panel id.
IndexedDB rather than `localStorage`, and the reason is isolation rather than
size: `localStorage` is one ~5 MB pot shared with the layout, the prefs and the
bridge settings, so a panel that writes too much does not break itself — it makes
v2's own next write throw, and the symptom is a layout that quietly stops saving.
Structured clone is a bonus (an ArrayBuffer or ImageBitmap kept directly, rather
than base64 in the pot the layout lives in), and deleting a removed panel's data
is a key-range delete rather than a prefix scan.

- **Still capped per panel.** Origin storage is best-effort and eviction is
  origin-wide, so a panel that fills the bucket can get *everything* on that
  origin evicted. The cap can be generous — a few MB — but not absent.
- **Asynchronous**, so `ready()` resolves the whole store as a snapshot and
  `store.all()` is synchronous after that; `set` is a fire-and-forget write.
- **Assume it can be unavailable** — private mode, blocked site data — and
  degrade to in-memory-for-this-mount rather than failing the panel, the way
  `bridge/settings.js` swallows its `localStorage` failures.

---

## 6. What the sandbox is for

Given §5.1, the frame is not buying restricted capability. It buys isolation,
and all of it survives full API parity:

- a panel cannot restyle the application or read another panel's DOM;
- it cannot read or clobber `ubersdr.v2.*` keys, the layout, or the prefs;
- it cannot read the admin session cookie;
- everything it does goes through one channel that can be logged, rate-limited
  or cut;
- hiding it genuinely stops the code (§4.6).

The storage cap is the same kind of thing: resource protection, not a capability
limit. A capped panel can still do everything a built-in does.

---

## 7. Build order

Sequenced so each step is verifiable before the next depends on it. The collector
goes first and ships independently: nothing in UberSDR depends on it landing, and
it has to be deployed before any instance can ask for panels.

1. ~~**Collector**~~ — **done**, see §3.4. The `ui_version` column and derive
   pass, the derive on both write paths, the validation branch, and the opt-in
   `ui` filter. Safe to deploy against every currently-running instance: the
   default result set is unchanged, validation never runs on read, and the legacy
   branch is untouched. Once it is live, panels can be authored and stored before
   anything can run one — a v1 instance that somehow enables one renders nothing
   (§2.6).
2. **Harden `reconcile()`** — park unknown ids instead of pruning them
   (LayoutContext.jsx:214, 237, 243, 249). Standalone, small, and a real
   data-loss fix on its own merits.
3. **Go side** — manifest parse and validation at cache time in `refreshAll` /
   `AddToCache`; `Manifest` on `widgetCacheEntry`; the two endpoints; enable-time
   rejection through the existing `handlePostEnabled` error path. Fully testable
   with no frontend.
4. **Registry merge and manifest cache** — with one hardcoded manifest, prove a
   panel appears in its dock, in the Layout panel row, in the mobile tab bar, and
   that it floats. No iframe yet.
5. **`CustomPanel`** — body fetch, `srcdoc` assembly, frame mount, port handover,
   the second `createHost` with its own transport, the client preamble,
   `store` and `fetch`. The real work, and by now everything around it is
   known-good.
6. **Lifecycle poll** — version bump remounts, removal flips `requires`.
7. **Author tooling** — retarget `widget-ai.sh`'s brief, add the icon picker and
   manifest validity indicator to the admin editor, and write one real panel end
   to end.

## 8. Open decisions

1. **`sdr.fetch` credentials** — include with `/admin/*` denied (recommended
   above), or omit entirely.
2. **Store scope.** v2 prefs are per-origin, so in a browser panel data is
   per-receiver, while Electron loads every receiver from
   `http://127.0.0.1:<port>` (`proxy.js:88`) with no session partition and
   therefore shares one. Ride that inconsistency, as the existing prefs already
   do, or define a panel-specific rule. Inclination: ride it, and document it,
   rather than have two storage models in one app.
3. **Backups.** The Backup panel picks up `ubersdr.v2.` `localStorage` keys for
   free; IndexedDB it will not. Does third-party panel data belong in an
   operator's export?
4. **`schema` mismatch** — a panel declaring a version the instance does not
   know. Refuse at enable time with a message, presumably, but the rule should
   exist before there is a schema 2. This is the instance's business, not the
   collector's: the collector records which *interface* a panel targets (§3.4),
   and manifest format changes should be additive so an older instance ignores
   what it does not recognise.
5. ~~**Legacy coexistence.**~~ Resolved — see §2.6. The `<template>` wrapper
   makes a bundle inert on any interface that does not unwrap it, including old
   builds that cannot be patched; v2 refuses non-panels at enable time. The only
   residue is that the admin browse list cannot mark the two kinds apart, because
   the collector omits `html_content` from list responses. Accepted.
6. **Naming.** `server.enabled_widgets` and the admin vocabulary. The collector
   will keep saying "widget" regardless, so there is a permanent split unless
   both are renamed, and renaming the config key is a migration.
7. **Frame budget.** `MaxEnabledWidgets = 10` as the cap — keep it, raise it, or
   count open frames rather than enabled panels.
8. **CSP for v2.** Worth having once third-party frames are in the page; awkward
   because of `custom_head_html`.

## 9. Files

**New**

- `static/v2/src/panels/custom/manifest.js` — parse and validate, degrading.
- `static/v2/src/panels/custom/cache.js` — the synchronous `localStorage` seed.
- `static/v2/src/panels/custom/CustomPanel.jsx` — frame, handover, states.
- `static/v2/src/panels/custom/host.js` — the second `createHost` and transport.
- `static/v2/src/panels/custom/preamble.js` — the in-frame `ubersdr` client.
- `static/v2/src/panels/custom/store.js` — parent-side IndexedDB.
- `panels_api.go` — the two endpoints.

**Changed**

- `widget_manager.go` — manifest parse at cache time, `Manifest` on the entry,
  enable-time rejection, and an `AssembleHTML` skip for parsed panels until v1
  goes (§2.6).
- `main.go` — routes.
- `static/v2/src/panels/registry.jsx` — merge custom entries.
- `static/v2/src/layout/LayoutContext.jsx` — park unknown ids.
- `static/v2/src/panels/groups.jsx` — runtime group insertion; fix the header
  comment about ungrouped panels being a bug.
- `static/v2/src/components/icons.jsx` — the fallback glyph, and a note that the
  keys are an external contract.
- `static/v2/src/panels/LayoutPanel.jsx` — provenance rows and the divider.
- `static/admin.html` — icon picker, manifest validity, panel-vs-legacy marking.
- `widget-ai.sh` — brief only.

**Collector** (`~/repos/ubersdr-aux/collector`, see §3.4)

- `main.go` — `ui_version` column on `widgets`, plus the one-off derive pass.
- `widgets.go` — derive `ui_version` from `manifest.ui` on create *and* update;
  validation branched on kind so the legacy path is unchanged byte for byte;
  `scriptTagRe` to skip non-JavaScript `<script type=…>` and module-mode
  `node --check` on the panel branch only; expose the field, and the opt-in `ui`
  filter on the list endpoints *only*.
- `static/widgets.html` / `widgets.js` — label and filter the two kinds.

**Deleted with v1**

- `AssembleHTML` and `parseExcludeWidgets` (widget_manager.go:415, main.go:3929)
- the `WidgetsHTML` template field and its injection in `handleIndexPage`
- the `?exclude_widgets=` / `localStorage` redirect at `static/index.html:31-57`
- `widgets/*.widget.html`, `widgets-custom/*.widget.html`

Per-user hiding is replaced by the Layout panel switch, which needs no server
involvement at all.
