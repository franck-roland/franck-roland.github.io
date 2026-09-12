# Grouped items outline — design

Date: 2026-09-12
Status: implemented — 19 `node --test` assertions, 22 browser assertions
Scope: `shopping-spa`
Preview: [`2026-09-12-items-outline-preview.html`](./2026-09-12-items-outline-preview.html)
&mdash; a clickable prototype with a Today/Proposed switch across both panels.
Also published at <https://claude.ai/code/artifact/e7149234-a011-457b-a895-aede4b6c6411>.

## Origin

The request was "when I click on a category, I want to see all subcategories and
all subitems in this view", with a screenshot showing an empty Items panel and a
Categories panel whose names were truncated to `F...` and `P...`.

Both symptoms have a single cause each, and they are worth naming precisely:

**The empty panel.** `renderItems()` filters with an exact match:

```js
.filter(i => (selectedCat ? (i.categoryId === selectedCat || selectedCat === "c_root") : true))
```

Selecting *Alimentation* therefore shows only items pinned directly to
*Alimentation* — never the ones inside *Fruits*, *Poissons* or *Viandes*. Only
`"All"` shows everything, and it shows it as one flat alphabetical list with no
grouping. For a tree-shaped shopping list this means the panel is empty most of
the time.

**The truncation.** Each tree node carries four inline action buttons. With
`.node .actions { flex-wrap: wrap; max-width: 50% }` they take half the row and
wrap onto a second line, leaving the name roughly 100px inside a 320px column.

This design replaces the flat filter with a recursive outline, and folds the four
buttons behind one overflow menu.

## Decision log

| Decision | Choice | Rationale |
| --- | --- | --- |
| Panel shape | Keep two panels; the Items panel gains grouping | Chosen over a merged outline, a flat list with category chips, and a full-width drill-down. The tree stays useful as an always-visible overview. |
| Depth rendering | Indented nested sections | Preserves the hierarchy the tree already shows. A flat sequence would render two different `Bio` categories identically. |
| Counts | Recursive over the subtree, and **visible-only** | *Fruits → 3* means 2 direct plus 1 in *Bio*. Counting only visible items means that with *Hide checked* on, the number reads as "3 left in this aisle" rather than lying about what is on screen. |
| Empty sections | Shown in Edit mode, hidden in Shopping mode | In Edit an empty header confirms the category exists and gives it a drop target; while shopping it is noise. Reuses the existing mode toggle. |
| `"All"` | Becomes an ordinary root walk | Deletes the `selectedCat === "c_root"` special case. One code path for every category. |
| Section collapse state | A **separate** set from the tree's `collapsedCategoryIds` | Tree collapse hides *navigation*; section collapse hides *content*. Sharing one set would mean folding a tree branch silently empties your shopping list. |
| Section header click | Toggles collapse only — it does **not** select or re-scope | See "The two-state trap" below. |
| Adding items | Top input adds to the scope root (unchanged); each section header gets a `➕` opening an inline row | No dialog: an inline row is better than a modal here, and `prompt()` is banned in this project. |
| Tree actions | Four inline buttons → one `⋯` popover | Returns nearly the full 320px to the name. |
| `Select` menu entry | Dropped | Clicking the row already selects. Keeping it in the menu duplicates the row's own behaviour. |
| Outline construction | A pure function in `js/tree.js` | `ui.js` is already 762 lines. Tree logic does not belong in the DOM layer, and a pure function is testable under `node --test` with no browser. |

## The two-state trap

In discussion I said clicking a section header would "select that category —
tree highlight and retarget the top input — but not re-scope the panel".

**That cannot work as stated.** The panel's scope *is* `st.selectedCategoryId`.
Selecting a category from a section header would therefore re-scope the panel,
collapsing the very outline you clicked inside. Making it work would require
splitting the state in two — `scopeCategoryId` set by the tree, plus
`selectedCategoryId` as the add-target — and two nearly-identical states that
disagree is precisely the kind of thing that produces bugs nobody can reproduce.

**Resolution:** the per-section `➕` removes the need entirely. There is never a
reason to retarget the top input, because every section can be added to directly.
So:

- `selectedCategoryId` remains the single source of truth, and is set **only**
  from the tree panel.
- A section header click toggles collapse. Nothing else.
- The top input adds to the scope root, exactly as today.

This supersedes what was agreed in chat. It is simpler, and it is the reason the
per-section `➕` earns its place rather than being a convenience.

## Piece 1 — `buildItemsOutline()` in `js/tree.js`

### API

```js
buildItemsOutline(doc, rootCategoryId, { mode, hideChecked, collapsed })
  // -> { rows, total }
```

`collapsed` is a `Set` of category ids. `mode` is `"edit" | "shopping"`.
`rows` is a flat, render-ready array — the caller paints it without recursing:

