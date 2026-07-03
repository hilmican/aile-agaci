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

function populateTreeRoots() {
  const sel = $("#tree-root");
  const cur = sel.value;
  sel.innerHTML = state.people
    .map((p) => {
      const y = birthYear(p);
      const label = fullName(p) + (Number.isFinite(y) ? ` (${y})` : "");
      return `<option value="${p.id}">${esc(label)}</option>`;
    })
    .join("");
  if (cur) sel.value = cur;
  else {
    // Default: start the tree from the oldest family member.
    const oldest = oldestPersonId();
    if (oldest) sel.value = oldest;
    if (sel.value) renderTree();
  }
}

$("#tree-render").addEventListener("click", renderTree);

function showInTree(id) {
  $$(".tab").forEach((b) => b.classList.remove("active"));
  document.querySelector('.tab[data-tab="tree"]').classList.add("active");
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $("#tab-tree").classList.remove("hidden");
  populateTreeRoots();
  $("#tree-root").value = id;
  renderTree();
}

async function renderTree() {
  const rootId = Number($("#tree-root").value);
  const depth = Number($("#tree-depth").value) || 4;
  const direction = $("#tree-direction").value || "down";
  if (!rootId) return;
  const data = await api(`/api/individuals/${rootId}/pedigree?depth=${depth}&direction=${direction}`);
  drawPedigree(data);
}

function drawPedigree(rootData) {
  const canvas = $("#tree-canvas");
  canvas.innerHTML = "";

  const root = d3.hierarchy(rootData);
  const nodeW = 150, nodeH = 52;
  const dx = nodeH + 26;   // vertical gap between siblings
  const dy = nodeW + 60;   // horizontal gap between generations
  d3.tree().nodeSize([dx, dy])(root);

  let x0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  root.each((d) => {
    if (d.x > x1) x1 = d.x;
    if (d.x < x0) x0 = d.x;
    if (d.y > y1) y1 = d.y;
  });

  const height = x1 - x0 + dx * 2;
  const width = y1 + dy;
  const svg = d3.select(canvas).append("svg")
    .attr("width", width + 40)
    .attr("height", height + 40)
    .attr("viewBox", [-nodeW / 2 - 20, x0 - dx, width + 40, height + 40]);

  const g = svg.append("g");

  g.selectAll("path.link")
    .data(root.links())
    .join("path")
    .attr("class", "link")
    .attr("d", d3.linkHorizontal().x((d) => d.y).y((d) => d.x));

  const node = g.selectAll("g.node-card")
    .data(root.descendants())
    .join("g")
    .attr("class", (d) => `node-card ${d.data.sex || "U"}`)
    .attr("transform", (d) => `translate(${d.y},${d.x})`)
    .style("cursor", "pointer")
    .on("click", (_, d) => selectFromTree(d.data.id));

  node.append("rect")
    .attr("x", -nodeW / 2).attr("y", -nodeH / 2)
    .attr("width", nodeW).attr("height", nodeH).attr("rx", 6);

  node.append("text")
    .attr("class", "name").attr("text-anchor", "middle").attr("dy", "-2")
    .text((d) => d.data.name);

  node.append("text")
    .attr("class", "dates").attr("text-anchor", "middle").attr("dy", "14")
    .text((d) => {
      const b = (d.data.birth_date || "").trim();
      const de = (d.data.death_date || "").trim();
      if (!b && !de) return "";
      return `${b || "?"} – ${de || ""}`.trim();
    });
}

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
