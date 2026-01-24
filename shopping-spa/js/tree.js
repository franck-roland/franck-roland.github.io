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

export function flattenTree(root){
  const out = [];
  const walk = (node, depth) => {
    out.push({ node, depth });
    for(const ch of (node.children||[])) walk(ch, depth+1);
  };
  if(root) walk(root, 0);
  return out;
}