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

    block_before: int
    block_after: int

    armor_before: int
    armor_after: int

    magic_armor_before: int
    magic_armor_after: int

    # attack-specific info
    input_damage: int = 0
    ignored_regular: int = 0
    ignored_magic: int = 0
    blocked_total: int = 0
    damage_to_hp: int = 0

    applied_statuses: tuple[str, ...] = ()


def apply_attack(enemy: EnemyInstance, damage: int, mods: Optional[Iterable[AttackMod]] = None) -> CombatLog:
    """
    Apply incoming damage to an enemy, taking block/armor/magic armor into account.

    Rules:
      - reduction = block + armor + magic_armor
      - sunder: destroys 1 regular armor (not block)
      - stab: ignore 1 regular reduction (block first, then armor)
      - pierce: ignore all regular reduction (block + armor)
      - magic_pierce: ignore all magic armor reduction
      - paralyse: marks a status (no effect yet on draws until step 4)
    """
    if damage < 0:
        raise ValueError("damage must be >= 0")

    mods_set = set(mods or [])

    hp_b = enemy.hp_current
    block_b = enemy.block_current
    armor_b = enemy.armor_current
    magic_b = enemy.magic_armor_current

    # 1) sunder (always affects regular armor only)
    armor_after_sunder = armor_b
    if "sunder" in mods_set and armor_after_sunder > 0:
        armor_after_sunder -= 1

    # Use block as-is; sunder never touches it
    block_now = block_b
    armor_now = armor_after_sunder
    magic_now = magic_b

    # 2) compute ignores
    ignored_regular = 0
    ignored_magic = 0

    if "pierce" in mods_set:
        ignored_regular = block_now + armor_now
    elif "stab" in mods_set:
        ignored_regular = 1

    if "magic_pierce" in mods_set:
        ignored_magic = magic_now

    # 3) compute blocked and hp damage
    regular_blocked = max(0, (block_now + armor_now) - ignored_regular)
    magic_blocked = max(0, magic_now - ignored_magic)
    blocked_total = regular_blocked + magic_blocked

    dmg_to_hp = max(0, damage - blocked_total)
    hp_after = max(0, hp_b - dmg_to_hp)

    # 4) apply
    enemy.hp_current = hp_after
    enemy.armor_current = armor_now  # includes sunder effect
    # block and magic armor unchanged by attacks in step 3
    # (later: effects could destroy magic armor etc)

    applied_statuses: list[str] = []
    if "paralyse" in mods_set:
        # store a simple status payload; step 4 will interpret it
        enemy.statuses["paralyzed"] = {"stacks": 1}
        applied_statuses.append("paralyzed")

    return CombatLog(
        instance_id=enemy.instance_id,
        action="attack",
        hp_before=hp_b,
        hp_after=enemy.hp_current,

        block_before=block_b,
        block_after=enemy.block_current,

        armor_before=armor_b,
        armor_after=enemy.armor_current,

        magic_armor_before=magic_b,
        magic_armor_after=enemy.magic_armor_current,

        input_damage=damage,
        ignored_regular=ignored_regular,
        ignored_magic=ignored_magic,
        blocked_total=blocked_total,
        damage_to_hp=dmg_to_hp,

        applied_statuses=tuple(applied_statuses),
    )


def apply_heal(
    enemy: EnemyInstance,
    *,
    hp: int = 0,
    armor: int = 0,
    magic_armor: int = 0,
    block: int = 0,
) -> CombatLog:
    """
    Restore hp/armor/magic_armor/block (clamped to max).
    """
    if hp < 0 or armor < 0 or magic_armor < 0 or block < 0:
        raise ValueError("heal values must be >= 0")

    hp_b = enemy.hp_current
    block_b = enemy.block_current
    armor_b = enemy.armor_current
    magic_b = enemy.magic_armor_current

    enemy.hp_current = min(enemy.hp_max, enemy.hp_current + hp)
    enemy.armor_current = min(enemy.armor_max, enemy.armor_current + armor)
    enemy.magic_armor_current = min(enemy.magic_armor_max, enemy.magic_armor_current + magic_armor)
    enemy.block_current = min(9999, enemy.block_current + block)  # no max defined yet; UI can show it

    return CombatLog(
        instance_id=enemy.instance_id,
        action="heal",
        hp_before=hp_b,
        hp_after=enemy.hp_current,

        block_before=block_b,
        block_after=enemy.block_current,

        armor_before=armor_b,
        armor_after=enemy.armor_current,

        magic_armor_before=magic_b,
        magic_armor_after=enemy.magic_armor_current,
    )
