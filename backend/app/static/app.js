"use strict";

const state = {
  token: localStorage.getItem("token") || null,
  user: null,
  people: [],
  selectedId: null,
  editing: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 2800);
}

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    logout();
    throw new Error("Oturum sona erdi");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (_) {}
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));

const fullName = (p) => `${p.first_name || ""} ${p.last_name || ""}`.trim() || "(isimsiz)";

// GEDCOM tarihlerini Türkçeleştir: "12 MAR 1940" -> "12 Mar 1940",
// "ABT 1950" -> "yakl. 1950". Ham değer saklıdır; yalnız gösterim çevrilir.
const TR_MONTHS = {
  JAN: "Oca", FEB: "Şub", MAR: "Mar", APR: "Nis", MAY: "May", JUN: "Haz",
  JUL: "Tem", AUG: "Ağu", SEP: "Eyl", OCT: "Eki", NOV: "Kas", DEC: "Ara",
};
const TR_QUAL = {
  ABT: "yakl.", EST: "tah.", CAL: "hes.", BEF: "önce", AFT: "sonra",
  FROM: "", TO: "–", BET: "", AND: "–", INT: "",
};
function trDate(s) {
  if (!s) return "";
  return String(s).replace(/[A-Za-zÇĞİÖŞÜçğıöşü]+/g, (w) => {
    const u = w.toUpperCase();
    if (TR_MONTHS[u]) return TR_MONTHS[u];
    if (u in TR_QUAL) return TR_QUAL[u];
    return w;
  }).replace(/\s+/g, " ").trim();
}

// Liste/arama sonuçlarında ikinci satır: "12 MAR 1940 – 2 MAR 1980 · Çiftçi"
function personSub(p) {
  const bits = [];
  const b = trDate((p.birth_date || "").trim());
  const d = trDate((p.death_date || "").trim());
  if (b && d) bits.push(`${b} – ${d}`);
  else if (b) bits.push(`d. ${b}`);
  else if (d) bits.push(`ö. ${d}`);
  if ((p.occupation || "").trim()) bits.push(p.occupation.trim());
  return bits.join(" · ");
}
const canEdit = () => state.user && (state.user.role === "admin" || state.user.role === "editor");
const isAdmin = () => state.user && state.user.role === "admin";

/* ---------------- Auth ---------------- */
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  const body = new URLSearchParams();
  body.set("username", $("#login-email").value);
  body.set("password", $("#login-password").value);
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    state.token = data.access_token;
    localStorage.setItem("token", state.token);
    await boot();
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#logout-btn").addEventListener("click", logout);
function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem("token");
  $("#app-view").classList.add("hidden");
  $("#login-view").classList.remove("hidden");
}

/* ---------------- Boot ---------------- */
async function boot() {
  try {
    state.user = await api("/api/auth/me");
  } catch (_) {
    logout();
    return;
  }
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#user-label").textContent = `${state.user.full_name || state.user.email} · ${roleLabel(state.user.role)}`;

  $$(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin()));
  $$(".editor-only").forEach((el) => el.classList.toggle("hidden", !canEdit()));
  $(".viewer-note").classList.toggle("hidden", canEdit());

  await loadPeople();
  if (isAdmin()) loadUsers();
  await applyHash(); // paylaşılan URL varsa o görünümü aç
}

const roleLabel = (r) => ({ admin: "Yönetici", editor: "Düzenleyici", viewer: "Görüntüleyici" }[r] || r);

/* ---------------- Tabs ---------------- */
function switchTab(tab) {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $("#tab-" + tab).classList.remove("hidden");
}

$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    switchTab(tab);
    updateHash({ tab });
    if (tab === "tree") populateTreeRoots();
  });
});

/* ---------------- Paylaşılabilir URL'ler (hash) ---------------- */
function updateHash(params) {
  history.replaceState(null, "", "#" + new URLSearchParams(params).toString());
}

// URL'deki durumu uygula: #tab=tree&root=..&dir=..&depth=..&lineage=..
// veya #tab=people&person=..  Login sonrası da çalışır (boot çağırır).
async function applyHash() {
  const h = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  const tab = h.get("tab");
  if (!tab) return false;

  if (tab === "tree" && h.get("root")) {
    if (h.get("dir")) $("#tree-direction").value = h.get("dir");
    if (h.get("depth")) $("#tree-depth").value = h.get("depth");
    if (h.get("lineage")) $("#tree-lineage").value = h.get("lineage");
    updateLineageVisibility();
    switchTab("tree");
    state._treeShown = true; // URL'deki durum varsayılanı ezer
    fillTreeRoots();
    setTreeRoot(Number(h.get("root")));
    try { await renderTree(); } catch (_) {}
    return true;
  }
  if (tab === "people" && h.get("person")) {
    switchTab("people");
    try { await selectPerson(Number(h.get("person"))); } catch (_) {}
    return true;
  }
  if (["people", "tree", "import", "users"].includes(tab)) {
    switchTab(tab);
    if (tab === "tree") populateTreeRoots();
    return true;
  }
  return false;
}

