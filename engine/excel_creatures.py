from __future__ import annotations

import posixpath
import re
import zipfile
from pathlib import Path
from typing import Iterable
from xml.etree import ElementTree as ET

from engine.models import Card, Deck, Effect, EnemyTemplate, RangeInt


CREATURES_SHEET = "Creatures_Master"
ACTION_DECK_SHEET = "Action_Deck"
EXCEL_CORE_DECK_ID = "__excel_creature_action_deck__"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
SKILL_COLUMNS = ("Intelligence", "Alertness", "Stealth", "Social", "Arcana", "Athletics")
ACTION_COLUMNS = ("MISS", "A1", "A2", "A3", "A4", "A5", "S")
SIM_COVERAGE_FULL = "full"
SIM_COVERAGE_MANUAL = "manual"
SIM_COVERAGE_WARNING = "warning"
SIM_COVERAGE_ERROR = "error"


def load_creatures_from_workbook(workbook_path: Path, *, images_dir: Path) -> dict[str, EnemyTemplate]:
    workbook = _XlsxWorkbook(workbook_path)
    creature_rows = _rows_as_dicts(workbook.read_sheet(CREATURES_SHEET))
    action_deck = _parse_action_deck(_rows_as_dicts(workbook.read_sheet(ACTION_DECK_SHEET)))
    if not action_deck:
        raise ValueError(f"{ACTION_DECK_SHEET} must contain at least one action deck row")

    templates: dict[str, EnemyTemplate] = {}
    for row_number, row in creature_rows:
        creature_id = _clean(row.get("ID"))
        if not creature_id:
            continue
        template = _template_from_row(row_number, row, action_deck, images_dir=images_dir)
        if template.id in templates:
            raise ValueError(f"Duplicate creature id '{template.id}' in {workbook_path}")
        templates[template.id] = template

    if not templates:
        raise ValueError(f"No creature rows found in {workbook_path}")
    return templates


class _XlsxWorkbook:
    def __init__(self, path: Path):
        self.path = Path(path)

    def read_sheet(self, sheet_name: str) -> list[list[str]]:
        with zipfile.ZipFile(self.path) as archive:
            shared_strings = self._read_shared_strings(archive)
            sheet_path = self._sheet_path(archive, sheet_name)
            root = ET.fromstring(archive.read(sheet_path))
            rows: list[list[str]] = []
            for row_el in _children(root, "sheetData", "row"):
                values: list[str] = []
                for cell in _children(row_el, "c"):
                    ref = cell.attrib.get("r", "")
                    col = re.sub(r"\d", "", ref)
                    if col:
                        index = _column_index(col)
                        while len(values) <= index:
                            values.append("")
                        values[index] = self._cell_value(cell, shared_strings)
                rows.append(values)
            return rows

    def _read_shared_strings(self, archive: zipfile.ZipFile) -> list[str]:
        if "xl/sharedStrings.xml" not in archive.namelist():
            return []
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        strings: list[str] = []
        for si in _iter_local(root, "si"):
            strings.append("".join(t.text or "" for t in _iter_local(si, "t")))
        return strings

    def _sheet_path(self, archive: zipfile.ZipFile, sheet_name: str) -> str:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        rel_map = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in rels
            if _local_name(rel.tag) == "Relationship"
        }
        for sheet in _iter_local(workbook, "sheet"):
            if sheet.attrib.get("name") != sheet_name:
                continue
            rel_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
            target = rel_map.get(rel_id or "")
            if not target:
                break
            return target.lstrip("/") if target.startswith("/") else f"xl/{target.lstrip('/')}"
        raise ValueError(f"Sheet '{sheet_name}' not found in {self.path}")

    def _cell_value(self, cell: ET.Element, shared_strings: list[str]) -> str:
        cell_type = cell.attrib.get("t")
        if cell_type == "inlineStr":
            return "".join(t.text or "" for t in _iter_local(cell, "t"))
        value = _first_child_text(cell, "v")
        if value is None:
            return ""
        if cell_type == "s":
            try:
                return shared_strings[int(value)]
            except (ValueError, IndexError):
                return value
        return value


