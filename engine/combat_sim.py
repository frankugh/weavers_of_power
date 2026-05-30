from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field, replace
import math
import random
from typing import Callable, Iterable, Optional

from engine.combat import AttackMod, CombatLog, apply_attack, apply_heal
from engine.excel_creatures import (
    SIM_COVERAGE_ERROR,
    SIM_COVERAGE_FULL,
    SIM_COVERAGE_MANUAL,
    SIM_COVERAGE_WARNING,
    action_card_coverage,
    build_creature_action_card,
)
from engine.models import Card, Deck, EnemyTemplate, RangeInt
from engine.runtime import draw_additional_cards, draw_cards, spawn_enemy, start_turn, end_turn
from engine.runtime_models import EnemyInstance

DEFAULT_TARGET_STRATEGY = "highest_toughness"
TARGET_STRATEGIES = {
    "highest_toughness",
    "lowest_toughness",
    "highest_tl",
    "random_focus",
    "full_random",
}
MAX_BATCH_RUNS = 1000
DEFAULT_BATCH_RUNS = 100
DEFAULT_MAX_ROUNDS = 100
MIN_PRECISION_RUNS = 30
Z_95 = 1.959963984540054


class CombatSimError(ValueError):
    pass


@dataclass(frozen=True)
class TeamEntry:
    template_id: str
    count: int = 1
    stat_overrides: dict[str, int] = field(default_factory=dict)
    skill_overrides: dict[str, int] = field(default_factory=dict)
    action_overrides: dict[str, str] = field(default_factory=dict)


@dataclass
class SimUnit:
    entity: EnemyInstance
    team: str
    template: EnemyTemplate
    order_index: int


@dataclass
class SimState:
    units: list[SimUnit]
    order: list[SimUnit]
    card_index: dict[str, Card]
    rng: random.Random
    strategy_by_team: dict[str, str]
    focus_by_team: dict[str, Optional[str]] = field(default_factory=lambda: {"A": None, "B": None})
    team_totals: dict[str, dict] = field(default_factory=dict)
    log: list[str] = field(default_factory=list)
    timeline: list[dict] = field(default_factory=list)
    used_card_ids: set[str] = field(default_factory=set)
    turns: int = 0
    attack_actions: int = 0


def simulate_combat_once(
    *,
    templates: dict[str, EnemyTemplate],
    decks: dict[str, Deck],
    card_index: dict[str, Card],
    team_a: Iterable[dict | TeamEntry],
    team_b: Iterable[dict | TeamEntry],
    strategy_a: str = DEFAULT_TARGET_STRATEGY,
    strategy_b: str = DEFAULT_TARGET_STRATEGY,
    seed: int,
    max_rounds: int = DEFAULT_MAX_ROUNDS,
    image_url_for: Optional[Callable[[EnemyTemplate], str]] = None,
) -> dict:
    rng = random.Random(int(seed))
    entries_a = _normalize_team(team_a, label="teamA")
    entries_b = _normalize_team(team_b, label="teamB")
    _validate_strategy(strategy_a)
    _validate_strategy(strategy_b)
    if max_rounds <= 0:
        raise CombatSimError("maxRounds must be > 0")

    sim_card_index = dict(card_index)
    units = _spawn_units(templates, decks, entries_a, entries_b, rng=rng, card_index=sim_card_index)
    if not units:
        raise CombatSimError("At least one unit is required")

    order = _roll_initiative(units, rng=rng)
    state = SimState(
        units=units,
        order=order,
        card_index=sim_card_index,
        rng=rng,
        strategy_by_team={"A": strategy_a, "B": strategy_b},
        team_totals={
            "A": _empty_team_totals(),
            "B": _empty_team_totals(),
        },
    )

    state.log.append("Initiative: " + ", ".join(_initiative_label(unit.entity) for unit in order))
    initial_units = _serialize_units(units, card_index=sim_card_index, image_url_for=image_url_for)

    winner = _winner(units)
    round_number = 0
    while winner is None and round_number < max_rounds:
        round_number += 1
        state.log.append(f"Round {round_number} begins")
        for unit in order:
            if _winner(units) is not None:
                break
            if _is_down(unit.entity):
                continue
            _run_unit_turn(state, unit, round_number, image_url_for=image_url_for)
        winner = _winner(units)

    if winner is None:
        winner = "draw"
        state.log.append(f"Max rounds reached ({max_rounds}); combat ends in a draw.")
    elif winner == "draw":
        state.log.append(f"Both teams are down in round {round_number}; combat ends in a draw.")
    else:
        state.log.append(f"Team {winner} wins in round {round_number}.")

    final_units = _serialize_units(units, card_index=sim_card_index, image_url_for=image_url_for)
    _finalize_team_totals(state, units)

    return {
        "seed": int(seed),
        "winner": winner,
        "rounds": round_number,
        "turns": state.turns,
        "attackActions": state.attack_actions,
        "initialUnits": initial_units,
        "finalUnits": final_units,
        "timeline": state.timeline,
        "combatLog": list(state.log),
        "teamTotals": state.team_totals,
        "coverageSummary": _coverage_summary(units, sim_card_index, state.used_card_ids),
    }


