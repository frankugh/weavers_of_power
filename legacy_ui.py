from __future__ import annotations

from typing import Optional

from fastapi import Request
from nicegui import ui

from battle_session import BattleSessionContext, BattleSessionError, create_sid


def register_legacy_page(context: BattleSessionContext) -> None:
    @ui.page("/legacy")
    def legacy_page(request: Request):
        sid = request.query_params.get("sid")
        if not sid:
            ui.navigate.to(f"/legacy?sid={create_sid()}")
            return

        session_holder = {"session": context.load_session(sid)}

        enemy_grid_container = None
        detail_container = None

        def session():
            return session_holder["session"]

        def selected_entity():
            selected_id = session().selected_id
            if not selected_id:
                return None
            return session().state.enemies.get(selected_id)

        def notify_error(exc: Exception) -> None:
            ui.notify(str(exc), type="warning")

        def run_action(action, *, success: Optional[str] = None) -> None:
            try:
                action()
                if success:
                    ui.notify(success, type="positive")
            except BattleSessionError as exc:
                notify_error(exc)
            finally:
                render_overview()
                render_detail()

        def refresh_load_options() -> None:
            options = {save["filename"]: save["label"] for save in session().list_manual_saves()}
            load_select.options = options
            load_select.value = next(iter(options.keys())) if options else None

        def open_image_preview(src: str, title: str) -> None:
            image_dialog.clear()
            with image_dialog:
                with ui.card().classes("p-0 w-[90vw] max-w-[1100px]"):
                    with ui.row().classes("items-center justify-between p-3"):
                        ui.label(title).classes("text-lg font-semibold")
                        ui.button(icon="close", on_click=image_dialog.close).props("flat dense")
                    with ui.element("div").classes("w-full max-h-[85vh] bg-black"):
                        ui.element("img").props(f"src={src}").classes("w-full h-full object-contain")
            image_dialog.open()

        def render_overview() -> None:
            nonlocal enemy_grid_container
            if enemy_grid_container is None:
                return
            enemy_grid_container.clear()

            with enemy_grid_container:
                if not session().order:
                    ui.label("No enemies/players yet. Use Add enemy / Add player.").classes("text-gray-500")
                    return

                with ui.row().classes("w-full flex-wrap gap-3"):
                    for instance_id in session().order:
                        entity = session().state.enemies.get(instance_id)
                        if not entity:
                            continue

                        is_selected = instance_id == session().selected_id
                        is_active = instance_id == session().active_turn_id
                        is_player = session().is_player(entity)

                        classes = "w-80"
                        if is_selected:
                            classes += " ring-2 ring-blue-500"
                        if is_active:
                            classes += " ring-2 ring-green-600 bg-green-50"

                        def on_select(iid=instance_id):
                            run_action(lambda: session().select(iid))

                        with ui.card().classes(classes).on("click", on_select):
                            with ui.row().classes("items-center justify-between"):
                                ui.label(entity.name).classes("text-lg font-semibold")
                                with ui.row().classes("items-center gap-1"):
                                    if is_active:
                                        ui.badge("ACTIVE TURN").props("color=green")
                                    ui.button(
                                        icon="arrow_upward",
                                        on_click=lambda iid=instance_id: run_action(lambda: session().move_in_order(iid, -1)),
                                    ).props("flat dense")
                                    ui.button(
                                        icon="arrow_downward",
                                        on_click=lambda iid=instance_id: run_action(lambda: session().move_in_order(iid, 1)),
                                    ).props("flat dense")
                                    ui.button(
                                        icon="delete",
                                        on_click=lambda iid=instance_id: run_action(lambda: session().delete_entity(iid)),
                                    ).props("flat dense").classes("text-red-600")

                            image_src = session().image_url_for(entity)
                            is_dead = session().is_down(entity)
                            with ui.element("div").classes("relative w-full h-40 bg-gray-50 overflow-hidden"):
                                ui.element("img") \
                                    .props(f"src={image_src}") \
                                    .classes("w-full h-full object-cover object-top" + (" grayscale opacity-60" if is_dead else "")) \
                                    .on("click", lambda _=None, src=image_src, title=entity.name: open_image_preview(src, title))
                                if is_dead:
                                    ui.label("☠").classes(
                                        "absolute inset-0 flex items-center justify-center text-white text-6xl bg-black/40 pointer-events-none"
                                    )

                            if is_player:
                                ui.label("Player card").classes("text-sm text-gray-700")
                            else:
                                ui.label(
                                    f"HP {entity.hp_current}/{entity.hp_max} | "
                                    f"Armor {entity.armor_current}/{entity.armor_max} | "
                                    f"Magic {entity.magic_armor_current}/{entity.magic_armor_max}"
                                )
                                ui.label(
                                    f"Guard {entity.guard_current} | Draws {entity.draws_base} | "
                                    f"Move {session().effective_movement(entity)}"
                                )
                                ui.label(f"Statuses: {session().format_statuses(entity.statuses)}").classes("text-sm text-gray-700")
                                ui.label(
                                    f"Current draw: {session().draw_list_to_text(session().visible_draw_for(entity), max_items=3)}"
                                ).classes("text-sm text-gray-700")

                            if is_selected and (session().active_turn_id is None) and (not is_player):
                                with ui.row().classes("gap-2 mt-2 flex-wrap"):
                                    ui.button("Draw", on_click=lambda: run_action(lambda: session().draw_turn())).props("color=primary dense")
                                    ui.button("Attack enemy", on_click=open_attack_dialog).props("outline dense")
                                    ui.button("Heal enemy", on_click=open_heal_dialog).props("outline dense")

                            if is_active and (not is_player):
                                ui.button("Next", on_click=lambda: run_action(lambda: session().next_turn())).props("color=primary dense").classes("mt-2")

                            if is_player and is_selected and (session().active_turn_id is None):
                                ui.button("Next", on_click=lambda: run_action(lambda: session().next_turn())).props("color=primary dense").classes("mt-2")

        def render_detail() -> None:
            nonlocal detail_container
            if detail_container is None:
                return
            detail_container.clear()

            entity = selected_entity()
            with detail_container:
                ui.label("Selected").classes("text-xl font-semibold")
                if not entity:
                    ui.label("—").classes("text-gray-500")
                    return

                is_active = entity.instance_id == session().active_turn_id
                is_player = session().is_player(entity)
                can_draw = (session().active_turn_id is None) or is_active
                can_end = is_active and session().turn_in_progress

                with ui.card().classes("w-full"):
                    with ui.row().classes("items-start gap-4"):
                        image_src = session().image_url_for(entity)
                        is_dead = session().is_down(entity)
                        with ui.element("div").classes("relative"):
                            image_classes = "w-56 h-56 object-contain bg-gray-50" + (" grayscale opacity-60" if is_dead else "")
                            ui.element("img") \
                                .props(f"src={image_src}") \
                                .classes(image_classes) \
                                .on("click", lambda _=None, src=image_src, title=entity.name: open_image_preview(src, title))
                            if is_dead:
                                ui.label("☠").classes(
                                    "absolute inset-0 flex items-center justify-center text-white text-6xl bg-black/40 pointer-events-none"
                                )

                        with ui.column().classes("gap-1 w-full"):
                            with ui.row().classes("items-center gap-2"):
                                ui.label(f"{entity.name} (id: {entity.instance_id})").classes("text-lg font-semibold")
                                if is_active:
                                    ui.badge("ACTIVE TURN").props("color=green")

                            with ui.row().classes("gap-2 flex-wrap mt-2"):
                                if is_player:
                                    button_next = ui.button("Next", on_click=lambda: run_action(lambda: session().next_turn())).props("color=primary")
                                    if session().active_turn_id is not None:
                                        button_next.disable()
                                else:
                                    button_draw = ui.button("Draw", on_click=lambda: run_action(lambda: session().draw_turn())).props("color=primary")
                                    if not can_draw:
                                        button_draw.disable()

                                    ui.button("Next", on_click=lambda: run_action(lambda: session().next_turn())).props("color=primary")

                                    button_end = ui.button("End turn", on_click=lambda: run_action(lambda: session().end_turn_selected())).props("outline")
                                    if not can_end:
                                        button_end.disable()

                                    button_no_draw = ui.button(
                                        "Enemy turn (no draw)",
                                        on_click=lambda: run_action(lambda: session().enemy_turn_no_draw()),
                                    ).props("outline")
                                    if not can_draw:
                                        button_no_draw.disable()

                                    ui.button("Attack enemy", on_click=open_attack_dialog).props("outline")
                                    ui.button("Heal enemy", on_click=open_heal_dialog).props("outline")

                                    loot_label = "Reroll loot" if getattr(entity, "loot_rolled", False) else "Roll loot"
                                    button_loot = ui.button(loot_label, on_click=lambda: run_action(lambda: session().roll_loot_for_selected())).props("outline")
                                    if entity.template_id in ("custom", "player"):
                                        button_loot.disable()

                    ui.separator()

                    if is_player:
                        ui.label("This is a player card (no stats).").classes("text-gray-700")
                        return

                    ui.label(
                        f"HP {entity.hp_current}/{entity.hp_max} | "
                        f"Armor {entity.armor_current}/{entity.armor_max} | "
                        f"Magic {entity.magic_armor_current}/{entity.magic_armor_max}"
                    )
                    ui.label(f"Guard {entity.guard_current} | Draws {entity.draws_base} | Move {session().effective_movement(entity)}")
                    ui.label(f"Statuses: {session().format_statuses(entity.statuses)}").classes("text-sm text-gray-700")

                    ui.separator()

                    if session().visible_draw_for(entity):
                        ui.label(
                            f"Current draw: {session().draw_list_to_text(session().visible_draw_for(entity), max_items=6)}"
                        ).classes("text-sm text-gray-700")
                    else:
                        ui.label("Current draw: â€”").classes("text-sm text-gray-700")

                    ui.separator()

                    ui.label("Loot").classes("font-semibold")
                    if entity.template_id in ("custom", "player"):
                        ui.label("(No template loot)").classes("text-gray-500")
                    elif not getattr(entity, "loot_rolled", False):
                        ui.label("Not rolled yet.").classes("text-gray-700")
                    else:
                        loot = getattr(entity, "rolled_loot", {}) or {}
                        ui.label(f"Currency: {loot.get('currency', {})}")
                        ui.label(f"Resources: {loot.get('resources', {})}")
                        ui.label(f"Other: {loot.get('other', [])}")

        attack_dialog = ui.dialog()
        heal_dialog = ui.dialog()
        custom_dialog = ui.dialog()
        save_dialog = ui.dialog()
        load_dialog = ui.dialog()
        image_dialog = ui.dialog()

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

        def open_save_dialog() -> None:
            save_name.value = "session"
            save_dialog.open()

        def open_load_dialog() -> None:
            refresh_load_options()
            load_dialog.open()

        def do_new_session() -> None:
            ui.navigate.to(f"/legacy?sid={create_sid()}")

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

                def apply_attack_action():
                    run_action(
                        lambda: session().apply_attack_to_selected(
                            damage=int(attack_damage.value or 0),
                            modifiers=[
                                modifier
                                for modifier, enabled in (
                                    ("stab", mod_stab.value),
                                    ("pierce", mod_pierce.value),
                                    ("magic_pierce", mod_magic_pierce.value),
                                    ("sunder", mod_sunder.value),
                                )
                                if enabled
                            ],
                            add_burn=bool(mod_burn.value),
                            add_poison=bool(mod_poison.value),
                            add_slow=bool(mod_slow.value),
                            add_paralyze=bool(mod_paralyse.value),
                        )
                    )
                    attack_dialog.close()

                ui.button("Apply", on_click=apply_attack_action).props("color=primary")

        with heal_dialog, ui.card().classes("w-[520px]"):
            ui.label("Heal enemy").classes("text-lg font-semibold")
            heal_hp = ui.number("Heal HP", value=0, min=0, step=1)
            heal_armor = ui.number("Restore Armor", value=0, min=0, step=1)
            heal_magic = ui.number("Restore Magic Armor", value=0, min=0, step=1)
            heal_guard = ui.number("Add Guard", value=0, min=0, step=1)

            with ui.row().classes("justify-end gap-2"):
                ui.button("Cancel", on_click=heal_dialog.close).props("flat")

                def apply_heal_action():
                    run_action(
                        lambda: session().apply_heal_to_selected(
                            hp=int(heal_hp.value or 0),
                            armor=int(heal_armor.value or 0),
                            magic_armor=int(heal_magic.value or 0),
                            guard=int(heal_guard.value or 0),
                        )
                    )
                    heal_dialog.close()

                ui.button("Apply", on_click=apply_heal_action).props("color=primary")

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
                options={deck_id: deck.name for deck_id, deck in session().context.decks.items()},
                value=next(iter(session().context.decks.keys())),
                label="Core deck",
            ).classes("w-full")

            with ui.row().classes("justify-end gap-2"):
                ui.button("Cancel", on_click=custom_dialog.close).props("flat")

                def add_custom_enemy_action():
                    run_action(
                        lambda: session().add_custom_enemy(
                            name=str(ce_name.value or "Custom"),
                            hp=int(ce_hp.value or 1),
                            armor=int(ce_armor.value or 0),
                            magic_armor=int(ce_magic.value or 0),
                            draws=int(ce_draws.value or 0),
                            movement=int(ce_move.value or 0),
                            core_deck_id=str(ce_deck.value),
                        )
                    )
                    custom_dialog.close()

                ui.button("Add", on_click=add_custom_enemy_action).props("color=primary")

        with save_dialog, ui.card().classes("w-[520px]"):
            ui.label("Save As").classes("text-lg font-semibold")
            save_name = ui.input("Name", value="session").classes("w-full")

            with ui.row().classes("justify-end gap-2"):
                ui.button("Cancel", on_click=save_dialog.close).props("flat")

                def do_save_action():
                    run_action(lambda: session().save_manual(str(save_name.value or "session")), success="Saved")
                    save_dialog.close()

                ui.button("Save", on_click=do_save_action).props("color=primary")

        with load_dialog, ui.card().classes("w-[680px]"):
            ui.label("Load").classes("text-lg font-semibold")
            load_select = ui.select(options={}, label="Saved games").classes("w-full")

            with ui.row().classes("justify-end gap-2"):
                ui.button("Cancel", on_click=load_dialog.close).props("flat")

                def do_load_action():
                    if not load_select.value:
                        ui.notify("No saves found.", type="warning")
                        return
                    run_action(lambda: session().load_manual(str(load_select.value)), success="Loaded")
                    load_dialog.close()

                ui.button("Load", on_click=do_load_action).props("color=primary")

        with ui.header():
            ui.label("Weavers of Power - Battle Simulator (Legacy)").classes("text-xl font-semibold")
            ui.badge(f"sid: {sid}").props("color=grey").classes("text-xs")

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
                            options={template_id: template.name for template_id, template in session().context.enemy_templates.items()},
                            value=next(iter(session().context.enemy_templates.keys())),
                            label="Template",
                        ).classes("w-full md:w-64")

                        ui.button(
                            "Add enemy",
                            on_click=lambda: run_action(lambda: session().add_enemy_from_template(str(add_select.value))),
                        ).props("color=primary")
                        ui.button("Quick custom enemy…", on_click=open_custom_dialog).props("outline")
                        ui.button("Add player", on_click=lambda: run_action(lambda: session().add_player())).props("outline")
                        ui.button("Next", on_click=lambda: run_action(lambda: session().next_turn())).props("outline")

                enemy_grid_container = ui.column().classes("w-full")
                render_overview()

            with ui.column().classes("w-full md:w-[480px] md:shrink-0 gap-3"):
                detail_container = ui.column().classes("w-full")
                render_detail()