def _rows_as_dicts(rows: list[list[str]]) -> list[tuple[int, dict[str, str]]]:
    if not rows:
        return []
    headers = [_clean(value) for value in rows[0]]
    result: list[tuple[int, dict[str, str]]] = []
    for index, row in enumerate(rows[1:], start=2):
        values = {header: row[i] if i < len(row) else "" for i, header in enumerate(headers) if header}
        if any(_clean(value) for value in values.values()):
            result.append((index, values))
    return result


def _parse_action_deck(rows: list[tuple[int, dict[str, str]]]) -> list[dict[str, object]]:
    action_rows: list[dict[str, object]] = []
    for row_number, row in rows:
        result = _clean(row.get("Result")).upper()
        if not result:
            continue
        copies = _parse_int(row.get("Copies"), default=1)
        if copies is None or copies <= 0:
            raise ValueError(f"{ACTION_DECK_SHEET} row {row_number}: Copies must be > 0")
        action_rows.append(
            {
                "row_number": row_number,
                "result": result,
                "copies": copies,
                "reshuffle": _parse_bool(row.get("Reshuffle?")),
            }
        )
    return action_rows


def _template_from_row(
    row_number: int,
    row: dict[str, str],
    action_deck: list[dict[str, object]],
    *,
    images_dir: Path,
) -> EnemyTemplate:
    creature_id = _clean(row.get("ID"))
    blockers: list[str] = []
    warnings: list[str] = []

    power = _required_positive_int(row, "Power", blockers)
    toughness = _required_positive_int(row, "Toughness", blockers)
    movement = _required_positive_int(row, "Move", blockers)
    armor = _required_non_negative_int(row, "Armor", blockers)
    magic_armor = _required_non_negative_int(row, "Magic_Armor", blockers)
    base_guard = _required_non_negative_int(row, "Base_Guard", blockers)
    threat_level = _parse_int(row.get("Threat_Level"))

    skills: dict[str, int] = {}
    for column in SKILL_COLUMNS:
        value = _parse_int(row.get(column))
        if value is None:
            blockers.append(f"{column} missing or invalid")
            value = 0
        skills[_camel_key(column)] = value

    actions = {column: _clean(row.get(column)) for column in ACTION_COLUMNS}
    for action_row in action_deck:
        result = str(action_row["result"])
        if _blankish(actions.get(result)):
            blockers.append(f"{result} action missing")

    image, image_missing = _validated_image_path(row.get("Image_Path"), images_dir)
    if image_missing:
        derived = _derived_image_path(creature_id, _clean(row.get("Part")), _clean(row.get("Section")))
        if derived and (images_dir / derived).exists():
            image = derived
            image_missing = False
        else:
            warnings.append("Image_Path missing or invalid")

    spawnable = not blockers
    cards = _build_action_cards(creature_id, actions, action_deck) if spawnable else tuple()
    deck = Deck(id=f"{creature_id}__actions", name=f"{_clean(row.get('Name')) or creature_id} Actions", cards=cards) if spawnable else None

    template = EnemyTemplate(
        id=creature_id,
        name=_clean(row.get("Name")) or creature_id,
        image=image,
        category=_clean(row.get("Part")) or "Uncategorized",
        hp=RangeInt(toughness or 0, toughness or 0),
        baseGuard=RangeInt(base_guard or 0, base_guard or 0),
        armor=RangeInt(armor or 0, armor or 0),
        magicArmor=RangeInt(magic_armor or 0, magic_armor or 0),
        draws=power or 0,
        movement=movement or 0,
        initiative_modifier=skills.get("alertness", 0),
        coreDeck=EXCEL_CORE_DECK_ID,
        specials=tuple(),
        loot=tuple(),
        source="excel",
        action_deck=deck,
        part=_clean(row.get("Part")) or None,
        section=_clean(row.get("Section")) or None,
        threat_tier=_clean(row.get("Threat_Tier")) or None,
        threat_level=threat_level,
        short_flavour=_clean(row.get("Short_Flavour")) or None,
        lore_note=_clean(row.get("Lore_Note")) or None,
        gm_note=_clean(row.get("GM_Note")) or None,
        mechanics_note=_clean(row.get("Mechanics_Note")) or None,
        traits=_clean(row.get("Traits")) or None,
        skills=skills,
        actions={key: value for key, value in actions.items() if not _blankish(value)},
        playtest_status=_clean(row.get("Playtest_Status")) or None,
        spawnable=spawnable,
        spawn_blockers=tuple([*blockers, *warnings] if not spawnable else warnings),
        image_missing=image_missing,
    )

    errs = template.validate(f"Creature({row_number}:{creature_id})", available_decks=set())
    if errs:
        raise ValueError("Creature workbook validation failed:\n- " + "\n- ".join(errs))
    return template


