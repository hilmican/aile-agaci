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
  const applied = await applyHash(); // paylaşılan URL varsa o görünümü aç
  if (!applied) {
    switchTab("home");
    loadDashboard();
  }
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
    if (tab === "home") loadDashboard();
    if (tab === "families") openFamilies();
    if (tab === "map") openMap();
    if (tab === "bulk") openBulk();
    if (tab === "dna") openDna();
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
    try {
      await selectPerson(Number(h.get("person")));
      if (h.get("edit") === "1" && canEdit()) {
        renderEditForm(await api("/api/individuals/" + Number(h.get("person"))));
      }
    } catch (_) {}
    return true;
  }
  if (tab === "list" && h.get("kind")) {
    await openListPage(h.get("kind"), h.get("item") || undefined);
    return true;
  }
  if (tab === "families") {
    await openFamilies(h.get("fam") ? Number(h.get("fam")) : undefined);
    return true;
  }
  if (tab === "map") { await openMap(); return true; }
  if (tab === "bulk") { await openBulk(); return true; }
  if (tab === "dna") { await openDna(); return true; }
  if (["home", "people", "tree", "import", "users"].includes(tab)) {
    switchTab(tab);
    if (tab === "tree") populateTreeRoots();
    if (tab === "home") loadDashboard();
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
  // İsimliler ve daha çok bilgisi olanlar üstte; isimsiz/eksik kayıtlar sonda.
  const ordered = [...state.people].sort((a, b) =>
    personScore(b) - personScore(a) || fullName(a).localeCompare(fullName(b), "tr"));
  ordered.forEach((p) => {
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
      ${(p.death_date || "").trim().toUpperCase().startsWith("EST")
        ? `<div class="field"><span class="k"></span><div class="est-note">⚠ Ölüm yılı toplu işlemle (~yaş) tahmin edildi; kesin kayıt bulununca düzeltin.</div></div>` : ""}
      ${field("Kızlık soyadı", p.maiden_name)}
      ${field("Meslek", p.occupation)}
      ${lastResidenceField(p)}
    </div>
    ${p.notes ? `<div class="field"><span class="k">Notlar</span><div>${esc(p.notes)}</div></div>` : ""}

    <div class="rel-section">
      <h3>Aile Kolları</h3>
      <div class="rel-chips">${(p.families || []).map((f) => {
        const tag = f.kind === "inherited" ? '<span class="fam-kind">baba tarafı</span>'
          : f.kind === "marriage" ? '<span class="fam-kind">evlilik</span>' : "";
        const del = (canEdit() && f.removable) ? `<span class="x" data-fam-del="${f.id}" title="Kaldır">×</span>` : "";
        const em = f.emblem ? `<span class="fam-emblem-sm">${emblemSvg(f.emblem)}</span>` : "";
        return `<span class="chip fam-chip ${esc(f.kind)}" data-fam-go="${f.id}">${em}${esc(f.name)} ${tag} ${del}</span>`;
      }).join("") || '<span class="muted">—</span>'}</div>
      ${canEdit() ? `<div class="inline-form">
        <input type="text" id="fam-input" list="fam-datalist" placeholder="Aile kolu (örn. Vasiloğulları)" />
        <datalist id="fam-datalist"></datalist>
        <button id="fam-add">Ekle</button>
      </div>` : ""}
    </div>

    ${contactSection(p)}

    ${relSection("Ebeveynler", "parent", p.parents)}
    ${spouseSection(p.spouses)}
    ${relSection("Çocuklar", "child", p.children)}

    <div class="rel-section">
      <h3>Yaşadığı Yerler</h3>
      <div class="residences">${residencesHtml(p)}</div>
      ${canEdit() ? `<div class="inline-form res-form">
        <input type="text" id="res-start" placeholder="Başlangıç (örn. 1998)" style="width:130px" />
        <input type="text" id="res-end" placeholder="Bitiş (boşsa halen)" style="width:130px" />
        <input type="text" id="res-place" placeholder="Yer (örn. Ankara)" />
        <input type="text" id="res-note" placeholder="Not (isteğe bağlı)" />
        <button id="res-add">Ekle</button>
      </div>` : ""}
    </div>

    <div class="rel-section">
      <h3>Görseller</h3>
      <div class="media-gallery">${p.media.map(mediaHtml).join("") || '<span class="muted">Görsel yok</span>'}</div>
      ${canEdit() ? `<div class="inline-form">
        <input type="file" id="media-file" accept="image/*" />
        <input type="text" id="media-caption" placeholder="Açıklama (isteğe bağlı)" />
        <button id="media-upload">Görsel Ekle</button>
      </div>` : ""}
    </div>

    <div class="rel-section">
      <h3>Anekdotlar</h3>
      <div class="anecdotes">${(p.anecdotes || []).map(anecdoteHtml).join("") || '<span class="muted">Henüz anekdot yok</span>'}</div>
      ${canEdit() ? `<div class="anec-form">
        <input type="text" id="anec-title" placeholder="Başlık (isteğe bağlı)" />
        <textarea id="anec-text" rows="3" placeholder="Bu kişiyle ilgili bir anı, hikâye yazın…"></textarea>
        <button id="anec-add">Anekdot Ekle</button>
      </div>` : ""}
    </div>
  `;

  $("#show-tree-btn").addEventListener("click", () => showInTree(p.id));
  if (canEdit()) {
    $("#edit-btn").addEventListener("click", () => renderEditForm(p));
    $("#del-btn").addEventListener("click", () => deletePerson(p.id));
    $("#media-upload").addEventListener("click", () => uploadMedia(p.id));
    $("#anec-add").addEventListener("click", async () => {
      const text = $("#anec-text").value.trim();
      if (!text) return toast("Anekdot metni boş olamaz", true);
      await api(`/api/individuals/${p.id}/anecdotes`, {
        method: "POST",
        json: { title: $("#anec-title").value.trim(), text },
      });
      toast("Anekdot eklendi");
      selectPerson(p.id);
    });
    $$("[data-anec-del]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Anekdot silinsin mi?")) return;
        await api(`/api/individuals/${p.id}/anecdotes/${btn.dataset.anecDel}`, { method: "DELETE" });
        toast("Anekdot silindi");
        selectPerson(p.id);
      }));
    let resPick = null;
    if ($("#res-place")) attachPlaceAutocomplete($("#res-place"), (pk) => { resPick = pk; });
    $("#res-add").addEventListener("click", async () => {
      const place = $("#res-place").value.trim();
      if (!place) return toast("Yer boş olamaz", true);
      await api(`/api/individuals/${p.id}/residences`, {
        method: "POST",
        json: {
          place,
          start: $("#res-start").value.trim(),
          end: $("#res-end").value.trim(),
          note: $("#res-note").value.trim(),
          lat: resPick ? resPick.lat : null,
          lng: resPick ? resPick.lon : null,
        },
      });
      toast("Yaşam yeri eklendi");
      selectPerson(p.id);
    });
    $$("[data-res-del]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Kayıt silinsin mi?")) return;
        await api(`/api/individuals/${p.id}/residences/${btn.dataset.resDel}`, { method: "DELETE" });
        toast("Silindi");
        selectPerson(p.id);
      }));
    // Aile kolu ekle (datalist ile otomatik tamamlama)
    api("/api/families").then((d) => {
      const dl = $("#fam-datalist");
      if (dl) dl.innerHTML = d.items.map((f) => `<option value="${esc(f.name)}"></option>`).join("");
    }).catch(() => {});
    $("#fam-add").addEventListener("click", async () => {
      const name = $("#fam-input").value.trim();
      if (!name) return toast("Aile kolu adı yazın", true);
      await api(`/api/individuals/${p.id}/families`, { method: "POST", json: { name } });
      toast("Aile kolu eklendi");
      selectPerson(p.id);
    });
    $$("[data-fam-del]").forEach((el) =>
      el.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        await api(`/api/individuals/${p.id}/families/${el.dataset.famDel}`, { method: "DELETE" });
        toast("Kaldırıldı");
        selectPerson(p.id);
      }));
    $$("[data-sp-edit]").forEach((btn) =>
      btn.addEventListener("click", () =>
        document.querySelector(`[data-sp-form="${btn.dataset.spEdit}"]`)?.classList.toggle("hidden")));
    $$("[data-sp-save]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const form = document.querySelector(`[data-sp-form="${btn.dataset.spSave}"]`);
        await api(`/api/individuals/${p.id}/spouses/${btn.dataset.spSave}`, {
          method: "PATCH",
          json: {
            marriage_date: form.querySelector(".sp-md").value.trim(),
            marriage_place: form.querySelector(".sp-mp").value.trim(),
          },
        });
        toast("Evlilik bilgisi güncellendi");
        selectPerson(p.id);
      }));
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
  // Aile kolu rozetine tıklayınca o kümenin üyelerine git.
  $$("[data-fam-go]").forEach((chip) =>
    chip.addEventListener("click", (e) => {
      if (e.target.closest("[data-fam-del]")) return;
      openFamilies(Number(chip.dataset.famGo));
    }));
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

// Eşler: evlilik tarihi/yeri gösterilir ve düzenlenebilir.
function spouseSection(spouses) {
  const rows = spouses.map((s) => {
    const p = s.person;
    const x = canEdit() ? `<span class="x" title="Kaldır">×</span>` : "";
    const md = trDate((s.marriage_date || "").trim());
    const mp = (s.marriage_place || "").trim();
    const info = [md && `💍 ${esc(md)}`, mp && esc(mp)].filter(Boolean).join(" · ");
    const edit = canEdit()
      ? `<button class="small ghost sp-edit-btn" data-sp-edit="${p.id}" title="Evlilik bilgisi">✏️</button>` : "";
    const form = canEdit() ? `<div class="sp-edit hidden" data-sp-form="${p.id}">
        <input type="text" class="sp-md" placeholder="Evlilik tarihi" value="${esc(s.marriage_date || "")}" />
        <input type="text" class="sp-mp" placeholder="Evlilik yeri" value="${esc(s.marriage_place || "")}" />
        <button class="small sp-save" data-sp-save="${p.id}">Kaydet</button>
      </div>` : "";
    return `<div class="spouse-row">
      <span class="chip" data-rel="spouse" data-relid="${p.id}" data-goto="${p.id}">${esc(fullName(p))} ${x}</span>
      ${info ? `<span class="sp-info">${info}</span>` : ""}
      ${edit}
      ${form}
    </div>`;
  }).join("");
  return `<div class="rel-section">
    <h3>Eş(ler)</h3>
    <div class="spouse-list">${rows || '<span class="muted">—</span>'}</div>
    <div class="rel-adder" data-adder="spouse"></div>
  </div>`;
}

// Aramalı kişi seçici: yazınca tüm veritabanında arar, sonuçlarda doğum
// tarihi ve (isim içindeki) lakap görünür. .el döner; getId() seçili id.
function createPersonPicker({ exclude = [], placeholder = "Kişi ara…" } = {}) {
  const excludeSet = new Set(exclude);
  const wrap = document.createElement("div");
  wrap.className = "combo person-picker";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  const list = document.createElement("div");
  list.className = "combo-list hidden";
  wrap.append(input, list);

  let chosenId = null, pool = [], timer = null;

  function draw(people) {
    pool = people;
    const items = people
      .filter((p) => !excludeSet.has(p.id))
      .sort((a, b) => personScore(b) - personScore(a) ||
        fullName(a).localeCompare(fullName(b), "tr"))
      .slice(0, 60);
    list.innerHTML = items.map((p) => {
      const s = personSub(p);
      return `<div class="combo-item" data-id="${p.id}">
        <div>${esc(fullName(p))}</div>${s ? `<div class="combo-sub">${esc(s)}</div>` : ""}</div>`;
    }).join("") || '<div class="combo-empty">Sonuç yok</div>';
    list.classList.remove("hidden");
  }

  async function search(q) {
    const needle = q.trim();
    if (!needle) return draw(state.people);
    try { draw(await api("/api/individuals?q=" + encodeURIComponent(needle))); }
    catch (_) {
      draw(state.people.filter((p) => fullName(p).toLowerCase().includes(needle.toLowerCase())));
    }
  }

  function pick(id) {
    chosenId = id;
    const p = pool.find((x) => x.id === id) || state.people.find((x) => x.id === id);
    input.value = p ? fullName(p) : "";
    list.classList.add("hidden");
  }

  input.addEventListener("input", () => {
    chosenId = null;
    clearTimeout(timer);
    timer = setTimeout(() => search(input.value), 200);
  });
  input.addEventListener("focus", () => draw(state.people));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = list.querySelector(".combo-item");
      if (first) pick(Number(first.dataset.id));
    } else if (e.key === "Escape") list.classList.add("hidden");
  });
  list.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".combo-item");
    if (item) pick(Number(item.dataset.id));
  });
  input.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 150));

  return { el: wrap, getId: () => chosenId, reset: () => { chosenId = null; input.value = ""; } };
}

function renderRelAdders(p) {
  ["parent", "spouse", "child"].forEach((relType) => {
    const holder = document.querySelector(`[data-adder="${relType}"]`);
    if (!holder) return;
    holder.innerHTML = "";
    const form = document.createElement("div");
    form.className = "inline-form";

    const picker = createPersonPicker({
      exclude: [p.id],
      placeholder: `${relLabel(relType)} ara…`,
    });
    form.appendChild(picker.el);

    let marrInput = null;
    if (relType === "spouse") {
      marrInput = document.createElement("input");
      marrInput.type = "text";
      marrInput.placeholder = "Evlilik tarihi";
      marrInput.style.width = "130px";
      form.appendChild(marrInput);
    }

    const btn = document.createElement("button");
    btn.className = "small";
    btn.textContent = "Ekle";
    btn.addEventListener("click", () => {
      const id = picker.getId();
      if (!id) return toast("Önce listeden kişi seçin", true);
      addRelationship(p.id, relType, id, marrInput ? marrInput.value : "");
    });
    form.appendChild(btn);
    holder.appendChild(form);
  });
}

const relLabel = (t) => ({ parent: "ebeveyn", spouse: "eş", child: "çocuk" }[t] || t);

// Bir kaydın zaman aralığı etiketi. Bitiş yoksa "halen".
function residenceRange(r) {
  const s = trDate((r.start || "").trim());
  const e = trDate((r.end || "").trim());
  if (s && e) return `${s} – ${e}`;
  if (s) return `${s} – halen`;
  if (e) return `– ${e}`;
  return "";
}

// Şu an yaşanan (bitişi olmayan) yer varsa onu, yoksa en son kaydı seç.
function currentResidence(res) {
  const ongoing = res.filter((r) => !(r.end || "").trim());
  if (ongoing.length) return ongoing[ongoing.length - 1];
  return res.length ? res[res.length - 1] : null;
}

function lastResidenceField(p) {
  const res = p.residences || [];
  const cur = currentResidence(res);
  if (!cur) return "";
  const ongoing = !(cur.end || "").trim();
  const label = ongoing ? "Şu an yaşadığı yer" : "Son yaşadığı yer";
  return `<div class="field"><span class="k">${label}</span><div>${esc(cur.place)}</div></div>`;
}

function residencesHtml(p) {
  const res = p.residences || [];
  if (!res.length) return '<span class="muted">Kayıt yok</span>';
  return `<ul class="res-timeline">${res.map((r) => {
    const ongoing = !(r.end || "").trim();
    const del = canEdit() ? `<button class="small danger" data-res-del="${r.id}">Sil</button>` : "";
    const range = residenceRange(r);
    const note = r.note ? `<div class="res-note">${esc(r.note)}</div>` : "";
    return `<li class="${ongoing ? "ongoing" : ""}">
      <span class="res-dot"></span>
      <div class="res-body">
        <div class="res-head"><span class="res-place">${esc(r.place)}</span>
          ${range ? `<span class="res-range">${esc(range)}</span>` : ""} ${del}</div>
        ${note}
      </div>
    </li>`;
  }).join("")}</ul>`;
}

function contactSection(p) {
  const rows = [];
  if ((p.phone || "").trim())
    rows.push(`<span class="k">Telefon</span><div><a href="tel:${esc(p.phone.replace(/\s/g, ""))}">${esc(p.phone)}</a></div>`);
  if ((p.email || "").trim())
    rows.push(`<span class="k">E-posta</span><div><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div>`);
  if ((p.address || "").trim())
    rows.push(`<span class="k">Adres</span><div><a target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(p.address)}">${esc(p.address)}</a></div>`);
  if (!rows.length) return "";
  return `<div class="rel-section"><h3>İletişim</h3>
    <div class="detail-grid">${rows.map((r) => `<div class="field">${r}</div>`).join("")}</div></div>`;
}

function anecdoteHtml(a) {
  const del = canEdit() ? `<button class="small danger" data-anec-del="${a.id}">Sil</button>` : "";
  const when = a.created_at
    ? new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" })
        .format(new Date(a.created_at))
    : "";
  return `<div class="anecdote">
    ${a.title ? `<div class="anec-title">${esc(a.title)}</div>` : ""}
    <div class="anec-text">${esc(a.text)}</div>
    <div class="anec-meta">${esc(a.author_name || "")}${when ? ` · ${esc(when)}` : ""} ${del}</div>
  </div>`;
}

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
  ["phone", "Telefon"], ["email", "E-posta"], ["address", "Adres"],
];

