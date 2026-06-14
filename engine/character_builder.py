from __future__ import annotations

import json
import re
from collections import Counter
from copy import deepcopy
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from engine.models import Card, Deck

UPGRADE_CARD_KEYS = ("success_1", "success_2", "fate_1", "fail_1")
SUPPORTED_ART_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
CHARACTER_ART_ROOT = "Playing_Characters"
CUSTOM_ART_ROOT = f"{CHARACTER_ART_ROOT}/extra/custom"
ANONYMOUS_ART = {
    "id": "anonymous",
    "classId": None,
    "ancestryId": None,
    "gender": None,
    "variant": "",
    "source": "anonymous",
    "imagePath": "anonymous.png",
    "imageUrl": "/images/anonymous.png",
    "label": "Anonymous",
}
OUTCOME_FOR_KEY = {
    "success_1": "success",
    "success_2": "success",
    "fate_1": "fate",
    "fail_1": "fail",
}
DEFAULT_STATS = {
    "toughness": 3,
    "armor": 1,
    "magicArmor": 0,
    "power": 4,
    "movement": 6,
    "baseGuard": 1,
    "initiativeModifier": 2,
}
ABILITY_KEYS = ("intelligence", "alertness", "stealth", "social", "arcana", "athletics")
ABILITY_LABELS = {
    "intelligence": "Intelligence",
    "alertness": "Alertness",
    "stealth": "Stealth",
    "social": "Social",
    "arcana": "Arcana",
    "athletics": "Athletics",
}
ABILITY_ARRAYS = (
    (3, 3, 3, 2, 2, 2),
    (3, 3, 3, 3, 2, 1),
    (4, 3, 2, 2, 2, 2),
    (4, 3, 3, 2, 2, 1),
    (4, 3, 3, 3, 1, 1),
)
DEFAULT_ABILITIES = dict(zip(ABILITY_KEYS, ABILITY_ARRAYS[0]))
COMMON_SPECIALIZATIONS = (
    "Survival",
    "Thievery",
    "Medicine",
    "Engineering",
    "Bard",
    "Herbalist",
    "Warrior Traditions",
    "Elemental Traditions",
    "Sacred Traditions",
    "Nature Traditions",
    "Shadow Traditions",
)
CLASS_ABILITY_BONUSES = {
    "fighter": {"athletics": 1},
    "berserker": {"athletics": 1},
    "shadowmaster": {"stealth": 1},
}
CLASS_SPECIALIZATION_MINIMUMS = {
    "ranger": {"Survival": 2},
}
CLASS_SPECIALIZATION_BONUSES = {
    "ranger": {"Survival": 1},
}


class CharacterBuilderError(ValueError):
    pass


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(value: str, *, fallback: str = "character") -> str:
    raw = str(value or "").strip().lower()
    raw = re.sub(r"[^a-z0-9]+", "_", raw).strip("_")
    return raw or fallback


