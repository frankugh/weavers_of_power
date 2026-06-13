from __future__ import annotations

import random
from typing import Any, Literal, Optional

from fastapi import File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from battle_session import (
    BattleSessionContext,
    BattleSessionError,
)
from engine.combat import AttackMod
from engine.combat_sim import (
    DEFAULT_MAX_ROUNDS,
    DEFAULT_TARGET_STRATEGY,
    MAX_BATCH_RUNS,
    TARGET_STRATEGIES,
    CombatSimError,
    simulate_combat_batch,
    simulate_combat_once,
)


class SelectRequest(BaseModel):
    instanceId: str


class OrderRequest(BaseModel):
    instanceId: str
    direction: Literal[-1, 1]


class PositionRequest(BaseModel):
    x: int
    y: int


class EntityPlacementRequest(PositionRequest):
    instanceId: str


class BatchPositionsRequest(BaseModel):
    placements: list[EntityPlacementRequest] = Field(default_factory=list)


class MoveRequest(PositionRequest):
    dash: bool = False


class PartyWalkRequest(PositionRequest):
    leaderId: str


class CustomEnemyRequest(BaseModel):
    name: str = "Custom"
    toughness: int = Field(default=10, ge=1)
    armor: int = Field(default=0, ge=0)
    magicArmor: int = Field(default=0, ge=0)
    draw: int = Field(default=1, ge=0)
    movement: int = Field(default=6, ge=0)
    coreDeckId: str


class AddPlayerRequest(BaseModel):
    name: str = ""
    playerDeckId: str = "human_fighter_lvl1"
    toughness: int = Field(default=4, ge=0)
    armor: int = Field(default=1, ge=0)
    magicArmor: int = Field(default=0, ge=0)
    power: int = Field(default=4, ge=0)
    movement: int = Field(default=6, ge=0)
    baseGuard: int = Field(default=1, ge=0)
    initiativeModifier: int = Field(default=2, ge=0)
    physicalCards: bool = False


class CharacterStatsRequest(BaseModel):
    toughness: int = Field(default=3, ge=0)
    armor: int = Field(default=1, ge=0)
    magicArmor: int = Field(default=0, ge=0)
    power: int = Field(default=4, ge=0)
    movement: int = Field(default=6, ge=0)
    baseGuard: int = Field(default=1, ge=0)
    initiativeModifier: int = Field(default=2, ge=0)


class CharacterProfileRequest(BaseModel):
    name: str = ""
    classId: str
    ancestryId: str
    energyTypes: list[str]
    mainArt: str
    gmOverride: bool = False
    deckUpgrades: dict[str, dict[str, int]] = Field(default_factory=dict)
    classImprovementTarget: str = "success_1"
    gearPresetId: str = ""
    stats: CharacterStatsRequest = Field(default_factory=CharacterStatsRequest)
    art: dict[str, Any] = Field(default_factory=dict)


class SpawnCharacterRequest(BaseModel):
    characterId: str
    physicalCards: bool = False


class AddEnemyRequest(BaseModel):
    templateId: Optional[str] = None
    custom: Optional[CustomEnemyRequest] = None


class RollInitiativeRequest(BaseModel):
    modes: dict[str, str] = Field(default_factory=dict)


class DrawExactRequest(BaseModel):
    count: int = Field(default=1, ge=1)


class ActionAmountRequest(BaseModel):
    x: int = Field(default=1, ge=1)


class HelpRequest(BaseModel):
    targetId: str


class OpportunityResolveRequest(BaseModel):
    action: Literal["attack", "skip"]
    useWillpower: Optional[bool] = None
    manualSuccesses: Optional[int] = Field(default=None, ge=0)
    manualFate: Optional[int] = Field(default=None, ge=0)


class RemoveWoundRequest(BaseModel):
    confirmDeck: bool = False


class AdjustWoundRequest(BaseModel):
    delta: int = Field(default=0)


class PlayerCardModeRequest(BaseModel):
    physicalCards: bool = False
    deckReset: bool = False


class AttackRequest(BaseModel):
    damage: int = Field(default=0, ge=0)
    modifiers: list[AttackMod] = Field(default_factory=list)
    burn: bool = False
    poison: bool = False
    slow: bool = False
    paralyze: bool = False
    targetMode: Literal["creature", "grapple"] = "creature"
    grappleId: str | None = None


class HealRequest(BaseModel):
    toughness: int = Field(default=0, ge=0)
    temporaryToughness: int = Field(default=0, ge=0)
    armor: int = Field(default=0, ge=0)
    magicArmor: int = Field(default=0, ge=0)
    guard: int = Field(default=0, ge=0)


class TakeLootRequest(BaseModel):
    playerId: str


class SaveRequest(BaseModel):
    name: str = "session"


class LoadRequest(BaseModel):
    filename: str


class SaveMapTemplateRequest(BaseModel):
    name: str = "map template"


class MapTemplateDefinitionRequest(BaseModel):
    name: str = "map template"
    template: dict[str, Any] = Field(default_factory=dict)


class ScenarioCreateRequest(BaseModel):
    name: str = "New Scenario"


