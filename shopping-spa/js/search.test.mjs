// Run with:  node --test js/search.test.mjs
//
// Item search is pure string work, so it is tested here rather than in a
// browser. ui.js only turns the ranges into <mark> elements.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseQuery, matchesQuery, highlightRanges } from "./search.js";

test("a blank query has no terms", () => {
  assert.deepEqual(parseQuery(""), []);
  assert.deepEqual(parseQuery("   "), []);
  assert.deepEqual(parseQuery(null), []);
});

test("a query splits on whitespace into folded terms", () => {
  assert.deepEqual(parseQuery("  Lait   COCO "), ["lait", "coco"]);
});

test("matching ignores case", () => {
  assert.equal(matchesQuery("Milk", parseQuery("MILK")), true);
});

test("matching ignores accents, both ways round", () => {
  assert.equal(matchesQuery("Crème fraîche", parseQuery("creme")), true);
  assert.equal(matchesQuery("Creme fraiche", parseQuery("crème")), true);
});

test("matching folds the French ligatures", () => {
  assert.equal(matchesQuery("Œufs", parseQuery("oeuf")), true);
  assert.equal(matchesQuery("Cæsar", parseQuery("caesar")), true);
});

test("every term must appear, in any order", () => {
  const terms = parseQuery("coco lait");
  assert.equal(matchesQuery("Lait de coco", terms), true);
  assert.equal(matchesQuery("Lait demi-écrémé", terms), false);
});

test("a term matches anywhere inside a word", () => {
  assert.equal(matchesQuery("Pamplemousse", parseQuery("mouss")), true);
});

test("no terms matches everything", () => {
  assert.equal(matchesQuery("Anything", []), true);
});

test("a missing label matches nothing but the empty query", () => {
  assert.equal(matchesQuery(undefined, parseQuery("a")), false);
  assert.equal(matchesQuery(undefined, []), true);
});

test("highlight ranges point into the original label", () => {
  assert.deepEqual(highlightRanges("Lait de coco", parseQuery("coco")), [[8, 12]]);
});

test("highlight ranges cover accented characters at their original width", () => {
  // "è" is one character in the label, whatever its folded form.
  assert.deepEqual(highlightRanges("Crème", parseQuery("creme")), [[0, 5]]);
});

test("highlight ranges survive a decomposed accent in the label", () => {
  // "e" + COMBINING GRAVE is two code units that fold to one "e".
  const label = "Crème";
  assert.deepEqual(highlightRanges(label, parseQuery("creme")), [[0, label.length]]);
});

test("a highlight never splits a letter from its combining accent", () => {
  assert.deepEqual(highlightRanges("Crème", parseQuery("cre")), [[0, 4]]);
});

test("highlight ranges cover a ligature whole", () => {
  assert.deepEqual(highlightRanges("Œufs", parseQuery("oeuf")), [[0, 3]]);
});

test("highlight ranges mark every occurrence of every term, sorted", () => {
  assert.deepEqual(
    highlightRanges("coco lait coco", parseQuery("coco lait")),
    [[0, 4], [5, 9], [10, 14]]
  );
});

test("overlapping or touching ranges merge into one", () => {
  assert.deepEqual(highlightRanges("abcdef", parseQuery("abc cde")), [[0, 5]]);
  assert.deepEqual(highlightRanges("abcdef", parseQuery("abc def")), [[0, 6]]);
});

test("no terms highlights nothing", () => {
  assert.deepEqual(highlightRanges("Milk", []), []);
});
