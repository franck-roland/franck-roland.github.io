function byId(arr){
  const m = new Map();
  for(const e of (arr || [])){
    if(!e?.id) continue;
    m.set(e.id, e);
  }
  return m;
}

function summarizeEntities(name, local, remote){
  const L = byId(local);
  const R = byId(remote);

  let added = 0, removed = 0, changed = 0, same = 0;

  for(const [id, r] of R.entries()){
    const l = L.get(id);
    if(!l){
      if(!r.deletedAt) added++;
      continue;
    }
    const lDel = !!l.deletedAt;
    const rDel = !!r.deletedAt;

    if(!lDel && rDel) removed++;
    else if(lDel && !rDel) added++;
    else if(l.updatedAt !== r.updatedAt) changed++;
    else same++;
  }

  // Local-only entities that remote doesn't have
  for(const [id, l] of L.entries()){
    if(!R.has(id) && !l.deletedAt) added++;
  }

  return `${name}: +${added}  -${removed}  ~${changed}  =${same}`;
}

export function buildConflictSummary(localDoc, remoteDoc){
  const lines = [];
  lines.push(`Title: local="${localDoc.title || ""}" | remote="${remoteDoc.title || ""}"`);
  lines.push(`Mode: local=${localDoc.mode} | remote=${remoteDoc.mode}`);
  lines.push("");
  lines.push(summarizeEntities("Categories", localDoc.categories, remoteDoc.categories));
  lines.push(summarizeEntities("Items", localDoc.items, remoteDoc.items));
  lines.push("");
  lines.push("Tip: Auto-merge keeps the newest changes per item/category (by updatedAt) and preserves deletions (tombstones).");
  return lines.join("\n");
}