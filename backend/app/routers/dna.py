"""DNA eşleşmeleri: içe aktarma (crawler'dan) + listeleme (arayüz)."""
import json

from fastapi import APIRouter, Body, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..activity import log_activity
from ..database import get_db
from ..models import DnaMatch, User
from ..security import get_current_user, require_editor

router = APIRouter(prefix="/api/dna", tags=["dna"])


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
        row.raw = json.dumps(mm, ensure_ascii=False)
        imported += 1
    db.flush()
    total = db.scalar(select(func.count()).select_from(DnaMatch)) or 0
    if imported:
        log_activity(db, user, "dna_imported", None,
                     f"{imported} DNA eşleşmesi çekildi (toplam {total})")
    db.commit()
    return {"imported": imported, "total": total}


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
        "tree_size": r.tree_size, "gender": r.gender,
    } for r in rows]
    return {"total": total, "offset": offset, "limit": limit, "items": items}
