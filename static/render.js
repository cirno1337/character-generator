// Rendering of the generated character (HTML) and Markdown/JSON export.

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const BASIC_LABELS = [
  ["imie_nazwisko", "Imię/nazwisko"], ["rasa", "Rasa"], ["urodziny", "Urodziny"], ["klasa", "Klasa"],
  ["plec", "Płeć"], ["wzrost", "Wzrost"], ["podklasa", "Podklasa"],
];

// Maps LLM basic keys to spec.basic keys.
export const BASIC_KEY_MAP = {
  imie_nazwisko: "name", rasa: "race", urodziny: "birthday", klasa: "class",
  plec: "gender", wzrost: "height", podklasa: "subclass",
};

// Section model shared by HTML rendering and Markdown export.
// kind: text | kv | list | pairs | cards | quotes
export const SECTIONS = [
  { n: 1, title: "Podstawowa koncepcja", get: (c) => ({ kind: "text", value: c.koncepcja }) },
  { n: 2, title: "Motywacja", get: (c) => ({ kind: "kv", value: [
    ["Czego chce", c.motywacja?.czego_chce], ["Dlaczego", c.motywacja?.dlaczego],
    ["Co jest gotowa poświęcić", c.motywacja?.co_poswieci], ["Czego boi się stracić", c.motywacja?.czego_boi_sie_stracic],
  ] }) },
  { n: 3, title: "Przeszłość", get: (c) => ({ kind: "kv", value: [
    ["Dzieciństwo i rodzina", c.przeszlosc?.dziecinstwo_i_rodzina], ["Edukacja", c.przeszlosc?.edukacja],
    ["Ważne relacje", c.przeszlosc?.wazne_relacje], ["Sukcesy i porażki", c.przeszlosc?.sukcesy_i_porazki],
  ], extra: { label: "Wydarzenia kształtujące", kind: "pairs",
    value: (c.przeszlosc?.wydarzenia_ksztaltujace || []).map((e) => [e.wydarzenie, e.wplyw]) } }) },
  { n: 4, title: "Osobowość", get: (c) => ({ kind: "kv", value: [
    ["Zachowanie", c.osobowosc?.zachowanie], ["Myślenie", c.osobowosc?.myslenie],
    ["Sposób mówienia", c.osobowosc?.sposob_mowienia], ["Wobec obcych", c.osobowosc?.wobec_obcych],
    ["Wobec przyjaciół", c.osobowosc?.wobec_przyjaciol], ["Pod presją", c.osobowosc?.pod_presja],
  ], lists: [
    ["Mocne strony", c.osobowosc?.mocne_strony], ["Słabości", c.osobowosc?.slabosci], ["Sprzeczności", c.osobowosc?.sprzecznosci],
  ] }) },
  { n: 5, title: "Przekonania i światopogląd", get: (c) => ({ kind: "pairs", value: (c.swiatopoglad || []).map((x) => [x.temat, x.poglad]) }) },
  { n: 6, title: "Pasje i zainteresowania", get: (c) => ({ kind: "pairs", value: (c.pasje || []).map((x) => [x.nazwa, x.opis]) }) },
  { n: 7, title: "Relacje", get: (c) => ({ kind: "pairs", value: (c.relacje || []).map((x) => [x.z_kim, x.wzorzec]) }) },
  { n: 8, title: "Codzienność", get: (c) => ({ kind: "text", value: c.codziennosc }) },
  { n: 9, title: "Sytuacje graniczne", get: (c) => ({ kind: "cards", value: c.sytuacje_graniczne || [] }) },
  { n: 10, title: "Wewnętrzny konflikt", get: (c) => ({ kind: "kv", value: [
    ["Co myśli o sobie", c.konflikt_wewnetrzny?.przekonanie_o_sobie], ["Jak jest naprawdę", c.konflikt_wewnetrzny?.prawda],
    ["Czego chce", c.konflikt_wewnetrzny?.czego_chce], ["Czego naprawdę potrzebuje", c.konflikt_wewnetrzny?.czego_potrzebuje],
  ] }) },
  { n: 11, title: "Potencjalny rozwój postaci", get: (c) => ({ kind: "kv", value: [
    ["Możliwy łuk", c.rozwoj?.mozliwy_luk], ["Co mogłoby ją zmienić", c.rozwoj?.co_moze_zmienic],
    ["Czego może się nauczyć", c.rozwoj?.czego_moze_sie_nauczyc], ["Co mogłoby ją złamać", c.rozwoj?.co_moze_zlamac],
    ["Co może ją wzmocnić", c.rozwoj?.co_wzmocni], ["Czego odmówi zmiany", c.rozwoj?.czego_nie_zmieni],
  ] }) },
  { n: 12, title: "Charakterystyczne detale", get: (c) => ({ kind: "list", value: c.detale || [] }) },
  { n: 13, title: "Przykładowe wypowiedzi", get: (c) => ({ kind: "quotes", value: c.wypowiedzi || [] }) },
];