def _build_action_cards(
    creature_id: str,
    actions: dict[str, str],
    action_deck: list[dict[str, object]],
) -> tuple[Card, ...]:
    cards: list[Card] = []
    for action_row in action_deck:
        result = str(action_row["result"])
        action_text = _clean(actions[result])
        cards.append(
            build_creature_action_card(
                creature_id=creature_id,
                action_result=result,
                action_text=action_text,
                card_id=f"{creature_id}__{result}__{action_row['row_number']}",
                weight=int(action_row["copies"]),
                reshuffle=bool(action_row["reshuffle"]),
            )
        )
    return tuple(cards)


def build_creature_action_card(
    *,
    creature_id: str,
    action_result: str,
    action_text: str,
    card_id: str | None = None,
    weight: int = 1,
    reshuffle: bool = False,
) -> Card:
    result = _clean(action_result).upper()
    text = _clean(action_text)
    title, body = _split_action(text)
    effects, manual_notes = _parse_action_effects(body)
    return Card(
        id=card_id or f"{creature_id}__{result}",
        title=title or text or result,
        effects=effects,
        weight=weight,
        action_text=text,
        manual_notes=manual_notes,
        action_result=result,
        reshuffle=reshuffle,
    )


def parse_creature_action(
    *,
    action_result: str,
    action_text: str,
    card_id: str = "__preview__",
    weight: int = 1,
    reshuffle: bool = False,
) -> dict:
    card = build_creature_action_card(
        creature_id="__preview__",
        action_result=action_result,
        action_text=action_text,
        card_id=card_id,
        weight=weight,
        reshuffle=reshuffle,
    )
    return serialize_creature_action_card(card)


def serialize_creature_action_card(card: Card) -> dict:
    coverage = action_card_coverage(card)
    return {
        "id": card.id,
        "result": card.action_result,
        "title": card.title,
        "text": card.action_text or "",
        "weight": card.weight,
        "reshuffle": bool(card.reshuffle),
        "effects": [_effect_to_dict(effect) for effect in card.effects],
        "manualNotes": list(card.manual_notes),
        "coverage": coverage,
        "coverageStatus": coverage["status"],
    }


def action_card_coverage(card: Card) -> dict:
    status = _coverage_status(card.action_text or card.title or "", card.effects, card.manual_notes)
    return {
        "status": status,
        "label": _coverage_label(status),
        "notes": list(card.manual_notes),
    }


def _effect_to_dict(effect: Effect) -> dict:
    return {
        "type": effect.type,
        "amount": effect.amount,
        "modifiers": list(effect.modifiers),
    }


def _coverage_label(status: str) -> str:
    if status == SIM_COVERAGE_FULL:
        return "Fully simulated"
    if status == SIM_COVERAGE_MANUAL:
        return "Manual/ignored"
    if status == SIM_COVERAGE_WARNING:
        return "Parse warning"
    if status == SIM_COVERAGE_ERROR:
        return "Sim blocker"
    return status