```js
{ kind: "section", id, name, depth, count, collapsed, empty }
{ kind: "item",    item, depth }
```

`total` is the visible item count for the whole scope, for the panel header.

### Walk

Depth-first from `rootCategoryId`, children in `order`:

1. Emit the section row for the current category.
2. If collapsed, stop — emit no descendants, but the header still carries the
   recursive `count`, so you can see what is folded away.
3. Emit its direct items, filtered and sorted (below), at `depth + 1`.
4. Recurse into child categories at `depth + 1`.

Depths for `Alimentation › Fruits › Bio`:

```
ALIMENTATION                     depth 0   section
  ☐ Sel                          depth 1   item
  ▼ Fruits & Légumes      3      depth 1   section
       ☐ Pommes                  depth 2   item
       ☐ Carottes                depth 2   item
       ▼ Bio              1      depth 2   section
            ☐ Tomates            depth 3   item
  ▼ Poissons              1      depth 1   section
       ☐ Saumon                  depth 2   item
```

### Filtering and sorting

Items are excluded when `deletedAt` is set, or when `hideChecked` is on and the
item is checked. Within a section, sorting is unchanged from today: unchecked
first, then `localeCompare` on the label.

`count` is the number of *surviving* items in the section's whole subtree, and
`empty` is `count === 0`. Because the count is recursive, an empty branch is
empty all the way down — so in Shopping mode dropping an empty section drops its
entire subtree, with no separate check needed.

The scope root's header always renders, whatever its count, because it is the
subject of the panel. When `total === 0` the caller shows an empty state beneath
it.

> **Deviation from the approved sketch:** the sketch showed no count on the root
> section. This spec gives every section a count, including the root — one rule
> instead of a special case. Say so in review if you would rather it stayed bare.

### Orphan items

Deleting a category reparents its items to `c_root`, so orphans should not
arise locally. A Drive merge can still produce one: `mergeEntities` keeps a
locally-added item whose category the remote deleted.

Today such an item is visible under `"All"` with its category shown as `—`.
Under a subtree walk it would belong to no live category and become **invisible**
— a silent data-loss bug introduced by this change.

**Mitigation:** when the scope root is `c_root`, and only then, append a final
`Uncategorized` section holding every non-deleted item whose `categoryId`
resolves to no live category. Omitted when it would be empty.

### Tests (`node --test js/tree.test.mjs`, no dependencies)

1. Flat tree: root section plus its items at depth 1.
2. Three-level nesting produces the depths tabulated above.
3. Recursive counts: *Fruits* reports 3 (2 direct + 1 in *Bio*).
4. `hideChecked` shrinks counts to visible-only; an all-checked section reports 0.
5. Shopping mode omits a zero-count section **and its whole subtree**.
6. Edit mode keeps that section, with `count: 0` and `empty: true`.
7. A collapsed id yields its header with the full count, and none of its descendants.
8. Scoping to a mid-tree category excludes ancestors and siblings.
9. Orphan items surface under `Uncategorized` at root scope, and nowhere else.
10. Deleted items and deleted categories are excluded.
11. Siblings follow `order`, not array insertion order.
12. Within a section: unchecked first, then alphabetical.

## Piece 2 — the Items panel in `js/ui.js`

`renderItems()` is rewritten to paint `rows`. Indentation is
`min(depth, 4) * 16px`, capped so a deep tree cannot push content off a phone
screen.

### Section row

`[twisty] [name] [count] [➕]`. The whole header is the collapse target; `➕`
stops propagation.

### The inline add row

`➕` inserts an input row directly beneath that section's header:

- Autofocused. **Enter adds the item and clears the input, leaving it open** —
  building a shopping list means typing several items into one aisle.
- Escape closes it. Only one row is open at a time.
- Adding into a collapsed section expands it first, or the new item vanishes.

**Re-render hazard.** `render()` rebuilds `itemsContainer.innerHTML` wholesale,
so an open row would be destroyed on every keystroke that triggers a save. The
open row is therefore module state, not DOM state:

```js
let addDraft = null;   // { categoryId, text } | null
```

`renderItems()` recreates the row from `addDraft`, restores its text, and
refocuses it with the caret at the end.

**Staleness.** The handler awaits `persistActiveDoc()`, so it must re-resolve the
document through `liveDoc(listId)` afterwards and bail if the user switched
lists — the same guard every other async handler in `ui.js` now uses.

### Panel header

`Items` becomes `Items — <scope name>` with `total` beside it. This needs an id
on the existing `.panel-title` — one of only two changes to `index.html`, the
other being removal of the dead `#itemCategorySelect` described below.

### Behaviour change to call out

`"All"` no longer renders a flat alphabetical list of every item. It renders the
full grouped outline. This is the point of the change, but it is the one thing an
existing user will notice immediately.

