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
        context = BattleSessionContext(root=PROJECT_ROOT, saves_dir=saves_dir)
        app = FastAPI()
        register_battle_api(app, context)
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


if __name__ == "__main__":
    unittest.main()
