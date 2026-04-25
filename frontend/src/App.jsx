import { useEffect, useRef, useState } from "react";
import { requestJson } from "./api.js";

const ATTACK_MODIFIERS = [
  { key: "stab", label: "Stab" },
  { key: "pierce", label: "Pierce" },
  { key: "magic_pierce", label: "Magic pierce" },
  { key: "sunder", label: "Sunder" },
];

const ATTACK_STATUSES = [
  { key: "burn", label: "Burn" },
  { key: "poison", label: "Poison" },
  { key: "slow", label: "Slow" },
  { key: "paralyze", label: "Paralyze" },
];

const PREMADE_TEMPLATE_IDS = ["goblin", "bandit"];
const DEFAULT_ROOM = { columns: 10, rows: 7 };
const ROOM_LIMITS = {
  minColumns: 3,
  maxColumns: 99,
  minRows: 3,
  maxRows: 99,
};

const EMPTY_ATTACK_FORM = {
  damage: 1,
  modifiers: {
    stab: false,
    pierce: false,
    magic_pierce: false,
    sunder: false,
  },
  statuses: {
    burn: false,
    poison: false,
    slow: false,
    paralyze: false,
  },
};

const EMPTY_HEAL_FORM = {
  hp: 0,
  armor: 0,
  magicArmor: 0,
  guard: 0,
};

function getSidFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("sid");
}

function setSidInUrl(sid) {
  const params = new URLSearchParams(window.location.search);
  params.set("sid", sid);
  const nextUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", nextUrl);
}

function percent(current, max) {
  if (!max) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((current / max) * 100)));
}

function barTone(value) {
  if (value > 55) {
    return "var(--tone-good)";
  }
  if (value > 25) {
    return "var(--tone-mid)";
  }
  return "var(--tone-bad)";
}

function titleCaseFromSnake(value) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatStatusLabel(statusKey, statusValue) {
  const label = titleCaseFromSnake(statusKey);
  if (statusValue && typeof statusValue === "object" && Number(statusValue.stacks) > 1) {
    return `${label} x${statusValue.stacks}`;
  }
  return label;
}

function getEntityState(entity, selectedId, activeTurnId) {
  const isSelected = entity?.instance_id === selectedId;
  const isActive = entity?.instance_id === activeTurnId;

  if (isSelected && isActive) {
    return { isSelected, isActive, label: "Selected + Active", toneClass: "state-dual" };
  }
  if (isSelected) {
    return { isSelected, isActive, label: "Selected", toneClass: "state-selected" };
  }
  if (isActive) {
    return { isSelected, isActive, label: "Active Turn", toneClass: "state-active" };
  }
  return { isSelected, isActive, label: null, toneClass: "" };
}

function getStateClassNames(prefix, entityState) {
  const classNames = [];
  if (entityState.isSelected) {
    classNames.push(`${prefix}-selected`);
  }
  if (entityState.isActive) {
    classNames.push(`${prefix}-active`);
  }
  if (entityState.isSelected && entityState.isActive) {
    classNames.push(`${prefix}-dual`);
  }
  return classNames.join(" ");
}

function orderEntities(orderIds, entities) {
  const byId = new Map(entities.map((entity) => [entity.instance_id, entity]));
  const ordered = orderIds.map((instanceId) => byId.get(instanceId)).filter(Boolean);
  const unordered = entities.filter((entity) => !orderIds.includes(entity.instance_id));
  return [...ordered, ...unordered];
}

function getPremadeTemplates(templates) {
  const byId = new Map(templates.map((template) => [template.id, template]));
  const preferred = PREMADE_TEMPLATE_IDS.map((templateId) => byId.get(templateId)).filter(Boolean);
  return preferred.length ? preferred : templates;
}

function getEntityInitial(entity) {
  return (entity?.name || "?").trim().charAt(0).toUpperCase() || "?";
}

function hasGridPosition(entity, room) {
  return (
    Number.isInteger(entity?.grid_x) &&
    Number.isInteger(entity?.grid_y) &&
    entity.grid_x >= 0 &&
    entity.grid_y >= 0 &&
    entity.grid_x < room.columns &&
    entity.grid_y < room.rows
  );
}

function positionKey(x, y) {
  return `${x}:${y}`;
}

