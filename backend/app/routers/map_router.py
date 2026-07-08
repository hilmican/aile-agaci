"""Coğrafi zaman haritası: kişilerin yaşadıkları yerleri koordinata çevirip
zaman aralıklarıyla döndürür. Yer adları uygulama içi il tablosuyla eşlenir
(dış geocoding yok)."""
import re
from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Family, Individual, Residence, User
from ..security import get_current_user
from .families import compute_memberships

router = APIRouter(prefix="/api/map", tags=["map"])

# Yer sözlükleri. Her giriş normalize edilmiş ad -> (lat, lng).
# Eşleşmede en SPESİFİK seviye kazanır: 0=şehir, 1=il/eyalet, 2=ülke.

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
}

# ABD eyaletleri (merkez yaklaşık) — çok kelimeliler normalize hâliyle.
US_STATES: dict[str, tuple[float, float]] = {
    "alabama": (32.81, -86.79), "alaska": (61.37, -152.40), "arizona": (33.73, -111.43),
    "arkansas": (34.97, -92.37), "california": (36.12, -119.68), "kaliforniya": (36.12, -119.68),
    "colorado": (39.06, -105.31), "connecticut": (41.60, -72.76), "delaware": (39.32, -75.51),
    "florida": (27.77, -81.69), "georgia": (33.04, -83.64), "hawaii": (21.09, -157.50),
    "idaho": (44.24, -114.48), "illinois": (40.35, -88.99), "indiana": (39.85, -86.26),
    "iowa": (42.01, -93.21), "kansas": (38.53, -96.73), "kentucky": (37.67, -84.67),
    "louisiana": (31.17, -91.87), "maine": (44.69, -69.38), "maryland": (39.06, -76.80),
    "massachusetts": (42.23, -71.53), "michigan": (43.33, -84.54), "minnesota": (45.69, -93.90),
    "mississippi": (32.74, -89.68), "missouri": (38.46, -92.29), "montana": (46.92, -110.45),
    "nebraska": (41.13, -98.27), "nevada": (38.31, -117.06), "new hampshire": (43.45, -71.56),
    "new jersey": (40.30, -74.52), "new mexico": (34.84, -106.25), "new york": (42.17, -74.95),
    "north carolina": (35.63, -79.81), "north dakota": (47.53, -99.78), "ohio": (40.39, -82.76),
    "oklahoma": (35.57, -96.93), "oregon": (44.57, -122.07), "pennsylvania": (40.59, -77.21),
    "rhode island": (41.68, -71.51), "south carolina": (33.86, -80.95),
    "south dakota": (44.30, -99.44), "tennessee": (35.75, -86.69), "texas": (31.05, -97.56),
    "teksas": (31.05, -97.56), "utah": (40.15, -111.86), "vermont": (44.05, -72.71),
    "virginia": (37.77, -78.17), "washington": (47.40, -121.49), "west virginia": (38.49, -80.95),
    "wisconsin": (44.27, -89.62), "wyoming": (42.76, -107.30),
}

# Yaygın ülkeler ve varyantları.
COUNTRIES: dict[str, tuple[float, float]] = {
    "turkiye": (39.0, 35.0), "turkey": (39.0, 35.0),
    "us": (39.83, -98.58), "usa": (39.83, -98.58), "united states": (39.83, -98.58),
    "abd": (39.83, -98.58), "amerika": (39.83, -98.58), "america": (39.83, -98.58),
    "almanya": (51.16, 10.45), "germany": (51.16, 10.45), "deutschland": (51.16, 10.45),
    "fransa": (46.6, 2.2), "france": (46.6, 2.2),
    "ingiltere": (52.5, -1.5), "england": (52.5, -1.5), "uk": (54.0, -2.0),
    "birlesik krallik": (54.0, -2.0), "united kingdom": (54.0, -2.0),
    "hollanda": (52.2, 5.3), "netherlands": (52.2, 5.3),
    "belcika": (50.5, 4.5), "belgium": (50.5, 4.5),
    "isvicre": (46.8, 8.2), "switzerland": (46.8, 8.2),
    "avusturya": (47.5, 14.5), "austria": (47.5, 14.5),
    "italya": (42.8, 12.8), "italy": (42.8, 12.8),
    "ispanya": (40.0, -3.7), "spain": (40.0, -3.7),
    "isvec": (62.0, 15.0), "sweden": (62.0, 15.0),
    "norvec": (61.0, 8.0), "norway": (61.0, 8.0),
    "danimarka": (56.0, 10.0), "denmark": (56.0, 10.0),
    "kanada": (56.1, -106.3), "canada": (56.1, -106.3),
    "avustralya": (-25.3, 133.8), "australia": (-25.3, 133.8),
    "rusya": (61.5, 105.3), "russia": (61.5, 105.3),
    "azerbaycan": (40.1, 47.6), "azerbaijan": (40.1, 47.6),
    "yunanistan": (39.1, 21.8), "greece": (39.1, 21.8),
    "bulgaristan": (42.7, 25.5), "bulgaria": (42.7, 25.5),
    "suriye": (35.0, 38.0), "syria": (35.0, 38.0),
    "irak": (33.2, 43.7), "iraq": (33.2, 43.7),
    "iran": (32.4, 53.7),
    "suudi arabistan": (24.0, 45.0), "saudi arabia": (24.0, 45.0),
    "katar": (25.3, 51.2), "qatar": (25.3, 51.2),
    "bae": (24.0, 54.0), "uae": (24.0, 54.0),
    "misir": (26.8, 30.8), "egypt": (26.8, 30.8),
    "kibris": (35.1, 33.4), "cyprus": (35.1, 33.4),
}

