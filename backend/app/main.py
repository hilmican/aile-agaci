import os

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from .config import settings
from .database import Base, SessionLocal, engine, wait_for_db
from .models import User
from .routers import auth, gedcom_router, individuals, users
from .security import hash_password

app = FastAPI(title="Aile Ağacı", version="1.0.0")

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


@app.on_event("startup")
def on_startup() -> None:
    wait_for_db()
    Base.metadata.create_all(bind=engine)
    os.makedirs(settings.upload_dir, exist_ok=True)
    seed_admin()


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(individuals.router)
app.include_router(gedcom_router.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Uploaded images
app.mount("/uploads", StaticFiles(directory=settings.upload_dir, check_dir=False), name="uploads")


# Frontend (SPA) — mounted last so API routes take precedence.
@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
