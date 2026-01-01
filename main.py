# main.py
from __future__ import annotations

import argparse
import random
import traceback
from pathlib import Path

from engine.loader import load_decks, load_enemies
from engine.runtime import spawn_enemy, enemy_turn, end_turn
from engine.turn_hooks import on_turn_start
from engine.combat import apply_attack, apply_heal


def build_card_index(decks: dict, enemy_templates: dict) -> dict:
    """Card lookup for pretty-printing."""
    idx = {}
    for d in decks.values():
        for c in d.cards:
            idx[c.id] = c
    for et in enemy_templates.values():
        for s in et.specials:
            idx[s.id] = s
    return idx


def card_to_text(card_index: dict, card_id: str) -> str:
    c = card_index.get(card_id)
    if not c:
        return card_id
    parts = []
    for eff in c.effects:
        if eff.type == "attack":
            if getattr(eff, "modifiers", ()):
                parts.append(f"Attack {eff.amount} ({', '.join(eff.modifiers)})")
            else:
                parts.append(f"Attack {eff.amount}")
        elif eff.type == "guard":
            parts.append(f"Guard {eff.amount}")
        else:
            parts.append(str(eff.type))
    return " + ".join(parts) if parts else (c.title or card_id)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--enemy", default="goblin", help="enemy template id (e.g. goblin, bandid)")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument(
        "--strict-images",
        action="store_true",
        help="enable image existence check (will fail if /images is missing the file)",
    )
    args = parser.parse_args()

    root = Path(__file__).parent
    decks_dir = root / "data" / "decks"
    enemies_dir = root / "data" / "enemies"
    images_dir = root / "images"

    rnd = random.Random(args.seed)

    try:
        decks = load_decks(decks_dir)

        # Skip image checks by default (so engine tests run even if images are missing)
        img_dir_for_loader = images_dir if args.strict_images else (root / "__no_images__does_not_exist__")
        enemies = load_enemies(enemies_dir, decks=decks, images_dir=img_dir_for_loader)

        if args.enemy not in enemies:
            print(f"ERROR: unknown enemy id '{args.enemy}'. Available: {sorted(enemies.keys())}")
            return 2

        card_index = build_card_index(decks, enemies)
        tpl = enemies[args.enemy]
        e = spawn_enemy(tpl, decks, rnd=rnd)

        print("=== SPAWNED ===")
        print(f"template_id={tpl.id} name={tpl.name} image={tpl.image}")
        print(
            f"HP {e.hp_current}/{e.hp_max} | Armor {e.armor_current}/{e.armor_max} | "
            f"Magic {e.magic_armor_current}/{e.magic_armor_max} | "
            f"Guard {getattr(e, 'guard_current', 0)} (base {getattr(e, 'guard_base', 0)})"
        )

        # Ensure we start with base guard (if you spawn with 0, this shows it clearly)
        print("\n=== TURN START (reset guard to base) ===")
        th = on_turn_start(e)
        print(f"guard: {th.guard_before} -> {th.guard_after} | hp: {th.hp_before} -> {th.hp_after} | dot={th.dot_damage}")

        # Simulate a draw turn and auto-apply guard cards (like the UI does)
        print("\n=== ENEMY TURN (draw + auto-apply guard cards) ===")
        res = enemy_turn(e, rnd=rnd)
        print(f"drawn ids: {res.drawn}")
        print("drawn text:", ", ".join(card_to_text(card_index, cid) for cid in res.drawn) or "—")

        guard_added = 0
        for cid in res.drawn:
            c = card_index.get(cid)
            if not c:
                continue
            for eff in c.effects:
                if eff.type == "guard":
                    apply_heal(e, guard=int(eff.amount))
                    guard_added += int(eff.amount)

        print(f"auto-guard added from draw: {guard_added}")
        print(
            f"after draw: HP {e.hp_current}/{e.hp_max} | Guard {e.guard_current} (base {getattr(e,'guard_base',0)})"
        )

        # Now test guard as a *consumable pool* with an incoming hit
        print("\n=== APPLY ATTACK (tests guard consumption) ===")
        dmg = 5
        log = apply_attack(e, dmg, mods=[])
        print(
            f"in={log.input_damage} guarded_total={log.guarded_total} damage_to_hp={log.damage_to_hp} "
            f"HP {log.hp_before}->{log.hp_after} | Guard {log.guard_before}->{log.guard_after} | "
            f"Armor {log.armor_before}->{log.armor_after} | Magic {log.magic_armor_before}->{log.magic_armor_after}"
        )

        print("\n=== END TURN ===")
        end_turn(e)
        print(f"hand={len(e.deck_state.hand)} discard={len(e.deck_state.discard_pile)}")

        # Next turn start should reset guard back to base again
        print("\n=== NEXT TURN START (guard reset) ===")
        th2 = on_turn_start(e)
        print(f"guard: {th2.guard_before} -> {th2.guard_after} | hp: {th2.hp_before} -> {th2.hp_after} | dot={th2.dot_damage}")

        print("\nOK")
        return 0

    except Exception as ex:
        print("\n!!! EXCEPTION !!!")
        print(ex)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