window.addEventListener("hashchange", applyHash);

/* ---------------- People ---------------- */
let searchTimer;
$("#people-search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadPeople(e.target.value), 250);
});
$("#add-person-btn").addEventListener("click", startAddPerson);

async function loadPeople(q = "") {
  state.people = await api("/api/individuals?q=" + encodeURIComponent(q));
  renderPeopleList();
}

function renderPeopleList() {
  const ul = $("#people-list");
  ul.innerHTML = "";
  state.people.forEach((p) => {
    const li = document.createElement("li");
    li.className = p.id === state.selectedId ? "active" : "";
    const sub = personSub(p);
    li.innerHTML = `<span class="sex-dot ${esc(p.sex)}"></span>
      <span class="li-main">${esc(fullName(p))}
        ${sub ? `<span class="li-sub">${esc(sub)}</span>` : ""}</span>`;
    li.addEventListener("click", () => selectPerson(p.id));
    ul.appendChild(li);
  });
  if (!state.people.length) ul.innerHTML = '<li class="muted">Kayıt yok</li>';
}

async function selectPerson(id) {
  state.selectedId = id;
  state.editing = false;
  renderPeopleList();
  const person = await api("/api/individuals/" + id);
  renderDetail(person);
  updateHash({ tab: "people", person: id });
}

function renderDetail(p) {
  const el = $("#person-detail");
  const editBtns = canEdit()
    ? `<button id="edit-btn">Düzenle</button>
       <button id="del-btn" class="danger">Sil</button>
       <button id="show-tree-btn" class="ghost">🌳 Ağaçta göster</button>`
    : `<button id="show-tree-btn" class="ghost">🌳 Ağaçta göster</button>`;

  el.innerHTML = `
    <div class="detail-actions">${editBtns}</div>
    <h2><span class="sex-dot ${esc(p.sex)}"></span> ${esc(fullName(p))}</h2>
    <div class="detail-grid">
      ${field("Doğum", trDate(p.birth_date), p.birth_place)}
      ${field("Ölüm", trDate(p.death_date), p.death_place)}
      ${field("Kızlık soyadı", p.maiden_name)}
      ${field("Meslek", p.occupation)}
    </div>
    ${p.notes ? `<div class="field"><span class="k">Notlar</span><div>${esc(p.notes)}</div></div>` : ""}

    ${relSection("Ebeveynler", "parent", p.parents)}
    ${relSection("Eş(ler)", "spouse", p.spouses.map((s) => s.person))}
    ${relSection("Çocuklar", "child", p.children)}

    <div class="rel-section">
      <h3>Görseller</h3>
      <div class="media-gallery">${p.media.map(mediaHtml).join("") || '<span class="muted">Görsel yok</span>'}</div>
      ${canEdit() ? `<div class="inline-form">
        <input type="file" id="media-file" accept="image/*" />
        <input type="text" id="media-caption" placeholder="Açıklama (isteğe bağlı)" />
        <button id="media-upload">Görsel Ekle</button>
      </div>` : ""}
    </div>
  `;

  $("#show-tree-btn").addEventListener("click", () => showInTree(p.id));
  if (canEdit()) {
    $("#edit-btn").addEventListener("click", () => renderEditForm(p));
    $("#del-btn").addEventListener("click", () => deletePerson(p.id));
    $("#media-upload").addEventListener("click", () => uploadMedia(p.id));
    $$("[data-rel]").forEach((chip) => {
      chip.querySelector(".x")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeRelationship(p.id, chip.dataset.rel, Number(chip.dataset.relid));
      });
    });
    renderRelAdders(p);
  }
  // Clicking a related person navigates to them.
  $$("[data-goto]").forEach((chip) =>
    chip.addEventListener("click", () => selectPerson(Number(chip.dataset.goto))));
}

function field(label, a, b) {
  const val = [a, b].filter(Boolean).join(" · ");
  if (!val) return "";
  return `<div class="field"><span class="k">${esc(label)}</span><div>${esc(val)}</div></div>`;
}

function relSection(title, relType, people) {
  const chips = people.map((p) => {
    const x = canEdit() ? `<span class="x" title="Kaldır">×</span>` : "";
    return `<span class="chip" data-rel="${relType}" data-relid="${p.id}" data-goto="${p.id}">
      ${esc(fullName(p))} ${x}</span>`;
  }).join("");
  return `<div class="rel-section">
    <h3>${esc(title)}</h3>
    <div class="rel-chips">${chips || '<span class="muted">—</span>'}</div>
    <div class="rel-adder" data-adder="${relType}"></div>
  </div>`;
}

