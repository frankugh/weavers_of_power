from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from battle_session import BattleSessionContext
from engine.combat import WOUND_CARD_ID
from engine.loader import load_decks, load_enemies
from persistence import save_current

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class BattleSessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.saves_dir = Path(self.temp_dir.name) / "saves"
        self.context = BattleSessionContext(root=PROJECT_ROOT, saves_dir=self.saves_dir)

    def test_create_session_has_expected_defaults(self) -> None:
        session = self.context.create_session("session-defaults")

        snapshot = session.snapshot()

        self.assertEqual(snapshot["sid"], "session-defaults")
        self.assertEqual(snapshot["round"], 1)
        self.assertEqual(snapshot["combatLog"], [])
        self.assertEqual(snapshot["order"], [])
        self.assertEqual(snapshot["room"], {"columns": 10, "rows": 7})

    def test_room_size_allows_large_maps_with_guardrail(self) -> None:
        session = self.context.create_session("large-map")

        session.set_room_size(99, 99)

        self.assertEqual(session.snapshot()["room"], {"columns": 99, "rows": 99})
        with self.assertRaisesRegex(ValueError, "between 3 and 99"):
            session.set_room_size(100, 99)

    def test_added_units_are_auto_placed_on_the_battle_map(self) -> None:
        session = self.context.create_session("map-placement")

        session.add_enemy_from_template("goblin")
        session.add_player()
        snapshot = session.snapshot()

        first, second = snapshot["enemies"]
        self.assertEqual((first["grid_x"], first["grid_y"]), (4, 3))
        self.assertEqual((second["grid_x"], second["grid_y"]), (5, 3))

    def test_enemy_loader_validates_taxonomy_image_category(self) -> None:
        root = Path(self.temp_dir.name) / "taxonomy"
        decks_dir = root / "decks"
        enemies_dir = root / "enemies"
        images_dir = root / "images"
        decks_dir.mkdir(parents=True)
        (enemies_dir / "Greenskins").mkdir(parents=True)
        (enemies_dir / "Outlaws").mkdir(parents=True)
        (images_dir / "Greenskins").mkdir(parents=True)
        (images_dir / "Outlaws").mkdir(parents=True)
        (images_dir / "Greenskins" / "goblin.png").write_bytes(b"image")
        (images_dir / "Outlaws" / "bandit.png").write_bytes(b"image")
        (decks_dir / "basic.json").write_text(
            """
{
  "id": "basic",
  "name": "Basic",
  "cards": [{ "id": "basic_a2", "title": "Attack 2", "effects": [{ "type": "attack", "amount": 2 }] }]
}
""".strip(),
            encoding="utf-8",
        )
        enemy_json = """
{
  "id": "goblin",
  "name": "Goblin",
  "image": "Greenskins/goblin.png",
  "hp": { "min": 5, "max": 5 },
  "baseGuard": { "min": 0, "max": 0 },
  "armor": { "min": 0, "max": 0 },
  "magicArmor": { "min": 0, "max": 0 },
  "coreDeck": "basic",
  "movement": 5,
  "draws": 1,
  "specials": [
    { "id": "goblin_s1", "title": "Attack 1", "effects": [{ "type": "attack", "amount": 1 }] },
    { "id": "goblin_s2", "title": "Attack 2", "effects": [{ "type": "attack", "amount": 2 }] },
    { "id": "goblin_s3", "title": "Attack 3", "effects": [{ "type": "attack", "amount": 3 }] }
  ],
  "loot": [{ "type": "currency", "kind": "cp", "min": 0, "max": 1 }]
}
""".strip()
        (enemies_dir / "Greenskins" / "goblin.json").write_text(enemy_json, encoding="utf-8")
        decks = load_decks(decks_dir)

        loaded = load_enemies(enemies_dir, decks=decks, images_dir=images_dir)
        self.assertEqual(loaded["goblin"].category, "Greenskins")

        (enemies_dir / "Outlaws" / "bad.json").write_text(
            enemy_json.replace('"id": "goblin"', '"id": "bad_goblin"'),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ValueError, "does not match enemy category"):
            load_enemies(enemies_dir, decks=decks, images_dir=images_dir)

    def test_set_entity_position_requires_free_in_bounds_cell(self) -> None:
        session = self.context.create_session("map-position")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id

        session.set_entity_position(first_id, 0, 0)
        moved = session.state.enemies[first_id]
        self.assertEqual((moved.grid_x, moved.grid_y), (0, 0))
        self.assertEqual(session.selected_id, first_id)

        with self.assertRaisesRegex(ValueError, "occupied"):
            session.set_entity_position(second_id, 0, 0)
        session.state.enemies[first_id].toughness_current = 0
        session.set_entity_position(second_id, 0, 0)
        moved_second = session.state.enemies[second_id]
        self.assertEqual((moved_second.grid_x, moved_second.grid_y), (0, 0))
        with self.assertRaisesRegex(ValueError, "outside"):
            session.set_entity_position(second_id, 99, 0)

    def test_active_unit_can_spend_movement_pool_across_multiple_moves_and_dash(self) -> None:
        session = self.context.create_session("movement-pool")
        session.add_enemy_from_template("bandit")
        entity_id = session.selected_id
        session.set_entity_position(entity_id, 0, 0)
        session.next_turn()
        session.start_new_round()  # single unit always wraps

        session.move_entity_with_movement(entity_id, 2, 0)
        session.move_entity_with_movement(entity_id, 3, 0)
        with self.assertRaisesRegex(ValueError, "requires a Dash"):
            session.move_entity_with_movement(entity_id, 7, 0)

        session.move_entity_with_movement(entity_id, 7, 0, dash=True)
        session.move_entity_with_movement(entity_id, 7, 3)

        self.assertEqual(session.movement_state["movement_used"], 10)
        self.assertTrue(session.movement_state["dash_used"])
        moved = session.state.enemies[entity_id]
        self.assertEqual((moved.grid_x, moved.grid_y), (7, 3))

    def test_movement_rejects_non_active_and_over_double_pool_moves(self) -> None:
        session = self.context.create_session("movement-limits")
        session.set_room_size(20, 20)
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id
        session.set_entity_position(first_id, 0, 0)
        session.set_entity_position(second_id, 0, 1)
        session.select(first_id)
        session.next_turn()

        self.assertEqual(session.active_turn_id, second_id)
        with self.assertRaisesRegex(ValueError, "Only the active"):
            session.move_entity_with_movement(first_id, 1, 0)
        with self.assertRaisesRegex(ValueError, "not reachable|not have enough"):
            session.move_entity_with_movement(second_id, 13, 1, dash=True)

    def test_diagonal_movement_cost_parity_continues_across_moves(self) -> None:
        session = self.context.create_session("movement-diagonal-parity")
        session.add_enemy_from_template("bandit")
        entity_id = session.selected_id
        session.set_entity_position(entity_id, 0, 0)
        session.next_turn()
        session.start_new_round()  # single unit always wraps

        session.move_entity_with_movement(entity_id, 1, 1)
        self.assertEqual(session.movement_state["movement_used"], 1)
        self.assertEqual(session.movement_state["diagonal_steps_used"], 1)

        session.move_entity_with_movement(entity_id, 2, 2)
        self.assertEqual(session.movement_state["movement_used"], 3)
        self.assertEqual(session.movement_state["diagonal_steps_used"], 2)

        session.move_entity_with_movement(entity_id, 3, 3)
        self.assertEqual(session.movement_state["movement_used"], 4)
        self.assertEqual(session.movement_state["diagonal_steps_used"], 3)

    def test_start_encounter_uses_first_non_down_in_order_and_resets_turn_state(self) -> None:
        session = self.context.create_session("start-encounter")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id
        first_enemy = session.state.enemies[first_id]
        first_enemy.deck_state.hand = ["basic_a3"]
        first_enemy.visible_draw = ["basic_a3"]

        session.select(second_id)
        session.start_encounter()

        self.assertEqual(session.selected_id, first_id)
        self.assertEqual(session.active_turn_id, first_id)
        self.assertFalse(session.turn_in_progress)
        self.assertEqual(session.movement_state["entity_id"], first_id)
        self.assertEqual(session.movement_state["movement_used"], 0)
        self.assertEqual(first_enemy.deck_state.hand, [])
        self.assertEqual(first_enemy.deck_state.discard_pile, ["basic_a3"])
        self.assertEqual(session.visible_draw_for(first_enemy), [])
        self.assertIn(f"Active turn: {first_enemy.name}", session.combat_log)

    def test_start_encounter_skips_down_units_and_rejects_invalid_starts(self) -> None:
        session = self.context.create_session("start-encounter-skip-down")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id
        session.state.enemies[first_id].toughness_current = 0

        session.start_encounter()

        self.assertEqual(session.selected_id, second_id)
        self.assertEqual(session.active_turn_id, second_id)
        with self.assertRaisesRegex(ValueError, "already has an active turn"):
            session.start_encounter()

        all_down = self.context.create_session("start-encounter-all-down")
        all_down.add_enemy_from_template("goblin")
        all_down.state.enemies[all_down.selected_id].toughness_current = 0

        with self.assertRaisesRegex(ValueError, "No units can start encounter"):
            all_down.start_encounter()
        self.assertIsNone(all_down.active_turn_id)
        self.assertFalse(all_down.turn_in_progress)

    def test_movement_pathing_blocks_living_units_but_not_down_units(self) -> None:
        session = self.context.create_session("movement-blockers")
        session.set_room_size(3, 3)
        session.add_enemy_from_template("bandit")
        mover_id = session.selected_id
        session.add_enemy_from_template("goblin")
        top_blocker_id = session.selected_id
        session.add_enemy_from_template("goblin")
        middle_blocker_id = session.selected_id
        session.add_enemy_from_template("goblin")
        bottom_blocker_id = session.selected_id

        for instance_id in (mover_id, top_blocker_id, middle_blocker_id, bottom_blocker_id):
            entity = session.state.enemies[instance_id]
            entity.grid_x = None
            entity.grid_y = None
        session.set_entity_position(mover_id, 0, 1)
        session.set_entity_position(top_blocker_id, 1, 0)
        session.set_entity_position(middle_blocker_id, 1, 1)
        session.set_entity_position(bottom_blocker_id, 1, 2)
        session.select(mover_id)
        session.draw_turn()

        with self.assertRaisesRegex(ValueError, "not reachable"):
            session.move_entity_with_movement(mover_id, 2, 1)

        session.state.enemies[middle_blocker_id].toughness_current = 0
        session.move_entity_with_movement(mover_id, 2, 1)

        moved = session.state.enemies[mover_id]
        self.assertEqual((moved.grid_x, moved.grid_y), (2, 1))

    def test_movement_state_persists_and_resets_on_next_active_turn(self) -> None:
        session = self.context.create_session("movement-persist")
        session.add_enemy_from_template("bandit")
        entity_id = session.selected_id
        session.set_entity_position(entity_id, 0, 0)
        session.next_turn()
        session.start_new_round()  # single unit always wraps
        session.move_entity_with_movement(entity_id, 2, 0)

        reloaded = self.context.load_session("movement-persist")
        self.assertEqual(reloaded.movement_state["entity_id"], entity_id)
        self.assertEqual(reloaded.movement_state["movement_used"], 2)

        reloaded.next_turn()
        reloaded.start_new_round()  # single unit wraps again
        self.assertEqual(reloaded.movement_state["entity_id"], entity_id)
        self.assertEqual(reloaded.movement_state["movement_used"], 0)

    def test_auto_place_ignores_down_units_as_blockers(self) -> None:
        session = self.context.create_session("map-down-passable")
        session.add_enemy_from_template("goblin")
        down_id = session.selected_id
        session.state.enemies[down_id].toughness_current = 0

        session.add_player()
        player = session.state.enemies[session.selected_id]
        down = session.state.enemies[down_id]

        self.assertEqual((down.grid_x, down.grid_y), (4, 3))
        self.assertEqual((player.grid_x, player.grid_y), (4, 3))

    def test_resize_warns_then_auto_places_out_of_bounds_units(self) -> None:
        session = self.context.create_session("map-resize")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.set_entity_position(first_id, 9, 6)

        with self.assertRaisesRegex(ValueError, "Resize would move"):
            session.set_room_size(3, 3)

        session.set_room_size(3, 3, auto_place_out_of_bounds=True)
        moved = session.state.enemies[first_id]

        self.assertEqual(session.snapshot()["room"], {"columns": 3, "rows": 3})
        self.assertIsNotNone(moved.grid_x)
        self.assertIsNotNone(moved.grid_y)
        self.assertLess(moved.grid_x, 3)
        self.assertLess(moved.grid_y, 3)

    def test_auto_place_leaves_units_unplaced_when_room_is_full(self) -> None:
        session = self.context.create_session("map-full")
        session.set_room_size(3, 3)

        for _ in range(10):
            session.add_player()

        snapshot = session.snapshot()
        placed = [entity for entity in snapshot["enemies"] if entity["grid_x"] is not None]
        unplaced = [entity for entity in snapshot["enemies"] if entity["grid_x"] is None]

        self.assertEqual(len(placed), 9)
        self.assertEqual(len(unplaced), 1)

    def test_draw_and_end_turn_keep_draw_visible_until_next_start(self) -> None:
        session = self.context.create_session("draw-turn")
        session.add_enemy_from_template("goblin")

        session.draw_turn()
        self.assertIsNotNone(session.active_turn_id)
        self.assertTrue(session.turn_in_progress)
        self.assertGreaterEqual(len(session.snapshot()["combatLog"]), 1)

        session.end_turn_selected()
        reloaded = self.context.load_session("draw-turn")

        self.assertIsNone(reloaded.active_turn_id)
        self.assertFalse(reloaded.turn_in_progress)
        selected = reloaded.state.enemies[reloaded.selected_id]
        self.assertGreaterEqual(len(selected.deck_state.hand), 1)
        self.assertGreaterEqual(len(reloaded.visible_draw_for(selected)), 1)
        self.assertGreaterEqual(len(reloaded.snapshot()["enemies"][0]["current_draw_text"]), 1)

    def test_draw_is_discarded_when_same_unit_starts_again(self) -> None:
        session = self.context.create_session("draw-replace")
        session.add_enemy_from_template("goblin")
        enemy = session.state.enemies[session.selected_id]

        session.draw_turn()
        first_visible_draw = session.visible_draw_for(enemy)

        self.assertEqual(enemy.deck_state.hand, first_visible_draw)
        self.assertGreaterEqual(len(first_visible_draw), 1)

        with self.assertRaisesRegex(ValueError, "already drawn"):
            session.draw_turn()

        session.end_turn_selected()
        self.assertEqual(enemy.deck_state.hand, first_visible_draw)
        self.assertEqual(session.visible_draw_for(enemy), first_visible_draw)

        session.next_turn()
        session.start_new_round()  # single unit always wraps

        self.assertEqual(session.active_turn_id, enemy.instance_id)
        self.assertFalse(session.turn_in_progress)
        self.assertEqual(len(enemy.deck_state.hand), 0)
        self.assertEqual(len(enemy.deck_state.discard_pile), len(first_visible_draw))
        self.assertEqual(session.visible_draw_for(enemy), [])
        self.assertEqual(session.snapshot()["enemies"][0]["current_draw_text"], [])

    def test_redraw_replaces_current_draw_during_active_turn(self) -> None:
        session = self.context.create_session("redraw-turn")
        session.add_enemy_from_template("goblin")
        enemy = session.state.enemies[session.selected_id]

        session.draw_turn()
        first_hand = list(enemy.deck_state.hand)

        session.redraw_turn()

        self.assertTrue(session.turn_in_progress)
        self.assertEqual(session.active_turn_id, enemy.instance_id)
        self.assertEqual(len(enemy.deck_state.discard_pile), len(first_hand))
        self.assertEqual(session.visible_draw_for(enemy), enemy.deck_state.hand)
        self.assertGreaterEqual(len(session.snapshot()["enemies"][0]["current_draw_text"]), 1)
        self.assertIn("redraws", session.combat_log[0])

    def test_current_draw_persists_until_that_same_unit_turn_starts_again(self) -> None:
        session = self.context.create_session("draw-persist")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        first_enemy = session.state.enemies[first_id]
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id

        session.select(first_id)
        session.draw_turn()
        first_visible_draw = session.visible_draw_for(first_enemy)
        session.end_turn_selected()

        session.next_turn()
        self.assertEqual(session.active_turn_id, second_id)
        self.assertEqual(session.visible_draw_for(first_enemy), first_visible_draw)

        session.select(first_id)
        persisted_enemy = next(enemy for enemy in session.snapshot()["enemies"] if enemy["instance_id"] == first_id)
        self.assertGreaterEqual(len(persisted_enemy["current_draw_text"]), 1)

        session.select(second_id)
        session.next_turn()
        session.start_new_round()  # wraps back to first unit

        self.assertEqual(session.active_turn_id, first_id)
        self.assertEqual(session.visible_draw_for(first_enemy), [])

    def test_next_without_draw_resolves_the_active_turn(self) -> None:
        session = self.context.create_session("next-no-draw")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id
        second_enemy = session.state.enemies[second_id]
        second_enemy.statuses["burn"] = {"stacks": 2}
        second_enemy.statuses["slowed"] = {}
        hp_before = second_enemy.toughness_current

        session.select(first_id)
        session.next_turn()

        self.assertEqual(session.active_turn_id, second_id)
        self.assertEqual(second_enemy.toughness_current, max(0, hp_before - 2))
        self.assertIn("slowed", second_enemy.statuses)

        session.next_turn()
        session.start_new_round()  # wraps back to first unit

        self.assertEqual(session.active_turn_id, first_id)
        self.assertNotIn("slowed", second_enemy.statuses)

    def test_next_turn_skips_down_units(self) -> None:
        session = self.context.create_session("skip-down-turns")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        down_id = session.selected_id
        session.add_enemy_from_template("goblin")
        third_id = session.selected_id
        session.state.enemies[down_id].toughness_current = 0

        session.select(first_id)
        session.next_turn()

        self.assertEqual(session.selected_id, third_id)
        self.assertEqual(session.active_turn_id, third_id)
        self.assertFalse(session.turn_in_progress)

    def test_down_units_cannot_start_turns(self) -> None:
        session = self.context.create_session("down-turn-blocked")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id
        session.state.enemies[first_id].toughness_current = 0
        session.state.enemies[second_id].toughness_current = 0

        session.select(first_id)
        with self.assertRaisesRegex(ValueError, "Down units cannot take a turn"):
            session.draw_turn()

        session.next_turn()

        self.assertIsNone(session.active_turn_id)
        self.assertFalse(session.turn_in_progress)

    def test_round_increments_when_next_wraps(self) -> None:
        session = self.context.create_session("round-wrap")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id

        session.select(first_id)
        session.next_turn()
        self.assertEqual(session.selected_id, second_id)
        self.assertEqual(session.round, 1)

        session.next_turn()
        self.assertTrue(session.pending_new_round)
        self.assertEqual(session.round, 1)  # not incremented yet
        session.start_new_round()

        reloaded = self.context.load_session("round-wrap")
        self.assertEqual(reloaded.selected_id, first_id)
        self.assertEqual(reloaded.round, 2)
        self.assertIn("Round 2 begins", reloaded.combat_log)

    def test_manual_save_and_load_restore_entities(self) -> None:
        session = self.context.create_session("manual-load")
        session.add_enemy_from_template("goblin")
        selected_id = session.selected_id
        session.apply_attack_to_selected(
            damage=2,
            modifiers=[],
            add_burn=True,
            add_poison=False,
            add_slow=False,
            add_paralyze=False,
        )

        save_info = session.save_manual("manual-load")
        session.delete_entity(selected_id)
        self.assertEqual(session.order, [])

        session.load_manual(save_info["filename"])
        reloaded = self.context.load_session("manual-load")

        self.assertEqual(len(reloaded.order), 1)
        restored = reloaded.state.enemies[reloaded.selected_id]
        self.assertIn("burn", restored.statuses)
        self.assertIn(f"Loaded save: {save_info['filename']}", reloaded.combat_log)

    def test_stab_ignores_one_armor_before_guard_absorbs_damage(self) -> None:
        session = self.context.create_session("stab-armor-before-guard")
        session.add_enemy_from_template("goblin")
        entity = session.state.enemies[session.selected_id]
        entity.toughness_current = 10
        entity.toughness_max = 10
        entity.guard_current = 3
        entity.armor_current = 2
        entity.armor_max = 2

        session.apply_attack_to_selected(
            damage=2,
            modifiers=["stab"],
            add_burn=False,
            add_poison=False,
            add_slow=False,
            add_paralyze=False,
        )

        self.assertEqual(entity.toughness_current, 10)
        self.assertEqual(entity.armor_current, 2)
        self.assertEqual(entity.guard_current, 2)

    def test_attack_and_heal_can_target_player_cards(self) -> None:
        session = self.context.create_session("player-attack-heal")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0, power=1, movement=5)
        player = session.state.enemies[session.selected_id]

        session.apply_attack_to_selected(
            damage=2,
            modifiers=[],
            add_burn=False,
            add_poison=False,
            add_slow=False,
            add_paralyze=False,
        )
        self.assertEqual(player.toughness_current, 3)

        session.apply_heal_to_selected(toughness=1, armor=0, magic_armor=0, guard=0)
        self.assertEqual(player.toughness_current, 4)

    def test_player_damage_adds_wounds_and_resets_toughness_for_overflow(self) -> None:
        session = self.context.create_session("player-wounds")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0, power=1, movement=5)
        player = session.state.enemies[session.selected_id]
        player.toughness_current = 3

        result = session.apply_attack_to_selected(
            damage=9,
            modifiers=[],
            add_burn=False,
            add_poison=False,
            add_slow=False,
            add_paralyze=False,
        )

        self.assertEqual(player.toughness_current, 4)
        self.assertEqual(player.deck_state.discard_pile, [WOUND_CARD_ID, WOUND_CARD_ID])
        self.assertEqual(result["woundEvents"][0]["wounds"], 2)
        self.assertEqual(result["woundEvents"][0]["toughnessAfter"], 4)
        self.assertIn("2 wounds added", session.combat_log[0])

    def test_delete_manual_save_removes_file_and_backup(self) -> None:
        session = self.context.create_session("manual-delete")
        save_info = session.save_manual("delete-me")
        path = self.context.manual_dir / save_info["filename"]
        backup = path.with_suffix(path.suffix + ".bak")
        backup.write_text("{}", encoding="utf-8")

        session.delete_manual(save_info["filename"])

        self.assertFalse(path.exists())
        self.assertFalse(backup.exists())
        self.assertEqual(session.list_manual_saves(), [])

    def test_loaded_template_enemy_deck_migrates_to_current_template_core_deck(self) -> None:
        sid = "legacy-goblin-deck"
        legacy_payload = {
            "version": 3,
            "app": "weavers_of_power_battle_sim",
            "saved_at": "2026-01-01T00:00:00+00:00",
            "sid": sid,
            "ui": {
                "selected_id": "goblin-1",
                "active_turn_id": "goblin-1",
                "turn_in_progress": True,
            },
            "order": ["goblin-1"],
            "enemies": [
                {
                    "instance_id": "goblin-1",
                    "template_id": "goblin",
                    "name": "Goblin 1",
                    "image": "goblin.png",
                    "toughness_current": 5,
                    "toughness_max": 5,
                    "armor_current": 1,
                    "armor_max": 1,
                    "magic_armor_current": 0,
                    "magic_armor_max": 0,
                    "guard_base": 0,
                    "guard_current": 0,
                    "power_base": 1,
                    "movement": 5,
                    "deck_state": {
                        "draw_pile": ["basic_a2", "goblin_s1", "basic_a3", "basic_a4g1"],
                        "discard_pile": ["basic_a5"],
                        "hand": ["basic_a4"],
                    },
                    "visible_draw": ["basic_a4"],
                    "statuses": {},
                }
            ],
        }
        save_current(self.context.current_path(sid), legacy_payload)

        session = self.context.load_session(sid)
        entity = session.state.enemies["goblin-1"]
        all_card_ids = entity.deck_state.draw_pile + entity.deck_state.discard_pile + entity.deck_state.hand
        control_ids = {card.id for card in self.context.decks["control"].cards}
        goblin_special_ids = {card.id for card in self.context.enemy_templates["goblin"].specials}

        self.assertTrue(all(card_id in control_ids | goblin_special_ids for card_id in all_card_ids))
        self.assertFalse(any(card_id.startswith("basic_") for card_id in all_card_ids))
        self.assertEqual(len([card_id for card_id in all_card_ids if card_id in control_ids]), len(control_ids))
        self.assertEqual(goblin_special_ids, {card_id for card_id in all_card_ids if card_id in goblin_special_ids})
        self.assertEqual(entity.deck_state.hand, session.visible_draw_for(entity))

    def test_legacy_save_without_round_and_log_defaults_cleanly(self) -> None:
        sid = "legacy-payload"
        legacy_payload = {
            "version": 1,
            "app": "weavers_of_power_battle_sim",
            "saved_at": "2026-01-01T00:00:00+00:00",
            "sid": sid,
            "ui": {
                "selected_id": None,
                "active_turn_id": None,
                "turn_in_progress": False,
            },
            "order": [],
            "enemies": [],
        }
        save_current(self.context.current_path(sid), legacy_payload)

        session = self.context.load_session(sid)

        self.assertEqual(session.round, 1)
        self.assertEqual(session.combat_log, [])
        self.assertEqual(session.snapshot()["room"], {"columns": 10, "rows": 7})

    def test_pending_new_round_is_set_on_wrap_and_cleared_by_start_new_round(self) -> None:
        session = self.context.create_session("pending-round")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id

        session.select(first_id)
        session.next_turn()
        self.assertFalse(session.pending_new_round)  # not yet wrapped
        self.assertEqual(session.active_turn_id, second_id)

        session.next_turn()
        self.assertTrue(session.pending_new_round)
        self.assertIsNone(session.active_turn_id)
        self.assertEqual(session.round, 1)  # not incremented yet

        # persists across reload
        reloaded = self.context.load_session("pending-round")
        self.assertTrue(reloaded.pending_new_round)
        self.assertIsNone(reloaded.active_turn_id)

        reloaded.start_new_round()
        self.assertFalse(reloaded.pending_new_round)
        self.assertEqual(reloaded.round, 2)
        self.assertEqual(reloaded.active_turn_id, first_id)
        self.assertIn("Round 2 begins", reloaded.combat_log)

    def test_start_new_round_uses_initiative_order_not_selected_id(self) -> None:
        session = self.context.create_session("round-order")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("bandit")
        second_id = session.selected_id

        session.select(first_id)
        session.next_turn()  # first → second
        session.next_turn()  # second → wraps, pending_new_round = True

        # Add a unit during GM adjustments — this changes selected_id
        session.add_enemy_from_template("goblin")
        late_id = session.selected_id
        self.assertNotEqual(late_id, first_id)

        session.start_new_round()

        # Must be first in order, not the late-added unit
        self.assertEqual(session.active_turn_id, first_id)

    def test_add_player_with_stats_persists_correctly(self) -> None:
        session = self.context.create_session("player-stats")
        session.add_player(name="Mira", toughness=18, armor=1, magic_armor=0, power=2, movement=5)

        player = next(e for e in session.state.enemies.values() if session.is_player(e))
        self.assertEqual(player.name, "Mira")
        self.assertEqual(player.toughness_max, 18)
        self.assertEqual(player.toughness_current, 18)
        self.assertEqual(player.armor_max, 1)
        self.assertEqual(player.movement, 5)
        self.assertEqual(player.power_base, 2)

        reloaded = self.context.load_session("player-stats")
        restored = next(e for e in reloaded.state.enemies.values() if reloaded.is_player(e))
        self.assertEqual(restored.name, "Mira")
        self.assertEqual(restored.toughness_max, 18)
        self.assertEqual(restored.movement, 5)

    def test_add_player_without_name_gets_auto_name(self) -> None:
        session = self.context.create_session("player-autoname")
        session.add_player()
        session.add_player()

        players = [e for e in session.state.enemies.values() if session.is_player(e)]
        names = {p.name for p in players}
        self.assertEqual(len(names), 2)
        self.assertTrue(all("Player" in n for n in names))

    def test_roll_initiative_sorts_order_by_total(self) -> None:
        session = self.context.create_session("init-sort")
        session.add_enemy_from_template("goblin")
        low_id = session.selected_id
        session.add_enemy_from_template("goblin")
        high_id = session.selected_id

        # Force deterministic rolls via seeded rng
        session._rng.seed(42)
        low_entity = session.state.enemies[low_id]
        high_entity = session.state.enemies[high_id]

        # Set modifiers so the outcome is predictable
        low_entity.initiative_modifier = 0
        high_entity.initiative_modifier = 10

        session.roll_initiative({})
        # high modifier should sort first
        self.assertEqual(session.order[0], high_id)
        self.assertEqual(session.initiative_rolled_round, 1)

    def test_roll_initiative_formulas(self) -> None:
        from battle_session import BattleSessionError

        session = self.context.create_session("init-formulas")
        session.add_enemy_from_template("goblin")
        eid = session.selected_id
        entity = session.state.enemies[eid]
        entity.initiative_modifier = 3

        # normal: roll + mod
        session._rng.seed(0)
        session.roll_initiative({eid: "normal"})
        self.assertEqual(entity.initiative_total, entity.initiative_roll + 3)

        # advantage: roll + 2*mod
        session._rng.seed(0)
        session.roll_initiative({eid: "advantage"})
        self.assertEqual(entity.initiative_total, entity.initiative_roll + 6)

        # disadvantage: roll only
        session._rng.seed(0)
        session.roll_initiative({eid: "disadvantage"})
        self.assertEqual(entity.initiative_total, entity.initiative_roll)

        # surprised: roll + mod AND status set
        session._rng.seed(0)
        session.roll_initiative({eid: "surprised"})
        self.assertEqual(entity.initiative_total, entity.initiative_roll + 3)
        self.assertIn("surprised", entity.statuses)
        self.assertEqual(entity.statuses["surprised"]["skipRound"], 1)

    def test_roll_initiative_blocked_during_active_encounter(self) -> None:
        from battle_session import BattleSessionError

        session = self.context.create_session("init-block")
        session.add_enemy_from_template("goblin")
        session.start_encounter()

        # encounter is active and not pending_new_round — should raise
        with self.assertRaises(BattleSessionError):
            session.roll_initiative({})

    def test_roll_initiative_allowed_before_encounter(self) -> None:
        session = self.context.create_session("init-pre")
        session.add_enemy_from_template("goblin")

        session.roll_initiative({})

        self.assertEqual(session.initiative_rolled_round, 1)

    def test_roll_initiative_allowed_during_pending_new_round(self) -> None:
        session = self.context.create_session("init-pending")
        session.add_enemy_from_template("goblin")
        first_id = session.selected_id
        session.add_enemy_from_template("goblin")

        session.select(first_id)
        session.next_turn()
        session.next_turn()
        self.assertTrue(session.pending_new_round)

        session.roll_initiative({})
        self.assertEqual(session.initiative_rolled_round, 2)

    def test_surprised_unit_skips_turn_and_status_removed(self) -> None:
        session = self.context.create_session("init-surprised")
        session.add_enemy_from_template("goblin")
        surprised_id = session.selected_id
        session.add_enemy_from_template("goblin")

        entity = session.state.enemies[surprised_id]
        session.roll_initiative({surprised_id: "surprised"})
        self.assertIn("surprised", entity.statuses)

        # Start encounter — if surprised_id is first, it should be skipped
        # We ensure surprised_id is first in order
        session.order = [surprised_id] + [iid for iid in session.order if iid != surprised_id]
        session.start_encounter()

        # surprised unit should have been skipped (status removed)
        self.assertNotIn("surprised", entity.statuses)
        self.assertNotEqual(session.active_turn_id, surprised_id)

    def test_turn_skip_notice_is_transient(self) -> None:
        session = self.context.create_session("init-transient")
        session.add_enemy_from_template("goblin")
        surprised_id = session.selected_id
        session.add_enemy_from_template("goblin")

        entity = session.state.enemies[surprised_id]
        session.roll_initiative({surprised_id: "surprised"})
        session.order = [surprised_id] + [iid for iid in session.order if iid != surprised_id]
        session.start_encounter()

        # notice populated in this session
        self.assertGreater(len(session.turn_skip_notice), 0)

        # after reload it's gone
        reloaded = self.context.load_session("init-transient")
        self.assertEqual(reloaded.turn_skip_notice, [])

    def test_encounter_started_flag_set_on_start_encounter(self) -> None:
        session = self.context.create_session("init-flag")
        session.add_enemy_from_template("goblin")

        self.assertFalse(session.encounter_started)
        session.start_encounter()
        self.assertTrue(session.encounter_started)

        reloaded = self.context.load_session("init-flag")
        self.assertTrue(reloaded.encounter_started)


if __name__ == "__main__":
    unittest.main()
