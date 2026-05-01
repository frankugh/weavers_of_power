from __future__ import annotations

from typing import Literal, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field

from battle_session import (
    BattleSessionContext,
    BattleSessionError,
)
from engine.combat import AttackMod


class SelectRequest(BaseModel):
    instanceId: str


class OrderRequest(BaseModel):
    instanceId: str
    direction: Literal[-1, 1]


class PositionRequest(BaseModel):
    x: int
    y: int


class MoveRequest(PositionRequest):
    dash: bool = False


class CustomEnemyRequest(BaseModel):
    name: str = "Custom"
    toughness: int = Field(default=10, ge=1)
    armor: int = Field(default=0, ge=0)
    magicArmor: int = Field(default=0, ge=0)
    power: int = Field(default=1, ge=0)
    movement: int = Field(default=6, ge=0)
    coreDeckId: str


class AddPlayerRequest(BaseModel):
    name: str = ""
    toughness: int = Field(default=3, ge=0)
    armor: int = Field(default=0, ge=0)
    magicArmor: int = Field(default=0, ge=0)
    power: int = Field(default=0, ge=0)
    movement: int = Field(default=6, ge=0)


class AddEnemyRequest(BaseModel):
    templateId: Optional[str] = None
    custom: Optional[CustomEnemyRequest] = None


class RollInitiativeRequest(BaseModel):
    modes: dict[str, str] = Field(default_factory=dict)


class AttackRequest(BaseModel):
    damage: int = Field(default=0, ge=0)
    modifiers: list[AttackMod] = Field(default_factory=list)
    burn: bool = False
    poison: bool = False
    slow: bool = False
    paralyze: bool = False


class HealRequest(BaseModel):
    toughness: int = Field(default=0, ge=0)
    armor: int = Field(default=0, ge=0)
    magicArmor: int = Field(default=0, ge=0)
    guard: int = Field(default=0, ge=0)


class SaveRequest(BaseModel):
    name: str = "session"


class LoadRequest(BaseModel):
    filename: str


class DungeonTilesRequest(BaseModel):
    tileType: str
    cells: list[list[int]]


class DungeonOpenDoorRequest(BaseModel):
    x: int
    y: int


class DungeonSettingsRequest(BaseModel):
    fogOfWarEnabled: bool


class DungeonRoomRevealedRequest(BaseModel):
    revealed: bool


class DungeonCropRequest(BaseModel):
    minX: int
    minY: int
    columns: int = Field(ge=1)
    rows: int = Field(ge=1)
    confirmUnitUnplace: bool = False


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

    @api_app.get("/api/battle/meta")
    def battle_meta():
        return context.metadata()

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
                    power=request.custom.power,
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
            ),
        )

    @api_app.delete("/api/battle/sessions/{sid}/entities/{instance_id}")
    def delete_entity(sid: str, instance_id: str):
        return run_mutation(sid, lambda session: session.delete_entity(instance_id))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/position")
    def move_entity_position(sid: str, instance_id: str, request: PositionRequest):
        return run_mutation(sid, lambda session: session.set_entity_position(instance_id, request.x, request.y))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/move")
    def move_entity_with_movement(sid: str, instance_id: str, request: MoveRequest):
        return run_mutation(
            sid,
            lambda session: session.move_entity_with_movement(instance_id, request.x, request.y, dash=request.dash),
        )

    @api_app.post("/api/battle/sessions/{sid}/turn/draw")
    def draw_turn(sid: str):
        return run_mutation(sid, lambda session: session.draw_turn())

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
            ),
        )

    @api_app.post("/api/battle/sessions/{sid}/heal")
    def heal_selected(sid: str, request: HealRequest):
        return run_mutation(
            sid,
            lambda session: session.apply_heal_to_selected(
                toughness=request.toughness,
                armor=request.armor,
                magic_armor=request.magicArmor,
                guard=request.guard,
            ),
        )

    @api_app.post("/api/battle/sessions/{sid}/loot")
    def roll_loot(sid: str):
        return run_mutation(sid, lambda session: session.roll_loot_for_selected())

    @api_app.get("/api/battle/sessions/{sid}/saves")
    def list_manual_saves(sid: str):
        session = load_session_or_400(sid)
        return {"saves": session.list_manual_saves()}

    @api_app.post("/api/battle/sessions/{sid}/saves")
    def create_manual_save(sid: str, request: SaveRequest):
        return run_mutation(sid, lambda session: session.save_manual(request.name), undoable=False)

    @api_app.delete("/api/battle/sessions/{sid}/saves/{filename}")
    def delete_manual_save(sid: str, filename: str):
        session = load_session_or_400(sid)
        try:
            session.delete_manual(filename)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"saves": session.list_manual_saves()}

    @api_app.post("/api/battle/sessions/{sid}/load")
    def load_manual_save(sid: str, request: LoadRequest):
        return run_mutation(sid, lambda session: session.load_manual(request.filename), undoable=False)

    @api_app.post("/api/battle/sessions/{sid}/dungeon/tiles")
    def edit_dungeon_tiles(sid: str, request: DungeonTilesRequest):
        return run_mutation(
            sid,
            lambda session: session.edit_dungeon_tiles(request.tileType, request.cells),
        )

    @api_app.post("/api/battle/sessions/{sid}/dungeon/analyze")
    def analyze_dungeon(sid: str):
        return run_mutation(sid, lambda session: session.analyze_dungeon())

    @api_app.post("/api/battle/sessions/{sid}/dungeon/doors/open")
    def open_door(sid: str, request: DungeonOpenDoorRequest):
        return run_mutation(sid, lambda session: session.open_door(request.x, request.y))

    @api_app.post("/api/battle/sessions/{sid}/dungeon/settings")
    def dungeon_settings(sid: str, request: DungeonSettingsRequest):
        return run_mutation(sid, lambda session: session.set_fog_of_war(request.fogOfWarEnabled))

    @api_app.post("/api/battle/sessions/{sid}/dungeon/rooms/{room_id}/revealed")
    def room_revealed(sid: str, room_id: str, request: DungeonRoomRevealedRequest):
        return run_mutation(sid, lambda session: session.set_room_revealed(room_id, request.revealed))

    @api_app.post("/api/battle/sessions/{sid}/dungeon/crop")
    def crop_dungeon(sid: str, request: DungeonCropRequest):
        return run_mutation(
            sid,
            lambda session: session.crop_dungeon(
                request.minX,
                request.minY,
                request.columns,
                request.rows,
                confirm_unit_unplace=request.confirmUnitUnplace,
            ),
        )
