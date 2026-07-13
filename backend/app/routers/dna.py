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
    if payload.get("detail_url"):
        row.detail_url = payload["detail_url"]
    log_activity(db, user, "dna_detail", None, f"{row.name} detayları çekildi")
    db.commit()
    return {"ok": True, "id": row.id, "name": row.name}


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
