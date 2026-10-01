// Character spec model + randomizer + coherence pass.
// Pure functions, no DOM: used by the browser app and by the Node tests.
//
// Every field is a cell: { value, source } where source is
//   "user"      – typed/clicked by the user, LOCKED, never modified here
//   "generated" – produced by the randomizer (or by the LLM for basic fields)
//   "unset"     – empty, value is null ("" for text)

export const NUMERIC_SECTIONS = ["life_priorities", "mental_axes", "character_traits", "social_traits"];

// Weighted distributions (index = value offset from min).
export const DIST = {
  axis: { min: 1, weights: [15, 20, 30, 20, 15] },             // 1..5
  level: { min: 0, weights: [5, 15, 25, 30, 20, 5] },          // 0..5 traits
  priority: { min: 0, weights: [6, 14, 24, 26, 20, 10] },      // 0..5 life priorities
};

export function sectionKind(section) {
  return section === "mental_axes" ? "axis" : "level";
}

function distFor(section) {
  if (section === "mental_axes") return DIST.axis;
  if (section === "life_priorities") return DIST.priority;
  return DIST.level;
}

function range(section) {
  return section === "mental_axes" ? [1, 5] : [0, 5];
}

export function cell(value = null, source = "unset") {
  return { value, source };
}

export function createEmptySpec(fields) {
  const spec = { basic: {}, additional_prompt: "" };
  for (const f of fields.basic.fields) spec.basic[f.key] = cell("", "unset");
  for (const s of NUMERIC_SECTIONS) {
    spec[s] = {};
    for (const f of fields[s].fields) spec[s][f.key] = cell(null, "unset");
  }
  return spec;
}

export function cloneSpec(spec) {
  return JSON.parse(JSON.stringify(spec));
}