def simulate_combat_batch(
    *,
    templates: dict[str, EnemyTemplate],
    decks: dict[str, Deck],
    card_index: dict[str, Card],
    team_a: Iterable[dict | TeamEntry],
    team_b: Iterable[dict | TeamEntry],
    strategy_a: str = DEFAULT_TARGET_STRATEGY,
    strategy_b: str = DEFAULT_TARGET_STRATEGY,
    seed: int,
    runs: int = DEFAULT_BATCH_RUNS,
    precision_target: float | None = None,
    max_rounds: int = DEFAULT_MAX_ROUNDS,
    image_url_for: Optional[Callable[[EnemyTemplate], str]] = None,
) -> dict:
    if runs < 1 or runs > MAX_BATCH_RUNS:
        raise CombatSimError(f"runs must be between 1 and {MAX_BATCH_RUNS}")
    run_cap = runs
    worst_case_required_runs = None
    if precision_target is not None:
        if precision_target <= 0:
            raise CombatSimError("precision target must be > 0")
        worst_case_required_runs = runs_for_rerun_fluctuation(precision_target)
        run_limit = min(run_cap, worst_case_required_runs)
    else:
        run_limit = run_cap

    results: list[dict] = []
    wins = {"A": 0, "B": 0, "draw": 0}
    sums = defaultdict(float)
    metric_values = {
        "rounds": [],
        "turns": [],
        "attackActions": [],
    }
    team_sums = {
        "A": defaultdict(float),
        "B": defaultdict(float),
    }
    winner_remaining_total = 0.0
    winner_remaining_count = 0
    observed_required_runs = None

    for run_index in range(run_limit):
        run_seed = int(seed) + run_index
        result = simulate_combat_once(
            templates=templates,
            decks=decks,
            card_index=card_index,
            team_a=team_a,
            team_b=team_b,
            strategy_a=strategy_a,
            strategy_b=strategy_b,
            seed=run_seed,
            max_rounds=max_rounds,
            image_url_for=image_url_for,
        )
        results.append(result)
        winner = result["winner"]
        wins[winner] = wins.get(winner, 0) + 1
        sums["rounds"] += result["rounds"]
        sums["turns"] += result["turns"]
        sums["attackActions"] += result["attackActions"]
        metric_values["rounds"].append(result["rounds"])
        metric_values["turns"].append(result["turns"])
        metric_values["attackActions"].append(result["attackActions"])
        for team in ("A", "B"):
            totals = result["teamTotals"][team]
            team_sums[team]["damageDealt"] += totals["damageDealt"]
            team_sums[team]["damagePrevented"] += totals["damagePrevented"]
            team_sums[team]["unitsLost"] += totals["unitsLost"]
            team_sums[team]["remainingToughness"] += totals["remainingToughness"]
        if winner in ("A", "B"):
            winner_remaining_total += result["teamTotals"][winner]["remainingToughness"]
            winner_remaining_count += 1
        completed_runs = run_index + 1
        if precision_target is not None and completed_runs >= min(MIN_PRECISION_RUNS, run_limit):
            observed_required_runs = runs_for_observed_rerun_fluctuation(
                wins=wins,
                runs=completed_runs,
                target=precision_target,
            )
            if completed_runs >= observed_required_runs:
                break

    runs_completed = len(results)
    if precision_target is not None:
        observed_required_runs = runs_for_observed_rerun_fluctuation(
            wins=wins,
            runs=runs_completed,
            target=precision_target,
        )

    return {
        "seed": int(seed),
        "runs": runs_completed,
        "runCap": run_cap,
        "requiredRunsForTarget": observed_required_runs,
        "worstCaseRequiredRunsForTarget": worst_case_required_runs,
        "summary": {
            "wins": wins,
            "winRates": {key: _ratio(value, runs_completed) for key, value in wins.items()},
            "avgRounds": _ratio(sums["rounds"], runs_completed),
            "avgTurns": _ratio(sums["turns"], runs_completed),
            "avgAttackActions": _ratio(sums["attackActions"], runs_completed),
            "metricStats": {key: _metric_stats(values) for key, values in metric_values.items()},
            "avgWinnerRemainingToughness": (
                _ratio(winner_remaining_total, winner_remaining_count) if winner_remaining_count else None
            ),
            "teamAverages": {
                team: {
                    "damageDealt": _ratio(values["damageDealt"], runs_completed),
                    "damagePrevented": _ratio(values["damagePrevented"], runs_completed),
                    "unitsLost": _ratio(values["unitsLost"], runs_completed),
                    "remainingToughness": _ratio(values["remainingToughness"], runs_completed),
                }
                for team, values in team_sums.items()
            },
            "precision": _precision_summary(
                wins=wins,
                runs=runs_completed,
                run_cap=run_cap,
                required_runs=observed_required_runs,
                worst_case_required_runs=worst_case_required_runs,
                precision_target=precision_target,
            ),
        },
        "lastCombat": results[-1],
    }


def runs_for_rerun_fluctuation(target: float) -> int:
    """
    Conservative run count for a 95% rerun-to-rerun winrate fluctuation target.

    target is a fraction, so 0.05 means +/- 5 percentage points.
    The worst case for a Bernoulli winrate is p=0.5.
    """
    if target <= 0:
        raise CombatSimError("precision target must be > 0")
    return max(1, math.ceil((Z_95 * Z_95 * 0.5) / (target * target)))


