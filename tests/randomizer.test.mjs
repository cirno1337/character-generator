// node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NUMERIC_SECTIONS, createEmptySpec, randomize, resetGenerated, cell, violations,
  promptBiases, describeTensions, hasUnsetNumeric,
} from "../static/randomizer.js";
import { toMarkdown, renderCharacterHTML } from "../static/render.js";

const fields = JSON.parse(readFileSync(new URL("../static/fields.json", import.meta.url)));

// deterministic PRNG
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const allCells = (spec) => NUMERIC_SECTIONS.flatMap((s) => Object.entries(spec[s]).map(([k, c]) => [s, k, c]));

test("empty character: every numeric field gets a generated value in range; basics stay for the LLM", () => {
  const spec = randomize(createEmptySpec(fields), { rng: mulberry32(1) });
  for (const [s, , c] of allCells(spec)) {
    assert.equal(c.source, "generated");
    const [lo, hi] = s === "mental_axes" ? [1, 5] : [0, 5];
    assert.ok(Number.isInteger(c.value) && c.value >= lo && c.value <= hi, `${s} ${c.value}`);
  }
  for (const c of Object.values(spec.basic)) assert.deepEqual(c, cell("", "unset"));
  assert.equal(hasUnsetNumeric(spec), false);
});

test("user values (including 0) are NEVER modified – fill, reroll, coherence, reset", () => {
  const rng = mulberry32(42);
  for (let run = 0; run < 3000; run++) {
    let spec = createEmptySpec(fields);
    spec.additional_prompt = run % 3 ? "Nieśmiała nauczycielka, nie jest wojowniczką, spokojna." : "";
    const locked = [];
    for (const [s, k] of allCells(spec)) {
      if (rng() < 0.35) {
        const [lo, hi] = s === "mental_axes" ? [1, 5] : [0, 5];
        const v = lo + Math.floor(rng() * (hi - lo + 1));
        spec[s][k] = cell(v, "user");
        locked.push([s, k, v]);
      }
    }
    spec.basic.name = cell("Ala", "user");
    for (const mode of ["fill", "reroll"]) {
      spec = randomize(spec, { mode, rng });
      for (const [s, k, v] of locked) assert.deepEqual(spec[s][k], { value: v, source: "user" });
      assert.deepEqual(spec.basic.name, cell("Ala", "user"));
    }
    spec = resetGenerated(spec);
    for (const [s, k, v] of locked) assert.deepEqual(spec[s][k], { value: v, source: "user" });
    for (const [, , c] of allCells(spec)) if (c.source !== "user") assert.deepEqual(c, cell(null, "unset"));
  }
});

test("unset vs zero are different", () => {
  let spec = createEmptySpec(fields);
  spec.character_traits.jealousy = cell(0, "user");
  spec = randomize(spec, { rng: mulberry32(7) });
  assert.deepEqual(spec.character_traits.jealousy, { value: 0, source: "user" });
  assert.equal(spec.character_traits.empathy.source, "generated");
  assert.notEqual(spec.character_traits.empathy.value, null);
  spec = resetGenerated(spec);
  assert.deepEqual(spec.character_traits.jealousy, { value: 0, source: "user" });
  assert.deepEqual(spec.character_traits.empathy, { value: null, source: "unset" });
});

test("fill mode keeps already generated values; reroll re-rolls them and clears LLM-generated basics", () => {
  const rng = mulberry32(3);
  const a = randomize(createEmptySpec(fields), { rng });
  a.basic.race = cell("krasnolud", "generated");
  const b = randomize(a, { mode: "fill", rng });
  assert.deepEqual(b, a);
  let differs = 0;
  for (let i = 0; i < 5; i++) {
    const c = randomize(a, { mode: "reroll", rng });
    assert.deepEqual(c.basic.race, cell("", "unset"));
    differs += JSON.stringify(c) !== JSON.stringify(a);
  }
  assert.ok(differs > 0);
});

test("axis distribution is centre-weighted, not uniform", () => {
  const rng = mulberry32(11);
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 4000; i++) {
    const s = randomize(createEmptySpec(fields), { rng, keepChance: 0 });
    for (const c of Object.values(s.mental_axes)) counts[c.value]++;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const share = (v) => counts[v] / total;
  assert.ok(share(3) > share(1) && share(3) > share(5), JSON.stringify(counts));
  assert.ok(share(1) < 0.2 && share(5) < 0.2, JSON.stringify(counts));
});

