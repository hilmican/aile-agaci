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
        row = db.scalar(select(DnaMatch).where(
            DnaMatch.kit == kit, DnaMatch.name == name, DnaMatch.shared_cm == cm))
        new = row is None
        if new:
            row = DnaMatch(kit=kit, name=name, shared_cm=cm)
            db.add(row)
        row.manager = mm.get("manager", "")
        row.relationship = mm.get("relationship", "")
        row.match_quality_pct = mm.get("match_quality_pct", "")
        row.shared_cm_val = _parse_tr_num(cm)
        row.shared_segments = mm.get("shared_segments", "")
        row.largest_segment_cm = mm.get("largest_segment_cm", "")
        row.age = mm.get("age", "")
        row.country = mm.get("country", "")
        row.smart_matches = mm.get("smart_matches", "")
        row.tree_size = mm.get("tree_size", "")
        gc = mm.get("gender_class", "") or ""
        row.gender = "F" if "gender_F" in gc else ("M" if "gender_M" in gc else "U")
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
        s = r.tofr_side
        if not s:  # self-heal: eski kayıtta ToFR taraf'ını hesapla ve sakla
            s = _side_from_eps(eps)
            if s != (r.tofr_side or ""):
                r.tofr_side = s
                dirty = True
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
    side = _side_from_eps(eps) or "unknown"
    side_short = {"paternal": "P", "maternal": "M"}.get(side)

    gen = _rel_to_gen(row.relationship)

    # Ağaç kişileri (isimle eşleştirmek için)
    tree = {}
    for p in db.scalars(select(Individual)).all():
        tree.setdefault(_norm(f"{p.first_name} {p.last_name}"), p)

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

    # Bağımsız katman: eşleşmenin çektiğimiz soyağacını bizim ağaçla kesiştir.
    def _find_names(o, out, d=0):
        if d > 9 or o is None:
            return
        if isinstance(o, dict):
            nm = o.get("name")
            if isinstance(nm, str):
                out.append(nm)
            for v in o.values():
                _find_names(v, out, d + 1)
        elif isinstance(o, list):
            for v in o:
                _find_names(v, out, d + 1)

    ped = eps.get("dna_single_match_get_other_kit_pedigree_chart")
    pnames = []
    _find_names(ped.get("data") if isinstance(ped, dict) else ped, pnames)
    overlap = []
    seen_ids = set()
    self_link = None
    for nm in pnames:
        if not nm or nm == "Bilinmiyor":
            continue
        tp = tree.get(_norm(re.sub(r"\(.*?\)", "", nm)))
        if tp and tp.id not in seen_ids:
            seen_ids.add(tp.id)
            entry = {"name": f"{tp.first_name} {tp.last_name}".strip(), "individual_id": tp.id}
            overlap.append(entry)
            if _norm(nm) == _norm(row.name) and self_link is None:
                self_link = entry

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
        "side": side, "side_tr": side_tr,
        "relationship": row.relationship, "mrca_generation": gen,
        "confidence": conf, "has_theory": bool(tofr),
        "mrca": mrca,
        "shared_ancestors": ancestors,
        # Bağımsız pedigree kesişimi (MyHeritage'dan bağımsız, bizim eşleştirmemiz)
        "tree_overlap": overlap,
        "tree_overlap_count": len(overlap),
        "pedigree_names": len([n for n in pnames if n and n != "Bilinmiyor"]),
        "self_in_tree": self_link,
        # In-common taraf çıkarımı (taraf bilinmiyorsa)
        "inferred_side": inferred_side,
        "inferred_side_tr": {"paternal": "Baba tarafı", "maternal": "Anne tarafı"}.get(inferred_side),
        "inferred_votes": inferred_votes,
        "anchors_shared": anchors_shared,
    }


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
