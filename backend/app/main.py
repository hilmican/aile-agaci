import os

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text

from .config import settings
from .database import Base, SessionLocal, engine, wait_for_db
from .gedcom import clean_text
from .models import Individual, Spouse, User
from .routers import (
    auth, bulk, dashboard, dna, families, gedcom_router, individuals, map_router, users,
)
from .security import hash_password

app = FastAPI(title="Baycan Aile Ağacı", version="1.0.0")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def seed_admin() -> None:
    with SessionLocal() as db:
        has_admin = db.scalar(select(User).where(User.role == "admin"))
        if has_admin:
            return
        admin = User(
            email=settings.admin_email.lower().strip(),
            full_name=settings.admin_name,
            role="admin",
            hashed_password=hash_password(settings.admin_password),
        )
        db.add(admin)
        db.commit()


def cleanup_imported_text() -> None:
    """Daha önce içe aktarılmış kayıtlardaki HTML entity/tag kalıntılarını
    temizler (&Ccedil;anakkale -> Çanakkale). İdempotent: temiz veri değişmez."""
    text_fields = ("first_name", "last_name", "maiden_name",
                   "birth_place", "death_place", "occupation")
    with SessionLocal() as db:
        changed = 0
        for ind in db.scalars(select(Individual)).all():
            for f in text_fields:
                val = getattr(ind, f) or ""
                new = clean_text(val)
                if new != val:
                    setattr(ind, f, new)
                    changed += 1
            notes = ind.notes or ""
            new_notes = clean_text(notes, strip_tags=True)
            if new_notes != notes:
                ind.notes = new_notes
                changed += 1
        for sp in db.scalars(select(Spouse)).all():
            val = sp.marriage_place or ""
            new = clean_text(val)
            if new != val:
                sp.marriage_place = new
                changed += 1
        if changed:
            db.commit()


def ensure_schema() -> None:
    """Additif şema göçü: create_all yeni tablolar açar ama mevcut tablolara
    sütun EKLEMEZ. Modelde sonradan eklenen sütunları verileri koruyarak
    (DROP yok) ekler. Idempotent — 'IF NOT EXISTS' sayesinde tekrar çalışabilir."""
    alters = [
        "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS phone VARCHAR(100) NOT NULL DEFAULT ''",
        "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS email VARCHAR(255) NOT NULL DEFAULT ''",
        "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS address VARCHAR(500) NOT NULL DEFAULT ''",
        "ALTER TABLE residences ADD COLUMN IF NOT EXISTS period_start VARCHAR(100) NOT NULL DEFAULT ''",
        "ALTER TABLE residences ADD COLUMN IF NOT EXISTS period_end VARCHAR(100) NOT NULL DEFAULT ''",
        "ALTER TABLE residences ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION",
        "ALTER TABLE residences ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION",
        "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS birth_lat DOUBLE PRECISION",
        "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS birth_lng DOUBLE PRECISION",
        "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS death_lat DOUBLE PRECISION",
        "ALTER TABLE individuals ADD COLUMN IF NOT EXISTS death_lng DOUBLE PRECISION",
        "ALTER TABLE families ADD COLUMN IF NOT EXISTS emblem VARCHAR(120) NOT NULL DEFAULT ''",
        "ALTER TABLE families ALTER COLUMN emblem TYPE VARCHAR(120)",
        # Eski serbest 'period' değerini başlangıç sütununa taşı (yalnız boşsa).
        "UPDATE residences SET period_start = period WHERE period_start = '' AND period <> ''",
    ]
    with engine.begin() as conn:
        for stmt in alters:
            conn.execute(text(stmt))


@app.on_event("startup")
def on_startup() -> None:
    wait_for_db()
    Base.metadata.create_all(bind=engine)
    ensure_schema()
    os.makedirs(settings.upload_dir, exist_ok=True)
    seed_admin()
    cleanup_imported_text()


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(individuals.router)
app.include_router(gedcom_router.router)
app.include_router(dashboard.router)
app.include_router(families.router)
app.include_router(map_router.router)
app.include_router(bulk.router)
app.include_router(dna.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


def _build_id() -> str:
    path = os.path.join(os.path.dirname(__file__), "..", "build_id.txt")
    try:
        with open(path) as f:
            return f.read().strip() or "dev"
    except OSError:
        return "dev"


BUILD_ID = _build_id()


@app.get("/api/version")
def version():
    return {
        "build": BUILD_ID,
        "version": app.version,
        "gedcom_import": settings.allow_gedcom_import,
    }


# Uploaded images
app.mount("/uploads", StaticFiles(directory=settings.upload_dir, check_dir=False), name="uploads")


# Frontend (SPA) — mounted last so API routes take precedence.
@app.get("/")
def index():
    # index.html'i her istekte taze döndür ve statik varlık URL'lerine build
    # numarasını göm (cache-busting). Böylece yeni deploy'da tarayıcı/CDN eski
    # app.js / style.css'i sunmaz — güncel index eski JS ile eşleşmez sorunu biter.
    with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as f:
        html = f.read().replace("__BUILD__", BUILD_ID)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, must-revalidate"})


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