function App() {
  const bootstrapped = useRef(false);
  const actionMenuRef = useRef(null);

  const [snapshot, setSnapshot] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState(null);
  const [customExpanded, setCustomExpanded] = useState(false);
  const [moveMode, setMoveMode] = useState(false);
  const [roomForm, setRoomForm] = useState(DEFAULT_ROOM);
  const [pendingRoomResize, setPendingRoomResize] = useState(null);
  const [saveName, setSaveName] = useState("session");
  const [saves, setSaves] = useState([]);
  const [attackForm, setAttackForm] = useState(EMPTY_ATTACK_FORM);
  const [healForm, setHealForm] = useState(EMPTY_HEAL_FORM);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [customForm, setCustomForm] = useState({
    name: "Custom",
    hp: 10,
    armor: 0,
    magicArmor: 0,
    draws: 1,
    movement: 6,
    coreDeckId: "",
  });

  useEffect(() => {
    if (!meta || customForm.coreDeckId || meta.decks.length === 0) {
      return;
    }
    setCustomForm((current) => ({ ...current, coreDeckId: meta.decks[0].id }));
  }, [customForm.coreDeckId, meta]);

  useEffect(() => {
    if (!snapshot?.room) {
      return;
    }
    setRoomForm({
      columns: snapshot.room.columns || DEFAULT_ROOM.columns,
      rows: snapshot.room.rows || DEFAULT_ROOM.rows,
    });
  }, [snapshot?.room?.columns, snapshot?.room?.rows]);

  useEffect(() => {
    setMoveMode(false);
  }, [snapshot?.selectedId, snapshot?.sid]);

  useEffect(() => {
    setActionMenuOpen(false);
  }, [snapshot?.selectedId, snapshot?.sid, modal]);

  useEffect(() => {
    if (!actionMenuOpen) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target)) {
        setActionMenuOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setActionMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionMenuOpen]);

  useEffect(() => {
    if (bootstrapped.current) {
      return;
    }
    bootstrapped.current = true;

    async function bootstrap() {
      setLoading(true);
      setError("");
      try {
        const sid = getSidFromUrl();
        const [metaPayload, snapshotPayload] = await Promise.all([
          requestJson("/api/battle/meta"),
          sid ? requestJson(`/api/battle/sessions/${sid}`) : requestJson("/api/battle/sessions", { method: "POST" }),
        ]);
        setMeta(metaPayload);
        setSnapshot(snapshotPayload);
        if (!sid) {
          setSidInUrl(snapshotPayload.sid);
        }
      } catch (bootstrapError) {
        setError(bootstrapError.message);
      } finally {
        setLoading(false);
      }
    }

    bootstrap();
  }, []);

  const orderIds = snapshot?.order || [];
  const enemies = snapshot?.enemies || [];
  const room = snapshot?.room || DEFAULT_ROOM;
  const orderedEnemies = orderEntities(orderIds, enemies);
  const selectedEntity =
    orderedEnemies.find((entity) => entity.instance_id === snapshot?.selectedId) || orderedEnemies[0] || null;
  const activeEntity = orderedEnemies.find((entity) => entity.instance_id === snapshot?.activeTurnId) || null;
  const selectedEntityState = selectedEntity ? getEntityState(selectedEntity, snapshot.selectedId, snapshot.activeTurnId) : null;
  const selectedDrawIsStored = Boolean(snapshot?.activeTurnId && selectedEntity && snapshot.activeTurnId !== selectedEntity.instance_id);
  const activeDetachedEntity =
    activeEntity && activeEntity.instance_id !== selectedEntity?.instance_id ? activeEntity : null;
  const isPlayerSelected = Boolean(selectedEntity?.is_player);
  const premadeTemplates = getPremadeTemplates(meta?.enemyTemplates || []);

  const canDraw = Boolean(
    selectedEntity &&
      !isPlayerSelected &&
      !snapshot.turnInProgress &&
      (!snapshot?.activeTurnId || snapshot.activeTurnId === selectedEntity.instance_id),
  );
  const canRedraw = Boolean(
    selectedEntity &&
      !isPlayerSelected &&
      snapshot.turnInProgress &&
      snapshot?.activeTurnId === selectedEntity.instance_id,
  );
  const canAttackOrHeal = Boolean(selectedEntity && !isPlayerSelected);
  const canRollLoot = Boolean(
    selectedEntity &&
      !isPlayerSelected &&
      selectedEntity.template_id !== "custom" &&
      selectedEntity.template_id !== "player",
  );
  const selectedStatuses = Object.entries(selectedEntity?.statuses || {});
  const selectedHasDraw = Boolean(selectedEntity?.current_draw_text?.length);
  const selectedHasLoot = Boolean(selectedEntity?.loot_rolled);
  const canOpenActionMore = Boolean(canRedraw || canAttackOrHeal || canRollLoot);

  function closeModal() {
    setModal(null);
    setCustomExpanded(false);
    setPendingRoomResize(null);
  }

  async function applySnapshotRequest(path, options = {}, successMessage = "") {
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(path, options);
      setSnapshot(payload);
      setNotice(successMessage);
      return payload;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createNewSession() {
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson("/api/battle/sessions", { method: "POST" });
      setSnapshot(payload);
      setNotice("Started a new session");
      setSidInUrl(payload.sid);
      closeModal();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshSaveList() {
    if (!snapshot?.sid) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(`/api/battle/sessions/${snapshot.sid}/saves`);
      setSaves(payload.saves || []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function openLoadModal() {
    await refreshSaveList();
    setModal("load");
  }

  function openAddUnitModal() {
    setCustomExpanded(false);
    setModal("add");
  }

  async function handleSelect(instanceId) {
    if (busy) {
      return;
    }
    if (snapshot?.selectedId === instanceId) {
      setMoveMode((current) => !current);
      return;
    }
    const payload = await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/select`, {
      method: "POST",
      body: JSON.stringify({ instanceId }),
    });
    if (payload) {
      setMoveMode(false);
    }
  }

  async function handleMove(instanceId, direction) {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/order`,
      {
        method: "POST",
        body: JSON.stringify({ instanceId, direction }),
      },
      direction < 0 ? "Moved unit up" : "Moved unit down",
    );
  }

  async function handleMoveSelectedToCell(x, y) {
    if (!selectedEntity) {
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${selectedEntity.instance_id}/position`,
      {
        method: "POST",
        body: JSON.stringify({ x, y }),
      },
      `Moved ${selectedEntity.name}`,
    );
    if (payload) {
      setMoveMode(false);
    }
  }

  function normalizeRoomFormValue(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  async function submitRoomResize(columns, rows, autoPlaceOutOfBounds = false) {
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(`/api/battle/sessions/${snapshot.sid}/room`, {
        method: "POST",
        body: JSON.stringify({ columns, rows, autoPlaceOutOfBounds }),
      });
      setSnapshot(payload);
      setNotice(`Battle map set to ${payload.room.columns}x${payload.room.rows}`);
      setPendingRoomResize(null);
      setModal(null);
      setMoveMode(false);
      return payload;
    } catch (requestError) {
      if (!autoPlaceOutOfBounds && requestError.message.includes("Resize would move")) {
        setPendingRoomResize({ columns, rows, message: requestError.message });
        setModal("room-warning");
        setNotice("");
        setError("");
      } else {
        setError(requestError.message);
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleRoomSubmit(event) {
    event.preventDefault();
    const columns = normalizeRoomFormValue(roomForm.columns, room.columns);
    const rows = normalizeRoomFormValue(roomForm.rows, room.rows);
    await submitRoomResize(columns, rows, false);
  }

  async function handleDeleteEntity(instanceId) {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${instanceId}`,
      {
        method: "DELETE",
      },
      "Entity removed",
    );
  }

  async function handleAddEnemyFromTemplate(templateId) {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/enemies`,
      {
        method: "POST",
        body: JSON.stringify({ templateId }),
      },
      "Enemy added",
    );
    if (payload) {
      closeModal();
    }
  }

  async function handleAddPlayer() {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/players`,
      {
        method: "POST",
      },
      "Player added",
    );
    if (payload) {
      closeModal();
    }
  }

  async function handleAddCustomEnemy(event) {
    event.preventDefault();
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/enemies`,
      {
        method: "POST",
        body: JSON.stringify({ custom: customForm }),
      },
      "Custom enemy added",
    );
    if (payload) {
      closeModal();
    }
  }

  async function handleDraw() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/turn/draw`,
      {
        method: "POST",
      },
      "Cards drawn",
    );
  }

  async function handleRedraw() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/turn/redraw`,
      {
        method: "POST",
      },
      "Cards redrawn",
    );
  }

  async function handleNext() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/turn/next`,
      {
        method: "POST",
      },
      "Advanced round order",
    );
  }

  async function handleRollLoot() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/loot`,
      {
        method: "POST",
      },
      "Loot rolled",
    );
  }

  async function handleAttackSubmit(event) {
    event.preventDefault();
    const modifiers = Object.entries(attackForm.modifiers)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key);
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/attack`,
      {
        method: "POST",
        body: JSON.stringify({
          damage: Number(attackForm.damage),
          modifiers,
          burn: attackForm.statuses.burn,
          poison: attackForm.statuses.poison,
          slow: attackForm.statuses.slow,
          paralyze: attackForm.statuses.paralyze,
        }),
      },
      "Attack applied",
    );
    if (payload) {
      closeModal();
      setAttackForm(EMPTY_ATTACK_FORM);
    }
  }

  async function handleHealSubmit(event) {
    event.preventDefault();
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/heal`,
      {
        method: "POST",
        body: JSON.stringify({
          hp: Number(healForm.hp),
          armor: Number(healForm.armor),
          magicArmor: Number(healForm.magicArmor),
          guard: Number(healForm.guard),
        }),
      },
      "Healing applied",
    );
    if (payload) {
      closeModal();
      setHealForm(EMPTY_HEAL_FORM);
    }
  }

  async function handleSaveSubmit(event) {
    event.preventDefault();
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/saves`,
      {
        method: "POST",
        body: JSON.stringify({ name: saveName }),
      },
      "Manual save created",
    );
    if (payload) {
      closeModal();
    }
  }

  async function handleLoadSubmit(filename) {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/load`,
      {
        method: "POST",
        body: JSON.stringify({ filename }),
      },
      "Manual save loaded",
    );
    if (payload) {
      closeModal();
    }
  }

  if (loading) {
    return <div className="screen-state">Loading battle simulator...</div>;
  }

  if (!snapshot || !meta) {
    return (
      <div className="screen-state">
        <div>Unable to load battle simulator.</div>
        {error ? <div className="screen-state-error">{error}</div> : null}
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="shell-noise" />

      <header className="topbar">
        <div className="brand-block">
          <div className="brand-kicker">Weavers of Power</div>
          <div className="brand-title">Battle Simulator</div>
        </div>

        <div className="round-cluster">
          <span className="pill">Round {snapshot.round}</span>
          <span className={`pill ${selectedEntity ? "pill-selected" : "pill-muted"}`}>
            {selectedEntity ? `Selected: ${selectedEntity.name}` : "Selected: none"}
          </span>
          {activeEntity ? (
            <span className={`pill pill-turn ${selectedEntityState?.isActive ? "pill-turn-current" : ""}`}>
              {`Active Turn: ${activeEntity.name}`}
            </span>
          ) : null}
          <span className="pill pill-muted">sid {snapshot.sid}</span>
        </div>

        <div className="menu-actions">
          <button className="menu-button" onClick={createNewSession} disabled={busy}>
            New
          </button>
          <button
            className="menu-button"
            onClick={() => {
              setSaveName("session");
              setModal("save");
            }}
            disabled={busy}
          >
            Save
          </button>
          <button className="menu-button" onClick={openLoadModal} disabled={busy}>
            Load
          </button>
          <a className="menu-button menu-link" href={snapshot.sid ? `/legacy?sid=${snapshot.sid}` : "/legacy"}>
            Legacy
          </a>
        </div>
      </header>

      <main className="main-grid">
        <section className="stage-column">
          <section className="battle-stage">
            <BattleRoom
              room={room}
              roomForm={roomForm}
              setRoomForm={setRoomForm}
              entities={orderedEnemies}
              selectedEntity={selectedEntity}
              selectedId={snapshot.selectedId}
              activeTurnId={snapshot.activeTurnId}
              moveMode={moveMode}
              busy={busy}
              onRoomSubmit={handleRoomSubmit}
              onSelect={handleSelect}
              onMoveToCell={handleMoveSelectedToCell}
            />
          </section>

          <section className="action-bar">
            <div className="action-copy">
              <div className="action-kicker">Action bar</div>
              <div className="action-title">
                {selectedEntity ? `${selectedEntity.name} is in focus` : "Select or add a combatant"}
              </div>
            </div>

            <div className="action-controls">
              <div className="action-buttons">
                <button
                  className="primary-button"
                  onClick={() => {
                    setActionMenuOpen(false);
                    handleDraw();
                  }}
                  disabled={!canDraw || busy}
                >
                  Draw
                </button>
                <button
                  className="primary-button"
                  onClick={() => {
                    setActionMenuOpen(false);
                    handleNext();
                  }}
                  disabled={!snapshot.order.length || busy}
                >
                  Next
                </button>
                <button
                  className={`secondary-button ${moveMode ? "move-button-active" : ""}`.trim()}
                  onClick={() => {
                    setActionMenuOpen(false);
                    setMoveMode((current) => !current);
                  }}
                  disabled={!selectedEntity || busy}
                >
                  {moveMode ? "Cancel Move" : "Move"}
                </button>
                <button
                  className="secondary-button"
                  onClick={() => {
                    setActionMenuOpen(false);
                    setAttackForm(EMPTY_ATTACK_FORM);
                    setModal("attack");
                  }}
                  disabled={!canAttackOrHeal || busy}
                >
                  Attack enemy
                </button>
              </div>

              <div className="action-more" ref={actionMenuRef}>
                <button
                  className={`secondary-button ${actionMenuOpen ? "action-more-trigger-open" : ""}`.trim()}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={actionMenuOpen}
                  onClick={() => setActionMenuOpen((current) => !current)}
                  disabled={!canOpenActionMore || busy}
                >
                  More
                </button>

                {actionMenuOpen ? (
                  <div className="action-more-menu" role="menu" aria-label="More actions">
                    <button
                      className="secondary-button action-more-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setActionMenuOpen(false);
                        handleRedraw();
                      }}
                      disabled={!canRedraw || busy}
                    >
                      Redraw
                    </button>
                    <button
                      className="secondary-button action-more-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setActionMenuOpen(false);
                        setHealForm(EMPTY_HEAL_FORM);
                        setModal("heal");
                      }}
                      disabled={!canAttackOrHeal || busy}
                    >
                      Heal enemy
                    </button>
                    <button
                      className="secondary-button action-more-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setActionMenuOpen(false);
                        handleRollLoot();
                      }}
                      disabled={!canRollLoot || busy}
                    >
                      Roll loot
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="roster-strip">
            {orderedEnemies.length ? (
              orderedEnemies.map((entity) => {
                const entityState = getEntityState(entity, snapshot.selectedId, snapshot.activeTurnId);
                const rosterIndex = orderedEnemies.indexOf(entity);
                const canMoveLeft = rosterIndex > 0;
                const canMoveRight = rosterIndex < orderedEnemies.length - 1;

                return (
                  <div key={entity.instance_id} className="roster-card-container">
                    <button
                      type="button"
                      className="roster-card-arrow roster-card-arrow-left"
                      aria-label={`Move ${entity.name} left`}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleMove(entity.instance_id, -1);
                      }}
                      disabled={!canMoveLeft || busy}
                    >
                      <ChevronLeftIcon />
                    </button>

                    <div
                      className={`roster-card ${entity.is_player ? "roster-player" : ""} ${getStateClassNames("roster", entityState)}`.trim()}
                      data-state={entityState.toneClass || "state-idle"}
                      role="button"
                      tabIndex={busy ? -1 : 0}
                      aria-disabled={busy}
                      onClick={() => {
                        if (!busy) {
                          handleSelect(entity.instance_id);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (busy || (event.key !== "Enter" && event.key !== " ")) {
                          return;
                        }
                        event.preventDefault();
                        handleSelect(entity.instance_id);
                      }}
                    >
                      <div className={`roster-portrait ${entity.is_player ? "roster-portrait-player" : ""}`.trim()}>
                        <img src={entity.image_url} alt={entity.name} />
                      </div>
                      <div className="roster-name">{entity.name}</div>
                      <StateBadge label={entityState.label} toneClass={entityState.toneClass} className="state-badge-compact" />
                      {!entity.is_player ? (
                        <div className="roster-bar">
                          <span
                            className="roster-bar-fill"
                            style={{
                              width: `${percent(entity.hp_current, entity.hp_max)}%`,
                              background: barTone(percent(entity.hp_current, entity.hp_max)),
                            }}
                          />
                        </div>
                      ) : null}

                      <div className="roster-tools">
                        <button
                          type="button"
                          className="roster-tool roster-tool-danger"
                          aria-label={`Delete ${entity.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleDeleteEntity(entity.instance_id);
                          }}
                          disabled={busy}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="roster-card-arrow roster-card-arrow-right"
                      aria-label={`Move ${entity.name} right`}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleMove(entity.instance_id, 1);
                      }}
                      disabled={!canMoveRight || busy}
                    >
                      <ChevronRightIcon />
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="subtle-copy">The roster strip will populate when you add combatants.</div>
            )}
            <button
              className="roster-card roster-card-add"
              type="button"
              aria-label="Add unit"
              onClick={openAddUnitModal}
              disabled={busy}
            >
              <div className="roster-add-icon">
                <PlusIcon />
              </div>
              <div className="roster-add-label">New Unit</div>
            </button>
          </section>
        </section>

        <aside className="right-rail">
          <div className="unit-inspector">
            <Panel title="Unit Inspector">
              {selectedEntity ? (
                <div className={`selected-summary ${selectedEntity.is_player ? "selected-summary-player" : ""}`.trim()}>
                  <div className="selected-summary-top">
                    <div className="selected-kicker">
                      {selectedEntity.is_player ? "Player" : titleCaseFromSnake(selectedEntity.template_id)}
                    </div>
                    <div className="selected-name-row">
                      <div className="selected-name">{selectedEntity.name}</div>
                      <StateBadge
                        label={selectedEntityState?.label}
                        toneClass={selectedEntityState?.toneClass}
                        className="state-badge-compact"
                      />
                      {selectedEntity.is_player ? <span className="badge">Player</span> : <span className="badge badge-enemy">Enemy</span>}
                      {selectedEntity.is_down ? <span className="badge badge-down">Down</span> : null}
                    </div>
                    <div className="selected-meta-row">
                      {!selectedEntity.is_player && selectedEntity.status_text && selectedEntity.status_text !== "-" ? (
                        <span className="selected-meta">{selectedEntity.status_text}</span>
                      ) : null}
                      {activeDetachedEntity ? <span className="selected-meta">{`Turn: ${activeDetachedEntity.name}`}</span> : null}
                    </div>
                  </div>

                  {selectedHasDraw ? (
                    <div className="unit-inspector-section unit-inspector-draw-preview">
                      <div className="selected-draw-label">{selectedDrawIsStored ? "Previous draw" : "Current draw"}</div>
                      <CardList items={selectedEntity.current_draw_text} compact />
                    </div>
                  ) : null}

                  <div className="unit-stat-strip">
                    <span className="unit-stat-chip unit-stat-hp">
                      <span>HP</span>
                      <strong>{selectedEntity.is_player ? "Player" : `${selectedEntity.hp_current}/${selectedEntity.hp_max}`}</strong>
                    </span>
                    <span className="unit-stat-chip">
                      <span>Armor</span>
                      <strong>{selectedEntity.is_player ? "-" : `${selectedEntity.armor_current}/${selectedEntity.armor_max}`}</strong>
                    </span>
                    <span className="unit-stat-chip unit-stat-arcane">
                      <span>M Armor</span>
                      <strong>
                        {selectedEntity.is_player
                          ? "-"
                          : `${selectedEntity.magic_armor_current}/${selectedEntity.magic_armor_max}`}
                      </strong>
                    </span>
                    <span className="unit-stat-chip unit-stat-guard">
                      <span>Guard</span>
                      <strong>{selectedEntity.is_player ? "-" : `${selectedEntity.guard_current}`}</strong>
                    </span>
                    <span className="unit-stat-chip">
                      <span>Draw</span>
                      <strong>{selectedEntity.is_player ? "-" : `${selectedEntity.draws_base}`}</strong>
                    </span>
                    <span className="unit-stat-chip unit-stat-move">
                      <span>Move</span>
                      <strong>{selectedEntity.is_player ? "-" : `${selectedEntity.effective_movement}`}</strong>
                    </span>
                  </div>

                  {!selectedEntity.is_player ? (
                    <>
                      <ProgressBar label="Vitality" value={percent(selectedEntity.hp_current, selectedEntity.hp_max)} compact />
                      {selectedStatuses.length ? (
                        <div className="selected-statuses">
                          {selectedStatuses.map(([statusKey, statusValue]) => (
                            <span className="status-pill" key={statusKey}>
                              {formatStatusLabel(statusKey, statusValue)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {selectedHasLoot ? (
                    <div className="unit-inspector-section">
                      <div className="selected-draw-label">Loot</div>
                      <div className="loot-grid">
                        <LootBlock label="Currency" value={JSON.stringify(selectedEntity.rolled_loot?.currency || {})} />
                        <LootBlock label="Resources" value={JSON.stringify(selectedEntity.rolled_loot?.resources || {})} />
                        <LootBlock label="Other" value={(selectedEntity.rolled_loot?.other || []).join(", ") || "-"} />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="subtle-copy">Select a combatant to inspect draw, loot, and stats.</div>
              )}
            </Panel>
          </div>

          <div className="right-rail-scroll">
            <Panel
              title="Initiative"
              actions={
                <button className="icon-button" type="button" aria-label="Add unit" onClick={openAddUnitModal} disabled={busy}>
                  <PlusIcon />
                </button>
              }
            >
            <div className="initiative-list initiative-list-compact">
              {orderedEnemies.map((entity) => {
                const entityState = getEntityState(entity, snapshot.selectedId, snapshot.activeTurnId);
                const entityIndex = orderIds.indexOf(entity.instance_id);
                const canMoveEntityUp = entityIndex > 0;
                const canMoveEntityDown = entityIndex >= 0 && entityIndex < orderIds.length - 1;
                return (
                  <div className="initiative-card" key={entity.instance_id}>
                    <button
                      type="button"
                      className={`initiative-row initiative-row-tools ${entity.is_player ? "initiative-player" : ""} ${getStateClassNames("initiative", entityState)}`.trim()}
                      data-state={entityState.toneClass || "state-idle"}
                      onClick={() => handleSelect(entity.instance_id)}
                    >
                      <div className="initiative-left">
                        <div className={`initiative-thumb ${entity.is_player ? "initiative-thumb-player" : ""}`.trim()}>
                          <img src={entity.image_url} alt="" aria-hidden="true" />
                        </div>
                        <div className="initiative-copy">
                          <div className="initiative-name-row">
                            <span className="initiative-name">{entity.name}</span>
                            <StateBadge
                              label={entityState.label}
                              toneClass={entityState.toneClass}
                              className="state-badge-compact"
                            />
                          </div>
                          <span className="initiative-meta">
                            {entity.is_player ? "Player" : titleCaseFromSnake(entity.template_id)}
                          </span>
                        </div>
                      </div>
                      {!entity.is_player ? (
                        <span className="initiative-hp">
                          {entity.hp_current}/{entity.hp_max}
                        </span>
                      ) : (
                        <span className="initiative-hp">Player</span>
                      )}
                    </button>

                    <div className="initiative-order-tools">
                      <button
                        type="button"
                        className="initiative-tool initiative-tool-arrow"
                        aria-label={`Move ${entity.name} up`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMove(entity.instance_id, -1);
                        }}
                        disabled={!canMoveEntityUp || busy}
                      >
                        <span className="initiative-arrow-glyph" aria-hidden="true">
                          ▲
                        </span>
                      </button>
                      <button
                        type="button"
                        className="initiative-tool initiative-tool-arrow"
                        aria-label={`Move ${entity.name} down`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMove(entity.instance_id, 1);
                        }}
                        disabled={!canMoveEntityDown || busy}
                      >
                        <span className="initiative-arrow-glyph" aria-hidden="true">
                          ▼
                        </span>
                      </button>
                    </div>

                    <div className="initiative-tools">
                      <button
                        type="button"
                        className="initiative-tool initiative-tool-danger"
                        aria-label={`Delete ${entity.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDeleteEntity(entity.instance_id);
                        }}
                        disabled={busy}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title="Combat Log">
            <div className="log-list">
              {snapshot.combatLog.length ? (
                snapshot.combatLog.map((entry, index) => (
                  <div className="log-entry" key={`${entry}-${index}`}>
                    {entry}
                  </div>
                ))
              ) : (
                <div className="subtle-copy">No combat events yet.</div>
              )}
            </div>
          </Panel>
          </div>

          {(error || notice) && (
            <div className={`status-banner status-banner-rail ${error ? "status-error" : "status-notice"}`}>
              <span>{error || notice}</span>
              <button
                className="status-dismiss"
                onClick={() => {
                  setError("");
                  setNotice("");
                }}
              >
                Close
              </button>
            </div>
          )}
        </aside>
      </main>

      <ModalShell
        open={modal === "attack"}
        title="Attack enemy"
        subtitle="Applies damage and optional status effects to the selected enemy card."
        onClose={closeModal}
      >
        <form className="modal-form" onSubmit={handleAttackSubmit}>
          <label className="field">
            <span>Damage</span>
            <input
              type="number"
              min="0"
              value={attackForm.damage}
              onChange={(event) => setAttackForm((current) => ({ ...current, damage: event.target.value }))}
            />
          </label>

          <div className="form-section">
            <div className="form-section-title">Attack modifiers</div>
            <div className="toggle-grid">
              {ATTACK_MODIFIERS.map((modifier) => (
                <ToggleField
                  key={modifier.key}
                  label={modifier.label}
                  checked={attackForm.modifiers[modifier.key]}
                  onChange={(checked) =>
                    setAttackForm((current) => ({
                      ...current,
                      modifiers: { ...current.modifiers, [modifier.key]: checked },
                    }))
                  }
                />
              ))}
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Status effects</div>
            <div className="toggle-grid">
              {ATTACK_STATUSES.map((status) => (
                <ToggleField
                  key={status.key}
                  label={status.label}
                  checked={attackForm.statuses[status.key]}
                  onChange={(checked) =>
                    setAttackForm((current) => ({
                      ...current,
                      statuses: { ...current.statuses, [status.key]: checked },
                    }))
                  }
                />
              ))}
            </div>
          </div>

          <div className="modal-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              Apply attack
            </button>
            <button className="secondary-button" type="button" onClick={closeModal}>
              Cancel
            </button>
          </div>
        </form>
      </ModalShell>

      <ModalShell
        open={modal === "heal"}
        title="Heal enemy"
        subtitle="Restores the selected enemy card using the backend heal model."
        onClose={closeModal}
      >
        <form className="modal-form" onSubmit={handleHealSubmit}>
          <div className="field-grid">
            <label className="field">
              <span>HP</span>
              <input
                type="number"
                min="0"
                value={healForm.hp}
                onChange={(event) => setHealForm((current) => ({ ...current, hp: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Armor</span>
              <input
                type="number"
                min="0"
                value={healForm.armor}
                onChange={(event) => setHealForm((current) => ({ ...current, armor: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Magic armor</span>
              <input
                type="number"
                min="0"
                value={healForm.magicArmor}
                onChange={(event) => setHealForm((current) => ({ ...current, magicArmor: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>Guard</span>
              <input
                type="number"
                min="0"
                value={healForm.guard}
                onChange={(event) => setHealForm((current) => ({ ...current, guard: event.target.value }))}
              />
            </label>
          </div>

          <div className="modal-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              Apply healing
            </button>
            <button className="secondary-button" type="button" onClick={closeModal}>
              Cancel
            </button>
          </div>
        </form>
      </ModalShell>

      <ModalShell
        open={modal === "add"}
        title="Add Unit"
        onClose={closeModal}
        size="wide"
      >
        <div className="panel-body add-unit-body">
          <section className="add-unit-section">
            <div className="form-section-title">Premade Enemies</div>
            <div className="premade-grid">
              {premadeTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="premade-card"
                  onClick={() => handleAddEnemyFromTemplate(template.id)}
                  disabled={busy}
                >
                  <div className="premade-card-art">
                    <img src={template.imageUrl} alt={template.name} />
                  </div>
                  <div className="premade-card-copy">
                    <div className="premade-card-kicker">Premade enemy</div>
                    <div className="premade-card-name">{template.name}</div>
                    <div className="premade-card-meta">{titleCaseFromSnake(template.id)}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="add-unit-section">
            <div className="form-section-title">Add Player</div>
            <button type="button" className="secondary-button add-player-card" onClick={handleAddPlayer} disabled={busy}>
              Add player card
            </button>
          </section>

          <section className="add-unit-section">
            <div className="add-unit-custom-header">
              <div>
                <div className="form-section-title">Custom Enemy</div>
                <div className="subtle-copy">Compact runtime enemy using an existing deck.</div>
              </div>
              <button
                type="button"
                className="small-button"
                onClick={() => setCustomExpanded((current) => !current)}
                disabled={busy || meta.decks.length === 0}
              >
                {customExpanded ? "Hide" : "Show"}
              </button>
            </div>

            {customExpanded ? (
              <form className="modal-form add-unit-custom-form" onSubmit={handleAddCustomEnemy}>
                <div className="field-grid">
                  <label className="field field-full">
                    <span>Name</span>
                    <input
                      type="text"
                      value={customForm.name}
                      onChange={(event) => setCustomForm((current) => ({ ...current, name: event.target.value }))}
                    />
                  </label>
                  <label className="field">
                    <span>HP</span>
                    <input
                      type="number"
                      min="1"
                      value={customForm.hp}
                      onChange={(event) => setCustomForm((current) => ({ ...current, hp: Number(event.target.value) }))}
                    />
                  </label>
                  <label className="field">
                    <span>Armor</span>
                    <input
                      type="number"
                      min="0"
                      value={customForm.armor}
                      onChange={(event) => setCustomForm((current) => ({ ...current, armor: Number(event.target.value) }))}
                    />
                  </label>
                  <label className="field">
                    <span>Magic armor</span>
                    <input
                      type="number"
                      min="0"
                      value={customForm.magicArmor}
                      onChange={(event) =>
                        setCustomForm((current) => ({ ...current, magicArmor: Number(event.target.value) }))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Draws</span>
                    <input
                      type="number"
                      min="0"
                      value={customForm.draws}
                      onChange={(event) => setCustomForm((current) => ({ ...current, draws: Number(event.target.value) }))}
                    />
                  </label>
                  <label className="field">
                    <span>Movement</span>
                    <input
                      type="number"
                      min="0"
                      value={customForm.movement}
                      onChange={(event) =>
                        setCustomForm((current) => ({ ...current, movement: Number(event.target.value) }))
                      }
                    />
                  </label>
                  <label className="field field-full">
                    <span>Core deck</span>
                    <select
                      value={customForm.coreDeckId}
                      onChange={(event) => setCustomForm((current) => ({ ...current, coreDeckId: event.target.value }))}
                    >
                      {meta.decks.map((deck) => (
                        <option key={deck.id} value={deck.id}>
                          {deck.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="modal-actions">
                  <button className="primary-button" type="submit" disabled={busy}>
                    Add custom enemy
                  </button>
                  <button className="secondary-button" type="button" onClick={closeModal}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
          </section>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "save"}
        title="Manual save"
        subtitle="Stores the current autosaved session as a named manual snapshot."
        onClose={closeModal}
      >
        <form className="modal-form" onSubmit={handleSaveSubmit}>
          <label className="field">
            <span>Save name</span>
            <input type="text" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              Save snapshot
            </button>
            <button className="secondary-button" type="button" onClick={closeModal}>
              Cancel
            </button>
          </div>
        </form>
      </ModalShell>

      <ModalShell
        open={modal === "load"}
        title="Load manual save"
        subtitle="Loads a saved snapshot into the current session id."
        onClose={closeModal}
      >
        <div className="save-list">
          {saves.length ? (
            saves.map((save) => (
              <button
                className="save-row"
                key={save.filename}
                onClick={() => handleLoadSubmit(save.filename)}
                disabled={busy}
              >
                <span>{save.label}</span>
                <span>{save.savedAt || save.filename}</span>
              </button>
            ))
          ) : (
            <div className="subtle-copy">No manual saves found for this workspace.</div>
          )}
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "room-warning" && Boolean(pendingRoomResize)}
        title="Resize battle map"
        subtitle="Some units are outside the new dimensions."
        onClose={closeModal}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">{pendingRoomResize?.message}</div>
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={() =>
                pendingRoomResize
                  ? submitRoomResize(pendingRoomResize.columns, pendingRoomResize.rows, true)
                  : null
              }
            >
              Auto-place and resize
            </button>
            <button className="secondary-button" type="button" onClick={closeModal}>
              Cancel
            </button>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}

function BattleRoom({
  room,
  roomForm,
  setRoomForm,
  entities,
  selectedEntity,
  selectedId,
  activeTurnId,
  moveMode,
  busy,
  onRoomSubmit,
  onSelect,
  onMoveToCell,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const placedEntities = entities.filter((entity) => hasGridPosition(entity, room));
  const unplacedEntities = entities.filter((entity) => !hasGridPosition(entity, room));
  const occupantByPosition = new Map(
    placedEntities.map((entity) => [positionKey(entity.grid_x, entity.grid_y), entity]),
  );
  const cells = Array.from({ length: room.rows }, (_, y) =>
    Array.from({ length: room.columns }, (_, x) => ({ x, y, entity: occupantByPosition.get(positionKey(x, y)) })),
  ).flat();

  function handleCellClick(x, y, entity) {
    if (entity) {
      onSelect(entity.instance_id);
      return;
    }
    if (moveMode && selectedEntity && !busy) {
      onMoveToCell(x, y);
    }
  }

  async function handleSettingsSubmit(event) {
    await onRoomSubmit(event);
    setSettingsOpen(false);
  }

  return (
    <div className="battle-map">
      <div className="map-settings">
        <button
          className="map-settings-trigger"
          type="button"
          aria-expanded={settingsOpen}
          aria-label="Map size settings"
          onClick={() => setSettingsOpen((current) => !current)}
        >
          {room.columns} x {room.rows}
        </button>

        {settingsOpen ? (
          <form className="map-settings-panel" onSubmit={handleSettingsSubmit}>
            <label className="map-size-field">
              <span>Rows</span>
              <input
                aria-label="Map rows"
                type="number"
                min={ROOM_LIMITS.minRows}
                max={ROOM_LIMITS.maxRows}
                value={roomForm.rows}
                onChange={(event) => setRoomForm((current) => ({ ...current, rows: Number(event.target.value) }))}
              />
            </label>
            <label className="map-size-field">
              <span>Cols</span>
              <input
                aria-label="Map columns"
                type="number"
                min={ROOM_LIMITS.minColumns}
                max={ROOM_LIMITS.maxColumns}
                value={roomForm.columns}
                onChange={(event) =>
                  setRoomForm((current) => ({ ...current, columns: Number(event.target.value) }))
                }
              />
            </label>
            <button className="small-button map-settings-apply" type="submit" disabled={busy}>
              Apply
            </button>
          </form>
        ) : null}
      </div>

      <div className="battle-map-scroll">
        <div
          className="battle-map-grid"
          role="grid"
          aria-label="Battle room grid"
          style={{ gridTemplateColumns: `repeat(${room.columns}, minmax(38px, 50px))` }}
        >
          {cells.map(({ x, y, entity }) => {
            const entityState = entity ? getEntityState(entity, selectedId, activeTurnId) : null;
            const canMoveTarget = moveMode && selectedEntity && !entity && !busy;
            const isEven = (x + y) % 2 === 0;
            return (
              <button
                key={positionKey(x, y)}
                type="button"
                className={[
                  "map-cell",
                  isEven ? "map-cell-even" : "map-cell-odd",
                  entity ? "map-cell-occupied" : "",
                  canMoveTarget ? "map-cell-move-target" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={entity ? `Cell ${x + 1}, ${y + 1}: ${entity.name}` : `Cell ${x + 1}, ${y + 1}`}
                aria-disabled={!entity && !canMoveTarget}
                onClick={() => handleCellClick(x, y, entity)}
              >
                {entity ? (
                  <MapToken entity={entity} entityState={entityState} />
                ) : (
                  <span className="map-cell-coordinates" aria-hidden="true">
                    {x + 1},{y + 1}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {unplacedEntities.length ? (
        <div className="unplaced-strip">
          <span className="unplaced-label">Unplaced</span>
          <div className="unplaced-list">
            {unplacedEntities.map((entity) => {
              const entityState = getEntityState(entity, selectedId, activeTurnId);
              return (
                <button
                  key={entity.instance_id}
                  type="button"
                  className={`unplaced-unit ${entity.is_player ? "unplaced-player" : ""} ${getStateClassNames("unplaced", entityState)}`.trim()}
                  data-state={entityState.toneClass || "state-idle"}
                  onClick={() => onSelect(entity.instance_id)}
                >
                  <span className={`unplaced-initial ${entity.is_player ? "unplaced-initial-player" : ""}`.trim()}>
                    {getEntityInitial(entity)}
                  </span>
                  <span>{entity.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MapToken({ entity, entityState }) {
  const hpValue = entity.is_player ? 100 : percent(entity.hp_current, entity.hp_max);
  const statusKeys = Object.keys(entity.statuses || {});

  return (
    <div
      className={`map-token ${entity.is_player ? "map-token-player-unit" : ""} ${getStateClassNames("map-token", entityState)} ${entity.is_down ? "map-token-down" : ""}`.trim()}
      data-state={entityState?.toneClass || "state-idle"}
    >
      <span className="map-token-initial" aria-hidden="true">
        {getEntityInitial(entity)}
      </span>
      {entity.image_url ? <img className="map-token-image" src={entity.image_url} alt="" aria-hidden="true" /> : null}
      <span className={`map-token-type ${entity.is_player ? "map-token-player" : "map-token-enemy"}`} aria-hidden="true" />
      {entity.is_down ? <span className="map-token-down-label">Down</span> : null}
      {!entity.is_player ? (
        <span className="map-token-health" aria-hidden="true">
          <span style={{ width: `${hpValue}%`, background: barTone(hpValue) }} />
        </span>
      ) : null}
      {statusKeys.length ? (
        <span className="map-token-statuses" aria-hidden="true">
          {statusKeys.slice(0, 3).map((statusKey) => (
            <span key={statusKey}>{statusKey.charAt(0).toUpperCase()}</span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function Panel({ title, detail, actions, children }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <div className="panel-title">{title}</div>
          {detail ? <div className="panel-detail">{detail}</div> : null}
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

function MetricCard({ label, value }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SelectedStat({ label, value, tone = "" }) {
  return (
    <div className={`selected-stat ${tone}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProgressBar({ label, value, compact = false }) {
  return (
    <div className={`progress-block ${compact ? "progress-compact" : ""}`}>
      <div className="progress-copy">
        <span>{label}</span>
        <strong>{value}%</strong>
      </div>
      <div className="progress-track">
        <span
          className="progress-fill"
          style={{ width: `${value}%`, background: barTone(value) }}
        />
      </div>
    </div>
  );
}

function CardList({ items, compact = false }) {
  return (
    <div className={`card-list ${compact ? "card-list-compact" : ""}`}>
      {items.map((item, index) => (
        <div className={`draw-card ${compact ? "draw-card-compact" : ""}`} key={`${item}-${index}`}>
          {item}
        </div>
      ))}
    </div>
  );
}

function LootBlock({ label, value }) {
  return (
    <div className="loot-block">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StateBadge({ label, toneClass, className = "" }) {
  if (!label) {
    return null;
  }

  return <span className={`state-badge ${toneClass} ${className}`.trim()}>{label}</span>;
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.25v9.5" />
      <path d="M3.25 8h9.5" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 9.75 8 5.25l4.5 4.5" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 6.25 4.5 4.5 4.5-4.5" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.75 3.5 5.25 8l4.5 4.5" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m6.25 3.5 4.5 4.5-4.5 4.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.75 3.5h4.5" />
      <path d="M4.5 4.75h7" />
      <path d="M6.25 2.5h3.5l.5 1h-4.5z" />
      <path d="M5.25 4.75v6.25c0 .69.56 1.25 1.25 1.25h3c.69 0 1.25-.56 1.25-1.25V4.75" />
      <path d="M6.75 6.5v4" />
      <path d="M9.25 6.5v4" />
    </svg>
  );
}

function ToggleField({ label, checked, onChange }) {
  return (
    <label className={`toggle-field ${checked ? "toggle-active" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function ModalShell({ open, title, subtitle, onClose, children, size = "default" }) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-shell ${size === "wide" ? "modal-shell-wide" : ""}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="panel-title">{title}</div>
            {subtitle ? <div className="panel-detail">{subtitle}</div> : null}
          </div>
          <button className="small-button" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default App;