def runs_for_observed_rerun_fluctuation(*, wins: dict[str, int], runs: int, target: float) -> int:
    """
    Wilson-adjusted observed run count for a 95% rerun-to-rerun fluctuation target.

    This varies by matchup, but avoids treating tiny all-win samples as perfectly stable.
    """
    if target <= 0:
        raise CombatSimError("precision target must be > 0")
    if runs <= 0:
        return 1
    max_variance = max(
        _max_bernoulli_variance_in_interval(*_wilson_interval(count, runs))
        for count in wins.values()
    )
    return max(1, math.ceil((Z_95 * Z_95 * 2 * max_variance) / (target * target)))


def _normalize_team(entries: Iterable[dict | TeamEntry], *, label: str) -> list[TeamEntry]:
    normalized: list[TeamEntry] = []
    for raw in entries or []:
        if isinstance(raw, TeamEntry):
            entry = raw
        else:
            overrides = raw.get("overrides") or {}
            entry = TeamEntry(
                template_id=str(raw.get("templateId") or raw.get("template_id") or "").strip(),
                count=int(raw.get("count", 1)),
                stat_overrides=_normalize_stat_overrides(
                    overrides.get("statOverrides") or raw.get("statOverrides") or {},
                    label=label,
                ),
                skill_overrides=_normalize_skill_overrides(
                    overrides.get("skillOverrides") or raw.get("skillOverrides") or {},
                    label=label,
                ),
                action_overrides=_normalize_action_overrides(
                    overrides.get("actionOverrides") or raw.get("actionOverrides") or {},
                    label=label,
                ),
            )
        if not entry.template_id:
            raise CombatSimError(f"{label}: templateId is required")
        if entry.count <= 0:
            raise CombatSimError(f"{label}: count must be > 0")
        if entry.count > 20:
            raise CombatSimError(f"{label}: count must be <= 20")
        normalized.append(entry)
    if not normalized:
        raise CombatSimError(f"{label} must contain at least one creature")
    return normalized


STAT_OVERRIDE_MINIMUMS = {
    "toughness": 1,
    "armor": 0,
    "magicArmor": 0,
    "baseGuard": 0,
    "power": 0,
    "movement": 0,
    "initiativeModifier": 0,
    "threatLevel": 0,
}

SKILL_OVERRIDE_MINIMUMS = {
    "intelligence": 0,
    "alertness": 0,
    "stealth": 0,
    "social": 0,
    "arcana": 0,
    "athletics": 0,
}


def _normalize_stat_overrides(raw: object, *, label: str) -> dict[str, int]:
    if not raw:
        return {}
    if not isinstance(raw, dict):
        raise CombatSimError(f"{label}: statOverrides must be an object")
    result: dict[str, int] = {}
    for key, value in raw.items():
        if value is None or value == "":
            continue
        if key not in STAT_OVERRIDE_MINIMUMS:
            raise CombatSimError(f"{label}: unknown stat override '{key}'")
        try:
            number = int(value)
        except (TypeError, ValueError) as exc:
            raise CombatSimError(f"{label}: {key} override must be an integer") from exc
        minimum = STAT_OVERRIDE_MINIMUMS[key]
        if number < minimum:
            raise CombatSimError(f"{label}: {key} override must be >= {minimum}")
        result[key] = number
    return result


def _normalize_skill_overrides(raw: object, *, label: str) -> dict[str, int]:
    if not raw:
        return {}
    if not isinstance(raw, dict):
        raise CombatSimError(f"{label}: skillOverrides must be an object")
    result: dict[str, int] = {}
    for key, value in raw.items():
        if value is None or value == "":
            continue
        if key not in SKILL_OVERRIDE_MINIMUMS:
            raise CombatSimError(f"{label}: unknown skill override '{key}'")
        try:
            number = int(value)
        except (TypeError, ValueError) as exc:
            raise CombatSimError(f"{label}: {key} skill override must be an integer") from exc
        minimum = SKILL_OVERRIDE_MINIMUMS[key]
        if number < minimum:
            raise CombatSimError(f"{label}: {key} skill override must be >= {minimum}")
        result[key] = number
    return result


def _normalize_action_overrides(raw: object, *, label: str) -> dict[str, str]:
    if not raw:
        return {}
    result: dict[str, str] = {}
    if isinstance(raw, dict):
        iterable = raw.items()
    elif isinstance(raw, list):
        iterable = []
        pairs: list[tuple[str, object]] = []
        for item in raw:
            if not isinstance(item, dict):
                raise CombatSimError(f"{label}: actionOverrides items must be objects")
            pairs.append((str(item.get("result") or item.get("actionResult") or ""), item.get("text") or item.get("actionText") or ""))
        iterable = pairs
    else:
        raise CombatSimError(f"{label}: actionOverrides must be an object or list")
    for raw_result, raw_text in iterable:
        result_key = str(raw_result or "").strip().upper()
        text = str(raw_text or "").strip()
        if not result_key:
            raise CombatSimError(f"{label}: action override result is required")
        if not text:
            raise CombatSimError(f"{label}: {result_key} action override text is required")
        result[result_key] = text
    return result


def _validate_strategy(strategy: str) -> None:
    if strategy not in TARGET_STRATEGIES:
        raise CombatSimError(f"Unknown target strategy '{strategy}'")