// Konum alanları: yer inputuna Nominatim autocomplete + gizli enlem/boylam.
const PLACE_KEYS = { birth_place: "birth", death_place: "death" };

function personForm(p = {}) {
  const inputs = PERSON_FIELDS.map(([k, label]) => {
    if (PLACE_KEYS[k]) {
      return `<label>${esc(label)}
        <input name="${k}" value="${esc(p[k] || "")}" data-place="${PLACE_KEYS[k]}" autocomplete="off" /></label>`;
    }
    return `<label>${esc(label)}<input name="${k}" value="${esc(p[k] || "")}" /></label>`;
  }).join("");
  const coordHidden = ["birth_lat", "birth_lng", "death_lat", "death_lng"]
    .map((k) => `<input type="hidden" name="${k}" value="${p[k] ?? ""}" />`).join("");
  return `<form id="person-form">
    <div class="detail-grid">
      <label>Cinsiyet<select name="sex">
        <option value="U" ${p.sex === "U" || !p.sex ? "selected" : ""}>Bilinmiyor</option>
        <option value="M" ${p.sex === "M" ? "selected" : ""}>Erkek</option>
        <option value="F" ${p.sex === "F" ? "selected" : ""}>Kadın</option>
      </select></label>
      ${inputs}
    </div>
    ${coordHidden}
    <label>Notlar<textarea name="notes" rows="3">${esc(p.notes || "")}</textarea></label>
    <div class="detail-actions" style="margin-top:1rem">
      <button type="submit">Kaydet</button>
      <button type="button" id="cancel-edit" class="ghost">Vazgeç</button>
    </div>
  </form>`;
}

// personForm'daki yer inputlarına autocomplete bağla; seçilince gizli koordinatı doldur.
function wirePlaceInputs(form) {
  form.querySelectorAll("[data-place]").forEach((input) => {
    const key = input.dataset.place; // birth | death
    attachPlaceAutocomplete(input, (pick) => {
      form.querySelector(`[name="${key}_lat"]`).value = pick ? pick.lat : "";
      form.querySelector(`[name="${key}_lng"]`).value = pick ? pick.lon : "";
    });
  });
}

function startAddPerson() {
  if (!canEdit()) return;
  state.selectedId = null;
  const el = $("#person-detail");
  el.innerHTML = `<h2>Yeni Kişi</h2>${personForm()}`;
  wirePlaceInputs($("#person-form"));
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
  wirePlaceInputs($("#person-form"));
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
  // Koordinat alanları: boş -> null, dolu -> sayı.
  ["birth_lat", "birth_lng", "death_lat", "death_lng"].forEach((k) => {
    if (k in obj) obj[k] = obj[k] === "" ? null : Number(obj[k]);
  });
  return obj;
}