function renderRelAdders(p) {
  ["parent", "spouse", "child"].forEach((relType) => {
    const holder = document.querySelector(`[data-adder="${relType}"]`);
    if (!holder) return;
    const options = state.people
      .filter((o) => o.id !== p.id)
      .map((o) => `<option value="${o.id}">${esc(fullName(o))}</option>`)
      .join("");
    const marr = relType === "spouse"
      ? `<input type="text" class="rel-marr" placeholder="Evlilik tarihi" style="width:130px" />`
      : "";
    holder.innerHTML = `<div class="inline-form">
      <select class="rel-select"><option value="">+ ${esc(relLabel(relType))} ekle…</option>${options}</select>
      ${marr}
      <button class="small rel-add-btn">Ekle</button>
    </div>`;
    holder.querySelector(".rel-add-btn").addEventListener("click", () => {
      const sel = holder.querySelector(".rel-select");
      const id = Number(sel.value);
      if (!id) return;
      const marriage = holder.querySelector(".rel-marr")?.value || "";
      addRelationship(p.id, relType, id, marriage);
    });
  });
}

const relLabel = (t) => ({ parent: "ebeveyn", spouse: "eş", child: "çocuk" }[t] || t);

function mediaHtml(m) {
  const del = canEdit() ? `<span class="del" data-media="${m.id}">✕</span>` : "";
  return `<div class="media-item">
    <img src="${esc(m.url)}" alt="${esc(m.caption)}" />
    ${del}
    ${m.caption ? `<div class="cap">${esc(m.caption)}</div>` : ""}
  </div>`;
}

/* ---- Person add/edit ---- */
const PERSON_FIELDS = [
  ["first_name", "Ad"], ["last_name", "Soyad"], ["maiden_name", "Kızlık soyadı"],
  ["birth_date", "Doğum tarihi"], ["birth_place", "Doğum yeri"],
  ["death_date", "Ölüm tarihi"], ["death_place", "Ölüm yeri"],
  ["occupation", "Meslek"],
];

function personForm(p = {}) {
  const inputs = PERSON_FIELDS.map(([k, label]) =>
    `<label>${esc(label)}<input name="${k}" value="${esc(p[k] || "")}" /></label>`).join("");
  return `<form id="person-form">
    <div class="detail-grid">
      <label>Cinsiyet<select name="sex">
        <option value="U" ${p.sex === "U" || !p.sex ? "selected" : ""}>Bilinmiyor</option>
        <option value="M" ${p.sex === "M" ? "selected" : ""}>Erkek</option>
        <option value="F" ${p.sex === "F" ? "selected" : ""}>Kadın</option>
      </select></label>
      ${inputs}
    </div>
    <label>Notlar<textarea name="notes" rows="3">${esc(p.notes || "")}</textarea></label>
    <div class="detail-actions" style="margin-top:1rem">
      <button type="submit">Kaydet</button>
      <button type="button" id="cancel-edit" class="ghost">Vazgeç</button>
    </div>
  </form>`;
}

function startAddPerson() {
  if (!canEdit()) return;
  state.selectedId = null;
  const el = $("#person-detail");
  el.innerHTML = `<h2>Yeni Kişi</h2>${personForm()}`;
  $("#cancel-edit").addEventListener("click", () => (el.innerHTML = '<p class="muted center">Soldan bir kişi seçin.</p>'));
  $("#person-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = formToObject(e.target);
    const created = await api("/api/individuals", { method: "POST", json: payload });
    toast("Kişi eklendi");
    await loadPeople($("#people-search").value);
    selectPerson(created.id);
  });
}

function renderEditForm(p) {
  const el = $("#person-detail");
  el.innerHTML = `<h2>Düzenle: ${esc(fullName(p))}</h2>${personForm(p)}`;
  $("#cancel-edit").addEventListener("click", () => selectPerson(p.id));
  $("#person-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = formToObject(e.target);
    await api("/api/individuals/" + p.id, { method: "PATCH", json: payload });
    toast("Kaydedildi");
    await loadPeople($("#people-search").value);
    selectPerson(p.id);
  });
}

function formToObject(form) {
  const obj = {};
  new FormData(form).forEach((v, k) => (obj[k] = v));
  return obj;
}

async function deletePerson(id) {
  if (!confirm("Bu kişiyi ve ilişkili görsellerini silmek istediğinize emin misiniz?")) return;
  await api("/api/individuals/" + id, { method: "DELETE" });
  state.selectedId = null;
  toast("Kişi silindi");
  await loadPeople($("#people-search").value);
  $("#person-detail").innerHTML = '<p class="muted center">Soldan bir kişi seçin.</p>';
}

/* ---- Relationships ---- */
async function addRelationship(id, type, relatedId, marriage = "") {
  await api(`/api/individuals/${id}/relationships`, {
    method: "POST",
    json: { type, related_id: relatedId, marriage_date: marriage },
  });
  toast("İlişki eklendi");
  selectPerson(id);
}

async function removeRelationship(id, type, relatedId) {
  await api(`/api/individuals/${id}/relationships?type=${type}&related_id=${relatedId}`, {
    method: "DELETE",
  });
  toast("İlişki kaldırıldı");
  selectPerson(id);
}

/* ---- Media ---- */
async function uploadMedia(id) {
  const fileInput = $("#media-file");
  if (!fileInput.files.length) return toast("Dosya seçin", true);
  const fd = new FormData();
  fd.append("file", fileInput.files[0]);
  fd.append("caption", $("#media-caption").value);
  await api(`/api/individuals/${id}/media`, { method: "POST", body: fd });
  toast("Görsel yüklendi");
  selectPerson(id);
}

