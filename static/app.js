import {
  NUMERIC_SECTIONS, createEmptySpec, cloneSpec, cell, randomize, resetGenerated,
  hasUnsetNumeric, describeTensions, sectionKind,
} from "./randomizer.js";
import {
  esc, renderCharacterHTML, markdownToHTML, toMarkdown, characterName, slug, BASIC_KEY_MAP,
} from "./render.js";

const DRAFT_KEY = "character-generator:draft:v1";
const EXPECTED_TOKENS = 4500; // typical length of a full profile, for the progress bar

const $ = (sel, root = document) => root.querySelector(sel);

let fields;           // fields.json
let spec;             // current character sheet – cells {value, source}
let result = null;    // { format, character | markdown, warning, generatedAt, spec, specKey }
let busy = false;
let abortCtl = null;
let llmOk = false;

// ---------------------------------------------------------------------------- utils

function specKey(s) {
  const strip = (sec) => Object.fromEntries(Object.entries(s[sec]).map(([k, c]) => [k, [c.value, c.source]]));
  return JSON.stringify({ b: strip("basic"), ...Object.fromEntries(NUMERIC_SECTIONS.map((x) => [x, strip(x)])), p: (s.additional_prompt || "").trim() });
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), isErr ? 5000 : 2200);
}

// Two-click confirmation instead of blocking browser dialogs.
function confirmClick(btn, action, label = "Na pewno?") {
  if (btn.dataset.armed) {
    delete btn.dataset.armed;
    btn.classList.remove("confirm");
    btn.innerHTML = btn.dataset.orig;
    action();
    return;
  }
  btn.dataset.armed = "1";
  btn.dataset.orig = btn.innerHTML;
  btn.classList.add("confirm");
  btn.textContent = label;
  setTimeout(() => {
    if (!btn.dataset.armed) return;
    delete btn.dataset.armed;
    btn.classList.remove("confirm");
    btn.innerHTML = btn.dataset.orig;
  }, 3000);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function saveDraft() {
  clearTimeout(saveDraft._t);
  saveDraft._t = setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ spec, result })); } catch { /* ignore */ }
  }, 250);
}

function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    if (d && d.spec) return d;
  } catch { /* ignore */ }
  return null;
}

// Merge a stored spec onto the current field layout (fields may have changed).
function adoptSpec(stored) {
  const fresh = createEmptySpec(fields);
  if (!stored) return fresh;
  for (const sec of ["basic", ...NUMERIC_SECTIONS]) {
    for (const key of Object.keys(fresh[sec])) {
      const c = stored[sec] && stored[sec][key];
      if (c && ["user", "generated", "unset"].includes(c.source)) fresh[sec][key] = { value: c.value, source: c.source };
    }
  }
  fresh.additional_prompt = stored.additional_prompt || "";
  return fresh;
}

// ---------------------------------------------------------------------------- source badge

function srcBadge(source, extra = "") {
  if (source === "user") return `<button type="button" class="src user" data-act="src" title="Twoja wartość – kliknij, aby oddać ją losowaniu" ${extra}>🔒</button>`;
  if (source === "generated") return `<button type="button" class="src generated" data-act="src" title="Wylosowane – kliknij, aby zablokować tę wartość" ${extra}>🎲</button>`;
  return `<span class="src unset" title="Puste – zostanie wylosowane">?</span>`;
}

function toggleSource(c) {
  if (c.source === "user") c.source = "generated";
  else if (c.source === "generated") c.source = "user";
}

// ---------------------------------------------------------------------------- basic fields

function buildBasic() {
  const grid = $("#basic-grid");
  grid.innerHTML = fields.basic.fields.map((f) => `
    <div class="field" data-key="${f.key}">
      <label for="basic-${f.key}">${esc(f.label)}</label>
      <div class="inwrap">
        <input id="basic-${f.key}" type="text" autocomplete="off" placeholder="${esc(f.placeholder || "")}">
        <span class="src-slot"></span>
      </div>
    </div>`).join("");

  grid.addEventListener("input", (e) => {
    const box = e.target.closest(".field");
    if (!box) return;
    const val = e.target.value;
    spec.basic[box.dataset.key] = val.trim() ? cell(val, "user") : cell("", "unset");
    updateBasicField(box.dataset.key, false);
    changed();
  });
  grid.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act=src]");
    if (!b) return;
    const key = b.closest(".field").dataset.key;
    toggleSource(spec.basic[key]);
    updateBasicField(key, false);
    changed();
  });
}