def _spawn_units(
    templates: dict[str, EnemyTemplate],
    decks: dict[str, Deck],
    entries_a: list[TeamEntry],
    entries_b: list[TeamEntry],
    *,
    rng: random.Random,
    card_index: dict[str, Card],
) -> list[SimUnit]:
    units: list[SimUnit] = []
    template_counts: dict[tuple[str, str], int] = defaultdict(int)

    for team, entries in (("A", entries_a), ("B", entries_b)):
        for entry_index, entry in enumerate(entries):
            template = templates.get(entry.template_id)
            if template is None:
                raise CombatSimError(f"Unknown template '{entry.template_id}'")
            if not getattr(template, "spawnable", True):
                raise CombatSimError(f"Template '{template.name}' is not spawnable")
            template = _effective_template_for_entry(
                template,
                entry,
                entry_key=f"{team}_{entry_index}_{entry.template_id}",
                card_index=card_index,
            )
            for _ in range(entry.count):
                template_counts[(team, template.id)] += 1
                copy_index = template_counts[(team, template.id)]
                entity = spawn_enemy(template, decks, rnd=rng)
                entity.instance_id = f"{team}-{len(units) + 1}"
                entity.name = f"{template.name} {copy_index}"
                units.append(SimUnit(entity=entity, team=team, template=template, order_index=len(units)))
    return units


def _effective_template_for_entry(
    template: EnemyTemplate,
    entry: TeamEntry,
    *,
    entry_key: str,
    card_index: dict[str, Card],
) -> EnemyTemplate:
    if entry.stat_overrides:
        template = _apply_stat_overrides(template, entry.stat_overrides)
    if entry.skill_overrides:
        template = _apply_skill_overrides(template, entry.skill_overrides)
    if entry.action_overrides:
        template = _apply_action_overrides(template, entry.action_overrides, entry_key=entry_key, card_index=card_index)
    if template.action_deck:
        for card in template.action_deck.cards:
            card_index[card.id] = card
    return template


def _apply_stat_overrides(template: EnemyTemplate, overrides: dict[str, int]) -> EnemyTemplate:
    changes = {}
    if "toughness" in overrides:
        changes["hp"] = RangeInt(overrides["toughness"], overrides["toughness"])
    if "armor" in overrides:
        changes["armor"] = RangeInt(overrides["armor"], overrides["armor"])
    if "magicArmor" in overrides:
        changes["magicArmor"] = RangeInt(overrides["magicArmor"], overrides["magicArmor"])
    if "baseGuard" in overrides:
        changes["baseGuard"] = RangeInt(overrides["baseGuard"], overrides["baseGuard"])
    if "power" in overrides:
        changes["draws"] = overrides["power"]
    if "movement" in overrides:
        changes["movement"] = overrides["movement"]
    if "initiativeModifier" in overrides:
        changes["initiative_modifier"] = overrides["initiativeModifier"]
    if "threatLevel" in overrides:
        changes["threat_level"] = overrides["threatLevel"]
    return replace(template, **changes) if changes else template


def _apply_skill_overrides(template: EnemyTemplate, overrides: dict[str, int]) -> EnemyTemplate:
    skills = dict(getattr(template, "skills", {}) or {})
    skills.update(overrides)
    changes = {"skills": skills}
    if "alertness" in overrides:
        changes["initiative_modifier"] = overrides["alertness"]
    return replace(template, **changes)


def _apply_action_overrides(
    template: EnemyTemplate,
    overrides: dict[str, str],
    *,
    entry_key: str,
    card_index: dict[str, Card],
) -> EnemyTemplate:
    if template.action_deck is None:
        raise CombatSimError(f"Template '{template.name}' has no action deck")
    cards_by_result = {
        str(card.action_result or "").upper(): card
        for card in template.action_deck.cards
        if card.action_result
    }
    unknown_results = sorted(set(overrides) - set(cards_by_result))
    if unknown_results:
        raise CombatSimError(f"Template '{template.name}' has no action result '{unknown_results[0]}'")

    cards: list[Card] = []
    for card in template.action_deck.cards:
        result = str(card.action_result or "").upper()
        if result in overrides:
            override_card = build_creature_action_card(
                creature_id=template.id,
                action_result=result,
                action_text=overrides[result],
                card_id=f"{template.id}__sim_{entry_key}__{result}",
                weight=card.weight,
                reshuffle=card.reshuffle,
            )
            coverage = action_card_coverage(override_card)
            if coverage["status"] == SIM_COVERAGE_ERROR:
                raise CombatSimError(f"Template '{template.name}' {result} override is not simulatable")
            cards.append(override_card)
            card_index[override_card.id] = override_card
        else:
            cards.append(card)
            card_index[card.id] = card

    deck = replace(
        template.action_deck,
        id=f"{template.action_deck.id}__sim_{entry_key}",
        cards=tuple(cards),
    )
    return replace(template, action_deck=deck)


def _roll_initiative(units: list[SimUnit], *, rng: random.Random) -> list[SimUnit]:
    for unit in units:
        roll = rng.randint(1, 6)
        modifier = int(getattr(unit.entity, "initiative_modifier", 0))
        unit.entity.initiative_roll = roll
        unit.entity.initiative_total = roll + modifier
        unit.entity.initiative_mode = "normal"
    return sorted(
        units,
        key=lambda unit: (
            -(unit.entity.initiative_total or 0),
            -int(getattr(unit.entity, "initiative_modifier", 0)),
            unit.order_index,
        ),
    )