# Birkaç büyük dünya şehri (en spesifik seviye).
CITIES: dict[str, tuple[float, float]] = {
    "new york city": (40.71, -74.01), "los angeles": (34.05, -118.24),
    "chicago": (41.88, -87.63), "london": (51.51, -0.13), "londra": (51.51, -0.13),
    "paris": (48.86, 2.35), "berlin": (52.52, 13.40), "münih": (48.14, 11.58),
    "munih": (48.14, 11.58), "munich": (48.14, 11.58), "frankfurt": (50.11, 8.68),
    "köln": (50.94, 6.96), "koln": (50.94, 6.96), "cologne": (50.94, 6.96),
    "amsterdam": (52.37, 4.90), "brussels": (50.85, 4.35), "brüksel": (50.85, 4.35),
    "moskova": (55.76, 37.62), "moscow": (55.76, 37.62),
    "passaic": (40.86, -74.13), "passaic city": (40.86, -74.13),
}

# Ad -> (lat, lng, seviye) birleşik indeks; seviye küçükse daha spesifik.
PLACE_INDEX: dict[str, tuple[float, float, int]] = {}
for _d, _lvl in ((CITIES, 0), (PROVINCES, 1), (US_STATES, 1), (COUNTRIES, 2)):
    for _name, (_la, _lo) in _d.items():
        PLACE_INDEX.setdefault(_name, (_la, _lo, _lvl))

# Türkçe karakterleri sadeleştir (İstanbul/İZMİR -> istanbul/izmir eşleşsin).
# Büyük 'İ' ve 'I' Python lower()'da sorun çıkardığı için önce çeviriyoruz.
_TR = str.maketrans(
    "çğıöşüâîûÇĞİÖŞÜÂÎÛI",
    "cgiosuaiucgiosuaiui",
)


def _norm(token: str) -> str:
    return token.translate(_TR).lower().replace("̇", "")


def geocode(place: str) -> tuple[float, float] | None:
    """Yer metnindeki en SPESİFİK tanınan yere göre koordinat.
    'US, New Jersey, Passaic City' -> New Jersey/Passaic; 'Trabzon/Araklı' -> Trabzon.
    Segmentleri (virgül/eğik çizgi) bütün olarak dener ('New Jersey'), sonra
    tek kelimeleri; şehir > il/eyalet > ülke önceliğiyle döner."""
    if not place:
        return None
    candidates: list[str] = []
    for seg in re.split(r"[\/,;]", place):
        seg = seg.strip()
        if not seg:
            continue
        candidates.append(_norm(seg))          # bütün segment ("new jersey")
        for w in seg.split():                  # tek kelimeler ("trabzon")
            candidates.append(_norm(w))
    best: tuple[int, float, float] | None = None
    for c in candidates:
        hit = PLACE_INDEX.get(c)
        if hit and (best is None or hit[2] < best[0]):
            best = (hit[2], hit[0], hit[1])
    return (best[1], best[2]) if best else None


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

    # Kişi -> ait olduğu aile kolları (miras/evlilik dahil)
    memberships = compute_memberships(db)
    fam_of: dict[int, list[int]] = {}
    for fid, membs in memberships.items():
        for pid in membs:
            fam_of.setdefault(pid, []).append(fid)
    families_meta = [
        {"id": f.id, "name": f.name, "emblem": f.emblem}
        for f in db.scalars(select(Family)).all()
    ]

    for ind in db.scalars(select(Individual)).all():
        birth_y = _year(ind.birth_date)
        death_y = _year(ind.death_date)

        # (yıl, yer, saklı_koordinat) noktaları. Saklı koordinat varsa geocode
        # tablosuna düşmeden onu kullan (Nominatim ile seçilen kesin konum).
        points: list[tuple[int, str, tuple[float, float] | None]] = []
        if birth_y and (ind.birth_place or ind.birth_lat is not None):
            coord = (ind.birth_lat, ind.birth_lng) if ind.birth_lat is not None else None
            points.append((birth_y, ind.birth_place, coord))
        for r in residences.get(ind.id, []):
            yr = r.year_from or _year(r.start)
            if yr and (r.place or r.lat is not None):
                coord = (r.lat, r.lng) if r.lat is not None else None
                points.append((yr, r.place, coord))
        if death_y and (ind.death_place or ind.death_lat is not None):
            coord = (ind.death_lat, ind.death_lng) if ind.death_lat is not None else None
            points.append((death_y, ind.death_place, coord))

        # Koordinat çöz (saklı > geocode tablosu) + sırala
        resolved: list[tuple[int, float, float]] = []
        for yr, place, coord in sorted(points, key=lambda x: x[0]):
            gc = coord or geocode(place)
            if gc:
                resolved.append((yr, gc[0], gc[1]))
            elif place:
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
            "families": fam_of.get(ind.id, []),
        })

    if not people_out:
        min_year, max_year = this_year - 100, this_year
    return {
        "min_year": min_year,
        "max_year": max_year,
        "people": people_out,
        "families": families_meta,
        "unresolved": sorted(unresolved),
    }
