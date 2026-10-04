/**
 * Item search: case- and accent-insensitive, every term must appear.
 *
 * Folding works one character at a time so that a match in the folded text can
 * be mapped back to the original label for highlighting — "è" folds to "e" and
 * "œ" to "oe", so folded and original offsets drift apart.
 */

const LIGATURES = { "œ": "oe", "æ": "ae", "ß": "ss" };

function foldChar(ch){
  const lower = ch.toLowerCase();
  return LIGATURES[lower] ?? lower.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Folded text plus, for each folded character, the [start, end) it came from. */
function foldWithMap(text){
  let folded = "";
  const spans = [];
  let at = 0;
  for(const ch of text){
    const f = foldChar(ch);
    // A combining accent folds to nothing; it belongs to the letter before it.
    if(!f && spans.length) spans.at(-1)[1] = at + ch.length;
    for(let i = 0; i < f.length; i++) spans.push([at, at + ch.length]);
    folded += f;
    at += ch.length;
  }
  return { folded, spans };
}

const fold = (text) => foldWithMap(text).folded;

/** The folded, non-empty terms of a query. */
export function parseQuery(query){
  return fold(String(query ?? "")).split(/\s+/).filter(Boolean);
}

export function matchesQuery(label, terms){
  if(!terms.length) return true;
  const folded = fold(String(label ?? ""));
  return terms.every(t => folded.includes(t));
}

/**
 * Where the terms occur in `label`, as sorted, merged [start, end) offsets into
 * the original string.
 */
export function highlightRanges(label, terms){
  const { folded, spans } = foldWithMap(String(label ?? ""));

  const ranges = [];
  for(const t of terms){
    for(let i = folded.indexOf(t); i !== -1; i = folded.indexOf(t, i + 1)){
      ranges.push([spans[i][0], spans[i + t.length - 1][1]]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);

  const merged = [];
  for(const r of ranges){
    const last = merged.at(-1);
    if(last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}
