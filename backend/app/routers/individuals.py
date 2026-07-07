import os
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..activity import log_activity
from ..config import settings
from ..database import get_db
from ..models import Anecdote, Individual, Media, ParentChild, Residence, Spouse
from ..schemas import (
    AnecdoteCreate,
    AnecdoteOut,
    IndividualCreate,
    IndividualDetail,
    IndividualSummary,
    IndividualUpdate,
    MediaOut,
    RelationshipCreate,
    ResidenceCreate,
    ResidenceOut,
    SpouseLink,
    SpouseUpdate,
)
import re as _re
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
    detail.anecdotes = [
        AnecdoteOut.model_validate(a)
        for a in db.scalars(
            select(Anecdote).where(Anecdote.individual_id == ind.id)
            .order_by(Anecdote.created_at.desc())
        ).all()
    ]
    # Yaşam yeri geçmişi: yıla göre eskiden yeniye (en son yer en altta).
    res = db.scalars(select(Residence).where(Residence.individual_id == ind.id)).all()
    res.sort(key=lambda r: (r.year_from if r.year_from is not None else 9999, r.id))
    detail.residences = [ResidenceOut.model_validate(r) for r in res]
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
    people = db.scalars(stmt).all()

    # Her kişinin ağaçtaki bağlantı sayısı (ebeveyn+çocuk+eş) — sıralama/önem için.
    deg: dict[int, int] = {}
    for pid, cid in db.execute(select(ParentChild.parent_id, ParentChild.child_id)).all():
        deg[pid] = deg.get(pid, 0) + 1
        deg[cid] = deg.get(cid, 0) + 1
    for aid, bid in db.execute(select(Spouse.a_id, Spouse.b_id)).all():
        deg[aid] = deg.get(aid, 0) + 1
        deg[bid] = deg.get(bid, 0) + 1

    out = []
    for p in people:
        summary = IndividualSummary.model_validate(p)
        summary.connections = deg.get(p.id, 0)
        out.append(summary)
    return out


@router.post("", response_model=IndividualDetail, status_code=201)
def create_individual(
    payload: IndividualCreate, db: Session = Depends(get_db), user: User = Depends(require_editor)
):
    ind = Individual(**payload.model_dump())
    db.add(ind)
    db.flush()
    log_activity(db, user, "person_created", ind)
    db.commit()
    db.refresh(ind)
    return _detail(db, ind)


def _default_root_id(db: Session) -> int | None:
    """Ağaç için varsayılan kök: soyun tepesindeki (ebeveynsiz) kişilerden
    en geniş alt soya sahip olanı; eşitlikte GEDCOM dosya sırasına göre ilki."""
    all_ids = db.scalars(select(Individual.id)).all()
    if not all_ids:
        return None

    child_map: dict[int, list[int]] = {}
    has_parent: set[int] = set()
    for parent_id, child_id in db.execute(
        select(ParentChild.parent_id, ParentChild.child_id)
    ).all():
        child_map.setdefault(parent_id, []).append(child_id)
        has_parent.add(child_id)

    roots = [i for i in all_ids if i not in has_parent] or list(all_ids)

    def descendant_count(start: int) -> int:
        seen: set[int] = set()
        stack = [start]
        while stack:
            cur = stack.pop()
            for c in child_map.get(cur, []):
                if c not in seen:
                    seen.add(c)
                    stack.append(c)
        return len(seen)

    # En çok toruna sahip kök kazanır; eşitlikte küçük id (dosya sırası) önce gelir.
    return min(roots, key=lambda i: (-descendant_count(i), i))


# NOTE: /{ind_id} rotasından önce tanımlanmalı, yoksa "tree-root" path'i onunla eşleşir.
@router.get("/tree-root")
def tree_root(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return {"id": _default_root_id(db)}


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
    user: User = Depends(require_editor),
):
    ind = db.get(Individual, ind_id)
    if ind is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(ind, key, value)
    log_activity(db, user, "person_updated", ind)
    db.commit()
    db.refresh(ind)
    return _detail(db, ind)


