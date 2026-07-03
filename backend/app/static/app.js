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
}

const roleLabel = (r) => ({ admin: "Yönetici", editor: "Düzenleyici", viewer: "Görüntüleyici" }[r] || r);

/* ---------------- Tabs ---------------- */
$$(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const tab = btn.dataset.tab;
    $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
    $("#tab-" + tab).classList.remove("hidden");
    if (tab === "tree") populateTreeRoots();
  });
});

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
    li.innerHTML = `<span class="sex-dot ${esc(p.sex)}"></span> ${esc(fullName(p))}`;
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
      ${field("Doğum", p.birth_date, p.birth_place)}
      ${field("Ölüm", p.death_date, p.death_place)}
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

function setTreeRoot(id) {
  state.treeRootId = id;
  const p = state.people.find((x) => x.id === id);
  if (p) $("#tree-root-input").value = treeRootLabel(p);
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
      (fullName(p) + " " + (p.birth_date || "")).toLowerCase().includes(needle))
    .slice(0, 60);
  list.innerHTML = items
    .map((p) => `<div class="combo-item" data-id="${p.id}">${esc(treeRootLabel(p))}</div>`)
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
  if (!state._treeShown) {
    // Default: the eldest ancestor line from the GEDCOM (topmost parentless
    // person with the largest descendant tree), not just the oldest birth date.
    try {
      const r = await api("/api/individuals/tree-root");
      if (r && r.id) setTreeRoot(r.id);
    } catch (_) {
      const oldest = oldestPersonId();
      if (oldest) setTreeRoot(oldest);
    }
    state._treeShown = true;
    if (state.treeRootId) renderTree();
  }
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
  renderTree();
}

async function renderTree() {
  const rootId = Number(state.treeRootId);
  const depth = Number($("#tree-depth").value) || 8;
  const direction = $("#tree-direction").value || "down";
  if (!rootId) return;
  const data = await api(`/api/individuals/${rootId}/pedigree?depth=${depth}&direction=${direction}`);
  if (data.mode === "focus") drawFocus(data);
  else drawPedigree(data);
}

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
  const b = (d.birth_date || "").trim();
  const de = (d.death_date || "").trim();
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
function drawTreeSvg(links, nodes, focusId = null) {
  const canvas = $("#tree-canvas");
  canvas.innerHTML = "";

  const width = canvas.clientWidth || 900;
  const height = Math.max(canvas.clientHeight, 560);

  const svg = d3.select(canvas).append("svg")
    .attr("width", width)
    .attr("height", height);

  // Tüm kartlar aynı yerel koordinatları kullandığı için tek clipPath yeter.
  svg.append("defs").append("clipPath").attr("id", "avatar-clip")
    .append("circle").attr("cx", AV_X).attr("cy", 0).attr("r", 16);

  const g = svg.append("g");

  // Ana kartlar + eş kartları ve çift bağlantıları.
  const cards = [];
  const coupleLinks = [];
  nodes.forEach((d) => {
    cards.push({ x: d.x, y: d.y, data: d.data,
                 focus: focusId !== null && d.data.id === focusId });
    (d.data.spouses || []).forEach((sp, i) => {
      const sx = d.x + (i + 1) * (NODE_W + SPOUSE_GAP);
      coupleLinks.push({ x1: sx - NODE_W - SPOUSE_GAP + NODE_W / 2, x2: sx - NODE_W / 2, y: d.y });
      cards.push({ x: sx, y: d.y, data: sp, focus: false });
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

  treeZoom = d3.zoom()
    .scaleExtent([0.05, 4])
    .on("zoom", (e) => g.attr("transform", e.transform));
  svg.call(treeZoom).on("dblclick.zoom", null);

  treeSvg = svg;
  treeG = g;
  fitTree(false);
}

// Eş kartları sağa doğru eklendiği için komşu düğümlere ekstra boşluk bırak.
function treeLayout() {
  const spouseSpan = (NODE_W + SPOUSE_GAP) / GAP_X;
  return d3.tree().nodeSize([GAP_X, GAP_Y]).separation((a, b) => {
    const s = (a.data.spouses ? a.data.spouses.length : 0) +
              (b.data.spouses ? b.data.spouses.length : 0);
    return (a.parent === b.parent ? 1 : 1.2) + s * spouseSpan;
  });
}

function drawPedigree(rootData) {
  const root = d3.hierarchy(rootData);
  treeLayout()(root);
  drawTreeSvg(root.links(), root.descendants());
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

/* ---------------- Start ---------------- */
if (state.token) boot();
