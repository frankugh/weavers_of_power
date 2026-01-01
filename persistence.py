# persistence.py
from __future__ import annotations

import json
import os
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple, List

from engine.runtime_models import EnemyInstance, DeckState


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _atomic_write_json(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


def _backup_then_write(path: Path, data: Dict[str, Any]) -> None:
    """Write atomically and keep a .bak copy of the previous file if it exists."""
    bak = path.with_suffix(path.suffix + ".bak")
    if path.exists():
        try:
            path.replace(bak)
        except Exception:
            # if backup fails, still try to write the new file
            pass
    _atomic_write_json(path, data)


def enemy_to_dict(e: EnemyInstance) -> Dict[str, Any]:
    # EnemyInstance and DeckState are dataclasses in your project
    if is_dataclass(e):
        d = asdict(e)
    else:
        d = dict(e.__dict__)

    # Make sure optional runtime extras exist in the save
    d.setdefault("last_drawn", getattr(e, "last_drawn", []))
    d.setdefault("loot_rolled", getattr(e, "loot_rolled", False))
    d.setdefault("rolled_loot", getattr(e, "rolled_loot", None))

    return d


def enemy_from_dict(d: Dict[str, Any]) -> EnemyInstance:
    deck = d.get("deck_state") or {}
    deck_state = DeckState(
        draw_pile=list(deck.get("draw_pile", [])),
        discard_pile=list(deck.get("discard_pile", [])),
        hand=list(deck.get("hand", [])),
    )

    e = EnemyInstance(
        instance_id=d["instance_id"],
        template_id=d.get("template_id", "custom"),
        name=d.get("name", d.get("template_id", "Enemy")),
        image=d.get("image", None),
        hp_current=int(d.get("hp_current", 0)),
        hp_max=int(d.get("hp_max", 0)),
        armor_current=int(d.get("armor_current", 0)),
        armor_max=int(d.get("armor_max", 0)),
        magic_armor_current=int(d.get("magic_armor_current", 0)),
        magic_armor_max=int(d.get("magic_armor_max", 0)),
        guard_base=int(d.get("guard_base", 0)),
        guard_current=int(d.get("guard_current", 0)),
        draws_base=int(d.get("draws_base", 0)),
        movement=int(d.get("movement", 0)),
        deck_state=deck_state,
        statuses=dict(d.get("statuses", {})),
    )

    # runtime extras
    e.last_drawn = list(d.get("last_drawn", []))
    e.loot_rolled = bool(d.get("loot_rolled", False))
    e.rolled_loot = d.get("rolled_loot", None)

    return e


def make_save_payload(
    *,
    version: int,
    sid: str,
    order: List[str],
    selected_id: Optional[str],
    active_turn_id: Optional[str],
    turn_in_progress: bool,
    enemies: List[EnemyInstance],
) -> Dict[str, Any]:
    return {
        "version": version,
        "app": "weavers_of_power_battle_sim",
        "saved_at": _utc_now_iso(),
        "sid": sid,
        "ui": {
            "selected_id": selected_id,
            "active_turn_id": active_turn_id,
            "turn_in_progress": turn_in_progress,
        },
        "order": list(order),
        "enemies": [enemy_to_dict(e) for e in enemies],
    }


def load_save_payload(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        # try backup if main file is corrupted
        bak = path.with_suffix(path.suffix + ".bak")
        if bak.exists():
            try:
                with bak.open("r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return None
        return None


def save_current(path: Path, payload: Dict[str, Any]) -> None:
    _backup_then_write(path, payload)


def restore_state_from_payload(
    payload: Dict[str, Any],
) -> Tuple[List[str], Optional[str], Optional[str], bool, List[EnemyInstance]]:
    order = list(payload.get("order", []))
    ui = payload.get("ui", {}) or {}
    selected_id = ui.get("selected_id")
    active_turn_id = ui.get("active_turn_id")
    turn_in_progress = bool(ui.get("turn_in_progress", False))

    enemies_raw = payload.get("enemies", []) or []
    enemies = [enemy_from_dict(ed) for ed in enemies_raw]

    return order, selected_id, active_turn_id, turn_in_progress, enemies
