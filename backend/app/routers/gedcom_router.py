from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..activity import log_activity
from ..config import settings
from ..database import get_db
from ..gedcom import parse_gedcom
from ..models import Individual, ParentChild, Residence, Spouse, User
from ..schemas import ImportResult
from ..security import get_current_user, require_editor

router = APIRouter(prefix="/api/gedcom", tags=["gedcom"])


@router.post("/import", response_model=ImportResult)
async def import_gedcom(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(require_editor),
):
    if not settings.allow_gedcom_import:
        raise HTTPException(
            status_code=403,
            detail="GEDCOM içe aktarma kapalı. Mevcut veriyi ezme/mükerrer kayıt "
                   "riskine karşı devre dışı. Açmak için ALLOW_GEDCOM_IMPORT=true.",
        )
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")

    data = parse_gedcom(text)
    if not data.individuals:
        raise HTTPException(status_code=400, detail="GEDCOM dosyasında kişi bulunamadı")

    # Map GEDCOM xref -> new Individual.id
    xref_to_id: dict[str, int] = {}
    for xref, gi in data.individuals.items():
        ind = Individual(
            gedcom_id=xref,
            first_name=gi.first_name,
            last_name=gi.last_name,
            sex=gi.sex,
            birth_date=gi.birth_date,
            birth_place=gi.birth_place,
            death_date=gi.death_date,
            death_place=gi.death_place,
            occupation=gi.occupation,
            notes=gi.notes,
        )
        db.add(ind)
        db.flush()
        xref_to_id[xref] = ind.id

    pc_count = 0
    spouse_count = 0
    warnings = list(data.warnings)

    for fam in data.families.values():
        husband_id = xref_to_id.get(fam.husband) if fam.husband else None
        wife_id = xref_to_id.get(fam.wife) if fam.wife else None

        if husband_id and wife_id:
            a, b = sorted((husband_id, wife_id))
            exists = db.scalar(select(Spouse).where(Spouse.a_id == a, Spouse.b_id == b))
            if not exists:
                db.add(
                    Spouse(
                        a_id=a,
                        b_id=b,
                        marriage_date=fam.marriage_date,
                        marriage_place=fam.marriage_place,
                    )
                )
                spouse_count += 1

        for child_xref in fam.children:
            child_id = xref_to_id.get(child_xref)
            if child_id is None:
                warnings.append(f"Çocuk referansı bulunamadı: {child_xref}")
                continue
            for parent_id in (husband_id, wife_id):
                if parent_id:
                    db.add(ParentChild(parent_id=parent_id, child_id=child_id))
                    pc_count += 1

    log_activity(db, user, "gedcom_imported",
                 detail=f"{len(xref_to_id)} kişi, {pc_count} ebeveyn-çocuk bağı, {spouse_count} evlilik")
    db.commit()
    return ImportResult(
        individuals=len(xref_to_id),
        parent_child=pc_count,
        spouses=spouse_count,
        warnings=warnings[:50],
    )


@router.get("/export", response_class=PlainTextResponse)
def export_gedcom(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """Export the current tree back to a minimal GEDCOM 5.5.1 file."""
    individuals = db.scalars(select(Individual)).all()
    id_to_xref = {ind.id: f"@I{ind.id}@" for ind in individuals}

    lines = [
        "0 HEAD",
        "1 SOUR AileAgaci",
        "1 GEDC",
        "2 VERS 5.5.1",
        "2 FORM LINEAGE-LINKED",
        "1 CHAR UTF-8",
    ]

    for ind in individuals:
        lines.append(f"0 {id_to_xref[ind.id]} INDI")
        lines.append(f"1 NAME {ind.first_name} /{ind.last_name}/")
        if ind.sex in ("M", "F"):
            lines.append(f"1 SEX {ind.sex}")
        if ind.birth_date or ind.birth_place:
            lines.append("1 BIRT")
            if ind.birth_date:
                lines.append(f"2 DATE {ind.birth_date}")
            if ind.birth_place:
                lines.append(f"2 PLAC {ind.birth_place}")
        if ind.death_date or ind.death_place:
            lines.append("1 DEAT")
            if ind.death_date:
                lines.append(f"2 DATE {ind.death_date}")
            if ind.death_place:
                lines.append(f"2 PLAC {ind.death_place}")
        if ind.occupation:
            lines.append(f"1 OCCU {ind.occupation}")
        if ind.phone:
            lines.append(f"1 PHON {ind.phone}")
        if ind.email:
            lines.append(f"1 EMAIL {ind.email}")
        if ind.address:
            lines.append(f"1 ADDR {ind.address}")
        for res in db.scalars(
            select(Residence).where(Residence.individual_id == ind.id)
        ).all():
            lines.append("1 RESI")
            if res.place:
                lines.append(f"2 PLAC {res.place}")
            if res.period:
                lines.append(f"2 DATE {res.period}")
            if res.note:
                lines.append(f"2 NOTE {res.note}")

    # Build families from spouse + parent_child edges.
    fam_index = 0
    spouses = db.scalars(select(Spouse)).all()
    parent_children = db.scalars(select(ParentChild)).all()
    children_by_parent: dict[int, list[int]] = {}
    for pc in parent_children:
        children_by_parent.setdefault(pc.parent_id, []).append(pc.child_id)

    for sp in spouses:
        fam_index += 1
        lines.append(f"0 @F{fam_index}@ FAM")
        if sp.a_id in id_to_xref:
            lines.append(f"1 HUSB {id_to_xref[sp.a_id]}")
        if sp.b_id in id_to_xref:
            lines.append(f"1 WIFE {id_to_xref[sp.b_id]}")
        shared = set(children_by_parent.get(sp.a_id, [])) & set(children_by_parent.get(sp.b_id, []))
        for child_id in sorted(shared):
            if child_id in id_to_xref:
                lines.append(f"1 CHIL {id_to_xref[child_id]}")
        if sp.marriage_date or sp.marriage_place:
            lines.append("1 MARR")
            if sp.marriage_date:
                lines.append(f"2 DATE {sp.marriage_date}")
            if sp.marriage_place:
                lines.append(f"2 PLAC {sp.marriage_place}")

    lines.append("0 TRLR")
    content = "\n".join(lines) + "\n"
    return PlainTextResponse(
        content,
        headers={"Content-Disposition": "attachment; filename=aile-agaci.ged"},
    )