def load_character_catalog(path: Path) -> dict[str, Any]:
    try:
        catalog = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise CharacterBuilderError(f"Could not read character builder catalog: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CharacterBuilderError(f"Invalid character builder catalog JSON: {path}") from exc
    validate_catalog(catalog)
    return catalog


def validate_catalog(catalog: dict[str, Any]) -> None:
    energy_types = catalog.get("energyTypes")
    if not isinstance(energy_types, list) or not energy_types:
        raise CharacterBuilderError("Catalog must define energyTypes")
    _require_unique_ids(catalog.get("classes") or [], "class")
    _require_unique_ids(catalog.get("ancestries") or [], "ancestry")

    valid_energy = set(energy_types)
    for class_entry in catalog.get("classes") or []:
        for energy_type in class_entry.get("requiredEnergyTypes") or []:
            if energy_type not in valid_energy:
                raise CharacterBuilderError(f"Class '{class_entry.get('id')}' has unknown required energy '{energy_type}'")
        for energy_type in class_entry.get("mainArtOptions") or []:
            if energy_type not in valid_energy:
                raise CharacterBuilderError(f"Class '{class_entry.get('id')}' has unknown main art '{energy_type}'")
        card = class_entry.get("card") or {}
        if not card.get("name") or not card.get("text"):
            raise CharacterBuilderError(f"Class '{class_entry.get('id')}' must define card name and text")

    for ancestry in catalog.get("ancestries") or []:
        card = ancestry.get("card") or {}
        if not card.get("name") or not card.get("text"):
            raise CharacterBuilderError(f"Ancestry '{ancestry.get('id')}' must define card name and text")


def _require_unique_ids(entries: list[dict[str, Any]], label: str) -> None:
    ids = [str(entry.get("id") or "").strip() for entry in entries]
    if any(not item for item in ids):
        raise CharacterBuilderError(f"Catalog has a {label} without an id")
    duplicates = [item for item, count in Counter(ids).items() if count > 1]
    if duplicates:
        raise CharacterBuilderError(f"Catalog has duplicate {label} ids: {', '.join(sorted(duplicates))}")


def catalog_payload(catalog: dict[str, Any], character_art_options: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    payload = deepcopy(catalog)
    payload["characterArt"] = {
        "anonymous": dict(ANONYMOUS_ART),
        "options": list(character_art_options or []),
    }
    return payload


def class_by_id(catalog: dict[str, Any], class_id: str) -> dict[str, Any]:
    for class_entry in catalog.get("classes") or []:
        if class_entry.get("id") == class_id:
            return class_entry
    raise CharacterBuilderError(f"Unknown class '{class_id}'")


def ancestry_by_id(catalog: dict[str, Any], ancestry_id: str) -> dict[str, Any]:
    for ancestry in catalog.get("ancestries") or []:
        if ancestry.get("id") == ancestry_id:
            return ancestry
    raise CharacterBuilderError(f"Unknown ancestry '{ancestry_id}'")


def build_character_art_options(catalog: dict[str, Any], images_dir: Path) -> list[dict[str, Any]]:
    art_root = images_dir / CHARACTER_ART_ROOT
    if not art_root.exists():
        return []

    options: list[dict[str, Any]] = []
    for path in sorted(art_root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in SUPPORTED_ART_EXTENSIONS:
            continue
        parsed = _parse_character_art_filename(path.stem, catalog)
        if parsed is None:
            continue
        image_path = path.relative_to(images_dir).as_posix()
        source = "upload" if image_path.startswith(f"{CUSTOM_ART_ROOT}/") else "catalog"
        label = _character_art_label(parsed["gender"], parsed["variant"])
        options.append({
            "id": f"pc_art_{slugify(image_path.rsplit('.', 1)[0], fallback='art')}",
            "classId": parsed["classId"],
            "ancestryId": parsed["ancestryId"],
            "gender": parsed["gender"],
            "variant": parsed["variant"],
            "source": source,
            "imagePath": image_path,
            "imageUrl": f"/images/{image_path}",
            "label": label,
        })
    return sorted(
        options,
        key=lambda item: (
            str(item["classId"]),
            str(item["ancestryId"]),
            str(item["gender"]),
            str(item["variant"]),
            str(item["imagePath"]),
        ),
    )


def resolve_character_art(
    raw: Any,
    *,
    images_dir: Path | None = None,
    character_art_options: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return dict(ANONYMOUS_ART)

    image_path = _normalize_image_path(raw.get("imagePath") or raw.get("image_path") or "")
    source = str(raw.get("source") or "").strip()
    if not image_path or image_path == ANONYMOUS_ART["imagePath"] or source == "anonymous":
        return dict(ANONYMOUS_ART)
    if images_dir is None:
        raise CharacterBuilderError("Character art validation requires an images directory")

    resolved_path = (images_dir / image_path).resolve()
    images_root = images_dir.resolve()
    if not resolved_path.is_relative_to(images_root):
        raise CharacterBuilderError("Character art path must stay inside images")
    if not resolved_path.is_file():
        raise CharacterBuilderError("Character art image does not exist")

    is_custom_upload = image_path.startswith(f"{CUSTOM_ART_ROOT}/")
    if source == "upload" and not is_custom_upload:
        raise CharacterBuilderError("Uploaded character art must be stored under the custom art folder")
    resolved_source = "upload" if is_custom_upload else "catalog"

    by_path = {
        str(option.get("imagePath")): option
        for option in (character_art_options or [])
        if isinstance(option, dict) and option.get("imagePath")
    }
    matched = by_path.get(image_path) or {}
    label = str(raw.get("label") or matched.get("label") or Path(image_path).stem.replace("_", " ")).strip()
    return {
        "source": resolved_source,
        "imagePath": image_path,
        "imageUrl": f"/images/{image_path}",
        "label": label or "Character art",
    }


def _parse_character_art_filename(stem: str, catalog: dict[str, Any]) -> dict[str, str] | None:
    if not stem or stem.startswith("_"):
        return None
    class_ids = sorted((str(entry.get("id")) for entry in catalog.get("classes") or []), key=len, reverse=True)
    ancestry_ids = sorted((str(entry.get("id")) for entry in catalog.get("ancestries") or []), key=len, reverse=True)
    for class_id in class_ids:
        class_prefix = f"{class_id}_"
        if not stem.startswith(class_prefix):
            continue
        after_class = stem[len(class_prefix):]
        for ancestry_id in ancestry_ids:
            ancestry_prefix = f"{ancestry_id}_"
            if not after_class.startswith(ancestry_prefix):
                continue
            tail = after_class[len(ancestry_prefix):]
            parts = tail.split("_")
            gender = parts[0] if parts else ""
            if gender not in {"male", "female"}:
                continue
            return {
                "classId": class_id,
                "ancestryId": ancestry_id,
                "gender": gender,
                "variant": "_".join(parts[1:]),
            }
    return None


def _normalize_image_path(raw: Any) -> str:
    value = str(raw or "").replace("\\", "/").strip().lstrip("/")
    if value.startswith("images/"):
        value = value[len("images/"):]
    parts = [part for part in value.split("/") if part]
    if any(part in {".", ".."} for part in parts):
        raise CharacterBuilderError("Character art path is invalid")
    return "/".join(parts)


def _character_art_label(gender: str, variant: str) -> str:
    label = gender.capitalize() if gender else "Character"
    if variant:
        label = f"{label} {variant.replace('_', ' ').upper()}"
    return label


def character_summary(profile: dict[str, Any]) -> dict[str, Any]:
    choices = profile.get("choices") or {}
    return {
        "id": profile.get("id"),
        "name": profile.get("name"),
        "classId": choices.get("classId"),
        "className": profile.get("className"),
        "ancestryId": choices.get("ancestryId"),
        "ancestryName": profile.get("ancestryName"),
        "energyTypes": list(choices.get("energyTypes") or []),
        "mainArt": choices.get("mainArt"),
        "art": dict(profile.get("art") or ANONYMOUS_ART),
        "gearPreset": profile.get("gearPreset"),
        "abilities": abilities_from_profile(profile),
        "specializations": specializations_from_profile(profile),
        "createdAt": profile.get("createdAt"),
        "updatedAt": profile.get("updatedAt"),
    }


def build_character_profile(
    catalog: dict[str, Any],
    request: dict[str, Any],
    *,
    character_id: str | None = None,
    created_at: str | None = None,
    updated_at: str | None = None,
    images_dir: Path | None = None,
    character_art_options: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    name = str(request.get("name") or "").strip()
    if not name:
        raise CharacterBuilderError("Character name is required")

    class_entry = class_by_id(catalog, str(request.get("classId") or ""))
    ancestry = ancestry_by_id(catalog, str(request.get("ancestryId") or ""))
    energy_types = _normalize_energy_types(request.get("energyTypes"), catalog)
    main_art = str(request.get("mainArt") or "").strip()
    gm_override = bool(request.get("gmOverride", False))
    deck_upgrades = _normalize_deck_upgrades(request.get("deckUpgrades"), energy_types)
    class_improvement_target = str(request.get("classImprovementTarget") or "success_1").strip()
    if class_improvement_target not in UPGRADE_CARD_KEYS:
        raise CharacterBuilderError("Class improvement target is invalid")

    validate_character_choices(
        catalog,
        class_entry,
        energy_types=energy_types,
        main_art=main_art,
        gm_override=gm_override,
        deck_upgrades=deck_upgrades,
        class_improvement_target=class_improvement_target,
    )

    stats = _resolve_stats(catalog, class_entry, request.get("stats"))
    base_abilities = _normalize_abilities(request.get("abilities"))
    abilities = _apply_ability_bonuses(base_abilities, class_entry)
    raw_specializations = request.get("specializations")
    specialization_mode = str(request.get("specializationMode") or "").strip().lower()
    normalized_specializations = (
        _normalize_specializations(raw_specializations, specialization_mode)
        if raw_specializations is not None
        else []
    )
    specializations = _apply_specialization_bonuses(
        normalized_specializations,
        class_entry,
    )
    gear_preset = _resolve_gear_preset(class_entry, request.get("gearPresetId"))
    art = resolve_character_art(
        request.get("art"),
        images_dir=images_dir,
        character_art_options=character_art_options,
    )
    now = updated_at or utc_now_iso()
    profile_id = character_id or slugify(f"{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    cards = generate_character_cards(
        profile_id=profile_id,
        class_entry=class_entry,
        ancestry=ancestry,
        energy_types=energy_types,
        main_art=main_art,
        deck_upgrades=deck_upgrades,
        class_improvement_target=class_improvement_target,
    )

    return {
        "version": 1,
        "id": profile_id,
        "name": name,
        "className": class_entry["name"],
        "ancestryName": ancestry["name"],
        "createdAt": created_at or now,
        "updatedAt": now,
        "art": art,
        "abilities": abilities,
        "specializations": specializations,
        "choices": {
            "classId": class_entry["id"],
            "ancestryId": ancestry["id"],
            "energyTypes": energy_types,
            "mainArt": main_art,
            "gmOverride": gm_override,
            "deckUpgrades": deck_upgrades,
            "classImprovementTarget": class_improvement_target,
            "gearPresetId": gear_preset.get("id"),
            "stats": stats,
            "abilityArray": _ability_array_id(base_abilities),
            "baseAbilities": base_abilities,
            "abilities": abilities,
            "specializationMode": specialization_mode or (
                "deep" if len(specializations) == 1 else "broad" if len(specializations) == 2 else ""
            ),
            "specializations": specializations,
        },
        "gearPreset": gear_preset,
        "generatedDeck": {
            "id": f"character_{profile_id}",
            "name": f"{name} Starting Deck",
            "cards": cards,
        },
    }


def validate_character_choices(
    catalog: dict[str, Any],
    class_entry: dict[str, Any],
    *,
    energy_types: list[str],
    main_art: str,
    gm_override: bool,
    deck_upgrades: dict[str, dict[str, int]],
    class_improvement_target: str,
) -> None:
    if len(energy_types) != 3:
        raise CharacterBuilderError("Choose exactly 3 energy types")
    if len(set(energy_types)) != 3:
        raise CharacterBuilderError("Energy types must be unique")

    required = set(class_entry.get("requiredEnergyTypes") or [])
    missing = required - set(energy_types)
    if missing:
        raise CharacterBuilderError(f"Missing required energy type: {', '.join(sorted(missing))}")

    forbidden = set(class_entry.get("forbiddenEnergyTypes") or [])
    blocked = forbidden & set(energy_types)
    if blocked and not gm_override:
        raise CharacterBuilderError(
            f"{class_entry['name']} requires GM override for: {', '.join(sorted(blocked))}"
        )

    _validate_choice_rule(class_entry, energy_types)

    allowed_main_arts = set(class_entry.get("mainArtOptions") or [])
    if main_art not in allowed_main_arts:
        raise CharacterBuilderError(f"Main art '{main_art}' is not available for {class_entry['name']}")
    if main_art not in energy_types:
        raise CharacterBuilderError("Main art must be one of the selected energy types")

    for energy_type in energy_types:
        points = deck_upgrades.get(energy_type)
        if points is None:
            raise CharacterBuilderError(f"Missing deck upgrades for {energy_type}")
        if sum(points.values()) != 2:
            raise CharacterBuilderError(f"{energy_type} must spend exactly 2 improvement points")
        for card_key, amount in points.items():
            if card_key not in UPGRADE_CARD_KEYS:
                raise CharacterBuilderError(f"Unknown upgrade target '{card_key}'")
            if amount < 0:
                raise CharacterBuilderError("Deck upgrade points cannot be negative")

    main_points = deck_upgrades.get(main_art, {})
    pre_class_value = 1 + int(main_points.get(class_improvement_target, 0))
    if pre_class_value >= 3:
        raise CharacterBuilderError("Class improvement target must have energy value below 3 before class improvement")


def _validate_choice_rule(class_entry: dict[str, Any], energy_types: list[str]) -> None:
    selected = set(energy_types)
    rule = class_entry.get("choiceRule")
    required = set(class_entry.get("requiredEnergyTypes") or [])
    extras = selected - required
    if rule == "anyTwo" and len(extras) != 2:
        raise CharacterBuilderError(f"{class_entry['name']} must choose 2 additional energy types")
    if rule == "anyOne" and len(extras) != 1:
        raise CharacterBuilderError(f"{class_entry['name']} must choose 1 additional energy type")
    if rule == "twoNonMartial":
        if "Martial" not in selected:
            raise CharacterBuilderError("Diviner requires Martial")
        if len([energy for energy in energy_types if energy != "Martial"]) != 2:
            raise CharacterBuilderError("Diviner must choose 2 non-Martial energy types")
    if rule == "monk":
        if "Martial" not in selected:
            raise CharacterBuilderError("Monk requires Martial")
        if not ({"Elemental", "Light"} & selected):
            raise CharacterBuilderError("Monk must choose Elemental or Light as one starting energy type")


def _normalize_energy_types(raw: Any, catalog: dict[str, Any]) -> list[str]:
    valid = set(catalog.get("energyTypes") or [])
    if not isinstance(raw, list):
        raise CharacterBuilderError("Energy types must be a list")
    result = [str(item).strip() for item in raw if str(item).strip()]
    unknown = [item for item in result if item not in valid]
    if unknown:
        raise CharacterBuilderError(f"Unknown energy type: {', '.join(unknown)}")
    return result


def _normalize_deck_upgrades(raw: Any, energy_types: list[str]) -> dict[str, dict[str, int]]:
    if not isinstance(raw, dict):
        raw = {}
    result: dict[str, dict[str, int]] = {}
    for energy_type in energy_types:
        per_energy = raw.get(energy_type) if isinstance(raw.get(energy_type), dict) else {}
        result[energy_type] = {
            card_key: max(0, int(per_energy.get(card_key, 0) or 0))
            for card_key in UPGRADE_CARD_KEYS
        }
    return result


def _resolve_stats(catalog: dict[str, Any], class_entry: dict[str, Any], raw: Any) -> dict[str, int]:
    stats = dict(catalog.get("defaultStats") or DEFAULT_STATS)
    stats.update(class_entry.get("statOverrides") or {})
    incoming = raw if isinstance(raw, dict) else {}
    for key in DEFAULT_STATS:
        if key in incoming:
            stats[key] = max(0, int(incoming.get(key, 0) or 0))
        else:
            stats[key] = max(0, int(stats.get(key, DEFAULT_STATS[key]) or 0))
    return stats


def _ability_array_id(values: dict[str, int]) -> str:
    ordered = [int(values.get(key, 0) or 0) for key in ABILITY_KEYS]
    return ",".join(str(value) for value in sorted(ordered, reverse=True))


def _class_ability_bonuses(class_entry: dict[str, Any]) -> dict[str, int]:
    class_id = str(class_entry.get("id") or "")
    bonuses: dict[str, int] = {}
    raw = class_entry.get("abilityBonuses")
    if isinstance(raw, dict):
        for key, value in raw.items():
            normalized = str(key or "").strip()
            if normalized in ABILITY_KEYS:
                bonuses[normalized] = int(value or 0)
    else:
        bonuses.update(CLASS_ABILITY_BONUSES.get(class_id, {}))
    return bonuses


def _class_specialization_minimums(class_entry: dict[str, Any]) -> dict[str, int]:
    class_id = str(class_entry.get("id") or "")
    minimums: dict[str, int] = {}
    raw = class_entry.get("specializationMinimums")
    if isinstance(raw, dict):
        for name, value in raw.items():
            normalized = _normalize_specialization_name(name)
            if normalized:
                minimums[normalized] = int(value or 0)
    else:
        minimums.update(CLASS_SPECIALIZATION_MINIMUMS.get(class_id, {}))
    return minimums


def _class_specialization_bonuses(class_entry: dict[str, Any]) -> dict[str, int]:
    class_id = str(class_entry.get("id") or "")
    bonuses: dict[str, int] = {}
    raw = class_entry.get("specializationBonuses")
    if isinstance(raw, dict):
        for name, value in raw.items():
            normalized = _normalize_specialization_name(name)
            if normalized:
                bonuses[normalized] = int(value or 0)
    else:
        bonuses.update(CLASS_SPECIALIZATION_BONUSES.get(class_id, {}))
    return bonuses


def _normalize_abilities(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return dict(DEFAULT_ABILITIES)
    result: dict[str, int] = {}
    for key in ABILITY_KEYS:
        result[key] = max(0, int(raw.get(key, DEFAULT_ABILITIES[key]) or 0))
    if tuple(sorted(result.values(), reverse=True)) not in ABILITY_ARRAYS:
        allowed = " / ".join(", ".join(str(v) for v in array) for array in ABILITY_ARRAYS)
        raise CharacterBuilderError(f"Ability scores must match one starting array: {allowed}")
    return result


def _apply_ability_bonuses(abilities: dict[str, int], class_entry: dict[str, Any]) -> dict[str, int]:
    result = dict(abilities)
    for key, bonus in _class_ability_bonuses(class_entry).items():
        result[key] = max(0, int(result.get(key, 0) or 0) + int(bonus or 0))
    return result


def _normalize_specialization_name(raw: Any) -> str:
    return " ".join(str(raw or "").strip().split())


def _normalize_specializations(raw: Any, mode: Any = None) -> list[dict[str, int]]:
    source = raw if isinstance(raw, list) else []
    normalized: list[dict[str, int]] = []
    seen: set[str] = set()
    for entry in source:
        if not isinstance(entry, dict):
            continue
        name = _normalize_specialization_name(entry.get("name"))
        if not name:
            continue
        key = name.lower()
        if key in seen:
            raise CharacterBuilderError(f"Duplicate specialization: {name}")
        seen.add(key)
        normalized.append({"name": name, "rank": max(0, int(entry.get("rank", 0) or 0))})

    mode_value = str(mode or "").strip().lower()
    ranks = sorted((item["rank"] for item in normalized), reverse=True)
    if mode_value == "deep":
        if ranks != [4] or len(normalized) != 1:
            raise CharacterBuilderError("Deep training requires one specialization at 4")
    elif mode_value == "broad":
        if ranks != [3, 2] or len(normalized) != 2:
            raise CharacterBuilderError("Broad training requires two specializations at 3 and 2")
    elif normalized:
        if ranks not in ([4], [3, 2]):
            raise CharacterBuilderError("Specializations must be broad training (3 and 2) or deep training (4)")
    return normalized


def _apply_specialization_bonuses(specializations: list[dict[str, int]], class_entry: dict[str, Any]) -> list[dict[str, int]]:
    by_key = {
        item["name"].lower(): {"name": item["name"], "rank": int(item.get("rank", 0) or 0)}
        for item in specializations
    }
    added_from_minimum: set[str] = set()
    minimums = _class_specialization_minimums(class_entry)
    bonuses = _class_specialization_bonuses(class_entry)
    for name, minimum in minimums.items():
        key = name.lower()
        current = by_key.get(key)
        if current is None:
            by_key[key] = {"name": name, "rank": max(0, int(minimum or 0))}
            added_from_minimum.add(key)
        else:
            current["rank"] = max(int(current.get("rank", 0) or 0), int(minimum or 0))
    for name, bonus in bonuses.items():
        key = name.lower()
        current = by_key.get(key)
        if current is not None and key not in added_from_minimum:
            current["rank"] = max(0, int(current.get("rank", 0) or 0) + int(bonus or 0))
    return sorted(by_key.values(), key=lambda item: item["name"].lower())


def abilities_from_profile(profile: dict[str, Any]) -> dict[str, int]:
    choices = profile.get("choices") or {}
    raw = profile.get("abilities") or choices.get("abilities") or choices.get("baseAbilities")
    class_id = str(choices.get("classId") or "").strip()
    class_entry = {"id": class_id}
    if not isinstance(raw, dict):
        return _apply_ability_bonuses(dict(DEFAULT_ABILITIES), class_entry)
    result: dict[str, int] = {}
    for key in ABILITY_KEYS:
        result[key] = max(0, int(raw.get(key, DEFAULT_ABILITIES[key]) or 0))
    return result


def specializations_from_profile(profile: dict[str, Any]) -> list[dict[str, int]]:
    choices = profile.get("choices") or {}
    raw = profile.get("specializations") or choices.get("specializations") or []
    result: list[dict[str, int]] = []
    seen: set[str] = set()
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        name = _normalize_specialization_name(entry.get("name"))
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        result.append({"name": name, "rank": max(0, int(entry.get("rank", 0) or 0))})
    if not result:
        class_entry = {"id": str(choices.get("classId") or "").strip()}
        for name, rank in _class_specialization_minimums(class_entry).items():
            result.append({"name": name, "rank": max(0, int(rank or 0))})
    return result


def _resolve_gear_preset(class_entry: dict[str, Any], gear_preset_id: Any) -> dict[str, Any]:
    presets = class_entry.get("gearPresets") or []
    requested = str(gear_preset_id or "").strip()
    for preset in presets:
        if preset.get("id") == requested:
            return deepcopy(preset)
    if presets:
        return deepcopy(presets[0])
    return {"id": "none", "name": "None", "items": []}


def generate_character_cards(
    *,
    profile_id: str,
    class_entry: dict[str, Any],
    ancestry: dict[str, Any],
    energy_types: list[str],
    main_art: str,
    deck_upgrades: dict[str, dict[str, int]],
    class_improvement_target: str,
) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = [
        _card_payload(
            f"cb_{profile_id}_master_success",
            "Master energy 1 - success",
            "Master",
            1,
            "success",
        ),
        _card_payload(
            f"cb_{profile_id}_master_fail",
            "Master energy 1 - fail",
            "Master",
            1,
            "fail",
        ),
        _effect_card_payload(
            f"cb_{profile_id}_class_{class_entry['id']}",
            class_entry["card"]["name"],
            "Class",
            class_entry["card"]["text"],
            int(class_entry["card"].get("autoDraw", 0) or 0),
        ),
        _effect_card_payload(
            f"cb_{profile_id}_ancestry_{ancestry['id']}",
            ancestry["card"]["name"],
            "Ancestry",
            ancestry["card"]["text"],
            int(ancestry["card"].get("autoDraw", 0) or 0),
        ),
    ]

    for energy_type in energy_types:
        for card_key in UPGRADE_CARD_KEYS:
            amount = 1 + int(deck_upgrades.get(energy_type, {}).get(card_key, 0) or 0)
            if energy_type == main_art and card_key == class_improvement_target:
                amount = 3
            outcome = OUTCOME_FOR_KEY[card_key]
            cards.append(
                _card_payload(
                    f"cb_{profile_id}_{slugify(energy_type, fallback='energy')}_{card_key}",
                    f"{energy_type} energy {amount} - {outcome}",
                    energy_type,
                    amount,
                    outcome,
                )
            )

    cards.extend(
        [
            _card_payload(f"cb_{profile_id}_void_success", "Void - success", "Void", 0, "success"),
            _card_payload(f"cb_{profile_id}_void_fate", "Void - fate", "Void", 0, "fate"),
            _card_payload(f"cb_{profile_id}_void_fail_1", "Void - fail", "Void", 0, "fail"),
            _card_payload(f"cb_{profile_id}_void_fail_2", "Void - fail", "Void", 0, "fail"),
        ]
    )
    return cards


def _card_payload(card_id: str, title: str, energy_type: str, amount: int, outcome: str) -> dict[str, Any]:
    return {
        "id": card_id,
        "title": title,
        "energyType": energy_type,
        "energyAmount": int(amount),
        "outcome": outcome,
    }


def _effect_card_payload(card_id: str, name: str, energy_type: str, text: str, auto_draw: int) -> dict[str, Any]:
    payload = {
        "id": card_id,
        "title": f"{name} - {text}",
        "energyType": energy_type,
        "outcome": "fate",
        "instruction": text,
    }
    if auto_draw > 0:
        payload["extraDraw"] = int(auto_draw)
    return payload


def card_from_payload(obj: dict[str, Any]) -> Card:
    return Card(
        id=str(obj["id"]),
        title=str(obj.get("title") or obj["id"]),
        effects=(),
        weight=int(obj.get("weight", 1) or 1),
        action_text=obj.get("actionText"),
        manual_notes=tuple(obj.get("manualNotes", [])),
        action_result=obj.get("actionResult"),
        energy_type=obj.get("energyType"),
        energy_amount=int(obj.get("energyAmount", 0) or 0),
        outcome=obj.get("outcome"),
        extra_draw=int(obj.get("extraDraw", 0) or 0),
        reshuffle=bool(obj.get("reshuffle", False)),
        instruction=obj.get("instruction"),
    )


def card_to_payload(card: Card) -> dict[str, Any]:
    payload = asdict(card)
    return {
        "id": payload["id"],
        "title": payload["title"],
        "weight": payload["weight"],
        "actionText": payload["action_text"],
        "manualNotes": list(payload["manual_notes"]),
        "actionResult": payload["action_result"],
        "energyType": payload["energy_type"],
        "energyAmount": payload["energy_amount"],
        "outcome": payload["outcome"],
        "extraDraw": payload["extra_draw"],
        "reshuffle": payload["reshuffle"],
        "instruction": payload["instruction"],
    }


def deck_from_profile(profile: dict[str, Any]) -> Deck:
    deck = profile.get("generatedDeck") or {}
    return Deck(
        id=str(deck.get("id") or f"character_{profile.get('id', 'unknown')}"),
        name=str(deck.get("name") or f"{profile.get('name', 'Character')} Starting Deck"),
        cards=tuple(card_from_payload(card) for card in deck.get("cards") or []),
    )


def card_library_from_profile(profile: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(card["id"]): dict(card)
        for card in (profile.get("generatedDeck") or {}).get("cards") or []
        if isinstance(card, dict) and card.get("id")
    }