function weightedPick(weights, rng) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function sampleAround(target, [lo, hi], rng) {
  // 55% exact, 22.5% one step either way (clamped).
  const r = rng();
  const v = r < 0.55 ? target : r < 0.775 ? target - 1 : target + 1;
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// Prompt biases: the free-form prompt outranks random values, so obvious
// keywords steer the distribution. The LLM remains the final guard.
// Each entry: regex on lowercased prompt, optional `unless` regex, and targets.
export const PROMPT_BIASES = [
  { re: /nie\s+(jest|była?|był|będzie)\s+(żadn\w*\s+)?(wojown|wojak|zabój|najemni|żołnierz)/,
    set: { mental_axes: { pacifist_vs_aggressor: 2, risktaker_vs_coward: 3 }, social_traits: { aggression: 1 } } },
  { re: /(wojown|wojak|najemni|zabój|żołnierz|gladiator|barbarzyń)/,
    unless: /nie\s+(jest|była?|był|będzie)\s+(żadn\w*\s+)?(wojown|wojak|zabój|najemni|żołnierz)/,
    set: { mental_axes: { pacifist_vs_aggressor: 4, bold_vs_shy: 2, risktaker_vs_coward: 2 }, social_traits: { aggression: 3 } } },
  { re: /(pacyfist|nie\s+(lubi|znosi)\s+przemocy|brzydzi\s+się\s+przemoc)/,
    set: { mental_axes: { pacifist_vs_aggressor: 1 }, social_traits: { aggression: 0 } } },
  { re: /(nieśmiał|wstydliw|zamknięt\w*\s+w\s+sobie|introwerty)/,
    set: { mental_axes: { bold_vs_shy: 4, extravert_vs_introvert: 4 }, character_traits: { shyness: 4 } } },
  { re: /(ekstrawerty|towarzysk|dusza\s+towarzystwa)/,
    set: { mental_axes: { extravert_vs_introvert: 2 }, social_traits: { loneliness: 1 } } },
  { re: /spokojn[a-ząęółśżźćń]*(?![a-ząęółśżźćń])(?!\s+(świe|mie|kraj|czas|okoli|wsi|miej|krain|królest|życi))|opanowan|łagodn/,
    set: { mental_axes: { calm_vs_expressive: 2, pacifist_vs_aggressor: 2 }, character_traits: { hot_temper: 1 }, social_traits: { patience: 4 } } },
  { re: /(aroganc|wynios|zarozumia|pyszn|pysz\w*\s)/,
    set: { mental_axes: { likeable_vs_arrogant: 4 }, social_traits: { self_confidence: 4 } } },
  { re: /(lider|przywódc|dowódc|wódz|\bkról|\bksiąż\w*\s+pan)/,
    set: { mental_axes: { leader_vs_worker: 2 }, social_traits: { self_confidence: 4, charisma: 4 } } },
  { re: /leniw/, set: { mental_axes: { diligent_vs_lazy: 4 } } },
  { re: /(pracowit|sumienn|pracoholi)/, set: { mental_axes: { diligent_vs_lazy: 1 } } },
  { re: /(inteligent|genialn|błyskotliw|uczon|naukow|mędr|mędrc|erudyt)/,
    set: { social_traits: { intelligence: 4 }, life_priorities: { education: 4 } } },
  { re: /nauczyciel|profesor|bibliotekar/, set: { life_priorities: { education: 4 }, social_traits: { intelligence: 3 } } },
  { re: /(samotni|odludek|odludk|pustelni)/,
    set: { social_traits: { loneliness: 4 }, mental_axes: { extravert_vs_introvert: 4 } } },
  { re: /(wesoł|pogodn|radosn|optymist)/,
    set: { social_traits: { life_satisfaction: 4 }, character_traits: { grumpiness: 1 } } },
  { re: /(zgorzknia|zrzędl|marud|cyniczn|cynik)/,
    set: { character_traits: { grumpiness: 4 }, social_traits: { life_satisfaction: 2 } } },
  { re: /(okrutn|sadyst|bezwzględn|złoczyń|antagonist|czarny\s+charakter)/,
    set: { mental_axes: { kind_vs_cruel: 4 }, character_traits: { empathy: 1 }, social_traits: { malice: 4 } } },
  { re: /(dobr\w*\s+serc|życzliw|opiekuńcz|empatyczn)/,
    set: { mental_axes: { kind_vs_cruel: 2 }, character_traits: { empathy: 4 } } },
  { re: /(tchórz|lękliw|bojaźliw|strachliw)/,
    set: { mental_axes: { risktaker_vs_coward: 4 }, social_traits: { general_anxiety: 4 } } },
  { re: /(odważn|brawur|ryzykan|awanturni|poszukiwacz\w*\s+przygód)/,
    set: { mental_axes: { risktaker_vs_coward: 2 } } },
  { re: /ambitn/, set: { character_traits: { ambition: 4 } } },
  { re: /(gaduł|rozgadan|papla)/, set: { character_traits: { talkativeness: 5 } } },
  { re: /(perfekcjonist|pedant)/, set: { character_traits: { perfectionism: 4 } } },
  { re: /(zazdrosn)/, set: { character_traits: { jealousy: 4 } } },
  { re: /(uciekł\w*\s+z\s+domu|zerwał\w*\s+z\s+rodzin|wydziedzicz)/, set: { life_priorities: { family: 2 } } },
  { re: /(władz|tron|polityk|intryg)/, set: { life_priorities: { power: 3 } } },
];

export function promptBiases(prompt) {
  const text = (prompt || "").toLowerCase();
  const out = {};
  if (!text.trim()) return out;
  for (const b of PROMPT_BIASES) {
    if (!b.re.test(text)) continue;
    if (b.unless && b.unless.test(text)) continue;
    for (const [sec, vals] of Object.entries(b.set)) {
      out[sec] = out[sec] || {};
      for (const [k, v] of Object.entries(vals)) {
        if (out[sec][k] === undefined) out[sec][k] = v; // first match wins (negations listed first)
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coherence rules. Values are normalised to 0..1 (axis: 0 = left pole,
// 1 = right pole; level: v/5). "same": the two should be close;
// "opposite": high on one implies low on the other. Violation when gap > tol.
export const RULES = [
  ["mental_axes.extravert_vs_introvert", "social_traits.charisma", "opposite"],
  ["mental_axes.extravert_vs_introvert", "character_traits.talkativeness", "opposite"],
  ["mental_axes.extravert_vs_introvert", "social_traits.eloquence", "opposite"],
  ["mental_axes.extravert_vs_introvert", "social_traits.loneliness", "same"],
  ["mental_axes.bold_vs_shy", "character_traits.shyness", "same"],
  ["mental_axes.bold_vs_shy", "social_traits.self_confidence", "opposite"],
  ["mental_axes.kind_vs_cruel", "character_traits.empathy", "opposite"],
  ["mental_axes.kind_vs_cruel", "social_traits.malice", "same"],
  ["mental_axes.kind_vs_cruel", "character_traits.politeness", "opposite", 0.8],
  ["mental_axes.pacifist_vs_aggressor", "social_traits.aggression", "same"],
  ["mental_axes.reflective_vs_impulsive", "character_traits.hot_temper", "same"],
  ["mental_axes.reflective_vs_impulsive", "social_traits.patience", "opposite"],
  ["mental_axes.likeable_vs_arrogant", "character_traits.politeness", "opposite", 0.8],
  ["mental_axes.likeable_vs_arrogant", "character_traits.rudeness", "same"],
  ["mental_axes.calm_vs_expressive", "character_traits.hot_temper", "same", 0.8],
  ["mental_axes.leader_vs_worker", "social_traits.self_confidence", "opposite", 0.8],
  ["mental_axes.leader_vs_worker", "life_priorities.power", "opposite", 0.8],
  ["mental_axes.diligent_vs_lazy", "character_traits.ambition", "opposite", 0.8],
  ["mental_axes.diligent_vs_lazy", "character_traits.perfectionism", "opposite"],
  ["mental_axes.risktaker_vs_coward", "social_traits.general_anxiety", "same"],
  ["character_traits.empathy", "social_traits.malice", "opposite"],
  ["character_traits.shyness", "social_traits.self_confidence", "opposite"],
  ["character_traits.shyness", "character_traits.talkativeness", "opposite", 0.8],
  ["character_traits.politeness", "character_traits.rudeness", "opposite"],
  ["character_traits.hot_temper", "social_traits.patience", "opposite"],
  ["character_traits.grumpiness", "social_traits.life_satisfaction", "opposite", 0.8],
  ["social_traits.general_anxiety", "social_traits.self_confidence", "opposite"],
  ["social_traits.general_anxiety", "social_traits.life_satisfaction", "opposite", 0.8],
  ["life_priorities.popularity", "social_traits.loneliness", "opposite", 0.8],
  ["life_priorities.friends", "social_traits.loneliness", "opposite", 0.8],
  ["life_priorities.power", "character_traits.ambition", "same", 0.8],
].map(([a, b, rel, tol = 0.7]) => ({ a: a.split("."), b: b.split("."), rel, tol }));

function norm(section, v) {
  return section === "mental_axes" ? (v - 1) / 4 : v / 5;
}

function gap(rule, va, vb) {
  const na = norm(rule.a[0], va);
  const nb = norm(rule.b[0], vb);
  return rule.rel === "same" ? Math.abs(na - nb) : Math.abs(na - (1 - nb));
}

function getCell(spec, [sec, key]) {
  return spec[sec] && spec[sec][key];
}

export function violations(spec) {
  const out = [];
  for (const rule of RULES) {
    const ca = getCell(spec, rule.a), cb = getCell(spec, rule.b);
    if (!ca || !cb || ca.value === null || cb.value === null) continue;
    const g = gap(rule, ca.value, cb.value);
    if (g > rule.tol + 1e-9) out.push({ rule, gap: g });
  }
  return out;
}

// Smallest change to `movePath` that satisfies the rule.
function closestValid(spec, rule, movePath) {
  const [lo, hi] = range(movePath[0]);
  const cur = getCell(spec, movePath).value;
  const moveIsA = movePath === rule.a;
  const other = getCell(spec, moveIsA ? rule.b : rule.a).value;
  for (let d = 1; d <= hi - lo; d++) {
    for (const cand of [cur - d, cur + d]) {
      if (cand < lo || cand > hi) continue;
      const g = moveIsA ? gap(rule, cand, other) : gap(rule, other, cand);
      if (g <= rule.tol + 1e-9) return cand;
    }
  }
  return cur;
}

/**
 * Adjusts generated values that clash. User values are never touched.
 * Prompt-biased generated values are preferred over plain random ones.
 * With probability `keepChance` one clash among generated values is kept
 * as an "interesting contradiction" for the LLM to explain.
 */
export function coherencePass(spec, { rng = Math.random, biased = {}, keepChance = 0.3 } = {}) {
  const weight = ([sec, key]) => {
    const c = getCell(spec, [sec, key]);
    if (c.source === "user") return 2;
    return biased[sec] && biased[sec][key] !== undefined ? 1 : 0;
  };
  let keptOne = rng() >= keepChance; // true = no budget for keeping
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const { rule } of violations(spec)) {
      const wa = weight(rule.a), wb = weight(rule.b);
      if (wa === 2 && wb === 2) continue; // user wants this contradiction
      if (!keptOne && pass === 0 && wa < 2 && wb < 2) { keptOne = true; continue; }
      let move;
      if (wa !== wb) move = wa < wb ? rule.a : rule.b;
      else move = rng() < 0.5 ? rule.a : rule.b;
      const c = getCell(spec, move);
      if (c.source === "user") continue;
      const nv = closestValid(spec, rule, move);
      if (nv !== c.value) { c.value = nv; changed = true; }
    }
    if (!changed) break;
  }
  balancePriorities(spec, rng);
  return spec;
}

// Life priorities: somebody should care strongly about something, and not
// everything can be "most important".
function balancePriorities(spec, rng) {
  const cells = Object.values(spec.life_priorities);
  const gen = cells.filter((c) => c.source === "generated");
  if (!gen.length) return;
  if (!cells.some((c) => c.value !== null && c.value >= 4)) {
    const pick = gen[Math.floor(rng() * gen.length)];
    pick.value = rng() < 0.6 ? 4 : 5;
  }
  let fives = cells.filter((c) => c.value === 5);
  while (fives.length > 2) {
    const g = fives.filter((c) => c.source === "generated");
    if (!g.length) break;
    g[Math.floor(rng() * g.length)].value = 4;
    fives = cells.filter((c) => c.value === 5);
  }
}

/**
 * Randomizes numeric fields.
 *   mode "fill"   – only "unset" fields (used by Generuj/Losuj cechy)
 *   mode "reroll" – "unset" and "generated" fields (Losuj ponownie)
 * Basic text fields are never randomized here: when empty, the LLM invents
 * them in context of the prompt/world. In "reroll" mode generated basic
 * fields are cleared so the LLM invents new ones.
 */
export function randomize(spec, { mode = "fill", rng = Math.random, keepChance = 0.3 } = {}) {
  const out = cloneSpec(spec);
  const biases = promptBiases(out.additional_prompt);
  const biased = {};
  if (mode === "reroll") {
    for (const c of Object.values(out.basic)) if (c.source === "generated") Object.assign(c, cell("", "unset"));
  }
  for (const sec of NUMERIC_SECTIONS) {
    for (const [key, c] of Object.entries(out[sec])) {
      const eligible = c.source === "unset" || (mode === "reroll" && c.source === "generated");
      if (!eligible) continue;
      const target = biases[sec] && biases[sec][key];
      let v;
      if (target !== undefined) {
        v = sampleAround(target, range(sec), rng);
        (biased[sec] = biased[sec] || {})[key] = true;
      } else {
        const d = distFor(sec);
        v = d.min + weightedPick(d.weights, rng);
      }
      out[sec][key] = cell(v, "generated");
    }
  }
  return coherencePass(out, { rng, biased, keepChance });
}

export function hasUnsetNumeric(spec) {
  return NUMERIC_SECTIONS.some((s) => Object.values(spec[s]).some((c) => c.source === "unset"));
}

/** Clears generated values (numeric and basic), keeps user values. */
export function resetGenerated(spec) {
  const out = cloneSpec(spec);
  for (const c of Object.values(out.basic)) if (c.source === "generated") Object.assign(c, cell("", "unset"));
  for (const s of NUMERIC_SECTIONS)
    for (const c of Object.values(out[s])) if (c.source === "generated") Object.assign(c, cell(null, "unset"));
  return out;
}

/** Tensions the LLM must explain (not flatten). Uses field labels. */
export function describeTensions(spec, fields) {
  const label = ([sec, key]) => {
    const f = fields[sec].fields.find((x) => x.key === key);
    const v = spec[sec][key].value;
    return sec === "mental_axes" ? `${f.left}↔${f.right}=${v}/5` : `${f.label}=${v}/5`;
  };
  return violations(spec).map(({ rule }) => {
    const both = getCell(spec, rule.a).source === "user" && getCell(spec, rule.b).source === "user";
    return `${label(rule.a)} vs ${label(rule.b)}${both ? " (oba wybrane przez autora)" : ""}`;
  });
}