/* ---- Yer otomatik tamamlama (OpenStreetMap Nominatim) ---- */
function attachPlaceAutocomplete(input, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "combo place-ac";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const list = document.createElement("div");
  list.className = "combo-list hidden";
  wrap.appendChild(list);
  let timer = null;

  input.addEventListener("input", () => {
    onPick(null); // elle yazınca eski koordinatı düşür (yeniden seçilmeli)
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { list.classList.add("hidden"); return; }
    timer = setTimeout(async () => {
      list.innerHTML = '<div class="combo-empty">Aranıyor…</div>';
      list.classList.remove("hidden");
      try {
        const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6"
          + "&accept-language=tr&q=" + encodeURIComponent(q);
        const data = await (await fetch(url, { headers: { Accept: "application/json" } })).json();
        list.innerHTML = data.length
          ? data.map((d) => `<div class="combo-item" data-lat="${d.lat}" data-lon="${d.lon}"
              data-name="${esc(d.display_name)}">${esc(d.display_name)}</div>`).join("")
          : '<div class="combo-empty">Sonuç yok</div>';
      } catch (_) { list.innerHTML = '<div class="combo-empty">Arama başarısız</div>'; }
    }, 500);
  });
  list.addEventListener("mousedown", (e) => {
    const it = e.target.closest(".combo-item");
    if (!it || !it.dataset.lat) return;
    input.value = it.dataset.name;
    list.classList.add("hidden");
    onPick({ lat: Number(it.dataset.lat), lon: Number(it.dataset.lon), name: it.dataset.name });
  });
  input.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 200));
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

// Önem sırası: isimliler önce; sonra ağaçtaki bağlantı sayısı (ana soy hattı
// çok bağlantılı, kayın/uzak dallar az); en son ufak bir "profil doluluğu"
// eşitlik bozucu. İsimsiz/kopuk kayıtlar en sona düşer.
function personScore(p) {
  let s = 0;
  if ((p.first_name || p.last_name || "").trim()) s += 1_000_000;  // isim baskın
  s += (p.connections || 0) * 1000;                                // bağlantı asıl ölçüt
  if ((p.birth_date || "").trim()) s += 3;                          // eşitlik bozucular
  if ((p.death_date || "").trim()) s += 1;
  if ((p.birth_place || "").trim()) s += 1;
  if ((p.occupation || "").trim()) s += 1;
  return s;
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
    .sort((a, b) => personScore(b) - personScore(a) ||
      fullName(a).localeCompare(fullName(b), "tr"))
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
  const depth = Number($("#tree-depth").value) || 12;
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

function treeCardYear(c) {
  const m = /\d{3,4}/.exec(c.data.birth_date || "");
  return m ? Number(m[0]) : null;
}

// Nesilleri yukarıdan aşağı yıl bantlarında göster (zaman ilerleme hissi).
function drawYearBands(layer, cards) {
  if (!cards.length) return;
  const xs = cards.map((c) => c.x);
  const minX = Math.min(...xs) - NODE_W;
  const w = (Math.max(...xs) + NODE_W) - minX;
  const byY = new Map();
  cards.forEach((c) => {
    const k = Math.round(c.y);
    if (!byY.has(k)) byY.set(k, []);
    byY.get(k).push(c);
  });
  [...byY.keys()].sort((a, b) => a - b).forEach((y, i) => {
    if (i % 2 === 0) {
      layer.append("rect").attr("class", "year-band-bg")
        .attr("x", minX).attr("y", y - GAP_Y / 2).attr("width", w).attr("height", GAP_Y);
    }
    const years = byY.get(y).map(treeCardYear).filter(Boolean);
    if (years.length) {
      const mn = Math.min(...years), mx = Math.max(...years);
      layer.append("text").attr("class", "band-label")
        .attr("x", minX + 10).attr("y", y).attr("dy", "0.32em")
        .text(mn === mx ? `${mn}` : `${mn}–${mx}`);
    }
  });
}

// Karta küçük aile arması (SVG havuz ya da custom görsel) ekle.
function appendCardEmblem(sel, key, x, y, size) {
  if (!key) return;
  if (key.startsWith("custom:")) {
    sel.append("image").attr("href", "/uploads/" + key.slice(7))
      .attr("x", x).attr("y", y).attr("width", size).attr("height", size)
      .attr("preserveAspectRatio", "xMidYMid meet").attr("pointer-events", "none");
  } else if (EMBLEMS[key]) {
    const s = sel.append("svg").attr("x", x).attr("y", y)
      .attr("width", size).attr("height", size).attr("viewBox", "0 0 100 100")
      .attr("pointer-events", "none");
    s.style("color", "#6a5acd").html(`<g fill="currentColor">${EMBLEMS[key].svg}</g>`);
  }
}

// Kişinin anekdotlarını popup'ta listele.
async function openAnecdotes(id) {
  let p;
  try { p = await api("/api/individuals/" + id); } catch (_) { return; }
  let ov = $("#anec-view");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "anec-view";
    ov.className = "modal-backdrop hidden";
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.add("hidden"); });
  }
  const list = (p.anecdotes || []).map((a) => {
    const when = a.created_at
      ? new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" })
          .format(new Date(a.created_at)) : "";
    return `<div class="anecdote">
      ${a.title ? `<div class="anec-title">${esc(a.title)}</div>` : ""}
      <div class="anec-text">${esc(a.text)}</div>
      <div class="anec-meta">${esc(a.author_name || "")}${when ? ` · ${esc(when)}` : ""}</div>
    </div>`;
  }).join("") || '<p class="muted">Anekdot yok.</p>';
  ov.innerHTML = `<div class="emblem-modal">
    <div class="modal-head"><h2>📖 ${esc(fullName(p))}</h2><button class="ghost" data-ac-close>✕</button></div>
    <div class="modal-body anecdotes">${list}</div>
  </div>`;
  ov.querySelector("[data-ac-close]").addEventListener("click", () => ov.classList.add("hidden"));
  ov.classList.remove("hidden");
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
  // Yıl bantları en arkada; kart/çizgilerden önce eklenir.
  const bandsLayer = g.append("g").attr("class", "year-bands").attr("pointer-events", "none");

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

  drawYearBands(bandsLayer, cards);

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

  // Aile arması (sol üst köşe) — varsa, avatarın üstünde küçük ve dekoratif.
  card.filter((c) => c.data.emblem)
    .each(function (c) {
      appendCardEmblem(d3.select(this), c.data.emblem,
        -NODE_W / 2 + 3, -NODE_H / 2 + 3, 16);
    });

  // Tam isim + tarihler + doğum yeri tarayıcı tooltip'i olarak.
  card.append("title")
    .text((c) => {
      const bp = (c.data.birth_place || "").trim();
      return [c.data.name, datesLabel(c.data), bp ? `📍 ${bp}` : ""]
        .filter(Boolean).join("\n");
    });

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

  // Hızlı düzenleme: kartın sağ ALT köşesinde, silik; yalnız üzerine gelince
  // belirir (dikkat dağıtmaz). Yalnız düzenleyiciye.
  if (canEdit()) {
    const editG = card.append("g")
      .attr("class", "edit-btn")
      .attr("transform", `translate(${NODE_W / 2 - 12},${NODE_H / 2 - 11})`)
      .on("click", (e, c) => {
        e.stopPropagation();
        openQuickEdit(c.data.id);
      });
    editG.append("circle").attr("r", 8);
    editG.append("text").attr("text-anchor", "middle").attr("dy", "3").attr("font-size", "9px").text("✏️");
    editG.append("title").text("Hızlı düzenle");
  }

  // Anekdot ikonu (sol alt köşe) — yalnız hakkında anekdot olan kişilerde.
  const anec = card.filter((c) => c.data.has_anecdotes)
    .append("g")
    .attr("class", "anec-btn")
    .attr("transform", `translate(${-NODE_W / 2 + 12},${NODE_H / 2 - 11})`)
    .on("click", (e, c) => {
      e.stopPropagation();
      openAnecdotes(c.data.id);
    });
  anec.append("circle").attr("r", 8);
  anec.append("text").attr("text-anchor", "middle").attr("dy", "3").attr("font-size", "9px").text("📖");
  anec.append("title").text("Anekdotları göster");

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
// Safari webkit önekli; iOS Safari (iPhone) element tam ekranını HİÇ desteklemez
// → CSS tabanlı "sözde tam ekran" (viewport'u kaplayan sabit katman) fallback'i.
function nativeFsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function exitNativeFs() {
  if (document.exitFullscreen) document.exitFullscreen();
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
}
$("#zoom-full").addEventListener("click", () => {
  const el = $("#tab-tree");
  if (nativeFsElement()) { exitNativeFs(); return; }
  if (el.classList.contains("pseudo-fullscreen")) {         // sözde tam ekrandan çık
    el.classList.remove("pseudo-fullscreen", "tree-fs");
    $("#zoom-full").classList.remove("active");
    setTimeout(() => fitTree(false), 80);
    return;
  }
  if (el.requestFullscreen) el.requestFullscreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else {                                                    // iPhone Safari fallback
    el.classList.add("pseudo-fullscreen", "tree-fs");
    $("#zoom-full").classList.add("active");
    setTimeout(() => fitTree(false), 80);
  }
});
// Tam ekrana gir/çıkınca kanvas boyutu değişir → görünümü yeniden sığdır.
// tree-fs sınıfı (native ya da sözde) iç düzeni kontrol eder.
["fullscreenchange", "webkitfullscreenchange"].forEach((ev) =>
  document.addEventListener(ev, () => {
    const on = !!nativeFsElement();
    $("#tab-tree").classList.toggle("tree-fs", on);
    $("#zoom-full").classList.toggle("active", on);
    setTimeout(() => fitTree(false), 80);
  }));

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