class ScenarioSaveRequest(BaseModel):
    definition: dict[str, Any]


class ScenarioRenameRequest(BaseModel):
    name: str


class ScenarioDuplicateRequest(BaseModel):
    name: Optional[str] = None


class ScenarioAttachRequest(BaseModel):
    scenarioId: str


class ScenarioNavigateRequest(BaseModel):
    nodeId: str


class ScenarioPhaseRequest(BaseModel):
    phaseId: str


class ScenarioEventResolveRequest(BaseModel):
    eventId: str = "event"
    setPhase: Optional[str] = None
    flags: dict[str, Any] = Field(default_factory=dict)


class ScenarioNodeRequest(BaseModel):
    node: dict[str, Any]


class ScenarioNodePositionRequest(BaseModel):
    x: float
    y: float


class ScenarioEdgeRequest(BaseModel):
    edge: dict[str, Any]


class DungeonTilesRequest(BaseModel):
    tileType: str
    cells: list[list[int]]


class DungeonEdgeRequest(BaseModel):
    x: int
    y: int
    side: str


class DungeonWallsRequest(BaseModel):
    wallType: str
    edges: list[DungeonEdgeRequest]
    secretDc: int = Field(default=2, ge=0)


class DungeonDoorStateRequest(BaseModel):
    x: int
    y: int
    side: str
    open: bool


class DungeonSettingsRequest(BaseModel):
    fogOfWarEnabled: bool


class DungeonPlayerSpawnRequest(BaseModel):
    x: int
    y: int


class StartPlayRequest(BaseModel):
    players: list[dict[str, Any]] = Field(default_factory=list)


class DungeonRoomRevealedRequest(BaseModel):
    revealed: bool


class DungeonSecretDoorRevealRequest(BaseModel):
    x: int
    y: int
    side: str


class DungeonSecretDoorDcRequest(BaseModel):
    x: int
    y: int
    side: str
    dc: int = Field(default=2, ge=0)


class SearchResolveRequest(BaseModel):
    useWillpower: bool = False
    partyWalk: bool = False


class InteractSuspectRequest(BaseModel):
    edgeKey: str


class CombatSimStatOverridesRequest(BaseModel):
    toughness: Optional[int] = None
    armor: Optional[int] = None
    magicArmor: Optional[int] = None
    baseGuard: Optional[int] = None
    draw: Optional[int] = None
    movement: Optional[int] = None
    initiativeModifier: Optional[int] = None
    threatLevel: Optional[int] = None


class CombatSimEntryOverridesRequest(BaseModel):
    statOverrides: Optional[CombatSimStatOverridesRequest] = None
    skillOverrides: dict[str, Optional[int]] = Field(default_factory=dict)
    actionOverrides: dict[str, str] = Field(default_factory=dict)


class CreatureTemplateSaveOverridesRequest(BaseModel):
    statOverrides: dict[str, Any] = Field(default_factory=dict)
    skillOverrides: dict[str, Any] = Field(default_factory=dict)
    actionOverrides: dict[str, Any] = Field(default_factory=dict)
    infoOverrides: dict[str, Any] = Field(default_factory=dict)


class CombatSimTeamEntryRequest(BaseModel):
    templateId: str
    count: int = 1
    overrides: Optional[CombatSimEntryOverridesRequest] = None


class CombatSimRequest(BaseModel):
    teamA: list[CombatSimTeamEntryRequest] = Field(default_factory=list)
    teamB: list[CombatSimTeamEntryRequest] = Field(default_factory=list)
    strategy: Optional[str] = None
    strategyA: Optional[str] = None
    strategyB: Optional[str] = None
    seed: Optional[int] = None
    runs: int = 1
    precisionTargetPercent: Optional[float] = None
    maxRounds: int = DEFAULT_MAX_ROUNDS


def _validate_combat_sim_request(
    request: CombatSimRequest,
    strategy_a: str,
    strategy_b: str,
    context: BattleSessionContext,
) -> None:
    if request.runs < 1 or request.runs > MAX_BATCH_RUNS:
        raise CombatSimError(f"runs must be between 1 and {MAX_BATCH_RUNS}")
    if request.precisionTargetPercent is not None and request.precisionTargetPercent <= 0:
        raise CombatSimError("precisionTargetPercent must be > 0")
    if request.maxRounds < 1:
        raise CombatSimError("maxRounds must be > 0")
    for strategy in (strategy_a, strategy_b):
        if strategy not in TARGET_STRATEGIES:
            raise CombatSimError(f"Unknown target strategy '{strategy}'")
    for label, entries in (("teamA", request.teamA), ("teamB", request.teamB)):
        if not entries:
            raise CombatSimError(f"{label} must contain at least one creature")
        for entry in entries:
            if not entry.templateId:
                raise CombatSimError(f"{label}: templateId is required")
            if entry.count <= 0:
                raise CombatSimError(f"{label}: count must be > 0")
            if entry.count > 20:
                raise CombatSimError(f"{label}: count must be <= 20")
            template = context.enemy_templates.get(entry.templateId)
            if template is None:
                raise CombatSimError(f"Unknown template '{entry.templateId}'")
            if not getattr(template, "spawnable", True):
                raise CombatSimError(f"Template '{template.name}' is not spawnable")