@router.delete("/{ind_id}", status_code=204)
def delete_individual(ind_id: int, db: Session = Depends(get_db), user: User = Depends(require_editor)):
    ind = db.get(Individual, ind_id)
    if ind is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    for m in ind.media:
        _remove_file(m.filename)
    log_activity(db, user, "person_deleted", ind)
    db.delete(ind)
    db.commit()


# ---- Relationships ----
@router.post("/{ind_id}/relationships", status_code=201)
def add_relationship(
    ind_id: int,
    payload: RelationshipCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
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
    rel_tr = {"parent": "ebeveyn", "child": "çocuk", "spouse": "eş"}[payload.type]
    other_name = f"{other.first_name} {other.last_name}".strip() or "(isimsiz)"
    log_activity(db, user, "relationship_added", ind, f"{rel_tr}: {other_name}")
    db.commit()
    return {"status": "ok"}


@router.patch("/{ind_id}/spouses/{other_id}")
def update_spouse(
    ind_id: int,
    other_id: int,
    payload: SpouseUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    a, b = sorted((ind_id, other_id))
    row = db.scalar(select(Spouse).where(Spouse.a_id == a, Spouse.b_id == b))
    if row is None:
        raise HTTPException(status_code=404, detail="Evlilik kaydı bulunamadı")
    if payload.marriage_date is not None:
        row.marriage_date = payload.marriage_date.strip()
    if payload.marriage_place is not None:
        row.marriage_place = payload.marriage_place.strip()
    ind = db.get(Individual, ind_id)
    other = db.get(Individual, other_id)
    other_name = (f"{other.first_name} {other.last_name}".strip() or "(isimsiz)") if other else ""
    if ind is not None:
        log_activity(db, user, "marriage_updated", ind, other_name)
    db.commit()
    return {"status": "ok"}


@router.delete("/{ind_id}/relationships", status_code=204)
def remove_relationship(
    ind_id: int,
    type: str,
    related_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
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
    ind = db.get(Individual, ind_id)
    if ind is not None:
        log_activity(db, user, "relationship_removed", ind)
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


# ---- Pedigree (up: atalar, down: alt soy, focus: tüm alt soy + kalan limit kadar üst soy) ----
@router.get("/{ind_id}/pedigree")
def pedigree(
    ind_id: int,
    depth: int = 4,
    direction: str = "up",
    lineage: str = "auto",  # tam ağaç tırmanma kolu: auto | father | mother
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    depth = max(1, min(depth, 30))

    def person_payload(ind: Individual) -> dict:
        return {
            "id": ind.id,
            "name": f"{ind.first_name} {ind.last_name}".strip() or "(isimsiz)",
            "sex": ind.sex,
            "birth_date": ind.birth_date,
            "death_date": ind.death_date,
            "photo": f"/uploads/{ind.media[0].filename}" if ind.media else None,
        }

    def siblings_of(pid: int, seen: set[int]) -> list[dict]:
        """Kişinin kardeşleri (ebeveynlerinin diğer çocukları), dal açmadan."""
        out: list[dict] = []
        added: set[int] = set()
        for par in _parents(db, pid):
            for ch in _children(db, par.id):
                if ch.id != pid and ch.id not in added and ch.id not in seen:
                    added.add(ch.id)
                    out.append(person_payload(ch))
        return out

    def build(node_id: int, level: int, seen: set[int], step, limit: int,
              include_spouses: bool = False, include_siblings: bool = False):
        ind = db.get(Individual, node_id)
        if ind is None or node_id in seen:
            return None
        seen = seen | {node_id}
        node = person_payload(ind)
        node["children"] = []
        node["spouses"] = []
        if include_siblings:
            node["siblings"] = siblings_of(node_id, seen)
        if include_spouses:
            rows = db.scalars(
                select(Spouse).where(or_(Spouse.a_id == ind.id, Spouse.b_id == ind.id))
            ).all()
            for row in rows:
                other = db.get(Individual, row.b_id if row.a_id == ind.id else row.a_id)
                if other is not None and other.id not in seen:
                    node["spouses"].append(person_payload(other))
        if level < limit:
            for related in step(db, ind.id):
                child = build(related.id, level + 1, seen, step, limit,
                              include_spouses, include_siblings)
                if child:
                    node["children"].append(child)
        return node

    def levels(node) -> int:
        if not node["children"]:
            return 0
        return 1 + max(levels(c) for c in node["children"])

    def ancestor_height(pid: int, cap: int, seen: frozenset) -> int:
        """cap sınırı içinde pid'den yukarı en uzun ata zinciri."""
        if cap <= 0:
            return 0
        best = 0
        for par in _parents(db, pid):
            if par.id not in seen:
                best = max(best, 1 + ancestor_height(par.id, cap - 1, seen | {par.id}))
        return best

    def pick_parent(parents: list[Individual], remaining: int) -> Individual | None:
        """Yukarı tırmanılacak ebeveyni soy koluna göre seç.
        father/mother: istenen cinsiyet; yoksa None (zincir durur).
        auto: kalan bütçeyi en iyi kullanan (en derin) ata kolu."""
        if lineage in ("father", "mother"):
            want = "M" if lineage == "father" else "F"
            match = [p for p in parents if p.sex == want]
            return match[0] if match else None
        return max(parents,
                   key=lambda p: ancestor_height(p.id, remaining, frozenset({p.id})))

    def build_up_chain(start_id: int, limit: int) -> dict:
        """Odaktan yukarı TEK doğrudan soy zinciri. Her atada eşi (diğer
        ebeveyn) ve kardeşleri kart olarak eklenir; dal açılmaz → ağaç
        yanlara doğru şişmez. 2. derece aileler karttaki 🌳 ile açılır."""
        start = db.get(Individual, start_id)
        root = person_payload(start)
        root["children"], root["spouses"], root["siblings"] = [], [], []
        seen = {start_id}
        cursor, cur_id = root, start_id
        for lvl in range(limit):
            parents = _parents(db, cur_id)
            if not parents:
                break
            chosen = pick_parent(parents, limit - lvl - 1)
            if chosen is None:
                break
            cnode = person_payload(chosen)
            cnode["children"], cnode["spouses"], cnode["siblings"] = [], [], []
            for o in parents:
                if o.id != chosen.id and o.id not in seen:
                    cnode["spouses"].append(person_payload(o))
            seen.add(chosen.id)
            cnode["siblings"] = siblings_of(chosen.id, seen)
            cursor["children"] = [cnode]
            cursor, cur_id = cnode, chosen.id
        return root

    if direction == "full":
        # Tam ağaç: odak kişiden hareketle kurulur. Önce alt soyunun kaç nesil
        # tuttuğu bulunur; kalan derinlik bütçesi kadar yukarı çıkılır ve o
        # atanın TÜM alt soyu (amca/kuzen dalları dahil) pencere sınırına kadar
        # çizilir. Odak kişi böylece her derinlikte görünür kalır.
        down = build(ind_id, 0, set(), _children, 30)
        if down is None:
            raise HTTPException(status_code=404, detail="Kişi bulunamadı")
        down_lv = levels(down)
        budget = max(0, depth - 1 - down_lv)

        root_id, climbed = ind_id, 0
        while climbed < budget:
            parents = _parents(db, root_id)
            if not parents:
                break
            chosen = pick_parent(parents, budget - climbed - 1)
            if chosen is None:  # istenen soy kolu burada bitiyor
                break
            root_id = chosen.id
            climbed += 1
        # Pencere kökten itibaren tam depth nesil: tırmanma kısa kalsa bile
        # diğer dallar kalan derinliği kullanabilsin.
        tree = build(root_id, 0, set(), _children, depth - 1, include_spouses=True)

        def center_focus(node) -> bool:
            """Odak kişiyi içeren dalı kardeşlerinin ortasına taşı ki odak
            ağacın kenarında değil görece merkezinde dursun."""
            if node["id"] == ind_id:
                return True
            for i, child in enumerate(node["children"]):
                if center_focus(child):
                    mid = len(node["children"]) // 2
                    node["children"].insert(mid, node["children"].pop(i))
                    return True
            return False

        center_focus(tree)
        return {"mode": "full", "root": tree, "focus_id": ind_id}

    if direction == "focus":
        # Odaklı: doğrudan alt soy + doğrudan üst soy (tek zincir), her ikisi
        # de derinlik filtresine uyar. Yan üyeler (kardeş/amca/hala) dal
        # açılmadan kart olarak; 2. derece aileler karttaki 🌳 ile açılır.
        down = build(ind_id, 0, set(), _children, depth - 1, include_spouses=True)
        if down is None:
            raise HTTPException(status_code=404, detail="Kişi bulunamadı")
        down["siblings"] = siblings_of(ind_id, {ind_id})
        up = build_up_chain(ind_id, depth - 1)
        return {"mode": "focus", "down": down, "up": up}

    step = _children if direction == "down" else _parents
    # Atalar görünümünde eşler zaten ebeveyn düğümü olarak çizilir.
    root = build(ind_id, 0, set(), step, depth, include_spouses=(direction == "down"))
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
    user: User = Depends(require_editor),
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
    log_activity(db, user, "media_added", ind)
    db.commit()
    db.refresh(media)
    return _media_out(media)


@router.delete("/{ind_id}/media/{media_id}", status_code=204)
def delete_media(
    ind_id: int,
    media_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    media = db.get(Media, media_id)
    if media is None or media.individual_id != ind_id:
        raise HTTPException(status_code=404, detail="Görsel bulunamadı")
    _remove_file(media.filename)
    db.delete(media)
    ind = db.get(Individual, ind_id)
    if ind is not None:
        log_activity(db, user, "media_deleted", ind)
    db.commit()


# ---- Anekdotlar ----
@router.post("/{ind_id}/anecdotes", response_model=AnecdoteOut, status_code=201)
def add_anecdote(
    ind_id: int,
    payload: AnecdoteCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    ind = db.get(Individual, ind_id)
    if ind is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Anekdot metni boş olamaz")
    an = Anecdote(
        individual_id=ind.id,
        author_id=user.id,
        author_name=user.full_name or user.email,
        title=payload.title.strip(),
        text=text,
    )
    db.add(an)
    snippet = an.title or (text[:80] + ("…" if len(text) > 80 else ""))
    log_activity(db, user, "anecdote_added", ind, snippet)
    db.commit()
    db.refresh(an)
    return AnecdoteOut.model_validate(an)


@router.delete("/{ind_id}/anecdotes/{anecdote_id}", status_code=204)
def delete_anecdote(
    ind_id: int,
    anecdote_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    an = db.get(Anecdote, anecdote_id)
    if an is None or an.individual_id != ind_id:
        raise HTTPException(status_code=404, detail="Anekdot bulunamadı")
    db.delete(an)
    ind = db.get(Individual, ind_id)
    if ind is not None:
        log_activity(db, user, "anecdote_deleted", ind)
    db.commit()


# ---- Yaşam yeri geçmişi ----
def _year_from_period(period: str) -> int | None:
    m = _re.search(r"\d{3,4}", period or "")
    return int(m.group(0)) if m else None


@router.post("/{ind_id}/residences", response_model=ResidenceOut, status_code=201)
def add_residence(
    ind_id: int,
    payload: ResidenceCreate,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    ind = db.get(Individual, ind_id)
    if ind is None:
        raise HTTPException(status_code=404, detail="Kişi bulunamadı")
    place = payload.place.strip()
    if not place:
        raise HTTPException(status_code=400, detail="Yer boş olamaz")
    start = payload.start.strip()
    end = payload.end.strip()
    res = Residence(
        individual_id=ind.id,
        place=place,
        start=start,
        end=end,
        year_from=_year_from_period(start or end),
        note=payload.note.strip(),
    )
    db.add(res)
    span = f"{start} – {end or 'halen'}".strip(" –") if (start or end) else ""
    label = f"{span + ' ' if span else ''}{place}".strip()
    log_activity(db, user, "residence_added", ind, label)
    db.commit()
    db.refresh(res)
    return ResidenceOut.model_validate(res)


@router.delete("/{ind_id}/residences/{residence_id}", status_code=204)
def delete_residence(
    ind_id: int,
    residence_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    res = db.get(Residence, residence_id)
    if res is None or res.individual_id != ind_id:
        raise HTTPException(status_code=404, detail="Kayıt bulunamadı")
    db.delete(res)
    ind = db.get(Individual, ind_id)
    if ind is not None:
        log_activity(db, user, "residence_removed", ind)
    db.commit()