/* ---------------- Anasayfa (dashboard) ---------------- */
const TR_DATE_FMT = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long" });
const TR_FULL_FMT = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" });

function fmtAgo(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 90) return "az önce";
  if (diff < 3600) return `${Math.round(diff / 60)} dk önce`;
  if (diff < 86400) return `${Math.round(diff / 3600)} saat önce`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} gün önce`;
  return TR_FULL_FMT.format(new Date(iso));
}

const personLink = (p) =>
  `<a href="#tab=people&person=${p.id}" class="plink" data-person="${p.id}">${esc(p.name)}</a>`;

async function loadDashboard() {
  const d = await api("/api/dashboard");

  // İstatistik kartları (nav: tıklanınca gidilecek yer / açılacak liste)
  const s = d.stats;
  const cards = [
    [s.total, "Kişi", "people"],
    [`${s.females} / ${s.males}`, "Kadın / Erkek", ""],
    [s.marriages, "Evlilik", "list:marriages"],
    [s.generations, "Nesil", ""],
    [s.with_photo, "Fotoğraflı kişi", "list:photos"],
    [s.anecdotes, "Anekdot", "list:anecdotes"],
  ];
  $("#dash-stats").innerHTML = cards
    .map(([v, l, nav]) => `<div class="stat-card${nav ? " clickable" : ""}"${nav ? ` data-nav="${nav}"` : ""}>
      <div class="v">${esc(String(v))}</div><div class="l">${esc(l)}</div></div>`)
    .join("") + (s.oldest
      ? `<div class="stat-card wide"><div class="v">${personLink(s.oldest.person)}</div>
         <div class="l">En eski kişi · ${esc(String(s.oldest.year))}</div></div>` : "");

  // Yaklaşan günler
  const when = (u) => u.days_left === 0 ? "bugün" : u.days_left === 1 ? "yarın"
    : `${u.days_left} gün sonra`;
  $("#dash-upcoming").innerHTML = d.upcoming.map((u) => {
    const dt = TR_DATE_FMT.format(new Date(u.date + "T00:00:00"));
    if (u.type === "birthday") {
      const age = u.age ? `, ${u.age} yaşına girecek` : "";
      return `<li>🎂 ${personLink(u.person)} — ${esc(dt)} (${when(u)})${esc(age)}</li>`;
    }
    const years = u.age ? `vefatının ${u.age}. yılı` : "vefat yıldönümü";
    return `<li>🕯 ${personLink(u.person)} — ${esc(years)} (${esc(dt)})</li>`;
  }).join("") || '<li class="muted">Önümüzdeki 30 günde kayıtlı bir gün yok.</li>';

  // Haber akışı
  const FEED_TR = {
    person_created: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> kişisini ekledi`,
    person_updated: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> bilgilerini güncelledi`,
    person_deleted: (f) => `${esc(f.user)}, <b>${esc(f.individual)}</b> kişisini sildi`,
    relationship_added: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> için ilişki ekledi${f.detail ? ` (${esc(f.detail)})` : ""}`,
    relationship_removed: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> için bir ilişkiyi kaldırdı`,
    media_added: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> için fotoğraf ekledi`,
    media_deleted: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> için bir görseli sildi`,
    anecdote_added: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> hakkında bir anekdot ekledi${f.detail ? `: “${esc(f.detail)}”` : ""}`,
    anecdote_deleted: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> için bir anekdotu sildi`,
    marriage_updated: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b>${f.detail ? ` – ${esc(f.detail)}` : ""} evlilik bilgisini güncelledi`,
    residence_added: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> için yaşadığı yer ekledi${f.detail ? `: ${esc(f.detail)}` : ""}`,
    residence_removed: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> için bir yaşam yeri kaydını sildi`,
    family_added: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> kişisini <b>${esc(f.detail)}</b> koluna ekledi`,
    family_removed: (f) => `${esc(f.user)}, <b>${nameOrLink(f)}</b> kişisini <b>${esc(f.detail)}</b> kolundan çıkardı`,
    gedcom_imported: (f) => `${esc(f.user)} GEDCOM içe aktardı${f.detail ? ` (${esc(f.detail)})` : ""}`,
    bulk_updated: (f) => `${esc(f.user)} toplu güncelleme yaptı${f.detail ? `: ${esc(f.detail)}` : ""}`,
    dna_imported: (f) => `${esc(f.user)} DNA eşleşmesi çekti${f.detail ? ` (${esc(f.detail)})` : ""}`,
  };
  function nameOrLink(f) {
    return f.individual_id
      ? personLink({ id: f.individual_id, name: f.individual })
      : esc(f.individual);
  }
  $("#dash-feed").innerHTML = d.feed.map((f) => {
    const line = (FEED_TR[f.action] || ((x) => `${esc(x.user)} · ${esc(x.action)}`))(f);
    return `<li>${line} <span class="ago">${esc(fmtAgo(f.at))}</span></li>`;
  }).join("") || '<li class="muted">Henüz bir hareket yok — ilk haberi sen oluştur!</li>';

  // Veri sağlığı
  const h = d.health;
  const issues = h.issues.filter((i) => i.count > 0);
  $("#dash-health").innerHTML = `
    <div class="health-bar" title="Ad, doğum tarihi ve cinsiyet alanlarının doluluk oranı">
      <div class="fill" style="width:${h.completeness}%"></div>
      <span>%${h.completeness} tamam</span>
    </div>
    ${issues.map((i) => `<div class="health-issue">
       <b>${i.count}</b> ${esc(i.label.toLowerCase())}
       ${i.people.length ? `<div class="chips">${i.people.map((p) =>
         `<span class="chip" data-person="${p.id}">${esc(p.name)}</span>`).join("")}
         ${i.count > i.people.length ? `<span class="muted">+${i.count - i.people.length} kişi daha</span>` : ""}</div>` : ""}
     </div>`).join("") || '<p class="muted">Harika — belirgin bir eksik yok! 🎉</p>'}`;
}

// Dashboard içindeki kişi bağlantıları ve kutu navigasyonu
$("#tab-home").addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) {
    const target = nav.dataset.nav;
    if (target === "people") { switchTab("people"); updateHash({ tab: "people" }); }
    else if (target.startsWith("list:")) openListPage(target.slice(5));
    return;
  }
  const el = e.target.closest("[data-person]");
  if (!el) return;
  e.preventDefault();
  switchTab("people");
  selectPerson(Number(el.dataset.person));
});

/* ---- DNA eşleşmeleri ---- */
const dnaState = { offset: 0, limit: 25, total: 0 };

async function openDna() {
  switchTab("dna");
  updateHash({ tab: "dna" });
  if (!$("#dna-prev").dataset.wired) {
    $("#dna-prev").dataset.wired = "1";
    $("#dna-prev").addEventListener("click", () => {
      dnaState.offset = Math.max(0, dnaState.offset - dnaState.limit); loadDna();
    });
    $("#dna-next").addEventListener("click", () => {
      if (dnaState.offset + dnaState.limit < dnaState.total) {
        dnaState.offset += dnaState.limit; loadDna();
      }
    });
  }
  loadDna();
}

async function loadDna() {
  const d = await api(`/api/dna?offset=${dnaState.offset}&limit=${dnaState.limit}`);
  dnaState.total = d.total;
  $("#dna-count").textContent = `${d.total} eşleşme`;
  if (!d.items.length) {
    $("#dna-list").innerHTML = '<p class="muted">Henüz DNA eşleşmesi çekilmedi.</p>';
  } else {
    $("#dna-list").innerHTML = `<table class="dna-table">
      <tr><th></th><th>İsim</th><th>Akrabalık</th><th>Paylaşılan DNA</th><th>Bölüm</th>
        <th>En büyük</th><th>Ülke</th><th>Ağaç</th><th>Smart</th></tr>
      ${d.items.map((m) => `<tr class="dna-row" data-id="${m.id}">
        <td title="${m.has_detail ? "Detay çekildi" : "Detay yok"}">${m.has_detail ? "📄" : ""}</td>
        <td><span class="sex-dot ${esc(m.gender)}"></span> ${esc(m.name)}
          ${m.linked ? `<div class="dna-link-ind">🔗 ${esc(m.linked.name)}</div>` : ""}
          ${m.manager ? `<div class="dna-mgr">yön: ${esc(m.manager)}</div>` : ""}</td>
        <td>${esc(m.relationship)}</td>
        <td><b>${esc(m.shared_cm)}</b> cM${m.match_quality_pct ? ` <span class="muted">(${esc(m.match_quality_pct)}%)</span>` : ""}</td>
        <td>${esc(m.shared_segments)}</td>
        <td>${esc(m.largest_segment_cm)} cM</td>
        <td>${esc(m.country)}</td>
        <td>${esc(m.tree_size)}</td>
        <td>${esc(m.smart_matches)}</td>
      </tr>`).join("")}
    </table>`;
    $$("#dna-list .dna-row").forEach((r) =>
      r.addEventListener("click", () => openDnaDetail(Number(r.dataset.id))));
  }
  if (d.undetailed !== undefined) {
    $("#dna-count").textContent = `${d.total} eşleşme · ${d.total - d.undetailed} detaylı`;
  }
  const from = d.total ? dnaState.offset + 1 : 0;
  const to = Math.min(dnaState.offset + dnaState.limit, d.total);
  $("#dna-page-info").textContent = `${from}–${to} / ${d.total}`;
  $("#dna-prev").disabled = dnaState.offset === 0;
  $("#dna-next").disabled = to >= d.total;
}

// Eşleşme detay popup'ı: özet + yakalanan detay bölümleri (ham JSON, katlanır).
const DNA_SECTION_TR = {
  dna_single_match_get_shared_segments: "Paylaşılan segmentler (kromozom)",
  dna_single_match_get_shared_matches: "Ortak DNA eşleşmeleri",
  dna_single_match_get_shared_surnames: "Ortak soyadlar",
  dna_single_match_get_shared_ancestral_places: "Ortak ata mekânları",
  dna_single_match_get_theories_of_family_relativity: "Theory of Family Relativity",
  dna_single_match_get_shared_smart_matches: "Ortak Smart Match'ler",
  dna_single_match_get_kit_pedigree_chart: "Senin soyağacın (kit)",
  dna_single_match_get_other_kit_pedigree_chart: "Eşleşmenin soyağacı",
  dna_single_match_get_matches_count: "Eşleşme sayıları",
  fetch_dna_match_notes_and_labels: "Notlar ve etiketler",
};
// Arayüzde gösterilmeyecek alakasız uçlar
const DNA_SKIP_SECTIONS = new Set(["get_shopping_cart_query"]);

async function openDnaDetail(id) {
  const m = await api("/api/dna/" + id);
  let ov = $("#dna-detail");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "dna-detail";
    ov.className = "modal-backdrop hidden";
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.add("hidden"); });
  }
  const summary = [
    ["Akrabalık", m.relationship], ["Paylaşılan DNA", `${m.shared_cm} cM (${m.match_quality_pct}%)`],
    ["Paylaşılan bölüm", m.shared_segments], ["En büyük parça", `${m.largest_segment_cm} cM`],
    ["Yaş", m.age], ["Ülke", m.country], ["Ağaç boyu", m.tree_size],
    ["Smart Match", m.smart_matches], ["Yöneten", m.manager],
  ].filter(([, v]) => (v || "").toString().trim() && v !== " cM (%)")
    .map(([k, v]) => `<div class="field"><span class="k">${esc(k)}</span><div>${esc(v)}</div></div>`).join("");

  let sections = '<p class="muted">Detay henüz çekilmedi. (Crawler: dna_detail_crawler.py)</p>';
  const eps = m.detail && m.detail.endpoints;
  if (eps) {
    sections = Object.entries(eps).filter(([key]) => !DNA_SKIP_SECTIONS.has(key))
      .map(([key, val]) => `<details class="dna-section">
      <summary>${esc(DNA_SECTION_TR[key] || key)}</summary>
      <pre>${esc(JSON.stringify(val, null, 1).slice(0, 40000))}</pre>
    </details>`).join("");
    const dom = m.detail.dom || {};
    if (dom.full_text) {
      sections += `<details class="dna-section"><summary>Sayfa metni (ham)</summary>
        <pre>${esc((dom.full_text || "").slice(0, 6000))}</pre></details>`;
    }
  }
  ov.innerHTML = `<div class="emblem-modal dna-modal">
    <div class="modal-head"><h2>🧬 ${esc(m.name)}</h2><button class="ghost" data-dd-close>✕</button></div>
    <div class="modal-body">
      <div class="detail-grid">${summary}</div>
      <div class="dna-analysis-box"><h3 class="dna-sec-title">🔎 Analiz</h3>
        <div id="dna-analysis" class="muted">Yükleniyor…</div></div>
      <div class="dna-link-box"><h3 class="dna-sec-title">Ağaçtaki yeri</h3>
        <div id="dna-link-body"></div></div>
      <h3 class="dna-sec-title">Detaylar ${m.detail_at ? `<span class="muted">(${esc(fmtAgo(m.detail_at))})</span>` : ""}</h3>
      ${sections}
    </div>
  </div>`;
  ov.querySelector("[data-dd-close]").addEventListener("click", () => ov.classList.add("hidden"));
  renderDnaAnalysis(m);
  renderDnaLink(m);
  ov.classList.remove("hidden");
}

function gotoPersonFromDna(pid) {
  $("#dna-detail").classList.add("hidden");
  switchTab("people"); selectPerson(pid);
}

async function renderDnaAnalysis(m) {
  const box = $("#dna-analysis");
  if (!box) return;
  let a;
  try { a = await api(`/api/dna/${m.id}/analysis`); }
  catch (_) { box.textContent = "Analiz yüklenemedi."; return; }
  if (!a.available) { box.innerHTML = '<span class="muted">Analiz için detay çekilmeli.</span>'; return; }
  box.className = "";
  const sideCls = a.side === "paternal" ? "side-p" : a.side === "maternal" ? "side-m" : "side-u";
  const chip = (x) => x.individual_id
    ? `<span class="chip an-mrca" data-goto-person="${x.individual_id}">${esc(x.name)} <span class="muted">${esc(x.position)}</span></span>`
    : `<span class="chip an-mrca off">${esc(x.name)} <span class="muted">${esc(x.position)}</span></span>`;
  const mrcaHtml = a.mrca.length ? a.mrca.map(chip).join("")
    : '<span class="muted">Ağaçta doğrudan ortak ata bulunamadı.</span>';
  const names = a.mrca.filter((x) => x.individual_id).map((x) => x.name.replace(/\(.*?\)/g, "").trim());
  const place = a.side === "unknown"
    ? `Taraf belirlenemedi; ~${a.mrca_generation || "?"}. nesil ata bölgesi.`
    : `Bu kişi ${a.side_tr.toLowerCase()}ndan geliyor. ${names.length
        ? `Olası ortak ata: <b>${esc(names.join(" & "))}</b> — ${esc(m.name)} muhtemelen onların soyundan.`
        : `Ortak ata ~${a.mrca_generation || "?"}. nesilde.`}`;
  // Bağımsız pedigree kesişimi
  let indep = "";
  if (a.tree_overlap_count) {
    const chips = a.tree_overlap.map((x) =>
      `<span class="chip an-mrca" data-goto-person="${x.individual_id}">${esc(x.name)}</span>`).join("");
    const selfNote = a.self_in_tree
      ? `<div class="an-self">✔ Bu eşleşme ağacımızda zaten var: <b>${esc(a.self_in_tree.name)}</b></div>` : "";
    indep = `<div class="an-indep">
      <div class="an-label">🌳 Bizim ağaç kesişimi (bağımsız): eşleşmenin ağacındaki ${a.pedigree_names} kişiden
        <b>${a.tree_overlap_count}</b>'i bizim ağaçta</div>
      ${selfNote}
      <div class="rel-chips">${chips}</div></div>`;
  } else {
    indep = `<div class="an-indep muted">🌳 Bizim ağaç kesişimi: eşleşmenin ağacında (${a.pedigree_names || 0} kişi)
      bizim ağaçla örtüşen kişi yok — bağımsız yerleştirilemez.</div>`;
  }
  box.innerHTML = `
    <div class="an-row"><span class="side-badge ${sideCls}">${esc(a.side_tr)}</span>
      <span class="muted">Güven: ${esc(a.confidence)}${a.has_theory ? " · ToFR ✓" : ""} · tahmini ~${a.mrca_generation || "?"}. nesil</span></div>
    <div class="an-label">MyHeritage'a göre olası ortak ata (MRCA):</div>
    <div class="rel-chips">${mrcaHtml}</div>
    <div class="an-place">${place}</div>
    ${indep}`;
  $$("#dna-analysis [data-goto-person]").forEach((c) =>
    c.addEventListener("click", () => gotoPersonFromDna(Number(c.dataset.gotoPerson))));
}

async function relinkDna(matchId, individualId) {
  await api(`/api/dna/${matchId}/link`, { method: "POST", json: { individual_id: individualId } });
  toast(individualId ? "Ağaca bağlandı" : "Bağlantı kaldırıldı");
  openDnaDetail(matchId);
  loadDna();
}

async function renderDnaLink(m) {
  const box = $("#dna-link-body");
  if (!box) return;
  if (m.linked) {
    box.innerHTML = `<div class="dna-linked">
      <span class="chip" data-goto-person="${m.linked.id}">🔗 ${esc(m.linked.name)}
        ${m.linked.birth_date ? `<span class="muted">(${esc(trDate(m.linked.birth_date))})</span>` : ""}</span>
      ${canEdit() ? `<button class="small ghost" id="dna-unlink">Bağlantıyı kaldır</button>` : ""}
    </div>`;
    box.querySelector("[data-goto-person]").addEventListener("click", () => {
      $("#dna-detail").classList.add("hidden");
      switchTab("people"); selectPerson(m.linked.id);
    });
    if (canEdit()) $("#dna-unlink").addEventListener("click", () => relinkDna(m.id, null));
    return;
  }
  if (!canEdit()) { box.innerHTML = '<span class="muted">Bağlı değil.</span>'; return; }
  box.innerHTML = '<div id="dna-sugg" class="dna-sugg muted">Öneriler yükleniyor…</div><div id="dna-picker"></div>';
  // Otomatik öneriler
  try {
    const s = await api(`/api/dna/${m.id}/suggestions`);
    $("#dna-sugg").className = "dna-sugg";
    $("#dna-sugg").innerHTML = s.items.length
      ? `<span class="muted">Öneri:</span> ` + s.items.map((p) =>
          `<button class="chip dna-sugg-chip" data-id="${p.id}">${esc(p.name)}
            ${p.birth_date ? `<span class="muted">${esc(trDate(p.birth_date))}</span>` : ""}</button>`).join("")
      : '<span class="muted">İsim eşleşen kişi bulunamadı.</span>';
    $$("#dna-sugg .dna-sugg-chip").forEach((b) =>
      b.addEventListener("click", () => relinkDna(m.id, Number(b.dataset.id))));
  } catch (_) { $("#dna-sugg").textContent = ""; }
  // Manuel arama
  const picker = createPersonPicker({ placeholder: "Ağaçta kişi ara ve bağla…" });
  const btn = document.createElement("button");
  btn.className = "small"; btn.textContent = "Bağla";
  btn.addEventListener("click", () => {
    const id = picker.getId();
    if (!id) return toast("Önce kişi seçin", true);
    relinkDna(m.id, id);
  });
  const wrap = $("#dna-picker");
  wrap.className = "inline-form";
  wrap.append(picker.el, btn);
}

/* ---- Toplu işlemler ---- */
let bulkData = null, bulkPick = null;

async function openBulk() {
  switchTab("bulk");
  updateHash({ tab: "bulk" });
  if (!bulkData) {
    try { bulkData = await api("/api/bulk/list"); }
    catch (_) { toast("Liste yüklenemedi", true); return; }
    ["#bulk-filter", "#bulk-group"].forEach((s) =>
      $(s).addEventListener("change", renderBulk));
    ["#bulk-ymin", "#bulk-ymax"].forEach((s) =>
      $(s).addEventListener("input", renderBulk));
    $("#bulk-all").addEventListener("change", (e) =>
      $$("#bulk-list .bulk-chk").forEach((c) => { c.checked = e.target.checked; }));
    $("#bulk-action").addEventListener("change", renderBulkValue);
    $("#bulk-apply").addEventListener("click", applyBulk);
  }
  renderBulk();
}

function bulkFiltered() {
  const f = $("#bulk-filter").value;
  const ymin = Number($("#bulk-ymin").value) || null;
  const ymax = Number($("#bulk-ymax").value) || null;
  const t = bulkData.this_year;
  return bulkData.people.filter((p) => {
    if (f === "over100_alive" && !(p.alive && p.birth_year && t - p.birth_year > 100)) return false;
    if (f === "no_birth_place" && (p.birth_place || "").trim()) return false;
    if (f === "no_birth_date" && (p.birth_date || "").trim()) return false;
    if (f === "no_birth_coord" && p.has_birth_coord) return false;
    if (f === "est_death" && !(p.death_date || "").trim().toUpperCase().startsWith("EST")) return false;
    if (ymin && !(p.birth_year && p.birth_year >= ymin)) return false;
    if (ymax && !(p.birth_year && p.birth_year <= ymax)) return false;
    return true;
  });
}

function bulkGroups(people) {
  const g = $("#bulk-group").value;
  if (g === "none") return [["", people]];
  const map = new Map();
  people.forEach((p) => {
    let keys = [""];
    if (g === "family") keys = p.families.length ? p.families : ["(kolsuz)"];
    else if (g === "last_name") keys = [p.last_name || "(soyadsız)"];
    else if (g === "birth_place") keys = [(p.birth_place || "").split("/")[0].trim() || "(yer yok)"];
    else if (g === "decade") keys = [p.birth_year ? `${Math.floor(p.birth_year / 10) * 10}'lar` : "(yıl yok)"];
    keys.forEach((k) => { if (!map.has(k)) map.set(k, []); map.get(k).push(p); });
  });
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

