from __future__ import annotations
from dataclasses import dataclass

from engine.runtime_models import EnemyInstance


@dataclass(frozen=True)
class TurnHookLog:
    instance_id: str
    phase: str  # "start" | "end"
    hp_before: int
    hp_after: int
    block_before: int
    block_after: int
    removed_statuses: tuple[str, ...] = ()
    dot_damage: int = 0


def _get_stacks(statuses: dict, key: str) -> int:
    v = statuses.get(key)
    if v is None:
        return 0
    # we store as {"stacks": n}
    return int(v.get("stacks", 0))


def on_turn_start(enemy: EnemyInstance) -> TurnHookLog:
    hp_b = enemy.hp_current
    block_b = enemy.block_current

    # 1) reset block
    enemy.block_current = 0

    # 2) apply DOT (ignores armor/block)
    burn = _get_stacks(enemy.statuses, "burn")
    poison = _get_stacks(enemy.statuses, "poison")
    dot = max(0, burn) + max(0, poison)

    if dot > 0:
        enemy.hp_current = max(0, enemy.hp_current - dot)

    return TurnHookLog(
        instance_id=enemy.instance_id,
        phase="start",
        hp_before=hp_b,
        hp_after=enemy.hp_current,
        block_before=block_b,
        block_after=enemy.block_current,
        dot_damage=dot,
    )


def on_turn_end(enemy: EnemyInstance) -> TurnHookLog:
    hp_b = enemy.hp_current
    block_b = enemy.block_current

    removed: list[str] = []
    for k in ("paralyzed", "slowed"):
        if k in enemy.statuses:
            enemy.statuses.pop(k, None)
            removed.append(k)

    return TurnHookLog(
        instance_id=enemy.instance_id,
        phase="end",
        hp_before=hp_b,
        hp_after=enemy.hp_current,
        block_before=block_b,
        block_after=enemy.block_current,
        removed_statuses=tuple(removed),
    )
