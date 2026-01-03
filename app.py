from __future__ import annotations

from pathlib import Path
import random
import uuid
from datetime import datetime
from typing import Optional, List

from fastapi import Request
from nicegui import ui, app

from engine.loader import load_decks, load_enemies
from engine.runtime import BattleState, spawn_enemy, enemy_turn, end_turn
from engine.runtime_models import EnemyInstance, DeckState
from engine.combat import apply_attack, apply_heal
from engine.loot import roll_loot
from engine.turn_hooks import on_turn_start, on_turn_end

from persistence import (
    make_save_payload,
    load_save_payload,
    restore_state_from_payload,
    save_current,
)

ROOT = Path(__file__).parent
DATA_DECKS = ROOT / "data" / "decks"
DATA_ENEMIES = ROOT / "data" / "enemies"
IMAGES_DIR = ROOT / "images"
SAVES_DIR = ROOT / "saves"
MANUAL_DIR = SAVES_DIR / "manual"
SAVE_VERSION = 1

app.add_static_files("/images", str(IMAGES_DIR))

# Load templates/decks once (safe global)
decks = load_decks(DATA_DECKS)
enemy_templates = load_enemies(DATA_ENEMIES, decks=decks, images_dir=IMAGES_DIR)

# Card lookup (deck cards + specials)
card_index = {}
for d in decks.values():
    for c in d.cards:
        card_index[c.id] = c
for et in enemy_templates.values():
    for s in et.specials:
        card_index[s.id] = s


# ---------- pure helpers (no UI) ----------

def uuid_short() -> str:
    return uuid.uuid4().hex[:10]


def is_player(e: EnemyInstance) -> bool:
    return getattr(e, "template_id", "") == "player"


def is_down(e: EnemyInstance) -> bool:
    """True if this non-player is at 0 HP (or below)."""
    return (not is_player(e)) and int(getattr(e, "hp_current", 0)) <= 0


def image_url_for(e: EnemyInstance) -> str:
    img = getattr(e, "image", None) or ""

    # allow absolute URLs
    if img.startswith("http://") or img.startswith("https://"):
        return img

    # normalize slashes + remove leading slash
    img = img.replace("\\", "/").lstrip("/")

    # handle stored paths like "images/bandit.png" or "/images/bandit.png"
    if img.startswith("images/"):
        img = img[len("images/"):]
    if img.startswith("images/"):  # (just in case, harmless)
        img = img[len("images/"):]

    # legacy typo
    if img == "bandid.png":
        img = "bandit.png"

    # fallback to template image if missing/invalid
    if not img or not (IMAGES_DIR / img).exists():
        tpl = enemy_templates.get(getattr(e, "template_id", ""))
        tpl_img = getattr(tpl, "image", None) if tpl else None
        tpl_img = (tpl_img or "").replace("\\", "/").lstrip("/")
        if tpl_img.startswith("images/"):
            tpl_img = tpl_img[len("images/"):]
        if tpl_img and (IMAGES_DIR / tpl_img).exists():
            img = tpl_img
        else:
            img = "anonymous.png"

    return f"/images/{img}"