function bulkRow(p) {
  const bits = [p.birth_year || "?", (p.birth_place || "").split("/")[0]].filter(Boolean).join(" · ");
  const est = (p.death_date || "").trim().toUpperCase().startsWith("EST");
  const flags = [!p.alive ? (est ? "tah. vefat" : "") : (p.age && p.age > 100 ? `⚠ ${p.age} yaş` : ""),
    !p.has_birth_coord && (p.birth_place || "").trim() ? "📍yok" : ""].filter(Boolean).join(" ");
  return `<label class="bulk-row">
    <input type="checkbox" class="bulk-chk" value="${p.id}" />
    <span class="sex-dot ${esc(p.sex)}"></span>
    <span class="bulk-name">${esc(p.name)}</span>
    <span class="bulk-sub">${esc(bits)}</span>
    <span class="bulk-flags">${esc(flags)}</span>
  </label>`;
}

function renderBulk() {
  const people = bulkFiltered();
  $("#bulk-count").textContent = `${people.length} kişi`;
  $("#bulk-all").checked = false;
  const groups = bulkGroups(people);
  $("#bulk-list").innerHTML = groups.map(([title, ppl]) => `
    <div class="bulk-group">
      ${title ? `<div class="bulk-group-head">
        <label><input type="checkbox" class="bulk-group-all" /> <b>${esc(title)}</b> (${ppl.length})</label>
      </div>` : ""}
      ${ppl.map(bulkRow).join("")}
    </div>`).join("") || '<p class="muted">Bu filtreye uyan kişi yok.</p>';
  $$("#bulk-list .bulk-group-all").forEach((c) =>
    c.addEventListener("change", (e) =>
      e.target.closest(".bulk-group").querySelectorAll(".bulk-chk")
        .forEach((chk) => { chk.checked = e.target.checked; })));
}