## Piece 3 — the tree's `⋯` menu

The node template becomes `[twisty] [handle] [name ────────] [⋯]`.

`handleCategoryAction(categoryId, act)` is **unchanged** — it already routes
`add`, `rename` and `del` through `showPrompt`/`showConfirm`. Only the trigger
changes: the menu dispatches into the same function.

Menu contents: `Add subcategory` · `Rename` · `Delete`. The root gets
`Add subcategory` alone.

- The popover is appended to `document.body` and positioned `fixed` against the
  button's rect, so neither the panel's scrolling nor the row's own drag
  handlers can clip or swallow it.
- One popover at a time. It closes on Escape, outside click, scroll, or a chosen
  action; Escape returns focus to the `⋯` button.
- `aria-haspopup="menu"` and `aria-expanded` on the button; `role="menu"` and
  `role="menuitem"` inside.
- Visible on hover or focus-within under `@media (hover: hover)`; always visible
  otherwise, so it is reachable on touch.

The CSS rules that caused the truncation come off: `overflow: hidden` on `.node`,
and `flex-wrap: wrap` with `max-width: 50%` on `.node .actions`.

Drag and drop is untouched.

### Dead code removed

`#itemCategorySelect` is `display:none`, has no way to be changed by the user,
and is still rebuilt on every render by `renderCategorySelect()`. Selection comes
from the tree alone. The element, its change listener and `renderCategorySelect()`
go. `#btnAddItem` duplicates the quick-add input and is left alone as out of
scope.

## Verification (`docs/superpowers/verification/itemsview.mjs`)

Playwright against real Chrome, following the existing convention — installed
outside the repository, zero runtime dependencies, no build step.

1. Selecting a category renders its descendants' items — the regression this
   whole change exists to fix.
2. A section twisty collapses and expands, and the state survives a re-render.
3. `➕` opens an inline row; Enter files the item into **that** subcategory rather
   than the scope root; the row stays open and clears.
4. Escape closes the row; an unrelated re-render preserves an open row's text.
5. Adding into a collapsed section expands it.
6. `⋯` opens the menu; Rename reaches `showPrompt`, Delete reaches `showConfirm`;
   Escape restores focus to the button.
7. A long category name is no longer clipped at 320px
   (`scrollWidth <= clientWidth` on `.node .name`).
8. The staleness guard: swapping `activeDoc` while the inline row is open makes
   the add bail without persisting.

## Files

| File | Change |
| --- | --- |
| `js/tree.js` | Add `buildItemsOutline()` |
| `js/tree.test.mjs` | New — 12 cases under `node --test` |
| `js/ui.js` | Rewrite `renderItems()`; node template and `⋯` menu; `collapsedSectionIds` and `addDraft` module state; drop `renderCategorySelect()` |
| `styles.css` | Section rows, depth indentation, inline add row, popover; remove the truncation rules |
| `index.html` | Add an id to the Items panel title; remove `#itemCategorySelect` |
| `docs/superpowers/verification/itemsview.mjs` | New — 8 assertions |
| `docs/superpowers/verification/README.md` | Document the new script |

## What changed during implementation

Two things the design did not anticipate, both found by the browser checks:

**The tree's chrome needed tightening, not just the buttons.** Removing the four
inline buttons was not enough on its own: with the `⋯` button at `6px 8px`
padding and three 8px gaps, `Entretien ménager` still wanted 140px in a 136px
box. The button is now `4px 6px` on a 15px glyph and the row gaps are 6px, which
also brings the node down from 51px tall to a single ~41px row. The verification
asserts the row budget (`.actions` under 25% of the row, sitting beside the name
rather than under it) instead of "no name is ever clipped" — any name can be made
long enough to need an ellipsis, so the budget is the real property.

**Folding state is module-level, which the tests had to respect.**
`collapsedSectionIds` and `collapsedCategoryIds` live at module scope so a fold
survives a re-render. A browser check that builds a fresh `createUI()` over the
cached module therefore inherits the previous check's folds. `itemsview.mjs`
reloads the page per check; this is noted in the verification README, because
anyone adding a check here will hit it.

## Accepted consequences

- Section collapse is session-only and lost on reload, matching the tree's
  existing behaviour. Persisting either is a separate piece of work.
- Indentation is capped at depth 4, so categories nested deeper than that share a
  visual level. The hierarchy is still unambiguous from the section headers'
  order and the tree panel.
- Counts shrink as you check items off with *Hide checked* on. This is intended —
  the number reads as "left to buy" — but it does mean the count is not a stable
  property of the category.
- `Uncategorized` is reachable only at root scope. An orphan item is invisible
  while scoped elsewhere, which is correct: it is in no category.
