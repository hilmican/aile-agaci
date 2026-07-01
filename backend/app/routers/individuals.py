import os
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import Individual, Media, ParentChild, Spouse
from ..schemas import (
    IndividualCreate,
    IndividualDetail,
    IndividualSummary,
    IndividualUpdate,
    MediaOut,
    RelationshipCreate,
    SpouseLink,
)
from ..security import get_current_user, require_editor
from ..models import User

router = APIRouter(prefix="/api/individuals", tags=["individuals"])

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


def _media_out(m: Media) -> MediaOut:
    out = MediaOut.model_validate(m)
    out.url = f"/uploads/{m.filename}"
    return out


def _parents(db: Session, ind_id: int) -> list[Individual]:
    ids = db.scalars(select(ParentChild.parent_id).where(ParentChild.child_id == ind_id)).all()
    return db.scalars(select(Individual).where(Individual.id.in_(ids))).all() if ids else []


def _children(db: Session, ind_id: int) -> list[Individual]:
    ids = db.scalars(select(ParentChild.child_id).where(ParentChild.parent_id == ind_id)).all()
    return db.scalars(select(Individual).where(Individual.id.in_(ids))).all() if ids else []


def _spouse_links(db: Session, ind_id: int) -> list[SpouseLink]:
    rows = db.scalars(
        select(Spouse).where(or_(Spouse.a_id == ind_id, Spouse.b_id == ind_id))
    ).all()
    links: list[SpouseLink] = []
    for row in rows:
        other_id = row.b_id if row.a_id == ind_id else row.a_id
        other = db.get(Individual, other_id)
        if other:
            links.append(
                SpouseLink(
                    person=IndividualSummary.model_validate(other),
                    marriage_date=row.marriage_date,
                    marriage_place=row.marriage_place,
                )
            )
    return links


def _detail(db: Session, ind: Individual) -> IndividualDetail:
    detail = IndividualDetail.model_validate(ind)
    detail.parents = [IndividualSummary.model_validate(p) for p in _parents(db, ind.id)]
    detail.children = [IndividualSummary.model_validate(c) for c in _children(db, ind.id)]
    detail.spouses = _spouse_links(db, ind.id)
    detail.media = [_media_out(m) for m in ind.media]
    return detail


@router.get("", response_model=list[IndividualSummary])
def list_individuals(
    q: str = "",
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(Individual)
    if q.strip():
        like = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(Individual.first_name.ilike(like), Individual.last_name.ilike(like))
        )
    stmt = stmt.order_by(Individual.last_name, Individual.first_name).limit(500)
    return db.scalars(stmt).all()


@router.post("", response_model=IndividualDetail, status_code=201)
def create_individual(
    payload: IndividualCreate, db: Session = Depends(get_db), _: User = Depends(require_editor)
):
    ind = Individual(**payload.model_dump())
    db.add(ind)
    db.commit()
    db.refresh(ind)
    return _detail(db, ind)


@router.get("/{ind_id}", response_model=IndividualDetail)
def get_individual(ind_id: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    ind = db.get(Individual, ind_id)
    if ind is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    return _detail(db, ind)


@router.patch("/{ind_id}", response_model=IndividualDetail)
def update_individual(
    ind_id: int,
    payload: IndividualUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_editor),
):
    ind = db.get(Individual, ind_id)
    if ind is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(ind, key, value)
    db.commit()
    db.refresh(ind)
    return _detail(db, ind)


@router.delete("/{ind_id}", status_code=204)
def delete_individual(ind_id: int, db: Session = Depends(get_db), _: User = Depends(require_editor)):
    ind = db.get(Individual, ind_id)
    if ind is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    for m in ind.media:
        _remove_file(m.filename)
    db.delete(ind)
    db.commit()