function renderBulkValue() {
  const action = $("#bulk-action").value;
  const wrap = $("#bulk-value-wrap");
  bulkPick = null;
  if (action === "birth_place") {
    wrap.innerHTML = `<input type="text" id="bulk-value" placeholder="Doğum yeri (seç)" autocomplete="off" />`;
    attachPlaceAutocomplete($("#bulk-value"), (pk) => { bulkPick = pk; });
  } else if (action === "estimate_death") {
    wrap.innerHTML = `<input type="number" id="bulk-value" value="100" title="Varsayılan vefat yaşı" style="width:90px" /> <span class="muted">yaşında (tahmini/EST)</span>`;
  } else if (action === "add_family") {
    wrap.innerHTML = `<input type="text" id="bulk-value" placeholder="Aile kolu adı" />`;
  } else if (action) {
    const ph = { death_date: "Ölüm tarihi", death_place: "Ölüm yeri", occupation: "Meslek" }[action];
    wrap.innerHTML = `<input type="text" id="bulk-value" placeholder="${ph}" />`;
  } else {
    wrap.innerHTML = "";
  }
}

async function applyBulk() {
  const action = $("#bulk-action").value;
  if (!action) return toast("Bir toplu işlem seçin", true);
  const ids = $$("#bulk-list .bulk-chk:checked").map((c) => Number(c.value));
  if (!ids.length) return toast("Kişi seçin", true);
  const val = ($("#bulk-value")?.value || "").trim();
  if (!val) return toast("Bir değer girin", true);

  const body = { ids };
  if (action === "add_family") body.add_family = val;
  else if (action === "estimate_death") body.estimate_death_age = Number(val) || 100;
  else if (action === "birth_place") {
    body.set = { birth_place: val };
    if (bulkPick) { body.set.birth_lat = bulkPick.lat; body.set.birth_lng = bulkPick.lon; }
  } else {
    body.set = { [action]: val };
  }
  if (!confirm(`${ids.length} kişiye uygulansın mı?`)) return;
  const r = await api("/api/bulk/update", { method: "POST", json: body });
  toast(`${r.updated} kişi güncellendi`);
  bulkData = await api("/api/bulk/list"); // tazele
  renderBulk();
}

/* ---- Ağaçtan hızlı düzenleme popup'ı ---- */
async function openQuickEdit(id) {
  let p;
  try { p = await api("/api/individuals/" + id); }
  catch (_) { return toast("Kişi yüklenemedi", true); }

  let ov = $("#quick-edit");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "quick-edit";
    ov.className = "modal-backdrop hidden";
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.add("hidden"); });
  }
  const sexOpt = (v, l) => `<option value="${v}" ${p.sex === v ? "selected" : ""}>${l}</option>`;
  ov.innerHTML = `<div class="qe-modal">
    <div class="modal-head"><h2>Hızlı Düzenle</h2><button class="ghost" data-qe-close>✕</button></div>
    <div class="qe-body">
      <div class="detail-grid">
        <label>Ad<input id="qe-first" value="${esc(p.first_name || "")}" /></label>
        <label>Soyad<input id="qe-last" value="${esc(p.last_name || "")}" /></label>
        <label>Cinsiyet<select id="qe-sex">
          ${sexOpt("U", "Bilinmiyor")}${sexOpt("M", "Erkek")}${sexOpt("F", "Kadın")}
        </select></label>
        <label>Doğum tarihi<input id="qe-bd" value="${esc(p.birth_date || "")}" /></label>
        <label>Doğum yeri<input id="qe-bp" value="${esc(p.birth_place || "")}" data-place="birth" autocomplete="off" /></label>
        <label>Ölüm tarihi<input id="qe-dd" value="${esc(p.death_date || "")}" /></label>
        <label>Ölüm yeri<input id="qe-dp" value="${esc(p.death_place || "")}" /></label>
      </div>
      <input type="hidden" id="qe-blat" value="${p.birth_lat ?? ""}" />
      <input type="hidden" id="qe-blng" value="${p.birth_lng ?? ""}" />
      <div class="detail-actions" style="margin-top:0.8rem">
        <button data-qe-save>Kaydet</button>
        <button class="ghost" data-qe-close>Vazgeç</button>
        <a class="qe-full" href="#tab=people&person=${id}&edit=1" target="_blank" rel="noopener">Tüm alanlar →</a>
      </div>
    </div>
  </div>`;
  ov.querySelectorAll("[data-qe-close]").forEach((b) =>
    b.addEventListener("click", () => ov.classList.add("hidden")));
  attachPlaceAutocomplete($("#qe-bp"), (pick) => {
    $("#qe-blat").value = pick ? pick.lat : "";
    $("#qe-blng").value = pick ? pick.lon : "";
  });
  ov.querySelector("[data-qe-save]").addEventListener("click", async () => {
    const blat = $("#qe-blat").value, blng = $("#qe-blng").value;
    const payload = {
      first_name: $("#qe-first").value.trim(),
      last_name: $("#qe-last").value.trim(),
      sex: $("#qe-sex").value,
      birth_date: $("#qe-bd").value.trim(),
      birth_place: $("#qe-bp").value.trim(),
      death_date: $("#qe-dd").value.trim(),
      death_place: $("#qe-dp").value.trim(),
      birth_lat: blat === "" ? null : Number(blat),
      birth_lng: blng === "" ? null : Number(blng),
    };
    try {
      await api("/api/individuals/" + id, { method: "PATCH", json: payload });
      ov.classList.add("hidden");
      toast("Kaydedildi");
      await loadPeople();      // liste/etiketler tazelensin
      if (state.treeRootId) renderTree(); // ağacı güncelle
    } catch (err) { toast(err.message, true); }
  });
  ov.classList.remove("hidden");
}