const CARD_FIELDS = [["reakcja", "Reakcja"], ["decyzja", "Decyzja"], ["konsekwencja", "Konsekwencja"], ["co_ujawnia", "Co to ujawnia"]];

const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== "";

function paras(text) {
  return String(text || "").split(/\n{2,}|\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p)}</p>`).join("");
}

function htmlBlock(b) {
  switch (b.kind) {
    case "text":
      return paras(b.value);
    case "kv":
      return `<dl class="kv">${b.value.filter(([, v]) => nonEmpty(v)).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${paras(v)}</dd>`).join("")}</dl>`;
    case "pairs":
      return `<ul class="pairs">${b.value.filter(([a, v]) => nonEmpty(a) || nonEmpty(v)).map(([a, v]) => `<li><strong>${esc(a)}</strong> ${esc(v)}</li>`).join("")}</ul>`;
    case "list":
      return `<ul class="bullets">${b.value.filter(nonEmpty).map((v) => `<li>${esc(v)}</li>`).join("")}</ul>`;
    case "cards":
      return `<div class="situations">${b.value.map((s, i) => `
        <article class="situation">
          <h4><span class="sit-n">${i + 1}</span>${esc(s.sytuacja)}</h4>
          <dl>${CARD_FIELDS.filter(([k]) => nonEmpty(s[k])).map(([k, l]) => `<dt>${l}</dt><dd>${esc(s[k])}</dd>`).join("")}</dl>
        </article>`).join("")}</div>`;
    case "quotes":
      return `<div class="quotes">${b.value.filter((q) => nonEmpty(q.kwestia)).map((q) => `
        <blockquote><p>„${esc(q.kwestia.replace(/^[„"“]+|[”"]+$/g, ""))}”</p>${nonEmpty(q.kontekst) ? `<cite>${esc(q.kontekst)}</cite>` : ""}</blockquote>`).join("")}</div>`;
  }
  return "";
}

export function renderCharacterHTML(c) {
  const basics = BASIC_LABELS.slice(1).map(([k, l]) => [l, c.dane_podstawowe?.[k]]).filter(([, v]) => nonEmpty(v));
  const name = c.dane_podstawowe?.imie_nazwisko || "Bez imienia";
  const subtitle = [c.dane_podstawowe?.rasa, c.dane_podstawowe?.klasa, c.dane_podstawowe?.podklasa].filter(nonEmpty).join(" · ");
  let html = `<header class="char-head">
      <h2>${esc(name)}</h2>
      ${subtitle ? `<p class="char-sub">${esc(subtitle)}</p>` : ""}
      <div class="chips">${basics.map(([l, v]) => `<span class="chip"><em>${esc(l)}</em>${esc(v)}</span>`).join("")}</div>
    </header>`;
  for (const s of SECTIONS) {
    const b = s.get(c);
    let body = htmlBlock(b);
    if (b.extra && b.extra.value.length) body += `<h4 class="sub">${esc(b.extra.label)}</h4>` + htmlBlock(b.extra);
    if (b.lists) {
      body += `<div class="trio">${b.lists.filter(([, v]) => v && v.length).map(([l, v]) =>
        `<div><h4 class="sub">${esc(l)}</h4>${htmlBlock({ kind: "list", value: v })}</div>`).join("")}</div>`;
    }
    const cls = s.n === 1 ? "sec sec-concept" : "sec";
    html += `<section class="${cls}"><h3><span class="sec-n">${s.n}</span>${esc(s.title)}</h3>${body}</section>`;
  }
  return html;
}

// Tiny Markdown → HTML for the non-JSON fallback. Input is escaped first.
export function markdownToHTML(md) {
  const lines = esc(md).split("\n");
  let html = "", inList = false;
  const inline = (t) => t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>");
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (!li && inList) { html += "</ul>"; inList = false; }
    if (h) html += `<h${Math.min(4, h[1].length + 1)}>${inline(h[2])}</h${Math.min(4, h[1].length + 1)}>`;
    else if (li) { if (!inList) { html += "<ul class='bullets'>"; inList = true; } html += `<li>${inline(li[1])}</li>`; }
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += "</ul>";
  return html;
}