def _coverage_status(action_text: str, effects: tuple[Effect, ...], manual_notes: tuple[str, ...]) -> str:
    text = _clean(action_text)
    if not text:
        return SIM_COVERAGE_ERROR
    _, body = _split_action(text)
    has_attack_effect = any(effect.type == "attack" for effect in effects)
    if re.search(r"\battack\b", body, flags=re.I) and not has_attack_effect:
        return SIM_COVERAGE_ERROR
    if not manual_notes:
        return SIM_COVERAGE_FULL
    return SIM_COVERAGE_MANUAL if _manual_notes_are_known(manual_notes) else SIM_COVERAGE_WARNING


def _manual_notes_are_known(notes: tuple[str, ...]) -> bool:
    known_patterns = (
        r"\bmove\b",
        r"\bmoves\b",
        r"\bshift\b",
        r"\bteleport\b",
        r"\bpush\b",
        r"\bpull\b",
        r"\bknock\b",
        r"\bprone\b",
        r"\badjacent\b",
        r"\bnearby\b",
        r"\bwithin\b",
        r"\brange\b",
        r"\bline\b",
        r"\bcone\b",
        r"\barea\b",
        r"\ball\b",
        r"\beach\b",
        r"\btarget\b",
        r"\btargets\b",
        r"\btaunt\b",
        r"\bfear\b",
        r"\bstun\b",
        r"\bslow\b",
        r"\bburn\b",
        r"\bpoison\b",
        r"\bheal\b",
        r"\bsummon\b",
        r"\bspawn\b",
        r"\buntil\b",
        r"\bnext turn\b",
        r"\bif\b",
        r"\bwhen\b",
        r"\bor\b",
        r"\bmanual\b",
        r"\bchoose\b",
        r"\bdisengage\b",
    )
    cleaned_notes = [_clean(note) for note in notes if _clean(note)]
    if not cleaned_notes:
        return True
    return all(any(re.search(pattern, note, flags=re.I) for pattern in known_patterns) for note in cleaned_notes)


def _parse_action_effects(body: str) -> tuple[tuple[Effect, ...], tuple[str, ...]]:
    effects: list[Effect] = []
    simplified = body

    attack = re.search(r"\b(?:ranged\s+)?(?:magic\s+)?attack\s+(\d+)\b", body, flags=re.I)
    if attack:
        modifiers = _parse_attack_modifiers(body)
        effects.append(Effect(type="attack", amount=int(attack.group(1)), modifiers=modifiers))
        simplified = simplified[:attack.start()] + simplified[attack.end():]

    for guard in re.finditer(r"\bgain\s+(\d+)\s+guard\b", body, flags=re.I):
        effects.append(Effect(type="guard", amount=int(guard.group(1))))
        simplified = simplified.replace(guard.group(0), "")

    for draw in re.finditer(r"\bdraw\s+(\d+)\b", body, flags=re.I):
        effects.append(Effect(type="draw", amount=int(draw.group(1))))
        simplified = simplified.replace(draw.group(0), "")

    for pattern in (
        r"\branged\s+magic\s+",
        r"\bmagic\s+pierce\b",
        r"\bpierce\s+\d+\b",
        r"\bsunder\s+\d+\b",
        r"\bstab\b",
        r"\bsunder\b",
        r"\boverwhelm\b",
        r"\bshatter\b",
        r"\bparaly[sz]e\b",
        r"\branged\s+",
        r"\bmagic\s+",
    ):
        simplified = re.sub(pattern, "", simplified, flags=re.I)
    simplified = re.sub(r"^[\s,.;:—-]+|[\s,.;:—-]+$", "", simplified)
    simplified = re.sub(r"\s+", " ", simplified)
    manual_notes = (simplified,) if simplified else tuple()
    return tuple(effects), manual_notes


