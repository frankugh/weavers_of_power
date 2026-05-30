from __future__ import annotations
from dataclasses import dataclass
import re
from typing import Iterable, Optional

from engine.runtime_models import EnemyInstance

AttackMod = str
WOUND_CARD_ID = "wound"


@dataclass(frozen=True)
class CombatLog:
    instance_id: str
    action: str

    # before/after snapshots (minimal but useful)
    toughness_before: int
    toughness_after: int

    guard_before: int
    guard_after: int

    armor_before: int
    armor_after: int

    magic_armor_before: int
    magic_armor_after: int

    # attack-specific info
    input_damage: int = 0
    ignored_regular: int = 0
    ignored_magic: int = 0
    guarded_total: int = 0
    damage_to_hp: int = 0
    wounds_added: int = 0

    applied_statuses: tuple[str, ...] = ()


def _apply_toughness_damage_with_resets(enemy: EnemyInstance, damage_to_hp: int) -> int:
    max_toughness = max(0, int(enemy.toughness_max))
    if damage_to_hp <= 0 or max_toughness <= 0:
        enemy.toughness_current = max(0, int(enemy.toughness_current) - damage_to_hp)
        return 0

    remaining = damage_to_hp
    current = max(0, int(enemy.toughness_current))
    wounds_added = 0

    while remaining > 0:
        if current <= 0:
            wounds_added += 1
            current = max_toughness
            continue

        if remaining < current:
            current -= remaining
            remaining = 0
        else:
            remaining -= current
            wounds_added += 1
            current = max_toughness

    enemy.toughness_current = current
    return wounds_added


def apply_attack(
    enemy: EnemyInstance,
    damage: int,
    mods: Optional[Iterable[AttackMod]] = None,
    *,
    reset_toughness_on_deplete: bool = False,
) -> CombatLog:
    """
    Apply incoming damage to an enemy, taking guard/armor/magic armor into account.

    Rules:
      - armor and magic_armor are *persistent* flat reductions
      - guard is a *consumable pool* that resets each turn
      - overwhelm: ignore guard for this attack without consuming it
      - sunder:X: remove X * 2 guard before this attack resolves
      - shatter: destroys 1 regular armor
      - stab: ignore 1 regular armor reduction
      - pierce: legacy modifier; ignore all regular reduction (guard + armor)
      - pierce:X: ignore X armor first, then X remaining guard
      - magic_pierce: ignore all magic armor reduction
      - paralyse: marks a status
      - reset_toughness_on_deplete: players gain wounds and reset Toughness instead of going down
    """
    if damage < 0:
        raise ValueError("damage must be >= 0")

    raw_mods = [_normalise_attack_mod(str(mod)) for mod in (mods or []) if str(mod).strip()]
    mods_set = set(raw_mods)
    pierce_amount = _sum_modifier_amount(raw_mods, "pierce")
    sunder_amount = _sum_modifier_amount(raw_mods, "sunder", default_for_bare=1)

    toughness_b = enemy.toughness_current
    guard_b = enemy.guard_current
    armor_b = enemy.armor_current
    magic_b = enemy.magic_armor_current

    # 1) destructive modifiers happen before temporary bypass modifiers.
    guard_removed = min(guard_b, sunder_amount * 2)
    guard_now = max(0, guard_b - guard_removed)
    armor_now = max(0, armor_b - 1) if "shatter" in mods_set else armor_b
    magic_now = magic_b

    # 2) compute ignores (bypass reductions; do NOT destroy them)
    ignored_regular = 0
    ignored_magic = 0

    guard_eff = guard_now
    armor_eff = armor_now

    if "pierce" in mods_set:
        ignored_regular += guard_eff + armor_eff
        guard_eff = 0
        armor_eff = 0
    else:
        if pierce_amount > 0:
            ignored_armor = min(pierce_amount, armor_eff)
            armor_eff = max(0, armor_eff - ignored_armor)
            ignored_guard = min(max(0, pierce_amount - ignored_armor), guard_eff)
            guard_eff = max(0, guard_eff - ignored_guard)
            ignored_regular += ignored_armor + ignored_guard

        if "stab" in mods_set:
            stab_ignore = min(1, armor_eff)
            armor_eff = max(0, armor_eff - stab_ignore)
            ignored_regular += stab_ignore

        if "overwhelm" in mods_set:
            ignored_regular += guard_eff
            guard_eff = 0

    if "magic_pierce" in mods_set:
        ignored_magic = magic_now

    magic_eff = max(0, magic_now - ignored_magic)

    # 3) compute damage & consume guard as a pool
    damage_after_fixed = max(0, damage - (armor_eff + magic_eff))
    guard_used = min(guard_eff, damage_after_fixed)
    dmg_to_hp = damage_after_fixed - guard_used

    guard_after = max(0, guard_now - guard_used)

    # 4) apply
    wounds_added = 0
    if reset_toughness_on_deplete:
        wounds_added = _apply_toughness_damage_with_resets(enemy, dmg_to_hp)
        if wounds_added:
            enemy.deck_state.hand.extend([WOUND_CARD_ID] * wounds_added)
    else:
        enemy.toughness_current = max(0, toughness_b - dmg_to_hp)
    enemy.guard_current = guard_after
    enemy.armor_current = armor_now  # includes shatter effect
    # magic armor unchanged by attacks for now

    applied_statuses: list[str] = []
    if "paralyse" in mods_set:
        enemy.statuses["paralyzed"] = {"stacks": 1}
        applied_statuses.append("paralyzed")

    guarded_total = damage - dmg_to_hp

    return CombatLog(
        instance_id=enemy.instance_id,
        action="attack",
        toughness_before=toughness_b,
        toughness_after=enemy.toughness_current,

        guard_before=guard_b,
        guard_after=enemy.guard_current,

        armor_before=armor_b,
        armor_after=enemy.armor_current,

        magic_armor_before=magic_b,
        magic_armor_after=enemy.magic_armor_current,

        input_damage=damage,
        ignored_regular=ignored_regular,
        ignored_magic=ignored_magic,
        guarded_total=guarded_total,
        damage_to_hp=dmg_to_hp,
        wounds_added=wounds_added,

        applied_statuses=tuple(applied_statuses),
    )


