from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr


# ---- Auth / Users ----
class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserBase(BaseModel):
    email: EmailStr
    full_name: str = ""
    role: str = "viewer"


class UserCreate(UserBase):
    password: str


class UserUpdate(BaseModel):
    full_name: str | None = None
    role: str | None = None
    password: str | None = None


class UserOut(UserBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime


# ---- Individuals ----
class IndividualBase(BaseModel):
    first_name: str = ""
    last_name: str = ""
    maiden_name: str = ""
    sex: str = "U"
    birth_date: str = ""
    birth_place: str = ""
    death_date: str = ""
    death_place: str = ""
    occupation: str = ""
    notes: str = ""


class IndividualCreate(IndividualBase):
    pass


class IndividualUpdate(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    maiden_name: str | None = None
    sex: str | None = None
    birth_date: str | None = None
    birth_place: str | None = None
    death_date: str | None = None
    death_place: str | None = None
    occupation: str | None = None
    notes: str | None = None


class MediaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    filename: str
    original_name: str
    content_type: str
    caption: str
    uploaded_at: datetime
    url: str = ""


class IndividualSummary(IndividualBase):
    model_config = ConfigDict(from_attributes=True)
    id: int


class SpouseLink(BaseModel):
    person: IndividualSummary
    marriage_date: str = ""
    marriage_place: str = ""


class AnecdoteCreate(BaseModel):
    title: str = ""
    text: str


class AnecdoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    individual_id: int
    author_name: str = ""
    title: str = ""
    text: str = ""
    created_at: datetime | None = None


class IndividualDetail(IndividualSummary):
    parents: list[IndividualSummary] = []
    children: list[IndividualSummary] = []
    spouses: list[SpouseLink] = []
    media: list[MediaOut] = []
    anecdotes: list[AnecdoteOut] = []


# ---- Relationships ----
class RelationshipCreate(BaseModel):
    # type: parent | child | spouse
    type: str
    related_id: int
    marriage_date: str = ""
    marriage_place: str = ""


# ---- GEDCOM ----
class ImportResult(BaseModel):
    individuals: int
    parent_child: int
    spouses: int
    warnings: list[str] = []