/* ---- Zaman bazlı coğrafi harita ---- */
let mapObj = null, mapLayer = null, mapData = null, mapPlayTimer = null;

async function openMap() {
  switchTab("map");
  updateHash({ tab: "map" });
  if (!mapObj) {
    mapObj = L.map("map-canvas", { scrollWheelZoom: true }).setView([39.5, 35.0], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "© OpenStreetMap",
    }).addTo(mapObj);
    mapLayer = L.layerGroup().addTo(mapObj);
  }
  setTimeout(() => mapObj.invalidateSize(), 100); // sekme görünür olunca boyutlan
  if (!mapData) {
    try { mapData = await api("/api/map/timeline"); }
    catch (_) { toast("Harita verisi yüklenemedi", true); return; }
    const slider = $("#map-year");
    slider.min = mapData.min_year;
    slider.max = mapData.max_year;
    slider.value = mapData.max_year;
    slider.addEventListener("input", () => drawMapYear(Number(slider.value)));
    $("#map-play").addEventListener("click", toggleMapPlay);
    // Aile seçici
    const famSel = $("#map-family");
    famSel.innerHTML = '<option value="">Tüm aileler</option>' +
      (mapData.families || []).map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
    famSel.addEventListener("change", () => drawMapYear(Number($("#map-year").value)));
    const un = mapData.unresolved || [];
    $("#map-unresolved").textContent = un.length
      ? `Haritaya konulamayan ${un.length} yer (il tanınmadı): ${un.slice(0, 12).join(", ")}${un.length > 12 ? "…" : ""}`
      : "";
  }
  drawMapYear(Number($("#map-year").value));
}

function mapFamilyById(id) {
  return (mapData.families || []).find((f) => f.id === id) || null;
}

// Belirli bir yılda kişiyi konumlandır: o yılı kapsayan "stay".
function stayAt(person, year) {
  for (const s of person.stays) {
    if (year >= s.from && year <= s.to) return s;
  }
  return null;
}

// Kişiye göre küçük sabit sapma (aynı ildeki noktalar üst üste binmesin).
function jitter(id) {
  const a = (id * 2654435761) % 1000 / 1000;
  const b = (id * 40503) % 1000 / 1000;
  return [(a - 0.5) * 0.5, (b - 0.5) * 0.5];
}

function personPopup(p) {
  const edit = canEdit()
    ? ` · <a href="#tab=people&person=${p.id}&edit=1" target="_blank" rel="noopener">✏️ Düzenle</a>` : "";
  return `<b>${esc(p.name)}</b><br>
    <a href="#tab=people&person=${p.id}" target="_blank" rel="noopener">Profili aç</a>${edit}`;
}

function drawMapYear(year) {
  if (!mapData || !mapLayer) return;
  mapLayer.clearLayers();
  const famId = Number($("#map-family").value) || null;
  const fam = famId ? mapFamilyById(famId) : null;

  // O yıl görünür kişiler (+ konumları)
  const visible = [];
  mapData.people.forEach((p) => {
    if (famId && !(p.families || []).includes(famId)) return;
    if (p.birth_year && year < p.birth_year) return;
    if (p.death_year && year > p.death_year) return;
    const s = stayAt(p, year);
    if (s) visible.push({ p, lat: s.lat, lng: s.lng });
  });

  if (fam && fam.emblem) {
    // Belli aile: aynı bölgedeki kişileri topla, o noktaya aile armasını koy.
    const clusters = new Map();
    visible.forEach((v) => {
      const key = `${v.lat.toFixed(1)},${v.lng.toFixed(1)}`;
      if (!clusters.has(key)) clusters.set(key, { lat: v.lat, lng: v.lng, people: [] });
      clusters.get(key).people.push(v.p);
    });
    clusters.forEach((c) => {
      const html = `<div class="em-mark">${emblemSvg(fam.emblem)}${
        c.people.length > 1 ? `<span class="em-badge">${c.people.length}</span>` : ""}</div>`;
      const icon = L.divIcon({ className: "emblem-marker", html, iconSize: [38, 38], iconAnchor: [19, 19] });
      const popup = `<b>${esc(fam.name)}</b> — ${c.people.length} kişi<br>` +
        c.people.map(personPopup).join("<hr style='margin:4px 0'>");
      L.marker([c.lat, c.lng], { icon }).bindPopup(popup).addTo(mapLayer);
    });
  } else {
    // Tüm aileler ya da armasız aile: kişi başına nokta.
    visible.forEach((v) => {
      const [dy, dx] = jitter(v.p.id);
      const color = v.p.sex === "M" ? "#5b9bd1" : v.p.sex === "F" ? "#dd8ba1" : "#8a8577";
      L.circleMarker([v.lat + dy, v.lng + dx], {
        radius: 5, color: "#fff", weight: 1, fillColor: color, fillOpacity: 0.85,
      }).bindPopup(personPopup(v.p)).addTo(mapLayer);
    });
  }
  $("#map-year-label").textContent = year;
  $("#map-count").textContent = `${visible.length} kişi`;
}

function toggleMapPlay() {
  const btn = $("#map-play");
  if (mapPlayTimer) {
    clearInterval(mapPlayTimer); mapPlayTimer = null; btn.textContent = "▶"; return;
  }
  btn.textContent = "⏸";
  const slider = $("#map-year");
  if (Number(slider.value) >= Number(slider.max)) slider.value = slider.min;
  mapPlayTimer = setInterval(() => {
    let y = Number(slider.value);
    if (y >= Number(slider.max)) { clearInterval(mapPlayTimer); mapPlayTimer = null; btn.textContent = "▶"; return; }
    slider.value = y + 1;
    drawMapYear(y + 1);
  }, 350);
}

/* ---- Aile armaları (Türk-İslam motifleri) ---- */
// Tümü currentColor kullanır; tema rengine uyar. viewBox 0 0 100 100.
const EMBLEMS = {
  hilal: { name: "Hilal", svg: `<path d="M64 15a35 35 0 1 0 0 70 28 28 0 0 1 0-70z"/>` },
  ayyildiz: { name: "Ay-Yıldız", svg: `<path d="M58 15a35 35 0 1 0 0 70 28 28 0 0 1 0-70z"/><path d="M76 38l4 11 11 .3-8.8 6.7 3.2 10.6L77 70l-8.6 6.6 3.2-10.6L62.6 59l11-.3z"/>` },
  selcuklu: { name: "Selçuklu Yıldızı", svg: `<g fill="none" stroke="currentColor" stroke-width="6"><rect x="26" y="26" width="48" height="48"/><rect x="26" y="26" width="48" height="48" transform="rotate(45 50 50)"/></g>` },
  rubelhizb: { name: "Rub'el Hizb", svg: `<rect x="28" y="28" width="44" height="44"/><rect x="28" y="28" width="44" height="44" transform="rotate(45 50 50)"/><circle cx="50" cy="50" r="7" fill="var(--panel,#fff)"/>` },
  lale: { name: "Lale", svg: `<path d="M50 88c0-14-2-30-2-30M50 58c-10 0-18-10-18-24 6 4 12 4 18 10 6-6 12-6 18-10 0 14-8 24-18 24z"/><path d="M32 34c-2 10 4 20 18 24 14-4 20-14 18-24" fill="none" stroke="currentColor" stroke-width="4"/>` },
  yildiz8: { name: "Sekiz Köşeli Yıldız", svg: `<path d="M50 10l9 22 22-9-9 22 22 9-22 9 9 22-22-9-9 22-9-22-22 9 9-22-22-9 22-9-9-22 22 9z"/>` },
  kilic: { name: "Çapraz Kılıç", svg: `<g stroke="currentColor" stroke-width="6" fill="none" stroke-linecap="round"><path d="M25 78L72 26"/><path d="M75 78L28 26"/></g><path d="M50 52l6 6-6 6-6-6z"/>` },
  gul: { name: "Gül", svg: `<g fill="none" stroke="currentColor" stroke-width="5"><circle cx="50" cy="50" r="10"/><circle cx="50" cy="30" r="12"/><circle cx="50" cy="70" r="12"/><circle cx="30" cy="50" r="12"/><circle cx="70" cy="50" r="12"/></g>` },
  servi: { name: "Servi Ağacı", svg: `<path d="M50 12c-10 14-14 30-14 46 0 12 4 20 14 26 10-6 14-14 14-26 0-16-4-32-14-46z"/><rect x="46" y="80" width="8" height="10"/>` },
  kubbe: { name: "Kubbe ve Hilal", svg: `<path d="M50 20c14 0 24 14 24 30H26c0-16 10-30 24-30z"/><rect x="26" y="52" width="48" height="30"/><path d="M50 6a10 10 0 1 0 0 14 8 8 0 0 1 0-14z"/>` },
  pusula: { name: "Yıldız Pusula", svg: `<path d="M50 8l8 34 34 8-34 8-8 34-8-34-34-8 34-8z" opacity=".85"/><circle cx="50" cy="50" r="6" fill="var(--panel,#fff)"/>` },
  kartal: { name: "Çift Başlı Kartal", svg: `<path d="M50 40c-6-10-16-16-28-16 4 8 2 14-4 18 8 2 12 6 12 14 0 10 8 18 20 22 12-4 20-12 20-22 0-8 4-12 12-14-6-4-8-10-4-18-12 0-22 6-28 16z"/><circle cx="34" cy="30" r="3"/><circle cx="66" cy="30" r="3"/>` },
};
const EMBLEM_DEFAULT = `<path d="M50 12l30 10v24c0 22-14 34-30 42-16-8-30-20-30-42V22z" fill="none" stroke="currentColor" stroke-width="4" opacity=".4"/>`;

function emblemSvg(key, cls = "") {
  // Özel yüklenmiş görsel: "custom:<dosya>"
  if (typeof key === "string" && key.startsWith("custom:")) {
    const file = key.slice(7);
    return `<img class="emblem emblem-img ${cls}" src="/uploads/${esc(file)}" alt="arma" />`;
  }
  const e = EMBLEMS[key];
  const inner = e ? e.svg : EMBLEM_DEFAULT;
  return `<svg class="emblem ${cls}" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">${inner}</svg>`;
}

