"""Coğrafi zaman haritası: kişilerin yaşadıkları yerleri koordinata çevirip
zaman aralıklarıyla döndürür. Yer adları uygulama içi il tablosuyla eşlenir
(dış geocoding yok)."""
import re
from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Individual, Residence, User
from ..security import get_current_user

router = APIRouter(prefix="/api/map", tags=["map"])

# Türkiye 81 il (yaklaşık merkez koordinatları) + birkaç yaygın varyant.
PROVINCES: dict[str, tuple[float, float]] = {
    "adana": (37.00, 35.32), "adiyaman": (37.76, 38.28), "afyonkarahisar": (38.76, 30.54),
    "afyon": (38.76, 30.54), "agri": (39.72, 43.05), "amasya": (40.65, 35.83),
    "ankara": (39.93, 32.86), "antalya": (36.90, 30.70), "artvin": (41.18, 41.82),
    "aydin": (37.85, 27.84), "balikesir": (39.65, 27.89), "bilecik": (40.15, 29.98),
    "bingol": (38.88, 40.50), "bitlis": (38.40, 42.11), "bolu": (40.74, 31.61),
    "burdur": (37.72, 30.29), "bursa": (40.19, 29.06), "canakkale": (40.15, 26.41),
    "cankiri": (40.60, 33.62), "corum": (40.55, 34.95), "denizli": (37.78, 29.09),
    "diyarbakir": (37.91, 40.24), "edirne": (41.68, 26.56), "elazig": (38.68, 39.22),
    "erzincan": (39.75, 39.49), "erzurum": (39.90, 41.27), "eskisehir": (39.78, 30.52),
    "gaziantep": (37.07, 37.38), "antep": (37.07, 37.38), "giresun": (40.91, 38.39),
    "gumushane": (40.46, 39.48), "hakkari": (37.57, 43.74), "hatay": (36.20, 36.16),
    "isparta": (37.76, 30.55), "mersin": (36.81, 34.64), "icel": (36.81, 34.64),
    "istanbul": (41.01, 28.98), "izmir": (38.42, 27.14), "kars": (40.60, 43.10),
    "kastamonu": (41.39, 33.78), "kayseri": (38.73, 35.49), "kirklareli": (41.74, 27.22),
    "kirsehir": (39.15, 34.16), "kocaeli": (40.85, 29.88), "izmit": (40.85, 29.88),
    "konya": (37.87, 32.48), "kutahya": (39.42, 29.98), "malatya": (38.36, 38.31),
    "manisa": (38.61, 27.43), "kahramanmaras": (37.58, 36.93), "maras": (37.58, 36.93),
    "mardin": (37.31, 40.74), "mugla": (37.22, 28.36), "mus": (38.73, 41.49),
    "nevsehir": (38.62, 34.71), "nigde": (37.97, 34.68), "ordu": (40.98, 37.88),
    "rize": (41.02, 40.52), "sakarya": (40.76, 30.38), "adapazari": (40.76, 30.38),
    "samsun": (41.29, 36.33), "siirt": (37.93, 41.94), "sinop": (42.03, 35.15),
    "sivas": (39.75, 37.02), "tekirdag": (40.98, 27.51), "tokat": (40.31, 36.55),
    "trabzon": (41.00, 39.72), "tunceli": (39.11, 39.55), "sanliurfa": (37.17, 38.79),
    "urfa": (37.17, 38.79), "usak": (38.68, 29.41), "van": (38.49, 43.38),
    "yozgat": (39.82, 34.81), "zonguldak": (41.45, 31.79), "aksaray": (38.37, 34.03),
    "bayburt": (40.26, 40.22), "karaman": (37.18, 33.22), "kirikkale": (39.85, 33.51),
    "batman": (37.88, 41.13), "sirnak": (37.52, 42.46), "bartin": (41.64, 32.34),
    "ardahan": (41.11, 42.70), "igdir": (39.92, 44.04), "yalova": (40.65, 29.28),
    "karabuk": (41.20, 32.63), "kilis": (36.72, 37.12), "osmaniye": (37.07, 36.25),
    "duzce": (40.84, 31.16),
    # Birkaç yurt dışı yaygın yer
    "almanya": (51.16, 10.45), "germany": (51.16, 10.45),
    "abd": (39.83, -98.58), "amerika": (39.83, -98.58),
}

# Türkçe karakterleri sadeleştir (İstanbul/İZMİR -> istanbul/izmir eşleşsin).
# Büyük 'İ' ve 'I' Python lower()'da sorun çıkardığı için önce çeviriyoruz.
_TR = str.maketrans(
    "çğıöşüâîûÇĞİÖŞÜÂÎÛI",
    "cgiosuaiucgiosuaiui",
)


def _norm(token: str) -> str:
    return token.translate(_TR).lower().replace("̇", "")


def geocode(place: str) -> tuple[float, float] | None:
    """Yer metnindeki ilk tanınan ile göre koordinat. 'Trabzon/Araklı/...' -> Trabzon."""
    if not place:
        return None
    tokens = [t for t in re.split(r"[\/,\-\s]+", place) if t]
    for tok in tokens:
        hit = PROVINCES.get(_norm(tok))
        if hit:
            return hit
    return None


def _year(s: str) -> int | None:
    m = re.search(r"\d{3,4}", s or "")
    return int(m.group(0)) if m else None


@router.get("/timeline")
def timeline(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    this_year = date.today().year
    people_out = []
    unresolved: set[str] = set()
    min_year, max_year = this_year, 0

    residences: dict[int, list[Residence]] = {}
    for r in db.scalars(select(Residence)).all():
        residences.setdefault(r.individual_id, []).append(r)

    for ind in db.scalars(select(Individual)).all():
        birth_y = _year(ind.birth_date)
        death_y = _year(ind.death_date)

        # (yıl, yer) noktaları
        points: list[tuple[int, str]] = []
        if birth_y and ind.birth_place:
            points.append((birth_y, ind.birth_place))
        for r in residences.get(ind.id, []):
            yr = r.year_from or _year(r.start)
            if yr and r.place:
                points.append((yr, r.place))
        if death_y and ind.death_place:
            points.append((death_y, ind.death_place))

        # Geocode + sırala
        resolved: list[tuple[int, float, float]] = []
        for yr, place in sorted(points):
            gc = geocode(place)
            if gc:
                resolved.append((yr, gc[0], gc[1]))
            else:
                unresolved.add(place.split("/")[0].strip())
        if not resolved:
            continue

        end_life = death_y or this_year
        stays = []
        for i, (yr, lat, lng) in enumerate(resolved):
            to = resolved[i + 1][0] if i + 1 < len(resolved) else end_life
            stays.append({"lat": lat, "lng": lng, "from": yr, "to": max(to, yr)})

        ymin = resolved[0][0]
        ymax = max(end_life, resolved[-1][0])
        min_year = min(min_year, ymin)
        max_year = max(max_year, ymax)
        people_out.append({
            "id": ind.id,
            "name": f"{ind.first_name} {ind.last_name}".strip() or "(isimsiz)",
            "sex": ind.sex,
            "birth_year": birth_y,
            "death_year": death_y,
            "stays": stays,
        })

    if not people_out:
        min_year, max_year = this_year - 100, this_year
    return {
        "min_year": min_year,
        "max_year": max_year,
        "people": people_out,
        "unresolved": sorted(unresolved),
    }
