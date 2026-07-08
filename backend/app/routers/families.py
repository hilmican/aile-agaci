"""Aile kümeleri (kollar): liste, üyeler, otomatik tamamlama."""
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Family, Individual, IndividualFamily, User
from ..security import get_current_user

router = APIRouter(prefix="/api/families", tags=["families"])


def _person_ref(ind: Individual) -> dict:
    return {
        "id": ind.id,
        "name": f"{ind.first_name} {ind.last_name}".strip() or "(isimsiz)",
        "sex": ind.sex,
    }


@router.get("")
def list_families(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Tüm kollar, üye sayısıyla (çoktan aza)."""
    counts = dict(
        db.execute(
            select(IndividualFamily.family_id, func.count(IndividualFamily.id))
            .group_by(IndividualFamily.family_id)
        ).all()
    )
    fams = db.scalars(select(Family)).all()
    items = [{"id": f.id, "name": f.name, "count": counts.get(f.id, 0)} for f in fams]
    items.sort(key=lambda x: (-x["count"], x["name"].lower()))
    return {"items": items}


@router.get("/{family_id}")
def family_members(family_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    fam = db.get(Family, family_id)
    if fam is None:
        return {"id": family_id, "name": "", "members": []}
    member_ids = db.scalars(
        select(IndividualFamily.individual_id).where(IndividualFamily.family_id == family_id)
    ).all()
    people = db.scalars(select(Individual).where(Individual.id.in_(member_ids))).all() if member_ids else []
    people.sort(key=lambda p: (p.last_name, p.first_name))
    return {"id": fam.id, "name": fam.name, "members": [_person_ref(p) for p in people]}