document.addEventListener("click", (e) => {
  const del = e.target.closest("[data-media]");
  if (del && state.selectedId) {
    if (!confirm("Görseli sil?")) return;
    api(`/api/individuals/${state.selectedId}/media/${del.dataset.media}`, { method: "DELETE" })
      .then(() => { toast("Silindi"); selectPerson(state.selectedId); })
      .catch((err) => toast(err.message, true));
  }
});

/* ---------------- Tree ---------------- */
// Extract a sortable birth year from free-form dates like "12 MAR 1901" or "1901".
function birthYear(p) {
  const m = /\d{3,4}/.exec(p.birth_date || "");
  return m ? Number(m[0]) : Infinity;
}

function oldestPersonId() {
  let best = null;
  state.people.forEach((p) => {
    if (best === null || birthYear(p) < birthYear(best)) best = p;
  });
  return best ? best.id : null;
}

const treeRootLabel = (p) => {
  const y = birthYear(p);
  return fullName(p) + (Number.isFinite(y) ? ` (${y})` : "");
};

function setTreeRoot(id, fallbackLabel) {
  state.treeRootId = id;
  const p = state.people.find((x) => x.id === id);
  if (p) $("#tree-root-input").value = treeRootLabel(p);
  else if (fallbackLabel) $("#tree-root-input").value = fallbackLabel;
}

// Karttaki 🌳 ikonundan: mevcut mod korunarak odak bu kişiye geçer.
function jumpToTree(id, label) {
  state._treeShown = true;
  setTreeRoot(id, label);
  renderTree();
}

// Seçili kişinin etiketini tazele (kişi listesi yenilendiğinde).
function fillTreeRoots() {
  if (state.treeRootId) {
    const p = state.people.find((x) => x.id === state.treeRootId);
    if (p) $("#tree-root-input").value = treeRootLabel(p);
  }
}

function renderRootList(q = "") {
  const list = $("#tree-root-list");
  const needle = q.trim().toLowerCase();
  const items = state.people
    .filter((p) => !needle ||
      (fullName(p) + " " + (p.birth_date || "") + " " + (p.occupation || ""))
        .toLowerCase().includes(needle))
    .slice(0, 60);
  list.innerHTML = items
    .map((p) => {
      const sub = personSub(p);
      return `<div class="combo-item" data-id="${p.id}">
        <div>${esc(fullName(p))}</div>
        ${sub ? `<div class="combo-sub">${esc(sub)}</div>` : ""}
      </div>`;
    })
    .join("") || '<div class="combo-empty">Sonuç yok</div>';
  list.classList.remove("hidden");
}

function pickTreeRoot(id) {
  setTreeRoot(id);
  $("#tree-root-list").classList.add("hidden");
  renderTree();
}

{
  const rootInput = $("#tree-root-input");
  rootInput.addEventListener("input", () => renderRootList(rootInput.value));
  rootInput.addEventListener("focus", () => {
    rootInput.select();
    renderRootList("");
  });
  rootInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = $("#tree-root-list .combo-item");
      if (first) pickTreeRoot(Number(first.dataset.id));
    } else if (e.key === "Escape") {
      $("#tree-root-list").classList.add("hidden");
    }
  });
  // mousedown: blur'dan önce çalışır, seçim kaybolmaz.
  $("#tree-root-list").addEventListener("mousedown", (e) => {
    const item = e.target.closest(".combo-item");
    if (item) pickTreeRoot(Number(item.dataset.id));
  });
  rootInput.addEventListener("blur", () => setTimeout(() => {
    fillTreeRoots(); // yarım kalan aramayı seçili etikete geri döndür
    $("#tree-root-list").classList.add("hidden");
  }, 150));
}

async function populateTreeRoots() {
  fillTreeRoots();
  if (state._treeShown) return;
  state._treeShown = true;

  // 1) Kaldığın yerden devam: kayıtlı kök + mod + derinlik.
  const saved = loadTreeState();
  if (saved && saved.rootId) {
    if (saved.direction) $("#tree-direction").value = saved.direction;
    if (saved.depth) $("#tree-depth").value = saved.depth;
    if (saved.lineage) $("#tree-lineage").value = saved.lineage;
    updateLineageVisibility();
    setTreeRoot(Number(saved.rootId));
    try {
      await renderTree();
      return;
    } catch (_) {
      localStorage.removeItem(TREE_STATE_KEY); // kök silinmiş olabilir
    }
  }

  // 2) Varsayılan: GEDCOM'daki en tepe ata.
  try {
    const r = await api("/api/individuals/tree-root");
    if (r && r.id) setTreeRoot(r.id);
  } catch (_) {
    const oldest = oldestPersonId();
    if (oldest) setTreeRoot(oldest);
  }
  if (state.treeRootId) renderTree();
}

$("#tree-render").addEventListener("click", renderTree);