// --------------------------------------------------------------------------- Markdown export

function mdBlock(b) {
  switch (b.kind) {
    case "text": return String(b.value || "").trim();
    case "kv": return b.value.filter(([, v]) => nonEmpty(v)).map(([k, v]) => `**${k}.** ${String(v).trim()}`).join("\n\n");
    case "pairs": return b.value.filter(([a, v]) => nonEmpty(a) || nonEmpty(v)).map(([a, v]) => `- **${a}** – ${v}`).join("\n");
    case "list": return b.value.filter(nonEmpty).map((v) => `- ${v}`).join("\n");
    case "cards": return b.value.map((s, i) => `### ${i + 1}. ${s.sytuacja}\n\n` +
      CARD_FIELDS.filter(([k]) => nonEmpty(s[k])).map(([k, l]) => `- **${l}:** ${s[k]}`).join("\n")).join("\n\n");
    case "quotes": return b.value.filter((q) => nonEmpty(q.kwestia)).map((q) =>
      `> „${q.kwestia.replace(/^[„"“]+|[”"]+$/g, "")}”${nonEmpty(q.kontekst) ? `\n> — *${q.kontekst}*` : ""}`).join("\n\n");
  }
  return "";
}

function specAppendix(spec, fields) {
  if (!spec || !fields) return "";
  const out = ["## Karta postaci", ""];
  const mark = (src) => (src === "user" ? "🔒" : "🎲");
  const lv = (sec) => fields[sec].fields
    .filter((f) => spec[sec]?.[f.key]?.value !== null && spec[sec]?.[f.key]?.value !== undefined)
    .map((f) => `| ${f.label} | ${"●".repeat(spec[sec][f.key].value)}${"○".repeat(5 - spec[sec][f.key].value)} ${spec[sec][f.key].value} | ${mark(spec[sec][f.key].source)} |`);
  for (const sec of ["life_priorities", "character_traits", "social_traits"]) {
    const rows = lv(sec);
    if (rows.length) out.push(`### ${fields[sec].title}`, "", "| Cecha | Poziom (0–5) | |", "|---|---|---|", ...rows, "");
  }
  const axes = fields.mental_axes.fields.filter((f) => spec.mental_axes?.[f.key]?.value);
  if (axes.length) {
    out.push(`### ${fields.mental_axes.title}`, "", "| | Skala 1–5 | | |", "|---|---|---|---|");
    for (const f of axes) {
      const c = spec.mental_axes[f.key];
      out.push(`| ${f.left} | ${[1, 2, 3, 4, 5].map((i) => (i === c.value ? "●" : "○")).join(" ")} | ${f.right} | ${mark(c.source)} |`);
    }
    out.push("");
  }
  out.push("*🔒 = wybrane przez autora, 🎲 = wylosowane*");
  return out.join("\n");
}

export function toMarkdown(result, spec, fields) {
  if (!result) return "";
  const parts = [];
  if (result.format === "markdown") {
    parts.push(result.markdown.trim());
  } else {
    const c = result.character;
    parts.push(`# ${c.dane_podstawowe?.imie_nazwisko || "Bez imienia"}`, "");
    const basics = BASIC_LABELS.map(([k, l]) => [l, c.dane_podstawowe?.[k]]).filter(([, v]) => nonEmpty(v));
    if (basics.length) parts.push(basics.map(([l, v]) => `- **${l}:** ${v}`).join("\n"), "");
    for (const s of SECTIONS) {
      const b = s.get(c);
      parts.push(`## ${s.n}. ${s.title}`, "", mdBlock(b), "");
      if (b.extra && b.extra.value.length) parts.push(`**${b.extra.label}:**`, "", mdBlock(b.extra), "");
      if (b.lists) for (const [l, v] of b.lists) if (v && v.length) parts.push(`**${l}:**`, "", mdBlock({ kind: "list", value: v }), "");
    }
  }
  if (spec && nonEmpty(spec.additional_prompt)) {
    parts.push("## Założenia autora", "", spec.additional_prompt.trim().split("\n").map((l) => `> ${l}`).join("\n"), "");
  }
  const app = specAppendix(spec, fields);
  if (app) parts.push(app, "");
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function characterName(result) {
  if (!result) return "postac";
  if (result.format === "json") return result.character?.dane_podstawowe?.imie_nazwisko || "Bez imienia";
  const m = (result.markdown || "").match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "Bez imienia";
}

export function slug(s) {
  return String(s || "postac").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L")
    .replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "postac";
}