/* ---- Aile kümeleri ---- */
async function openFamilies(focusId) {
  switchTab("families");
  updateHash(focusId ? { tab: "families", fam: focusId } : { tab: "families" });
  const box = $("#families-content");
  box.innerHTML = '<p class="muted">Yükleniyor…</p>';
  let d;
  try { d = await api("/api/families"); }
  catch (_) { box.innerHTML = '<p class="error">Yüklenemedi.</p>'; return; }
  if (!d.items.length) {
    box.innerHTML = '<p class="muted">Henüz aile kolu yok. Bir kişinin detayında "Aile Kolları"ndan ekleyebilirsiniz.</p>';
    return;
  }
  box.innerHTML = `<div class="fam-grid">${d.items.map((f) => `
    <div class="fam-card" data-fam="${f.id}">
      <span class="fam-emblem">${emblemSvg(f.emblem)}</span>
      <span class="fam-name">${esc(f.name)}</span>
      <span class="fam-count">${f.count} kişi</span>
      ${canEdit() ? `<div class="fam-card-actions">
        <button class="small ghost" data-emblem-for="${f.id}">Arma seç</button>
        <button class="small ghost" data-rename-for="${f.id}" data-name="${esc(f.name)}">Adı düzenle</button>
      </div>` : ""}
    </div>`).join("")}</div>
    <div id="fam-members"></div>`;
  box.querySelectorAll("[data-fam]").forEach((b) =>
    b.addEventListener("click", (e) => {
      if (e.target.closest("[data-emblem-for],[data-rename-for]")) return;
      showFamilyMembers(Number(b.dataset.fam));
    }));
  box.querySelectorAll("[data-emblem-for]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openEmblemPicker(Number(b.dataset.emblemFor));
    }));
  box.querySelectorAll("[data-rename-for]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = prompt("Aile kolunun yeni adı:", b.dataset.name);
      if (name === null) return;
      const trimmed = name.trim();
      if (!trimmed || trimmed === b.dataset.name) return;
      try {
        await api(`/api/families/${b.dataset.renameFor}`, { method: "PATCH", json: { name: trimmed } });
        toast("Ad güncellendi");
        openFamilies(Number(b.dataset.renameFor));
      } catch (err) { toast(err.message, true); }
    }));
  if (focusId) showFamilyMembers(focusId);
}

// Arma seçici overlay
function openEmblemPicker(familyId) {
  let ov = $("#emblem-picker");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "emblem-picker";
    ov.className = "modal-backdrop hidden";
    ov.innerHTML = `<div class="emblem-modal">
      <div class="modal-head"><h2>Arma Seç</h2><button id="emblem-close" class="ghost">✕</button></div>
      <div class="emblem-grid" id="emblem-grid"></div>
      <div class="emblem-upload">
        <label class="emblem-upload-label">📁 Kendi armanı yükle (PNG/JPG/SVG)
          <input type="file" id="emblem-file" accept="image/*,.svg" hidden />
        </label>
      </div>
    </div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.add("hidden"); });
    $("#emblem-close").addEventListener("click", () => ov.classList.add("hidden"));
  }
  ov.dataset.familyId = familyId;
  const grid = $("#emblem-grid");
  const cells = [`<button class="emblem-cell" data-key="">${emblemSvg("")}<span>Yok</span></button>`]
    .concat(Object.entries(EMBLEMS).map(([k, e]) =>
      `<button class="emblem-cell" data-key="${k}">${emblemSvg(k)}<span>${esc(e.name)}</span></button>`));
  grid.innerHTML = cells.join("");
  grid.querySelectorAll(".emblem-cell").forEach((c) =>
    c.addEventListener("click", async () => {
      await api(`/api/families/${ov.dataset.familyId}`, { method: "PATCH", json: { emblem: c.dataset.key } });
      ov.classList.add("hidden");
      toast("Arma güncellendi");
      openFamilies(Number(ov.dataset.familyId));
    }));
  const fileInput = $("#emblem-file");
  fileInput.value = "";
  fileInput.onchange = async () => {
    if (!fileInput.files.length) return;
    const fd = new FormData();
    fd.append("file", fileInput.files[0]);
    try {
      await api(`/api/families/${ov.dataset.familyId}/emblem-upload`, { method: "POST", body: fd });
      ov.classList.add("hidden");
      toast("Arma yüklendi");
      openFamilies(Number(ov.dataset.familyId));
    } catch (err) { toast(err.message, true); }
  };
  ov.classList.remove("hidden");
}

async function showFamilyMembers(id) {
  const box = $("#fam-members");
  box.querySelectorAll && box.classList.add("loading");
  const d = await api(`/api/families/${id}`);
  $$("#families-content [data-fam]").forEach((b) =>
    b.classList.toggle("active", Number(b.dataset.fam) === id));
  const kindTr = { tagged: "", inherited: "baba tarafı", marriage: "evlilik" };
  box.innerHTML = `<h2 class="fam-title"><span class="fam-emblem-lg">${emblemSvg(d.emblem)}</span> ${esc(d.name)} — ${d.members.length} kişi</h2>
    <p class="muted fam-legend">Etiketli · <span class="fam-kind">baba tarafı</span> (soydan) · <span class="fam-kind">evlilik</span></p>
    <div class="chips">${d.members.map((p) => {
      const t = kindTr[p.kind] ? ` <span class="fam-kind">${kindTr[p.kind]}</span>` : "";
      return `<span class="chip fam-chip ${esc(p.kind || "")}" data-person="${p.id}">${esc(p.name)}${t}</span>`;
    }).join("") || '<span class="muted">Üye yok</span>'}</div>`;
  box.querySelectorAll("[data-person]").forEach((el) =>
    el.addEventListener("click", () => { switchTab("people"); selectPerson(Number(el.dataset.person)); }));
}

/* ---- Liste sayfaları (evlilikler / anekdotlar / fotoğraflar) ---- */
async function openListPage(kind, item) {
  updateHash(item ? { tab: "list", kind, item } : { tab: "list", kind });
  switchTab("list");
  $("#list-title").textContent = "Yükleniyor…";
  $("#list-content").innerHTML = "";
  let d;
  try { d = await api(`/api/dashboard/list/${kind}`); }
  catch (_) { $("#list-content").innerHTML = '<p class="error">Liste yüklenemedi.</p>'; return; }
  $("#list-title").textContent = `${d.title} (${d.items.length})`;
  $("#list-content").innerHTML = renderList(kind, d.items, item);
  if (item) {
    const el = document.getElementById(`item-${item}`);
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); }
  }
}

function shareBtn(url) {
  return `<button class="small ghost share-btn" data-share="${esc(url)}" title="Bağlantıyı kopyala">🔗 Paylaş</button>`;
}

function renderList(kind, items, highlight) {
  if (!items.length) return '<p class="muted">Kayıt yok.</p>';
  if (kind === "marriages") {
    return `<ul class="page-list">${items.map((it) => {
      const info = [it.date && trDate(it.date), it.place].filter(Boolean).join(" · ");
      return `<li>💍 ${it.a ? personLink(it.a) : "?"} — ${it.b ? personLink(it.b) : "?"}
        ${info ? `<span class="muted">(${esc(info)})</span>` : ""}</li>`;
    }).join("")}</ul>`;
  }
  if (kind === "anecdotes") {
    return `<ul class="page-list">${items.map((it) => {
      const url = `${location.origin}${location.pathname}#tab=list&kind=anecdotes&item=${it.id}`;
      const hot = String(it.id) === String(highlight) ? " flash" : "";
      return `<li id="item-${it.id}" class="anec-item${hot}">
        <div class="anec-item-head">
          ${it.title ? `<b>${esc(it.title)}</b>` : `<b class="muted">Anekdot</b>`}
          ${it.person ? `— ${personLink(it.person)}` : ""}
          ${shareBtn(url)}
        </div>
        <div class="anec-text">${esc(it.text)}</div>
        <div class="muted anec-by">${esc(it.author || "")}${it.at ? " · " + fmtAgo(it.at) : ""}</div>
      </li>`;
    }).join("")}</ul>`;
  }
  if (kind === "photos") {
    return `<div class="photo-grid">${items.map((it) => `<a class="photo-cell" data-person="${it.id}" href="#tab=people&person=${it.id}">
      ${it.photo ? `<img src="${esc(it.photo)}" alt="${esc(it.name)}" />` : `<span class="ph">${esc(initials(it.name))}</span>`}
      <span class="pc-name">${esc(it.name)}</span></a>`).join("")}</div>`;
  }
  return "";
}

// Liste sayfası içi: kişi bağlantıları + paylaş butonu
$("#tab-list").addEventListener("click", async (e) => {
  const share = e.target.closest("[data-share]");
  if (share) {
    try {
      await navigator.clipboard.writeText(share.dataset.share);
      toast("Bağlantı kopyalandı");
    } catch (_) {
      window.prompt("Bağlantıyı kopyalayın:", share.dataset.share);
    }
    return;
  }
  const el = e.target.closest("[data-person]");
  if (!el) return;
  e.preventDefault();
  switchTab("people");
  selectPerson(Number(el.dataset.person));
});

/* ---------------- Build footer ---------------- */
fetch("/api/version")
  .then((r) => r.json())
  .then((v) => {
    $("#build-footer").textContent = `Sürüm ${v.version} · Yapı ${v.build}`;
    // GEDCOM içe aktarma kapalıysa sekmeyi tamamen gizle (yanlışlıkla ezmeye karşı).
    if (!v.gedcom_import) {
      document.querySelector('.tab[data-tab="import"]')?.classList.add("hidden");
      $("#tab-import")?.classList.add("import-off");
    }
  })
  .catch(() => {});

/* ---------------- Start ---------------- */
if (state.token) boot();