def register_battle_api(api_app, context: BattleSessionContext) -> None:
    def load_session_or_400(sid: str):
        try:
            return context.load_session(sid)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    def run_mutation(sid: str, action, *, undoable: bool = True):
        session = load_session_or_400(sid)
        before_payload = session.undo_payload() if undoable else None
        try:
            mutation_result = action(session)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if undoable:
            after_payload = session.undo_payload()
            if before_payload != after_payload:
                session.remember_undo_state(before_payload)
                session.autosave()
        payload = session.snapshot()
        if isinstance(mutation_result, dict):
            payload.update(mutation_result)
        return payload

    def load_scenario_or_404(scenario_id: str) -> dict:
        scenario = context.get_scenario(scenario_id)
        if scenario is None:
            raise HTTPException(status_code=404, detail=f"Scenario '{scenario_id}' not found")
        return scenario

    def save_scenario_or_400(scenario_id: str, definition: dict) -> dict:
        try:
            return context.save_scenario(scenario_id, definition)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @api_app.get("/api/battle/meta")
    def battle_meta():
        return context.metadata()

    @api_app.get("/api/battle/character-builder/catalog")
    def character_builder_catalog():
        return context.character_catalog_payload()

    @api_app.post("/api/battle/character-builder/art/upload")
    async def upload_character_builder_art(file: UploadFile = File(...)):
        try:
            content = await file.read(8 * 1024 * 1024 + 1)
            return context.save_character_art_upload(file.filename or "character_art.png", content)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @api_app.get("/api/battle/characters")
    def character_profiles():
        return {"characters": context.list_character_profiles()}

    @api_app.post("/api/battle/characters")
    def create_character_profile(request: CharacterProfileRequest):
        try:
            return context.create_character_profile(request.model_dump())
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @api_app.delete("/api/battle/characters/{character_id}")
    def delete_character_profile(character_id: str):
        try:
            return context.delete_character_profile(character_id)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @api_app.post("/api/combat-sim/simulate")
    def combat_simulate(request: CombatSimRequest):
        strategy_a = request.strategyA or request.strategy or DEFAULT_TARGET_STRATEGY
        strategy_b = request.strategyB or request.strategy or DEFAULT_TARGET_STRATEGY
        base_seed = request.seed if (request.seed is not None and request.seed > 0) else random.randint(1, 2_000_000_000)

        try:
            _validate_combat_sim_request(request, strategy_a, strategy_b, context)
            team_a = [entry.model_dump() for entry in request.teamA]
            team_b = [entry.model_dump() for entry in request.teamB]
            common = {
                "templates": context.enemy_templates,
                "decks": context.decks,
                "card_index": context.card_index,
                "team_a": team_a,
                "team_b": team_b,
                "strategy_a": strategy_a,
                "strategy_b": strategy_b,
                "seed": int(base_seed),
                "max_rounds": request.maxRounds,
                "image_url_for": context.template_image_url,
            }
            if request.runs == 1:
                result = simulate_combat_once(**common)
                return {"mode": "single", "result": result}
            precision_target = (
                request.precisionTargetPercent / 100.0
                if request.precisionTargetPercent is not None
                else None
            )
            result = simulate_combat_batch(runs=request.runs, precision_target=precision_target, **common)
            return {"mode": "batch", "result": result}
        except CombatSimError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @api_app.post("/api/battle/creature-templates/{templateId}/save-overrides")
    def save_creature_template_overrides(templateId: str, request: CreatureTemplateSaveOverridesRequest):
        try:
            return context.save_creature_template_overrides(templateId, request.model_dump())
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @api_app.post("/api/battle/sessions")
    def create_battle_session():
        session = context.create_session()
        return session.snapshot()

    @api_app.get("/api/battle/sessions/{sid}")
    def get_battle_session(sid: str):
        session = context.load_session(sid)
        return session.snapshot()

    @api_app.post("/api/battle/sessions/{sid}/select")
    def select_entity(sid: str, request: SelectRequest):
        return run_mutation(sid, lambda session: session.select(request.instanceId), undoable=False)

    @api_app.post("/api/battle/sessions/{sid}/order")
    def move_entity(sid: str, request: OrderRequest):
        return run_mutation(sid, lambda session: session.move_in_order(request.instanceId, request.direction))

    @api_app.post("/api/battle/sessions/{sid}/enemies")
    def add_enemy(sid: str, request: AddEnemyRequest):
        def mutate(session):
            if request.custom is not None:
                session.add_custom_enemy(
                    name=request.custom.name,
                    toughness=request.custom.toughness,
                    armor=request.custom.armor,
                    magic_armor=request.custom.magicArmor,
                    power=request.custom.draw,
                    movement=request.custom.movement,
                    core_deck_id=request.custom.coreDeckId,
                )
                return
            if request.templateId:
                session.add_enemy_from_template(request.templateId)
                return
            raise BattleSessionError("Either templateId or custom is required")

        return run_mutation(sid, mutate)

    @api_app.post("/api/battle/sessions/{sid}/players")
    def add_player(sid: str, request: AddPlayerRequest):
        return run_mutation(
            sid,
            lambda session: session.add_player(
                name=request.name,
                toughness=request.toughness,
                armor=request.armor,
                magic_armor=request.magicArmor,
                power=request.power,
                movement=request.movement,
                base_guard=request.baseGuard,
                initiative_modifier=request.initiativeModifier,
                player_deck_id=request.playerDeckId,
                physical_cards=request.physicalCards,
            ),
        )

    @api_app.post("/api/battle/sessions/{sid}/players/from-character")
    def add_player_from_character(sid: str, request: SpawnCharacterRequest):
        return run_mutation(
            sid,
            lambda session: session.add_player_from_character(
                request.characterId,
                physical_cards=request.physicalCards,
            ),
        )

    @api_app.delete("/api/battle/sessions/{sid}/entities/{instance_id}")
    def delete_entity(sid: str, instance_id: str):
        return run_mutation(sid, lambda session: session.delete_entity(instance_id))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/position")
    def move_entity_position(sid: str, instance_id: str, request: PositionRequest):
        return run_mutation(sid, lambda session: session.set_entity_position(instance_id, request.x, request.y))

    @api_app.post("/api/battle/sessions/{sid}/entities/positions")
    def move_entity_positions(sid: str, request: BatchPositionsRequest):
        return run_mutation(
            sid,
            lambda session: session.set_entity_positions([placement.model_dump() for placement in request.placements]),
        )

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/copy")
    def copy_entity(sid: str, instance_id: str):
        return run_mutation(sid, lambda session: session.copy_entity(instance_id))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/loot")
    def roll_entity_loot(sid: str, instance_id: str):
        return run_mutation(sid, lambda session: session.roll_loot_for_entity(instance_id))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/loot/inspect")
    def inspect_entity_loot(sid: str, instance_id: str):
        return run_mutation(sid, lambda session: session.inspect_loot_for_entity(instance_id))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/loot/take")
    def take_entity_loot(sid: str, instance_id: str, request: TakeLootRequest):
        return run_mutation(sid, lambda session: session.take_loot_for_player(instance_id, request.playerId))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/move")
    def move_entity_with_movement(sid: str, instance_id: str, request: MoveRequest):
        return run_mutation(
            sid,
            lambda session: session.move_entity_with_movement(instance_id, request.x, request.y, dash=request.dash),
        )

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/walk")
    def walk_entity(sid: str, instance_id: str, request: PositionRequest):
        return run_mutation(
            sid,
            lambda session: session.walk_entity(instance_id, request.x, request.y),
        )

    @api_app.post("/api/battle/sessions/{sid}/action/party-walk")
    def party_walk(sid: str, request: PartyWalkRequest):
        return run_mutation(
            sid,
            lambda session: session.party_walk(request.leaderId, request.x, request.y),
        )

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/wounds/discard")
    def discard_player_wound(sid: str, instance_id: str):
        return run_mutation(sid, lambda session: session.discard_player_wound(instance_id))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/wounds/remove")
    def remove_player_wound(sid: str, instance_id: str, request: RemoveWoundRequest):
        return run_mutation(sid, lambda session: session.remove_player_wound(instance_id, confirm_deck=request.confirmDeck))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/wounds/adjust")
    def adjust_player_wounds(sid: str, instance_id: str, request: AdjustWoundRequest):
        return run_mutation(sid, lambda session: session.adjust_physical_wounds(instance_id, delta=request.delta))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/player-card-mode")
    def set_player_card_mode(sid: str, instance_id: str, request: PlayerCardModeRequest):
        return run_mutation(
            sid,
            lambda session: session.set_player_card_mode(
                instance_id,
                physical_cards=request.physicalCards,
                deck_reset=request.deckReset,
            ),
        )

    @api_app.post("/api/battle/sessions/{sid}/turn/draw")
    def draw_turn(sid: str):
        return run_mutation(sid, lambda session: session.draw_turn())

    @api_app.post("/api/battle/sessions/{sid}/turn/draw-exact")
    def draw_exact_turn(sid: str, request: DrawExactRequest):
        return run_mutation(sid, lambda session: session.draw_exact_turn(request.count))

    @api_app.post("/api/battle/sessions/{sid}/action/prepare")
    def prepare_pc(sid: str):
        return run_mutation(sid, lambda session: session.prepare_pc())

    @api_app.post("/api/battle/sessions/{sid}/action/strengthen")
    def strengthen_pc(sid: str, request: ActionAmountRequest):
        return run_mutation(sid, lambda session: session.strengthen_pc(request.x))

    @api_app.post("/api/battle/sessions/{sid}/action/guard")
    def guard_pc(sid: str, request: ActionAmountRequest):
        return run_mutation(sid, lambda session: session.guard_pc(request.x))

    @api_app.post("/api/battle/sessions/{sid}/action/hitdraw")
    def hitdraw_pc(sid: str):
        return run_mutation(sid, lambda session: session.hitdraw_pc())

    @api_app.post("/api/battle/sessions/{sid}/action/shed")
    def shed_wound(sid: str):
        return run_mutation(sid, lambda session: session.shed_wound())

    @api_app.post("/api/battle/sessions/{sid}/action/disengage")
    def disengage_pc(sid: str):
        return run_mutation(sid, lambda session: session.disengage_pc())

    @api_app.post("/api/battle/sessions/{sid}/opportunity/resolve")
    def resolve_opportunity(sid: str, request: OpportunityResolveRequest):
        return run_mutation(
            sid,
            lambda session: session.resolve_opportunity_attack(
                action=request.action,
                use_willpower=request.useWillpower,
                manual_successes=request.manualSuccesses,
                manual_fate=request.manualFate,
            ),
            undoable=False,
        )

    @api_app.post("/api/battle/sessions/{sid}/action/help")
    def help_pc(sid: str, request: HelpRequest):
        return run_mutation(sid, lambda session: session.help_pc(request.targetId))

    @api_app.post("/api/battle/sessions/{sid}/turn/redraw")
    def redraw_turn(sid: str):
        return run_mutation(sid, lambda session: session.redraw_turn())

    @api_app.post("/api/battle/sessions/{sid}/turn/quick-attack")
    def quick_attack_turn(sid: str):
        return run_mutation(sid, lambda session: session.apply_quick_attack_from_active_draw())

    @api_app.post("/api/battle/sessions/{sid}/turn/no-draw")
    def enemy_turn_without_draw(sid: str):
        return run_mutation(sid, lambda session: session.enemy_turn_no_draw())

    @api_app.post("/api/battle/sessions/{sid}/turn/end")
    def end_turn(sid: str):
        return run_mutation(sid, lambda session: session.end_turn_selected())

    @api_app.post("/api/battle/sessions/{sid}/encounter/start")
    def start_encounter(sid: str):
        return run_mutation(sid, lambda session: session.start_encounter())

    @api_app.post("/api/battle/sessions/{sid}/turn/next")
    def next_turn(sid: str):
        return run_mutation(sid, lambda session: session.next_turn())

    @api_app.post("/api/battle/sessions/{sid}/round/start")
    def start_round(sid: str):
        return run_mutation(sid, lambda session: session.start_new_round())

    @api_app.post("/api/battle/sessions/{sid}/encounter/end")
    def end_combat(sid: str):
        return run_mutation(sid, lambda session: session.end_combat())

    @api_app.post("/api/battle/sessions/{sid}/initiative/roll")
    def roll_initiative(sid: str, request: RollInitiativeRequest):
        return run_mutation(sid, lambda session: session.roll_initiative(request.modes))

    @api_app.post("/api/battle/sessions/{sid}/undo")
    def undo(sid: str):
        return run_mutation(sid, lambda session: session.undo(), undoable=False)

    @api_app.post("/api/battle/sessions/{sid}/redo")
    def redo(sid: str):
        return run_mutation(sid, lambda session: session.redo(), undoable=False)

    @api_app.post("/api/battle/sessions/{sid}/attack")
    def attack_selected(sid: str, request: AttackRequest):
        return run_mutation(
            sid,
            lambda session: session.apply_attack_to_selected(
                damage=request.damage,
                modifiers=request.modifiers,
                add_burn=request.burn,
                add_poison=request.poison,
                add_slow=request.slow,
                add_paralyze=request.paralyze,
                target_mode=request.targetMode,
                grapple_id=request.grappleId,
            ),
        )

    @api_app.post("/api/battle/sessions/{sid}/heal")
    def heal_selected(sid: str, request: HealRequest):
        return run_mutation(
            sid,
            lambda session: session.apply_heal_to_selected(
                toughness=request.toughness,
                temporary_toughness=request.temporaryToughness,
                armor=request.armor,
                magic_armor=request.magicArmor,
                guard=request.guard,
            ),
        )

    @api_app.post("/api/battle/sessions/{sid}/loot")
    def roll_loot(sid: str):
        return run_mutation(sid, lambda session: session.roll_loot_for_selected())

    @api_app.post("/api/battle/sessions/{sid}/loot/inspect-all")
    def inspect_all_visible_loot(sid: str):
        return run_mutation(sid, lambda session: session.inspect_all_visible_loot())

    @api_app.get("/api/battle/sessions/{sid}/saves")
    def list_manual_saves(sid: str):
        session = load_session_or_400(sid)
        return {"saves": session.list_manual_saves()}

    @api_app.post("/api/battle/sessions/{sid}/saves")
    def create_manual_save(sid: str, request: SaveRequest):
        return run_mutation(sid, lambda session: session.save_manual(request.name), undoable=False)

    @api_app.put("/api/battle/sessions/{sid}/saves/{filename}")
    def overwrite_manual_save(sid: str, filename: str):
        return run_mutation(sid, lambda session: session.overwrite_manual(filename), undoable=False)

    @api_app.delete("/api/battle/sessions/{sid}/saves/{filename}")
    def delete_manual_save(sid: str, filename: str):
        session = load_session_or_400(sid)
        try:
            session.delete_manual(filename)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"saves": session.list_manual_saves(), "activeSave": session.active_save_snapshot()}

    @api_app.post("/api/battle/sessions/{sid}/load")
    def load_manual_save(sid: str, request: LoadRequest):
        return run_mutation(sid, lambda session: session.load_manual(request.filename), undoable=False)

    @api_app.post("/api/battle/sessions/{sid}/dungeon/tiles")
    def edit_dungeon_tiles(sid: str, request: DungeonTilesRequest):
        return run_mutation(
            sid,
            lambda session: session.edit_dungeon_tiles(request.tileType, request.cells),
        )

    @api_app.post("/api/battle/sessions/{sid}/dungeon/walls")
    def edit_dungeon_walls(sid: str, request: DungeonWallsRequest):
        edges = [{"x": e.x, "y": e.y, "side": e.side} for e in request.edges]
        return run_mutation(
            sid,
            lambda session: session.edit_dungeon_walls(request.wallType, edges, secret_dc=request.secretDc),
        )

    @api_app.post("/api/battle/sessions/{sid}/dungeon/analyze")
    def analyze_dungeon(sid: str):
        return run_mutation(sid, lambda session: session.analyze_dungeon())

    @api_app.post("/api/battle/sessions/{sid}/dungeon/doors/state")
    def set_door_state(sid: str, request: DungeonDoorStateRequest):
        return run_mutation(
            sid,
            lambda session: session.set_door_state(request.x, request.y, request.side, request.open),
        )

    @api_app.post("/api/battle/sessions/{sid}/dungeon/settings")
    def dungeon_settings(sid: str, request: DungeonSettingsRequest):
        return run_mutation(sid, lambda session: session.set_fog_of_war(request.fogOfWarEnabled))

    @api_app.post("/api/battle/sessions/{sid}/dungeon/rooms/{room_id}/revealed")
    def room_revealed(sid: str, room_id: str, request: DungeonRoomRevealedRequest):
        return run_mutation(sid, lambda session: session.set_room_revealed(room_id, request.revealed))

    @api_app.post("/api/battle/sessions/{sid}/dungeon/secret-doors/reveal")
    def reveal_secret_door(sid: str, request: DungeonSecretDoorRevealRequest):
        return run_mutation(
            sid,
            lambda session: session.gm_reveal_secret_door(request.x, request.y, request.side),
        )

    @api_app.post("/api/battle/sessions/{sid}/dungeon/secret-doors/dc")
    def set_secret_door_dc(sid: str, request: DungeonSecretDoorDcRequest):
        return run_mutation(
            sid,
            lambda session: session.gm_set_secret_door_dc(request.x, request.y, request.side, request.dc),
        )

    @api_app.post("/api/battle/sessions/{sid}/dungeon/search/start")
    def start_room_search(sid: str):
        return run_mutation(sid, lambda session: session.start_room_search())

    @api_app.post("/api/battle/sessions/{sid}/dungeon/search/resolve")
    def resolve_room_search(sid: str, request: SearchResolveRequest):
        return run_mutation(
            sid,
            lambda session: session.resolve_room_search(request.useWillpower, party_walk=request.partyWalk),
            undoable=False,
        )

    @api_app.post("/api/battle/sessions/{sid}/dungeon/suspects/interact")
    def interact_suspect(sid: str, request: InteractSuspectRequest):
        return run_mutation(sid, lambda session: session.interact_suspect(request.edgeKey))

    @api_app.post("/api/battle/sessions/{sid}/dungeon/suspects/resolve")
    def resolve_suspect(sid: str, request: SearchResolveRequest):
        return run_mutation(sid, lambda session: session.resolve_suspect_interaction(request.useWillpower), undoable=False)

    @api_app.get("/api/scenarios")
    def list_scenarios():
        return {"scenarios": context.list_scenarios()}

    @api_app.post("/api/scenarios")
    def create_scenario(request: ScenarioCreateRequest):
        scenario = context.create_scenario(request.name)
        return {"scenario": scenario, "scenarios": context.list_scenarios()}

    @api_app.get("/api/scenarios/{scenario_id}")
    def get_scenario(scenario_id: str):
        return {"scenario": load_scenario_or_404(scenario_id)}

    @api_app.put("/api/scenarios/{scenario_id}")
    def save_scenario(scenario_id: str, request: ScenarioSaveRequest):
        scenario = save_scenario_or_400(scenario_id, request.definition)
        return {"scenario": scenario, "scenarios": context.list_scenarios()}

    @api_app.post("/api/scenarios/{scenario_id}/rename")
    def rename_scenario(scenario_id: str, request: ScenarioRenameRequest):
        try:
            scenario = context.rename_scenario(scenario_id, request.name)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"scenario": scenario, "scenarios": context.list_scenarios()}

    @api_app.post("/api/scenarios/{scenario_id}/duplicate")
    def duplicate_scenario(scenario_id: str, request: ScenarioDuplicateRequest):
        try:
            scenario = context.duplicate_scenario(scenario_id, request.name)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"scenario": scenario, "scenarios": context.list_scenarios()}

    @api_app.delete("/api/scenarios/{scenario_id}")
    def delete_scenario(scenario_id: str):
        try:
            context.delete_scenario(scenario_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"scenarios": context.list_scenarios()}

    @api_app.post("/api/scenarios/{scenario_id}/nodes")
    def create_scenario_node(scenario_id: str, request: ScenarioNodeRequest):
        scenario = load_scenario_or_404(scenario_id)
        node = dict(request.node)
        if not node.get("id"):
            node["id"] = f"node_{random.randint(100000, 999999)}"
        scenario["nodes"] = [*scenario.get("nodes", []), node]
        scenario = save_scenario_or_400(scenario_id, scenario)
        return {"scenario": scenario}

    @api_app.put("/api/scenarios/{scenario_id}/nodes/{node_id}")
    def update_scenario_node(scenario_id: str, node_id: str, request: ScenarioNodeRequest):
        scenario = load_scenario_or_404(scenario_id)
        nodes = scenario.get("nodes", [])
        if not any(node.get("id") == node_id for node in nodes):
            raise HTTPException(status_code=404, detail=f"Scenario node '{node_id}' not found")
        scenario["nodes"] = [
            {**dict(request.node), "id": node_id} if node.get("id") == node_id else node
            for node in nodes
        ]
        scenario = save_scenario_or_400(scenario_id, scenario)
        return {"scenario": scenario}

    @api_app.patch("/api/scenarios/{scenario_id}/nodes/{node_id}/position")
    def update_scenario_node_position(scenario_id: str, node_id: str, request: ScenarioNodePositionRequest):
        scenario = load_scenario_or_404(scenario_id)
        nodes = scenario.get("nodes", [])
        if not any(node.get("id") == node_id for node in nodes):
            raise HTTPException(status_code=404, detail=f"Scenario node '{node_id}' not found")
        scenario["nodes"] = [
            {**node, "position": {"x": request.x, "y": request.y}} if node.get("id") == node_id else node
            for node in nodes
        ]
        scenario = save_scenario_or_400(scenario_id, scenario)
        return {"scenario": scenario}

    @api_app.delete("/api/scenarios/{scenario_id}/nodes/{node_id}")
    def delete_scenario_node(scenario_id: str, node_id: str):
        scenario = load_scenario_or_404(scenario_id)
        nodes = [node for node in scenario.get("nodes", []) if node.get("id") != node_id]
        if len(nodes) == len(scenario.get("nodes", [])):
            raise HTTPException(status_code=404, detail=f"Scenario node '{node_id}' not found")
        scenario["nodes"] = nodes
        scenario["edges"] = [
            edge for edge in scenario.get("edges", [])
            if edge.get("from") != node_id and edge.get("to") != node_id
        ]
        if scenario.get("startNodeId") == node_id and nodes:
            scenario["startNodeId"] = nodes[0].get("id")
        scenario = save_scenario_or_400(scenario_id, scenario)
        return {"scenario": scenario}

    @api_app.post("/api/scenarios/{scenario_id}/edges")
    def create_scenario_edge(scenario_id: str, request: ScenarioEdgeRequest):
        scenario = load_scenario_or_404(scenario_id)
        edge = dict(request.edge)
        if not edge.get("id"):
            edge["id"] = f"edge_{random.randint(100000, 999999)}"
        scenario["edges"] = [*scenario.get("edges", []), edge]
        scenario = save_scenario_or_400(scenario_id, scenario)
        return {"scenario": scenario}

    @api_app.put("/api/scenarios/{scenario_id}/edges/{edge_id}")
    def update_scenario_edge(scenario_id: str, edge_id: str, request: ScenarioEdgeRequest):
        scenario = load_scenario_or_404(scenario_id)
        edges = scenario.get("edges", [])
        if not any(edge.get("id") == edge_id for edge in edges):
            raise HTTPException(status_code=404, detail=f"Scenario edge '{edge_id}' not found")
        scenario["edges"] = [
            {**dict(request.edge), "id": edge_id} if edge.get("id") == edge_id else edge
            for edge in edges
        ]
        scenario = save_scenario_or_400(scenario_id, scenario)
        return {"scenario": scenario}

    @api_app.delete("/api/scenarios/{scenario_id}/edges/{edge_id}")
    def delete_scenario_edge(scenario_id: str, edge_id: str):
        scenario = load_scenario_or_404(scenario_id)
        edges = [edge for edge in scenario.get("edges", []) if edge.get("id") != edge_id]
        if len(edges) == len(scenario.get("edges", [])):
            raise HTTPException(status_code=404, detail=f"Scenario edge '{edge_id}' not found")
        scenario["edges"] = edges
        scenario = save_scenario_or_400(scenario_id, scenario)
        return {"scenario": scenario}

    @api_app.post("/api/battle/sessions/{sid}/scenario/attach")
    def attach_scenario_to_session(sid: str, request: ScenarioAttachRequest):
        return run_mutation(sid, lambda session: session.start_scenario_run(request.scenarioId))

    @api_app.post("/api/battle/sessions/{sid}/scenario/start-run")
    def start_scenario_run(sid: str, request: ScenarioAttachRequest):
        return run_mutation(sid, lambda session: session.start_scenario_run(request.scenarioId))

    @api_app.put("/api/battle/sessions/{sid}/scenario/templates/{scenario_id}")
    def save_scenario_template_and_update_active_run(sid: str, scenario_id: str, request: ScenarioSaveRequest):
        session = load_session_or_400(sid)
        if session._scenario_source_id() != scenario_id:
            raise HTTPException(status_code=400, detail="Template does not match the active scenario run")
        before_payload = session.undo_payload()
        try:
            scenario = save_scenario_or_400(scenario_id, request.definition)
            session.update_scenario_run_definition(scenario)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        after_payload = session.undo_payload()
        if before_payload != after_payload:
            session.remember_undo_state(before_payload)
            session.autosave()
        payload = session.snapshot()
        payload.update({"scenarioTemplate": scenario, "scenarios": context.list_scenarios()})
        return payload

    @api_app.post("/api/battle/sessions/{sid}/scenario/detach")
    def detach_scenario_from_session(sid: str):
        return run_mutation(sid, lambda session: session.detach_scenario())

    @api_app.post("/api/battle/sessions/{sid}/scenario/navigate")
    def navigate_scenario(sid: str, request: ScenarioNavigateRequest):
        return run_mutation(sid, lambda session: session.navigate_scenario_node(request.nodeId))

    @api_app.post("/api/battle/sessions/{sid}/scenario/nodes/{node_id}/phase")
    def set_scenario_phase(sid: str, node_id: str, request: ScenarioPhaseRequest):
        return run_mutation(sid, lambda session: session.set_scenario_node_phase(node_id, request.phaseId))

    @api_app.post("/api/battle/sessions/{sid}/scenario/nodes/{node_id}/events/resolve")
    def resolve_scenario_event(sid: str, node_id: str, request: ScenarioEventResolveRequest):
        return run_mutation(
            sid,
            lambda session: session.resolve_scenario_event(
                node_id,
                request.eventId,
                set_phase=request.setPhase,
                flags=request.flags,
            ),
        )

    @api_app.post("/api/battle/sessions/{sid}/scenario/nodes/{node_id}/start-combat")
    def start_scenario_combat(sid: str, node_id: str, request: Optional[StartPlayRequest] = None):
        players = request.players if request else []
        return run_mutation(sid, lambda session: session.start_scenario_combat(node_id, players))

    @api_app.get("/api/map-templates")
    def list_map_templates():
        return {"templates": context.list_map_templates()}

    @api_app.post("/api/map-templates")
    def create_map_template(request: MapTemplateDefinitionRequest):
        result = context.save_map_template(request.name, dict(request.template))
        template = context.get_map_template(result["id"]) or {}
        return {"template": {**template, "id": result["id"]}, "templates": context.list_map_templates()}

    @api_app.get("/api/map-templates/{template_id}")
    def get_map_template(template_id: str):
        template = context.get_map_template(template_id)
        if template is None:
            raise HTTPException(status_code=404, detail=f"Map template '{template_id}' not found")
        return {"template": {**template, "id": template_id}}

    @api_app.put("/api/map-templates/{template_id}")
    def save_map_template(template_id: str, request: MapTemplateDefinitionRequest):
        try:
            result = context.write_map_template(template_id, {**dict(request.template), "name": request.name})
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        template = context.get_map_template(result["id"]) or {}
        return {"template": {**template, "id": result["id"]}, "templates": context.list_map_templates()}

    @api_app.post("/api/battle/sessions/{sid}/dungeon/save-as-template")
    def save_dungeon_as_map_template(sid: str, request: SaveMapTemplateRequest):
        session = load_session_or_400(sid)
        try:
            result = session.save_dungeon_as_map_template(request.name)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        payload = session.snapshot()
        payload["savedTemplate"] = result
        return payload

    @api_app.post("/api/battle/sessions/{sid}/dungeon/save-template/{template_id}")
    def save_dungeon_to_map_template(sid: str, template_id: str):
        session = load_session_or_400(sid)
        try:
            result = session.save_dungeon_to_map_template(template_id)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        payload = session.snapshot()
        payload["savedTemplate"] = result
        return payload

    @api_app.post("/api/battle/sessions/{sid}/dungeon/load-template/{template_id}")
    def load_map_template(sid: str, template_id: str):
        return run_mutation(sid, lambda session: session.load_map_template_into_dungeon(template_id))

    @api_app.post("/api/battle/sessions/{sid}/start-play")
    def start_play_from_map(sid: str, request: Optional[StartPlayRequest] = None):
        players = request.players if request else []
        return run_mutation(sid, lambda session: session.start_play_from_current_map(players))

    @api_app.post("/api/battle/sessions/{sid}/dungeon/player-spawn")
    def set_player_spawn(sid: str, request: DungeonPlayerSpawnRequest):
        return run_mutation(sid, lambda session: session.set_player_spawn(request.x, request.y))

    @api_app.delete("/api/map-templates/{template_id}")
    def delete_map_template(template_id: str):
        try:
            context.delete_map_template(template_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"templates": context.list_map_templates()}
