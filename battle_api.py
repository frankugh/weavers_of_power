from __future__ import annotations

from typing import Literal, Optional

from fastapi import HTTPException
from pydantic import BaseModel, Field

from battle_session import (
    ROOM_MAX_COLUMNS,
    ROOM_MAX_ROWS,
    ROOM_MIN_COLUMNS,
    ROOM_MIN_ROWS,
    BattleSessionContext,
    BattleSessionError,
)
from engine.combat import AttackMod


class SelectRequest(BaseModel):
    instanceId: str


class OrderRequest(BaseModel):
    instanceId: str
    direction: Literal[-1, 1]


class RoomRequest(BaseModel):
    columns: int = Field(ge=ROOM_MIN_COLUMNS, le=ROOM_MAX_COLUMNS)
    rows: int = Field(ge=ROOM_MIN_ROWS, le=ROOM_MAX_ROWS)
    autoPlaceOutOfBounds: bool = False


class PositionRequest(BaseModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)


class CustomEnemyRequest(BaseModel):
    name: str = "Custom"
    hp: int = Field(default=10, ge=1)
    armor: int = Field(default=0, ge=0)
    magicArmor: int = Field(default=0, ge=0)
    draws: int = Field(default=1, ge=0)
    movement: int = Field(default=6, ge=0)
    coreDeckId: str


class AddEnemyRequest(BaseModel):
    templateId: Optional[str] = None
    custom: Optional[CustomEnemyRequest] = None


class AttackRequest(BaseModel):
    damage: int = Field(default=0, ge=0)
    modifiers: list[AttackMod] = Field(default_factory=list)
    burn: bool = False
    poison: bool = False
    slow: bool = False
    paralyze: bool = False


class HealRequest(BaseModel):
    hp: int = Field(default=0, ge=0)
    armor: int = Field(default=0, ge=0)
    magicArmor: int = Field(default=0, ge=0)
    guard: int = Field(default=0, ge=0)


class SaveRequest(BaseModel):
    name: str = "session"


class LoadRequest(BaseModel):
    filename: str


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
            action(session)
        except BattleSessionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if undoable:
            after_payload = session.undo_payload()
            if before_payload != after_payload:
                session.remember_undo_state(before_payload)
                session.autosave()
        return session.snapshot()

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

    @api_app.post("/api/battle/sessions/{sid}/room")
    def resize_room(sid: str, request: RoomRequest):
        return run_mutation(
            sid,
            lambda session: session.set_room_size(
                request.columns,
                request.rows,
                auto_place_out_of_bounds=request.autoPlaceOutOfBounds,
            ),
        )

    @api_app.post("/api/battle/sessions/{sid}/enemies")
    def add_enemy(sid: str, request: AddEnemyRequest):
        def mutate(session):
            if request.custom is not None:
                session.add_custom_enemy(
                    name=request.custom.name,
                    hp=request.custom.hp,
                    armor=request.custom.armor,
                    magic_armor=request.custom.magicArmor,
                    draws=request.custom.draws,
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
    def add_player(sid: str):
        return run_mutation(sid, lambda session: session.add_player())

    @api_app.delete("/api/battle/sessions/{sid}/entities/{instance_id}")
    def delete_entity(sid: str, instance_id: str):
        return run_mutation(sid, lambda session: session.delete_entity(instance_id))

    @api_app.post("/api/battle/sessions/{sid}/entities/{instance_id}/position")
    def move_entity_position(sid: str, instance_id: str, request: PositionRequest):
        return run_mutation(sid, lambda session: session.set_entity_position(instance_id, request.x, request.y))

    @api_app.post("/api/battle/sessions/{sid}/turn/draw")
    def draw_turn(sid: str):
        return run_mutation(sid, lambda session: session.draw_turn())

    @api_app.post("/api/battle/sessions/{sid}/turn/redraw")
    def redraw_turn(sid: str):
        return run_mutation(sid, lambda session: session.redraw_turn())

    @api_app.post("/api/battle/sessions/{sid}/turn/no-draw")
    def enemy_turn_without_draw(sid: str):
        return run_mutation(sid, lambda session: session.enemy_turn_no_draw())

    @api_app.post("/api/battle/sessions/{sid}/turn/end")
    def end_turn(sid: str):
        return run_mutation(sid, lambda session: session.end_turn_selected())

    @api_app.post("/api/battle/sessions/{sid}/turn/next")
    def next_turn(sid: str):
        return run_mutation(sid, lambda session: session.next_turn())

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
                hp=request.hp,
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

    @api_app.post("/api/battle/sessions/{sid}/load")
    def load_manual_save(sid: str, request: LoadRequest):
        return run_mutation(sid, lambda session: session.load_manual(request.filename), undoable=False)