function updateBasicField(key, setValue = true) {
  const box = $(`#basic-grid .field[data-key="${key}"]`);
  const c = spec.basic[key];
  box.className = `field ${c.source}`;
  if (setValue) box.querySelector("input").value = c.value || "";
  box.querySelector(".src-slot").innerHTML = srcBadge(c.source);
}

// ---------------------------------------------------------------------------- scales

function rowHTML(section, f, c) {
  const kind = sectionKind(section);
  const src = c.source;
  const v = c.value;
  if (kind === "axis") {
    const dots = [1, 2, 3, 4, 5].map((i) =>
      `<button type="button" class="dot-btn ${v === i ? "on" : ""} ${i === 3 ? "mid" : ""}" data-v="${i}"
        aria-label="${esc(f.left)} ↔ ${esc(f.right)}: ${i}" aria-pressed="${v === i}"></button>`).join("");
    const leftCls = v === null ? "" : v <= 2 ? "active" : v >= 4 ? "dim" : "";
    const rightCls = v === null ? "" : v >= 4 ? "active" : v <= 2 ? "dim" : "";
    return `<span class="lbl left ${leftCls}">${esc(f.left)}</span>
      <div class="dots">${dots}</div>
      <span class="lbl right ${rightCls}">${esc(f.right)}</span>
      ${srcBadge(src)}
      <button type="button" class="clear-btn" data-act="clear" title="Wyczyść (do wylosowania)">✕</button>`;
  }
  const dots = [1, 2, 3, 4, 5].map((i) =>
    `<button type="button" class="dot-btn ${v !== null && i <= v ? "on" : ""}" data-v="${i}"
      aria-label="${esc(f.label)}: ${i}" aria-pressed="${v === i}"></button>`).join("");
  return `<span class="lbl">${esc(f.label)}</span>
    <div class="dots"><button type="button" class="zero-btn ${v === 0 ? "on" : ""}" data-v="0"
      title="0 = świadomie nieistotne / brak" aria-label="${esc(f.label)}: 0" aria-pressed="${v === 0}">0</button>${dots}</div>
    ${srcBadge(src)}
    <button type="button" class="clear-btn" data-act="clear" title="Wyczyść (do wylosowania)">✕</button>`;
}

function buildScales() {
  for (const section of NUMERIC_SECTIONS) {
    const box = $(`.scales[data-section="${section}"]`);
    box.innerHTML = fields[section].fields.map((f) =>
      `<div class="scale-row" data-key="${f.key}" role="group" aria-label="${esc(f.label || `${f.left} ↔ ${f.right}`)}"></div>`).join("");
    box.addEventListener("click", (e) => {
      const row = e.target.closest(".scale-row");
      if (!row) return;
      const key = row.dataset.key;
      const c = spec[section][key];
      const dot = e.target.closest("[data-v]");
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (dot) {
        const v = Number(dot.dataset.v);
        // clicking your own current value again clears it
        spec[section][key] = c.source === "user" && c.value === v ? cell(null, "unset") : cell(v, "user");
      } else if (act === "src") {
        toggleSource(c);
      } else if (act === "clear") {
        spec[section][key] = cell(null, "unset");
      } else return;
      const focusSel = dot ? `[data-v="${dot.dataset.v}"]` : null;
      updateRow(section, key);
      if (focusSel) row.querySelector(focusSel)?.focus();
      changed();
    });
  }
}

function updateRow(section, key) {
  const row = $(`.scales[data-section="${section}"] .scale-row[data-key="${key}"]`);
  const f = fields[section].fields.find((x) => x.key === key);
  const c = spec[section][key];
  row.className = `scale-row ${c.source}`;
  row.innerHTML = rowHTML(section, f, c);
}

function updateMeta() {
  for (const sec of ["basic", ...NUMERIC_SECTIONS]) {
    const cells = Object.values(spec[sec]);
    const u = cells.filter((c) => c.source === "user").length;
    const g = cells.filter((c) => c.source === "generated").length;
    const n = cells.length - u - g;
    const meta = $(`#card-${sec} .card-meta`);
    if (meta) meta.innerHTML = [u && `<b class="u">${u} 🔒</b>`, g && `<b class="g">${g} 🎲</b>`, n && `${n} pustych`].filter(Boolean).join(" · ");
  }
}

function renderAllFields() {
  for (const f of fields.basic.fields) updateBasicField(f.key);
  for (const sec of NUMERIC_SECTIONS) for (const f of fields[sec].fields) updateRow(sec, f.key);
  $("#prompt").value = spec.additional_prompt || "";
  updateMeta();
  updateStale();
}

function changed() {
  updateMeta();
  updateStale();
  saveDraft();
}

