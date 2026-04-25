from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from battle_session import BattleSessionContext
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
        with self.assertRaisesRegex(ValueError, "outside"):
            session.set_entity_position(second_id, 99, 0)

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
        hp_before = second_enemy.hp_current

        session.select(first_id)
        session.next_turn()

        self.assertEqual(session.active_turn_id, second_id)
        self.assertEqual(second_enemy.hp_current, max(0, hp_before - 2))
        self.assertIn("slowed", second_enemy.statuses)

        session.next_turn()

        self.assertEqual(session.active_turn_id, first_id)
        self.assertNotIn("slowed", second_enemy.statuses)

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


if __name__ == "__main__":
    unittest.main()
