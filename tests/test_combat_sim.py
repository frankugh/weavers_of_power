from __future__ import annotations

import unittest

from engine.combat_sim import CombatSimError, runs_for_rerun_fluctuation, simulate_combat_batch, simulate_combat_once
from engine.excel_creatures import parse_creature_action
from engine.models import Card, Deck, Effect, EnemyTemplate, RangeInt


def make_template(
    template_id: str,
    name: str,
    *,
    toughness: int = 10,
    armor: int = 0,
    base_guard: int = 0,
    power: int = 1,
    initiative: int = 0,
    threat_level: int = 1,
    cards: tuple[Card, ...] | None = None,
    skills: dict[str, int] | None = None,
) -> EnemyTemplate:
    action_cards = cards or (
        Card(
            id=f"{template_id}_attack",
            title="Attack 1",
            effects=(Effect(type="attack", amount=1),),
        ),
    )
    return EnemyTemplate(
        id=template_id,
        name=name,
        image=None,
        category="test",
        hp=RangeInt(toughness, toughness),
        armor=RangeInt(armor, armor),
        magicArmor=RangeInt(0, 0),
        baseGuard=RangeInt(base_guard, base_guard),
        draws=power,
        movement=1,
        coreDeck="unused",
        specials=tuple(),
        loot=tuple(),
        initiative_modifier=initiative,
        source="excel",
        action_deck=Deck(id=f"{template_id}_deck", name=f"{name} Deck", cards=action_cards),
        threat_level=threat_level,
        skills=skills if skills is not None else {"alertness": initiative},
    )


def card_index(templates: dict[str, EnemyTemplate]) -> dict[str, Card]:
    cards: dict[str, Card] = {}
    for template in templates.values():
        for card in template.action_deck.cards:
            cards[card.id] = card
    return cards