function updateStale() {
  $("#stale").hidden = !(result && !busy && result.specKey !== specKey(spec));
}

// ---------------------------------------------------------------------------- actions

function setBusy(b) {
  busy = b;
  for (const id of ["btn-roll", "btn-reroll", "btn-reset", "btn-clear", "btn-generate", "btn-regen", "btn-reroll-gen", "btn-save", "btn-stale-regen"]) {
    const el = document.getElementById(id);
    if (el) el.disabled = b;
  }
  updateStale();
}

function doRandomize(mode) {
  if (busy) return;
  spec = randomize(spec, { mode });
  renderAllFields();
  saveDraft();
  toast(mode === "fill" ? "Wylosowano puste pola 🎲" : "Przelosowano wszystkie niezablokowane wartości 🎲");
}

async function generate({ reroll = false, keepSheet = false } = {}) {
  if (busy) return;
  if (reroll) spec = randomize(spec, { mode: "reroll" });
  else if (!keepSheet && hasUnsetNumeric(spec)) spec = randomize(spec, { mode: "fill" });
  renderAllFields();

  const sent = cloneSpec(spec);
  const payload = { ...sent, tensions: describeTensions(sent, fields) };
  setBusy(true);
  showProgress(0, 0);
  const started = performance.now();
  abortCtl = new AbortController();
  try {
    const resp = await fetch("/api/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: abortCtl.signal,
    });
    if (!resp.ok) {
      let msg = `Błąd serwera aplikacji (HTTP ${resp.status}).`;
      try { msg = (await resp.json()).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", final = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "progress") showProgress(ev.tokens, (performance.now() - started) / 1000);
        else if (ev.type === "error") throw new Error(ev.message);
        else if (ev.type === "done") final = ev;
      }
    }
    if (!final) throw new Error("Połączenie zakończyło się bez wyniku. Sprawdź, czy serwer aplikacji i model działają.");
    applyResult(final, sent);
  } catch (e) {
    if (e.name === "AbortError") {
      showError("Generowanie przerwane", "Anulowano generowanie.", false);
    } else if (e instanceof TypeError) {
      showError("Brak połączenia z aplikacją", "Nie udało się połączyć z serwerem aplikacji. Czy <code>./run.sh</code> nadal działa?", true);
    } else {
      showError("Nie udało się wygenerować postaci", esc(e.message), true);
    }
  } finally {
    abortCtl = null;
    setBusy(false);
    refreshStatus();
  }
}

function applyResult(ev, sent) {
  // Empty basic fields are invented by the model → show them as generated values.
  if (ev.format === "json") {
    const b = ev.character.dane_podstawowe || {};
    for (const [llmKey, key] of Object.entries(BASIC_KEY_MAP)) {
      const val = (b[llmKey] || "").trim();
      const cur = spec.basic[key], was = sent.basic[key];
      if (!val) continue;
      const untouched = cur.source === was.source && cur.value === was.value;
      if (untouched && cur.source !== "user") spec.basic[key] = cell(val, "generated");
    }
    // Author-locked basics are authoritative in the displayed profile.
    for (const [llmKey, key] of Object.entries(BASIC_KEY_MAP)) {
      if (sent.basic[key].source === "user") b[llmKey] = sent.basic[key].value.trim();
    }
  }
  result = {
    format: ev.format, character: ev.character, markdown: ev.markdown, warning: ev.warning || null,
    generatedAt: new Date().toISOString(), spec: cloneSpec(spec),
  };
  result.specKey = specKey(spec);
  renderAllFields();
  renderResult();
  saveDraft();
}

// ---------------------------------------------------------------------------- result view

function renderEmpty() {
  $("#result-toolbar").hidden = true;
  $("#result-body").innerHTML = `
    <div class="empty">
      <div class="big-ico">🪶</div>
      <h2>Tu pojawi się Twoja postać</h2>
      <p>Wypełnij tylko to, na czym Ci zależy – resztę wylosujemy.</p>
      <ol>
        <li>Ustaw wybrane cechy (🔒 zostaną nietknięte)</li>
        <li>Opisz świat, rolę i pomysł</li>
        <li><b>🎲 Losuj cechy</b>, żeby podejrzeć i poprawić wartości…</li>
        <li>…albo od razu <b>✨ Generuj postać</b></li>
      </ol>
    </div>`;
}

