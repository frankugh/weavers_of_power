from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from battle_session import BattleSession, BattleSessionContext
from engine.combat import WOUND_CARD_ID, apply_attack
from engine.loader import load_decks, load_enemies
from engine.models import Card, Effect
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

    def test_added_units_are_auto_placed_on_the_battle_map(self) -> None:
        session = self.context.create_session("map-placement")

        session.add_enemy_from_template("C_GOBLIN")
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
  "id": "C_GOBLIN",
  "name": "C_GOBLIN",
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
        self.assertEqual(loaded["C_GOBLIN"].category, "Greenskins")

        (enemies_dir / "Outlaws" / "bad.json").write_text(
            enemy_json.replace('"id": "C_GOBLIN"', '"id": "bad_goblin"'),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ValueError, "does not match enemy category"):
            load_enemies(enemies_dir, decks=decks, images_dir=images_dir)

    def test_set_entity_position_requires_free_in_bounds_cell(self) -> None:
        session = self.context.create_session("map-position")
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
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
        with self.assertRaisesRegex(ValueError, "not walkable|outside"):
            session.set_entity_position(second_id, 99, 0)

    def test_set_entity_positions_moves_group_atomically(self) -> None:
        session = self.context.create_session("map-group-position")
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
        second_id = session.selected_id
        session.add_enemy_from_template("C_HOBGOBLIN")
        blocker_id = session.selected_id

        session.set_entity_position(first_id, 0, 0)
        session.set_entity_position(second_id, 1, 0)
        session.set_entity_position(blocker_id, 2, 0)

        with self.assertRaisesRegex(ValueError, "occupied"):
            session.set_entity_positions([
                {"instanceId": first_id, "x": 1, "y": 0},
                {"instanceId": second_id, "x": 2, "y": 0},
            ])
        self.assertEqual((session.state.enemies[first_id].grid_x, session.state.enemies[first_id].grid_y), (0, 0))
        self.assertEqual((session.state.enemies[second_id].grid_x, session.state.enemies[second_id].grid_y), (1, 0))

        session.set_entity_position(blocker_id, 3, 0)
        session.set_entity_positions([
            {"instanceId": first_id, "x": 1, "y": 0},
            {"instanceId": second_id, "x": 0, "y": 0},
        ])

        self.assertEqual((session.state.enemies[first_id].grid_x, session.state.enemies[first_id].grid_y), (1, 0))
        self.assertEqual((session.state.enemies[second_id].grid_x, session.state.enemies[second_id].grid_y), (0, 0))
        self.assertEqual(session.selected_id, first_id)
        self.assertIn("Repositioned 2 units", session.combat_log[0])

    def test_party_walk_places_four_players_in_open_formation(self) -> None:
        session = self.context.create_session("party-walk-open")
        ids = []
        for index, position in enumerate([(0, 1), (0, 2), (0, 3), (0, 4)]):
            session.add_player(name=f"Player {index + 1}")
            ids.append(session.selected_id)
            entity = session.state.enemies[session.selected_id]
            session._set_position(entity, position[0], position[1])

        result = session.party_walk(ids[0], 4, 1)

        self.assertEqual(result["partyWalk"]["leaderId"], ids[0])
        self.assertFalse(result["partyWalk"]["stoppedForEncounter"])
        self.assertEqual((session.state.enemies[ids[0]].grid_x, session.state.enemies[ids[0]].grid_y), (4, 1))
        self.assertEqual((session.state.enemies[ids[1]].grid_x, session.state.enemies[ids[1]].grid_y), (3, 1))
        self.assertEqual((session.state.enemies[ids[2]].grid_x, session.state.enemies[ids[2]].grid_y), (3, 2))
        self.assertEqual((session.state.enemies[ids[3]].grid_x, session.state.enemies[ids[3]].grid_y), (3, 0))
        self.assertIsNone(session.movement_state)
        self.assertIn("Party walk:", session.combat_log[0])

    def test_party_walk_uses_breadcrumbs_in_corridor(self) -> None:
        session = self.context.create_session("party-walk-corridor")
        session.edit_dungeon_tiles("void", [[x, y] for x in range(10) for y in range(7)])
        session.edit_dungeon_tiles("floor", [[x, 0] for x in range(6)])
        session.analyze_dungeon()
        session.dungeon.fog_of_war_enabled = False
        ids = []
        for index, x in enumerate([0, 1, 2]):
            session.add_player(name=f"Player {index + 1}")
            ids.append(session.selected_id)
            session._set_position(session.state.enemies[session.selected_id], x, 0)

        session.party_walk(ids[0], 5, 0)

        self.assertEqual((session.state.enemies[ids[0]].grid_x, session.state.enemies[ids[0]].grid_y), (5, 0))
        self.assertEqual((session.state.enemies[ids[1]].grid_x, session.state.enemies[ids[1]].grid_y), (4, 0))
        self.assertEqual((session.state.enemies[ids[2]].grid_x, session.state.enemies[ids[2]].grid_y), (3, 0))

    def test_party_walk_stops_after_revealing_enemy_room(self) -> None:
        session = self.context.create_session("party-walk-encounter")
        session.edit_dungeon_tiles("void", [[x, y] for x in range(10) for y in range(7)])
        session.edit_dungeon_tiles("floor", [[0, 0], [1, 0], [2, 0], [3, 0]])
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.edit_dungeon_walls("door", [{"x": 1, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        session.dungeon.walls["0,0,e"].door_open = True
        session.dungeon.walls["1,0,e"].door_open = True
        session.dungeon.fog_of_war_enabled = True
        session.add_player()
        player_id = session.selected_id
        session._set_position(session.state.enemies[player_id], 0, 0)
        start_room = session.state.enemies[player_id].room_id
        session.dungeon.revealed_room_ids = [start_room]
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        session._set_position(session.state.enemies[goblin_id], 3, 0)

        result = session.party_walk(player_id, 2, 0)

        self.assertTrue(result["partyWalk"]["stoppedForEncounter"])
        self.assertEqual(result["partyWalk"]["actualDestination"], {"x": 2, "y": 0})
        enemy_room = session.state.enemies[goblin_id].room_id
        self.assertIn(enemy_room, session.dungeon.revealed_room_ids)
        self.assertIn(enemy_room, session.dungeon.pending_encounter_room_ids)
        self.assertEqual((session.state.enemies[player_id].grid_x, session.state.enemies[player_id].grid_y), (2, 0))

    def test_party_walk_failure_does_not_partially_move_or_reveal(self) -> None:
        session = self.context.create_session("party-walk-atomic")
        session.edit_dungeon_tiles("void", [[x, y] for x in range(10) for y in range(7)])
        session.edit_dungeon_tiles("floor", [[0, 0]])
        session.analyze_dungeon()
        session.add_player(name="Leader")
        leader_id = session.selected_id
        session._set_position(session.state.enemies[leader_id], 0, 0)
        session.add_player(name="Follower")
        follower_id = session.selected_id
        session._set_position(session.state.enemies[follower_id], 0, 0)
        session.dungeon.revealed_room_ids = []

        with self.assertRaisesRegex(ValueError, "No valid Party Walk formation cell"):
            session.party_walk(leader_id, 0, 0)

        self.assertEqual((session.state.enemies[leader_id].grid_x, session.state.enemies[leader_id].grid_y), (0, 0))
        self.assertEqual((session.state.enemies[follower_id].grid_x, session.state.enemies[follower_id].grid_y), (0, 0))
        self.assertEqual(session.dungeon.revealed_room_ids, [])

    def test_party_walk_rejects_active_turn_pending_encounter_and_grappled_party(self) -> None:
        session = self.context.create_session("party-walk-reject")
        session.add_player(name="Leader")
        leader_id = session.selected_id
        session.add_player(name="Follower")
        follower_id = session.selected_id
        session.active_turn_id = leader_id
        with self.assertRaisesRegex(ValueError, "outside active combat"):
            session.party_walk(leader_id, 0, 0)

        session.active_turn_id = None
        session.dungeon = None
        session.pending_opportunity = {"kind": "test"}
        with self.assertRaisesRegex(ValueError, "pending opportunity"):
            session.party_walk(leader_id, 0, 0)

        session.pending_opportunity = None
        session._apply_grapple(session.state.enemies[leader_id], session.state.enemies[follower_id], 2)
        with self.assertRaisesRegex(ValueError, "Grappled"):
            session.party_walk(leader_id, 0, 0)

        session.state.grapples.clear()
        session.add_enemy_from_template("C_GOBLIN")
        session.encounter_started = True
        session.active_turn_id = None
        with self.assertRaisesRegex(ValueError, "outside active combat"):
            session.party_walk(leader_id, 0, 0)

    def test_copy_entity_creates_fresh_premade_enemy_next_to_source(self) -> None:
        session = self.context.create_session("copy-premade")
        session.add_enemy_from_template("C_GOBLIN")
        source_id = session.selected_id
        source = session.state.enemies[source_id]
        source.toughness_current = 1

        session.copy_entity(source_id)

        copy_id = session.selected_id
        copy = session.state.enemies[copy_id]
        self.assertNotEqual(copy_id, source_id)
        self.assertEqual(copy.template_id, source.template_id)
        self.assertEqual(copy.name, "Goblin 2")
        self.assertEqual((copy.grid_x, copy.grid_y), (source.grid_x + 1, source.grid_y))
        self.assertEqual(copy.toughness_current, copy.toughness_max)
        self.assertEqual(session.order, [source_id, copy_id])

    def test_copy_entity_creates_fresh_custom_enemy_with_core_deck(self) -> None:
        session = self.context.create_session("copy-custom")
        deck_id = next(iter(self.context.decks.keys()))
        session.add_custom_enemy(
            name="Custom Brute",
            toughness=12,
            armor=2,
            magic_armor=1,
            power=4,
            movement=5,
            core_deck_id=deck_id,
        )
        source_id = session.selected_id
        source = session.state.enemies[source_id]
        source.toughness_current = 3
        source.armor_current = 0
        source.magic_armor_current = 0

        session.copy_entity(source_id)

        copy = session.state.enemies[session.selected_id]
        self.assertEqual(copy.template_id, "custom")
        self.assertEqual(copy.name, "Custom Brute 2")
        self.assertEqual(copy.core_deck_id, deck_id)
        self.assertEqual((copy.toughness_current, copy.toughness_max), (12, 12))
        self.assertEqual((copy.armor_current, copy.armor_max), (2, 2))
        self.assertEqual((copy.magic_armor_current, copy.magic_armor_max), (1, 1))
        self.assertEqual(copy.power_base, 4)
        self.assertEqual(copy.movement, 5)

    def test_copy_entity_rejects_players(self) -> None:
        session = self.context.create_session("copy-player")
        session.add_player(name="Hero")

        with self.assertRaisesRegex(ValueError, "Players cannot be copied"):
            session.copy_entity(session.selected_id)

    def test_active_unit_can_spend_movement_pool_across_multiple_moves_and_dash(self) -> None:
        session = self.context.create_session("movement-pool")
        session.add_enemy_from_template("C_GOBLIN")
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

    def test_npc_opportunity_attack_triggers_when_pc_moves_away(self) -> None:
        session = self.context.create_session("npc-opportunity")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        session.set_entity_position(player_id, 1, 1)
        session.set_entity_position(goblin_id, 2, 1)
        session.active_turn_id = player_id
        goblin.deck_state.draw_pile = ["basic_a3"]
        goblin.deck_state.discard_pile = []

        result = session.move_entity_with_movement(player_id, 0, 1)

        self.assertEqual((player.grid_x, player.grid_y), (0, 1))
        self.assertEqual(player.toughness_current, 2)
        self.assertEqual(goblin.opportunity_attack_used_round, session.round)
        self.assertEqual(len(result["opportunityEvents"]), 1)
        self.assertEqual(result["opportunityEvents"][0]["attackerName"], goblin.name)
        self.assertEqual(result["opportunityEvents"][0]["damage"], 3)
        self.assertEqual(result["opportunityEvents"][0]["damageToToughness"], 3)

    def test_multiple_npc_opportunity_attacks_are_reported_together(self) -> None:
        session = self.context.create_session("multi-npc-opportunity")
        session.add_player(name="Mira", toughness=20, armor=0, magic_armor=0)
        player_id = session.selected_id
        goblin_ids = []
        draw_cards = ["basic_a2", "basic_a2", "basic_a3"]
        for index, position in enumerate([(2, 1), (2, 0), (2, 2)]):
            session.add_enemy_from_template("C_GOBLIN")
            goblin_id = session.selected_id
            goblin_ids.append(goblin_id)
            goblin = session.state.enemies[goblin_id]
            session.set_entity_position(goblin_id, position[0], position[1])
            goblin.deck_state.draw_pile = [draw_cards[index]]
            goblin.deck_state.discard_pile = []
        player = session.state.enemies[player_id]
        session.set_entity_position(player_id, 1, 1)
        session.active_turn_id = player_id

        result = session.move_entity_with_movement(player_id, 0, 1)

        self.assertEqual((player.grid_x, player.grid_y), (0, 1))
        self.assertEqual(player.toughness_current, 13)
        self.assertEqual([event["damage"] for event in result["opportunityEvents"]], [2, 2, 3])
        self.assertEqual(len(result["opportunityEvents"]), 3)
        for goblin_id in goblin_ids:
            self.assertEqual(session.state.enemies[goblin_id].opportunity_attack_used_round, session.round)
        self.assertTrue(any("provokes 3 enemy opportunity attacks" in line for line in session.combat_log))

    def test_npc_special_opportunity_stops_pc_before_step_and_is_unpreventable(self) -> None:
        session = self.context.create_session("npc-special-opportunity")
        session.add_player(name="Mira", toughness=5, armor=99, magic_armor=99)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        special_id = "C_GOBLIN__S__9"
        session.set_entity_position(player_id, 1, 1)
        session.set_entity_position(goblin_id, 2, 1)
        session.active_turn_id = player_id
        goblin.deck_state.draw_pile = [special_id]
        goblin.deck_state.discard_pile = []

        result = session.move_entity_with_movement(player_id, 0, 1)

        self.assertEqual((player.grid_x, player.grid_y), (1, 1))
        self.assertEqual(player.toughness_current, 1)
        self.assertEqual(session.movement_state["movement_used"], 0)
        self.assertTrue(session.movement_state["movement_stopped"])
        self.assertEqual(session.snapshot()["movementState"]["remainingMovement"], 0)
        self.assertEqual(result["opportunityEvents"][0]["special"], True)
        self.assertEqual(result["opportunityEvents"][0]["unpreventable"], True)
        self.assertEqual(result["opportunityEvents"][0]["stopped"], True)
        with self.assertRaisesRegex(ValueError, "movement has been stopped"):
            session.move_entity_with_movement(player_id, 0, 1)

    def test_opportunity_does_not_trigger_when_distance_stays_the_same(self) -> None:
        session = self.context.create_session("opportunity-same-distance")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        session.set_entity_position(player_id, 1, 1)
        session.set_entity_position(goblin_id, 2, 1)
        session.active_turn_id = player_id
        goblin.deck_state.draw_pile = ["basic_a3"]
        goblin.deck_state.discard_pile = []

        session.move_entity_with_movement(player_id, 1, 0)

        self.assertEqual((player.grid_x, player.grid_y), (1, 0))
        self.assertEqual(player.toughness_current, 5)
        self.assertEqual(goblin.opportunity_attack_used_round, 0)

    def test_disengage_prevents_opportunity_attacks_for_the_active_unit(self) -> None:
        session = self.context.create_session("opportunity-disengage")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        session.set_entity_position(player_id, 1, 1)
        session.set_entity_position(goblin_id, 2, 1)
        session.active_turn_id = player_id
        session.selected_id = player_id
        goblin.deck_state.draw_pile = ["basic_a3"]
        goblin.deck_state.discard_pile = []

        session.disengage_pc()
        session.move_entity_with_movement(player_id, 0, 1)

        self.assertEqual((player.grid_x, player.grid_y), (0, 1))
        self.assertEqual(player.toughness_current, 5)
        self.assertEqual(goblin.opportunity_attack_used_round, 0)

    def test_pc_opportunity_precise_hit_stops_mover_and_deals_unpreventable_base_damage(self) -> None:
        session = self.context.create_session("pc-opportunity-precise")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        goblin.toughness_current = 10
        goblin.toughness_max = 10
        goblin.armor_current = 99
        goblin.armor_max = 99
        session.set_entity_position(player_id, 1, 1)
        session.set_entity_position(goblin_id, 0, 1)
        session.active_turn_id = goblin_id
        player.deck_state.draw_pile = ["hf_martial_success_3", "hf_void_success_1", "hf_void_fail"]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []

        result = session.move_entity_with_movement(goblin_id, 0, 3)

        self.assertIsNotNone(result.get("pendingOpportunity"))
        self.assertEqual((goblin.grid_x, goblin.grid_y), (0, 2))
        self.assertEqual(session.movement_state["movement_used"], 1)

        waiting = session.resolve_opportunity_attack(action="attack")

        self.assertEqual(waiting["pendingOpportunity"]["phase"], "confirm")
        self.assertEqual(waiting["pendingOpportunity"]["successCount"], 2)
        self.assertEqual(waiting["pendingOpportunity"]["fateCount"], 0)
        self.assertEqual(goblin.toughness_current, 10)
        self.assertEqual(player.opportunity_attack_used_round, 0)

        session.resolve_opportunity_attack(action="attack", use_willpower=False)

        self.assertIsNone(session.pending_opportunity)
        self.assertEqual((goblin.grid_x, goblin.grid_y), (0, 2))
        self.assertEqual(goblin.toughness_current, 8)
        self.assertEqual(goblin.armor_current, 99)
        self.assertEqual(player.opportunity_attack_used_round, session.round)
        self.assertEqual(player.deck_state.hand, [])
        self.assertEqual(
            player.deck_state.discard_pile,
            ["hf_martial_success_3", "hf_void_success_1", "hf_void_fail"],
        )
        self.assertTrue(session.movement_state["movement_stopped"])
        self.assertEqual(session.snapshot()["movementState"]["remainingMovement"], 0)
        with self.assertRaisesRegex(ValueError, "movement has been stopped"):
            session.move_entity_with_movement(goblin_id, 0, 3)

    def test_pc_opportunity_draws_extra_hit_card_against_prone_target(self) -> None:
        session = self.context.create_session("pc-opportunity-prone-advantage")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        goblin.statuses["prone"] = {"stacks": 1}
        session.set_entity_position(player_id, 1, 1)
        session.set_entity_position(goblin_id, 0, 1)
        session.active_turn_id = goblin_id
        player.deck_state.draw_pile = ["hf_void_success_1", "hf_void_fail", "hf_void_fail", "hf_void_fail"]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []

        result = session.move_entity_with_movement(goblin_id, 0, 3)
        waiting = session.resolve_opportunity_attack(action="attack")

        self.assertEqual(result["pendingOpportunity"]["hitDrawCount"], 4)
        self.assertEqual(waiting["pendingOpportunity"]["hitDrawCount"], 4)
        self.assertEqual(waiting["pendingOpportunity"]["successCount"], 1)
        self.assertEqual(
            player.deck_state.discard_pile,
            ["hf_void_success_1", "hf_void_fail", "hf_void_fail", "hf_void_fail"],
        )

    def test_pc_opportunity_uses_fallback_damage_when_weapon_is_not_martial_melee(self) -> None:
        session = self.context.create_session("pc-opportunity-fallback")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        player.melee_weapon = {"name": "Longbow", "kind": "martial_ranged", "baseDamage": 5, "reach": 5}
        goblin.toughness_current = 10
        goblin.toughness_max = 10
        session.set_entity_position(player_id, 1, 1)
        session.set_entity_position(goblin_id, 0, 1)
        session.active_turn_id = goblin_id
        player.deck_state.draw_pile = ["hf_martial_success_3", "hf_void_success_1", "hf_void_fail"]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []

        session.move_entity_with_movement(goblin_id, 0, 3)
        session.resolve_opportunity_attack(action="attack", use_willpower=False)

        self.assertEqual(goblin.toughness_current, 9)

    def test_legacy_player_without_weapon_loads_placeholder_sword(self) -> None:
        session = self.context.create_session("legacy-player-weapon")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        payload = session.undo_payload()
        for enemy in payload["enemies"]:
            if enemy["instance_id"] == player_id:
                enemy.pop("melee_weapon", None)

        loaded = BattleSession(context=self.context, sid="legacy-player-weapon-loaded")
        loaded.load_from_payload(payload, load_undo_stack=False)
        player = loaded.state.enemies[player_id]

        self.assertEqual(player.melee_weapon["name"], "Sword")
        self.assertEqual(loaded._opportunity_base_damage(player), 2)
        self.assertEqual(loaded._opportunity_reach(player), 1)

    def test_pc_opportunity_skip_does_not_mark_used_and_continues_movement(self) -> None:
        session = self.context.create_session("pc-opportunity-skip")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        session.set_entity_position(player_id, 1, 1)
        session.set_entity_position(goblin_id, 0, 1)
        session.active_turn_id = goblin_id

        session.move_entity_with_movement(goblin_id, 0, 3)
        session.resolve_opportunity_attack(action="skip")

        self.assertIsNone(session.pending_opportunity)
        self.assertEqual((goblin.grid_x, goblin.grid_y), (0, 3))
        self.assertEqual(player.opportunity_attack_used_round, 0)

    def test_physical_pc_opportunity_fate_waits_for_willpower_choice(self) -> None:
        session = self.context.create_session("pc-opportunity-physical-fate")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0, physical_cards=True)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        goblin.toughness_current = 10
        goblin.toughness_max = 10
        session.set_entity_position(player_id, 1, 1)
        session.set_entity_position(goblin_id, 0, 1)
        session.active_turn_id = goblin_id

        session.move_entity_with_movement(goblin_id, 0, 3)
        waiting = session.resolve_opportunity_attack(action="attack", manual_successes=1, manual_fate=1)

        self.assertEqual(waiting["pendingOpportunity"]["phase"], "willpower")
        self.assertEqual(player.opportunity_attack_used_round, 0)

        session.resolve_opportunity_attack(action="attack", use_willpower=True)

        self.assertIsNone(session.pending_opportunity)
        self.assertEqual((goblin.grid_x, goblin.grid_y), (0, 2))
        self.assertEqual(goblin.toughness_current, 8)
        self.assertEqual(player.opportunity_attack_used_round, session.round)

    def test_reach_two_opportunity_triggers_when_mover_steps_farther_away(self) -> None:
        session = self.context.create_session("pc-opportunity-reach")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        player.melee_weapon = {"name": "Spear", "kind": "martial_melee", "baseDamage": 3, "reach": 2}
        session.set_entity_position(player_id, 2, 1)
        session.set_entity_position(goblin_id, 0, 1)
        session.active_turn_id = goblin_id

        session.move_entity_with_movement(goblin_id, 0, 4)

        self.assertIsNotNone(session.pending_opportunity)
        self.assertEqual(session.pending_opportunity["attacker_ids"], [player_id])
        self.assertEqual((session.state.enemies[goblin_id].grid_x, session.state.enemies[goblin_id].grid_y), (0, 3))

    def test_precise_opportunity_stops_at_last_route_cell_within_reach(self) -> None:
        session = self.context.create_session("pc-opportunity-stop-cell")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0)
        player_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        goblin_id = session.selected_id
        player = session.state.enemies[player_id]
        goblin = session.state.enemies[goblin_id]
        player.melee_weapon = {"name": "Spear", "kind": "martial_melee", "baseDamage": 3, "reach": 2}
        goblin.toughness_current = 10
        goblin.toughness_max = 10
        goblin.armor_current = 99
        goblin.armor_max = 99
        session.set_entity_position(player_id, 2, 1)
        session.set_entity_position(goblin_id, 1, 1)
        session.active_turn_id = goblin_id
        player.deck_state.draw_pile = ["hf_martial_success_3", "hf_void_success_1", "hf_void_fail"]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []

        session.move_entity_with_movement(goblin_id, 0, 1)

        self.assertIsNotNone(session.pending_opportunity)
        self.assertEqual((goblin.grid_x, goblin.grid_y), (1, 1))

        session.resolve_opportunity_attack(action="attack", use_willpower=False)

        self.assertEqual((goblin.grid_x, goblin.grid_y), (0, 1))
        self.assertEqual(session.movement_state["movement_used"], 1)
        self.assertEqual(goblin.toughness_current, 7)
        self.assertEqual(goblin.armor_current, 99)

    def test_movement_rejects_non_active_and_over_double_pool_moves(self) -> None:
        session = self.context.create_session("movement-limits")
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
        second_id = session.selected_id
        session.set_entity_position(first_id, 0, 0)
        session.set_entity_position(second_id, 0, 1)
        session.select(first_id)
        session.next_turn()

        self.assertEqual(session.active_turn_id, second_id)
        with self.assertRaisesRegex(ValueError, "Only the active"):
            session.move_entity_with_movement(first_id, 1, 0)
        with self.assertRaisesRegex(ValueError, "not reachable|not have enough|not walkable"):
            session.move_entity_with_movement(second_id, 13, 1, dash=True)

    def test_diagonal_movement_cost_parity_continues_across_moves(self) -> None:
        session = self.context.create_session("movement-diagonal-parity")
        session.add_enemy_from_template("C_WOLF")
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
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
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
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
        second_id = session.selected_id
        session.state.enemies[first_id].toughness_current = 0

        session.start_encounter()

        self.assertEqual(session.selected_id, second_id)
        self.assertEqual(session.active_turn_id, second_id)
        with self.assertRaisesRegex(ValueError, "already has an active turn"):
            session.start_encounter()

        all_down = self.context.create_session("start-encounter-all-down")
        all_down.add_enemy_from_template("C_GOBLIN")
        all_down.state.enemies[all_down.selected_id].toughness_current = 0

        with self.assertRaisesRegex(ValueError, "No units can start encounter"):
            all_down.start_encounter()
        self.assertIsNone(all_down.active_turn_id)
        self.assertFalse(all_down.turn_in_progress)

    def test_movement_pathing_blocks_living_units_but_not_down_units(self) -> None:
        session = self.context.create_session("movement-blockers")
        session.edit_dungeon_tiles("void", [[x, y] for x in range(10) for y in range(7)])
        session.edit_dungeon_tiles("floor", [[x, y] for x in range(3) for y in range(3)])
        session.analyze_dungeon()
        # Player as mover â€” enemies block cross-faction; same-faction units are passable
        session.add_player(name="Mira")
        mover_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        top_blocker_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        middle_blocker_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
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
        session.add_enemy_from_template("C_WOLF")
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
        session.add_enemy_from_template("C_GOBLIN")
        down_id = session.selected_id
        session.state.enemies[down_id].toughness_current = 0

        session.add_player()
        player = session.state.enemies[session.selected_id]
        down = session.state.enemies[down_id]

        self.assertEqual((down.grid_x, down.grid_y), (4, 3))
        self.assertEqual((player.grid_x, player.grid_y), (4, 3))

    def test_sparse_dungeon_negative_tiles_persist_and_accept_units(self) -> None:
        session = self.context.create_session("sparse-negative")
        session.edit_dungeon_tiles("floor", [[-2, 0]])
        session.add_player()
        player_id = session.selected_id

        session.set_entity_position(player_id, -2, 0)
        snapshot = session.snapshot()

        self.assertIn("-2,0", snapshot["dungeon"]["tiles"])
        self.assertEqual(snapshot["dungeon"]["extents"]["minX"], -2)
        self.assertEqual((session.state.enemies[player_id].grid_x, session.state.enemies[player_id].grid_y), (-2, 0))

        self.context._sessions.pop("sparse-negative", None)
        reloaded = self.context.load_session("sparse-negative")
        self.assertIn("-2,0", reloaded.dungeon.tiles)
        self.assertEqual((reloaded.state.enemies[player_id].grid_x, reloaded.state.enemies[player_id].grid_y), (-2, 0))

    def test_void_remains_absent_and_sparse_area_is_not_filled(self) -> None:
        session = self.context.create_session("sparse-void")

        session.edit_dungeon_tiles("void", [[1, 1]])

        self.assertNotIn("1,1", session.dungeon.tiles)
        self.assertNotIn("11,8", session.dungeon.tiles)

    def test_sparse_dungeon_movement_uses_explicit_walkable_tiles(self) -> None:
        session = self.context.create_session("sparse-movement")
        session.edit_dungeon_tiles("floor", [[-1, 3]])
        session.add_enemy_from_template("C_WOLF")
        entity_id = session.selected_id
        session.set_entity_position(entity_id, 0, 3)
        session.next_turn()
        session.start_new_round()

        session.move_entity_with_movement(entity_id, -1, 3)

        moved = session.state.enemies[entity_id]
        self.assertEqual((moved.grid_x, moved.grid_y), (-1, 3))
        with self.assertRaisesRegex(ValueError, "not walkable"):
            session.move_entity_with_movement(entity_id, -2, 3)

    def test_auto_place_uses_walkable_sparse_dungeon_tiles(self) -> None:
        session = self.context.create_session("sparse-auto-place")

        # Reduce to a single cell at (0,0)
        session.edit_dungeon_tiles("void", [[x, y] for x in range(10) for y in range(7)])
        session.edit_dungeon_tiles("floor", [[0, 0]])
        session.analyze_dungeon()
        session.add_player()
        first_id = session.selected_id

        self.assertEqual((session.state.enemies[first_id].grid_x, session.state.enemies[first_id].grid_y), (0, 0))

        session.edit_dungeon_tiles("void", [[0, 0]])
        session.add_player()
        second_id = session.selected_id

        self.assertIsNone(session.state.enemies[second_id].grid_x)
        self.assertIsNone(session.state.enemies[second_id].grid_y)

    def test_auto_place_leaves_units_unplaced_when_room_is_full(self) -> None:
        session = self.context.create_session("map-full")
        # Clear default 10x7 grid, then paint a 3x3 room (9 cells max capacity)
        session.edit_dungeon_tiles("void", [[x, y] for x in range(10) for y in range(7)])
        session.edit_dungeon_tiles("floor", [[x, y] for x in range(3) for y in range(3)])
        session.analyze_dungeon()

        for _ in range(10):
            session.add_player()

        snapshot = session.snapshot()
        placed = [entity for entity in snapshot["enemies"] if entity["grid_x"] is not None]
        unplaced = [entity for entity in snapshot["enemies"] if entity["grid_x"] is None]

        self.assertEqual(len(placed), 9)
        self.assertEqual(len(unplaced), 1)

    def test_draw_and_end_turn_keep_draw_visible_until_next_start(self) -> None:
        session = self.context.create_session("draw-turn")
        session.add_enemy_from_template("C_GOBLIN")
        selected = session.state.enemies[session.selected_id]
        selected.deck_state.draw_pile = ["C_GOBLIN__A1__4"]
        selected.deck_state.discard_pile = []
        selected.deck_state.hand = []

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
        session.add_enemy_from_template("C_GOBLIN")
        enemy = session.state.enemies[session.selected_id]
        enemy.deck_state.draw_pile = ["C_GOBLIN__A1__4"]
        enemy.deck_state.discard_pile = []
        enemy.deck_state.hand = []

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
        session.add_enemy_from_template("C_GOBLIN")
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

    def test_draw_effect_immediately_draws_next_card(self) -> None:
        session = self.context.create_session("draw-effect")
        session.add_enemy_from_template("C_GOBLIN")
        enemy = session.state.enemies[session.selected_id]
        enemy.power_base = 1
        enemy.deck_state.draw_pile = ["ctrl_dis5_draw", "ctrl_a3"]
        enemy.deck_state.discard_pile = []
        enemy.deck_state.hand = []

        session.draw_turn()

        self.assertEqual(enemy.deck_state.hand, ["ctrl_dis5_draw", "ctrl_a3"])
        self.assertEqual(session.visible_draw_for(enemy), ["ctrl_dis5_draw", "ctrl_a3"])
        payload = session.snapshot()["enemies"][0]
        self.assertEqual(payload["current_draw_text"], ["Disengage 5 + Draw 1", "Attack 3"])
        self.assertEqual(payload["current_draw_attacks"][0]["damage"], 3)
        self.assertIn("+1 draw", session.combat_log[0])

    def test_quick_attack_applies_current_draw_to_selected_target(self) -> None:
        session = self.context.create_session("quick-attack")
        session.add_enemy_from_template("C_WOLF")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 0
        target.armor_current = 0
        target.armor_max = 0
        self.context.card_index["test_stab_5"] = Card(
            id="test_stab_5",
            title="Test Stab",
            effects=(Effect(type="attack", amount=5, modifiers=("stab",)),),
        )
        attacker.deck_state.hand = ["test_stab_5"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(target.toughness_current, 5)
        self.assertEqual(result["quickAttack"]["attackerId"], attacker_id)
        self.assertEqual(result["quickAttack"]["targetId"], target_id)
        self.assertEqual(result["quickAttack"]["attacks"][0]["label"], "Attack 5 (stab)")
        self.assertIn("Quick Attack by", session.combat_log[0])
        attacker_payload = next(enemy for enemy in session.snapshot()["enemies"] if enemy["instance_id"] == attacker_id)
        self.assertTrue(attacker.quick_attack_used)
        self.assertTrue(attacker_payload["quick_attack_used"])
        self.assertEqual(attacker_payload["current_draw_attacks"][0]["damage"], 5)
        with self.assertRaisesRegex(ValueError, "already been used"):
            session.apply_quick_attack_from_active_draw()

    def test_quick_attack_applies_multi_attack_sequentially(self) -> None:
        session = self.context.create_session("quick-multi")
        session.add_enemy_from_template("C_WOLF")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 0
        target.armor_current = 1
        target.armor_max = 1
        attacker.deck_state.hand = ["ctrl_a2_stab", "ctrl_a3"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        session.apply_quick_attack_from_active_draw()

        self.assertEqual(target.toughness_current, 6)

    def test_quick_attack_adds_player_wounds(self) -> None:
        session = self.context.create_session("quick-player-wound")
        session.add_enemy_from_template("C_WOLF")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0, power=0, movement=6)
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 3
        attacker.deck_state.hand = ["basic_a5"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(target.toughness_current, 3)
        self.assertEqual(result["woundEvents"][0]["wounds"], 1)
        self.assertEqual(target.deck_state.hand, [WOUND_CARD_ID])

    def test_quick_attack_reports_unsupported_modifiers_and_manual_effects(self) -> None:
        session = self.context.create_session("quick-unsupported")
        session.add_enemy_from_template("C_HOBGOBLIN")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 0
        target.armor_current = 0
        target.armor_max = 0
        self.context.card_index["test_push"] = Card(
            id="test_push",
            title="Push Strike",
            effects=(Effect(type="attack", amount=3, modifiers=("push 5ft",)),),
        )
        attacker.deck_state.hand = ["test_push", "ctrl_a2_dodge"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(target.toughness_current, 5)
        self.assertIn("push 5ft", result["quickAttack"]["manualItems"])
        self.assertIn("dodge", result["quickAttack"]["manualItems"])
        self.assertIn("Handle manually", result["quickAttackNotice"])
        self.assertIn("handle manually", session.combat_log[0])

    def test_quick_attack_supports_excel_pierce_x_actions(self) -> None:
        session = self.context.create_session("quick-pierce-x")
        session.add_enemy_from_template("C_GOBLIN_ARCHER")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 3
        target.armor_current = 2
        target.armor_max = 2
        attacker.deck_state.hand = ["C_GOBLIN_ARCHER__S__10"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(result["quickAttack"]["attacks"][0]["label"], "Attack 5 (pierce 3)")
        self.assertEqual(target.toughness_current, 7)
        self.assertEqual(target.guard_current, 1)

    def test_quick_attack_supports_overwhelm_sunder_and_shatter(self) -> None:
        session = self.context.create_session("quick-breaker")
        session.add_enemy_from_template("C_BUGBEAR")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 4
        target.armor_current = 2
        target.armor_max = 2
        self.context.card_index["test_breaker"] = Card(
            id="test_breaker",
            title="Breaker",
            effects=(Effect(type="attack", amount=5, modifiers=("overwhelm", "sunder:2", "shatter")),),
        )
        attacker.deck_state.hand = ["test_breaker"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(result["quickAttack"]["attacks"][0]["label"], "Attack 5 (overwhelm, sunder 2, shatter)")
        self.assertEqual(target.toughness_current, 6)
        self.assertEqual(target.guard_current, 0)
        self.assertEqual(target.armor_current, 1)

    def test_quick_attack_supports_conditional_attack_replacement(self) -> None:
        session = self.context.create_session("quick-conditional")
        session.add_enemy_from_template("C_WOLF")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 0
        target.armor_current = 0
        target.statuses["poison"] = {"stacks": 1}
        self.context.card_index["test_conditional_poison"] = Card(
            id="test_conditional_poison",
            title="Venom Bite",
            effects=(
                Effect(type="attack", amount=4),
                Effect(
                    type="conditional_attack",
                    amount=7,
                    modifiers=("replace_attack", "if_target_poisoned", "condition_any"),
                ),
            ),
        )
        attacker.deck_state.hand = ["test_conditional_poison"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(target.toughness_current, 3)
        self.assertIn("Attack 7", result["quickAttackNotice"])
        self.assertIn("conditional attack", session.combat_log[1])

    def test_quick_attack_applies_prone_melee_and_ranged_damage_adjustments(self) -> None:
        session = self.context.create_session("quick-prone-advantage")
        session.add_enemy_from_template("C_WOLF")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 0
        target.armor_current = 0
        target.armor_max = 0
        target.statuses["prone"] = {"stacks": 1}
        self.context.card_index["test_prone_melee"] = Card(
            id="test_prone_melee",
            title="Prone Melee",
            effects=(Effect(type="attack", amount=4),),
        )
        attacker.deck_state.hand = ["test_prone_melee"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(target.toughness_current, 4)
        self.assertEqual(result["quickAttack"]["attacks"][0]["label"], "Attack 6")
        self.assertTrue(any("melee attack damage increases from 4 to 6" in line for line in session.combat_log))

        session = self.context.create_session("quick-prone-disadvantage")
        session.add_enemy_from_template("C_WOLF")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 0
        target.armor_current = 0
        target.armor_max = 0
        target.statuses["prone"] = {"stacks": 1}
        self.context.card_index["test_prone_ranged"] = Card(
            id="test_prone_ranged",
            title="Prone Ranged",
            effects=(Effect(type="attack", amount=4, modifiers=("ranged",)),),
        )
        attacker.deck_state.hand = ["test_prone_ranged"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(target.toughness_current, 8)
        self.assertEqual(result["quickAttack"]["attacks"][0]["label"], "Attack 2")
        self.assertTrue(any("ranged attack damage decreases from 4 to 2" in line for line in session.combat_log))

    def test_quick_attack_charge_applies_grapple_and_prone(self) -> None:
        session = self.context.create_session("quick-charge")
        session.add_enemy_from_template("C_WOLF")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 0
        target.armor_current = 0
        target.armor_max = 0
        self.context.card_index["test_charge"] = Card(
            id="test_charge",
            title="Charge",
            effects=(Effect(type="attack", amount=1), Effect(type="charge", amount=5)),
        )
        attacker.deck_state.hand = ["test_charge"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(target.toughness_current, 9)
        self.assertIn("prone", target.statuses)
        self.assertEqual(len(session._grapples_for_target(target_id)), 1)
        self.assertEqual(session._grapples_for_target(target_id)[0].toughness_current, 5)
        self.assertEqual(result["quickAttack"]["manualItems"], [])

    def test_quick_attack_prone_effect_sets_target_prone(self) -> None:
        session = self.context.create_session("quick-prone-effect")
        session.add_enemy_from_template("C_WOLF")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 0
        target.armor_current = 0
        target.armor_max = 0
        self.context.card_index["test_prone_effect"] = Card(
            id="test_prone_effect",
            title="Trip",
            effects=(Effect(type="attack", amount=1), Effect(type="prone", amount=1)),
        )
        attacker.deck_state.hand = ["test_prone_effect"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        session.select(target_id)

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(target.toughness_current, 9)
        self.assertIn("prone", target.statuses)
        self.assertEqual(result["quickAttack"]["attacks"][0]["proneEffects"][0]["type"], "prone")
        self.assertEqual(result["quickAttack"]["manualItems"], [])

    def test_grapple_apply_stacks_and_splits_by_grappler(self) -> None:
        session = self.context.create_session("grapple-stack")
        session.add_enemy_from_template("C_WOLF")
        first_grappler = session.state.enemies[session.selected_id]
        session.add_enemy_from_template("C_GOBLIN")
        target = session.state.enemies[session.selected_id]
        session.add_enemy_from_template("C_HOBGOBLIN")
        second_grappler = session.state.enemies[session.selected_id]

        session._apply_grapple(first_grappler, target, 3)
        session._apply_grapple(first_grappler, target, 2)
        session._apply_grapple(second_grappler, target, 4)

        grapples = session._grapples_for_target(target.instance_id)
        self.assertEqual(len(grapples), 2)
        self.assertEqual(sorted(grapple.toughness_max for grapple in grapples), [4, 5])
        snapshot_target = next(enemy for enemy in session.snapshot()["enemies"] if enemy["instance_id"] == target.instance_id)
        self.assertEqual(len(snapshot_target["grappled_by"]), 2)
        self.assertIn("grappled", snapshot_target["statuses"])

    def test_manual_attack_can_damage_selected_units_grapple_without_reductions(self) -> None:
        session = self.context.create_session("grapple-manual")
        session.add_enemy_from_template("C_WOLF")
        grappler = session.state.enemies[session.selected_id]
        session.add_enemy_from_template("C_GOBLIN")
        target = session.state.enemies[session.selected_id]
        target.toughness_current = 10
        target.toughness_max = 10
        target.guard_current = 99
        target.armor_current = 99
        line = session._apply_grapple(grappler, target, 5)
        self.assertIn("Grappled", line)
        grapple = session._preferred_grapple_for_target(target.instance_id)
        session.select(target.instance_id)

        result = session.apply_attack_to_selected(
            damage=3,
            modifiers=[],
            add_burn=False,
            add_poison=False,
            add_slow=False,
            add_paralyze=False,
            target_mode="grapple",
            grapple_id=grapple.id,
        )

        self.assertEqual(target.toughness_current, 10)
        self.assertEqual(target.guard_current, 99)
        self.assertEqual(result["grappleEvents"][0]["toughnessAfter"], 2)
        self.assertEqual(session.state.grapples[grapple.id].toughness_current, 2)

    def test_grappled_unit_cannot_use_normal_movement(self) -> None:
        session = self.context.create_session("grapple-move-block")
        session.add_enemy_from_template("C_WOLF")
        grappler = session.state.enemies[session.selected_id]
        session.add_enemy_from_template("C_GOBLIN")
        target_id = session.selected_id
        target = session.state.enemies[target_id]
        session.set_entity_position(grappler.instance_id, 1, 1)
        session.set_entity_position(target_id, 2, 1)
        session._apply_grapple(grappler, target, 5)
        session.active_turn_id = target_id

        with self.assertRaisesRegex(ValueError, "Grappled and cannot move"):
            session.move_entity_with_movement(target_id, 3, 1)

    def test_damage_to_grappler_reduces_grapples_they_hold(self) -> None:
        session = self.context.create_session("grapple-spill")
        session.add_enemy_from_template("C_WOLF")
        grappler = session.state.enemies[session.selected_id]
        session.add_enemy_from_template("C_GOBLIN")
        target = session.state.enemies[session.selected_id]
        grappler.toughness_current = 10
        grappler.toughness_max = 10
        grappler.guard_current = 0
        grappler.armor_current = 0
        session._apply_grapple(grappler, target, 5)
        grapple = session._preferred_grapple_for_target(target.instance_id)
        session.select(grappler.instance_id)

        session.apply_attack_to_selected(
            damage=2,
            modifiers=[],
            add_burn=False,
            add_poison=False,
            add_slow=False,
            add_paralyze=False,
        )

        self.assertEqual(grappler.toughness_current, 8)
        self.assertEqual(session.state.grapples[grapple.id].toughness_current, 3)

    def test_quick_attack_targets_lowest_toughness_grapple_when_active_is_grappled(self) -> None:
        session = self.context.create_session("quick-grapple")
        session.add_enemy_from_template("C_WOLF")
        attacker_id = session.selected_id
        attacker = session.state.enemies[attacker_id]
        session.add_enemy_from_template("C_GOBLIN")
        first_grappler = session.state.enemies[session.selected_id]
        session.add_enemy_from_template("C_HOBGOBLIN")
        second_grappler = session.state.enemies[session.selected_id]
        session._apply_grapple(first_grappler, attacker, 4)
        session._apply_grapple(second_grappler, attacker, 2)
        attacker.deck_state.hand = ["basic_a3"]
        session.active_turn_id = attacker_id
        session.turn_in_progress = True
        first_toughness = first_grappler.toughness_current
        second_toughness = second_grappler.toughness_current

        result = session.apply_quick_attack_from_active_draw()

        self.assertEqual(result["quickAttack"]["targetType"], "grapple")
        self.assertEqual(first_grappler.toughness_current, first_toughness)
        self.assertEqual(second_grappler.toughness_current, second_toughness)
        remaining_grapples = session._grapples_for_target(attacker.instance_id)
        self.assertEqual(len(remaining_grapples), 1)
        self.assertEqual(remaining_grapples[0].toughness_current, 4)

    def test_save_load_preserves_grapple_state(self) -> None:
        session = self.context.create_session("grapple-save")
        session.add_enemy_from_template("C_WOLF")
        grappler = session.state.enemies[session.selected_id]
        session.add_enemy_from_template("C_GOBLIN")
        target = session.state.enemies[session.selected_id]
        session._apply_grapple(grappler, target, 5)

        restored = self.context.create_session("grapple-restore")
        restored.load_from_payload(session.undo_payload(), load_undo_stack=False)

        self.assertEqual(len(restored.state.grapples), 1)
        restored_grapple = next(iter(restored.state.grapples.values()))
        self.assertEqual(restored_grapple.grappler_id, grappler.instance_id)
        self.assertEqual(restored_grapple.target_id, target.instance_id)
        self.assertEqual(restored_grapple.toughness_current, 5)

    def test_quick_attack_rejects_invalid_state(self) -> None:
        no_active = self.context.create_session("quick-no-active")
        no_active.add_enemy_from_template("C_WOLF")
        with self.assertRaisesRegex(ValueError, "No NPC"):
            no_active.apply_quick_attack_from_active_draw()

        no_draw = self.context.create_session("quick-no-draw")
        no_draw.add_enemy_from_template("C_WOLF")
        attacker_id = no_draw.selected_id
        no_draw.add_enemy_from_template("C_GOBLIN")
        no_draw.active_turn_id = attacker_id
        with self.assertRaisesRegex(ValueError, "Press Draw"):
            no_draw.apply_quick_attack_from_active_draw()

        self_target = self.context.create_session("quick-self")
        self_target.add_enemy_from_template("C_WOLF")
        attacker_id = self_target.selected_id
        attacker = self_target.state.enemies[attacker_id]
        attacker.deck_state.hand = ["basic_a2"]
        self_target.active_turn_id = attacker_id
        self_target.turn_in_progress = True
        with self.assertRaisesRegex(ValueError, "other than the active NPC"):
            self_target.apply_quick_attack_from_active_draw()

        down_target = self.context.create_session("quick-down")
        down_target.add_enemy_from_template("C_WOLF")
        attacker_id = down_target.selected_id
        attacker = down_target.state.enemies[attacker_id]
        down_target.add_enemy_from_template("C_GOBLIN")
        target_id = down_target.selected_id
        down_target.state.enemies[target_id].toughness_current = 0
        attacker.deck_state.hand = ["basic_a2"]
        down_target.active_turn_id = attacker_id
        down_target.turn_in_progress = True
        with self.assertRaisesRegex(ValueError, "target is down"):
            down_target.apply_quick_attack_from_active_draw()

        no_attack = self.context.create_session("quick-no-attack")
        no_attack.add_enemy_from_template("C_WOLF")
        attacker_id = no_attack.selected_id
        attacker = no_attack.state.enemies[attacker_id]
        no_attack.add_enemy_from_template("C_GOBLIN")
        attacker.deck_state.hand = ["basic_g4"]
        no_attack.active_turn_id = attacker_id
        no_attack.turn_in_progress = True
        with self.assertRaisesRegex(ValueError, "no attack effects"):
            no_attack.apply_quick_attack_from_active_draw()

    def test_current_draw_persists_until_that_same_unit_turn_starts_again(self) -> None:
        session = self.context.create_session("draw-persist")
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        first_enemy = session.state.enemies[first_id]
        session.add_enemy_from_template("C_WOLF")
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
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
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
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
        down_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
        third_id = session.selected_id
        session.state.enemies[down_id].toughness_current = 0

        session.select(first_id)
        session.next_turn()

        self.assertEqual(session.selected_id, third_id)
        self.assertEqual(session.active_turn_id, third_id)
        self.assertFalse(session.turn_in_progress)

    def test_down_units_cannot_start_turns(self) -> None:
        session = self.context.create_session("down-turn-blocked")
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
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
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
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
        session.add_enemy_from_template("C_GOBLIN")
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
        session.add_enemy_from_template("C_GOBLIN")
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

    def test_pierce_x_ignores_armor_first_then_guard(self) -> None:
        session = self.context.create_session("pierce-x")
        session.add_enemy_from_template("C_GOBLIN")
        entity = session.state.enemies[session.selected_id]
        entity.toughness_current = 10
        entity.toughness_max = 10
        entity.guard_current = 3
        entity.armor_current = 2
        entity.armor_max = 2

        log = apply_attack(entity, 8, mods=["pierce:4"])

        self.assertEqual(log.ignored_regular, 4)
        self.assertEqual(log.damage_to_hp, 7)
        self.assertEqual(entity.toughness_current, 3)
        self.assertEqual(entity.armor_current, 2)
        self.assertEqual(entity.guard_current, 2)

    def test_overwhelm_ignores_guard_without_consuming_it(self) -> None:
        session = self.context.create_session("overwhelm")
        session.add_enemy_from_template("C_GOBLIN")
        entity = session.state.enemies[session.selected_id]
        entity.toughness_current = 10
        entity.toughness_max = 10
        entity.guard_current = 4
        entity.armor_current = 1
        entity.armor_max = 1

        log = apply_attack(entity, 5, mods=["overwhelm"])

        self.assertEqual(log.ignored_regular, 4)
        self.assertEqual(log.damage_to_hp, 4)
        self.assertEqual(log.guarded_total, 1)
        self.assertEqual(entity.toughness_current, 6)
        self.assertEqual(entity.armor_current, 1)
        self.assertEqual(entity.guard_current, 4)

    def test_sunder_removes_guard_before_damage_resolves(self) -> None:
        session = self.context.create_session("sunder")
        session.add_enemy_from_template("C_GOBLIN")
        entity = session.state.enemies[session.selected_id]
        entity.toughness_current = 10
        entity.toughness_max = 10
        entity.guard_current = 6
        entity.armor_current = 0
        entity.armor_max = 0

        log = apply_attack(entity, 3, mods=["sunder:2"])

        self.assertEqual(log.ignored_regular, 0)
        self.assertEqual(log.damage_to_hp, 1)
        self.assertEqual(log.guarded_total, 2)
        self.assertEqual(entity.toughness_current, 9)
        self.assertEqual(entity.guard_current, 0)

    def test_shatter_destroys_one_regular_armor_before_damage_resolves(self) -> None:
        session = self.context.create_session("shatter")
        session.add_enemy_from_template("C_GOBLIN")
        entity = session.state.enemies[session.selected_id]
        entity.toughness_current = 10
        entity.toughness_max = 10
        entity.guard_current = 0
        entity.armor_current = 2
        entity.armor_max = 2

        log = apply_attack(entity, 3, mods=["shatter"])

        self.assertEqual(log.damage_to_hp, 2)
        self.assertEqual(log.guarded_total, 1)
        self.assertEqual(entity.toughness_current, 8)
        self.assertEqual(entity.armor_current, 1)

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

    def test_player_heal_clamps_to_toughness_max(self) -> None:
        session = self.context.create_session("player-overheal")
        session.add_player(name="Mira", toughness=3, armor=0, magic_armor=0, power=1, movement=5)
        player = session.state.enemies[session.selected_id]
        player.toughness_current = 2

        session.apply_heal_to_selected(toughness=3, armor=0, magic_armor=0, guard=0)

        self.assertEqual(player.toughness_current, 3)

        session.apply_heal_to_selected(toughness=3, armor=0, magic_armor=0, guard=0)

        self.assertEqual(player.toughness_current, 3)

    def test_enemy_heal_still_clamps_to_toughness_max(self) -> None:
        session = self.context.create_session("enemy-heal-cap")
        session.add_enemy_from_template("C_WOLF")
        enemy = session.state.enemies[session.selected_id]
        enemy.toughness_current = 2
        enemy.toughness_max = 3

        session.apply_heal_to_selected(toughness=3, armor=0, magic_armor=0, guard=0)

        self.assertEqual(enemy.toughness_current, 3)

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
        self.assertEqual(player.deck_state.hand, [WOUND_CARD_ID, WOUND_CARD_ID])
        self.assertEqual(result["woundEvents"][0]["wounds"], 2)
        self.assertEqual(result["woundEvents"][0]["toughnessAfter"], 4)
        self.assertIn("2 wounds added", session.combat_log[0])
        payload = session.snapshot()["enemies"][0]
        self.assertEqual(payload["wound_counts"], {"hand": 2, "discard": 0, "draw_pile": 0, "total": 2})

    def test_player_draw_of_power_is_reduced_by_hand_wounds(self) -> None:
        session = self.context.create_session("player-wound-draw")
        session.add_player(name="Mira", power=4)
        player = session.state.enemies[session.selected_id]
        player.deck_state.hand = [WOUND_CARD_ID]
        player.deck_state.discard_pile = []
        player.deck_state.draw_pile = [
            "hf_martial_success_2",
            "hf_elemental_fail_1a",
            "hf_void_success_1",
            "hf_light_success_2a",
        ]

        session.draw_turn()

        self.assertEqual(
            player.deck_state.hand,
            [WOUND_CARD_ID, "hf_martial_success_2", "hf_elemental_fail_1a", "hf_void_success_1"],
        )
        self.assertEqual(session.visible_draw_for(player), ["hf_martial_success_2", "hf_elemental_fail_1a", "hf_void_success_1"])
        self.assertTrue(player.power_draw_used)
        payload = session.snapshot()["enemies"][0]
        self.assertEqual(payload["wound_counts"], {"hand": 1, "discard": 0, "draw_pile": 0, "total": 1})

    def test_player_draw_of_power_resolves_legacy_player_card_ids(self) -> None:
        session = self.context.create_session("player-legacy-dop")
        session.add_player(name="Mira", power=4)
        player = session.state.enemies[session.selected_id]
        player.deck_state.hand = []
        player.deck_state.discard_pile = []
        player.deck_state.draw_pile = [
            "hf_martial_1_fail",
            "hf_master_fate_reshuffle",
            "hf_void_fate",
            "hf_martial_1_fail",
        ]

        session.draw_turn()

        payload = session.snapshot()["enemies"][0]
        self.assertEqual(
            payload["current_draw_text"],
            [
                "Martial energy fail",
                "Master energy fate (reshuffle at end turn)",
                "Void fate",
                "Martial energy fail",
            ],
        )
        self.assertEqual(payload["current_draw_summary"]["energies"], {"Martial": 2, "Master": 1})
        self.assertEqual(payload["current_draw_summary"]["outcomes"], {"success": 0, "fate": 2, "fail": 2})
        self.assertEqual(
            payload["power_draw_cards"],
            [
                {"energy_type": "Martial", "energy_amount": 1, "outcome": "fail", "title": "Martial energy fail"},
                {
                    "energy_type": "Master",
                    "energy_amount": 1,
                    "outcome": "fate",
                    "title": "Master energy fate (reshuffle at end turn)",
                },
                {"energy_type": "Void", "energy_amount": 0, "outcome": "fate", "title": "Void fate"},
                {"energy_type": "Martial", "energy_amount": 1, "outcome": "fail", "title": "Martial energy fail"},
            ],
        )
        self.assertTrue(player.pending_reshuffle)

    def test_player_draw_exact_ignores_hand_wounds_and_drawn_wounds_count_as_fails(self) -> None:
        session = self.context.create_session("player-draw-x-wound")
        session.add_player(name="Mira", power=4)
        player = session.state.enemies[session.selected_id]
        player.deck_state.hand = [WOUND_CARD_ID]
        player.deck_state.discard_pile = []
        player.deck_state.draw_pile = [WOUND_CARD_ID, "hf_martial_success_2"]

        session.draw_exact_turn(2)

        # Pre-existing wound in hand stays; drawn wound goes to discard (Draw X rule, not Draw of Power)
        self.assertEqual(player.deck_state.hand, [WOUND_CARD_ID, "hf_martial_success_2"])
        self.assertEqual(player.deck_state.discard_pile, [WOUND_CARD_ID])
        self.assertFalse(player.power_draw_used)
        payload = session.snapshot()["enemies"][0]
        self.assertEqual(payload["current_draw_text"], ["Wound", "Martial 2 energy success"])
        self.assertEqual(payload["current_draw_summary"]["outcomes"], {"success": 1, "fate": 0, "fail": 1})
        self.assertEqual(payload["wound_counts"], {"hand": 1, "discard": 1, "draw_pile": 0, "total": 2})

    def test_player_wounds_persist_in_hand_after_turn_cleanup(self) -> None:
        session = self.context.create_session("player-wound-cleanup")
        session.add_player(name="Mira", power=4)
        player = session.state.enemies[session.selected_id]
        player.deck_state.draw_pile = [WOUND_CARD_ID, "hf_martial_success_2"]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []

        session.draw_exact_turn(2)
        session.next_turn()
        session.start_new_round()

        # Wounds from Draw X go to discard immediately, so they don't persist in hand after cleanup
        self.assertEqual(player.deck_state.hand, [])
        self.assertEqual(player.deck_state.discard_pile, [WOUND_CARD_ID, "hf_martial_success_2"])
        self.assertEqual(session.visible_draw_for(player), [])

    def test_strengthen_allows_overflow_and_draw_bonus_triggers_at_turn_start(self) -> None:
        session = self.context.create_session("strengthen-overflow")
        session.add_player(name="Mira", toughness=4, power=1)
        player = session.state.enemies[session.selected_id]

        # Strengthen below max: no overflow, no draw bonus
        player.toughness_current = 2
        player.draw_bonus_pending = 0
        session.strengthen_pc(2)
        self.assertEqual(player.toughness_current, 4)
        self.assertEqual(player.draw_bonus_pending, 0)

        # Strengthen above max: temporary toughness, no immediate draw bonus
        player.toughness_current = 4
        player.draw_bonus_pending = 0
        session.strengthen_pc(2)
        self.assertEqual(player.toughness_current, 6)
        self.assertEqual(player.draw_bonus_pending, 0)

        # At start of Draw of Power: temporary expires, +1 draw bonus
        player.deck_state.draw_pile = ["hf_martial_success_2", "hf_elemental_success_2a"]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []
        session.draw_turn()
        self.assertEqual(player.toughness_current, 4)
        self.assertEqual(player.draw_bonus_pending, 0)  # consumed by draw
        self.assertEqual(len(player.deck_state.hand), 2)  # base 1 + 1 bonus

    def test_guard_action_adds_guard_and_counts_as_action(self) -> None:
        session = self.context.create_session("guard-action")
        session.add_player(name="Mira")
        player = session.state.enemies[session.selected_id]

        session.guard_pc(3)

        self.assertEqual(player.guard_current, 3)
        self.assertEqual(player.actions_used, 1)
        self.assertIn("Mira guards: +3 guard.", session.combat_log)

    def test_player_hitdraw_after_draw_of_power_draws_to_discard(self) -> None:
        session = self.context.create_session("player-hitdraw")
        session.add_player(name="Mira", power=1)
        player = session.state.enemies[session.selected_id]
        player.deck_state.draw_pile = ["hf_martial_success_2"]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []
        session.active_turn_id = player.instance_id

        with self.assertRaisesRegex(Exception, "Draw of Power"):
            session.hitdraw_pc()

        session.draw_turn()
        player.deck_state.draw_pile = [WOUND_CARD_ID, "hf_martial_fate_1"]
        player.deck_state.discard_pile = ["hf_void_fail"]

        result = session.hitdraw_pc()

        self.assertEqual(player.deck_state.hand, ["hf_martial_success_2"])
        self.assertEqual(player.deck_state.discard_pile, [WOUND_CARD_ID, "hf_martial_fate_1", "hf_void_fail"])
        self.assertEqual(result["hitDraw"]["drawnCardIds"], [WOUND_CARD_ID, "hf_martial_fate_1", "hf_void_fail"])
        self.assertEqual(result["hitDraw"]["drawnText"], ["Fail", "Fate", "Fail"])
        self.assertEqual(
            result["hitDraw"]["drawnCards"],
            [
                {"label": "Fail", "detail": "Wound"},
                {"label": "Fate", "detail": "Martial 1 energy"},
                {"label": "Fail", "detail": "Void"},
            ],
        )
        self.assertEqual(result["hitDraw"]["summary"]["outcomes"], {"success": 0, "fate": 1, "fail": 2})
        self.assertTrue(result["hitDraw"]["reshuffled"])
        self.assertEqual(player.actions_used, 1)
        self.assertEqual(session.visible_draw_for(player), ["hf_martial_success_2"])
        self.assertIn("Mira hits draw: Fail, Fate, Fail (success 0, fate 1, fail 2)", session.combat_log)

    def test_physical_player_hitdraw_is_rejected(self) -> None:
        session = self.context.create_session("physical-hitdraw")
        session.add_player(name="Mira", physical_cards=True)

        with self.assertRaisesRegex(Exception, "Physical-card players"):
            session.hitdraw_pc()

    def test_prepare_bonus_applies_next_turn_and_expires_unused(self) -> None:
        session = self.context.create_session("prepare-expires")
        session.add_player(name="Mira", power=1)
        player = session.state.enemies[session.selected_id]

        session.prepare_pc()

        self.assertEqual(player.draw_bonus_pending, 0)
        self.assertEqual(player.draw_bonus_next_turn, 1)

        session.start_encounter()

        self.assertEqual(player.draw_bonus_pending, 1)
        self.assertEqual(player.draw_bonus_next_turn, 0)

        session.next_turn()

        self.assertEqual(player.draw_bonus_pending, 0)
        self.assertIn("unused draw bonus expires", " ".join(session.combat_log))

    def test_prepare_bonus_is_consumed_by_digital_draw_of_power(self) -> None:
        session = self.context.create_session("prepare-consumed")
        session.add_player(name="Mira", power=1)
        player = session.state.enemies[session.selected_id]
        player.deck_state.draw_pile = ["hf_martial_success_2", "hf_elemental_success_2a"]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []

        session.prepare_pc()
        session.start_encounter()
        session.draw_turn()

        self.assertEqual(player.draw_bonus_pending, 0)
        self.assertEqual(player.draw_bonus_next_turn, 0)
        self.assertEqual(len(player.deck_state.hand), 2)

    def test_physical_player_damage_tracks_wound_total_without_cards(self) -> None:
        session = self.context.create_session("physical-player-wounds")
        session.add_player(name="Mira", toughness=5, armor=0, magic_armor=0, power=1, movement=5, physical_cards=True)
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
        self.assertEqual(player.deck_state.hand, [])
        self.assertEqual(player.physical_wounds, 2)
        self.assertEqual(result["woundEvents"][0]["wounds"], 2)
        payload = session.snapshot()["enemies"][0]
        self.assertTrue(payload["physical_cards"])
        self.assertEqual(payload["wound_counts"], {"hand": 0, "discard": 0, "draw_pile": 0, "total": 2})

    def test_physical_players_do_not_use_digital_draw_or_wound_location_actions(self) -> None:
        session = self.context.create_session("physical-player-actions")
        session.add_player(name="Mira", power=1, physical_cards=True)
        player_id = session.selected_id
        player = session.state.enemies[player_id]

        with self.assertRaisesRegex(ValueError, "outside the app"):
            session.draw_turn()
        with self.assertRaisesRegex(ValueError, "outside the app"):
            session.draw_exact_turn(1)

        session.active_turn_id = player_id
        session.turn_in_progress = True
        player.power_draw_used = True
        with self.assertRaisesRegex(ValueError, "outside the app"):
            session.redraw_turn()

        with self.assertRaisesRegex(ValueError, "wound locations"):
            session.discard_player_wound(player_id)
        with self.assertRaisesRegex(ValueError, "wounds in hand"):
            session.shed_wound()

    def test_physical_wound_adjust_and_mode_conversion(self) -> None:
        session = self.context.create_session("physical-wound-adjust")
        session.add_player(name="Mira", power=1)
        player_id = session.selected_id
        player = session.state.enemies[player_id]
        player.deck_state.hand = [WOUND_CARD_ID]
        player.deck_state.discard_pile = [WOUND_CARD_ID]
        player.deck_state.draw_pile = [WOUND_CARD_ID, "hf_martial_success_2"]

        session.set_player_card_mode(player_id, physical_cards=True)

        self.assertTrue(player.physical_cards)
        self.assertEqual(player.physical_wounds, 3)
        self.assertEqual(player.deck_state.hand, [])
        self.assertEqual(player.deck_state.discard_pile, [])
        self.assertEqual(player.deck_state.draw_pile, ["hf_martial_success_2"])

        session.adjust_physical_wounds(player_id, delta=2)
        session.adjust_physical_wounds(player_id, delta=-1)
        self.assertEqual(player.physical_wounds, 4)

        with self.assertRaisesRegex(ValueError, "negative wounds"):
            session.adjust_physical_wounds(player_id, delta=-5)
        with self.assertRaisesRegex(ValueError, "requires a deck reset confirmation"):
            session.set_player_card_mode(player_id, physical_cards=False)

        session.set_player_card_mode(player_id, physical_cards=False, deck_reset=True)
        self.assertFalse(player.physical_cards)
        self.assertEqual(player.physical_wounds, 0)
        self.assertEqual(player.deck_state.hand, [])
        self.assertEqual(player.deck_state.discard_pile, [])
        self.assertEqual(player.deck_state.draw_pile.count(WOUND_CARD_ID), 4)
        self.assertEqual(session._player_wound_counts(player), {"hand": 0, "discard": 0, "draw_pile": 4, "total": 4})

    def test_physical_player_state_persists(self) -> None:
        session = self.context.create_session("physical-persist")
        session.add_player(name="Mira", power=1, physical_cards=True)
        player = session.state.enemies[session.selected_id]
        player.physical_wounds = 2
        player.draw_bonus_next_turn = 1
        session.autosave()

        loaded = self.context.load_session("physical-persist")
        loaded_player = loaded.state.enemies[player.instance_id]

        self.assertTrue(loaded_player.physical_cards)
        self.assertEqual(loaded_player.physical_wounds, 2)
        self.assertEqual(loaded_player.draw_bonus_next_turn, 1)

    def test_player_wound_actions_discard_remove_and_confirm_deck_removal(self) -> None:
        session = self.context.create_session("player-wound-actions")
        session.add_player(name="Mira", power=4)
        player_id = session.selected_id
        player = session.state.enemies[player_id]
        player.deck_state.hand = [WOUND_CARD_ID, WOUND_CARD_ID]
        player.deck_state.discard_pile = [WOUND_CARD_ID]
        player.deck_state.draw_pile = [WOUND_CARD_ID, "hf_martial_success_2"]

        session.discard_player_wound(player_id)
        self.assertEqual(player.deck_state.hand, [WOUND_CARD_ID])
        self.assertEqual(player.deck_state.discard_pile, [WOUND_CARD_ID, WOUND_CARD_ID])

        session.remove_player_wound(player_id)
        self.assertEqual(player.deck_state.hand, [])
        self.assertEqual(player.deck_state.discard_pile, [WOUND_CARD_ID, WOUND_CARD_ID])
        session.remove_player_wound(player_id)
        session.remove_player_wound(player_id)
        self.assertEqual(player.deck_state.discard_pile, [])

        with self.assertRaisesRegex(ValueError, "requires confirmation"):
            session.remove_player_wound(player_id)
        session.remove_player_wound(player_id, confirm_deck=True)
        self.assertEqual(player.deck_state.draw_pile, ["hf_martial_success_2"])

    def test_player_ko_from_wounds_clears_only_after_all_hand_wounds_leave_hand(self) -> None:
        session = self.context.create_session("player-wound-ko")
        session.add_player(name="Mira", power=1)
        player_id = session.selected_id
        player = session.state.enemies[player_id]
        player.deck_state.hand = [WOUND_CARD_ID, WOUND_CARD_ID]
        player.deck_state.discard_pile = []
        player.deck_state.draw_pile = ["hf_martial_success_2"]

        session.draw_turn()

        self.assertTrue(player.is_ko)
        self.assertTrue(session.is_down(player))
        payload = session.snapshot()["enemies"][0]
        self.assertTrue(payload["is_ko"])
        self.assertTrue(payload["is_down"])

        session.discard_player_wound(player_id)
        self.assertTrue(player.is_ko)
        session.discard_player_wound(player_id)
        self.assertFalse(player.is_ko)
        self.assertFalse(session.is_down(player))

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
                    "template_id": "C_GOBLIN",
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
        action_ids = {
            card.id
            for card in self.context.enemy_templates["C_GOBLIN"].action_deck.cards
        }

        self.assertTrue(all(card_id in action_ids for card_id in all_card_ids))
        self.assertFalse(any(card_id.startswith("basic_") for card_id in all_card_ids))
        self.assertEqual(len(all_card_ids), 20)
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
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
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
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_WOLF")
        second_id = session.selected_id

        session.select(first_id)
        session.next_turn()  # first â†’ second
        session.next_turn()  # second â†’ wraps, pending_new_round = True

        # Add a unit during GM adjustments â€” this changes selected_id
        session.add_enemy_from_template("C_GOBLIN")
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

    def test_default_player_is_level_one_human_fighter_with_deck(self) -> None:
        session = self.context.create_session("player-fighter-default")
        session.add_player(name="Mira")

        player = next(e for e in session.state.enemies.values() if session.is_player(e))
        self.assertEqual(player.toughness_max, 4)
        self.assertEqual(player.armor_max, 1)
        self.assertEqual(player.guard_base, 1)
        self.assertEqual(player.power_base, 4)
        self.assertEqual(player.movement, 6)
        self.assertEqual(player.initiative_modifier, 2)
        self.assertEqual(player.core_deck_id, "human_fighter_lvl1")
        self.assertEqual(len(player.deck_state.draw_pile), 26)

        reloaded = self.context.load_session("player-fighter-default")
        restored = next(e for e in reloaded.state.enemies.values() if reloaded.is_player(e))
        self.assertEqual(restored.core_deck_id, "human_fighter_lvl1")
        self.assertEqual(len(restored.deck_state.draw_pile), 26)

    def test_player_can_use_selected_player_deck(self) -> None:
        session = self.context.create_session("player-wizard-deck")
        session.add_player(name="Merlin", player_deck_id="human_wizzard_lvl1")

        player = next(e for e in session.state.enemies.values() if session.is_player(e))
        self.assertEqual(player.core_deck_id, "human_wizzard_lvl1")
        self.assertIn("hw_class_wizard", player.deck_state.draw_pile)
        self.assertNotIn("hf_class_fighter", player.deck_state.draw_pile)

    def test_player_can_draw_exact_after_draw_of_power_in_one_turn(self) -> None:
        session = self.context.create_session("player-multiple-draw")
        session.add_player(name="Mira")
        player = session.state.enemies[session.selected_id]
        player.deck_state.draw_pile = [
            "hf_martial_success_2",
            "hf_elemental_fail_1a",
            "hf_void_success_1",
            "hf_light_fate_1",
            "hf_martial_fail_1a",
            "hf_elemental_fate_1",
            "hf_void_fail",
            "hf_light_success_2a",
        ]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []

        session.draw_turn()
        session.draw_exact_turn(4)

        self.assertTrue(session.turn_in_progress)
        self.assertEqual(session.active_turn_id, player.instance_id)
        self.assertEqual(len(session.visible_draw_groups_for(player)), 2)
        self.assertEqual(len(session.visible_draw_groups_for(player)[0]), 4)
        self.assertEqual(len(session.visible_draw_groups_for(player)[1]), 4)
        payload = session.snapshot()["enemies"][0]
        self.assertEqual(len(payload["current_draw_groups"]), 2)
        self.assertIn("Martial", payload["current_draw_groups"][0]["items"][0])
        self.assertEqual(payload["current_draw_groups"][0]["summary"]["outcomes"], {"success": 2, "fate": 1, "fail": 1})
        self.assertEqual(payload["current_draw_groups"][0]["summary"]["energies"], {"Martial": 2, "Light": 1, "Elemental": 1})
        self.assertEqual(payload["current_draw_summary"]["outcomes"], {"success": 3, "fate": 2, "fail": 3})
        self.assertEqual(
            payload["current_draw_summary"]["energies"],
            {"Martial": 3, "Elemental": 2, "Light": 3},
        )

    def test_player_race_and_class_cards_draw_into_same_group(self) -> None:
        session = self.context.create_session("player-extra-draws")
        session.add_player(name="Mira", power=2)
        player = session.state.enemies[session.selected_id]
        player.deck_state.draw_pile = [
            "hf_ancestry_human",
            "hf_class_fighter",
            "hf_martial_success_2",
            "hf_void_fail",
            "hf_elemental_success_2a",
        ]
        player.deck_state.discard_pile = []
        player.deck_state.hand = []

        session.draw_turn()

        self.assertEqual(
            player.deck_state.hand,
            [
                "hf_ancestry_human",
                "hf_class_fighter",
                "hf_martial_success_2",
                "hf_void_fail",
                "hf_elemental_success_2a",
            ],
        )
        self.assertEqual(session.visible_draw_groups_for(player), [player.deck_state.hand])
        self.assertTrue(any("Martial may be used as Martial energy" in entry for entry in session.combat_log))
        self.assertIn("+3 draw", next(entry for entry in session.combat_log if "draws:" in entry))

    def test_player_reshuffle_card_reshuffles_deck_discard_and_hand_at_end_turn(self) -> None:
        session = self.context.create_session("player-delayed-reshuffle")
        session.add_player(name="Mira", power=1)
        player = session.state.enemies[session.selected_id]
        player.deck_state.draw_pile = ["hf_master_success_reshuffle", "hf_martial_success_2"]
        player.deck_state.discard_pile = ["hf_void_fail"]
        player.deck_state.hand = []

        session.draw_turn()

        self.assertTrue(player.pending_reshuffle)
        self.assertEqual(player.deck_state.hand, ["hf_master_success_reshuffle"])

        session.next_turn()

        self.assertFalse(player.pending_reshuffle)
        self.assertEqual(player.deck_state.hand, [])
        self.assertEqual(player.deck_state.discard_pile, [])
        self.assertCountEqual(
            player.deck_state.draw_pile,
            ["hf_master_success_reshuffle", "hf_martial_success_2", "hf_void_fail"],
        )
        self.assertEqual(session.visible_draw_groups_for(player), [["hf_master_success_reshuffle"]])

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
        session.add_enemy_from_template("C_GOBLIN")
        low_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")
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
        session.add_enemy_from_template("C_GOBLIN")
        eid = session.selected_id
        entity = session.state.enemies[eid]
        entity.initiative_modifier = 3

        # normal: roll + mod
        session._rng.seed(0)
        session.roll_initiative({eid: "normal"})
        self.assertEqual(entity.initiative_roll, 4)
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
        session.add_enemy_from_template("C_GOBLIN")
        session.start_encounter()

        # encounter is active and not pending_new_round â€” should raise
        with self.assertRaises(BattleSessionError):
            session.roll_initiative({})

    def test_roll_initiative_allowed_before_encounter(self) -> None:
        session = self.context.create_session("init-pre")
        session.add_enemy_from_template("C_GOBLIN")

        session.roll_initiative({})

        self.assertEqual(session.initiative_rolled_round, 1)

    def test_roll_initiative_allowed_during_pending_new_round(self) -> None:
        session = self.context.create_session("init-pending")
        session.add_enemy_from_template("C_GOBLIN")
        first_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")

        session.select(first_id)
        session.next_turn()
        session.next_turn()
        self.assertTrue(session.pending_new_round)

        session.roll_initiative({})
        self.assertEqual(session.initiative_rolled_round, 2)

    def test_surprised_unit_skips_turn_and_status_removed(self) -> None:
        session = self.context.create_session("init-surprised")
        session.add_enemy_from_template("C_GOBLIN")
        surprised_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")

        entity = session.state.enemies[surprised_id]
        session.roll_initiative({surprised_id: "surprised"})
        self.assertIn("surprised", entity.statuses)

        # Start encounter â€” if surprised_id is first, it should be skipped
        # We ensure surprised_id is first in order
        session.order = [surprised_id] + [iid for iid in session.order if iid != surprised_id]
        session.start_encounter()

        # surprised unit should have been skipped (status removed)
        self.assertNotIn("surprised", entity.statuses)
        self.assertNotEqual(session.active_turn_id, surprised_id)

    def test_turn_skip_notice_is_transient(self) -> None:
        session = self.context.create_session("init-transient")
        session.add_enemy_from_template("C_GOBLIN")
        surprised_id = session.selected_id
        session.add_enemy_from_template("C_GOBLIN")

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
        session.add_enemy_from_template("C_GOBLIN")

        self.assertFalse(session.encounter_started)
        session.start_encounter()
        self.assertTrue(session.encounter_started)

        reloaded = self.context.load_session("init-flag")
        self.assertTrue(reloaded.encounter_started)


class WallEdgeDoorTests(unittest.TestCase):
    """Tests for the edge-based wall/door system."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        saves_dir = Path(self.temp_dir.name) / "saves"
        self.context = BattleSessionContext(root=PROJECT_ROOT, saves_dir=saves_dir)

    def _make_dungeon(self, sid: str, cells: list) -> "BattleSession":
        session = self.context.create_session(sid)
        session.edit_dungeon_tiles("void", [[x, y] for x in range(10) for y in range(7)])
        session.edit_dungeon_tiles("floor", cells)
        session.analyze_dungeon()
        return session

    # ------------------------------------------------------------------ rooms

    def test_adjacent_floor_cells_without_edge_are_one_room(self) -> None:
        session = self._make_dungeon("no-wall", [[0, 0], [1, 0]])
        self.assertEqual(len(session.dungeon.rooms), 1)

    def test_wall_edge_splits_adjacent_cells_into_two_rooms(self) -> None:
        session = self._make_dungeon("wall-split", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("wall", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        self.assertEqual(len(session.dungeon.rooms), 2)

    def test_door_edge_splits_rooms_even_when_open(self) -> None:
        session = self._make_dungeon("door-split", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        # even with door_open=False by default, there are two rooms
        self.assertEqual(len(session.dungeon.rooms), 2)
        # manually set door open and re-analyze â€” still two rooms
        session.dungeon.walls["0,0,e"].door_open = True
        session.analyze_dungeon()
        self.assertEqual(len(session.dungeon.rooms), 2)

    def test_door_edge_links_two_different_rooms(self) -> None:
        session = self._make_dungeon("door-link", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        link = session.dungeon.linked_doors.get("0,0,e")
        self.assertIsNotNone(link)
        self.assertEqual(len(link), 2)
        self.assertNotEqual(link[0], link[1])

    def test_door_without_two_rooms_emits_unlinked_issue(self) -> None:
        session = self._make_dungeon("door-unlinked", [[0, 0]])
        # door on east edge but no floor tile to the east
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        issue_types = [i.issue_type for i in session.dungeon.issues]
        self.assertIn("unlinkedDoor", issue_types)

    # ------------------------------------------------------------------ movement

    def test_wall_edge_blocks_orthogonal_movement(self) -> None:
        session = self._make_dungeon("wall-block", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("wall", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        session.add_enemy_from_template("C_GOBLIN")
        mover_id = session.selected_id
        entity = session.state.enemies[mover_id]
        entity.grid_x, entity.grid_y = 0, 0
        entity.movement = 10
        session.active_turn_id = mover_id
        session._reset_movement_state(mover_id)
        with self.assertRaises(Exception):
            session.move_entity_with_movement(mover_id, 1, 0)

    def test_closed_door_blocks_orthogonal_movement(self) -> None:
        session = self._make_dungeon("door-closed-block", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        session.add_enemy_from_template("C_GOBLIN")
        mover_id = session.selected_id
        entity = session.state.enemies[mover_id]
        entity.grid_x, entity.grid_y = 0, 0
        entity.movement = 10
        session.active_turn_id = mover_id
        session._reset_movement_state(mover_id)
        with self.assertRaises(Exception):
            session.move_entity_with_movement(mover_id, 1, 0)

    def test_open_door_allows_orthogonal_movement(self) -> None:
        session = self._make_dungeon("door-open-pass", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        session.dungeon.walls["0,0,e"].door_open = True
        session.add_enemy_from_template("C_GOBLIN")
        mover_id = session.selected_id
        entity = session.state.enemies[mover_id]
        entity.grid_x, entity.grid_y = 0, 0
        entity.movement = 10
        session.active_turn_id = mover_id
        session._reset_movement_state(mover_id)
        session.move_entity_with_movement(mover_id, 1, 0)
        self.assertEqual((entity.grid_x, entity.grid_y), (1, 0))

    def test_diagonal_blocked_by_open_door_edge(self) -> None:
        """Open door on an orthogonal passage blocks diagonal through that corner.

        Door at '0,0,e'. Movement=1 means only a single diagonal step (cost 1) to (1,1)
        is affordable; alternate 2-step routes (0,0)â†’(1,0)â†’(1,1) cost 2 and are out of
        budget. So (1,1) becomes unreachable when that diagonal is blocked.
        """
        session = self._make_dungeon(
            "diag-door-block",
            [[0, 0], [1, 0], [0, 1], [1, 1]],
        )
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        session.dungeon.walls["0,0,e"].door_open = True
        session.add_enemy_from_template("C_GOBLIN")
        mover_id = session.selected_id
        entity = session.state.enemies[mover_id]
        entity.grid_x, entity.grid_y = 0, 0
        entity.movement = 1   # only 1 step budget: diagonal (cost 1) or orthogonal (cost 1)
        session.active_turn_id = mover_id
        session._reset_movement_state(mover_id)
        # diagonal (0,0)â†’(1,1): horizontal leg 0,0,e has open door â†’ _edge_has_any_wall=True â†’ blocked
        # alternate path via (1,0) or (0,1) costs 2 â†’ out of budget (movement=1)
        with self.assertRaises(Exception):
            session.move_entity_with_movement(mover_id, 1, 1)

    def test_diagonal_blocked_by_wall_edge(self) -> None:
        """Wall at '0,0,s' blocks the diagonal (0,0)â†’(1,1); movement=1 keeps alternate routes out of budget."""
        session = self._make_dungeon(
            "diag-wall-block",
            [[0, 0], [1, 0], [0, 1], [1, 1]],
        )
        session.edit_dungeon_walls("wall", [{"x": 0, "y": 0, "side": "s"}])
        session.analyze_dungeon()
        session.add_enemy_from_template("C_GOBLIN")
        mover_id = session.selected_id
        entity = session.state.enemies[mover_id]
        entity.grid_x, entity.grid_y = 0, 0
        entity.movement = 1   # budget too small for 2-step alternate routes
        session.active_turn_id = mover_id
        session._reset_movement_state(mover_id)
        # diagonal (0,0)â†’(1,1): south leg 0,0,s has wall â†’ blocked
        with self.assertRaises(Exception):
            session.move_entity_with_movement(mover_id, 1, 1)

    def test_diagonal_blocked_by_target_corner_wall_edge(self) -> None:
        session = self._make_dungeon("diag-target-wall-block", [[0, 0], [1, 1]])
        session.edit_dungeon_walls("wall", [{"x": 0, "y": 1, "side": "e"}])
        session.analyze_dungeon()
        session.add_enemy_from_template("C_GOBLIN")
        mover_id = session.selected_id
        entity = session.state.enemies[mover_id]
        entity.grid_x, entity.grid_y = 0, 0
        entity.movement = 10
        session.active_turn_id = mover_id
        session._reset_movement_state(mover_id)

        with self.assertRaisesRegex(Exception, "not reachable"):
            session.move_entity_with_movement(mover_id, 1, 1, dash=True)

    # ------------------------------------------------------------------ edit_dungeon_walls

    def test_edit_dungeon_walls_creates_and_erases_edges(self) -> None:
        session = self._make_dungeon("wall-edit", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("wall", [{"x": 0, "y": 0, "side": "e"}])
        self.assertIn("0,0,e", session.dungeon.walls)
        self.assertEqual(session.dungeon.walls["0,0,e"].wall_type, "wall")

        session.edit_dungeon_walls("erase", [{"x": 0, "y": 0, "side": "e"}])
        self.assertNotIn("0,0,e", session.dungeon.walls)

    def test_wall_normalizes_west_side_to_canonical_key(self) -> None:
        session = self._make_dungeon("wall-normalize", [[0, 0], [1, 0]])
        # west edge of (1,0) == east edge of (0,0)
        session.edit_dungeon_walls("wall", [{"x": 1, "y": 0, "side": "w"}])
        self.assertIn("0,0,e", session.dungeon.walls)

    def test_void_tile_edit_removes_orphan_door_but_keeps_wall_with_one_neighbor(self) -> None:
        session = self._make_dungeon("wall-cleanup", [[0, 0], [1, 0], [2, 0]])
        # wall between (0,0) and (1,0); door between (1,0) and (2,0)
        session.edit_dungeon_walls("wall", [{"x": 0, "y": 0, "side": "e"}])
        session.edit_dungeon_walls("door", [{"x": 1, "y": 0, "side": "e"}])
        # remove (1,0) â†’ door at 1,0,e loses both neighbors, wall at 0,0,e keeps (0,0)
        session.edit_dungeon_tiles("void", [[1, 0]])
        self.assertIn("0,0,e", session.dungeon.walls)     # wall kept â€” (0,0) still exists
        self.assertNotIn("1,0,e", session.dungeon.walls)  # door removed â€” (2,0) has no (1,0)

    # ------------------------------------------------------------------ set_door_state

    def test_open_door_reveals_linked_room(self) -> None:
        session = self._make_dungeon("door-reveal", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        session.dungeon.fog_of_war_enabled = True

        session.add_player()
        player_id = session.selected_id
        player = session.state.enemies[player_id]
        player.grid_x, player.grid_y = 0, 0
        player.room_id = next(
            r.room_id for r in session.dungeon.rooms if any(tuple(c) == (0, 0) for c in r.cells)
        )
        session.dungeon.revealed_room_ids = [player.room_id]

        session.set_door_state(0, 0, "e", True)

        self.assertTrue(session.dungeon.walls["0,0,e"].door_open)
        link = session.dungeon.linked_doors["0,0,e"]
        other_room = link[1] if link[0] == player.room_id else link[0]
        self.assertIn(other_room, session.dungeon.revealed_room_ids)

    def test_close_door_does_not_conceal_room(self) -> None:
        session = self._make_dungeon("door-close", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()

        session.add_player()
        player_id = session.selected_id
        player = session.state.enemies[player_id]
        player.grid_x, player.grid_y = 0, 0
        player.room_id = next(
            r.room_id for r in session.dungeon.rooms if any(tuple(c) == (0, 0) for c in r.cells)
        )
        link = session.dungeon.linked_doors["0,0,e"]
        other_room = link[1] if link[0] == player.room_id else link[0]
        session.dungeon.revealed_room_ids = [player.room_id, other_room]
        session.dungeon.walls["0,0,e"].door_open = True

        session.set_door_state(0, 0, "e", False)

        self.assertFalse(session.dungeon.walls["0,0,e"].door_open)
        self.assertIn(other_room, session.dungeon.revealed_room_ids)  # not removed

    def test_set_door_state_rejects_non_adjacent_unit(self) -> None:
        session = self._make_dungeon(
            "door-adj",
            [[0, 0], [1, 0], [2, 0]],
        )
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()

        session.add_player()
        player_id = session.selected_id
        player = session.state.enemies[player_id]
        player.grid_x, player.grid_y = 2, 0
        player.room_id = next(
            r.room_id for r in session.dungeon.rooms if any(tuple(c) == (2, 0) for c in r.cells)
        )

        with self.assertRaises(Exception):
            session.set_door_state(0, 0, "e", True)

    # ------------------------------------------------------------------ persistence

    def test_walls_persist_across_save_and_load(self) -> None:
        session = self._make_dungeon("wall-persist", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("door", [{"x": 0, "y": 0, "side": "e"}])
        session.analyze_dungeon()
        session.autosave()

        reloaded = self.context.load_session("wall-persist")
        self.assertIn("0,0,e", reloaded.dungeon.walls)
        self.assertEqual(reloaded.dungeon.walls["0,0,e"].wall_type, "door")
        self.assertFalse(reloaded.dungeon.walls["0,0,e"].door_open)
        self.assertIn("0,0,e", reloaded.dungeon.linked_doors)

    def test_snapshot_includes_walls(self) -> None:
        session = self._make_dungeon("snap-walls", [[0, 0], [1, 0]])
        session.edit_dungeon_walls("wall", [{"x": 0, "y": 0, "side": "e"}])
        snap = session.snapshot()
        self.assertIn("walls", snap["dungeon"])
        self.assertIn("0,0,e", snap["dungeon"]["walls"])
        self.assertEqual(snap["dungeon"]["walls"]["0,0,e"]["wall_type"], "wall")


if __name__ == "__main__":
    unittest.main()