def _run_unit_turn(
    state: SimState,
    unit: SimUnit,
    round_number: int,
    *,
    image_url_for: Optional[Callable[[EnemyTemplate], str]],
) -> None:
    entity = unit.entity
    state.turns += 1
    turn_number = state.turns
    before = _serialize_units(state.units, card_index=state.card_index, image_url_for=image_url_for)
    lines: list[str] = [f"Round {round_number}, Turn {turn_number}: {entity.name}"]
    actions: list[dict] = []

    start_log = start_turn(entity)
    if start_log.dot_damage:
        lines.append(f"{entity.name} takes {start_log.dot_damage} DOT.")
    if _is_down(entity):
        lines.append(f"{entity.name} is down before drawing.")
        end_turn(entity)
        state.log.extend(lines)
        state.timeline.append(_turn_payload(round_number, turn_number, unit, before, state, lines, actions, image_url_for))
        return

    draw_count = _draw_count_for(entity)
    draw_result = draw_cards(entity, draw_count, rnd=state.rng)
    draw_resolution = _resolve_draw_effects(state, entity, draw_result.drawn)
    state.used_card_ids.update(draw_resolution["cardIds"])
    drawn_text = [_card_text(state.card_index, card_id) for card_id in draw_resolution["cardIds"]]
    if drawn_text:
        suffix_parts = []
        if draw_resolution["guardAdded"]:
            suffix_parts.append(f"+{draw_resolution['guardAdded']} guard")
        if draw_resolution["extraDrawn"]:
            suffix_parts.append(f"+{draw_resolution['extraDrawn']} draw")
        suffix = f" ({', '.join(suffix_parts)})" if suffix_parts else ""
        lines.append(f"{entity.name} draws: {', '.join(drawn_text)}{suffix}.")
    else:
        lines.append(f"{entity.name} draws no cards.")
    lines.extend(_draw_coverage_notes(entity.name, draw_resolution["cardIds"], state.card_index))

    for card_id in list(entity.deck_state.hand):
        card = state.card_index.get(card_id)
        if not card:
            continue
        for effect in card.effects:
            if effect.type == "attack":
                target_unit = _choose_target(state, unit)
                if target_unit is None:
                    continue
                action = _apply_attack_effect(state, unit, target_unit, card, effect)
                actions.append(action)
                lines.extend(action["log"])
            elif effect.type in {"guard", "draw"}:
                continue
            else:
                text = _effect_label(effect)
                actions.append({"type": "ignored", "card": card.title or card.id, "effect": text})
                lines.append(f"{entity.name} ignores {text} for simulation.")

    end_turn(entity)
    if getattr(entity, "pending_reshuffle", False):
        _reshuffle_enemy_deck_at_end(entity, state.rng)
        lines.append(f"{entity.name} reshuffles their deck.")

    state.log.extend(lines)
    state.timeline.append(_turn_payload(round_number, turn_number, unit, before, state, lines, actions, image_url_for))


def _turn_payload(
    round_number: int,
    turn_number: int,
    unit: SimUnit,
    before: list[dict],
    state: SimState,
    lines: list[str],
    actions: list[dict],
    image_url_for: Optional[Callable[[EnemyTemplate], str]],
) -> dict:
    return {
        "round": round_number,
        "turn": turn_number,
        "actorId": unit.entity.instance_id,
        "actorName": unit.entity.name,
        "team": unit.team,
        "beforeUnits": before,
        "units": _serialize_units(state.units, card_index=state.card_index, image_url_for=image_url_for),
        "draw": [_card_text(state.card_index, card_id) for card_id in unit.entity.deck_state.hand],
        "actions": actions,
        "log": list(lines),
    }


def _draw_count_for(entity: EnemyInstance) -> int:
    draws = int(getattr(entity, "power_base", 0))
    if "paralyzed" in getattr(entity, "statuses", {}):
        draws -= 1
    return max(0, draws)


def _resolve_draw_effects(state: SimState, entity: EnemyInstance, card_ids: list[str]) -> dict:
    resolved = list(card_ids)
    pending = list(card_ids)
    guard_added = 0
    extra_drawn = 0

    while pending:
        card_id = pending.pop(0)
        card = state.card_index.get(card_id)
        if not card:
            continue
        if card.reshuffle:
            entity.pending_reshuffle = True
        for effect in card.effects:
            if effect.type == "guard":
                apply_heal(entity, guard=int(effect.amount))
                guard_added += int(effect.amount)
            elif effect.type == "draw":
                result = draw_additional_cards(entity, max(0, int(effect.amount)), rnd=state.rng)
                if result.drawn:
                    resolved.extend(result.drawn)
                    pending.extend(result.drawn)
                    extra_drawn += len(result.drawn)

    return {"cardIds": resolved, "guardAdded": guard_added, "extraDrawn": extra_drawn}