function showProgress(tokens, secs) {
  $("#result-toolbar").hidden = true;
  $("#stale").hidden = true;
  let box = $("#result-body .progress");
  if (!box) {
    $("#result-body").innerHTML = `
      <div class="progress">
        <div class="quill">🪶</div>
        <h2>Gemma pisze postać…</h2>
        <div class="bar"><i></i></div>
        <div class="meta"></div>
        <p><button id="btn-cancel" class="btn ghost" type="button">Anuluj</button></p>
      </div>`;
    box = $("#result-body .progress");
    $("#btn-cancel").onclick = () => abortCtl && abortCtl.abort();
  }
  const pct = Math.min(96, (tokens / EXPECTED_TOKENS) * 100);
  box.querySelector(".bar > i").style.width = `${pct}%`;
  const rate = secs > 1 && tokens ? ` · ${(tokens / secs).toFixed(0)} tok/s` : "";
  box.querySelector(".meta").textContent = tokens
    ? `${tokens} tokenów · ${secs.toFixed(0)} s${rate}`
    : "Model czyta kartę postaci…";
}

function showError(title, html, withRetry) {
  $("#result-toolbar").hidden = !result;
  const cmd = llmOk ? "" : `<p>Uruchom model: <code>~/.local/bin/llama-start.sh</code></p>`;
  $("#result-body").innerHTML = `
    <div class="error-box">
      <h3>⚠️ ${esc(title)}</h3>
      <p>${html}</p>
      ${withRetry ? cmd : ""}
      <p>${withRetry ? `<button class="btn" id="btn-retry" type="button">Spróbuj ponownie</button> ` : ""}
      ${result ? `<button class="btn ghost" id="btn-back" type="button">Pokaż poprzednią postać</button>` : ""}</p>
    </div>`;
  $("#btn-retry")?.addEventListener("click", () => generate({ keepSheet: true }));
  $("#btn-back")?.addEventListener("click", renderResult);
}

function renderResult() {
  if (!result) return renderEmpty();
  $("#result-toolbar").hidden = false;
  const warn = result.warning ? `<div class="notice" style="margin:0 0 18px">${esc(result.warning)}</div>` : "";
  const body = result.format === "json"
    ? renderCharacterHTML(result.character)
    : `<div class="md-body">${markdownToHTML(result.markdown)}</div>`;
  $("#result-body").innerHTML = warn + body;
  $(".result").scrollTop = 0;
  updateStale();
}

function currentMarkdown() {
  return toMarkdown(result, result.spec, fields);
}

function plainSheet(s) {
  const out = { basic: {} };
  for (const [k, c] of Object.entries(s.basic)) if (c.value) out.basic[k] = c.value;
  for (const sec of NUMERIC_SECTIONS) {
    out[sec] = {};
    for (const [k, c] of Object.entries(s[sec])) if (c.value !== null) out[sec][k] = c.value;
  }
  out.additional_prompt = s.additional_prompt || "";
  return out;
}

function exportJSON() {
  return JSON.stringify({
    app: "local-character-generator", version: 1,
    timestamp: result.generatedAt,
    name: characterName(result),
    user_prompt: result.spec.additional_prompt || "",
    character_sheet: plainSheet(result.spec),   // plain values
    specification: result.spec,                 // with {value, source}
    description: result.format === "json" ? result.character : { markdown: result.markdown },
  }, null, 2);
}

// ---------------------------------------------------------------------------- saved characters

async function refreshSavedCount() {
  try {
    const list = await (await fetch("/api/characters")).json();
    $("#saved-count").textContent = list.length ? `(${list.length})` : "";
    return list;
  } catch {
    return [];
  }
}

async function saveCharacter() {
  if (!result) return;
  const summary = result.format === "json" ? result.character.koncepcja : (result.markdown || "").slice(0, 300);
  try {
    const r = await fetch("/api/characters", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: characterName(result), summary, spec: result.spec, prompt: result.spec.additional_prompt, result }),
    });
    if (!r.ok) throw new Error();
    toast(`Zapisano: ${characterName(result)} 💾`);
    refreshSavedCount();
  } catch {
    toast("Nie udało się zapisać postaci.", true);
  }
}

async function openDrawer() {
  $("#drawer").hidden = false;
  const listEl = $("#saved-list");
  listEl.innerHTML = `<p class="saved-empty">Wczytywanie…</p>`;
  const list = await refreshSavedCount();
  if (!list.length) {
    listEl.innerHTML = `<p class="saved-empty">Brak zapisanych postaci.<br>Wygeneruj postać i kliknij 💾 Zapisz.</p>`;
    return;
  }
  listEl.innerHTML = list.map((it) => `
    <div class="saved-item" data-id="${esc(it.id)}">
      <h3>${esc(it.name)}</h3>
      <time>${esc(new Date(it.timestamp).toLocaleString("pl-PL"))}</time>
      <p>${esc((it.summary || "").slice(0, 180))}${(it.summary || "").length > 180 ? "…" : ""}</p>
      <div class="row">
        <button class="btn" type="button" data-act="load">Wczytaj</button>
        <button class="btn ghost danger" type="button" data-act="del">Usuń</button>
      </div>
    </div>`).join("");
}

