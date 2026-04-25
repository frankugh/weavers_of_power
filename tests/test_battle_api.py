from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from battle_api import register_battle_api
from battle_session import BattleSessionContext

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class BattleApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        saves_dir = Path(self.temp_dir.name) / "saves"
        self.context = BattleSessionContext(root=PROJECT_ROOT, saves_dir=saves_dir)
        app = FastAPI()
        register_battle_api(app, self.context)
        self.client = TestClient(app)

    def test_meta_endpoint_returns_templates_and_decks(self) -> None:
        response = self.client.get("/api/battle/meta")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("enemyTemplates", payload)
        self.assertIn("decks", payload)
        goblin_template = next(item for item in payload["enemyTemplates"] if item["id"] == "goblin")
        self.assertEqual(goblin_template["name"], "Goblin")
        self.assertEqual(goblin_template["imageUrl"], "/images/goblin.png")

    def test_create_and_load_session(self) -> None:
        create_response = self.client.post("/api/battle/sessions")
        self.assertEqual(create_response.status_code, 200)
        snapshot = create_response.json()
        sid = snapshot["sid"]

        get_response = self.client.get(f"/api/battle/sessions/{sid}")
        self.assertEqual(get_response.status_code, 200)
        self.assertEqual(get_response.json()["sid"], sid)
        self.assertEqual(get_response.json()["round"], 1)
        self.assertEqual(get_response.json()["room"], {"columns": 10, "rows": 7})

    def test_room_endpoint_accepts_large_maps_with_guardrail(self) -> None:
        snapshot = self.client.post("/api/battle/sessions").json()
        sid = snapshot["sid"]

        large_response = self.client.post(
            f"/api/battle/sessions/{sid}/room",
            json={"columns": 99, "rows": 99},
        )
        self.assertEqual(large_response.status_code, 200)
        self.assertEqual(large_response.json()["room"], {"columns": 99, "rows": 99})

        too_large_response = self.client.post(
            f"/api/battle/sessions/{sid}/room",
            json={"columns": 100, "rows": 99},
        )
        self.assertEqual(too_large_response.status_code, 422)

    def test_enemy_flow_and_manual_save_endpoints(self) -> None:
        snapshot = self.client.post("/api/battle/sessions").json()
        sid = snapshot["sid"]

        add_enemy = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"})
        self.assertEqual(add_enemy.status_code, 200)
        entity_id = add_enemy.json()["selectedId"]

        draw_response = self.client.post(f"/api/battle/sessions/{sid}/turn/draw")
        self.assertEqual(draw_response.status_code, 200)
        self.assertIsNotNone(draw_response.json()["activeTurnId"])

        save_response = self.client.post(f"/api/battle/sessions/{sid}/saves", json={"name": "api-save"})
        self.assertEqual(save_response.status_code, 200)
        self.assertIn("Manual save created", save_response.json()["combatLog"][0])

        saves_response = self.client.get(f"/api/battle/sessions/{sid}/saves")
        self.assertEqual(saves_response.status_code, 200)
        saves = saves_response.json()["saves"]
        self.assertEqual(len(saves), 1)

        delete_response = self.client.delete(f"/api/battle/sessions/{sid}/entities/{entity_id}")
        self.assertEqual(delete_response.status_code, 200)
        self.assertEqual(delete_response.json()["order"], [])

        load_response = self.client.post(
            f"/api/battle/sessions/{sid}/load",
            json={"filename": saves[0]["filename"]},
        )
        self.assertEqual(load_response.status_code, 200)
        self.assertEqual(len(load_response.json()["order"]), 1)

    def test_next_clears_current_draw_until_a_new_draw_happens(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        add_enemy = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()
        entity_id = add_enemy["selectedId"]

        draw_response = self.client.post(f"/api/battle/sessions/{sid}/turn/draw")
        self.assertEqual(draw_response.status_code, 200)
        drawn_enemy = next(enemy for enemy in draw_response.json()["enemies"] if enemy["instance_id"] == entity_id)
        self.assertGreaterEqual(len(drawn_enemy["current_draw_text"]), 1)

        end_response = self.client.post(f"/api/battle/sessions/{sid}/turn/end")
        self.assertEqual(end_response.status_code, 200)
        ended_enemy = next(enemy for enemy in end_response.json()["enemies"] if enemy["instance_id"] == entity_id)
        self.assertGreaterEqual(len(ended_enemy["current_draw_text"]), 1)

        next_response = self.client.post(f"/api/battle/sessions/{sid}/turn/next")
        self.assertEqual(next_response.status_code, 200)
        next_payload = next_response.json()
        next_enemy = next(enemy for enemy in next_payload["enemies"] if enemy["instance_id"] == entity_id)

        self.assertEqual(next_payload["activeTurnId"], entity_id)
        self.assertFalse(next_payload["turnInProgress"])
        self.assertEqual(next_enemy["current_draw_text"], [])

    def test_next_to_other_unit_keeps_previous_units_draw_visible(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        first_enemy = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()
        first_id = first_enemy["selectedId"]
        second_enemy = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()
        second_id = second_enemy["selectedId"]

        self.client.post(f"/api/battle/sessions/{sid}/select", json={"instanceId": first_id})
        draw_response = self.client.post(f"/api/battle/sessions/{sid}/turn/draw")
        self.assertEqual(draw_response.status_code, 200)
        self.client.post(f"/api/battle/sessions/{sid}/turn/end")

        next_response = self.client.post(f"/api/battle/sessions/{sid}/turn/next")
        self.assertEqual(next_response.status_code, 200)
        next_payload = next_response.json()
        self.assertEqual(next_payload["activeTurnId"], second_id)

        self.client.post(f"/api/battle/sessions/{sid}/select", json={"instanceId": first_id})
        selected_first = self.client.get(f"/api/battle/sessions/{sid}").json()
        first_enemy_payload = next(enemy for enemy in selected_first["enemies"] if enemy["instance_id"] == first_id)
        self.assertGreaterEqual(len(first_enemy_payload["current_draw_text"]), 1)

    def test_attack_and_heal_endpoints_return_updated_snapshot(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        enemy_snapshot = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()

        before = next(enemy for enemy in enemy_snapshot["enemies"] if enemy["instance_id"] == enemy_snapshot["selectedId"])

        attack_response = self.client.post(
            f"/api/battle/sessions/{sid}/attack",
            json={"damage": 2, "burn": True, "poison": False, "slow": False, "paralyze": False, "modifiers": []},
        )
        self.assertEqual(attack_response.status_code, 200)
        attacked = next(
            enemy for enemy in attack_response.json()["enemies"] if enemy["instance_id"] == attack_response.json()["selectedId"]
        )
        self.assertLessEqual(attacked["hp_current"], before["hp_current"])
        self.assertIn("burn", attacked["statuses"])

        heal_response = self.client.post(
            f"/api/battle/sessions/{sid}/heal",
            json={"hp": 1, "armor": 0, "magicArmor": 0, "guard": 0},
        )
        self.assertEqual(heal_response.status_code, 200)
        healed = next(enemy for enemy in heal_response.json()["enemies"] if enemy["instance_id"] == enemy_snapshot["selectedId"])
        self.assertGreaterEqual(healed["hp_current"], attacked["hp_current"])

    def test_undo_restores_previous_mutation_state(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        enemy_snapshot = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()
        entity_id = enemy_snapshot["selectedId"]
        before = next(enemy for enemy in enemy_snapshot["enemies"] if enemy["instance_id"] == entity_id)

        attack_response = self.client.post(
            f"/api/battle/sessions/{sid}/attack",
            json={"damage": 2, "burn": True, "poison": False, "slow": False, "paralyze": False, "modifiers": []},
        )
        self.assertEqual(attack_response.status_code, 200)
        self.assertTrue(attack_response.json()["canUndo"])

        undo_response = self.client.post(f"/api/battle/sessions/{sid}/undo")
        self.assertEqual(undo_response.status_code, 200)
        self.assertTrue(undo_response.json()["canRedo"])
        restored = next(enemy for enemy in undo_response.json()["enemies"] if enemy["instance_id"] == entity_id)
        self.assertEqual(restored["hp_current"], before["hp_current"])
        self.assertNotIn("burn", restored["statuses"])
        self.assertEqual(undo_response.json()["combatLog"], enemy_snapshot["combatLog"])

        redo_response = self.client.post(f"/api/battle/sessions/{sid}/redo")
        self.assertEqual(redo_response.status_code, 200)
        redone = next(enemy for enemy in redo_response.json()["enemies"] if enemy["instance_id"] == entity_id)
        attacked = next(enemy for enemy in attack_response.json()["enemies"] if enemy["instance_id"] == entity_id)
        self.assertEqual(redone["hp_current"], attacked["hp_current"])
        self.assertIn("burn", redone["statuses"])
        self.assertEqual(redo_response.json()["combatLog"], attack_response.json()["combatLog"])
        self.assertFalse(redo_response.json()["canRedo"])

    def test_redo_persists_and_new_mutation_clears_redo_history(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        add_response = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()
        entity_id = add_response["selectedId"]
        attacked_response = self.client.post(
            f"/api/battle/sessions/{sid}/attack",
            json={"damage": 4, "burn": False, "poison": False, "slow": False, "paralyze": False, "modifiers": []},
        ).json()

        undo_response = self.client.post(f"/api/battle/sessions/{sid}/undo").json()
        self.assertEqual(undo_response["redoDepth"], 1)
        reloaded = self.client.get(f"/api/battle/sessions/{sid}").json()
        self.assertEqual(reloaded["redoDepth"], 1)

        redo_response = self.client.post(f"/api/battle/sessions/{sid}/redo").json()
        redone = next(enemy for enemy in redo_response["enemies"] if enemy["instance_id"] == entity_id)
        attacked = next(enemy for enemy in attacked_response["enemies"] if enemy["instance_id"] == entity_id)
        self.assertEqual(redone["hp_current"], attacked["hp_current"])
        self.assertEqual(redo_response["redoDepth"], 0)

        self.client.post(f"/api/battle/sessions/{sid}/undo")
        diverged_response = self.client.post(f"/api/battle/sessions/{sid}/players").json()
        self.assertFalse(diverged_response["canRedo"])
        self.assertEqual(diverged_response["redoDepth"], 0)

    def test_undo_is_lifo_and_persists_across_session_reload(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        add_response = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()
        entity_id = add_response["selectedId"]
        attacked_response = self.client.post(
            f"/api/battle/sessions/{sid}/attack",
            json={"damage": 3, "burn": True, "poison": False, "slow": False, "paralyze": False, "modifiers": []},
        ).json()
        healed_response = self.client.post(
            f"/api/battle/sessions/{sid}/heal",
            json={"hp": 1, "armor": 0, "magicArmor": 0, "guard": 0},
        ).json()

        self.assertEqual(healed_response["undoDepth"], 3)
        reloaded = self.client.get(f"/api/battle/sessions/{sid}").json()
        self.assertEqual(reloaded["undoDepth"], 3)

        undo_heal = self.client.post(f"/api/battle/sessions/{sid}/undo").json()
        self.assertEqual(undo_heal["undoDepth"], 2)
        after_undo_heal = next(enemy for enemy in undo_heal["enemies"] if enemy["instance_id"] == entity_id)
        attacked_enemy = next(enemy for enemy in attacked_response["enemies"] if enemy["instance_id"] == entity_id)
        self.assertEqual(after_undo_heal["hp_current"], attacked_enemy["hp_current"])

        undo_attack = self.client.post(f"/api/battle/sessions/{sid}/undo").json()
        self.assertEqual(undo_attack["undoDepth"], 1)
        after_undo_attack = next(enemy for enemy in undo_attack["enemies"] if enemy["instance_id"] == entity_id)
        added_enemy = next(enemy for enemy in add_response["enemies"] if enemy["instance_id"] == entity_id)
        self.assertEqual(after_undo_attack["hp_current"], added_enemy["hp_current"])
        self.assertNotIn("burn", after_undo_attack["statuses"])

    def test_select_is_not_undoable_and_empty_undo_reports_error(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        empty_response = self.client.post(f"/api/battle/sessions/{sid}/undo")
        self.assertEqual(empty_response.status_code, 400)
        self.assertIn("Nothing to undo", empty_response.json()["detail"])
        empty_redo_response = self.client.post(f"/api/battle/sessions/{sid}/redo")
        self.assertEqual(empty_redo_response.status_code, 400)
        self.assertIn("Nothing to redo", empty_redo_response.json()["detail"])

        first = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()
        first_id = first["selectedId"]
        second = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()
        second_id = second["selectedId"]
        depth_before_select = second["undoDepth"]

        select_response = self.client.post(f"/api/battle/sessions/{sid}/select", json={"instanceId": first_id})
        self.assertEqual(select_response.status_code, 200)
        self.assertEqual(select_response.json()["undoDepth"], depth_before_select)

        undo_response = self.client.post(f"/api/battle/sessions/{sid}/undo").json()
        self.assertEqual(undo_response["undoDepth"], depth_before_select - 1)
        self.assertFalse(any(enemy["instance_id"] == second_id for enemy in undo_response["enemies"]))

    def test_undo_stack_trims_to_twenty_entries(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]

        latest = None
        for _ in range(25):
            latest = self.client.post(f"/api/battle/sessions/{sid}/players").json()

        self.assertEqual(latest["undoDepth"], 20)

    def test_manual_load_resets_undo_history(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        first = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()
        self.assertTrue(first["canUndo"])

        save_response = self.client.post(f"/api/battle/sessions/{sid}/saves", json={"name": "undo-reset"})
        saves = self.client.get(f"/api/battle/sessions/{sid}/saves").json()["saves"]
        self.assertTrue(save_response.json()["canUndo"])

        self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"})
        load_response = self.client.post(
            f"/api/battle/sessions/{sid}/load",
            json={"filename": saves[0]["filename"]},
        )

        self.assertEqual(load_response.status_code, 200)
        self.assertFalse(load_response.json()["canUndo"])
        self.assertEqual(load_response.json()["undoDepth"], 0)
        self.assertFalse(load_response.json()["canRedo"])
        self.assertEqual(load_response.json()["redoDepth"], 0)

    def test_player_and_custom_enemy_endpoints_remain_usable(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]

        player_response = self.client.post(f"/api/battle/sessions/{sid}/players")
        self.assertEqual(player_response.status_code, 200)
        self.assertTrue(any(enemy["template_id"] == "player" for enemy in player_response.json()["enemies"]))

        custom_response = self.client.post(
            f"/api/battle/sessions/{sid}/enemies",
            json={
                "custom": {
                    "name": "Shade",
                    "hp": 7,
                    "armor": 1,
                    "magicArmor": 0,
                    "draws": 2,
                    "movement": 4,
                    "coreDeckId": "basic",
                }
            },
        )
        self.assertEqual(custom_response.status_code, 200)
        self.assertTrue(any(enemy["name"] == "Shade" for enemy in custom_response.json()["enemies"]))

    def test_room_and_position_endpoints_validate_map_state(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        first = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()
        first_id = first["selectedId"]
        second = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()
        second_id = second["selectedId"]

        move_response = self.client.post(
            f"/api/battle/sessions/{sid}/entities/{first_id}/position",
            json={"x": 0, "y": 0},
        )
        self.assertEqual(move_response.status_code, 200)
        moved = next(enemy for enemy in move_response.json()["enemies"] if enemy["instance_id"] == first_id)
        self.assertEqual((moved["grid_x"], moved["grid_y"]), (0, 0))
        self.assertEqual(move_response.json()["selectedId"], first_id)

        occupied_response = self.client.post(
            f"/api/battle/sessions/{sid}/entities/{second_id}/position",
            json={"x": 0, "y": 0},
        )
        self.assertEqual(occupied_response.status_code, 400)
        self.assertIn("occupied", occupied_response.json()["detail"])

        resize_warning = self.client.post(
            f"/api/battle/sessions/{sid}/room",
            json={"columns": 3, "rows": 3},
        )
        self.assertEqual(resize_warning.status_code, 400)
        self.assertIn("Resize would move", resize_warning.json()["detail"])

        resize_confirm = self.client.post(
            f"/api/battle/sessions/{sid}/room",
            json={"columns": 3, "rows": 3, "autoPlaceOutOfBounds": True},
        )
        self.assertEqual(resize_confirm.status_code, 200)
        self.assertEqual(resize_confirm.json()["room"], {"columns": 3, "rows": 3})


if __name__ == "__main__":
    unittest.main()
