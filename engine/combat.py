from __future__ import annotations
from dataclasses import dataclass
from typing import Iterable, Literal, Optional

from engine.runtime_models import EnemyInstance

AttackMod = Literal["stab", "pierce", "magic_pierce", "sunder", "paralyse"]


@dataclass(frozen=True)
class CombatLog:
    instance_id: str
    action: str

    # before/after snapshots (minimal but useful)
    hp_before: int
    hp_after: int

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

    applied_statuses: tuple[str, ...] = ()


def apply_attack(enemy: EnemyInstance, damage: int, mods: Optional[Iterable[AttackMod]] = None) -> CombatLog:
    """
    Apply incoming damage to an enemy, taking guard/armor/magic armor into account.

    Rules:
      - armor and magic_armor are *persistent* flat reductions
      - guard is a *consumable pool* that resets each turn
      - sunder: destroys 1 regular armor (not guard)
      - stab: ignore 1 regular reduction (guard first, then armor)
      - pierce: ignore all regular reduction (guard + armor)
      - magic_pierce: ignore all magic armor reduction
      - paralyse: marks a status
    """
    if damage < 0:
        raise ValueError("damage must be >= 0")

    mods_set = set(mods or [])

    hp_b = enemy.hp_current
    guard_b = enemy.guard_current
    armor_b = enemy.armor_current
    magic_b = enemy.magic_armor_current

    # 1) sunder (always affects regular armor only)
    armor_after_sunder = armor_b
    if "sunder" in mods_set and armor_after_sunder > 0:
        armor_after_sunder -= 1

    guard_now = guard_b
    armor_now = armor_after_sunder
    magic_now = magic_b

    # 2) compute ignores (bypass reductions; do NOT destroy them)
    ignored_regular = 0
    ignored_magic = 0

    if "pierce" in mods_set:
        ignored_regular = guard_now + armor_now
    elif "stab" in mods_set:
        ignored_regular = 1

    if "magic_pierce" in mods_set:
        ignored_magic = magic_now

    # Apply ignore prioritization: stab ignores guard first, then armor.
    guard_eff = guard_now
    armor_eff = armor_now

    ignore = ignored_regular
    ignored_from_guard = min(guard_eff, ignore)
    guard_eff -= ignored_from_guard
    ignore -= ignored_from_guard

    ignored_from_armor = min(armor_eff, ignore)
    armor_eff -= ignored_from_armor

    magic_eff = max(0, magic_now - ignored_magic)

    # 3) compute damage & consume guard as a pool
    damage_after_fixed = max(0, damage - (armor_eff + magic_eff))
    guard_used = min(guard_eff, damage_after_fixed)
    dmg_to_hp = damage_after_fixed - guard_used

    hp_after = max(0, hp_b - dmg_to_hp)
    guard_after = max(0, guard_b - guard_used)

    # 4) apply
    enemy.hp_current = hp_after
    enemy.guard_current = guard_after
    enemy.armor_current = armor_now  # includes sunder effect
    # magic armor unchanged by attacks for now

    applied_statuses: list[str] = []
    if "paralyse" in mods_set:
        enemy.statuses["paralyzed"] = {"stacks": 1}
        applied_statuses.append("paralyzed")

    guarded_total = damage - dmg_to_hp

    return CombatLog(
        instance_id=enemy.instance_id,
        action="attack",
        hp_before=hp_b,
        hp_after=enemy.hp_current,

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

        applied_statuses=tuple(applied_statuses),
    )


def apply_heal(
    enemy: EnemyInstance,
    *,
    hp: int = 0,
    armor: int = 0,
    magic_armor: int = 0,
    guard: int = 0,
) -> CombatLog:
    """
    Restore hp/armor/magic_armor/guard (clamped to max).
    """
    if hp < 0 or armor < 0 or magic_armor < 0 or guard < 0:
        raise ValueError("heal values must be >= 0")

    hp_b = enemy.hp_current
    guard_b = enemy.guard_current
    armor_b = enemy.armor_current
    magic_b = enemy.magic_armor_current

    enemy.hp_current = min(enemy.hp_max, enemy.hp_current + hp)
    enemy.armor_current = min(enemy.armor_max, enemy.armor_current + armor)
    enemy.magic_armor_current = min(enemy.magic_armor_max, enemy.magic_armor_current + magic_armor)
    enemy.guard_current = min(9999, enemy.guard_current + guard)  # no max defined yet; UI can show it

    return CombatLog(
        instance_id=enemy.instance_id,
        action="heal",
        hp_before=hp_b,
        hp_after=enemy.hp_current,

        guard_before=guard_b,
        guard_after=enemy.guard_current,

        armor_before=armor_b,
        armor_after=enemy.armor_current,

        magic_armor_before=magic_b,
        magic_armor_after=enemy.magic_armor_current,
    )