# ---- Relationships ----
@router.post("/{ind_id}/relationships", status_code=201)
def add_relationship(
    ind_id: int,
    payload: RelationshipCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_editor),
):
    ind = db.get(Individual, ind_id)
    other = db.get(Individual, payload.related_id)
    if ind is None or other is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    if ind.id == other.id:
        raise HTTPException(status_code=400, detail="Kişi kendisiyle ilişkilendirilemez")

    if payload.type == "parent":
        _link_parent_child(db, parent_id=other.id, child_id=ind.id)
    elif payload.type == "child":
        _link_parent_child(db, parent_id=ind.id, child_id=other.id)
    elif payload.type == "spouse":
        a, b = sorted((ind.id, other.id))
        exists = db.scalar(select(Spouse).where(Spouse.a_id == a, Spouse.b_id == b))
        if not exists:
            db.add(
                Spouse(
                    a_id=a,
                    b_id=b,
                    marriage_date=payload.marriage_date,
                    marriage_place=payload.marriage_place,
                )
            )
    else:
        raise HTTPException(status_code=400, detail="Geçersiz ilişki türü")
    db.commit()
    return {"status": "ok"}


@router.delete("/{ind_id}/relationships", status_code=204)
def remove_relationship(
    ind_id: int,
    type: str,
    related_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_editor),
):
    if type == "parent":
        _unlink_parent_child(db, parent_id=related_id, child_id=ind_id)
    elif type == "child":
        _unlink_parent_child(db, parent_id=ind_id, child_id=related_id)
    elif type == "spouse":
        a, b = sorted((ind_id, related_id))
        row = db.scalar(select(Spouse).where(Spouse.a_id == a, Spouse.b_id == b))
        if row:
            db.delete(row)
    else:
        raise HTTPException(status_code=400, detail="Geçersiz ilişki türü")
    db.commit()


def _link_parent_child(db: Session, parent_id: int, child_id: int) -> None:
    exists = db.scalar(
        select(ParentChild).where(
            ParentChild.parent_id == parent_id, ParentChild.child_id == child_id
        )
    )
    if not exists:
        db.add(ParentChild(parent_id=parent_id, child_id=child_id))


def _unlink_parent_child(db: Session, parent_id: int, child_id: int) -> None:
    row = db.scalar(
        select(ParentChild).where(
            ParentChild.parent_id == parent_id, ParentChild.child_id == child_id
        )
    )
    if row:
        db.delete(row)


# ---- Pedigree (ancestors) ----
@router.get("/{ind_id}/pedigree")
def pedigree(
    ind_id: int,
    depth: int = 4,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    depth = max(1, min(depth, 8))

    def build(node_id: int, level: int, seen: set[int]):
        ind = db.get(Individual, node_id)
        if ind is None or node_id in seen:
            return None
        seen = seen | {node_id}
        node = {
            "id": ind.id,
            "name": f"{ind.first_name} {ind.last_name}".strip() or "(isimsiz)",
            "sex": ind.sex,
            "birth_date": ind.birth_date,
            "death_date": ind.death_date,
            "children": [],
        }
        if level < depth:
            for parent in _parents(db, ind.id):
                child = build(parent.id, level + 1, seen)
                if child:
                    node["children"].append(child)
        return node

    root = build(ind_id, 0, set())
    if root is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    return root


# ---- Media ----
def _remove_file(filename: str) -> None:
    path = os.path.join(settings.upload_dir, filename)
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


@router.post("/{ind_id}/media", response_model=MediaOut, status_code=201)
async def upload_media(
    ind_id: int,
    file: UploadFile = File(...),
    caption: str = Form(""),
    db: Session = Depends(get_db),
    _: User = Depends(require_editor),
):
    ind = db.get(Individual, ind_id)
    if ind is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="Yalnızca resim dosyaları yüklenebilir")

    os.makedirs(settings.upload_dir, exist_ok=True)
    ext = os.path.splitext(file.filename or "")[1].lower() or ".jpg"
    filename = f"{uuid.uuid4().hex}{ext}"
    path = os.path.join(settings.upload_dir, filename)
    contents = await file.read()
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Dosya 10MB sınırını aşıyor")
    with open(path, "wb") as fh:
        fh.write(contents)

    media = Media(
        individual_id=ind.id,
        filename=filename,
        original_name=file.filename or "",
        content_type=file.content_type or "",
        caption=caption,
    )
    db.add(media)
    db.commit()
    db.refresh(media)
    return _media_out(media)


@router.delete("/{ind_id}/media/{media_id}", status_code=204)
def delete_media(
    ind_id: int,
    media_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_editor),
):
    media = db.get(Media, media_id)
    if media is None or media.individual_id != ind_id:
        raise HTTPException(status_code=404, detail="Görsel bulunamadı")
    _remove_file(media.filename)
    db.delete(media)
    db.commit()
