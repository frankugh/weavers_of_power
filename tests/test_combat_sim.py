from __future__ import annotations

import unittest

from engine.combat_sim import runs_for_rerun_fluctuation, simulate_combat_batch, simulate_combat_once
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
    )


def card_index(templates: dict[str, EnemyTemplate]) -> dict[str, Card]:
    cards: dict[str, Card] = {}
    for template in templates.values():
        for card in template.action_deck.cards:
            cards[card.id] = card
    return cards


class CombatSimTests(unittest.TestCase):
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
