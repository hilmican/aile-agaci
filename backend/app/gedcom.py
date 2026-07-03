"""A small, dependency-free GEDCOM 5.5.1 parser.

Handles the subset produced by MyHeritage/common tools: INDI and FAM records
with NAME, SEX, BIRT/DEAT (DATE/PLAC), OCCU, HUSB/WIFE/CHIL, MARR.
It is deliberately forgiving — unknown tags are ignored rather than failing.
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass, field

_TAG_RE = re.compile(r"<[^>]+>")


def clean_text(value: str, strip_tags: bool = False) -> str:
    """Decode HTML entities (&Ccedil; -> Ç) and optionally strip markup.

    MyHeritage and similar tools export NOTE (and sometimes other) fields with
    HTML entities and <p> tags; we want plain readable text in the app.
    """
    out = value
    for _ in range(3):  # handles double-encoded entities like &amp;Ccedil;
        new = html.unescape(out)
        if new == out:
            break
        out = new
    if strip_tags:
        out = _TAG_RE.sub(" ", out)
    return " ".join(out.split())


@dataclass
class GedLine:
    level: int
    tag: str
    xref: str | None
    value: str


def _parse_line(raw: str) -> GedLine | None:
    raw = raw.rstrip("\r\n")
    if not raw.strip():
        return None
    parts = raw.split(" ", 2)
    try:
        level = int(parts[0])
    except ValueError:
        return None
    if len(parts) == 1:
        return None
    token = parts[1]
    rest = parts[2] if len(parts) > 2 else ""
    # Records start with an xref: "0 @I1@ INDI"
    if token.startswith("@") and token.endswith("@"):
        xref = token
        sub = rest.split(" ", 1)
        tag = sub[0] if sub else ""
        value = sub[1] if len(sub) > 1 else ""
        return GedLine(level, tag, xref, value)
    return GedLine(level, token, None, rest)


@dataclass
class GedIndividual:
    xref: str
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


@dataclass
class GedFamily:
    xref: str
    husband: str | None = None
    wife: str | None = None
    children: list[str] = field(default_factory=list)
    marriage_date: str = ""
    marriage_place: str = ""


@dataclass
class GedcomData:
    individuals: dict[str, GedIndividual] = field(default_factory=dict)
    families: dict[str, GedFamily] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def _split_name(value: str) -> tuple[str, str]:
    """GEDCOM NAME is 'Given /Surname/'."""
    if "/" in value:
        before, _, after = value.partition("/")
        surname = after.split("/", 1)[0]
        return before.strip(), surname.strip()
    return value.strip(), ""


def parse_gedcom(text: str) -> GedcomData:
    data = GedcomData()
    lines = [pl for pl in (_parse_line(l) for l in text.splitlines()) if pl is not None]

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if line.level != 0:
            i += 1
            continue

        if line.tag == "INDI" and line.xref:
            ind = GedIndividual(xref=line.xref)
            i += 1
            context: str | None = None  # BIRT / DEAT while reading sub-lines
            while i < n and lines[i].level > 0:
                sub = lines[i]
                if sub.level == 1:
                    context = None
                    if sub.tag == "NAME":
                        given, surname = _split_name(sub.value)
                        ind.first_name = given
                        ind.last_name = surname
                    elif sub.tag == "SEX":
                        val = sub.value.strip().upper()[:1]
                        ind.sex = val if val in ("M", "F") else "U"
                    elif sub.tag == "OCCU":
                        ind.occupation = sub.value.strip()
                    elif sub.tag in ("BIRT", "DEAT"):
                        context = sub.tag
                    elif sub.tag == "NOTE":
                        ind.notes = (ind.notes + " " + sub.value).strip()
                elif sub.level == 2:
                    if sub.tag == "DATE" and context == "BIRT":
                        ind.birth_date = sub.value.strip()
                    elif sub.tag == "PLAC" and context == "BIRT":
                        ind.birth_place = sub.value.strip()
                    elif sub.tag == "DATE" and context == "DEAT":
                        ind.death_date = sub.value.strip()
                    elif sub.tag == "PLAC" and context == "DEAT":
                        ind.death_place = sub.value.strip()
                    elif sub.tag == "SURN":
                        ind.last_name = ind.last_name or sub.value.strip()
                    elif sub.tag == "GIVN":
                        ind.first_name = ind.first_name or sub.value.strip()
                i += 1
            ind.first_name = clean_text(ind.first_name)
            ind.last_name = clean_text(ind.last_name)
            ind.maiden_name = clean_text(ind.maiden_name)
            ind.birth_place = clean_text(ind.birth_place)
            ind.death_place = clean_text(ind.death_place)
            ind.occupation = clean_text(ind.occupation)
            ind.notes = clean_text(ind.notes, strip_tags=True)
            data.individuals[ind.xref] = ind
            continue

        if line.tag == "FAM" and line.xref:
            fam = GedFamily(xref=line.xref)
            i += 1
            context = None
            while i < n and lines[i].level > 0:
                sub = lines[i]
                if sub.level == 1:
                    context = None
                    if sub.tag == "HUSB":
                        fam.husband = sub.value.strip()
                    elif sub.tag == "WIFE":
                        fam.wife = sub.value.strip()
                    elif sub.tag == "CHIL":
                        fam.children.append(sub.value.strip())
                    elif sub.tag == "MARR":
                        context = "MARR"
                elif sub.level == 2 and context == "MARR":
                    if sub.tag == "DATE":
                        fam.marriage_date = sub.value.strip()
                    elif sub.tag == "PLAC":
                        fam.marriage_place = sub.value.strip()
                i += 1
            fam.marriage_place = clean_text(fam.marriage_place)
            data.families[fam.xref] = fam
            continue

        i += 1

    return data