function showInTree(id) {
  $$(".tab").forEach((b) => b.classList.remove("active"));
  document.querySelector('.tab[data-tab="tree"]').classList.add("active");
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $("#tab-tree").classList.remove("hidden");
  fillTreeRoots();
  state._treeShown = true; // explicit choice; don't override with default root
  setTreeRoot(id);
  $("#tree-direction").value = "focus"; // kişi odaklı akış: odaklı mod
  updateLineageVisibility();
  renderTree();
}

/* Ağaç durumu (kök + mod + derinlik) tarayıcıda saklanır: kaldığın yerden devam. */
const TREE_STATE_KEY = "aile-tree-state";

function saveTreeState() {
  localStorage.setItem(TREE_STATE_KEY, JSON.stringify({
    rootId: state.treeRootId,
    direction: $("#tree-direction").value,
    depth: $("#tree-depth").value,
    lineage: $("#tree-lineage").value,
  }));
}

function loadTreeState() {
  try { return JSON.parse(localStorage.getItem(TREE_STATE_KEY)) || null; }
  catch (_) { return null; }
}

async function renderTree() {
  const rootId = Number(state.treeRootId);
  const depth = Number($("#tree-depth").value) || 8;
  const direction = $("#tree-direction").value || "down";
  const lineage = $("#tree-lineage").value || "auto";
  if (!rootId) return;
  const data = await api(
    `/api/individuals/${rootId}/pedigree?depth=${depth}&direction=${direction}&lineage=${lineage}`);
  saveTreeState();
  updateHash({ tab: "tree", root: rootId, dir: direction, depth, lineage });
  if (data.mode === "focus") drawFocus(data);
  else if (data.mode === "full") drawFull(data);
  else drawPedigree(data);
}

// Soy kolu seçimi üst soyu takip eden modlarda (odaklı + tam ağaç) anlamlı.
function updateLineageVisibility() {
  const dir = $("#tree-direction").value;
  $("#lineage-label").classList.toggle("hidden", dir !== "full" && dir !== "focus");
}

// Mod/derinlik/soy kolu değişince yeniden çiz (kök seçiliyse).
$("#tree-direction").addEventListener("change", () => {
  updateLineageVisibility();
  if (state.treeRootId) renderTree();
});
$("#tree-depth").addEventListener("change", () => state.treeRootId && renderTree());
$("#tree-lineage").addEventListener("change", () => state.treeRootId && renderTree());

let treeSvg = null, treeG = null, treeZoom = null;
const NODE_W = 160, NODE_H = 56;
const SPOUSE_GAP = 18;       // gap between a couple's cards
const GAP_X = NODE_W + 34;   // horizontal gap between siblings
const GAP_Y = NODE_H + 64;   // vertical gap between generations
const AV_X = -NODE_W / 2 + 24; // avatar circle center
const TEXT_X = AV_X + 22;      // text block start

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

// "Abdullah Hilmi BAYCAN" -> ["Abdullah Hilmi", "BAYCAN"]
function nameLines(name) {
  const parts = (name || "").trim().split(/\s+/);
  if (parts.length < 2) return [name || "", ""];
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
}

function initials(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  const a = parts[0] ? parts[0][0] : "";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
}

function datesLabel(d) {
  const b = trDate((d.birth_date || "").trim());
  const de = trDate((d.death_date || "").trim());
  if (!b && !de) return "";
  return `${b || "?"} – ${de || ""}`.trim();
}

// Right-angled (elbow) connector, works both downward and upward.
function elbowPath(d) {
  const down = d.target.y > d.source.y;
  const sy = d.source.y + (down ? NODE_H / 2 : -NODE_H / 2);
  const ty = d.target.y + (down ? -NODE_H / 2 : NODE_H / 2);
  const my = (sy + ty) / 2;
  return `M${d.source.x},${sy} V${my} H${d.target.x} V${ty}`;
}

