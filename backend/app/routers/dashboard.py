"""Anasayfa (dashboard): özet istatistikler, yaklaşan günler, veri sağlığı, akış."""
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import ActivityLog, Anecdote, Individual, Media, ParentChild, Spouse, User
from ..security import get_current_user
from .individuals import person_photo_url

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

TZ = ZoneInfo("Europe/Istanbul")

_MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
           "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}


def _parse_day_month_year(s: str) -> tuple[int | None, int | None, int | None]:
    """GEDCOM tarihinden (gün, ay, yıl) çıkar; eksikler None."""
    s = (s or "").strip().upper()
    if not s:
        return None, None, None
    m = re.search(r"\b(\d{1,2})\s+([A-Z]{3})\s+(\d{3,4})\b", s)
    if m and m.group(2) in _MONTHS:
        return int(m.group(1)), _MONTHS[m.group(2)], int(m.group(3))
    m = re.search(r"\b([A-Z]{3})\s+(\d{3,4})\b", s)
    if m and m.group(1) in _MONTHS:
        return None, _MONTHS[m.group(1)], int(m.group(2))
    m = re.search(r"\b(\d{3,4})\b", s)
    if m:
        return None, None, int(m.group(1))
    return None, None, None


def _next_occurrence(day: int, month: int, today: date) -> date | None:
    """Gün/ayın bugünden itibaren ilk yıldönümü."""
    for year in (today.year, today.year + 1):
        try:
            d = date(year, month, day)
        except ValueError:  # 29 Şubat gibi
            continue
        if d >= today:
            return d
    return None


def _person_ref(ind: Individual) -> dict:
    return {
        "id": ind.id,
        "name": f"{ind.first_name} {ind.last_name}".strip() or "(isimsiz)",
        "sex": ind.sex,
    }


@router.get("")
def dashboard(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    people = db.scalars(select(Individual)).all()
    today = datetime.now(TZ).date()

    # ---- İstatistikler ----
    total = len(people)
    males = sum(1 for p in people if p.sex == "M")
    females = sum(1 for p in people if p.sex == "F")
    marriages = db.scalar(select(func.count()).select_from(Spouse)) or 0
    with_photo = db.scalar(select(func.count(func.distinct(Media.individual_id)))) or 0
    anecdote_count = db.scalar(select(func.count()).select_from(Anecdote)) or 0

    oldest = None
    for p in people:
        _, _, year = _parse_day_month_year(p.birth_date)
        if year and (oldest is None or year < oldest[0]):
            oldest = (year, p)

    # Nesil sayısı: tepe atalardan en uzun ebeveyn->çocuk zinciri.
    child_map: dict[int, list[int]] = {}
    has_parent: set[int] = set()
    for pid, cid in db.execute(select(ParentChild.parent_id, ParentChild.child_id)).all():
        child_map.setdefault(pid, []).append(cid)
        has_parent.add(cid)
    ids = {p.id for p in people}
    roots = [i for i in ids if i not in has_parent]
    depth_memo: dict[int, int] = {}

    def depth_of(i: int, path: frozenset) -> int:
        if i in depth_memo:
            return depth_memo[i]
        best = 0
        for c in child_map.get(i, []):
            if c not in path:
                best = max(best, 1 + depth_of(c, path | {c}))
        depth_memo[i] = best
        return best

    generations = (max((depth_of(r, frozenset({r})) for r in roots), default=0) + 1) if roots else 0

    # ---- Yaklaşan günler (30 gün) ----
    upcoming = []
    horizon = today + timedelta(days=30)
    for p in people:
        alive = not (p.death_date or "").strip()
        b_day, b_mon, b_year = _parse_day_month_year(p.birth_date)
        if alive and b_day and b_mon:
            nxt = _next_occurrence(b_day, b_mon, today)
            if nxt and nxt <= horizon:
                upcoming.append({
                    "type": "birthday",
                    "date": nxt.isoformat(),
                    "days_left": (nxt - today).days,
                    "age": (nxt.year - b_year) if b_year else None,
                    "person": _person_ref(p),
                })
        if not alive:
            d_day, d_mon, d_year = _parse_day_month_year(p.death_date)
            if d_day and d_mon:
                nxt = _next_occurrence(d_day, d_mon, today)
                if nxt and nxt <= horizon:
                    upcoming.append({
                        "type": "memorial",
                        "date": nxt.isoformat(),
                        "days_left": (nxt - today).days,
                        "age": (nxt.year - d_year) if d_year else None,  # vefatın n. yılı
                        "person": _person_ref(p),
                    })
    upcoming.sort(key=lambda u: (u["days_left"], u["person"]["name"]))

    # ---- Veri sağlığı ----
    unnamed = [p for p in people if not (p.first_name or p.last_name).strip()]
    no_birth = [p for p in people if not (p.birth_date or "").strip()]
    no_sex = [p for p in people if p.sex not in ("M", "F")]
    parentless = [p for p in people if p.id not in has_parent]
    photoless_count = total - with_photo

    def refs(lst, cap=10):
        return [_person_ref(p) for p in lst[:cap]]

    filled_fields = 0
    field_total = 0
    for p in people:
        for v in (p.first_name or p.last_name, p.birth_date, p.sex if p.sex in ("M", "F") else ""):
            field_total += 1
            if str(v).strip():
                filled_fields += 1
    completeness = round(100 * filled_fields / field_total) if field_total else 100

    health = {
        "completeness": completeness,
        "issues": [
            {"key": "unnamed", "label": "İsimsiz kayıt", "count": len(unnamed), "people": refs(unnamed)},
            {"key": "no_birth", "label": "Doğum tarihi eksik", "count": len(no_birth), "people": refs(no_birth)},
            {"key": "no_sex", "label": "Cinsiyeti belirsiz", "count": len(no_sex), "people": refs(no_sex)},
            {"key": "parentless", "label": "Ebeveyni bağlanmamış", "count": len(parentless), "people": refs(parentless)},
            {"key": "no_photo", "label": "Fotoğrafı yok", "count": photoless_count, "people": []},
        ],
    }

    # ---- Haber akışı ----
    feed = [
        {
            "id": a.id,
            "action": a.action,
            "user": a.user_name,
            "individual_id": a.individual_id,
            "individual": a.individual_name,
            "detail": a.detail,
            "at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in db.scalars(
            select(ActivityLog).order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc()).limit(25)
        ).all()
    ]

    return {
        "stats": {
            "total": total,
            "males": males,
            "females": females,
            "marriages": marriages,
            "with_photo": with_photo,
            "anecdotes": anecdote_count,
            "generations": generations,
            "oldest": {"year": oldest[0], "person": _person_ref(oldest[1])} if oldest else None,
        },
        "upcoming": upcoming[:20],
        "health": health,
        "feed": feed,
    }