def effective_movement(e: EnemyInstance) -> int:
    if "slowed" in getattr(e, "statuses", {}):
        return max(0, int(e.movement) // 2)
    return int(e.movement)


def format_statuses(statuses: dict) -> str:
    if not statuses:
        return "—"
    parts = []
    for k, v in statuses.items():
        if isinstance(v, dict) and "stacks" in v:
            parts.append(f"{k}({v.get('stacks')})")
        else:
            parts.append(k)
    return ", ".join(parts)


def add_status_stack(e: EnemyInstance, name: str, stacks: int = 1) -> None:
    cur = e.statuses.get(name)
    if isinstance(cur, dict):
        e.statuses[name] = {"stacks": int(cur.get("stacks", 0)) + stacks}
    else:
        e.statuses[name] = {"stacks": stacks}


def set_transient_status(e: EnemyInstance, name: str) -> None:
    e.statuses[name] = {"stacks": 1}


def card_to_effect_text(card_id: str) -> str:
    c = card_index.get(card_id)
    if not c:
        return card_id
    parts: list[str] = []
    for eff in c.effects:
        if eff.type == "attack":
            if eff.modifiers:
                parts.append(f"Attack {eff.amount} ({', '.join(eff.modifiers)})")
            else:
                parts.append(f"Attack {eff.amount}")
        elif eff.type == "guard":
            parts.append(f"Guard {eff.amount}")
        else:
            parts.append(eff.type)
    return " + ".join(parts) if parts else (c.title or card_id)


def draw_list_to_text(card_ids: list[str], max_items: int = 3) -> str:
    if not card_ids:
        return "—"
    shown = [card_to_effect_text(cid) for cid in card_ids[:max_items]]
    suffix = f" (+{len(card_ids) - max_items} more)" if len(card_ids) > max_items else ""
    return ", ".join(shown) + suffix


def build_core_deck_ids(deck_id: str, rnd: random.Random) -> list[str]:
    d = decks[deck_id]
    ids: list[str] = []
    for c in d.cards:
        ids.extend([c.id] * c.weight)
    rnd.shuffle(ids)
    return ids


def spawn_custom_enemy(
    name: str,
    hp: int,
    armor: int,
    magic_armor: int,
    draws: int,
    movement: int,
    core_deck_id: str,
    rnd: random.Random,
) -> EnemyInstance:
    inst_id = uuid_short()
    draw_pile = build_core_deck_ids(core_deck_id, rnd=rnd)
    return EnemyInstance(
        instance_id=inst_id,
        template_id="custom",
        name=name,
        image=None,
        hp_current=hp,
        hp_max=hp,
        armor_current=armor,
        armor_max=armor,
        magic_armor_current=magic_armor,
        magic_armor_max=magic_armor,
        guard_current=0,
        draws_base=draws,
        movement=movement,
        deck_state=DeckState(draw_pile=draw_pile, discard_pile=[], hand=[]),
        statuses={},
    )


def spawn_player(name: str) -> EnemyInstance:
    inst_id = uuid_short()
    return EnemyInstance(
        instance_id=inst_id,
        template_id="player",
        name=name,
        image=None,
        hp_current=0,
        hp_max=0,
        armor_current=0,
        armor_max=0,
        magic_armor_current=0,
        magic_armor_max=0,
        guard_current=0,
        draws_base=0,
        movement=0,
        deck_state=DeckState(draw_pile=[], discard_pile=[], hand=[]),
        statuses={},
    )


def safe_filename(name: str) -> str:
    keep = []
    for ch in name.strip():
        if ch.isalnum() or ch in ("-", "_", " "):
            keep.append(ch)
    s = "".join(keep).strip().replace(" ", "_")
    return s or "save"


def now_stamp() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


# ---------- page ----------

@ui.page("/")
def index(request: Request):
    # ----- session id via URL (per tab) -----
    sid = request.query_params.get("sid")
    if not sid:
        sid = uuid.uuid4().hex[:12]
        ui.navigate.to(f"/?sid={sid}")
        return

    SAVES_DIR.mkdir(parents=True, exist_ok=True)
    MANUAL_DIR.mkdir(parents=True, exist_ok=True)

    current_path = SAVES_DIR / f"_current_{sid}.json"

    # ----- runtime state (per-page instance) -----
    state = BattleState()
    order: list[str] = []
    selected_id: Optional[str] = None

    active_turn_id: Optional[str] = None
    turn_in_progress: bool = False

    session_rng = random.Random()

    template_counts: dict[str, int] = {}
    player_count: int = 0

    # UI containers
    enemy_grid_container = None
    detail_container = None

    # ---------- persistence ----------
    def autosave() -> None:
        payload = make_save_payload(
            version=SAVE_VERSION,
            sid=sid,
            order=order,
            selected_id=selected_id,
            active_turn_id=active_turn_id,
            turn_in_progress=turn_in_progress,
            enemies=list(state.enemies.values()),
        )
        save_current(current_path, payload)

    def load_from_payload(payload: dict) -> None:
        nonlocal order, selected_id, active_turn_id, turn_in_progress, player_count, template_counts

        state.enemies.clear()
        order = []
        selected_id = None
        active_turn_id = None
        turn_in_progress = False
        template_counts = {}
        player_count = 0

        loaded_order, loaded_selected, loaded_active, loaded_tip, enemies = restore_state_from_payload(payload)

        for e in enemies:
            state.add_enemy(e)

        order = [iid for iid in loaded_order if iid in state.enemies]

        if loaded_selected in state.enemies:
            selected_id = loaded_selected
        elif order:
            selected_id = order[0]

        if loaded_active in state.enemies:
            active_turn_id = loaded_active
            turn_in_progress = bool(loaded_tip)

        # rebuild counters
        for iid in order:
            e = state.enemies[iid]
            if getattr(e, "template_id", "") == "player":
                player_count += 1
                continue

            parts = e.name.rsplit(" ", 1)
            if len(parts) == 2 and parts[1].isdigit():
                base_name = parts[0]
                n = int(parts[1])
                template_counts[base_name] = max(template_counts.get(base_name, 0), n)
            else:
                template_counts[e.name] = max(template_counts.get(e.name, 0), 1)

    def load_or_init_current() -> None:
        payload = load_save_payload(current_path)
        if payload:
            load_from_payload(payload)

    def list_manual_saves() -> List[Path]:
        return sorted(MANUAL_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)

    def save_manual(name: str) -> Path:
        filename = f"{safe_filename(name)}_{now_stamp()}.json"
        path = MANUAL_DIR / filename
        payload = make_save_payload(
            version=SAVE_VERSION,
            sid=sid,
            order=order,
            selected_id=selected_id,
            active_turn_id=active_turn_id,
            turn_in_progress=turn_in_progress,
            enemies=list(state.enemies.values()),
        )
        save_current(path, payload)
        return path

    # ---------- state helpers ----------
    def ensure_selected() -> None:
        nonlocal selected_id
        if selected_id and selected_id not in state.enemies:
            selected_id = None
        if selected_id is None and order:
            selected_id = order[0]

    def get_selected() -> Optional[EnemyInstance]:
        ensure_selected()
        if not selected_id:
            return None
        return state.enemies.get(selected_id)

    def select_next_in_order() -> None:
        nonlocal selected_id
        if not order:
            selected_id = None
            return
        if selected_id not in order:
            selected_id = order[0]
            return
        i = order.index(selected_id)
        selected_id = order[(i + 1) % len(order)]

    def move_in_order(instance_id: str, direction: int) -> None:
        if instance_id not in order:
            return
        i = order.index(instance_id)
        j = i + direction
        if j < 0 or j >= len(order):
            return
        order[i], order[j] = order[j], order[i]

    def roll_loot_for_instance(instance_id: str) -> None:
        e = state.enemies[instance_id]
        tpl = enemy_templates.get(e.template_id)
        if not tpl:
            e.rolled_loot = {"currency": {}, "resources": {}, "other": ["(no template loot)"]}
            e.loot_rolled = True
            return
        lr = roll_loot(tpl, rnd=session_rng)
        e.rolled_loot = {"currency": dict(lr.currency), "resources": dict(lr.resources), "other": list(lr.other)}
        e.loot_rolled = True

    # ---------- render ----------
    def render_overview() -> None:
        nonlocal enemy_grid_container
        if enemy_grid_container is None:
            return
        enemy_grid_container.clear()

        with enemy_grid_container:
            if not order:
                ui.label("No enemies/players yet. Use Add enemy / Add player.").classes("text-gray-500")
                return

            with ui.row().classes("w-full flex-wrap gap-3"):
                for inst_id in order:
                    e = state.enemies.get(inst_id)
                    if not e:
                        continue

                    sel = (inst_id == selected_id)
                    active = (inst_id == active_turn_id)
                    player = is_player(e)

                    classes = "w-80"
                    if sel:
                        classes += " ring-2 ring-blue-500"
                    if active:
                        classes += " ring-2 ring-green-600 bg-green-50"

                    def on_click(iid=inst_id):
                        nonlocal selected_id
                        selected_id = iid
                        autosave()
                        render_overview()
                        render_detail()

                    with ui.card().classes(classes).on("click", on_click):
                        with ui.row().classes("items-center justify-between"):
                            ui.label(e.name).classes("text-lg font-semibold")
                            with ui.row().classes("items-center gap-1"):
                                if active:
                                    ui.badge("ACTIVE TURN").props("color=green")
                                ui.button(
                                    icon="arrow_upward",
                                    on_click=lambda iid=inst_id: (
                                        move_in_order(iid, -1),
                                        autosave(),
                                        render_overview(),
                                        render_detail(),
                                    ),
                                ).props("flat dense")
                                ui.button(
                                    icon="arrow_downward",
                                    on_click=lambda iid=inst_id: (
                                        move_in_order(iid, +1),
                                        autosave(),
                                        render_overview(),
                                        render_detail(),
                                    ),
                                ).props("flat dense")
                                ui.button(icon="delete", on_click=lambda iid=inst_id: ui_delete_item(iid)).props(
                                    "flat dense"
                                ).classes("text-red-600")

                        img_src = image_url_for(e)
                        dead = is_down(e)

                        # Use a real <img> element here (no ui.html -> no sanitize issues; no q-img -> no blank images)
                        with ui.element("div").classes("relative w-full h-40 bg-gray-50 overflow-hidden"):
                            ui.element("img")\
                                .props(f"src={img_src}")\
                                .classes("w-full h-full object-cover object-top" + (" grayscale opacity-60" if dead else ""))\
                                .on("click", lambda _=None, s=img_src, n=e.name: open_image_preview(s, n))
                            if dead:
                                ui.label("☠").classes(
                                    "absolute inset-0 flex items-center justify-center text-white text-6xl bg-black/40 pointer-events-none"
                                )

                        if player:
                            ui.label("Player card").classes("text-sm text-gray-700")
                        else:
                            ui.label(
                                f"HP {e.hp_current}/{e.hp_max} | "
                                f"Armor {e.armor_current}/{e.armor_max} | "
                                f"Magic {e.magic_armor_current}/{e.magic_armor_max}"
                            )
                            ui.label(f"Guard {e.guard_current} | Draws {e.draws_base} | Move {effective_movement(e)}")
                            ui.label(f"Statuses: {format_statuses(e.statuses)}").classes("text-sm text-gray-700")

                            current_draw = list(e.deck_state.hand)
                            last_drawn = list(getattr(e, "last_drawn", []))
                            ui.label(f"Current draw: {draw_list_to_text(current_draw, 3)}").classes("text-sm text-gray-700")
                            ui.label(f"Last draw: {draw_list_to_text(last_drawn, 3)}").classes("text-sm text-gray-600")

                        # Overview action buttons
                        if sel and (active_turn_id is None) and (not player):
                            # only show Draw when there's no current draw
                            if len(getattr(e.deck_state, "hand", [])) == 0:
                                with ui.row().classes("gap-2 mt-2 flex-wrap"):
                                    ui.button("Draw", on_click=ui_enemy_turn).props("color=primary dense")
                                    ui.button("Attack enemy", on_click=open_attack_dialog).props("outline dense")
                                    ui.button("Heal enemy", on_click=open_heal_dialog).props("outline dense")

                        if active and (not player):
                            ui.button("Next", on_click=ui_next).props("color=primary dense").classes("mt-2")

                        if player and sel and (active_turn_id is None):
                            ui.button("Next", on_click=ui_next).props("color=primary dense").classes("mt-2")

    def render_detail() -> None:
        nonlocal detail_container
        if detail_container is None:
            return
        detail_container.clear()

        e = get_selected()
        with detail_container:
            ui.label("Selected").classes("text-xl font-semibold")
            if not e:
                ui.label("—").classes("text-gray-500")
                return

            active = (e.instance_id == active_turn_id)
            player = is_player(e)

            can_draw = (active_turn_id is None) or active
            can_end = active and turn_in_progress

            with ui.card().classes("w-full"):
                with ui.row().classes("items-start gap-4"):
                    img_src = image_url_for(e)
                    dead = is_down(e)
                    with ui.element("div").classes("relative"):
                        img_classes = "w-56 h-56 object-contain bg-gray-50" + (" grayscale opacity-60" if dead else "")
                        ui.element("img")\
                            .props(f"src={img_src}")\
                            .classes(img_classes)\
                            .on("click", lambda _=None, s=img_src, n=e.name: open_image_preview(s, n))
                        if dead:
                            ui.label("☠").classes(
                                "absolute inset-0 flex items-center justify-center text-white text-6xl bg-black/40 pointer-events-none"
                            )

                    with ui.column().classes("gap-1 w-full"):
                        with ui.row().classes("items-center gap-2"):
                            ui.label(f"{e.name} (id: {e.instance_id})").classes("text-lg font-semibold")
                            if active:
                                ui.badge("ACTIVE TURN").props("color=green")

                        # buttons above stats
                        with ui.row().classes("gap-2 flex-wrap mt-2"):
                            if player:
                                btn_next = ui.button("Next", on_click=ui_next).props("color=primary")
                                if active_turn_id is not None:
                                    btn_next.disable()
                            else:
                                btn_draw = ui.button("Draw", on_click=ui_enemy_turn).props("color=primary")
                                if not can_draw:
                                    btn_draw.disable()

                                ui.button("Next", on_click=ui_next).props("color=primary")

                                btn_end = ui.button("End turn", on_click=ui_end_turn).props("outline")
                                if not can_end:
                                    btn_end.disable()

                                btn_no_draw = ui.button("Enemy turn (no draw)", on_click=ui_enemy_turn_no_draw).props("outline")
                                if not can_draw:
                                    btn_no_draw.disable()

                                ui.button("Attack enemy", on_click=open_attack_dialog).props("outline")
                                ui.button("Heal enemy", on_click=open_heal_dialog).props("outline")

                                loot_label = "Reroll loot" if getattr(e, "loot_rolled", False) else "Roll loot"
                                btn_loot = ui.button(loot_label, on_click=ui_roll_loot).props("outline")
                                if e.template_id in ("custom", "player"):
                                    btn_loot.disable()

                ui.separator()

                if player:
                    ui.label("This is a player card (no stats).").classes("text-gray-700")
                    return

                ui.label(
                    f"HP {e.hp_current}/{e.hp_max} | "
                    f"Armor {e.armor_current}/{e.armor_max} | "
                    f"Magic {e.magic_armor_current}/{e.magic_armor_max}"
                )
                ui.label(f"Guard {e.guard_current} | Draws {e.draws_base} | Move {effective_movement(e)}")
                ui.label(f"Statuses: {format_statuses(e.statuses)}").classes("text-sm text-gray-700")

                ui.separator()

                current_draw = list(e.deck_state.hand)
                last_drawn = list(getattr(e, "last_drawn", []))
                if current_draw:
                    ui.label(f"Current draw: {draw_list_to_text(current_draw, 6)}").classes("text-sm text-gray-700")
                else:
                    ui.label(f"Last draw: {draw_list_to_text(last_drawn, 6)}").classes("text-sm text-gray-700")

                ui.separator()

                ui.label("Loot").classes("font-semibold")
                if e.template_id in ("custom", "player"):
                    ui.label("(No template loot)").classes("text-gray-500")
                else:
                    if not getattr(e, "loot_rolled", False):
                        ui.label("Not rolled yet.").classes("text-gray-700")
                    else:
                        loot = getattr(e, "rolled_loot", {}) or {}
                        ui.label(f"Currency: {loot.get('currency', {})}")
                        ui.label(f"Resources: {loot.get('resources', {})}")
                        ui.label(f"Other: {loot.get('other', [])}")

    # ---------- mutation wrapper ----------
    def mutate(fn):
        def _wrapped(*args, **kwargs):
            result = fn(*args, **kwargs)
            autosave()
            render_overview()
            render_detail()
            return result

        return _wrapped

    # ---------- actions ----------
    @mutate
    def ui_delete_item(instance_id: str) -> None:
        nonlocal selected_id, active_turn_id, turn_in_progress

        if active_turn_id == instance_id:
            active_turn_id = None
            turn_in_progress = False

        state.remove_enemy(instance_id)
        if instance_id in order:
            order.remove(instance_id)

        if selected_id == instance_id:
            selected_id = None
            ensure_selected()

    @mutate
    def ui_add_enemy(template_id: str) -> None:
        nonlocal selected_id

        tpl = enemy_templates[template_id]
        base = tpl.name
        template_counts[base] = template_counts.get(base, 0) + 1
        n = template_counts[base]

        inst = spawn_enemy(tpl, decks, rnd=session_rng)
        inst.name = f"{base} {n}"

        state.add_enemy(inst)
        order.append(inst.instance_id)
        selected_id = inst.instance_id

    @mutate
    def ui_add_player() -> None:
        nonlocal selected_id, player_count

        player_count += 1
        inst = spawn_player(f"Player {player_count}")
        state.add_enemy(inst)
        order.append(inst.instance_id)
        selected_id = inst.instance_id

    @mutate
    def ui_enemy_turn() -> None:
        nonlocal active_turn_id, turn_in_progress

        e = get_selected()
        if not e or is_player(e):
            return

        if active_turn_id is not None and active_turn_id != e.instance_id:
            ui.notify("Another enemy has the active turn. End that turn first.", type="warning")
            return

        active_turn_id = e.instance_id
        turn_in_progress = True

        res = enemy_turn(e, rnd=session_rng)
        e.last_drawn = list(res.drawn)

        # Auto-apply guard immediately (so it shows right away)
        for cid in res.drawn:
            c = card_index.get(cid)
            if not c:
                continue
            for eff in c.effects:
                if eff.type == "guard":
                    apply_heal(e, guard=int(eff.amount))

    @mutate
    def ui_enemy_turn_no_draw() -> None:
        nonlocal active_turn_id, turn_in_progress

        e = get_selected()
        if not e or is_player(e):
            return

        if active_turn_id is not None and active_turn_id != e.instance_id:
            ui.notify("Another enemy has the active turn. End that turn first.", type="warning")
            return

        active_turn_id = e.instance_id
        turn_in_progress = False

        on_turn_start(e)
        on_turn_end(e)

        active_turn_id = None
        turn_in_progress = False

    @mutate
    def ui_end_turn() -> None:
        nonlocal active_turn_id, turn_in_progress

        e = get_selected()
        if not e or is_player(e):
            return

        if active_turn_id is None or active_turn_id != e.instance_id:
            ui.notify("End turn applies only to the active enemy.", type="warning")
            return
        if not turn_in_progress:
            ui.notify("Press Draw first (or use Enemy turn (no draw)).", type="warning")
            return

        end_turn(e)
        active_turn_id = None
        turn_in_progress = False

    @mutate
    def ui_next() -> None:
        nonlocal active_turn_id, turn_in_progress

        # If an enemy was active, finish their turn first (without auto-draw)
        if active_turn_id is not None:
            active_enemy = state.enemies.get(active_turn_id)
            if active_enemy and (not is_player(active_enemy)):
                if turn_in_progress:
                    end_turn(active_enemy)
                else:
                    on_turn_end(active_enemy)

            active_turn_id = None
            turn_in_progress = False

        select_next_in_order()

    @mutate
    def ui_roll_loot() -> None:
        e = get_selected()
        if not e or is_player(e):
            return
        if e.template_id == "custom":
            ui.notify("Custom enemies have no template loot.", type="warning")
            return
        roll_loot_for_instance(e.instance_id)

    # ---------- dialogs: attack/heal/custom + save/load ----------
    attack_dialog = ui.dialog()
    heal_dialog = ui.dialog()
    custom_dialog = ui.dialog()
    save_dialog = ui.dialog()
    load_dialog = ui.dialog()

    image_dialog = ui.dialog()

    def open_image_preview(src: str, title: str) -> None:
        """Open a large preview of an enemy image."""
        image_dialog.clear()
        with image_dialog:
            with ui.card().classes("p-0 w-[90vw] max-w-[1100px]"):
                with ui.row().classes("items-center justify-between p-3"):
                    ui.label(title).classes("text-lg font-semibold")
                    ui.button(icon="close", on_click=image_dialog.close).props("flat dense")
                with ui.element("div").classes("w-full max-h-[85vh] bg-black"):
                    ui.element("img").props(f"src={src}").classes("w-full h-full object-contain")
        image_dialog.open()

    def open_attack_dialog() -> None:
        attack_damage.value = 1
        mod_stab.value = False
        mod_pierce.value = False
        mod_magic_pierce.value = False
        mod_sunder.value = False

        mod_paralyse.value = False
        mod_burn.value = False
        mod_poison.value = False
        mod_slow.value = False

        attack_dialog.open()

    def open_heal_dialog() -> None:
        heal_hp.value = 0
        heal_armor.value = 0
        heal_magic.value = 0
        heal_guard.value = 0
        heal_dialog.open()

    def open_custom_dialog() -> None:
        custom_dialog.open()

    @mutate
    def ui_apply_attack() -> None:
        e = get_selected()
        if not e or is_player(e):
            attack_dialog.close()
            return

        mods = []
        if mod_stab.value:
            mods.append("stab")
        if mod_pierce.value:
            mods.append("pierce")
        if mod_magic_pierce.value:
            mods.append("magic_pierce")
        if mod_sunder.value:
            mods.append("sunder")

        # 0 damage is allowed; status can still apply
        apply_attack(e, int(attack_damage.value or 0), mods=mods)

        # status effects
        if mod_burn.value:
            add_status_stack(e, "burn", 1)
        if mod_poison.value:
            add_status_stack(e, "poison", 1)
        if mod_slow.value:
            set_transient_status(e, "slowed")
        if mod_paralyse.value:
            set_transient_status(e, "paralyzed")

        attack_dialog.close()

    @mutate
    def ui_apply_heal() -> None:
        e = get_selected()
        if not e or is_player(e):
            heal_dialog.close()
            return

        apply_heal(
            e,
            hp=int(heal_hp.value or 0),
            armor=int(heal_armor.value or 0),
            magic_armor=int(heal_magic.value or 0),
            guard=int(heal_guard.value or 0),
        )
        heal_dialog.close()

    @mutate
    def ui_add_custom_enemy() -> None:
        nonlocal selected_id

        name = str(ce_name.value or "Custom").strip() or "Custom"
        inst = spawn_custom_enemy(
            name=name,
            hp=int(ce_hp.value or 1),
            armor=int(ce_armor.value or 0),
            magic_armor=int(ce_magic.value or 0),
            draws=int(ce_draws.value or 0),
            movement=int(ce_move.value or 0),
            core_deck_id=str(ce_deck.value),
            rnd=session_rng,
        )
        state.add_enemy(inst)
        order.append(inst.instance_id)
        selected_id = inst.instance_id
        custom_dialog.close()

    # Save/Load helpers
    def do_new_session() -> None:
        new_sid = uuid.uuid4().hex[:12]
        ui.navigate.to(f"/?sid={new_sid}")

    def open_save_dialog() -> None:
        save_name.value = "session"
        save_dialog.open()

    def do_save_as() -> None:
        name = str(save_name.value or "save").strip()
        p = save_manual(name)
        save_dialog.close()
        ui.notify(f"Saved: {p.name}", type="positive")

    def refresh_load_options() -> None:
        files = list_manual_saves()
        options = {str(p): p.name for p in files}
        load_select.options = options
        load_select.value = next(iter(options.keys())) if options else None

    def open_load_dialog() -> None:
        refresh_load_options()
        load_dialog.open()

    def do_load_selected() -> None:
        val = load_select.value
        if not val:
            ui.notify("No saves found.", type="warning")
            return
        p = Path(val)
        payload = load_save_payload(p)
        if not payload:
            ui.notify("Could not load save (corrupt?).", type="negative")
            return

        load_from_payload(payload)
        autosave()
        render_overview()
        render_detail()
        load_dialog.close()
        ui.notify(f"Loaded: {p.name}", type="positive")

    # Dialog UIs
    with attack_dialog, ui.card().classes("w-[560px]"):
        ui.label("Attack enemy").classes("text-lg font-semibold")
        attack_damage = ui.number("Damage", value=1, min=0, step=1)

        ui.separator()
        ui.label("Attack modifiers (this attack only)").classes("font-semibold")
        mod_stab = ui.checkbox("Stab (ignore 1 regular)")
        mod_pierce = ui.checkbox("Pierce (ignore all regular)")
        mod_magic_pierce = ui.checkbox("Magic pierce (ignore all magic)")
        mod_sunder = ui.checkbox("Sunder (destroy 1 armor)")

        ui.separator()
        ui.label("Status effects").classes("font-semibold")
        mod_paralyse = ui.checkbox("Paralyze (draw -1 next turn)")
        mod_burn = ui.checkbox("Burn (+1 stack)")
        mod_poison = ui.checkbox("Poison (+1 stack)")
        mod_slow = ui.checkbox("Slow (halve movement until end of turn)")

        with ui.row().classes("justify-end gap-2"):
            ui.button("Cancel", on_click=attack_dialog.close).props("flat")
            ui.button("Apply", on_click=ui_apply_attack).props("color=primary")

    with heal_dialog, ui.card().classes("w-[520px]"):
        ui.label("Heal enemy").classes("text-lg font-semibold")
        heal_hp = ui.number("Heal HP", value=0, min=0, step=1)
        heal_armor = ui.number("Restore Armor", value=0, min=0, step=1)
        heal_magic = ui.number("Restore Magic Armor", value=0, min=0, step=1)
        heal_guard = ui.number("Add Guard", value=0, min=0, step=1)

        with ui.row().classes("justify-end gap-2"):
            ui.button("Cancel", on_click=heal_dialog.close).props("flat")
            ui.button("Apply", on_click=ui_apply_heal).props("color=primary")

    with custom_dialog, ui.card().classes("w-[560px]"):
        ui.label("Quick custom enemy").classes("text-lg font-semibold")
        ce_name = ui.input("Name", value="Custom").classes("w-full")

        with ui.row().classes("gap-2"):
            ce_hp = ui.number("HP", value=10, min=1, step=1).classes("w-1/3")
            ce_armor = ui.number("Armor", value=0, min=0, step=1).classes("w-1/3")
            ce_magic = ui.number("Magic armor", value=0, min=0, step=1).classes("w-1/3")

        with ui.row().classes("gap-2"):
            ce_draws = ui.number("Draws", value=1, min=0, step=1).classes("w-1/2")
            ce_move = ui.number("Movement", value=6, min=0, step=1).classes("w-1/2")

        ce_deck = ui.select(
            options={k: v.name for k, v in decks.items()},
            value=next(iter(decks.keys())),
            label="Core deck",
        ).classes("w-full")

        with ui.row().classes("justify-end gap-2"):
            ui.button("Cancel", on_click=custom_dialog.close).props("flat")
            ui.button("Add", on_click=ui_add_custom_enemy).props("color=primary")

    with save_dialog, ui.card().classes("w-[520px]"):
        ui.label("Save As").classes("text-lg font-semibold")
        save_name = ui.input("Name", value="session").classes("w-full")
        with ui.row().classes("justify-end gap-2"):
            ui.button("Cancel", on_click=save_dialog.close).props("flat")
            ui.button("Save", on_click=do_save_as).props("color=primary")

    with load_dialog, ui.card().classes("w-[680px]"):
        ui.label("Load").classes("text-lg font-semibold")
        load_select = ui.select(options={}, label="Saved games").classes("w-full")
        with ui.row().classes("justify-end gap-2"):
            ui.button("Cancel", on_click=load_dialog.close).props("flat")
            ui.button("Load", on_click=do_load_selected).props("color=primary")

    # ---------- build UI ----------
    load_or_init_current()

    # Header
    with ui.header():
        ui.label("Weavers of Power - Battle Simulator").classes("text-xl font-semibold")
        ui.badge(f"sid: {sid}").props("color=grey").classes("text-xs")

    # Save/Load/New bar
    with ui.card().classes("w-full"):
        with ui.row().classes("items-center justify-between"):
            ui.label("Session").classes("text-lg font-semibold")
            with ui.row().classes("gap-2"):
                ui.button("New", on_click=do_new_session).props("outline")
                ui.button("Save As…", on_click=open_save_dialog).props("outline")
                ui.button("Load…", on_click=open_load_dialog).props("outline")

    with ui.row().classes("w-full gap-4 items-start flex-col md:flex-row"):
        with ui.column().classes("min-w-0 w-full md:flex-1 gap-3"):
            with ui.card().classes("w-full"):
                ui.label("Round order").classes("text-lg font-semibold")
                with ui.row().classes("items-center gap-2 flex-wrap"):
                    add_select = ui.select(
                        options={k: v.name for k, v in enemy_templates.items()},
                        value=next(iter(enemy_templates.keys())) if enemy_templates else None,
                        label="Template",
                    ).classes("w-full md:w-64")

                    ui.button("Add enemy", on_click=lambda: ui_add_enemy(add_select.value)).props("color=primary")
                    ui.button("Quick custom enemy…", on_click=open_custom_dialog).props("outline")
                    ui.button("Add player", on_click=ui_add_player).props("outline")
                    ui.button("Next", on_click=ui_next).props("outline")

            enemy_grid_container = ui.column().classes("w-full")
            render_overview()

        with ui.column().classes("w-full md:w-[480px] md:shrink-0 gap-3"):
            detail_container = ui.column().classes("w-full")
            render_detail()

    autosave()


ui.run(title="Weavers of Power", reload=True)