async function onSavedClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest(".saved-item").dataset.id;
  if (btn.dataset.act === "load") {
    if (busy) return toast("Poczekaj na koniec generowania.", true);
    try {
      const it = await (await fetch(`/api/characters/${encodeURIComponent(id)}`)).json();
      spec = adoptSpec(it.spec);
      result = it.result ? { ...it.result, spec: cloneSpec(spec) } : null;
      if (result) result.specKey = specKey(spec);
      renderAllFields();
      renderResult();
      saveDraft();
      $("#drawer").hidden = true;
      toast(`Wczytano: ${it.name}`);
    } catch {
      toast("Nie udało się wczytać postaci.", true);
    }
  } else if (btn.dataset.act === "del") {
    confirmClick(btn, async () => {
      await fetch(`/api/characters/${encodeURIComponent(id)}`, { method: "DELETE" });
      openDrawer();
    }, "Usunąć?");
  }
}

// ---------------------------------------------------------------------------- status

async function refreshStatus() {
  const box = $("#status"), txt = $("#status-text");
  try {
    const s = await (await fetch("/api/status", { cache: "no-store" })).json();
    llmOk = !!s.ok;
    box.className = "status " + (s.ok ? "ok" : s.loading ? "loading" : "bad");
    txt.textContent = s.ok ? "Gemma 4 połączona" : s.loading ? "Gemma 4 się ładuje…" : "Gemma 4 niedostępna";
    box.title = s.ok ? `${s.model} · kontekst ${s.n_ctx} · ${s.llama_url}` : s.error;
  } catch {
    llmOk = false;
    box.className = "status bad";
    txt.textContent = "Serwer aplikacji niedostępny";
    box.title = "Uruchom ./run.sh";
  }
  clearTimeout(refreshStatus._t);
  refreshStatus._t = setTimeout(refreshStatus, llmOk ? 15000 : 4000);
}

// ---------------------------------------------------------------------------- init

async function init() {
  fields = await (await fetch("fields.json")).json();
  const draft = loadDraft();
  spec = adoptSpec(draft && draft.spec);
  result = draft && draft.result && draft.result.spec ? draft.result : null;

  buildBasic();
  buildScales();
  renderAllFields();
  renderResult();

  $("#prompt").addEventListener("input", (e) => { spec.additional_prompt = e.target.value; changed(); });
  $("#btn-roll").onclick = () => doRandomize("fill");
  $("#btn-reroll").onclick = () => doRandomize("reroll");
  $("#btn-reset").onclick = () => { spec = resetGenerated(spec); renderAllFields(); saveDraft(); toast("Wyczyszczono wylosowane wartości ♻️"); };
  $("#btn-clear").onclick = (e) => confirmClick(e.currentTarget, () => {
    spec = createEmptySpec(fields); renderAllFields(); saveDraft(); toast("Wyczyszczono kartę");
  });
  $("#btn-generate").onclick = () => generate();
  $("#btn-regen").onclick = () => generate({ keepSheet: true });
  $("#btn-stale-regen").onclick = () => generate({ keepSheet: true });
  $("#btn-reroll-gen").onclick = () => generate({ reroll: true });
  $("#btn-copy").onclick = async () => toast((await copyText(currentMarkdown())) ? "Skopiowano do schowka 📋" : "Nie udało się skopiować", false);
  $("#btn-save").onclick = saveCharacter;
  $("#btn-md").onclick = () => download(`${slug(characterName(result))}.md`, currentMarkdown(), "text/markdown;charset=utf-8");
  $("#btn-json").onclick = () => download(`${slug(characterName(result))}.json`, exportJSON(), "application/json;charset=utf-8");
  $("#btn-saved").onclick = openDrawer;
  $("#drawer").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) $("#drawer").hidden = true; });
  $("#saved-list").addEventListener("click", onSavedClick);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#drawer").hidden = true;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") generate();
  });

  refreshStatus();
  refreshSavedCount();
}

init().catch((e) => {
  document.body.insertAdjacentHTML("afterbegin", `<div class="error-box"><h3>Błąd inicjalizacji</h3><p>${esc(e.message)}</p></div>`);
});