def _parse_attack_modifiers(body: str) -> tuple[str, ...]:
    modifiers: list[str] = []
    for match in re.finditer(r"\bpierce\s+(\d+)\b", body, flags=re.I):
        amount = max(0, int(match.group(1)))
        if amount > 0:
            modifiers.append(f"pierce:{amount}")
    if re.search(r"\bstab\b", body, flags=re.I):
        modifiers.append("stab")
    for match in re.finditer(r"\bsunder(?:\s+(\d+))?\b", body, flags=re.I):
        amount = max(0, int(match.group(1) or "1"))
        if amount > 0:
            modifiers.append(f"sunder:{amount}")
    if re.search(r"\boverwhelm\b", body, flags=re.I):
        modifiers.append("overwhelm")
    if re.search(r"\bshatter\b", body, flags=re.I):
        modifiers.append("shatter")
    if re.search(r"\bmagic\s+pierce\b", body, flags=re.I):
        modifiers.append("magic_pierce")
    if re.search(r"\bparaly[sz]e\b", body, flags=re.I):
        modifiers.append("paralyse")
    return tuple(dict.fromkeys(modifiers))


def _split_action(action_text: str) -> tuple[str, str]:
    if "—" in action_text:
        title, body = action_text.split("—", 1)
        return _clean(title), _clean(body)
    if " - " in action_text:
        title, body = action_text.split(" - ", 1)
        return _clean(title), _clean(body)
    return action_text, action_text


def _validated_image_path(raw: str | None, images_dir: Path) -> tuple[str | None, bool]:
    image = _clean(raw).replace("\\", "/")
    if image.startswith("images/"):
        image = image[len("images/"):]
    if not image:
        return None, True
    normalized = posixpath.normpath(image).lstrip("/")
    if normalized.startswith("../") or normalized == "..":
        return None, True
    if Path(normalized).suffix.lower() not in IMAGE_EXTENSIONS:
        return None, True
    if not (images_dir / normalized).exists():
        return normalized, True
    return normalized, False


def _safe_folder_name(name: str) -> str:
    return re.sub(r"[^\w]", "_", name).strip("_")


def _derived_image_path(creature_id: str, part: str | None, section: str | None) -> str | None:
    """Return images/<part>/<section>/<id>.png derived from taxonomy, or None if inputs are missing."""
    if not creature_id or not part or not section:
        return None
    return f"{_safe_folder_name(part)}/{_safe_folder_name(section)}/{creature_id}.png"


def _required_positive_int(row: dict[str, str], column: str, blockers: list[str]) -> int | None:
    value = _parse_int(row.get(column))
    if value is None or value <= 0:
        blockers.append(f"{column} must be > 0")
        return None
    return value


def _required_non_negative_int(row: dict[str, str], column: str, blockers: list[str]) -> int | None:
    value = _parse_int(row.get(column))
    if value is None or value < 0:
        blockers.append(f"{column} must be >= 0")
        return None
    return value


def _parse_int(value: str | None, *, default: int | None = None) -> int | None:
    text = _clean(value)
    if not text:
        return default
    match = re.search(r"-?\d+", text)
    if not match:
        return default
    return int(match.group(0))


def _parse_bool(value: str | None) -> bool:
    return _clean(value).lower() in {"yes", "y", "true", "1"}


def _blankish(value: str | None) -> bool:
    return _clean(value) in {"", "0"}


def _clean(value: str | None) -> str:
    return str(value or "").strip()


def _camel_key(value: str) -> str:
    first, *rest = value.split("_")
    return first[:1].lower() + first[1:] + "".join(part[:1].upper() + part[1:] for part in rest)


def _column_index(col: str) -> int:
    index = 0
    for char in col.upper():
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index - 1


def _first_child_text(element: ET.Element, child_name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == child_name:
            return child.text or ""
    return None


def _children(element: ET.Element, *path: str) -> Iterable[ET.Element]:
    current = [element]
    for name in path:
        next_level: list[ET.Element] = []
        for item in current:
            next_level.extend(child for child in item if _local_name(child.tag) == name)
        current = next_level
    return current


def _iter_local(element: ET.Element, name: str) -> Iterable[ET.Element]:
    for item in element.iter():
        if _local_name(item.tag) == name:
            yield item


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]
