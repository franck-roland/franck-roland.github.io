export function buildTree(categories){
  const nodes = (categories || []).filter(c => !c.deletedAt);
  const byId = new Map(nodes.map(n => [n.id, { ...n, children: [] }]));

  let root = null;

  for(const n of byId.values()){
    if(n.parentId && byId.has(n.parentId)){
      byId.get(n.parentId).children.push(n);
    }else{
      // Orphan or root
      if(n.parentId === null) root = n;
    }
  }

  // Ensure deterministic ordering by order field
  const sortRec = (node) => {
    node.children.sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
    for(const ch of node.children) sortRec(ch);
  };

  if(root){
    sortRec(root);
    return root;
  }

  // Fallback: pick any
  const any = byId.values().next().value || null;
  if(any) sortRec(any);
  return any;
}

/** The synthetic section that collects items whose category no longer exists. */
export const ORPHAN_SECTION_ID = "__orphans";

/**
 * Flattens a category subtree into a render-ready list of rows:
 *
 *   { kind:"section", id, name, depth, count, collapsed, empty, orphan? }
 *   { kind:"item",    item, depth }
 *
 * Sections carry a count over their *whole* subtree, so a folded header still
 * shows what it hides, and Shopping mode can drop an empty branch with a single
 * test rather than walking it twice. Rows come out ordered and filtered — the
 * caller paints them without recursing.
 *
 * @param {object}            doc
 * @param {string}            rootCategoryId  the scope; "c_root" also collects orphans
 * @param {object}            [opts]
 * @param {"edit"|"shopping"} [opts.mode]         Shopping hides empty sections
 * @param {boolean}           [opts.hideChecked]
 * @param {Set<string>}       [opts.collapsed]    section ids to fold
 * @returns {{ rows: Array, total: number }}
 */
export function buildItemsOutline(doc, rootCategoryId, opts = {}){
  const { mode = "shopping", hideChecked = false, collapsed = new Set() } = opts;

  const live = (doc.categories || []).filter(c => !c.deletedAt);
  const byId = new Map(live.map(c => [c.id, c]));

  const childrenOf = new Map();
  for(const c of live){
    if(!childrenOf.has(c.parentId)) childrenOf.set(c.parentId, []);
    childrenOf.get(c.parentId).push(c);
  }
  for(const kids of childrenOf.values()){
    kids.sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
  }

  const isVisible = (it) => !it.deletedAt && !(hideChecked && it.checked);

  const itemsOf = new Map();
  for(const it of (doc.items || [])){
    if(!isVisible(it)) continue;
    if(!itemsOf.has(it.categoryId)) itemsOf.set(it.categoryId, []);
    itemsOf.get(it.categoryId).push(it);
  }
  for(const list of itemsOf.values()) sortItems(list);

  const counted = new Map();
  const countOf = (id) => {
    if(counted.has(id)) return counted.get(id);
    let n = (itemsOf.get(id) || []).length;
    for(const ch of (childrenOf.get(id) || [])) n += countOf(ch.id);
    counted.set(id, n);
    return n;
  };

  const root = byId.get(rootCategoryId);
  if(!root) return { rows: [], total: 0 };

  const rows = [];

  const walk = (c, depth) => {
    const count = countOf(c.id);
    const empty = count === 0;

    // Shopping mode drops an empty section. Because the count is recursive, an
    // empty branch is empty all the way down and goes with it. The scope root
    // always renders — it is the subject of the panel.
    if(empty && mode === "shopping" && c.id !== rootCategoryId) return;

    const isCollapsed = collapsed.has(c.id);
    rows.push({ kind:"section", id:c.id, name:c.name, depth, count, collapsed:isCollapsed, empty });
    if(isCollapsed) return;

    for(const it of (itemsOf.get(c.id) || [])){
      rows.push({ kind:"item", item:it, depth: depth + 1 });
    }
    for(const ch of (childrenOf.get(c.id) || [])){
      walk(ch, depth + 1);
    }
  };

  walk(root, 0);

  // Counting from the tree rather than from `rows` keeps the total steady when
  // a section is folded: folding hides rows, not items.
  let total = countOf(rootCategoryId);

  // An item whose category was deleted on another device belongs to no live
  // category, so a plain subtree walk would hide it for good. Surface it at
  // root scope, where "everything" is the promise being made.
  if(rootCategoryId === "c_root"){
    const orphans = sortItems(
      (doc.items || []).filter(it => isVisible(it) && !byId.has(it.categoryId))
    );
    if(orphans.length){
      const isCollapsed = collapsed.has(ORPHAN_SECTION_ID);
      rows.push({
        kind:"section", id:ORPHAN_SECTION_ID, name:"Uncategorized", depth:0,
        count:orphans.length, collapsed:isCollapsed, empty:false, orphan:true
      });
      if(!isCollapsed){
        for(const it of orphans) rows.push({ kind:"item", item:it, depth:1 });
      }
      total += orphans.length;
    }
  }

  return { rows, total };
}

/** Unchecked first, then alphabetical — unchanged from the old flat list. */
function sortItems(list){
  return list.sort((a,b) => (a.checked === b.checked)
    ? (a.label || "").localeCompare(b.label || "")
    : (a.checked ? 1 : -1));
}

export function flattenTree(root){
  const out = [];
  const walk = (node, depth) => {
    out.push({ node, depth });
    for(const ch of (node.children||[])) walk(ch, depth+1);
  };
  if(root) walk(root, 0);
  return out;
}