class CombatSimTests(unittest.TestCase):
    def test_parser_helper_reports_effects_and_coverage(self) -> None:
        parsed = parse_creature_action(
            action_result="A1",
            action_text="Shield Bash - Attack 3 pierce 1, gain 2 guard, draw 1",
        )

        self.assertEqual(parsed["result"], "A1")
        self.assertEqual(parsed["coverageStatus"], "full")
        self.assertEqual(
            [(effect["type"], effect["amount"]) for effect in parsed["effects"]],
            [("attack", 3), ("guard", 2), ("draw", 1)],
        )
        self.assertEqual(parsed["effects"][0]["modifiers"], ["pierce:1"])

    def test_parser_helper_reports_guard_and_armor_attack_modifiers(self) -> None:
        parsed = parse_creature_action(
            action_result="A4",
            action_text="Breaker - Attack 4 overwhelm, sunder 2, shatter",
        )

        self.assertEqual(parsed["coverageStatus"], "full")
        self.assertEqual(parsed["manualNotes"], [])
        self.assertEqual(parsed["effects"][0]["modifiers"], ["sunder:2", "overwhelm", "shatter"])

    def test_single_sim_is_deterministic_for_fixed_seed(self) -> None:
        templates = {
            "attacker": make_template("attacker", "Attacker", initiative=3),
            "target": make_template("target", "Target"),
        }

        first = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "target", "count": 1}],
            seed=42,
            max_rounds=5,
        )
        second = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "target", "count": 1}],
            seed=42,
            max_rounds=5,
        )

        self.assertEqual(first, second)

    def test_stat_overrides_change_spawned_units_without_mutating_template(self) -> None:
        templates = {
            "attacker": make_template("attacker", "Attacker", toughness=10, armor=0, initiative=3),
            "target": make_template("target", "Target"),
        }

        result = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[
                {
                    "templateId": "attacker",
                    "count": 1,
                    "overrides": {"statOverrides": {"toughness": 4, "armor": 2, "draw": 0}},
                }
            ],
            team_b=[{"templateId": "target", "count": 1}],
            seed=42,
            max_rounds=1,
        )

        attacker = next(unit for unit in result["initialUnits"] if unit["templateId"] == "attacker")
        self.assertEqual(attacker["toughnessMax"], 4)
        self.assertEqual(attacker["armorMax"], 2)
        self.assertEqual(attacker["draw"], 0)
        self.assertEqual(templates["attacker"].hp.min, 10)
        self.assertEqual(templates["attacker"].armor.min, 0)

    def test_action_override_is_reparsed_and_used(self) -> None:
        templates = {
            "attacker": make_template(
                "attacker",
                "Attacker",
                initiative=10,
                cards=(
                    Card(
                        id="base_a1",
                        title="Base",
                        effects=(Effect(type="attack", amount=1),),
                        action_text="Base - Attack 1",
                        action_result="A1",
                    ),
                ),
            ),
            "target": make_template("target", "Target", toughness=6, power=0),
        }

        result = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[
                {
                    "templateId": "attacker",
                    "count": 1,
                    "overrides": {"actionOverrides": {"A1": "Heavy Blow - Attack 5"}},
                }
            ],
            team_b=[{"templateId": "target", "count": 1}],
            seed=7,
            max_rounds=1,
        )

        action = result["timeline"][0]["actions"][0]
        self.assertEqual(action["damage"], 5)
        self.assertEqual(action["cardTitle"], "Heavy Blow")
        self.assertEqual(templates["attacker"].action_deck.cards[0].action_text, "Base - Attack 1")

    def test_skill_override_alertness_changes_initiative_without_mutating_template(self) -> None:
        templates = {
            "slow": make_template(
                "slow",
                "Slow",
                initiative=0,
                skills={"alertness": 0, "stealth": 1},
                cards=(Card(id="slow_guard", title="Guard", effects=(Effect(type="guard", amount=1),)),),
            ),
            "fast": make_template(
                "fast",
                "Fast",
                initiative=0,
                skills={"alertness": 0, "stealth": 1},
                cards=(Card(id="fast_guard", title="Guard", effects=(Effect(type="guard", amount=1),)),),
            ),
        }

        result = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[
                {
                    "templateId": "slow",
                    "count": 1,
                    "overrides": {
                        "statOverrides": {"initiativeModifier": 1},
                        "skillOverrides": {"alertness": 20, "stealth": 4},
                    },
                }
            ],
            team_b=[{"templateId": "fast", "count": 1}],
            seed=1,
            max_rounds=1,
        )

        slow = next(unit for unit in result["initialUnits"] if unit["templateId"] == "slow")
        self.assertEqual(result["timeline"][0]["actorName"], "Slow 1")
        self.assertEqual(slow["initiativeModifier"], 20)
        self.assertEqual(templates["slow"].initiative_modifier, 0)
        self.assertEqual(templates["slow"].skills, {"alertness": 0, "stealth": 1})

    def test_invalid_overrides_raise_combat_sim_error(self) -> None:
        templates = {
            "attacker": make_template(
                "attacker",
                "Attacker",
                cards=(
                    Card(
                        id="base_a1",
                        title="Base",
                        effects=(Effect(type="attack", amount=1),),
                        action_text="Base - Attack 1",
                        action_result="A1",
                    ),
                ),
            ),
            "target": make_template("target", "Target"),
        }

        with self.assertRaisesRegex(CombatSimError, "toughness"):
            simulate_combat_once(
                templates=templates,
                decks={},
                card_index=card_index(templates),
                team_a=[{"templateId": "attacker", "count": 1, "overrides": {"statOverrides": {"toughness": 0}}}],
                team_b=[{"templateId": "target", "count": 1}],
                seed=1,
            )

        with self.assertRaisesRegex(CombatSimError, "alertness"):
            simulate_combat_once(
                templates=templates,
                decks={},
                card_index=card_index(templates),
                team_a=[{"templateId": "attacker", "count": 1, "overrides": {"skillOverrides": {"alertness": -1}}}],
                team_b=[{"templateId": "target", "count": 1}],
                seed=1,
            )

        with self.assertRaisesRegex(CombatSimError, "not simulatable"):
            simulate_combat_once(
                templates=templates,
                decks={},
                card_index=card_index(templates),
                team_a=[{"templateId": "attacker", "count": 1, "overrides": {"actionOverrides": {"A1": "Bad - Attack target"}}}],
                team_b=[{"templateId": "target", "count": 1}],
                seed=1,
            )

    def test_coverage_summary_counts_manual_actions_and_logs_when_drawn(self) -> None:
        templates = {
            "manual": make_template(
                "manual",
                "Manual",
                cards=(
                    Card(
                        id="manual_a1",
                        title="Reposition",
                        effects=tuple(),
                        action_text="Reposition - Move target 2",
                        manual_notes=("Move target 2",),
                        action_result="A1",
                    ),
                ),
            ),
            "target": make_template("target", "Target", cards=(Card(id="wait", title="Wait", effects=(Effect(type="guard", amount=1),)),)),
        }

        result = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "manual", "count": 1}],
            team_b=[{"templateId": "target", "count": 1}],
            seed=9,
            max_rounds=1,
        )

        self.assertEqual(result["coverageSummary"]["available"]["manual"], 1)
        self.assertEqual(result["coverageSummary"]["used"]["manual"], 1)
        self.assertTrue(any("Simulation note" in line for line in result["combatLog"]))

    def test_initiative_orders_by_total_then_modifier(self) -> None:
        templates = {
            "slow": make_template("slow", "Slow", initiative=0, cards=(Card(id="slow_guard", title="Guard", effects=(Effect(type="guard", amount=1),)),)),
            "fast": make_template("fast", "Fast", initiative=6, cards=(Card(id="fast_guard", title="Guard", effects=(Effect(type="guard", amount=1),)),)),
        }

        result = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "slow", "count": 1}],
            team_b=[{"templateId": "fast", "count": 1}],
            seed=1,
            max_rounds=1,
        )

        self.assertEqual(result["timeline"][0]["actorName"], "Fast 1")
        self.assertIn("Fast 1 Init", result["combatLog"][0])

    def test_target_strategies_pick_expected_targets(self) -> None:
        templates = {
            "attacker": make_template("attacker", "Attacker", initiative=10, cards=(Card(id="hit", title="Hit", effects=(Effect(type="attack", amount=1),)),)),
            "weak": make_template("weak", "Weak", toughness=4, power=0, threat_level=9),
            "brute": make_template("brute", "Brute", toughness=12, power=0, threat_level=1),
        }

        high_toughness = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "weak", "count": 1}, {"templateId": "brute", "count": 1}],
            strategy_a="highest_toughness",
            seed=3,
            max_rounds=1,
        )
        low_toughness = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "weak", "count": 1}, {"templateId": "brute", "count": 1}],
            strategy_a="lowest_toughness",
            seed=3,
            max_rounds=1,
        )
        high_tl = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "weak", "count": 1}, {"templateId": "brute", "count": 1}],
            strategy_a="highest_tl",
            seed=3,
            max_rounds=1,
        )

        self.assertEqual(high_toughness["timeline"][0]["actions"][0]["targetName"], "Brute 1")
        self.assertEqual(low_toughness["timeline"][0]["actions"][0]["targetName"], "Weak 1")
        self.assertEqual(high_tl["timeline"][0]["actions"][0]["targetName"], "Weak 1")

    def test_priority_strategy_commits_to_equal_priority_target_until_down(self) -> None:
        templates = {
            "attacker": make_template(
                "attacker",
                "Attacker",
                power=2,
                initiative=10,
                cards=(Card(id="hit", title="Hit", effects=(Effect(type="attack", amount=1),), weight=2),),
            ),
            "twin": make_template("twin", "Twin", toughness=10, power=0),
        }

        result = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "twin", "count": 2}],
            strategy_a="highest_toughness",
            seed=11,
            max_rounds=1,
        )

        targets = [action["targetName"] for action in result["timeline"][0]["actions"]]
        self.assertEqual(targets, ["Twin 1", "Twin 1"])

    def test_guard_draw_and_attack_effects_are_resolved(self) -> None:
        templates = {
            "attacker": make_template(
                "attacker",
                "Attacker",
                initiative=10,
                cards=(
                    Card(id="draw_guard", title="Draw Guard", effects=(Effect(type="guard", amount=2), Effect(type="draw", amount=1))),
                    Card(id="strike", title="Strike", effects=(Effect(type="attack", amount=3),)),
                ),
            ),
            "target": make_template("target", "Target", toughness=10, armor=1, power=0),
        }

        result = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "target", "count": 1}],
            seed=0,
            max_rounds=1,
        )

        self.assertEqual(result["attackActions"], 1)
        self.assertEqual(result["teamTotals"]["A"]["damageDealt"], 2)
        self.assertEqual(result["teamTotals"]["B"]["damagePrevented"], 1)
        attacker = next(unit for unit in result["finalUnits"] if unit["templateId"] == "attacker")
        self.assertEqual(attacker["guardCurrent"], 2)
        self.assertIn("+1 draw", result["timeline"][0]["log"][1])

    def test_batch_uses_incrementing_seeds_and_keeps_last_combat(self) -> None:
        templates = {
            "attacker": make_template("attacker", "Attacker", initiative=3),
            "target": make_template("target", "Target"),
        }

        result = simulate_combat_batch(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "target", "count": 1}],
            seed=100,
            runs=3,
            max_rounds=2,
        )

        self.assertEqual(result["runs"], 3)
        self.assertEqual(result["lastCombat"]["seed"], 102)
        self.assertEqual(sum(result["summary"]["wins"].values()), 3)

    def test_batch_precision_target_caps_run_count_and_reports_stats(self) -> None:
        templates = {
            "attacker": make_template("attacker", "Attacker", initiative=3),
            "target": make_template("target", "Target"),
        }

        result = simulate_combat_batch(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "target", "count": 1}],
            seed=100,
            runs=10,
            precision_target=0.50,
            max_rounds=2,
        )

        self.assertEqual(result["runs"], runs_for_rerun_fluctuation(0.50))
        self.assertLessEqual(result["runs"], 10)
        precision = result["summary"]["precision"]
        self.assertEqual(precision["verdict"], "Target met")
        self.assertIn("A", precision["outcomes"])
        self.assertIn("ciLow", precision["outcomes"]["A"])
        self.assertIn("std", precision["outcomes"]["A"])

    def test_batch_precision_needed_varies_by_observed_outcome_stability(self) -> None:
        templates = {
            "attacker": make_template(
                "attacker",
                "Attacker",
                initiative=10,
                cards=(Card(id="heavy", title="Heavy", effects=(Effect(type="attack", amount=20),)),),
            ),
            "target": make_template("target", "Target", toughness=1, power=0),
        }

        result = simulate_combat_batch(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "attacker", "count": 1}],
            team_b=[{"templateId": "target", "count": 1}],
            seed=100,
            runs=500,
            precision_target=0.10,
            max_rounds=2,
        )

        precision = result["summary"]["precision"]
        self.assertLess(precision["observedRequiredRunsForTarget"], precision["worstCaseRequiredRunsForTarget"])
        self.assertLess(result["runs"], precision["worstCaseRequiredRunsForTarget"])
        self.assertEqual(precision["verdict"], "Target met")

    def test_batch_counts_draw_results(self) -> None:
        templates = {
            "left": make_template("left", "Left", cards=(Card(id="left_guard", title="Guard", effects=(Effect(type="guard", amount=1),)),)),
            "right": make_template("right", "Right", cards=(Card(id="right_guard", title="Guard", effects=(Effect(type="guard", amount=1),)),)),
        }

        result = simulate_combat_batch(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "left", "count": 1}],
            team_b=[{"templateId": "right", "count": 1}],
            seed=5,
            runs=5,
            max_rounds=2,
        )

        self.assertEqual(result["summary"]["wins"]["draw"], 5)
        self.assertEqual(result["summary"]["winRates"]["draw"], 1.0)

    def test_max_rounds_returns_draw(self) -> None:
        templates = {
            "left": make_template("left", "Left", cards=(Card(id="left_guard", title="Guard", effects=(Effect(type="guard", amount=1),)),)),
            "right": make_template("right", "Right", cards=(Card(id="right_guard", title="Guard", effects=(Effect(type="guard", amount=1),)),)),
        }

        result = simulate_combat_once(
            templates=templates,
            decks={},
            card_index=card_index(templates),
            team_a=[{"templateId": "left", "count": 1}],
            team_b=[{"templateId": "right", "count": 1}],
            seed=5,
            max_rounds=2,
        )

        self.assertEqual(result["winner"], "draw")
        self.assertEqual(result["rounds"], 2)


if __name__ == "__main__":
    unittest.main()