def _normalise_attack_mod(modifier: str) -> str:
    text = modifier.strip().lower().replace("-", "_")
    text = re.sub(r"\s+", " ", text)
    if text == "magic pierce":
        return "magic_pierce"
    if text == "paralyze":
        return "paralyse"
    amount_match = re.match(r"^(pierce|sunder)[:\s]+(\d+)$", text)
    if amount_match:
        return f"{amount_match.group(1)}:{int(amount_match.group(2))}"
    return text


def _sum_modifier_amount(raw_mods: Iterable[str], name: str, *, default_for_bare: int = 0) -> int:
    total = 0
    for mod in raw_mods:
        if mod == name:
            total += max(0, default_for_bare)
            continue
        amount_match = re.match(rf"^{re.escape(name)}:(\d+)$", mod)
        if amount_match:
            total += max(0, int(amount_match.group(1)))
    return total


def apply_heal(
    enemy: EnemyInstance,
    *,
    toughness: int = 0,
    armor: int = 0,
    magic_armor: int = 0,
    guard: int = 0,
    toughness_cap: int | None = None,
) -> CombatLog:
    """
    Restore toughness/armor/magic_armor/guard.
    """
    if toughness < 0 or armor < 0 or magic_armor < 0 or guard < 0:
        raise ValueError("heal values must be >= 0")

    toughness_b = enemy.toughness_current
    guard_b = enemy.guard_current
    armor_b = enemy.armor_current
    magic_b = enemy.magic_armor_current

    effective_toughness_cap = enemy.toughness_max if toughness_cap is None else max(0, int(toughness_cap))
    enemy.toughness_current = min(effective_toughness_cap, enemy.toughness_current + toughness)
    enemy.armor_current = min(enemy.armor_max, enemy.armor_current + armor)
    enemy.magic_armor_current = min(enemy.magic_armor_max, enemy.magic_armor_current + magic_armor)
    enemy.guard_current = min(9999, enemy.guard_current + guard)  # no max defined yet; UI can show it

    return CombatLog(
        instance_id=enemy.instance_id,
        action="heal",
        toughness_before=toughness_b,
        toughness_after=enemy.toughness_current,

        guard_before=guard_b,
        guard_after=enemy.guard_current,

        armor_before=armor_b,
        armor_after=enemy.armor_current,

        magic_armor_before=magic_b,
        magic_armor_after=enemy.magic_armor_current,
    )
