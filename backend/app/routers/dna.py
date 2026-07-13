"""DNA eşleşmeleri: içe aktarma + listeleme + ağaca bağlama."""
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..activity import log_activity
from ..database import get_db
from ..models import DnaMatch, Individual, ParentChild, Spouse, User
from ..security import get_current_user, require_editor

router = APIRouter(prefix="/api/dna", tags=["dna"])

_TR = str.maketrans("çğıöşüâîûÇĞİÖŞÜÂÎÛI", "cgiosuaiucgiosuaiui")


def _norm(s: str) -> str:
    return " ".join(re.sub(r"\(.*?\)", " ", s or "").translate(_TR).lower().replace("̇", "").split())


def _person_brief(db: Session, ind: Individual) -> dict:
    return {
        "id": ind.id,
        "name": f"{ind.first_name} {ind.last_name}".strip() or "(isimsiz)",
        "birth_date": ind.birth_date,
        "sex": ind.sex,
    }


def _parse_tr_num(s: str) -> float | None:
    """'1.680,4' -> 1680.4 (TR: nokta binlik, virgül ondalık)."""
    s = (s or "").replace("‎", "").strip()
    if not s:
        return None
    s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


@router.post("/import")
def import_matches(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    """Crawler'dan gelen eşleşmeleri kaydeder. (kit, name, shared_cm) ile
    tekilleştirir; ham veri raw'da saklanır."""
    kit = (payload.get("kit") or "").strip()
    matches = payload.get("matches") or []
    imported = 0
    for mm in matches:
        name = (mm.get("name") or "").strip()
        if not name:
            continue
        cm = (mm.get("shared_cm") or "").strip()
        guid = (mm.get("match_guid") or "").strip()
        # Tekilleştirme: guid varsa onunla (kararlı), yoksa (kit,ad,cm).
        row = None
        if guid:
            row = db.scalar(select(DnaMatch).where(DnaMatch.match_guid == guid))
        if row is None:
            row = db.scalar(select(DnaMatch).where(
                DnaMatch.kit == kit, DnaMatch.name == name, DnaMatch.shared_cm == cm))
        new = row is None
        if new:
            row = DnaMatch(kit=kit, name=name, shared_cm=cm)
            db.add(row)
        row.name = name or row.name
        row.shared_cm = cm or row.shared_cm
        row.manager = mm.get("manager", "")
        row.relationship = mm.get("relationship", "")
        row.match_quality_pct = mm.get("match_quality_pct", "")
        scv = mm.get("shared_cm_val")
        row.shared_cm_val = float(scv) if isinstance(scv, (int, float)) else _parse_tr_num(cm)
        row.shared_segments = mm.get("shared_segments", "")
        row.largest_segment_cm = mm.get("largest_segment_cm", "")
        row.age = mm.get("age", "")
        row.country = mm.get("country", "")
        row.smart_matches = mm.get("smart_matches", "")
        row.tree_size = mm.get("tree_size", "")
        g = (mm.get("gender") or "").upper()
        gc = mm.get("gender_class", "") or ""
        row.gender = (g if g in ("F", "M")
                      else "F" if "gender_F" in gc else "M" if "gender_M" in gc else "U")
        if mm.get("detail_href"):
            row.detail_url = mm["detail_href"]
        if mm.get("match_guid"):
            row.match_guid = mm["match_guid"]
        row.raw = json.dumps(mm, ensure_ascii=False)
        imported += 1
    db.flush()
    total = db.scalar(select(func.count()).select_from(DnaMatch)) or 0
    if imported:
        log_activity(db, user, "dna_imported", None,
                     f"{imported} DNA eşleşmesi çekildi (toplam {total})")
    db.commit()
    return {"imported": imported, "total": total}


@router.post("/detail")
def save_detail(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    """Bir eşleşmenin detay JSON'unu (segmentler, ortak eşleşmeler vb.) saklar.
    match_guid veya id ile bulur."""
    detail = payload.get("detail")
    guid = (payload.get("match_guid") or "").strip()
    mid = payload.get("id")
    row = None
    if mid:
        row = db.get(DnaMatch, int(mid))
    elif guid:
        row = db.scalar(select(DnaMatch).where(DnaMatch.match_guid == guid))
    if row is None:
        return {"ok": False, "error": "Eşleşme bulunamadı"}
    row.detail_json = json.dumps(detail, ensure_ascii=False)
    row.detail_at = datetime.now(timezone.utc)
    row.tofr_side = _side_from_eps(detail.get("endpoints", {}) if isinstance(detail, dict) else {})
    if payload.get("detail_url"):
        row.detail_url = payload["detail_url"]
    log_activity(db, user, "dna_detail", None, f"{row.name} detayları çekildi")
    db.commit()
    return {"ok": True, "id": row.id, "name": row.name}


def _dig(o, *path):
    for k in path:
        if isinstance(o, dict):
            o = o.get(k)
        elif isinstance(o, list) and isinstance(k, int) and len(o) > k:
            o = o[k]
        else:
            return None
        if o is None:
            return None
    return o


def _side_from_eps(eps: dict) -> str:
    """ToFR description_with_side'dan taraf: paternal | maternal | ''."""
    tofr = _dig(eps, "dna_single_match_get_theories_of_family_relativity",
                "data", "dna_match", "theories", "data") or []
    for th in tofr:
        s = _norm(_dig(th, "relationship", "description_with_side") or "")
        if "baban" in s:
            return "paternal"
        if "annen" in s or "anneniz" in s:
            return "maternal"
    return ""


def _shared_names(eps: dict) -> list[str]:
    sm = _dig(eps, "dna_single_match_get_shared_matches",
              "data", "dna_match", "dna_shared_matches", "data") or []
    out = []
    for x in sm:
        nm = (x.get("shared_member") or x.get("shared_individual") or {}).get("name")
        if nm:
            out.append(nm)
    return out


def _first_norm(name: str) -> str:
    """Bir addan norm ilk ad(lar)ı: soyadı at, ilk 1-2 kelimeyi al.
    Türk soykütüğünde soyadı güvenilmez (1934 kanunu), kimlik ilk ad + baba/ana adı."""
    parts = _norm(name).split()
    if not parts:
        return ""
    # tek kelimeyse o; değilse son kelimeyi (muhtemel soyad) at
    return parts[0] if len(parts) == 1 else " ".join(parts[:-1]) if len(parts) == 2 else parts[0]


def _tree_index(db: Session):
    """Ağaç dizini. byname: norm(tam ad)->[Individual]; byfirst: norm(ilk ad)->[Individual]
    (soyadsız eşleştirme için); id->Individual; child_id->{parent_id}."""
    from collections import defaultdict
    byname = defaultdict(list)
    byfirst = defaultdict(list)
    id2ind = {}
    for p in db.scalars(select(Individual)).all():
        id2ind[p.id] = p
        keys = {_norm(f"{p.first_name} {p.last_name}")}
        if p.maiden_name:
            keys.add(_norm(f"{p.first_name} {p.maiden_name}"))
        for k in keys:
            if k:
                byname[k].append(p)
        fk = _norm(p.first_name)
        if fk:
            byfirst[fk].append(p)
    parents_ids = defaultdict(set)
    for r in db.scalars(select(ParentChild)).all():
        parents_ids[r.child_id].add(r.parent_id)
    return byname, parents_ids, id2ind, byfirst


def _tree_parent_firstnames(tid: int, parents_ids, id2ind) -> set:
    """Ağaçtaki kişinin ebeveynlerinin İLK adları (baba adı / ana adı)."""
    out = set()
    for pid in parents_ids.get(tid, ()):
        p = id2ind.get(pid)
        if p and _norm(p.first_name):
            out.add(_norm(p.first_name))
    return out


def _ped_first(ind: dict) -> str:
    """Pedigree bireyinin norm ilk adı."""
    return _norm(ind.get("first_name") or "") or _first_norm(ind.get("name") or "")


def _pedigree_individuals(eps: dict):
    """Eşleşmenin pedigree'sinden kök birey + {id:birey} + {aile:(koca,karı)}."""
    ai = _dig(eps, "dna_single_match_get_other_kit_pedigree_chart",
              "data", "dna_match", "other_dna_kit", "associated_individual")
    inds, fams = {}, {}

    def add(ind):
        if isinstance(ind, dict) and ind.get("id"):
            inds[ind["id"]] = ind
            for sf in ind.get("spouse_in_families") or []:
                fams[sf.get("id")] = ((sf.get("husband") or {}).get("id"),
                                      (sf.get("wife") or {}).get("id"))
    if ai:
        add(ai)
        for cf in _dig(ai, "close_family", "data") or []:
            add(cf.get("individual"))
    return ai, inds, fams


def _ped_parents(ind: dict, inds: dict, fams: dict) -> list:
    out = []
    if isinstance(ind, dict):
        for cf in ind.get("child_in_families") or []:
            fid = (cf.get("family") or {}).get("id") or cf.get("id")
            h, w = fams.get(fid, (None, None))
            for pid in (h, w):
                if pid and pid in inds:
                    out.append(inds[pid])
    return out


def _tree_overlap(eps: dict, byfirst, parents_ids, id2ind) -> list:
    """YAPISAL ağaç kesişimi — SOYADSIZ. Pedigree bireyinin İLK adı bizim ağaçtaki
    biriyle eşleşiyor VE en az bir ebeveyninin İLK adı (baba/ana adı) da eşleşiyorsa
    'güçlü'. Soyadı hiç kullanılmaz (1934 kanunu; eski atalarda yok/yanlış olabilir).
    İlk ad tek başına yetersiz (yaygın adlar) → ebeveyn adı korroborasyonu ŞART."""
    ai, inds, fams = _pedigree_individuals(eps)
    out, seen = [], set()
    for ind in inds.values():
        fn = _ped_first(ind)
        if not fn or fn == "bilinmiyor":
            continue
        cands = byfirst.get(fn)
        if not cands:
            continue
        ped_par = {_ped_first(p) for p in _ped_parents(ind, inds, fams)}
        ped_par.discard("")
        if not ped_par:
            continue  # ebeveyn adı yok -> korrobore edilemez, ele
        for T in cands:
            if T.id in seen:
                continue
            tpar = _tree_parent_firstnames(T.id, parents_ids, id2ind)
            matched = ped_par & tpar
            if not matched:
                continue  # ebeveyn ilk-adı eşleşmiyor -> ele (ilk ad tek başına yetersiz)
            seen.add(T.id)
            mp = [{"name": f"{id2ind[pid].first_name} {id2ind[pid].last_name}".strip(),
                   "individual_id": pid}
                  for pid in parents_ids.get(T.id, ())
                  if id2ind.get(pid) and _norm(id2ind[pid].first_name) in matched]
            out.append({
                "name": f"{T.first_name} {T.last_name}".strip(),
                "individual_id": T.id, "ped_name": ind.get("name"),
                "score": len(matched), "strong": True,
                "is_root": bool(ai) and ind.get("id") == ai.get("id"),
                "matched_parents": mp,
            })
    out.sort(key=lambda x: (-x["score"], not x["is_root"]))
    return out


def _match_tree(eps: dict, byfirst, parents_ids, id2ind) -> dict | None:
    """Eşleşmenin yakın ailesini (kök + ebeveyn/eş/çocuk) ilişki etiketiyle döndürür;
    bizim ağaçla eşleşen bireyleri (yapısal) individual_id ile işaretler. Görselleştirme için."""
    ai, inds, fams = _pedigree_individuals(eps)
    if not ai:
        return None
    strong = {o["ped_name"]: o for o in _tree_overlap(eps, byfirst, parents_ids, id2ind)}
    root_id = ai.get("id")
    par_ids = {p.get("id") for p in _ped_parents(ai, inds, fams)}
    spouse_ids = set()
    for sf in ai.get("spouse_in_families") or []:
        for r in ((sf.get("husband") or {}).get("id"), (sf.get("wife") or {}).get("id")):
            if r and r != root_id:
                spouse_ids.add(r)
    child_ids = {i["id"] for i in inds.values()
                 if any(p.get("id") == root_id for p in _ped_parents(i, inds, fams))}

    def rel(iid):
        if iid == root_id:
            return "kök"
        if iid in par_ids:
            return "ebeveyn"
        if iid in spouse_ids:
            return "eş"
        if iid in child_ids:
            return "çocuk"
        return "aile"

    def entry(ind):
        o = strong.get(ind.get("name"))
        return {"name": ind.get("name"), "gender": ind.get("gender"),
                "relation": rel(ind.get("id")),
                "matched": o["individual_id"] if (o and o["strong"]) else None}
    members = [entry(i) for i in inds.values() if i.get("id") != root_id]
    order = {"ebeveyn": 0, "eş": 1, "çocuk": 2, "aile": 3}
    members.sort(key=lambda m: order.get(m["relation"], 9))
    return {"root": entry(ai), "members": members}


def _rel_to_gen(rel: str) -> int | None:
    """Akrabalık etiketinden MRCA neslini (sen=0) tahmin et."""
    r = _norm(rel)
    base = None
    if any(k in r for k in ("hala", "teyze", "amca", "dayi")):
        base = 2
    else:
        m = re.search(r"(\d+)\.?\s*derece", r)
        if m:
            base = int(m.group(1)) + 1
    if "ebeveyl" in r and base:  # "ebeveylerin ... kuzeni" bir nesil yukarı
        base += 1
    return base


def _classify_ancestor(term: str) -> tuple[str | None, int | None]:
    """Türkçe ata terimini (taraf, nesil)'e çevir. P=baba, M=anne tarafı."""
    t = _norm(term)
    words = t.split()
    # Bileşik zincir ("X'in Y'si") = dolaylı ata, MRCA adayı değil.
    if len(words) > 1 and any(w.endswith(("nin", "nun", "sin", "sinin", "sining")) for w in words):
        return (None, None)
    if "buyuk buyuk" in t:
        return (None, 4)
    if "buyuk dede" in t or "buyuk baba" in t or ("buyuk" in t and "anne" in t):
        return (None, 3)
    if "babaanne" in t:
        return ("P", 2)
    if "anneanne" in t:
        return ("M", 2)
    if "buyukbaba" in t:
        return ("P", 2)
    if t.startswith("dede"):
        return ("M", 2)
    if t.startswith("baba"):
        return ("P", 1)
    if t.startswith("anne"):
        return ("M", 1)
    return (None, None)


_CLUSTER_CACHE: dict = {"key": None, "val": None}


def _cluster_sides(db: Session) -> dict:
    """Tüm eşleşmeler üzerinde graf etiket-yayılımı (label propagation) ile taraf
    kümelemesi. Düğüm = eşleşme + ortak-eşleşme isimleri; kenar = 'ortak DNA';
    tohum = ToFR ile taraf'ı bilinenler. 'michel -> Merve -> Hatice' gibi geçişli
    zincirleri çözer: doğrudan çapa paylaşmasa da kümeye üyeliğinden taraf çıkar.
    Dönüş: norm_ad -> {side, seed(bool), neighbors:[aynı taraf komşu eşleşme adları]}."""
    from collections import Counter, defaultdict
    rows = db.scalars(select(DnaMatch).where(DnaMatch.detail_json != "")).all()
    key = (len(rows), max((r.detail_at.timestamp() if r.detail_at else 0.0) for r in rows) if rows else 0.0)
    if _CLUSTER_CACHE["key"] == key:
        return _CLUSTER_CACHE["val"]
    adj: dict = defaultdict(set)
    seed: dict = {}          # norm_ad -> taraf (ToFR, sabit tohum)
    match_nodes: dict = {}   # norm_ad -> görünen ad (çekilmiş eşleşmeler)
    dirty = False
    for r in rows:
        nn = _norm(r.name)
        match_nodes[nn] = r.name
        try:
            eps = (json.loads(r.detail_json) or {}).get("endpoints", {})
        except Exception:
            eps = {}
        if not r.tofr_side:  # self-heal: eski kayıtta ToFR taraf'ını hesapla ve sakla
            t = _side_from_eps(eps)
            if t:
                r.tofr_side = t
                dirty = True
        s = r.manual_side or r.tofr_side  # elle işaret ToFR'yi ezer (tohum)
        if s:
            seed[nn] = s
        for p in _shared_names(eps):
            pn = _norm(p)
            if pn and pn != nn:
                adj[nn].add(pn)
                adj[pn].add(nn)
    if dirty:
        db.commit()
    # Etiket yayılımı: tohumlar sabit, diğerleri komşu çoğunluğunu alır.
    label = dict(seed)
    for _ in range(8):
        changed = False
        for node in list(adj.keys()):
            if node in seed:
                continue
            votes = Counter(label[n] for n in adj[node] if n in label)
            if votes:
                best = votes.most_common(1)[0][0]
                if label.get(node) != best:
                    label[node] = best
                    changed = True
        if not changed:
            break
    out = {}
    for nn, side in label.items():
        nb = [match_nodes[x] for x in adj.get(nn, ()) if x in match_nodes and label.get(x) == side]
        out[nn] = {"side": side, "seed": nn in seed, "neighbors": nb[:8]}
    _CLUSTER_CACHE["key"] = key
    _CLUSTER_CACHE["val"] = out
    return out


@router.get("/{match_id}/analysis")
def analysis(match_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Eşleşme için: taraf (baba/anne), olası ortak ata (MRCA, ağaca bağlı),
    olası ağaç yeri ve güven. Detay JSON'undan türetilir."""
    row = db.get(DnaMatch, match_id)
    if row is None or not row.detail_json:
        return {"available": False}
    eps = (json.loads(row.detail_json) or {}).get("endpoints", {})

    # Taraf (ToFR'den)
    tofr = _dig(eps, "dna_single_match_get_theories_of_family_relativity",
                "data", "dna_match", "theories", "data") or []
    side = row.manual_side or _side_from_eps(eps) or "unknown"
    side_src = ("manuel" if row.manual_side else "ToFR" if _side_from_eps(eps) else None)
    side_short = {"paternal": "P", "maternal": "M"}.get(side)

    gen = _rel_to_gen(row.relationship)

    # Ağaç dizini (yapısal kesişim + ata isim eşleşmesi için)
    byname, parents_ids, id2ind, byfirst = _tree_index(db)
    tree = {k: v[0] for k, v in byname.items()}

    # Ortak atalar (isim + pozisyon + ağaç eşleşmesi)
    ancestors = []
    for grp in _dig(eps, "dna_single_match_get_shared_surnames",
                    "data", "dna_match", "surname_matches", "data") or []:
        for a in _dig(grp, "individual_ancestors", "data") or []:
            nm = _dig(a, "individual", "name") or ""
            pos = a.get("relationship_description", "")
            a_side, a_gen = _classify_ancestor(pos)
            tp = tree.get(_norm(re.sub(r"\(.*?\)", "", nm)))
            ancestors.append({
                "name": nm, "position": pos, "side": a_side, "gen": a_gen,
                "individual_id": tp.id if tp else None,
            })

    # MRCA adayları: tarafa + nesle uyanlar (yoksa tarafa uyan en yakınlar)
    def side_ok(s):
        return s is None or side_short is None or s == side_short
    mrca = [a for a in ancestors if a["gen"] == gen and side_ok(a["side"])]
    if not mrca and gen:
        near = [a for a in ancestors if a["gen"] and side_ok(a["side"])]
        near.sort(key=lambda a: abs((a["gen"] or 9) - gen))
        mrca = near[:2]

    # Bağımsız YAPISAL katman: eşleşmenin pedigree'sini (birey + ebeveyn ilişkileri)
    # bizim ağaçla kesiştir. Yalnız ad benzerliği değil, ebeveyn korroborasyonu aranır.
    overlap = _tree_overlap(eps, byfirst, parents_ids, id2ind)
    self_link = next((o for o in overlap if o["is_root"] and o["strong"]), None)
    match_tree = _match_tree(eps, byfirst, parents_ids, id2ind)
    tree_url = ""
    try:
        raw = json.loads(row.raw) if row.raw else {}
        tree_url = _dig(raw, "other_dna_kit", "associated_individual", "link_in_tree") or ""
    except Exception:
        pass

    # ---- In-common taraf çıkarımı (graf etiket-yayılımı) ----
    # Taraf ToFR'den bilinmiyorsa: ortak-eşleşme grafında hangi tarafın kümesine
    # düştüğüne bak. Geçişli: doğrudan çapa paylaşmasa da (michel -> Merve -> Hatice).
    inferred_side = None
    inferred_votes = {"paternal": 0, "maternal": 0}
    anchors_shared = []
    if side == "unknown":
        node = _cluster_sides(db).get(_norm(row.name))
        if node and not node["seed"]:
            inferred_side = node["side"]
            anchors_shared = [{"name": n, "side": inferred_side} for n in node["neighbors"]]
            inferred_votes[inferred_side] = len(anchors_shared)

    cm = row.shared_cm_val or 0
    conf = ("çok yüksek" if cm >= 1300 else "yüksek" if cm >= 500
            else "orta" if cm >= 200 else "düşük")

    side_tr = {"paternal": "Baba tarafı", "maternal": "Anne tarafı", "unknown": "Belirsiz"}[side]
    return {
        "available": True,
        "side": side, "side_tr": side_tr, "side_src": side_src,
        "manual_side": row.manual_side or None,
        "relationship": row.relationship, "mrca_generation": gen,
        "confidence": conf, "has_theory": bool(tofr),
        "mrca": mrca,
        "shared_ancestors": ancestors,
        # Bağımsız YAPISAL pedigree kesişimi (ebeveyn korroborasyonlu)
        "tree_overlap": [o for o in overlap if o["strong"]],
        "tree_overlap_count": sum(1 for o in overlap if o["strong"]),
        "self_in_tree": self_link,
        "match_tree": match_tree,
        "myheritage_url": row.detail_url or "",
        "tree_url": tree_url,
        # In-common taraf çıkarımı (taraf bilinmiyorsa)
        "inferred_side": inferred_side,
        "inferred_side_tr": {"paternal": "Baba tarafı", "maternal": "Anne tarafı"}.get(inferred_side),
        "inferred_votes": inferred_votes,
        "anchors_shared": anchors_shared,
    }


@router.get("/graph")
def dna_graph(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Gen Ağacı verisi: detaylı eşleşmeler (düğüm) + ortak DNA (kenar) + taraf
    kümesi + ağaç kesişimleri. Üç görünümü de (küme ağı, varsayımsal soy,
    ağaç katmanı) tek kaynaktan besler."""
    from collections import defaultdict
    clusters = _cluster_sides(db)
    rows = [r for r in db.scalars(select(DnaMatch)).all() if r.detail_json]
    byname, parents_ids, id2ind, byfirst = _tree_index(db)

    nodes = []
    idx = {}
    shared_sets = {}
    tree_links = defaultdict(list)  # individual_id -> [node index]
    for r in rows:
        nn = _norm(r.name)
        try:
            eps = (json.loads(r.detail_json) or {}).get("endpoints", {})
        except Exception:
            eps = {}
        cl = clusters.get(nn, {})
        eff = r.manual_side or r.tofr_side or cl.get("side") or "unknown"
        gen = _rel_to_gen(r.relationship)
        linked = None
        if r.individual_id:
            ind = db.get(Individual, r.individual_id)
            if ind:
                linked = {"individual_id": ind.id, "name": f"{ind.first_name} {ind.last_name}".strip()}
        # YAPISAL pedigree kesişimi (ebeveyn korroborasyonlu; yaygın-ad false-positive'siz)
        ov = [{"individual_id": o["individual_id"], "name": o["name"]}
              for o in _tree_overlap(eps, byfirst, parents_ids, id2ind) if o["strong"]]
        i = len(nodes)
        idx[nn] = i
        nodes.append({
            "id": r.id, "name": r.name, "cm": r.shared_cm_val or 0,
            "side": eff, "seed": bool(r.manual_side or r.tofr_side), "gen": gen,
            "relationship": r.relationship, "linked": linked, "overlap": ov,
        })
        shared_sets[nn] = set(_norm(x) for x in _shared_names(eps))
        if linked:
            tree_links[linked["individual_id"]].append(i)
        for o in ov:
            if not linked or o["individual_id"] != linked["individual_id"]:
                tree_links[o["individual_id"]].append(i)

    # Kenarlar: bir eşleşme diğerini ortak-listesinde barındırıyorsa (match-match)
    edges = set()
    for nn, sset in shared_sets.items():
        for other in sset:
            if other in idx and other != nn:
                a, b = sorted((idx[nn], idx[other]))
                edges.add((a, b))

    tl = []
    for iid, nis in tree_links.items():
        ind = db.get(Individual, iid)
        if not ind:
            continue
        tl.append({
            "individual_id": iid,
            "name": f"{ind.first_name} {ind.last_name}".strip(),
            "matches": [{"id": nodes[n]["id"], "name": nodes[n]["name"],
                         "cm": nodes[n]["cm"], "side": nodes[n]["side"]} for n in nis],
        })
    tl.sort(key=lambda x: -len(x["matches"]))

    counts = {"paternal": 0, "maternal": 0, "unknown": 0}
    for n in nodes:
        counts[n["side"]] = counts.get(n["side"], 0) + 1
    return {"nodes": nodes, "edges": [[a, b] for a, b in edges],
            "tree_links": tl, "counts": counts, "total_matches": db.scalar(
                select(func.count()).select_from(DnaMatch)) or 0}


@router.get("/ancestor-suggestions")
def ancestor_suggestions(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Ağacı YUKARI genişletmek için: (1) ağaç uçları (ebeveyni olmayan atalar =
    genişletme noktaları), (2) DNA'dan ata adayları (shared_surnames'deki ata
    isimleri — ağaçta olmayanlar). Kaç eşleşme desteklediği + pozisyon ipucu ile."""
    from collections import defaultdict
    byname, parents_ids, id2ind, byfirst = _tree_index(db)
    intree = set(byname.keys())

    # Ağaç uçları: ebeveyni olmayan, adı olan kişiler (soyadı olanlar önce)
    have_child_parent = set(parents_ids.keys())
    frontier = []
    for p in id2ind.values():
        nm = f"{p.first_name} {p.last_name}".strip()
        if p.id in have_child_parent or not nm:
            continue
        frontier.append({"individual_id": p.id, "name": nm,
                         "surname": (p.last_name or "").strip(),
                         "birth_date": p.birth_date or ""})
    frontier.sort(key=lambda x: (not x["surname"], x["name"]))

    # DNA ata adayları: tüm detaylı eşleşmelerin shared_surnames ata isimleri
    cand = defaultdict(lambda: {"support": 0, "positions": set(), "matches": set(), "name": ""})
    for r in db.scalars(select(DnaMatch).where(DnaMatch.detail_json != "")).all():
        try:
            eps = (json.loads(r.detail_json) or {}).get("endpoints", {})
        except Exception:
            continue
        for grp in _dig(eps, "dna_single_match_get_shared_surnames",
                        "data", "dna_match", "surname_matches", "data") or []:
            for a in _dig(grp, "individual_ancestors", "data") or []:
                nm = _dig(a, "individual", "name") or ""
                k = _norm(nm)
                if not k or "bilinmiyor" in k:
                    continue
                c = cand[k]
                c["support"] += 1
                c["name"] = nm
                pos = a.get("relationship_description", "")
                if pos:
                    c["positions"].add(pos)
                c["matches"].add(r.name)
    suggestions = []
    for k, c in cand.items():
        tp = byname.get(k)
        suggestions.append({
            "name": c["name"], "norm": k,
            "support": c["support"], "positions": sorted(c["positions"])[:3],
            "matches": sorted(c["matches"])[:6],
            "in_tree": bool(tp),
            "individual_id": tp[0].id if tp else None,
        })
    suggestions.sort(key=lambda x: (x["in_tree"], -x["support"]))
    return {
        "frontier": frontier,
        "frontier_count": len(frontier),
        "suggestions": suggestions,
        "new_count": sum(1 for s in suggestions if not s["in_tree"]),
    }


@router.post("/{match_id}/side")
def set_side(match_id: int, payload: dict = Body(...),
             db: Session = Depends(get_db), user: User = Depends(require_editor)):
    """Eşleşmeye elle taraf atar (baba/anne) — kümeleme için tohum olur.
    Bilinen bir anne-tarafı akrabayı işaretleyince anne kümesi propagasyonla oluşur."""
    row = db.get(DnaMatch, match_id)
    if row is None:
        raise HTTPException(404, "Eşleşme bulunamadı")
    s = (payload.get("side") or "").strip().lower()
    if s not in ("paternal", "maternal", ""):
        raise HTTPException(400, "Geçersiz taraf")
    row.manual_side = s
    _CLUSTER_CACHE["key"] = None  # kümeleme yeniden hesaplanmalı
    log_activity(db, user, "dna_side", None, f"{row.name}: taraf = {s or 'temizlendi'}")
    db.commit()
    return {"ok": True, "id": row.id, "manual_side": s or None}


@router.post("/{match_id}/link")
def link_match(
    match_id: int,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    """DNA eşleşmesini ağaçtaki bir kişiye bağlar (individual_id) veya çözer."""
    row = db.get(DnaMatch, match_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Eşleşme bulunamadı")
    iid = payload.get("individual_id")
    if iid:
        ind = db.get(Individual, int(iid))
        if ind is None:
            raise HTTPException(status_code=404, detail="Kişi bulunamadı")
        row.individual_id = ind.id
        log_activity(db, user, "dna_linked", ind, f"DNA: {row.name}")
    else:
        row.individual_id = None
    db.commit()
    return {"ok": True, "individual_id": row.individual_id}


@router.get("/{match_id}/suggestions")
def suggestions(match_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Eşleşme adına göre ağaçtan aday kişiler (isim/soyad örtüşmesi + bağlantı)."""
    row = db.get(DnaMatch, match_id)
    if row is None:
        return {"items": []}
    target = _norm(row.name)
    tparts = set(target.split())
    if not tparts:
        return {"items": []}
    # bağlantı sayısı (tie-break)
    deg: dict[int, int] = {}
    for pid, cid in db.execute(select(ParentChild.parent_id, ParentChild.child_id)).all():
        deg[pid] = deg.get(pid, 0) + 1
        deg[cid] = deg.get(cid, 0) + 1
    for aid, bid in db.execute(select(Spouse.a_id, Spouse.b_id)).all():
        deg[aid] = deg.get(aid, 0) + 1
        deg[bid] = deg.get(bid, 0) + 1
    scored = []
    for p in db.scalars(select(Individual)).all():
        nm = _norm(f"{p.first_name} {p.last_name}")
        if not nm:
            continue
        nparts = set(nm.split())
        common = tparts & nparts
        if not common:
            continue
        score = 100 if nm == target else len(common) * 20
        scored.append((score + deg.get(p.id, 0), _person_brief(db, p)))
    scored.sort(key=lambda x: -x[0])
    return {"items": [dict(b, score=s) for s, b in scored[:8]]}


@router.get("/next-undetailed")
def next_undetailed(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Detayı henüz çekilmemiş, cM'si en yüksek eşleşme (crawler sırası için)."""
    row = db.scalar(
        select(DnaMatch).where(DnaMatch.detail_at.is_(None), DnaMatch.detail_url != "")
        .order_by(DnaMatch.shared_cm_val.desc().nullslast(), DnaMatch.id)
    )
    if row is None:
        return {"done": True}
    return {"done": False, "id": row.id, "name": row.name, "detail_url": row.detail_url,
            "match_guid": row.match_guid}


@router.get("/{match_id}")
def get_match(match_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    r = db.get(DnaMatch, match_id)
    if r is None:
        return {"error": "yok"}
    out = {
        "id": r.id, "name": r.name, "manager": r.manager, "relationship": r.relationship,
        "shared_cm": r.shared_cm, "shared_segments": r.shared_segments,
        "largest_segment_cm": r.largest_segment_cm, "match_quality_pct": r.match_quality_pct,
        "age": r.age, "country": r.country, "smart_matches": r.smart_matches,
        "tree_size": r.tree_size, "gender": r.gender, "match_guid": r.match_guid,
        "detail_url": r.detail_url, "has_detail": bool(r.detail_json),
        "detail_at": r.detail_at.isoformat() if r.detail_at else None,
        "individual_id": r.individual_id,
        "linked": _person_brief(db, db.get(Individual, r.individual_id))
                  if r.individual_id and db.get(Individual, r.individual_id) else None,
    }
    try:
        out["detail"] = json.loads(r.detail_json) if r.detail_json else None
    except Exception:
        out["detail"] = None
    return out


@router.get("")
def list_matches(
    offset: int = 0,
    limit: int = 25,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    total = db.scalar(select(func.count()).select_from(DnaMatch)) or 0
    limit = min(max(limit, 1), 100)
    rows = db.scalars(
        select(DnaMatch)
        .order_by(DnaMatch.shared_cm_val.desc().nullslast(), DnaMatch.id)
        .offset(max(offset, 0)).limit(limit)
    ).all()
    items = [{
        "id": r.id, "name": r.name, "manager": r.manager, "relationship": r.relationship,
        "match_quality_pct": r.match_quality_pct, "shared_cm": r.shared_cm,
        "shared_segments": r.shared_segments, "largest_segment_cm": r.largest_segment_cm,
        "age": r.age, "country": r.country, "smart_matches": r.smart_matches,
        "tree_size": r.tree_size, "gender": r.gender, "has_detail": bool(r.detail_json),
        "linked": _person_brief(db, db.get(Individual, r.individual_id))
                  if r.individual_id and db.get(Individual, r.individual_id) else None,
    } for r in rows]
    undetailed = db.scalar(
        select(func.count()).select_from(DnaMatch).where(DnaMatch.detail_at.is_(None))) or 0
    return {"total": total, "undetailed": undetailed, "offset": offset, "limit": limit, "items": items}
