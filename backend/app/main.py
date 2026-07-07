import os

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .config import settings
from .database import Base, SessionLocal, engine, wait_for_db
from .gedcom import clean_text
from .models import Individual, Spouse, User
from .routers import auth, dashboard, gedcom_router, individuals, users
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


@app.on_event("startup")
def on_startup() -> None:
    wait_for_db()
    Base.metadata.create_all(bind=engine)
    os.makedirs(settings.upload_dir, exist_ok=True)
    seed_admin()
    cleanup_imported_text()


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(individuals.router)
app.include_router(gedcom_router.router)
app.include_router(dashboard.router)


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
    return {"build": BUILD_ID, "version": app.version}


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
