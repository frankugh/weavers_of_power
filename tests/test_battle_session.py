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

    def test_draw_and_end_turn_persist_state(self) -> None:
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
        self.assertEqual(len(selected.deck_state.hand), 0)
        self.assertGreaterEqual(len(reloaded.visible_draw_for(selected)), 1)
        self.assertGreaterEqual(len(reloaded.snapshot()["enemies"][0]["current_draw_text"]), 1)

    def test_draw_replaces_hand_and_clears_when_unit_becomes_active(self) -> None:
        session = self.context.create_session("draw-replace")
        session.add_enemy_from_template("goblin")
        enemy = session.state.enemies[session.selected_id]

        session.draw_turn()
        first_visible_draw = session.visible_draw_for(enemy)

        self.assertEqual(enemy.deck_state.hand, first_visible_draw)
        self.assertGreaterEqual(len(first_visible_draw), 1)

        session.draw_turn()
        second_visible_draw = session.visible_draw_for(enemy)

        self.assertEqual(enemy.deck_state.hand, second_visible_draw)
        self.assertEqual(len(enemy.deck_state.discard_pile), len(first_visible_draw))
        self.assertEqual(len(second_visible_draw), enemy.draws_base)

        session.end_turn_selected()
        self.assertEqual(len(enemy.deck_state.hand), 0)
        self.assertEqual(session.visible_draw_for(enemy), second_visible_draw)

        session.next_turn()

        self.assertEqual(session.active_turn_id, enemy.instance_id)
        self.assertFalse(session.turn_in_progress)
        self.assertEqual(session.visible_draw_for(enemy), [])
        self.assertEqual(session.snapshot()["enemies"][0]["current_draw_text"], [])

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


if __name__ == "__main__":
    unittest.main()
