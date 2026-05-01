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
        templates_by_id = {item["id"]: item for item in payload["enemyTemplates"]}
        self.assertTrue({"goblin", "bandit", "guard", "soldier"}.issubset(templates_by_id))
        goblin_template = next(item for item in payload["enemyTemplates"] if item["id"] == "goblin")
        self.assertEqual(goblin_template["name"], "Goblin")
        self.assertEqual(goblin_template["imageUrl"], "/images/Greenskins/goblin.png")
        self.assertEqual(templates_by_id["goblin"]["category"], "Greenskins")
        self.assertEqual(templates_by_id["bandit"]["category"], "Outlaws")
        self.assertEqual(templates_by_id["guard"]["category"], "Realms_and_order")
        self.assertEqual(templates_by_id["soldier"]["category"], "Realms_and_order")

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

    def test_restricted_move_endpoint_tracks_pool_and_position_repositions_freely(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        added = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()
        entity_id = added["selectedId"]
        self.client.post(f"/api/battle/sessions/{sid}/entities/{entity_id}/position", json={"x": 0, "y": 0})
        self.client.post(f"/api/battle/sessions/{sid}/turn/next")
        self.client.post(f"/api/battle/sessions/{sid}/round/start")  # single unit wraps

        moved = self.client.post(f"/api/battle/sessions/{sid}/entities/{entity_id}/move", json={"x": 2, "y": 0})
        self.assertEqual(moved.status_code, 200)
        self.assertEqual(moved.json()["movementState"]["movementUsed"], 2)
        self.assertFalse(moved.json()["movementState"]["dashUsed"])

        repositioned = self.client.post(f"/api/battle/sessions/{sid}/entities/{entity_id}/position", json={"x": 5, "y": 0})
        self.assertEqual(repositioned.status_code, 200)
        self.assertEqual(repositioned.json()["movementState"]["movementUsed"], 2)
        self.client.post(
            f"/api/battle/sessions/{sid}/dungeon/tiles",
            json={"tileType": "floor", "cells": [[10, 0]]},
        )

        dash_required = self.client.post(f"/api/battle/sessions/{sid}/entities/{entity_id}/move", json={"x": 10, "y": 0})
        self.assertEqual(dash_required.status_code, 400)
        self.assertIn("Dash", dash_required.json()["detail"])

        dashed = self.client.post(
            f"/api/battle/sessions/{sid}/entities/{entity_id}/move",
            json={"x": 10, "y": 0, "dash": True},
        )
        self.assertEqual(dashed.status_code, 200)
        self.assertEqual(dashed.json()["movementState"]["movementUsed"], 7)
        self.assertTrue(dashed.json()["movementState"]["dashUsed"])

    def test_position_endpoint_accepts_negative_sparse_floor(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        added = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()
        entity_id = added["selectedId"]
        tile_response = self.client.post(
            f"/api/battle/sessions/{sid}/dungeon/tiles",
            json={"tileType": "floor", "cells": [[-1, 0]]},
        )
        self.assertEqual(tile_response.status_code, 200)

        positioned = self.client.post(
            f"/api/battle/sessions/{sid}/entities/{entity_id}/position",
            json={"x": -1, "y": 0},
        )
        self.assertEqual(positioned.status_code, 200)
        moved = next(enemy for enemy in positioned.json()["enemies"] if enemy["instance_id"] == entity_id)
        self.assertEqual((moved["grid_x"], moved["grid_y"]), (-1, 0))

        missing_tile = self.client.post(
            f"/api/battle/sessions/{sid}/entities/{entity_id}/position",
            json={"x": -2, "y": 0},
        )
        self.assertEqual(missing_tile.status_code, 400)
        self.assertIn("not walkable", missing_tile.json()["detail"])

    def test_batch_position_endpoint_moves_group_atomically_and_undoes_once(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        first_id = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()["selectedId"]
        second_id = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()["selectedId"]
        blocker_id = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "guard"}).json()["selectedId"]
        self.client.post(f"/api/battle/sessions/{sid}/entities/{first_id}/position", json={"x": 0, "y": 0})
        self.client.post(f"/api/battle/sessions/{sid}/entities/{second_id}/position", json={"x": 1, "y": 0})
        self.client.post(f"/api/battle/sessions/{sid}/entities/{blocker_id}/position", json={"x": 3, "y": 0})
        before = self.client.get(f"/api/battle/sessions/{sid}").json()

        blocked = self.client.post(
            f"/api/battle/sessions/{sid}/entities/positions",
            json={
                "placements": [
                    {"instanceId": first_id, "x": 1, "y": 0},
                    {"instanceId": second_id, "x": 3, "y": 0},
                ],
            },
        )
        self.assertEqual(blocked.status_code, 400)
        unchanged = self.client.get(f"/api/battle/sessions/{sid}").json()
        positions = {enemy["instance_id"]: (enemy["grid_x"], enemy["grid_y"]) for enemy in unchanged["enemies"]}
        self.assertEqual(positions[first_id], (0, 0))
        self.assertEqual(positions[second_id], (1, 0))
        self.assertEqual(unchanged["undoDepth"], before["undoDepth"])

        moved = self.client.post(
            f"/api/battle/sessions/{sid}/entities/positions",
            json={
                "placements": [
                    {"instanceId": first_id, "x": 1, "y": 0},
                    {"instanceId": second_id, "x": 0, "y": 0},
                ],
            },
        )
        self.assertEqual(moved.status_code, 200)
        moved_payload = moved.json()
        self.assertEqual(moved_payload["undoDepth"], before["undoDepth"] + 1)
        moved_positions = {enemy["instance_id"]: (enemy["grid_x"], enemy["grid_y"]) for enemy in moved_payload["enemies"]}
        self.assertEqual(moved_positions[first_id], (1, 0))
        self.assertEqual(moved_positions[second_id], (0, 0))

        undone = self.client.post(f"/api/battle/sessions/{sid}/undo").json()
        undone_positions = {enemy["instance_id"]: (enemy["grid_x"], enemy["grid_y"]) for enemy in undone["enemies"]}
        self.assertEqual(undone_positions[first_id], (0, 0))
        self.assertEqual(undone_positions[second_id], (1, 0))

    def test_copy_endpoint_creates_fresh_enemy_and_is_undoable(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        added = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()
        source_id = added["selectedId"]
        before = self.client.get(f"/api/battle/sessions/{sid}").json()
        source = next(enemy for enemy in before["enemies"] if enemy["instance_id"] == source_id)

        copied = self.client.post(f"/api/battle/sessions/{sid}/entities/{source_id}/copy")

        self.assertEqual(copied.status_code, 200)
        payload = copied.json()
        self.assertEqual(payload["undoDepth"], before["undoDepth"] + 1)
        self.assertEqual(len(payload["enemies"]), len(before["enemies"]) + 1)
        copy = next(enemy for enemy in payload["enemies"] if enemy["instance_id"] == payload["selectedId"])
        self.assertNotEqual(copy["instance_id"], source_id)
        self.assertEqual(copy["template_id"], source["template_id"])
        self.assertEqual((copy["grid_x"], copy["grid_y"]), (source["grid_x"] + 1, source["grid_y"]))
        self.assertEqual(payload["order"], [source_id, copy["instance_id"]])

        undone = self.client.post(f"/api/battle/sessions/{sid}/undo").json()
        self.assertEqual([enemy["instance_id"] for enemy in undone["enemies"]], [source_id])

    def test_start_encounter_endpoint_activates_highest_initiative_unit(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        first_enemy = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()
        first_id = first_enemy["selectedId"]
        self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"})

        response = self.client.post(f"/api/battle/sessions/{sid}/encounter/start")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        active_enemy = next(enemy for enemy in payload["enemies"] if enemy["instance_id"] == first_id)
        self.assertEqual(payload["activeTurnId"], first_id)
        self.assertEqual(payload["selectedId"], first_id)
        self.assertFalse(payload["turnInProgress"])
        self.assertEqual(payload["movementState"]["entityId"], first_id)
        self.assertEqual(active_enemy["current_draw_text"], [])

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

    def test_manual_save_delete_endpoint(self) -> None:
        snapshot = self.client.post("/api/battle/sessions").json()
        sid = snapshot["sid"]

        save_response = self.client.post(f"/api/battle/sessions/{sid}/saves", json={"name": "old-load"})
        self.assertEqual(save_response.status_code, 200)
        saves = self.client.get(f"/api/battle/sessions/{sid}/saves").json()["saves"]
        self.assertEqual(len(saves), 1)

        delete_response = self.client.delete(f"/api/battle/sessions/{sid}/saves/{saves[0]['filename']}")

        self.assertEqual(delete_response.status_code, 200)
        self.assertEqual(delete_response.json()["saves"], [])
        self.assertEqual(self.client.get(f"/api/battle/sessions/{sid}/saves").json()["saves"], [])

    def test_new_taxonomy_templates_can_be_added(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]

        for template_id in ("guard", "soldier"):
            response = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": template_id})
            self.assertEqual(response.status_code, 200)
            selected = next(enemy for enemy in response.json()["enemies"] if enemy["instance_id"] == response.json()["selectedId"])
            self.assertEqual(selected["template_id"], template_id)

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

        self.client.post(f"/api/battle/sessions/{sid}/turn/next")  # single unit wraps
        start_response = self.client.post(f"/api/battle/sessions/{sid}/round/start")
        self.assertEqual(start_response.status_code, 200)
        next_payload = start_response.json()
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
        self.assertLessEqual(attacked["toughness_current"], before["toughness_current"])
        self.assertIn("burn", attacked["statuses"])

        heal_response = self.client.post(
            f"/api/battle/sessions/{sid}/heal",
            json={"toughness": 1, "armor": 0, "magicArmor": 0, "guard": 0},
        )
        self.assertEqual(heal_response.status_code, 200)
        healed = next(enemy for enemy in heal_response.json()["enemies"] if enemy["instance_id"] == enemy_snapshot["selectedId"])
        self.assertGreaterEqual(healed["toughness_current"], attacked["toughness_current"])

    def test_attack_endpoint_reports_player_wounds(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        player_snapshot = self.client.post(
            f"/api/battle/sessions/{sid}/players",
            json={"name": "Mira", "toughness": 5, "armor": 0, "magicArmor": 0, "power": 0, "movement": 6},
        ).json()

        attack_response = self.client.post(
            f"/api/battle/sessions/{sid}/attack",
            json={"damage": 11, "burn": False, "poison": False, "slow": False, "paralyze": False, "modifiers": []},
        )

        self.assertEqual(attack_response.status_code, 200)
        payload = attack_response.json()
        player = next(enemy for enemy in payload["enemies"] if enemy["instance_id"] == player_snapshot["selectedId"])
        self.assertEqual(player["toughness_current"], 4)
        self.assertFalse(player["is_down"])
        self.assertEqual(payload["woundEvents"][0]["name"], "Mira")
        self.assertEqual(payload["woundEvents"][0]["wounds"], 2)
        self.assertEqual(payload["woundEvents"][0]["toughnessAfter"], 4)

    def test_heal_endpoint_allows_player_overheal_to_twice_toughness_max(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        self.client.post(
            f"/api/battle/sessions/{sid}/players",
            json={"name": "Mira", "toughness": 3, "armor": 0, "magicArmor": 0, "power": 0, "movement": 6},
        )
        self.client.post(
            f"/api/battle/sessions/{sid}/attack",
            json={"damage": 1, "burn": False, "poison": False, "slow": False, "paralyze": False, "modifiers": []},
        )

        payload = self.client.post(
            f"/api/battle/sessions/{sid}/heal",
            json={"toughness": 3, "armor": 0, "magicArmor": 0, "guard": 0},
        ).json()

        player = next(enemy for enemy in payload["enemies"] if enemy["template_id"] == "player")
        self.assertEqual(player["toughness_current"], 5)
        self.assertEqual(player["toughness_max"], 3)

        payload = self.client.post(
            f"/api/battle/sessions/{sid}/heal",
            json={"toughness": 3, "armor": 0, "magicArmor": 0, "guard": 0},
        ).json()

        player = next(enemy for enemy in payload["enemies"] if enemy["template_id"] == "player")
        self.assertEqual(player["toughness_current"], 6)

    def test_quick_attack_endpoint_uses_active_draw_and_supports_undo(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        attacker_snapshot = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()
        attacker_id = attacker_snapshot["selectedId"]
        target_snapshot = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"}).json()
        target_id = target_snapshot["selectedId"]
        session = self.context.load_session(sid)
        attacker = session.state.enemies[attacker_id]
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 0
        target.armor_current = 0
        target.armor_max = 0
        attacker.deck_state.hand = ["bandit_s3"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)
        session.autosave()

        quick_response = self.client.post(f"/api/battle/sessions/{sid}/turn/quick-attack")

        self.assertEqual(quick_response.status_code, 200)
        payload = quick_response.json()
        attacked = next(enemy for enemy in payload["enemies"] if enemy["instance_id"] == target_id)
        attacker_payload = next(enemy for enemy in payload["enemies"] if enemy["instance_id"] == attacker_id)
        self.assertEqual(attacked["toughness_current"], 5)
        self.assertTrue(attacker_payload["quick_attack_used"])
        self.assertTrue(payload["canUndo"])
        self.assertEqual(payload["quickAttack"]["attackerId"], attacker_id)
        self.assertIn("Quick Attack", payload["quickAttackNotice"])

        repeat_response = self.client.post(f"/api/battle/sessions/{sid}/turn/quick-attack")
        self.assertEqual(repeat_response.status_code, 400)
        self.assertIn("already been used", repeat_response.json()["detail"])

        undo_response = self.client.post(f"/api/battle/sessions/{sid}/undo")
        restored = next(enemy for enemy in undo_response.json()["enemies"] if enemy["instance_id"] == target_id)
        restored_attacker = next(enemy for enemy in undo_response.json()["enemies"] if enemy["instance_id"] == attacker_id)
        self.assertEqual(restored["toughness_current"], 10)
        self.assertFalse(restored_attacker["quick_attack_used"])

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
        self.assertEqual(restored["toughness_current"], before["toughness_current"])
        self.assertNotIn("burn", restored["statuses"])
        self.assertEqual(undo_response.json()["combatLog"], enemy_snapshot["combatLog"])

        redo_response = self.client.post(f"/api/battle/sessions/{sid}/redo")
        self.assertEqual(redo_response.status_code, 200)
        redone = next(enemy for enemy in redo_response.json()["enemies"] if enemy["instance_id"] == entity_id)
        attacked = next(enemy for enemy in attack_response.json()["enemies"] if enemy["instance_id"] == entity_id)
        self.assertEqual(redone["toughness_current"], attacked["toughness_current"])
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
        self.assertEqual(redone["toughness_current"], attacked["toughness_current"])
        self.assertEqual(redo_response["redoDepth"], 0)

        self.client.post(f"/api/battle/sessions/{sid}/undo")
        diverged_response = self.client.post(f"/api/battle/sessions/{sid}/players", json={}).json()
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
            json={"toughness": 1, "armor": 0, "magicArmor": 0, "guard": 0},
        ).json()

        self.assertEqual(healed_response["undoDepth"], 3)
        reloaded = self.client.get(f"/api/battle/sessions/{sid}").json()
        self.assertEqual(reloaded["undoDepth"], 3)

        undo_heal = self.client.post(f"/api/battle/sessions/{sid}/undo").json()
        self.assertEqual(undo_heal["undoDepth"], 2)
        after_undo_heal = next(enemy for enemy in undo_heal["enemies"] if enemy["instance_id"] == entity_id)
        attacked_enemy = next(enemy for enemy in attacked_response["enemies"] if enemy["instance_id"] == entity_id)
        self.assertEqual(after_undo_heal["toughness_current"], attacked_enemy["toughness_current"])

        undo_attack = self.client.post(f"/api/battle/sessions/{sid}/undo").json()
        self.assertEqual(undo_attack["undoDepth"], 1)
        after_undo_attack = next(enemy for enemy in undo_attack["enemies"] if enemy["instance_id"] == entity_id)
        added_enemy = next(enemy for enemy in add_response["enemies"] if enemy["instance_id"] == entity_id)
        self.assertEqual(after_undo_attack["toughness_current"], added_enemy["toughness_current"])
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
            latest = self.client.post(f"/api/battle/sessions/{sid}/players", json={}).json()

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

        player_response = self.client.post(
            f"/api/battle/sessions/{sid}/players",
            json={"name": "Aldric", "toughness": 20, "armor": 2, "magicArmor": 0, "power": 1, "movement": 5},
        )
        self.assertEqual(player_response.status_code, 200)
        player = next(e for e in player_response.json()["enemies"] if e["template_id"] == "player")
        self.assertEqual(player["name"], "Aldric")
        self.assertEqual(player["toughness_max"], 20)
        self.assertEqual(player["armor_max"], 2)
        self.assertEqual(player["movement"], 5)

        custom_response = self.client.post(
            f"/api/battle/sessions/{sid}/enemies",
            json={
                "custom": {
                    "name": "Shade",
                    "toughness": 7,
                    "armor": 1,
                    "magicArmor": 0,
                    "power": 2,
                    "movement": 4,
                    "coreDeckId": "basic",
                }
            },
        )
        self.assertEqual(custom_response.status_code, 200)
        self.assertTrue(any(enemy["name"] == "Shade" for enemy in custom_response.json()["enemies"]))

    def test_position_endpoint_validates_map_state(self) -> None:
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

        # Down units don't block — second can stack on the cell where first is downed
        self.client.post(f"/api/battle/sessions/{sid}/select", json={"instanceId": first_id})
        down_response = self.client.post(
            f"/api/battle/sessions/{sid}/attack",
            json={"damage": 999},
        )
        self.assertEqual(down_response.status_code, 200)
        down_first = next(enemy for enemy in down_response.json()["enemies"] if enemy["instance_id"] == first_id)
        self.assertTrue(down_first["is_down"])

        passable_response = self.client.post(
            f"/api/battle/sessions/{sid}/entities/{second_id}/position",
            json={"x": 0, "y": 0},
        )
        self.assertEqual(passable_response.status_code, 200)
        stacked_second = next(enemy for enemy in passable_response.json()["enemies"] if enemy["instance_id"] == second_id)
        self.assertEqual((stacked_second["grid_x"], stacked_second["grid_y"]), (0, 0))

    def test_pending_new_round_flag_and_round_start_endpoint(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"})
        first_id = self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"}).json()["selectedId"]
        self.client.post(f"/api/battle/sessions/{sid}/select", json={"instanceId": self.client.get(f"/api/battle/sessions/{sid}").json()["order"][0]})

        first_next = self.client.post(f"/api/battle/sessions/{sid}/turn/next").json()
        self.assertFalse(first_next["pendingNewRound"])
        self.assertIsNotNone(first_next["activeTurnId"])

        second_next = self.client.post(f"/api/battle/sessions/{sid}/turn/next").json()
        self.assertTrue(second_next["pendingNewRound"])
        self.assertIsNone(second_next["activeTurnId"])
        self.assertEqual(second_next["round"], 1)

        # pendingNewRound persists across reload
        reloaded = self.client.get(f"/api/battle/sessions/{sid}").json()
        self.assertTrue(reloaded["pendingNewRound"])

        start = self.client.post(f"/api/battle/sessions/{sid}/round/start").json()
        self.assertFalse(start["pendingNewRound"])
        self.assertEqual(start["round"], 2)
        self.assertIsNotNone(start["activeTurnId"])

    def test_add_player_with_stats_endpoint(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]

        response = self.client.post(
            f"/api/battle/sessions/{sid}/players",
            json={"name": "Aldric", "toughness": 15, "armor": 2, "magicArmor": 1, "power": 0, "movement": 6},
        )
        self.assertEqual(response.status_code, 200)
        player = next(e for e in response.json()["enemies"] if e["template_id"] == "player")
        self.assertEqual(player["name"], "Aldric")
        self.assertEqual(player["toughness_max"], 15)
        self.assertEqual(player["armor_max"], 2)
        self.assertEqual(player["magic_armor_max"], 1)
        self.assertEqual(player["movement"], 6)

        # default name when omitted
        default_response = self.client.post(f"/api/battle/sessions/{sid}/players", json={})
        self.assertEqual(default_response.status_code, 200)
        default_player = next(e for e in default_response.json()["enemies"] if "Player" in e["name"])
        self.assertIn("Player", default_player["name"])
        self.assertEqual(default_player["toughness_max"], 4)
        self.assertEqual(default_player["armor_max"], 1)
        self.assertEqual(default_player["guard_base"], 1)
        self.assertEqual(default_player["power_base"], 4)
        self.assertEqual(default_player["initiative_modifier"], 2)

    def test_player_draw_endpoint_allows_multiple_draws_in_active_turn(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        added = self.client.post(f"/api/battle/sessions/{sid}/players", json={"name": "Mira"}).json()
        player_id = added["selectedId"]

        first = self.client.post(f"/api/battle/sessions/{sid}/turn/draw")
        self.assertEqual(first.status_code, 200)
        first_payload = first.json()
        self.assertEqual(first_payload["activeTurnId"], player_id)
        self.assertTrue(first_payload["turnInProgress"])

        second = self.client.post(f"/api/battle/sessions/{sid}/turn/draw")
        self.assertEqual(second.status_code, 200)
        player = next(e for e in second.json()["enemies"] if e["instance_id"] == player_id)
        self.assertEqual(len(player["current_draw_groups"]), 2)

    def test_roll_initiative_endpoint(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"})
        self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "bandit"})

        response = self.client.post(f"/api/battle/sessions/{sid}/initiative/roll", json={"modes": {}})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["initiativeRolledRound"], 1)

        # All enemies should have initiative_total set
        for enemy in payload["enemies"]:
            self.assertIsNotNone(enemy["initiative_total"])
            self.assertIsNotNone(enemy["initiative_roll"])

    def test_roll_initiative_blocked_when_encounter_active(self) -> None:
        sid = self.client.post("/api/battle/sessions").json()["sid"]
        self.client.post(f"/api/battle/sessions/{sid}/enemies", json={"templateId": "goblin"})
        self.client.post(f"/api/battle/sessions/{sid}/encounter/start")

        response = self.client.post(f"/api/battle/sessions/{sid}/initiative/roll", json={"modes": {}})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Cannot roll initiative", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