@router.get("/list/{kind}")
def dashboard_list(kind: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Dashboard kutularının detay listeleri: marriages | anecdotes | photos."""
    if kind == "marriages":
        items = []
        for sp in db.scalars(select(Spouse)).all():
            a = db.get(Individual, sp.a_id)
            b = db.get(Individual, sp.b_id)
            _, _, m_year = _parse_day_month_year(sp.marriage_date)
            # Sıralama yılı: evlilik yılı; yoksa çiftin doğum yıllarından tahmin
            # (~20 yaş sonrası). Hiç yıl bilgisi yoksa None → en sona.
            if m_year:
                sort_year = m_year
            else:
                bys = [y for y in (_parse_day_month_year(x.birth_date)[2] for x in (a, b) if x) if y]
                sort_year = (max(bys) + 20) if bys else None
            items.append({
                "a": _person_ref(a) if a else None,
                "b": _person_ref(b) if b else None,
                "date": sp.marriage_date,
                "place": sp.marriage_place,
                "_has": sort_year is not None,
                "_year": sort_year or 0,
                "name": (a.last_name if a else "") + (a.first_name if a else ""),
            })
        # En yeni evlilik en tepede (yıla göre azalan); yıl bilgisi olmayanlar sonda.
        items.sort(key=lambda x: (0 if x["_has"] else 1, -x["_year"], x["name"]))
        for x in items:
            x.pop("_has", None)
            x.pop("_year", None)
            x.pop("name", None)
        return {"kind": kind, "title": "Evlilikler", "items": items}

    if kind == "anecdotes":
        rows = db.scalars(
            select(Anecdote).order_by(Anecdote.created_at.desc(), Anecdote.id.desc())
        ).all()
        items = [{
            "id": a.id,
            "person": _person_ref(db.get(Individual, a.individual_id)) if a.individual_id else None,
            "title": a.title,
            "text": a.text,
            "author": a.author_name,
            "at": a.created_at.isoformat() if a.created_at else None,
        } for a in rows]
        return {"kind": kind, "title": "Anekdotlar", "items": items}

    if kind == "photos":
        photo_ids = db.scalars(select(Media.individual_id).distinct()).all()
        people = db.scalars(select(Individual).where(Individual.id.in_(photo_ids))).all() if photo_ids else []
        people = sorted(people, key=lambda p: (p.last_name, p.first_name))
        items = []
        for p in people:
            ref = _person_ref(p)
            ref["photo"] = person_photo_url(p)
            items.append(ref)
        return {"kind": kind, "title": "Fotoğraflı Kişiler", "items": items}

    return {"kind": kind, "title": "", "items": []}