test("coherence pass removes clashes between generated values (keepChance 0)", () => {
  const rng = mulberry32(5);
  let before = 0, after = 0;
  for (let i = 0; i < 500; i++) {
    const s = randomize(createEmptySpec(fields), { rng, keepChance: 0 });
    after += violations(s).length;
  }
  // sanity: without coherence clashes would be common – build raw random specs
  for (let i = 0; i < 500; i++) {
    const s = createEmptySpec(fields);
    for (const [sec, k] of allCells(s)) s[sec][k] = cell(sec === "mental_axes" ? 1 + Math.floor(rng() * 5) : Math.floor(rng() * 6), "generated");
    before += violations(s).length;
  }
  assert.ok(before > 500, `raw clashes ${before}`);
  assert.ok(after < before * 0.05, `after coherence ${after} vs raw ${before}`);
});

test("coherence moves the generated side when user locked the other side", () => {
  const rng = mulberry32(9);
  for (let i = 0; i < 200; i++) {
    let s = createEmptySpec(fields);
    s.mental_axes.extravert_vs_introvert = cell(5, "user");
    s = randomize(s, { rng, keepChance: 0 });
    // strongly introverted => generated charisma must not be extreme
    assert.ok(s.social_traits.charisma.value <= 4);
    assert.ok(s.character_traits.talkativeness.value <= 4);
  }
});

test("both-user contradictions are kept and reported as tensions", () => {
  let s = createEmptySpec(fields);
  s.mental_axes.extravert_vs_introvert = cell(5, "user");
  s.character_traits.talkativeness = cell(5, "user");
  s = randomize(s, { rng: mulberry32(2) });
  assert.equal(s.character_traits.talkativeness.value, 5);
  const t = describeTensions(s, fields);
  assert.ok(t.some((x) => x.includes("Gadulstwo") && x.includes("oba wybrane przez autora")), t.join("\n"));
});

test("prompt biases: negation, world-vs-character 'spokojny'", () => {
  const b1 = promptBiases("Chcę zwykłą nauczycielkę w spokojnym świecie fantasy. Nie jest wojowniczką.");
  assert.equal(b1.mental_axes.pacifist_vs_aggressor, 2);
  assert.equal(b1.social_traits.aggression, 1);
  assert.equal(b1.life_priorities.education, 4);
  assert.equal(b1.mental_axes.calm_vs_expressive, undefined, "spokojnym świecie describes the world");
  const b2 = promptBiases("Stary najemnik, bardzo spokojny.");
  assert.equal(b2.mental_axes.pacifist_vs_aggressor, 4);
  assert.equal(b2.mental_axes.calm_vs_expressive, 2);
  assert.deepEqual(promptBiases(""), {});
});

test("prompt bias shifts randomized values", () => {
  const rng = mulberry32(13);
  let sum = 0;
  for (let i = 0; i < 300; i++) {
    const s = createEmptySpec(fields);
    s.additional_prompt = "Nie jest wojowniczką. Pacyfistka.";
    sum += randomize(s, { rng }).social_traits.aggression.value;
  }
  assert.ok(sum / 300 < 1.2, `mean aggression ${sum / 300}`);
});

test("markdown export and HTML rendering of a real model response", () => {
  const character = JSON.parse(readFileSync(new URL("./fixtures/sample_character.json", import.meta.url)));
  const spec = randomize(createEmptySpec(fields), { rng: mulberry32(1) });
  spec.additional_prompt = "Elfka w dystopijnym mieście.";
  const md = toMarkdown({ format: "json", character }, spec, fields);
  assert.match(md, /^# \S/);
  for (let n = 1; n <= 13; n++) assert.match(md, new RegExp(`^## ${n}\\. `, "m"));
  assert.match(md, /## Karta postaci/);
  assert.match(md, /> Elfka w dystopijnym mieście\./);
  const html = renderCharacterHTML(character);
  assert.ok(html.includes("Sytuacje graniczne") && html.includes("<blockquote>"));
  assert.ok(!/<script/i.test(renderCharacterHTML({ ...character, koncepcja: "<script>alert(1)</script>" })));
});
