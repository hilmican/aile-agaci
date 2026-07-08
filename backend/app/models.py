from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255), default="")
    hashed_password: Mapped[str] = mapped_column(String(255))
    # role: admin | editor | viewer
    role: Mapped[str] = mapped_column(String(20), default="viewer")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Individual(Base):
    __tablename__ = "individuals"

    id: Mapped[int] = mapped_column(primary_key=True)
    gedcom_id: Mapped[str | None] = mapped_column(String(50), index=True, nullable=True)
    first_name: Mapped[str] = mapped_column(String(255), default="")
    last_name: Mapped[str] = mapped_column(String(255), default="")
    maiden_name: Mapped[str] = mapped_column(String(255), default="")
    sex: Mapped[str] = mapped_column(String(1), default="U")  # M | F | U
    birth_date: Mapped[str] = mapped_column(String(100), default="")
    birth_place: Mapped[str] = mapped_column(String(255), default="")
    birth_lat: Mapped[float | None] = mapped_column(nullable=True)
    birth_lng: Mapped[float | None] = mapped_column(nullable=True)
    death_date: Mapped[str] = mapped_column(String(100), default="")
    death_place: Mapped[str] = mapped_column(String(255), default="")
    death_lat: Mapped[float | None] = mapped_column(nullable=True)
    death_lng: Mapped[float | None] = mapped_column(nullable=True)
    occupation: Mapped[str] = mapped_column(String(255), default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    # İletişim bilgileri (yaşayanlar için pratik erişim)
    phone: Mapped[str] = mapped_column(String(100), default="")
    email: Mapped[str] = mapped_column(String(255), default="")
    address: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    media: Mapped[list["Media"]] = relationship(
        back_populates="individual", cascade="all, delete-orphan"
    )


class ParentChild(Base):
    __tablename__ = "parent_child"
    __table_args__ = (UniqueConstraint("parent_id", "child_id", name="uq_parent_child"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int] = mapped_column(
        ForeignKey("individuals.id", ondelete="CASCADE"), index=True
    )
    child_id: Mapped[int] = mapped_column(
        ForeignKey("individuals.id", ondelete="CASCADE"), index=True
    )


class Spouse(Base):
    __tablename__ = "spouses"
    __table_args__ = (UniqueConstraint("a_id", "b_id", name="uq_spouse_pair"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    a_id: Mapped[int] = mapped_column(
        ForeignKey("individuals.id", ondelete="CASCADE"), index=True
    )
    b_id: Mapped[int] = mapped_column(
        ForeignKey("individuals.id", ondelete="CASCADE"), index=True
    )
    marriage_date: Mapped[str] = mapped_column(String(100), default="")
    marriage_place: Mapped[str] = mapped_column(String(255), default="")


class Family(Base):
    """Soyaddan bağımsız aile kolu/kümesi: Vasiloğulları, Salehler, Mitçarliler…"""
    __tablename__ = "families"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    emblem: Mapped[str] = mapped_column(String(40), default="")  # arma anahtarı


class IndividualFamily(Base):
    """Kişi ↔ aile kolu (çoklu: bir kişi birden fazla kola ait olabilir)."""
    __tablename__ = "individual_families"
    __table_args__ = (UniqueConstraint("individual_id", "family_id", name="uq_individual_family"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    individual_id: Mapped[int] = mapped_column(
        ForeignKey("individuals.id", ondelete="CASCADE"), index=True
    )
    family_id: Mapped[int] = mapped_column(
        ForeignKey("families.id", ondelete="CASCADE"), index=True
    )


class Residence(Base):
    """Kişinin yaşadığı yer, zaman aralığıyla. Bitiş boşsa hâlâ orada yaşıyor.
    year_from sıralama anahtarı; place serbest metin."""
    __tablename__ = "residences"

    id: Mapped[int] = mapped_column(primary_key=True)
    individual_id: Mapped[int] = mapped_column(
        ForeignKey("individuals.id", ondelete="CASCADE"), index=True
    )
    place: Mapped[str] = mapped_column(String(255), default="")
    lat: Mapped[float | None] = mapped_column(nullable=True)
    lng: Mapped[float | None] = mapped_column(nullable=True)
    start: Mapped[str] = mapped_column("period_start", String(100), default="")
    end: Mapped[str] = mapped_column("period_end", String(100), default="")
    year_from: Mapped[int | None] = mapped_column(nullable=True)  # sıralama anahtarı
    period: Mapped[str] = mapped_column(String(100), default="")  # legacy (backfill için)
    note: Mapped[str] = mapped_column(String(500), default="")


class Anecdote(Base):
    """Kişiye bağlı, yazarlı ve tarihli kısa hikâye/anı."""
    __tablename__ = "anecdotes"

    id: Mapped[int] = mapped_column(primary_key=True)
    individual_id: Mapped[int] = mapped_column(
        ForeignKey("individuals.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    author_name: Mapped[str] = mapped_column(String(255), default="")
    title: Mapped[str] = mapped_column(String(255), default="")
    text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ActivityLog(Base):
    """Anasayfa haber akışı: kim, ne yaptı, kimin üzerinde."""
    __tablename__ = "activity_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    user_name: Mapped[str] = mapped_column(String(255), default="")
    # action: person_created | person_updated | person_deleted | relationship_added
    # | relationship_removed | media_added | media_deleted | anecdote_added
    # | anecdote_deleted | gedcom_imported
    action: Mapped[str] = mapped_column(String(40))
    individual_id: Mapped[int | None] = mapped_column(
        ForeignKey("individuals.id", ondelete="SET NULL"), nullable=True
    )
    individual_name: Mapped[str] = mapped_column(String(255), default="")
    detail: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class Media(Base):
    __tablename__ = "media"

    id: Mapped[int] = mapped_column(primary_key=True)
    individual_id: Mapped[int] = mapped_column(
        ForeignKey("individuals.id", ondelete="CASCADE"), index=True
    )
    filename: Mapped[str] = mapped_column(String(255))
    original_name: Mapped[str] = mapped_column(String(255), default="")
    content_type: Mapped[str] = mapped_column(String(100), default="")
    caption: Mapped[str] = mapped_column(String(255), default="")
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    individual: Mapped["Individual"] = relationship(back_populates="media")
