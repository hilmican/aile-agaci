"""Toplu işlemler: aday listesi + toplu alan atama."""
import re
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..activity import log_activity
from ..database import get_db
from ..models import Family, Individual, IndividualFamily, User
from ..security import get_current_user, require_editor
from .families import compute_memberships

router = APIRouter(prefix="/api/bulk", tags=["bulk"])


def _year(s: str) -> int | None:
    m = re.search(r"\d{3,4}", s or "")
    return int(m.group(0)) if m else None


@router.get("/list")
def bulk_list(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Toplu işlem ekranı için tüm kişiler + ilgili alanlar. Filtre/gruplama
    istemcide yapılır (veri küçük)."""
    memberships = compute_memberships(db)
    fam_names = {f.id: f.name for f in db.scalars(select(Family)).all()}
    fams_of: dict[int, list[str]] = {}
    for fid, membs in memberships.items():
        for pid in membs:
            fams_of.setdefault(pid, []).append(fam_names.get(fid, ""))

    this_year = date.today().year
    out = []
    for ind in db.scalars(select(Individual)).all():
        by = _year(ind.birth_date)
        out.append({
            "id": ind.id,
            "name": f"{ind.first_name} {ind.last_name}".strip() or "(isimsiz)",
            "last_name": ind.last_name,
            "sex": ind.sex,
            "birth_date": ind.birth_date,
            "birth_year": by,
            "birth_place": ind.birth_place,
            "has_birth_coord": ind.birth_lat is not None,
            "death_date": ind.death_date,
            "death_place": ind.death_place,
            "occupation": ind.occupation,
            "families": sorted(set(fams_of.get(ind.id, []))),
            "age": (this_year - by) if by else None,
            "alive": not (ind.death_date or "").strip(),
        })
    return {"this_year": this_year, "people": out}


class BulkSet(BaseModel):
    birth_place: str | None = None
    birth_lat: float | None = None
    birth_lng: float | None = None
    death_date: str | None = None
    death_place: str | None = None
    occupation: str | None = None


class BulkUpdate(BaseModel):
    ids: list[int]
    set: BulkSet = BulkSet()
    add_family: str | None = None
    # Verilirse: vefat kaydı olmayan her kişiye doğum yılı + bu yaş kadar,
    # GEDCOM "EST" (tahmini) işaretiyle ölüm yılı atanır (sonradan düzeltilebilir).
    estimate_death_age: int | None = None


_FIELD_TR = {
    "birth_place": "doğum yeri", "death_date": "ölüm tarihi",
    "death_place": "ölüm yeri", "occupation": "meslek",
}


@router.post("/update")
def bulk_update(
    payload: BulkUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    if not payload.ids:
        raise HTTPException(status_code=400, detail="Kişi seçilmedi")
    changes = payload.set.model_dump(exclude_none=True)
    est_age = payload.estimate_death_age
    if not changes and not (payload.add_family or "").strip() and not est_age:
        raise HTTPException(status_code=400, detail="Uygulanacak bir değişiklik yok")

    fam = None
    if (payload.add_family or "").strip():
        name = payload.add_family.strip()
        fam = db.scalar(select(Family).where(func.lower(Family.name) == name.lower()))
        if fam is None:
            fam = Family(name=name)
            db.add(fam)
            db.flush()

    updated = 0
    est_applied = 0
    for ind in db.scalars(select(Individual).where(Individual.id.in_(payload.ids))).all():
        # Tahmini vefat: yalnız doğum yılı olan ve henüz vefat kaydı olmayanlara.
        if est_age:
            by = _year(ind.birth_date)
            if by and not (ind.death_date or "").strip():
                ind.death_date = f"EST {by + est_age}"
                est_applied += 1
        for key, val in changes.items():
            setattr(ind, key, val)
        if fam is not None:
            exists = db.scalar(select(IndividualFamily).where(
                IndividualFamily.individual_id == ind.id, IndividualFamily.family_id == fam.id))
            if exists is None:
                db.add(IndividualFamily(individual_id=ind.id, family_id=fam.id))
        updated += 1

    parts = [_FIELD_TR[k] for k in changes if k in _FIELD_TR]
    if est_age:
        parts.append(f"tahmini vefat (~{est_age} yaş, {est_applied} kişi)")
    if fam is not None:
        parts.append(f"{fam.name} kolu")
    log_activity(db, user, "bulk_updated", None,
                 f"{updated} kişi güncellendi: {', '.join(parts) or 'toplu'}")
    db.commit()
    return {"updated": updated}
