"""Aile kümeleri (kollar): liste, üyeler, otomatik tamamlama."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Family, Individual, IndividualFamily, ParentChild, Spouse, User
from ..security import get_current_user, require_editor

router = APIRouter(prefix="/api/families", tags=["families"])


class FamilyEmblem(BaseModel):
    emblem: str = ""


def _person_ref(ind: Individual) -> dict:
    return {
        "id": ind.id,
        "name": f"{ind.first_name} {ind.last_name}".strip() or "(isimsiz)",
        "sex": ind.sex,
    }


def compute_memberships(db: Session) -> dict[int, dict[int, str]]:
    """Her aile kolu için üyelik hesapla.
    Kural: etiketli kişiler + baba soyu üzerinden miras (bir kişi babasının
    kolundandır → erkek üyeler çocuklarına aktarır) + evlilikle katılanlar.
    Dönen: {family_id: {person_id: kind}} kind = tagged | inherited | marriage.
    """
    explicit: dict[int, set[int]] = {}
    for link in db.scalars(select(IndividualFamily)).all():
        explicit.setdefault(link.family_id, set()).add(link.individual_id)

    children_of: dict[int, list[int]] = {}
    for pid, cid in db.execute(select(ParentChild.parent_id, ParentChild.child_id)).all():
        children_of.setdefault(pid, []).append(cid)
    sex = {rid: s for rid, s in db.execute(select(Individual.id, Individual.sex)).all()}
    spouse_pairs = db.execute(select(Spouse.a_id, Spouse.b_id)).all()

    result: dict[int, dict[int, str]] = {}
    for fid, tagged in explicit.items():
        # Kan bağı: etiketlilerden başla; erkek (baba) olanlar çocuklarına aktarır.
        blood = set(tagged)
        queue = list(tagged)
        while queue:
            p = queue.pop()
            if sex.get(p) == "M":  # aile adını yalnız babalar aktarır
                for c in children_of.get(p, []):
                    if c not in blood:
                        blood.add(c)
                        queue.append(c)
        # Evlilikle katılım: kan bağı olan birinin eşi.
        married = set()
        for a, b in spouse_pairs:
            if a in blood and b not in blood:
                married.add(b)
            if b in blood and a not in blood:
                married.add(a)
        membs: dict[int, str] = {}
        for pid in blood:
            membs[pid] = "tagged" if pid in tagged else "inherited"
        for pid in married:
            membs.setdefault(pid, "marriage")
        result[fid] = membs
    return result


@router.get("")
def list_families(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Tüm kollar, hesaplanmış üye sayısıyla (çoktan aza)."""
    memberships = compute_memberships(db)
    fams = db.scalars(select(Family)).all()
    items = [{"id": f.id, "name": f.name, "emblem": f.emblem,
              "count": len(memberships.get(f.id, {}))} for f in fams]
    items.sort(key=lambda x: (-x["count"], x["name"].lower()))
    return {"items": items}


@router.patch("/{family_id}")
def set_emblem(
    family_id: int,
    payload: FamilyEmblem,
    db: Session = Depends(get_db),
    _: User = Depends(require_editor),
):
    fam = db.get(Family, family_id)
    if fam is None:
        raise HTTPException(status_code=404, detail="Aile bulunamadı")
    fam.emblem = (payload.emblem or "").strip()[:40]
    db.commit()
    return {"id": fam.id, "name": fam.name, "emblem": fam.emblem}


@router.get("/{family_id}")
def family_members(family_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    fam = db.get(Family, family_id)
    if fam is None:
        return {"id": family_id, "name": "", "emblem": "", "members": []}
    membs = compute_memberships(db).get(family_id, {})
    people = db.scalars(select(Individual).where(Individual.id.in_(membs.keys()))).all() if membs else []
    order = {"tagged": 0, "inherited": 1, "marriage": 2}
    people.sort(key=lambda p: (order.get(membs.get(p.id), 3), p.last_name, p.first_name))
    members = [dict(_person_ref(p), kind=membs.get(p.id, "inherited")) for p in people]
    return {"id": fam.id, "name": fam.name, "emblem": fam.emblem, "members": members}
