from __future__ import annotations
from dataclasses import dataclass

from engine.runtime_models import EnemyInstance


@dataclass(frozen=True)
class TurnHookLog:
    instance_id: str
    phase: str  # "start" | "end"
    toughness_before: int
    toughness_after: int
    guard_before: int
    guard_after: int
    removed_statuses: tuple[str, ...] = ()
    dot_damage: int = 0


def _get_stacks(statuses: dict, key: str) -> int:
    v = statuses.get(key)
    if v is None:
        return 0
    # we store as {"stacks": n}
    return int(v.get("stacks", 0))


def on_turn_start(enemy: EnemyInstance) -> TurnHookLog:
    toughness_b = enemy.toughness_current
    guard_b = enemy.guard_current

    # 1) reset guard
    enemy.guard_current = int(getattr(enemy, "guard_base", 0))

    # 2) apply DOT (ignores armor/guard)
    burn = _get_stacks(enemy.statuses, "burn")
    poison = _get_stacks(enemy.statuses, "poison")
    dot = max(0, burn) + max(0, poison)

    if dot > 0:
        enemy.toughness_current = max(0, enemy.toughness_current - dot)

    return TurnHookLog(
        instance_id=enemy.instance_id,
        phase="start",
        toughness_before=toughness_b,
        toughness_after=enemy.toughness_current,
        guard_before=guard_b,
        guard_after=enemy.guard_current,
        dot_damage=dot,
    )


def on_turn_end(enemy: EnemyInstance) -> TurnHookLog:
    toughness_b = enemy.toughness_current
    guard_b = enemy.guard_current

    removed: list[str] = []
    for k in ("paralyzed", "slowed"):
        if k in enemy.statuses:
            enemy.statuses.pop(k, None)
            removed.append(k)

    return TurnHookLog(
        instance_id=enemy.instance_id,
        phase="end",
        toughness_before=toughness_b,
        toughness_after=enemy.toughness_current,
        guard_before=guard_b,
        guard_after=enemy.guard_current,
        removed_statuses=tuple(removed),
    )
