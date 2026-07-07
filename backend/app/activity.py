"""Anasayfa haber akışı için aktivite kaydı."""
from sqlalchemy.orm import Session

from .models import ActivityLog, Individual, User


def log_activity(
    db: Session,
    user: User | None,
    action: str,
    individual: Individual | None = None,
    detail: str = "",
) -> None:
    """Akışa bir satır ekler; commit çağıranın sorumluluğundadır."""
    person_name = ""
    if individual is not None:
        person_name = f"{individual.first_name} {individual.last_name}".strip() or "(isimsiz)"
    db.add(ActivityLog(
        user_id=user.id if user else None,
        user_name=(user.full_name or user.email) if user else "",
        action=action,
        individual_id=individual.id if individual else None,
        individual_name=person_name,
        detail=detail[:500],
    ))