def _apply_attack_effect(state: SimState, attacker: SimUnit, target: SimUnit, card: Card, effect) -> dict:
    modifiers = _normalize_modifiers(effect.modifiers)
    before_toughness = target.entity.toughness_current
    log: CombatLog = apply_attack(target.entity, int(effect.amount), mods=modifiers)
    state.attack_actions += 1
    state.team_totals[attacker.team]["damageDealt"] += log.damage_to_hp
    state.team_totals[target.team]["damagePrevented"] += log.guarded_total
    label = _attack_label(effect.amount, modifiers)
    lines = [
        f"{attacker.entity.name} targets {target.entity.name} with {label}.",
        (
            f"{target.entity.name}: {log.input_damage} in, {log.damage_to_hp} to Toughness, "
            f"T {before_toughness}->{target.entity.toughness_current}, "
            f"G {log.guard_before}->{log.guard_after}, AR {log.armor_before}->{log.armor_after}."
        ),
    ]
    if log.applied_statuses:
        lines.append(f"{target.entity.name} gains {', '.join(log.applied_statuses)}.")
    if _is_down(target.entity):
        lines.append(f"{target.entity.name} is down.")
    return {
        "type": "attack",
        "cardId": card.id,
        "cardTitle": card.title or card.id,
        "attackerId": attacker.entity.instance_id,
        "attackerName": attacker.entity.name,
        "targetId": target.entity.instance_id,
        "targetName": target.entity.name,
        "damage": int(effect.amount),
        "modifiers": modifiers,
        "damageToToughness": log.damage_to_hp,
        "damagePrevented": log.guarded_total,
        "targetToughnessBefore": before_toughness,
        "targetToughnessAfter": target.entity.toughness_current,
        "log": lines,
    }


def _choose_target(state: SimState, attacker: SimUnit) -> Optional[SimUnit]:
    candidates = [unit for unit in state.units if unit.team != attacker.team and not _is_down(unit.entity)]
    if not candidates:
        return None
    strategy = state.strategy_by_team.get(attacker.team, DEFAULT_TARGET_STRATEGY)

    if strategy == "full_random":
        return state.rng.choice(candidates)

    if strategy == "random_focus":
        focused_id = state.focus_by_team.get(attacker.team)
        focused = next((unit for unit in candidates if unit.entity.instance_id == focused_id), None)
        if focused is not None:
            return focused
        target = state.rng.choice(candidates)
        state.focus_by_team[attacker.team] = target.entity.instance_id
        return target

    focused_id = state.focus_by_team.get(attacker.team)
    focused = next((unit for unit in candidates if unit.entity.instance_id == focused_id), None)
    if focused is not None:
        return focused

    if strategy == "lowest_toughness":
        target = min(candidates, key=lambda unit: (unit.entity.toughness_current, unit.entity.toughness_max, unit.order_index))
        state.focus_by_team[attacker.team] = target.entity.instance_id
        return target

    if strategy == "highest_tl":
        target = max(
            candidates,
            key=lambda unit: (
                int(getattr(unit.template, "threat_level", 0) or 0),
                unit.entity.toughness_max,
                unit.entity.toughness_current,
                -unit.order_index,
            ),
        )
        state.focus_by_team[attacker.team] = target.entity.instance_id
        return target

    target = max(candidates, key=lambda unit: (unit.entity.toughness_max, unit.entity.toughness_current, -unit.order_index))
    state.focus_by_team[attacker.team] = target.entity.instance_id
    return target


def _winner(units: list[SimUnit]) -> Optional[str]:
    alive_teams = {unit.team for unit in units if not _is_down(unit.entity)}
    if len(alive_teams) == 1:
        return next(iter(alive_teams))
    if len(alive_teams) == 0:
        return "draw"
    return None


def _finalize_team_totals(state: SimState, units: list[SimUnit]) -> None:
    for team in ("A", "B"):
        team_units = [unit for unit in units if unit.team == team]
        state.team_totals[team]["unitsLost"] = sum(1 for unit in team_units if _is_down(unit.entity))
        state.team_totals[team]["remainingToughness"] = sum(
            max(0, int(unit.entity.toughness_current)) for unit in team_units if not _is_down(unit.entity)
        )
        state.team_totals[team]["units"] = len(team_units)


def _empty_team_totals() -> dict:
    return {
        "damageDealt": 0,
        "damagePrevented": 0,
        "unitsLost": 0,
        "remainingToughness": 0,
        "units": 0,
    }


def _draw_coverage_notes(entity_name: str, card_ids: list[str], card_index: dict[str, Card]) -> list[str]:
    notes: list[str] = []
    seen: set[str] = set()
    for card_id in card_ids:
        if card_id in seen:
            continue
        seen.add(card_id)
        card = card_index.get(card_id)
        if not card:
            continue
        coverage = action_card_coverage(card)
        if coverage["status"] == SIM_COVERAGE_FULL:
            continue
        result = card.action_result or card.title or card.id
        details = "; ".join(card.manual_notes) if card.manual_notes else coverage["label"]
        notes.append(f"Simulation note: {entity_name} {result} has {coverage['label'].lower()}: {details}.")
    return notes


def _coverage_summary(units: list[SimUnit], card_index: dict[str, Card], used_card_ids: set[str]) -> dict:
    available_card_ids: list[str] = []
    for unit in units:
        if unit.template.action_deck:
            available_card_ids.extend(card.id for card in unit.template.action_deck.cards)
    return {
        "available": _coverage_counts(available_card_ids, card_index),
        "used": _coverage_counts(list(used_card_ids), card_index),
    }