// Shared renderer: takes laid-out links/nodes, draws cards + zoom + fit.
// centerFocus: ekrana sığdırmak yerine görüntüyü odak kişiye ortala.
function drawTreeSvg(links, nodes, focusId = null, centerFocus = false) {
  const canvas = $("#tree-canvas");
  canvas.innerHTML = "";

  const width = canvas.clientWidth || 900;
  const height = Math.max(canvas.clientHeight, 560);

  const svg = d3.select(canvas).append("svg")
    .attr("width", "100%")
    .attr("height", "100%");

  // Tüm kartlar aynı yerel koordinatları kullandığı için tek clipPath yeter.
  svg.append("defs").append("clipPath").attr("id", "avatar-clip")
    .append("circle").attr("cx", AV_X).attr("cy", 0).attr("r", 16);

  // gZoom pan/zoom taşır; g (statik içerik) mercek tarafından <use> ile
  // yeniden çizilebilsin diye transform'suz kalır.
  const gZoom = svg.append("g");
  const g = gZoom.append("g").attr("id", "tree-content");

  // Ana kartlar + eş kartları (sağa) + kardeş kartları (sola, dal açılmadan).
  const cards = [];
  const coupleLinks = [];
  const sibLinks = [];
  nodes.forEach((d) => {
    cards.push({ x: d.x, y: d.y, data: d.data,
                 focus: focusId !== null && d.data.id === focusId });
    (d.data.spouses || []).forEach((sp, i) => {
      const sx = d.x + (i + 1) * (NODE_W + SPOUSE_GAP);
      coupleLinks.push({ x1: sx - NODE_W - SPOUSE_GAP + NODE_W / 2, x2: sx - NODE_W / 2, y: d.y });
      cards.push({ x: sx, y: d.y, data: sp, focus: false });
    });
    (d.data.siblings || []).forEach((sb, i) => {
      const sx = d.x - (i + 1) * (NODE_W + SPOUSE_GAP);
      sibLinks.push({ x1: sx + NODE_W / 2, x2: sx + NODE_W / 2 + SPOUSE_GAP, y: d.y });
      cards.push({ x: sx, y: d.y, data: sb, focus: false });
    });
  });

  g.selectAll("path.link")
    .data(links)
    .join("path")
    .attr("class", "link")
    .attr("d", elbowPath);

  g.selectAll("line.couple-link")
    .data(coupleLinks)
    .join("line")
    .attr("class", "couple-link")
    .attr("x1", (c) => c.x1).attr("x2", (c) => c.x2)
    .attr("y1", (c) => c.y).attr("y2", (c) => c.y);

  g.selectAll("line.sib-link")
    .data(sibLinks)
    .join("line")
    .attr("class", "sib-link")
    .attr("x1", (c) => c.x1).attr("x2", (c) => c.x2)
    .attr("y1", (c) => c.y).attr("y2", (c) => c.y);

  const card = g.selectAll("g.node-card")
    .data(cards)
    .join("g")
    .attr("class", (c) => `node-card ${c.data.sex || "U"}${c.focus ? " focus" : ""}`)
    .attr("transform", (c) => `translate(${c.x},${c.y})`)
    .style("cursor", "pointer")
    .on("click", (_, c) => selectFromTree(c.data.id));

  card.append("rect")
    .attr("x", -NODE_W / 2).attr("y", -NODE_H / 2)
    .attr("width", NODE_W).attr("height", NODE_H).attr("rx", 8);

  card.append("circle")
    .attr("class", "avatar")
    .attr("cx", AV_X).attr("cy", 0).attr("r", 16);

  card.filter((c) => c.data.photo)
    .append("image")
    .attr("href", (c) => c.data.photo)
    .attr("x", AV_X - 16).attr("y", -16)
    .attr("width", 32).attr("height", 32)
    .attr("preserveAspectRatio", "xMidYMid slice")
    .attr("clip-path", "url(#avatar-clip)");

  card.filter((c) => !c.data.photo)
    .append("text")
    .attr("class", "initials")
    .attr("x", AV_X).attr("dy", "4")
    .text((c) => initials(c.data.name));

  card.append("text")
    .attr("class", "name").attr("x", TEXT_X).attr("y", -9)
    .text((c) => truncate(nameLines(c.data.name)[0], 15));

  card.append("text")
    .attr("class", "name").attr("x", TEXT_X).attr("y", 4)
    .text((c) => truncate(nameLines(c.data.name)[1], 15));

  card.append("text")
    .attr("class", "dates").attr("x", TEXT_X).attr("y", 18)
    .text((c) => truncate(datesLabel(c.data), 24));

  // Tam isim + tarihler tarayıcı tooltip'i olarak.
  card.append("title")
    .text((c) => [c.data.name, datesLabel(c.data)].filter(Boolean).join("\n"));

  // MyHeritage tarzı "ağacını göster": odağı bu kişiye taşır.
  const jump = card.filter((c) => !c.focus)
    .append("g")
    .attr("class", "jump-btn")
    .attr("transform", `translate(${NODE_W / 2 - 13},${-NODE_H / 2 + 13})`)
    .on("click", (e, c) => {
      e.stopPropagation();
      jumpToTree(c.data.id, c.data.name);
    });
  jump.append("circle").attr("r", 9);
  jump.append("text").attr("text-anchor", "middle").attr("dy", "3.5").text("🌳");
  jump.append("title").text("Ağacını göster (odağı buna al)");

  treeZoom = d3.zoom()
    .scaleExtent([0.05, 4])
    .on("zoom", (e) => {
      gZoom.attr("transform", e.transform);
      if (e.transform.k >= MAG_THRESHOLD) hideMagnifier();
    });
  svg.call(treeZoom).on("dblclick.zoom", null);

  // Mercek: fit halinde kartlar okunmazken imlecin altını büyütülmüş gösterir.
  const mag = d3.select(canvas).append("div")
    .attr("class", "magnifier hidden").attr("id", "magnifier");
  const magSvg = mag.append("svg").attr("width", "100%").attr("height", "100%");
  magSvg.append("rect").attr("class", "mag-bg")
    .attr("width", "100%").attr("height", "100%");
  magSvg.append("use").attr("id", "mag-view").attr("href", "#tree-content");
  magSvg.append("circle").attr("class", "mag-cursor")
    .attr("cx", "50%").attr("cy", "50%").attr("r", 10);

  svg.on("mousemove", updateMagnifier);
  svg.on("mouseleave", hideMagnifier);

  treeSvg = svg;
  treeG = g;
  if (centerFocus && focusId !== null) {
    const fc = cards.find((c) => c.data.id === focusId);
    if (fc) { centerOn(fc.x, fc.y); return; }
  }
  fitTree(false);
}

/* ---- Mercek (loupe) ---- */
const MAG_THRESHOLD = 0.55; // bu ölçeğin üstünde kartlar zaten okunur, mercek gizli
const MAG_SCALE = 0.7;      // mercek içindeki büyütme
// Kullanıcı merceği kapatabilir: kapalıyken hiç açılmaz, kendisi zoom yapar.
let magnifierEnabled = localStorage.getItem("aile-loupe") !== "off";

function hideMagnifier() {
  const mag = $("#magnifier");
  if (mag) mag.classList.add("hidden");
}

function updateMagnifier(event) {
  const mag = $("#magnifier");
  if (!mag || !treeSvg || !magnifierEnabled) { if (mag) mag.classList.add("hidden"); return; }
  const svgNode = treeSvg.node();
  const t = d3.zoomTransform(svgNode);
  if (t.k >= MAG_THRESHOLD) { mag.classList.add("hidden"); return; }

  const [mx, my] = d3.pointer(event, svgNode);
  const w = svgNode.clientWidth, h = svgNode.clientHeight;

  // İmlecin ağaç koordinatındaki karşılığını merceğin merkezine getir.
  const tx = (mx - t.x) / t.k;
  const ty = (my - t.y) / t.k;
  const mw = mag.clientWidth || 340, mh = mag.clientHeight || 260;
  $("#mag-view").setAttribute("transform",
    `translate(${mw / 2 - MAG_SCALE * tx},${mh / 2 - MAG_SCALE * ty}) scale(${MAG_SCALE})`);

  // Panel imlecin karşı yakasında durur (yalnız sağ/sol değişir).
  mag.classList.remove("mag-l", "mag-r", "hidden");
  mag.classList.add(mx < w / 2 ? "mag-r" : "mag-l");
}

function centerOn(x, y, scale = 0.9) {
  const svgNode = treeSvg.node();
  const w = svgNode.clientWidth || Number(treeSvg.attr("width"));
  const h = svgNode.clientHeight || Number(treeSvg.attr("height"));
  treeSvg.call(treeZoom.transform,
    d3.zoomIdentity.translate(w / 2 - scale * x, h / 2 - scale * y).scale(scale));
}

// Eş kartları sağa, kardeş kartları sola eklendiği için komşu düğümlere
// yanlarındaki kart sayısı kadar ekstra boşluk bırak.
function treeLayout() {
  const cardSpan = (NODE_W + SPOUSE_GAP) / GAP_X;
  const extras = (n) =>
    (n.data.spouses ? n.data.spouses.length : 0) +
    (n.data.siblings ? n.data.siblings.length : 0);
  return d3.tree().nodeSize([GAP_X, GAP_Y]).separation((a, b) =>
    (a.parent === b.parent ? 1 : 1.2) + (extras(a) + extras(b)) * cardSpan);
}

function drawPedigree(rootData) {
  const root = d3.hierarchy(rootData);
  treeLayout()(root);
  drawTreeSvg(root.links(), root.descendants());
}

// Tam ağaç: en tepe atadan tüm soy; odak kişi vurgulu ve görüntü ona ortalı.
function drawFull(data) {
  const root = d3.hierarchy(data.root);
  treeLayout()(root);
  drawTreeSvg(root.links(), root.descendants(), data.focus_id, true);
}

// Odaklı mod: seçilen kişi ortada, tüm alt soy aşağı, üst soy yukarı açılır.
function drawFocus(data) {
  const layout = treeLayout();

  const downRoot = d3.hierarchy(data.down);
  layout(downRoot);

  const upRoot = d3.hierarchy(data.up);
  layout(upRoot);
  upRoot.each((d) => { d.y = -d.y; }); // ataları yukarı aynala

  const links = [...downRoot.links(), ...upRoot.links()];
  // Odak kişi iki ağaçta da kök; üst ağaçtaki kopyasını çizme.
  const nodes = [...downRoot.descendants(), ...upRoot.descendants().slice(1)];
  drawTreeSvg(links, nodes, data.down.id);
}

function fitTree(animate = true) {
  if (!treeSvg || !treeG || !treeZoom) return;
  const svgNode = treeSvg.node();
  const box = treeG.node().getBBox();
  if (!box.width || !box.height) return;
  const w = svgNode.clientWidth || Number(treeSvg.attr("width"));
  const h = svgNode.clientHeight || Number(treeSvg.attr("height"));
  const scale = Math.min(w / (box.width + 40), h / (box.height + 40), 1.5);
  const tx = w / 2 - scale * (box.x + box.width / 2);
  const ty = h / 2 - scale * (box.y + box.height / 2);
  const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
  (animate ? treeSvg.transition().duration(300) : treeSvg).call(treeZoom.transform, t);
}