def _coverage_counts(card_ids: list[str], card_index: dict[str, Card]) -> dict:
    unique_ids = list(dict.fromkeys(card_ids))
    counts = {
        "total": len(unique_ids),
        SIM_COVERAGE_FULL: 0,
        SIM_COVERAGE_MANUAL: 0,
        SIM_COVERAGE_WARNING: 0,
        SIM_COVERAGE_ERROR: 0,
    }
    for card_id in unique_ids:
        card = card_index.get(card_id)
        status = action_card_coverage(card)["status"] if card else SIM_COVERAGE_WARNING
        counts[status] = counts.get(status, 0) + 1
    return counts


def _precision_summary(
    *,
    wins: dict[str, int],
    runs: int,
    run_cap: int,
    required_runs: int | None,
    worst_case_required_runs: int | None,
    precision_target: float | None,
) -> dict:
    outcomes = {
        key: _winrate_stats(count, runs)
        for key, count in wins.items()
    }
    observed_rerun = max((stats["rerunFluctuation95"] for stats in outcomes.values()), default=0.0)
    adjusted_rerun = _adjusted_observed_rerun_fluctuation(wins=wins, runs=runs)
    worst_case_rerun = _worst_case_rerun_fluctuation(runs)
    target_met = (
        precision_target is not None
        and required_runs is not None
        and runs >= required_runs
    )
    worst_case_target_met = precision_target is not None and worst_case_rerun <= precision_target
    cap_reached_before_target = (
        precision_target is not None
        and required_runs is not None
        and run_cap < required_runs
    )
    if precision_target is None:
        verdict = "Fixed runs"
    elif target_met:
        verdict = "Target met"
    elif cap_reached_before_target:
        verdict = "Cap reached before target"
    else:
        verdict = "Precision target not met"
    return {
        "confidenceLevel": 0.95,
        "targetRerunFluctuation": precision_target,
        "observedRerunFluctuation95": observed_rerun,
        "adjustedRerunFluctuation95": adjusted_rerun,
        "worstCaseRerunFluctuation95": worst_case_rerun,
        "requiredRunsForTarget": required_runs,
        "observedRequiredRunsForTarget": required_runs,
        "worstCaseRequiredRunsForTarget": worst_case_required_runs,
        "runCap": run_cap,
        "targetMet": target_met,
        "observedTargetMet": target_met,
        "worstCaseTargetMet": worst_case_target_met,
        "capReachedBeforeTarget": cap_reached_before_target,
        "verdict": verdict,
        "outcomes": outcomes,
        "runsForRerunFluctuation": {
            "10pct": runs_for_rerun_fluctuation(0.10),
            "5pct": runs_for_rerun_fluctuation(0.05),
            "3pct": runs_for_rerun_fluctuation(0.03),
            "1pct": runs_for_rerun_fluctuation(0.01),
        },
    }


def _winrate_stats(wins: int, runs: int) -> dict:
    p = wins / runs if runs else 0.0
    variance = p * (1 - p)
    std = math.sqrt(variance)
    standard_error = math.sqrt(variance / runs) if runs else 0.0
    ci_low, ci_high = _wilson_interval(wins, runs)
    rerun_fluctuation = Z_95 * math.sqrt((2 * variance) / runs) if runs else 0.0
    return {
        "wins": wins,
        "rate": round(p, 5),
        "std": round(std, 5),
        "standardError": round(standard_error, 5),
        "ciLow": round(ci_low, 5),
        "ciHigh": round(ci_high, 5),
        "ciMargin": round((ci_high - ci_low) / 2, 5),
        "rerunFluctuation95": round(rerun_fluctuation, 5),
    }


def _wilson_interval(wins: int, runs: int) -> tuple[float, float]:
    if runs <= 0:
        return (0.0, 0.0)
    p = wins / runs
    z2 = Z_95 * Z_95
    denominator = 1 + z2 / runs
    center = (p + z2 / (2 * runs)) / denominator
    half_width = (
        Z_95
        * math.sqrt((p * (1 - p) / runs) + (z2 / (4 * runs * runs)))
        / denominator
    )
    return (max(0.0, center - half_width), min(1.0, center + half_width))


def _max_bernoulli_variance_in_interval(low: float, high: float) -> float:
    low = max(0.0, min(1.0, low))
    high = max(0.0, min(1.0, high))
    if low > high:
        low, high = high, low
    if low <= 0.5 <= high:
        return 0.25
    return max(low * (1 - low), high * (1 - high))


def _adjusted_observed_rerun_fluctuation(*, wins: dict[str, int], runs: int) -> float:
    if runs <= 0:
        return 0.0
    max_variance = max(
        _max_bernoulli_variance_in_interval(*_wilson_interval(count, runs))
        for count in wins.values()
    )
    return Z_95 * math.sqrt((2 * max_variance) / runs)


def _worst_case_rerun_fluctuation(runs: int) -> float:
    if runs <= 0:
        return 0.0
    return Z_95 * math.sqrt(0.5 / runs)


def _metric_stats(values: list[float]) -> dict:
    count = len(values)
    if count <= 0:
        return {"mean": 0.0, "std": 0.0, "standardError": 0.0, "ciLow": 0.0, "ciHigh": 0.0}
    mean = sum(values) / count
    if count == 1:
        std = 0.0
    else:
        std = math.sqrt(sum((value - mean) ** 2 for value in values) / (count - 1))
    standard_error = std / math.sqrt(count) if count else 0.0
    margin = Z_95 * standard_error
    return {
        "mean": round(mean, 3),
        "std": round(std, 3),
        "standardError": round(standard_error, 3),
        "ciLow": round(mean - margin, 3),
        "ciHigh": round(mean + margin, 3),
    }


def _serialize_units(
    units: list[SimUnit],
    *,
    card_index: dict[str, Card],
    image_url_for: Optional[Callable[[EnemyTemplate], str]],
) -> list[dict]:
    return [_serialize_unit(unit, card_index=card_index, image_url_for=image_url_for) for unit in units]


def _serialize_unit(
    unit: SimUnit,
    *,
    card_index: dict[str, Card],
    image_url_for: Optional[Callable[[EnemyTemplate], str]],
) -> dict:
    entity = unit.entity
    deck_state = entity.deck_state
    roll = entity.initiative_roll
    modifier = int(getattr(entity, "initiative_modifier", 0))
    total = entity.initiative_total
    image_url = image_url_for(unit.template) if image_url_for else None
    return {
        "id": entity.instance_id,
        "team": unit.team,
        "name": entity.name,
        "templateId": unit.template.id,
        "imageUrl": image_url,
        "threatLevel": getattr(unit.template, "threat_level", None),
        "toughnessCurrent": entity.toughness_current,
        "toughnessMax": entity.toughness_max,
        "armorCurrent": entity.armor_current,
        "armorMax": entity.armor_max,
        "magicArmorCurrent": entity.magic_armor_current,
        "magicArmorMax": entity.magic_armor_max,
        "guardCurrent": entity.guard_current,
        "guardBase": int(getattr(entity, "guard_base", 0)),
        "power": int(getattr(entity, "power_base", 0)),
        "initiativeRoll": roll,
        "initiativeModifier": modifier,
        "initiativeTotal": total,
        "initiativeText": f"Init {total} ({roll}+{modifier})" if roll is not None and total is not None else "Init -",
        "statuses": dict(getattr(entity, "statuses", {}) or {}),
        "statusText": _status_text(entity),
        "currentDraw": [_card_text(card_index, card_id) for card_id in deck_state.hand],
        "deckCounts": {
            "draw": len(deck_state.draw_pile),
            "hand": len(deck_state.hand),
            "discard": len(deck_state.discard_pile),
        },
        "actionCoverage": _unit_action_coverage(unit.template, card_index),
        "isDown": _is_down(entity),
    }


def _unit_action_coverage(template: EnemyTemplate, card_index: dict[str, Card]) -> dict:
    if not template.action_deck:
        return _coverage_counts([], card_index)
    return _coverage_counts([card.id for card in template.action_deck.cards], card_index)


def _status_text(entity: EnemyInstance) -> str:
    statuses = getattr(entity, "statuses", {}) or {}
    if not statuses:
        return "-"
    parts = []
    for key, value in sorted(statuses.items()):
        stacks = value.get("stacks") if isinstance(value, dict) else None
        parts.append(f"{key} {stacks}" if stacks else key)
    return ", ".join(parts)


def _card_text(card_index: dict[str, Card], card_id: str) -> str:
    card = card_index.get(card_id)
    if not card:
        return card_id
    if card.action_text:
        return card.action_text
    parts = [_effect_label(effect) for effect in card.effects]
    return " + ".join(parts) if parts else (card.title or card.id)


def _effect_label(effect) -> str:
    if effect.type == "attack":
        modifiers = _normalize_modifiers(effect.modifiers)
        return _attack_label(effect.amount, modifiers)
    if effect.type == "guard":
        return f"Guard {effect.amount}"
    if effect.type == "draw":
        return f"Draw {effect.amount}"
    if effect.type == "disengage":
        return f"Disengage {effect.amount}"
    return str(effect.type)


def _attack_label(amount: int, modifiers: list[str]) -> str:
    if modifiers:
        return f"Attack {amount} ({', '.join(_format_modifier(modifier) for modifier in modifiers)})"
    return f"Attack {amount}"


def _normalize_modifiers(modifiers: Iterable[str]) -> list[AttackMod]:
    result: list[AttackMod] = []
    for modifier in modifiers or []:
        text = str(modifier).strip().lower()
        if not text:
            continue
        if text in {"magic pierce", "magic-pierce"}:
            text = "magic_pierce"
        if text in {"paralyze", "paralyse"}:
            text = "paralyse"
        if text not in result:
            result.append(text)
    return result


def _format_modifier(modifier: str) -> str:
    if modifier.startswith("pierce:"):
        return f"pierce {modifier.split(':', 1)[1]}"
    return modifier


def _initiative_label(entity: EnemyInstance) -> str:
    roll = entity.initiative_roll
    modifier = int(getattr(entity, "initiative_modifier", 0))
    total = entity.initiative_total
    return f"{entity.name} Init {total} ({roll}+{modifier})"


def _is_down(entity: EnemyInstance) -> bool:
    return int(getattr(entity, "toughness_current", 0)) <= 0


def _reshuffle_enemy_deck_at_end(entity: EnemyInstance, rng: random.Random) -> None:
    deck_state = entity.deck_state
    cards = list(deck_state.draw_pile) + list(deck_state.discard_pile) + list(deck_state.hand)
    deck_state.draw_pile = cards
    deck_state.discard_pile.clear()
    deck_state.hand.clear()
    rng.shuffle(deck_state.draw_pile)
    entity.pending_reshuffle = False


def _ratio(value: float, total: int) -> float:
    if not total:
        return 0.0
    return round(float(value) / float(total), 3)