$("#zoom-in").addEventListener("click", () =>
  treeSvg && treeSvg.transition().duration(200).call(treeZoom.scaleBy, 1.3));
$("#zoom-out").addEventListener("click", () =>
  treeSvg && treeSvg.transition().duration(200).call(treeZoom.scaleBy, 1 / 1.3));
$("#zoom-fit").addEventListener("click", () => fitTree());

// Mercek aç/kapa (tercih saklanır).
function syncLoupeButton() {
  $("#zoom-loupe").classList.toggle("active", magnifierEnabled);
}
$("#zoom-loupe").addEventListener("click", () => {
  magnifierEnabled = !magnifierEnabled;
  localStorage.setItem("aile-loupe", magnifierEnabled ? "on" : "off");
  syncLoupeButton();
  if (!magnifierEnabled) hideMagnifier();
});
syncLoupeButton();

// Sadece ağaç sekmesini tam ekran yap (kontroller görünür kalsın diye #tab-tree).
$("#zoom-full").addEventListener("click", () => {
  const el = $("#tab-tree");
  if (document.fullscreenElement) document.exitFullscreen();
  else if (el.requestFullscreen) el.requestFullscreen();
});
// Tam ekrana gir/çıkınca kanvas boyutu değişir → görünümü yeniden sığdır.
document.addEventListener("fullscreenchange", () => {
  $("#zoom-full").classList.toggle("active", !!document.fullscreenElement);
  setTimeout(() => fitTree(false), 80);
});

function selectFromTree(id) {
  $$(".tab").forEach((b) => b.classList.remove("active"));
  document.querySelector('.tab[data-tab="people"]').classList.add("active");
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $("#tab-people").classList.remove("hidden");
  selectPerson(id);
}

/* ---------------- Import ---------------- */
$("#import-btn").addEventListener("click", async () => {
  const f = $("#gedcom-file");
  if (!f.files.length) return toast("Dosya seçin", true);
  const fd = new FormData();
  fd.append("file", f.files[0]);
  $("#import-result").innerHTML = '<p class="muted">Yükleniyor…</p>';
  try {
    const r = await api("/api/gedcom/import", { method: "POST", body: fd });
    $("#import-result").innerHTML = `<div class="result-ok">
      <strong>İçe aktarma tamamlandı.</strong><br />
      ${r.individuals} kişi · ${r.parent_child} ebeveyn-çocuk bağı · ${r.spouses} evlilik
      ${r.warnings.length ? `<br /><span class="muted">${r.warnings.length} uyarı</span>` : ""}
    </div>`;
    await loadPeople();
    toast("İçe aktarıldı");
  } catch (err) {
    $("#import-result").innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
});

/* ---------------- Users (admin) ---------------- */
async function loadUsers() {
  const users = await api("/api/users");
  const t = $("#users-table");
  t.innerHTML = `<tr><th>Ad</th><th>E-posta</th><th>Rol</th><th></th></tr>` +
    users.map((u) => `<tr>
      <td>${esc(u.full_name || "—")}</td>
      <td>${esc(u.email)}</td>
      <td>
        <select data-uid="${u.id}" class="role-select">
          ${["viewer", "editor", "admin"].map((r) =>
            `<option value="${r}" ${u.role === r ? "selected" : ""}>${roleLabel(r)}</option>`).join("")}
        </select>
      </td>
      <td>${u.id === state.user.id ? "" : `<button class="small danger" data-del-uid="${u.id}">Sil</button>`}</td>
    </tr>`).join("");

  t.querySelectorAll(".role-select").forEach((sel) =>
    sel.addEventListener("change", async () => {
      await api("/api/users/" + sel.dataset.uid, { method: "PATCH", json: { role: sel.value } });
      toast("Rol güncellendi");
    }));
  t.querySelectorAll("[data-del-uid]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Kullanıcı silinsin mi?")) return;
      await api("/api/users/" + btn.dataset.delUid, { method: "DELETE" });
      toast("Silindi");
      loadUsers();
    }));
}

$("#user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/users", {
      method: "POST",
      json: {
        full_name: $("#nu-name").value,
        email: $("#nu-email").value,
        password: $("#nu-password").value,
        role: $("#nu-role").value,
      },
    });
    e.target.reset();
    toast("Kullanıcı eklendi");
    loadUsers();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- Export ---------------- */
$("#export-btn").addEventListener("click", async () => {
  try {
    const text = await api("/api/gedcom/export");
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "aile-agaci.ged";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- Global error surfacing ---------------- */
window.addEventListener("unhandledrejection", (e) => {
  if (e.reason && e.reason.message) toast(e.reason.message, true);
});

/* ---------------- Build footer ---------------- */
fetch("/api/version")
  .then((r) => r.json())
  .then((v) => { $("#build-footer").textContent = `Sürüm ${v.version} · Yapı ${v.build}`; })
  .catch(() => {});

/* ---------------- Start ---------------- */
if (state.token) boot();
