import { useEffect, useMemo, useRef, useState } from "react";
import { requestJson } from "./api.js";
import BattleMapSurface from "./BattleMapSurface.jsx";
import { pickSearchFlavour } from "./roomSearchFlavour.js";

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

const DEFAULT_ROOM = { columns: 10, rows: 7 };
const MAP_MODES = {
  IDLE: "idle",
  MOVE: "move",
  REPOSITION: "reposition",
  GM_REPOSITION: "gm-reposition",
  GM_DUNGEON: "gm-dungeon",
};

const GM_DUNGEON_PALETTES = ["floor", "void"];
const GM_DUNGEON_TOOLS = {
  BRUSH: "brush",
  RECTANGLE: "rectangle",
};
const GM_DUNGEON_INTERACTION_MODES = {
  DRAW: "draw",
  SELECT: "select",
  DRAG: "drag",
};
const GM_DUNGEON_DRAW_SUBMODES = {
  TERRAIN: "terrain",
  WALLS: "walls",
};
const GM_DUNGEON_WALL_PALETTES = ["wall", "door", "secret_door", "erase"];
const RECTANGLE_PALETTES = new Set(["floor", "void"]);
const RECTANGLE_CONFIRM_LIMIT = 2500;
const DISPLAY_BRIGHTNESS_STORAGE_KEY = "weavers-display-brightness";
const DISPLAY_BRIGHTNESS_DEFAULT = 115;
const DISPLAY_BRIGHTNESS_MIN = 100;
const DISPLAY_BRIGHTNESS_MAX = 160;
const DISPLAY_BRIGHTNESS_STEP = 5;
const DRAW_REVEAL_TIMING = {
  enterMs: 80,
  holdMs: 3200,
  settleMs: 900,
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
  toughness: 0,
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

function clampDisplayBrightness(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return DISPLAY_BRIGHTNESS_DEFAULT;
  }
  return Math.max(DISPLAY_BRIGHTNESS_MIN, Math.min(DISPLAY_BRIGHTNESS_MAX, Math.round(numericValue)));
}

function getInitialDisplayBrightness() {
  if (typeof window === "undefined") {
    return DISPLAY_BRIGHTNESS_DEFAULT;
  }
  try {
    const storedValue = window.localStorage.getItem(DISPLAY_BRIGHTNESS_STORAGE_KEY);
    return storedValue == null ? DISPLAY_BRIGHTNESS_DEFAULT : clampDisplayBrightness(storedValue);
  } catch {
    return DISPLAY_BRIGHTNESS_DEFAULT;
  }
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

function normalizeSearch(value) {
  return value.trim().toLowerCase();
}

function getTemplateCategory(template) {
  return template?.category || "Uncategorized";
}

function filterTemplates(templates, search, category) {
  const normalizedSearch = normalizeSearch(search);
  return templates.filter((template) => {
    const matchesCategory = category === "All" || getTemplateCategory(template) === category;
    const haystack = `${template.name} ${template.id}`.toLowerCase();
    return matchesCategory && (!normalizedSearch || haystack.includes(normalizedSearch));
  });
}

function getDrawRevealEntity(payload) {
  if (!payload?.enemies?.length) {
    return null;
  }
  const revealId = payload.activeTurnId || payload.selectedId;
  return payload.enemies.find((entity) => entity.instance_id === revealId) || null;
}

function drawGroupsForEntity(entity) {
  const groups = Array.isArray(entity?.current_draw_groups)
    ? entity.current_draw_groups
        .map((group, index) => ({
          label: group?.label || `Draw ${index + 1}`,
          items: Array.isArray(group?.items) ? group.items : [],
          summary: group?.summary || null,
        }))
        .filter((group) => group.items.length > 0)
    : [];
  if (groups.length > 0) {
    return groups;
  }
  const items = Array.isArray(entity?.current_draw_text) ? entity.current_draw_text : [];
  return items.length > 0 ? [{ label: "Draw 1", items, summary: entity?.current_draw_summary || null }] : [];
}

function getEntityInitial(entity) {
  return (entity?.name || "?").trim().charAt(0).toUpperCase() || "?";
}

function hasGridPosition(entity, room, dungeon = null) {
  if (dungeon?.tiles) {
    return Number.isInteger(entity?.grid_x) && Number.isInteger(entity?.grid_y);
  }
  return (
    Number.isInteger(entity?.grid_x) &&
    Number.isInteger(entity?.grid_y) &&
    entity.grid_x >= 0 &&
    entity.grid_y >= 0 &&
    entity.grid_x < room.columns &&
    entity.grid_y < room.rows
  );
}

function isTemplateLootable(entity) {
  return Boolean(entity && !entity.is_player && entity.template_id !== "custom" && entity.template_id !== "player");
}

function App() {
  const bootstrapped = useRef(false);
  const actionMenuRef = useRef(null);
  const unitContextMenuRef = useRef(null);
  const repositionReturnModeRef = useRef(null);

  const [snapshot, setSnapshot] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState(null);
  const [flavourText, setFlavourText] = useState(null);
  const [addUnitTab, setAddUnitTab] = useState("premade");
  const [templateSearch, setTemplateSearch] = useState("");
  const [templateCategory, setTemplateCategory] = useState("All");
  const [mapMode, setMapMode] = useState(MAP_MODES.IDLE);
  const [pendingDashMove, setPendingDashMove] = useState(null);
  const [saveName, setSaveName] = useState("session");
  const [saves, setSaves] = useState([]);
  const [attackForm, setAttackForm] = useState(EMPTY_ATTACK_FORM);
  const [healForm, setHealForm] = useState(EMPTY_HEAL_FORM);
  const [drawExactCount, setDrawExactCount] = useState(1);
  const [strengthenCount, setStrengthenCount] = useState(1);
  const [actionWarningAcknowledged, setActionWarningAcknowledged] = useState(false);
  const [pendingActionFn, setPendingActionFn] = useState(null);
  const [helpTargets, setHelpTargets] = useState([]);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [unitContextMenu, setUnitContextMenu] = useState(null);
  const [previewEntityId, setPreviewEntityId] = useState(null);
  const [drawReveal, setDrawReveal] = useState(null);
  const [drawDetail, setDrawDetail] = useState(null);
  const [woundNotice, setWoundNotice] = useState(null);
  const [pendingWoundRemove, setPendingWoundRemove] = useState(null);
  const [customForm, setCustomForm] = useState({
    name: "Custom",
    toughness: 10,
    armor: 0,
    magicArmor: 0,
    power: 1,
    movement: 6,
    coreDeckId: "",
  });
  const [pcForm, setPcForm] = useState({
    name: "",
    playerDeckId: "",
    toughness: 4,
    armor: 1,
    magicArmor: 0,
    power: 4,
    movement: 6,
    baseGuard: 1,
    initiativeModifier: 2,
  });
  const [initiativeModes, setInitiativeModes] = useState({});
  const [initiativeOpenReason, setInitiativeOpenReason] = useState("manual");
  const [selectedUnitIds, setSelectedUnitIds] = useState([]);
  const [gmDungeonInteractionMode, setGmDungeonInteractionMode] = useState(GM_DUNGEON_INTERACTION_MODES.DRAW);
  const [gmDungeonPalette, setGmDungeonPalette] = useState("floor");
  const [gmDungeonTool, setGmDungeonTool] = useState(GM_DUNGEON_TOOLS.BRUSH);
  const [gmDungeonDrawSubmode, setGmDungeonDrawSubmode] = useState(GM_DUNGEON_DRAW_SUBMODES.TERRAIN);
  const [gmDungeonWallPalette, setGmDungeonWallPalette] = useState("wall");
  const [highlightedRoomId, setHighlightedRoomId] = useState(null);
  const [gmSelectedSecretDoorKey, setGmSelectedSecretDoorKey] = useState(null);
  const [gmSecretDcInput, setGmSecretDcInput] = useState("");
  const [gmSecretDoorDefaultDc, setGmSecretDoorDefaultDc] = useState(2);
  const [pendingLargeTileEdit, setPendingLargeTileEdit] = useState(null);
  const [displayBrightness, setDisplayBrightness] = useState(getInitialDisplayBrightness);

  useEffect(() => {
    try {
      window.localStorage.setItem(DISPLAY_BRIGHTNESS_STORAGE_KEY, String(displayBrightness));
    } catch {
      // Local storage is a convenience only; the slider should keep working without it.
    }
  }, [displayBrightness]);

  useEffect(() => {
    if (!meta || customForm.coreDeckId || meta.decks.length === 0) {
      return;
    }
    setCustomForm((current) => ({ ...current, coreDeckId: meta.decks[0].id }));
  }, [customForm.coreDeckId, meta]);

  useEffect(() => {
    if (!meta || pcForm.playerDeckId || !meta.playerDecks?.length) {
      return;
    }
    const defaultDeck = meta.playerDecks.find((deck) => deck.id === "human_fighter_lvl1") || meta.playerDecks[0];
    setPcForm((current) => ({ ...current, playerDeckId: defaultDeck.id }));
  }, [pcForm.playerDeckId, meta]);

  useEffect(() => {
    setMapMode(MAP_MODES.IDLE);
    setSelectedUnitIds([]);
  }, [snapshot?.sid]);

  useEffect(() => {
    setMapMode((current) =>
      current === MAP_MODES.GM_REPOSITION || current === MAP_MODES.GM_DUNGEON ? current : MAP_MODES.IDLE,
    );
  }, [snapshot?.selectedId, snapshot?.activeTurnId]);

  useEffect(() => {
    const validIds = new Set((snapshot?.enemies || []).map((entity) => entity.instance_id));
    setSelectedUnitIds((current) => current.filter((instanceId) => validIds.has(instanceId)));
  }, [snapshot?.enemies]);

  useEffect(() => {
    setActionMenuOpen(false);
  }, [snapshot?.selectedId, snapshot?.sid, modal]);

  useEffect(() => {
    setUnitContextMenu(null);
  }, [snapshot?.sid, modal]);

  useEffect(() => {
    if (!drawReveal) {
      return undefined;
    }

    if (drawReveal.sticky && drawReveal.phase === "hold") {
      return undefined;
    }

    const nextPhase =
      drawReveal.phase === "enter" ? "hold" : drawReveal.phase === "hold" ? "settle" : null;
    const delay =
      drawReveal.phase === "enter"
        ? DRAW_REVEAL_TIMING.enterMs
        : drawReveal.phase === "hold"
          ? DRAW_REVEAL_TIMING.holdMs
          : DRAW_REVEAL_TIMING.settleMs;

    const timer = window.setTimeout(() => {
      setDrawReveal((current) => {
        if (current?.key !== drawReveal.key) {
          return current;
        }
        return nextPhase ? { ...current, phase: nextPhase } : null;
      });
    }, delay);

    return () => {
      window.clearTimeout(timer);
    };
  }, [drawReveal?.key, drawReveal?.phase, drawReveal?.sticky]);

  useEffect(() => {
    if (!drawReveal || drawReveal.phase === "settle") {
      return undefined;
    }

    function settleRevealOnPointerDown(event) {
      if (event.target?.closest?.(".draw-reveal-panel")) {
        return;
      }
      setDrawReveal((current) =>
        current?.key === drawReveal.key && current.phase !== "settle" ? { ...current, phase: "settle" } : current,
      );
    }

    window.addEventListener("pointerdown", settleRevealOnPointerDown, true);
    return () => window.removeEventListener("pointerdown", settleRevealOnPointerDown, true);
  }, [drawReveal?.key, drawReveal?.phase]);

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
    if (!unitContextMenu) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (unitContextMenuRef.current && !unitContextMenuRef.current.contains(event.target)) {
        setUnitContextMenu(null);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setUnitContextMenu(null);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [unitContextMenu]);

  useEffect(() => {
    if (snapshot?.pendingNewRound) {
      setModal("new-round");
    }
  }, [snapshot?.pendingNewRound]);

  useEffect(() => {
    if (snapshot?.pendingSearch?.hasFate) {
      setModal("search-resolve");
    }
  }, [snapshot?.pendingSearch?.hasFate]);

  useEffect(() => {
    setActionWarningAcknowledged(false);
    setPendingActionFn(null);
  }, [snapshot?.activeTurnId]);

  useEffect(() => {
    const notice = snapshot?.turnSkipNotice;
    if (notice && notice.length > 0) {
      setNotice(`Surprised and skipped: ${notice.join(", ")}`);
    }
  }, [snapshot?.turnSkipNotice]);

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
  const contextMenuEntity = unitContextMenu
    ? orderedEnemies.find((entity) => entity.instance_id === unitContextMenu.entityId) || null
    : null;
  const previewEntity = previewEntityId
    ? orderedEnemies.find((entity) => entity.instance_id === previewEntityId) || null
    : null;
  const selectedEntityState = selectedEntity ? getEntityState(selectedEntity, snapshot.selectedId, snapshot.activeTurnId) : null;
  const selectedDrawIsStored = Boolean(snapshot?.activeTurnId && selectedEntity && snapshot.activeTurnId !== selectedEntity.instance_id);
  const activeDetachedEntity =
    activeEntity && activeEntity.instance_id !== selectedEntity?.instance_id ? activeEntity : null;
  const isPlayerSelected = Boolean(selectedEntity?.is_player);
  const selectedIsDown = Boolean(selectedEntity?.is_down);
  const selectedIsKo = Boolean(selectedEntity?.is_ko);
  const selectedPowerDrawUsed = Boolean(selectedEntity?.power_draw_used);
  const selectedWoundCounts = selectedEntity?.wound_counts || { hand: 0, discard: 0, draw_pile: 0, total: 0 };
  const movementState = snapshot?.movementState || null;
  const dungeon = snapshot?.dungeon || null;
  const selectedIsActive = Boolean(selectedEntity && snapshot?.activeTurnId === selectedEntity.instance_id);
  const hasActiveTurn = Boolean(snapshot?.activeTurnId);
  const pendingNewRound = Boolean(snapshot?.pendingNewRound);
  const hasStartableUnit = orderedEnemies.some((entity) => !entity.is_down);
  const turnAdvanceLabel = hasActiveTurn ? "Next" : pendingNewRound ? "Start Round" : "Start encounter";
  const canAdvanceTurn = Boolean(hasActiveTurn || hasStartableUnit || pendingNewRound);
  const selectedMovementBase =
    selectedIsActive && movementState?.entityId === selectedEntity?.instance_id
      ? Number(movementState.baseMovement)
      : Number(selectedEntity?.effective_movement || 0);
  const selectedMovementUsed =
    selectedIsActive && movementState?.entityId === selectedEntity?.instance_id
      ? Number(movementState.movementUsed)
      : 0;
  const selectedMovementRemaining = Math.max(0, selectedMovementBase * 2 - selectedMovementUsed);
  const canUseMove = Boolean(
    selectedEntity &&
      selectedIsActive &&
      !selectedIsDown &&
      hasGridPosition(selectedEntity, room, dungeon) &&
      selectedMovementRemaining > 0,
  );
  const canReposition = Boolean(selectedEntity);
  const isGmRepositionMode = mapMode === MAP_MODES.GM_REPOSITION;
  const isGmDungeonMode = mapMode === MAP_MODES.GM_DUNGEON;
  const canUseGmReposition = orderedEnemies.length > 0;
  const fogOfWarEnabled = dungeon?.fogOfWarEnabled ?? true;
  const visibleRoomIds = new Set(dungeon?.visibleRoomIds || []);
  const revealedRoomIdSet = new Set(dungeon?.revealedRoomIds || []);

  useEffect(() => {
    if (!RECTANGLE_PALETTES.has(gmDungeonPalette) && gmDungeonTool === GM_DUNGEON_TOOLS.RECTANGLE) {
      setGmDungeonTool(GM_DUNGEON_TOOLS.BRUSH);
    }
  }, [gmDungeonPalette, gmDungeonTool]);

  function isEntityVisible(entity) {
    return !dungeon || !fogOfWarEnabled || entity.is_player || visibleRoomIds.has(entity.room_id);
  }

  const visibleSelectedEntity = selectedEntity && isEntityVisible(selectedEntity) ? selectedEntity : null;
  const copySourceEntity =
    selectedUnitIds.length === 1 ? orderedEnemies.find((entity) => entity.instance_id === selectedUnitIds[0]) || null : null;
  const canCopySelectedUnit = Boolean(isGmDungeonMode && gmDungeonInteractionMode === GM_DUNGEON_INTERACTION_MODES.SELECT && copySourceEntity && !copySourceEntity.is_player);

  const adjacentDoors = useMemo(() => {
    if (!dungeon?.walls || !selectedEntity || selectedEntity.grid_x == null || selectedEntity.grid_y == null) return [];
    const { grid_x: sx, grid_y: sy } = selectedEntity;
    const candidates = [
      { x: sx,     y: sy,     side: "e" },
      { x: sx - 1, y: sy,     side: "e" },
      { x: sx,     y: sy,     side: "s" },
      { x: sx,     y: sy - 1, side: "s" },
    ];
    return candidates
      .map(({ x, y, side }) => ({ x, y, side, key: `${x},${y},${side}` }))
      .filter(({ key }) => {
        const wall = dungeon.walls[key];
        const isDoor = wall?.wall_type === "door";
        const isDiscoveredSecret = wall?.wall_type === "secret_door" && wall?.secret_discovered;
        return (isDoor || isDiscoveredSecret) && (dungeon.linkedDoors || {})[key];
      });
  }, [dungeon, selectedEntity?.grid_x, selectedEntity?.grid_y, selectedEntity?.instance_id]);
  const activeDrawAttacks = activeEntity?.current_draw_attacks || [];
  const quickAttackAlreadyUsed = Boolean(activeEntity?.quick_attack_used);
  const hasQuickAttackTarget = Boolean(
    activeEntity &&
      selectedEntity &&
      !activeEntity.is_player &&
      snapshot.turnInProgress &&
      activeEntity.instance_id !== selectedEntity.instance_id &&
      !selectedIsDown &&
      activeDrawAttacks.length > 0,
  );
  const canQuickAttack = hasQuickAttackTarget && !quickAttackAlreadyUsed;

  const canDraw = Boolean(
    selectedEntity &&
      !selectedIsDown &&
      selectedIsActive &&
      (isPlayerSelected ? !selectedPowerDrawUsed : !snapshot.turnInProgress),
  );
  const canDrawExact = Boolean(selectedEntity && isPlayerSelected && !selectedIsDown && selectedIsActive);
  const playerActionsUsed = (selectedEntity?.actions_used ?? 0) + (snapshot?.movementState?.dashUsed ? 1 : 0);
  const pcEntitiesInRange = isPlayerSelected && selectedEntity?.grid_x != null
    ? orderedEnemies.filter(
        (e) =>
          e.is_player &&
          e.instance_id !== selectedEntity.instance_id &&
          !e.is_down &&
          e.grid_x != null &&
          e.grid_y != null &&
          Math.max(
            Math.abs(e.grid_x - selectedEntity.grid_x),
            Math.abs(e.grid_y - selectedEntity.grid_y),
          ) <= 1,
      )
    : [];
  const canHelp = isPlayerSelected && !selectedIsDown && pcEntitiesInRange.length > 0;

  const pendingSearch = snapshot?.pendingSearch ?? null;
  const currentPcRoomId = selectedEntity?.room_id ?? null;
  const roomAlreadySearched = Boolean(currentPcRoomId && (dungeon?.searchedRoomIds || []).includes(currentPcRoomId));
  const canSearch = Boolean(
    isPlayerSelected &&
      !selectedIsDown &&
      dungeon &&
      !roomAlreadySearched &&
      !pendingSearch &&
      (snapshot?.activeTurnId == null || snapshot?.activeTurnId === selectedEntity?.instance_id),
  );

  const adjacentSuspects = useMemo(() => {
    if (!isPlayerSelected || selectedIsDown) return [];
    if (snapshot?.activeTurnId != null && snapshot.activeTurnId !== selectedEntity?.instance_id) return [];
    if (!dungeon?.secretSuspects?.length || !selectedEntity || selectedEntity.grid_x == null) return [];
    // Build room → cell set map to mirror the backend room-side cell logic
    const roomCellSet = {};
    (dungeon.rooms || []).forEach((r) => {
      r.cells.forEach((c) => { roomCellSet[`${c[0]},${c[1]}`] = r.room_id; });
    });
    return dungeon.secretSuspects.filter((s) => {
      if (s.exhausted) return false;
      const parts = s.edge_key?.split(",");
      if (!parts || parts.length !== 3) return false;
      const ex = parseInt(parts[0], 10);
      const ey = parseInt(parts[1], 10);
      const es = parts[2];
      const bx = es === "e" ? ex + 1 : ex;
      const by = es === "s" ? ey + 1 : ey;
      // Use the room-side cell (matching backend interact_suspect logic)
      let rx = ex, ry = ey;
      if (s.room_id && roomCellSet[`${bx},${by}`] === s.room_id) {
        rx = bx; ry = by;
      }
      const dist = Math.max(Math.abs(selectedEntity.grid_x - rx), Math.abs(selectedEntity.grid_y - ry));
      return dist <= 1;
    });
  }, [dungeon?.secretSuspects, dungeon?.rooms, isPlayerSelected, selectedIsDown, selectedEntity?.grid_x, selectedEntity?.grid_y, selectedEntity?.instance_id, snapshot?.activeTurnId]);
  const canShed = isPlayerSelected && !selectedIsDown && (selectedEntity?.wounds_in_hand ?? 0) > 0;
  const canRedraw = Boolean(
    selectedEntity &&
      !selectedIsDown &&
      snapshot.turnInProgress &&
      snapshot?.activeTurnId === selectedEntity.instance_id,
  ) && (!isPlayerSelected || selectedPowerDrawUsed);
  const canDiscardWound = Boolean(isPlayerSelected && Number(selectedWoundCounts.hand) > 0);
  const canRemoveWound = Boolean(isPlayerSelected && Number(selectedWoundCounts.total) > 0);
  const removeWoundNeedsDeckConfirm = Boolean(
    isPlayerSelected &&
      Number(selectedWoundCounts.hand) === 0 &&
      Number(selectedWoundCounts.discard) === 0 &&
      Number(selectedWoundCounts.draw_pile) > 0,
  );
  const canAttackOrHeal = Boolean(visibleSelectedEntity && !selectedIsDown);
  const selectedTargetNoun = isPlayerSelected ? "player" : "enemy";
  const canRollLoot = isTemplateLootable(visibleSelectedEntity);
  const canDisengage = Boolean(isPlayerSelected && !selectedIsDown);
  const canContextRollLoot = Boolean(contextMenuEntity?.is_down && !contextMenuEntity?.loot_rolled && isTemplateLootable(contextMenuEntity));
  const canContextQuickAttack = Boolean(
    contextMenuEntity &&
      activeEntity &&
      !activeEntity.is_player &&
      snapshot.turnInProgress &&
      contextMenuEntity.instance_id !== activeEntity.instance_id &&
      !contextMenuEntity.is_down &&
      !quickAttackAlreadyUsed &&
      activeDrawAttacks.length > 0,
  );
  const selectedStatuses = Object.entries(selectedEntity?.statuses || {});
  const selectedDrawGroups = [...drawGroupsForEntity(selectedEntity)].reverse();
  const selectedHasDraw = selectedDrawGroups.length > 0;
  const selectedHasLoot = Boolean(selectedEntity?.loot_rolled);
  const canOpenActionMore = Boolean(canRedraw || canAttackOrHeal || canRollLoot || canReposition || canDisengage || canHelp);
  const sessionHasHistory = Boolean(snapshot?.canUndo || snapshot?.canRedo || snapshot?.undoDepth || snapshot?.redoDepth);
  const canRollInitiative = Boolean(snapshot?.canRollInitiative) && orderIds.length > 0;
  const initiativeTargetRound = snapshot?.initiativeTargetRound ?? null;
  const initiativeRolledRound = snapshot?.initiativeRolledRound ?? null;
  const initiativeRolledForTarget =
    initiativeTargetRound !== null && initiativeRolledRound === initiativeTargetRound;
  const allTemplates = meta?.enemyTemplates || [];
  const templateCategories = useMemo(
    () => ["All", ...Array.from(new Set(allTemplates.map(getTemplateCategory))).sort((a, b) => a.localeCompare(b))],
    [allTemplates],
  );
  const shownTemplates = useMemo(
    () => filterTemplates(allTemplates, templateSearch, templateCategory),
    [allTemplates, templateSearch, templateCategory],
  );
  const selectedDrawPreviewHighlighted = Boolean(
    drawReveal?.phase === "settle" && selectedEntity?.instance_id === drawReveal.entityId,
  );

  function closeModal() {
    setModal(null);
    setAddUnitTab("premade");
    setTemplateSearch("");
    setTemplateCategory("All");
    setPendingDashMove(null);
    setPendingLargeTileEdit(null);
    setDrawDetail(null);
    setPreviewEntityId(null);
    setWoundNotice(null);
    setPendingWoundRemove(null);
  }

  function showDrawReveal(payload, kind) {
    const entity = getDrawRevealEntity(payload);
    const groups = drawGroupsForEntity(entity);
    const latestGroup = groups[groups.length - 1] || null;
    const items = entity?.is_player && latestGroup ? latestGroup.items : entity?.current_draw_text || [];
    if (!entity || !items.length) {
      return;
    }

    setDrawReveal({
      key: `${kind}-${entity.instance_id}-${Date.now()}`,
      entityId: entity.instance_id,
      entityName: entity.name,
      items,
      groups: entity.is_player && latestGroup ? [latestGroup] : [],
      sticky: Boolean(entity.is_player),
      kind,
      phase: "enter",
    });
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

  function requestNewSession() {
    if (!sessionHasHistory) {
      createNewSession();
      return;
    }
    setModal("new-session-confirm");
  }

  async function handleUndo() {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/undo`,
      {
        method: "POST",
      },
      "Undid last action",
    );
    if (payload) {
      setMapMode((current) => (current === MAP_MODES.GM_DUNGEON ? current : MAP_MODES.IDLE));
    }
  }

  async function handleRedo() {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/redo`,
      {
        method: "POST",
      },
      "Redid last action",
    );
    if (payload) {
      setMapMode((current) => (current === MAP_MODES.GM_DUNGEON ? current : MAP_MODES.IDLE));
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
    setAddUnitTab("premade");
    setTemplateSearch("");
    setTemplateCategory("All");
    setModal("add");
  }

  function toggleGmRepositionMode() {
    setActionMenuOpen(false);
    setUnitContextMenu(null);
    if (isGmRepositionMode) {
      setSelectedUnitIds([]);
      setMapMode(MAP_MODES.IDLE);
      return;
    }
    setSelectedUnitIds(selectedEntity ? [selectedEntity.instance_id] : []);
    setMapMode(MAP_MODES.GM_REPOSITION);
  }

  function toggleGmDungeonMode() {
    setActionMenuOpen(false);
    setUnitContextMenu(null);
    if (isGmDungeonMode) {
      exitGmDungeonMode();
    } else {
      setGmDungeonInteractionMode(GM_DUNGEON_INTERACTION_MODES.DRAW);
      setSelectedUnitIds(selectedEntity ? [selectedEntity.instance_id] : []);
      setMapMode(MAP_MODES.GM_DUNGEON);
    }
  }

  function setDungeonInteractionMode(mode) {
    setGmDungeonInteractionMode(mode);
    if (mode === GM_DUNGEON_INTERACTION_MODES.SELECT && selectedUnitIds.length === 0 && selectedEntity) {
      setSelectedUnitIds([selectedEntity.instance_id]);
    }
  }

  async function exitGmDungeonMode() {
    const payload = await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/analyze`, { method: "POST" });
    if (!payload) return;
    const fog = payload?.dungeon?.fogOfWarEnabled ?? true;
    const hasVisible = (payload?.dungeon?.visibleRoomIds?.length ?? 0) > 0;
    if (fog && !hasVisible) {
      setModal("dungeon-exit-confirm");
      return;
    }
    setSelectedUnitIds([]);
    setMapMode(MAP_MODES.IDLE);
  }

  async function submitTileEdit(tileType, cells, options = {}) {
    if (!snapshot?.sid || cells.length === 0) return null;
    if (!options.confirmed && cells.length > RECTANGLE_CONFIRM_LIMIT) {
      setPendingLargeTileEdit({ tileType, cells, count: cells.length });
      setModal("large-tile-edit-confirm");
      return null;
    }
    return applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/tiles`, {
      method: "POST",
      body: JSON.stringify({ tileType, cells }),
    });
  }

  async function confirmLargeTileEdit() {
    if (!pendingLargeTileEdit) return;
    const edit = pendingLargeTileEdit;
    setPendingLargeTileEdit(null);
    await submitTileEdit(edit.tileType, edit.cells, { confirmed: true });
    closeModal();
  }

  async function submitAnalyzeDungeon() {
    await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/analyze`, { method: "POST" });
  }

  async function submitWallEdit(wallType, edges) {
    if (!snapshot?.sid || edges.length === 0) return null;
    const body = { wallType, edges };
    if (wallType === "secret_door") {
      body.secretDc = gmSecretDoorDefaultDc;
    }
    return applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/walls`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async function handleToggleDoor({ x, y, side, key }) {
    const isOpen = dungeon?.walls?.[key]?.door_open;
    await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/doors/state`, {
      method: "POST",
      body: JSON.stringify({ x, y, side, open: !isOpen }),
    });
  }

  function showSearchFlavour(payload) {
    const text = pickSearchFlavour(payload);
    if (text) {
      setFlavourText(text);
      setModal("search-flavour");
    }
  }

  async function handleStartSearch() {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/dungeon/search/start`,
      { method: "POST" },
    );
    if (!payload) return;
    showDrawReveal(payload, "draw");
    if (payload.pendingSearch?.hasFate) {
      setModal("search-resolve");
    } else {
      const resolved = await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/dungeon/search/resolve`,
        { method: "POST", body: JSON.stringify({ useWillpower: false }) },
      );
      showSearchFlavour(resolved);
    }
  }

  async function handleResolveSearch(useWillpower) {
    const resolvePath = pendingSearch?.kind === "suspect"
      ? "dungeon/suspects/resolve"
      : "dungeon/search/resolve";
    closeModal();
    const resolved = await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/${resolvePath}`, {
      method: "POST",
      body: JSON.stringify({ useWillpower }),
    });
    showSearchFlavour(resolved);
  }

  async function handleInteractSuspect(edgeKey) {
    const payload = await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/suspects/interact`, {
      method: "POST",
      body: JSON.stringify({ edgeKey }),
    });
    if (!payload) return;
    showDrawReveal(payload, "draw");
    if (payload.pendingSearch?.hasFate) {
      setModal("search-resolve");
    } else {
      const resolved = await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/dungeon/suspects/resolve`,
        { method: "POST", body: JSON.stringify({ useWillpower: false }) },
      );
      showSearchFlavour(resolved);
    }
  }

  async function handleGmRevealSecretDoor(edgeKey) {
    const parts = edgeKey.split(",");
    if (parts.length !== 3) return;
    const [x, y, side] = parts;
    await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/secret-doors/reveal`, {
      method: "POST",
      body: JSON.stringify({ x: parseInt(x, 10), y: parseInt(y, 10), side }),
    });
    setGmSelectedSecretDoorKey(null);
  }

  async function handleGmSetSecretDc(edgeKey) {
    const parts = edgeKey.split(",");
    if (parts.length !== 3) return;
    const [x, y, side] = parts;
    const dc = parseInt(gmSecretDcInput, 10);
    if (isNaN(dc) || dc < 0) return;
    await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/secret-doors/dc`, {
      method: "POST",
      body: JSON.stringify({ x: parseInt(x, 10), y: parseInt(y, 10), side, dc }),
    });
  }

  async function submitFogToggle(enabled) {
    await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/settings`, {
      method: "POST",
      body: JSON.stringify({ fogOfWarEnabled: enabled }),
    });
  }

  async function submitRoomRevealed(roomId, revealed) {
    await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/rooms/${roomId}/revealed`, {
      method: "POST",
      body: JSON.stringify({ revealed }),
    });
  }

  async function handleSelect(instanceId, options = {}) {
    if (busy) {
      return;
    }
    setUnitContextMenu(null);
    const preserveMapMode = Boolean(options.preserveMapMode);
    const syncLocalSelection = options.syncLocalSelection !== false;
    if (preserveMapMode && syncLocalSelection) {
      setSelectedUnitIds([instanceId]);
    }
    if (snapshot?.selectedId === instanceId) {
      if (!preserveMapMode && snapshot?.activeTurnId === instanceId && canUseMove) {
        setMapMode((current) => (current === MAP_MODES.MOVE ? MAP_MODES.IDLE : MAP_MODES.MOVE));
      }
      return;
    }
    const payload = await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/select`, {
      method: "POST",
      body: JSON.stringify({ instanceId }),
    });
    if (payload) {
      setMapMode((current) => (preserveMapMode ? current : MAP_MODES.IDLE));
    }
  }

  function normalizeSelectedUnitIds(instanceIds) {
    const allowedIds = new Set(orderedEnemies.map((entity) => entity.instance_id));
    const nextIds = [];
    for (const instanceId of instanceIds || []) {
      if (allowedIds.has(instanceId) && !nextIds.includes(instanceId)) {
        nextIds.push(instanceId);
      }
    }
    return nextIds;
  }

  function handleMapSelectionChange(instanceIds, { primaryId = "" } = {}) {
    const nextIds = normalizeSelectedUnitIds(instanceIds);
    setSelectedUnitIds(nextIds);
    if (primaryId && nextIds.includes(primaryId) && snapshot?.selectedId !== primaryId) {
      handleSelect(primaryId, { preserveMapMode: true, syncLocalSelection: false });
    }
  }

  async function submitGroupPositions(placements) {
    const normalizedPlacements = (placements || [])
      .filter((placement) => placement?.instanceId && Number.isInteger(placement.x) && Number.isInteger(placement.y))
      .map((placement) => ({
        instanceId: placement.instanceId,
        x: placement.x,
        y: placement.y,
      }));
    if (!snapshot?.sid || busy || normalizedPlacements.length === 0) {
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/positions`,
      {
        method: "POST",
        body: JSON.stringify({ placements: normalizedPlacements }),
      },
      `Repositioned ${normalizedPlacements.length} unit${normalizedPlacements.length === 1 ? "" : "s"}`,
    );
    if (payload) {
      setSelectedUnitIds(normalizeSelectedUnitIds(normalizedPlacements.map((placement) => placement.instanceId)));
    }
  }

  async function copySelectedUnit() {
    if (!canCopySelectedUnit || !copySourceEntity || !snapshot?.sid || busy) {
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${copySourceEntity.instance_id}/copy`,
      { method: "POST" },
      `Copied ${copySourceEntity.name}`,
    );
    if (payload?.selectedId) {
      setSelectedUnitIds([payload.selectedId]);
    }
  }

  async function selectEntityForAction(instanceId, { allowWhileBusy = false } = {}) {
    if (!snapshot?.sid || (busy && !allowWhileBusy)) {
      return null;
    }
    if (snapshot?.selectedId === instanceId) {
      return snapshot;
    }

    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(`/api/battle/sessions/${snapshot.sid}/select`, {
        method: "POST",
        body: JSON.stringify({ instanceId }),
      });
      setSnapshot(payload);
      setNotice("");
      setMapMode(MAP_MODES.IDLE);
      return payload;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleUnitContextMenu({ instanceId, clientX, clientY }) {
    if (busy || !orderedEnemies.some((entity) => entity.instance_id === instanceId)) {
      return;
    }
    setActionMenuOpen(false);
    setUnitContextMenu(null);
    const payload = await selectEntityForAction(instanceId);
    if (!payload?.enemies?.some((entity) => entity.instance_id === instanceId)) {
      return;
    }
    setUnitContextMenu({ entityId: instanceId, x: clientX, y: clientY });
  }

  async function openAttackForEntity(instanceId, options = {}) {
    const payload = await selectEntityForAction(instanceId, options);
    if (!payload) {
      return;
    }
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    setMapMode((m) => (m === MAP_MODES.GM_DUNGEON ? m : MAP_MODES.IDLE));
    setAttackForm(EMPTY_ATTACK_FORM);
    setModal("attack");
  }

  async function openHealForEntity(instanceId) {
    const payload = await selectEntityForAction(instanceId);
    if (!payload) {
      return;
    }
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    setMapMode((m) => (m === MAP_MODES.GM_DUNGEON ? m : MAP_MODES.IDLE));
    setHealForm(EMPTY_HEAL_FORM);
    setModal("heal");
  }

  async function openRepositionForEntity(instanceId) {
    const payload = await selectEntityForAction(instanceId);
    if (!payload) {
      return;
    }
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    setMapMode((current) => {
      repositionReturnModeRef.current = current === MAP_MODES.GM_DUNGEON ? current : null;
      return MAP_MODES.REPOSITION;
    });
  }

  async function rollLootForEntity(instanceId) {
    const payload = await selectEntityForAction(instanceId);
    if (!payload) {
      return;
    }
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    setMapMode((m) => (m === MAP_MODES.GM_DUNGEON ? m : MAP_MODES.IDLE));
    await handleRollLoot();
  }

  function openUnitPreview(instanceId) {
    const target = orderedEnemies.find((entity) => entity.instance_id === instanceId);
    if (!target) {
      return;
    }
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    setPreviewEntityId(instanceId);
    setModal("unit-preview");
  }

  function handleUnitDoubleClick(instanceId) {
    const target = orderedEnemies.find((entity) => entity.instance_id === instanceId);
    if (!target || target.is_player || target.is_down || snapshot?.activeTurnId === instanceId) {
      return false;
    }
    openAttackForEntity(instanceId, { allowWhileBusy: true });
    return true;
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

  function setMapModeAfterMovement() {
    setMapMode(MAP_MODES.IDLE);
  }

  async function submitRestrictedMove(x, y, { dash = false } = {}) {
    if (!selectedEntity) {
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${selectedEntity.instance_id}/move`,
      {
        method: "POST",
        body: JSON.stringify({ x, y, dash }),
      },
      `Moved ${selectedEntity.name}`,
    );
    if (payload) {
      setPendingDashMove(null);
      setModal(null);
      setMapModeAfterMovement(payload);
    }
  }

  async function submitReposition(x, y) {
    if (!selectedEntity) {
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${selectedEntity.instance_id}/position`,
      {
        method: "POST",
        body: JSON.stringify({ x, y }),
      },
      `Repositioned ${selectedEntity.name}`,
    );
    if (payload) {
      const returnMode = repositionReturnModeRef.current;
      repositionReturnModeRef.current = null;
      setMapMode((current) => {
        if (current === MAP_MODES.GM_REPOSITION) return current;
        return returnMode ?? MAP_MODES.IDLE;
      });
    }
  }

  async function handleMoveSelectedToCell(x, y, target = {}) {
    if (mapMode === MAP_MODES.REPOSITION || mapMode === MAP_MODES.GM_REPOSITION) {
      await submitReposition(x, y);
      return;
    }
    if (mapMode !== MAP_MODES.MOVE) {
      return;
    }
    if (target.requiresDash) {
      setPendingDashMove({ x, y });
      setModal("dash-confirm");
      return;
    }
    await submitRestrictedMove(x, y);
  }

  async function confirmDashMove() {
    if (!pendingDashMove) {
      return;
    }
    await submitRestrictedMove(pendingDashMove.x, pendingDashMove.y, { dash: true });
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
        body: JSON.stringify(pcForm),
      },
      "Player added",
    );
    if (payload) {
      closeModal();
    }
  }

  async function handleAddPC(event) {
    event.preventDefault();
    await handleAddPlayer();
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
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/turn/draw`,
      {
        method: "POST",
      },
      "Cards drawn",
    );
    if (payload) {
      showDrawReveal(payload, "draw");
    }
  }

  async function handleRedraw() {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/turn/redraw`,
      {
        method: "POST",
      },
      "Cards redrawn",
    );
    if (payload) {
      showDrawReveal(payload, "redraw");
    }
  }

  async function handleDrawExact(explicitCount) {
    const n = explicitCount !== undefined ? explicitCount : Number(drawExactCount);
    closeModal();
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/turn/draw-exact`,
      {
        method: "POST",
        body: JSON.stringify({ count: n }),
      },
      `Drew ${n} card(s)`,
    );
    if (payload) {
      showDrawReveal(payload, "draw");
    }
  }

  async function handleChannel() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/channel`,
      { method: "POST" },
      "Channeled",
    );
  }

  async function handleStrengthen(explicitX) {
    const x = explicitX !== undefined ? explicitX : Number(strengthenCount);
    closeModal();
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/strengthen`,
      { method: "POST", body: JSON.stringify({ x }) },
      `Strengthened +${x}`,
    );
  }

  async function handleShed() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/shed`,
      { method: "POST" },
      "Wound shed",
    );
  }

  async function handleDisengage() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/disengage`,
      { method: "POST" },
      "Disengaged",
    );
    setModal("disengage-info");
  }

  async function handleHelp(targetId) {
    closeModal();
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/help`,
      { method: "POST", body: JSON.stringify({ targetId }) },
      "Help given",
    );
  }

  function withActionCheck(fn) {
    if (isPlayerSelected && playerActionsUsed >= 2 && !actionWarningAcknowledged) {
      setPendingActionFn(() => fn);
      setModal("action-warning");
    } else {
      fn();
    }
  }

  function handleConfirmActionWarning() {
    setActionWarningAcknowledged(true);
    closeModal();
    if (pendingActionFn) {
      pendingActionFn();
      setPendingActionFn(null);
    }
  }

  async function handleTurnAdvance() {
    if (!hasActiveTurn && !pendingNewRound && hasStartableUnit && !initiativeRolledForTarget) {
      setInitiativeOpenReason("start");
      setInitiativeModes({});
      setModal("initiative");
      return;
    }

    if (pendingNewRound) {
      await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/round/start`,
        { method: "POST" },
        "Started new round",
      );
      return;
    }

    if (hasActiveTurn) {
      await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/turn/next`,
        {
          method: "POST",
        },
        "Advanced round order",
      );
      return;
    }

    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/encounter/start`,
      {
        method: "POST",
      },
      "Encounter started",
    );
  }

  async function handleContinueNewRound() {
    closeModal();
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/round/start`,
      { method: "POST" },
      "Started new round",
    );
  }

  async function handleRollInitiative() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/initiative/roll`,
      { method: "POST", body: JSON.stringify({ modes: initiativeModes }) },
      "Initiative rolled",
    );
  }

  async function handleRollAndStart() {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/initiative/roll`,
      { method: "POST", body: JSON.stringify({ modes: initiativeModes }) },
      "Initiative rolled",
    );
    if (!payload) return;
    closeModal();
    if (initiativeOpenReason === "start") {
      await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/encounter/start`,
        { method: "POST" },
        "Encounter started",
      );
    } else {
      await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/round/start`,
        { method: "POST" },
        "Round started",
      );
    }
  }

  async function handleStartCurrentOrder() {
    closeModal();
    if (!snapshot?.encounterStarted) {
      await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/encounter/start`,
        { method: "POST" },
        "Encounter started",
      );
    } else {
      await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/round/start`,
        { method: "POST" },
        "Round started",
      );
    }
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
      setAttackForm(EMPTY_ATTACK_FORM);
      const woundEvent = Array.isArray(payload.woundEvents) ? payload.woundEvents[0] : null;
      if (woundEvent && Number(woundEvent.wounds) > 0) {
        setWoundNotice(woundEvent);
        setModal("wounds");
      } else {
        closeModal();
      }
    }
  }

  async function handleQuickAttack() {
    setActionMenuOpen(false);
    setUnitContextMenu(null);
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/turn/quick-attack`,
      {
        method: "POST",
      },
      "Quick Attack applied",
    );
    if (!payload) {
      return;
    }
    if (payload.quickAttackNotice) {
      setNotice(payload.quickAttackNotice);
    }
    const woundEvent = Array.isArray(payload.woundEvents) ? payload.woundEvents[0] : null;
    if (woundEvent && Number(woundEvent.wounds) > 0) {
      setWoundNotice(woundEvent);
      setModal("wounds");
    }
  }

  async function handleHealSubmit(event) {
    event.preventDefault();
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/heal`,
      {
        method: "POST",
        body: JSON.stringify({
          toughness: Number(healForm.toughness),
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

  async function handleDiscardWound() {
    if (!selectedEntity) return;
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${selectedEntity.instance_id}/wounds/discard`,
      { method: "POST" },
      "Wound discarded",
    );
  }

  async function handleRemoveWound({ confirmDeck = false } = {}) {
    if (!selectedEntity) return;
    if (!confirmDeck && removeWoundNeedsDeckConfirm) {
      setPendingWoundRemove({ instanceId: selectedEntity.instance_id, name: selectedEntity.name });
      setModal("remove-wound-confirm");
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${selectedEntity.instance_id}/wounds/remove`,
      {
        method: "POST",
        body: JSON.stringify({ confirmDeck }),
      },
      "Wound removed",
    );
    if (payload && modal === "remove-wound-confirm") {
      closeModal();
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

  async function handleDeleteSave(filename) {
    if (!snapshot?.sid || busy) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(`/api/battle/sessions/${snapshot.sid}/saves/${encodeURIComponent(filename)}`, {
        method: "DELETE",
      });
      setSaves(payload.saves || []);
      setNotice("Manual save deleted");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
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

  const displayBrightnessScale = displayBrightness / 100;
  const displayBrightnessLift = Math.max(0, (displayBrightness - 100) / (DISPLAY_BRIGHTNESS_MAX - 100) * 0.22);
  const displayBrightnessStyle = {
    "--display-brightness": displayBrightnessScale.toFixed(2),
    "--display-brightness-lift": displayBrightnessLift.toFixed(3),
  };

  return (
    <div className="shell" style={displayBrightnessStyle}>
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
          <label className="brightness-control">
            <span>Light</span>
            <input
              aria-label="Display brightness"
              type="range"
              min={DISPLAY_BRIGHTNESS_MIN}
              max={DISPLAY_BRIGHTNESS_MAX}
              step={DISPLAY_BRIGHTNESS_STEP}
              value={displayBrightness}
              onChange={(event) => setDisplayBrightness(clampDisplayBrightness(event.target.value))}
            />
            <output>{displayBrightness}%</output>
          </label>
          <button className="menu-button" onClick={requestNewSession} disabled={busy}>
            New
          </button>
          <button className="menu-button" onClick={handleUndo} disabled={busy || !snapshot.canUndo}>
            Undo
          </button>
          <button className="menu-button" onClick={handleRedo} disabled={busy || !snapshot.canRedo}>
            Redo
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
          <button
            className={`menu-button gm-reposition-button ${isGmRepositionMode ? "gm-reposition-active" : ""}`.trim()}
            type="button"
            title="Click a unit, then click an empty map cell to reposition it."
            onClick={toggleGmRepositionMode}
            disabled={busy || !canUseGmReposition}
          >
            {isGmRepositionMode ? "Exit GM" : "GM Reposition"}
          </button>
          <button
            className={`menu-button gm-dungeon-button ${isGmDungeonMode ? "gm-dungeon-active" : ""}`.trim()}
            type="button"
            title="Edit dungeon terrain, walls, and doors."
            onClick={toggleGmDungeonMode}
            disabled={busy}
          >
            {isGmDungeonMode ? "Exit Dungeon GM" : "GM Dungeon"}
          </button>
        </div>
      </header>

      <main className="main-grid">
        <section className="stage-column">
          <section className="battle-stage">
            <BattleRoom
              room={room}
              entities={isGmDungeonMode ? orderedEnemies : orderedEnemies.filter(isEntityVisible)}
              selectedEntity={selectedEntity}
              selectedId={snapshot.selectedId}
              activeTurnId={snapshot.activeTurnId}
              mapMode={mapMode}
              movementState={movementState}
              dungeon={dungeon}
              gmDungeonInteractionMode={gmDungeonInteractionMode}
              gmDungeonPalette={gmDungeonPalette}
              gmDungeonTool={gmDungeonTool}
              gmDungeonDrawSubmode={gmDungeonDrawSubmode}
              gmDungeonWallPalette={gmDungeonWallPalette}
              selectedUnitIds={selectedUnitIds}
              highlightedRoomId={isGmDungeonMode ? highlightedRoomId : null}
              drawPulse={drawReveal ? { entityId: drawReveal.entityId, key: drawReveal.key } : null}
              busy={busy}
              onSelect={handleSelect}
              onSelectionChange={handleMapSelectionChange}
              onGroupMove={submitGroupPositions}
              onMoveToCell={handleMoveSelectedToCell}
              onTileEdit={submitTileEdit}
              onWallEdit={submitWallEdit}
              onSecretDoorClick={(key) => {
                setGmSelectedSecretDoorKey((prev) => (prev === key ? null : key));
                setGmSecretDcInput(String(dungeon?.walls?.[key]?.secret_dc ?? 2));
              }}
              onUnitContextMenu={handleUnitContextMenu}
              onUnitDoubleClick={handleUnitDoubleClick}
            />
            {(isGmDungeonMode || (isGmRepositionMode && gmSelectedSecretDoorKey)) && dungeon && (
              <div className="dungeon-room-panel">
                <div className="dungeon-room-panel-header">
                  <button
                    type="button"
                    className={`dungeon-fog-btn${fogOfWarEnabled ? " active" : ""}`}
                    onClick={() => submitFogToggle(!fogOfWarEnabled)}
                    disabled={busy}
                  >
                    Fog {fogOfWarEnabled ? "Aan" : "Uit"}
                  </button>
                </div>
                {(dungeon.rooms || []).map((room, idx) => {
                  const isRevealed = revealedRoomIdSet.has(room.room_id);
                  const isPcVisible = visibleRoomIds.has(room.room_id) && !isRevealed;
                  const isHighlighted = highlightedRoomId === room.room_id;
                  return (
                    <div
                      key={room.room_id}
                      className={`dungeon-room-entry${isHighlighted ? " dungeon-room-highlighted" : ""}`}
                      onClick={() => setHighlightedRoomId(isHighlighted ? null : room.room_id)}
                    >
                      <span className="dungeon-room-label">
                        Kamer {idx + 1}
                        {isPcVisible ? " ◆" : ""}
                      </span>
                      <button
                        type="button"
                        className={`dungeon-room-toggle${isRevealed ? " dungeon-room-toggle-visible" : ""}`}
                        onClick={(e) => { e.stopPropagation(); submitRoomRevealed(room.room_id, !isRevealed); }}
                        disabled={busy}
                      >
                        {isRevealed ? "Zichtbaar" : "Verborgen"}
                      </button>
                    </div>
                  );
                })}
                {gmSelectedSecretDoorKey && (
                  <div className="dungeon-secret-door-panel">
                    <div className="dungeon-room-label">Secret Door: {gmSelectedSecretDoorKey}</div>
                    <button
                      type="button"
                      className="menu-button"
                      onClick={() => handleGmRevealSecretDoor(gmSelectedSecretDoorKey)}
                      disabled={busy}
                    >
                      Reveal to players
                    </button>
                    <div className="dungeon-secret-dc-row">
                      <label className="dungeon-secret-dc-label">DC</label>
                      <input
                        className="dungeon-secret-dc-input"
                        type="number"
                        min="0"
                        value={gmSecretDcInput}
                        onChange={(e) => setGmSecretDcInput(e.target.value)}
                      />
                      <button
                        type="button"
                        className="menu-button"
                        onClick={() => handleGmSetSecretDc(gmSelectedSecretDoorKey)}
                        disabled={busy}
                      >
                        Set DC
                      </button>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setGmSelectedSecretDoorKey(null)}
                    >
                      Deselect
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="action-bar">
            {isGmDungeonMode ? (
              <div className="dungeon-toolbar-content">
                <div className="dungeon-palette" aria-label="Dungeon interaction mode">
                  {[
                    [GM_DUNGEON_INTERACTION_MODES.DRAW, "Draw"],
                    [GM_DUNGEON_INTERACTION_MODES.SELECT, "Select"],
                    [GM_DUNGEON_INTERACTION_MODES.DRAG, "Drag"],
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={`dungeon-palette-btn${gmDungeonInteractionMode === mode ? " active" : ""}`}
                      onClick={() => setDungeonInteractionMode(mode)}
                      disabled={busy}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="dungeon-toolbar-sep" />
                {gmDungeonInteractionMode === GM_DUNGEON_INTERACTION_MODES.DRAW ? (
                  <>
                    <div className="dungeon-palette">
                      {Object.values(GM_DUNGEON_DRAW_SUBMODES).map((sub) => (
                        <button
                          key={sub}
                          type="button"
                          className={`dungeon-palette-btn${gmDungeonDrawSubmode === sub ? " active" : ""}`}
                          onClick={() => {
                            setGmDungeonDrawSubmode(sub);
                            if (sub === GM_DUNGEON_DRAW_SUBMODES.TERRAIN) {
                              setGmDungeonPalette("floor");
                            } else {
                              setGmDungeonWallPalette("wall");
                            }
                          }}
                          disabled={busy}
                        >
                          {sub.charAt(0).toUpperCase() + sub.slice(1)}
                        </button>
                      ))}
                    </div>
                    <div className="dungeon-toolbar-sep" />
                    {gmDungeonDrawSubmode === GM_DUNGEON_DRAW_SUBMODES.TERRAIN ? (
                      <>
                        <div className="dungeon-palette">
                          {GM_DUNGEON_PALETTES.map((p) => (
                            <button
                              key={p}
                              type="button"
                              className={`dungeon-palette-btn${gmDungeonPalette === p ? " active" : ""}`}
                              onClick={() => setGmDungeonPalette(p)}
                              disabled={busy}
                            >
                              {p.charAt(0).toUpperCase() + p.slice(1)}
                            </button>
                          ))}
                        </div>
                        <div className="dungeon-toolbar-sep" />
                        <div className="dungeon-palette" aria-label="Dungeon paint tool">
                          <button
                            type="button"
                            className={`dungeon-palette-btn${gmDungeonTool === GM_DUNGEON_TOOLS.BRUSH ? " active" : ""}`}
                            onClick={() => setGmDungeonTool(GM_DUNGEON_TOOLS.BRUSH)}
                            disabled={busy}
                          >
                            Brush
                          </button>
                          <button
                            type="button"
                            className={`dungeon-palette-btn${gmDungeonTool === GM_DUNGEON_TOOLS.RECTANGLE ? " active" : ""}`}
                            onClick={() => setGmDungeonTool(GM_DUNGEON_TOOLS.RECTANGLE)}
                            disabled={busy || !RECTANGLE_PALETTES.has(gmDungeonPalette)}
                          >
                            Rect
                          </button>
                        </div>
                        <div className="dungeon-toolbar-sep" />
                      </>
                    ) : (
                      <>
                        <div className="dungeon-palette">
                          {GM_DUNGEON_WALL_PALETTES.map((p) => (
                            <button
                              key={p}
                              type="button"
                              className={`dungeon-palette-btn${gmDungeonWallPalette === p ? " active" : ""}`}
                              onClick={() => setGmDungeonWallPalette(p)}
                              disabled={busy}
                            >
                              {p === "secret_door" ? "Secret" : p.charAt(0).toUpperCase() + p.slice(1)}
                            </button>
                          ))}
                        </div>
                        {gmDungeonWallPalette === "secret_door" && (
                          <label className="dungeon-secret-dc-toolbar">
                            <span>DC</span>
                            <input
                              type="number"
                              min="0"
                              max="10"
                              className="dungeon-secret-dc-input"
                              value={gmSecretDoorDefaultDc}
                              onChange={(e) => setGmSecretDoorDefaultDc(Math.max(0, parseInt(e.target.value, 10) || 0))}
                            />
                          </label>
                        )}
                        <div className="dungeon-toolbar-sep" />
                      </>
                    )}
                  </>
                ) : null}
                {gmDungeonInteractionMode === GM_DUNGEON_INTERACTION_MODES.SELECT ? (
                  <button
                    className="menu-button"
                    type="button"
                    onClick={copySelectedUnit}
                    disabled={busy || !canCopySelectedUnit}
                    title="Copy selected enemy"
                  >
                    Copy
                  </button>
                ) : null}
                <button
                  className="menu-button"
                  type="button"
                  onClick={submitAnalyzeDungeon}
                  disabled={busy}
                >
                  Analyze
                </button>
                <button
                  className="menu-button dungeon-exit-btn"
                  type="button"
                  onClick={exitGmDungeonMode}
                  disabled={busy}
                >
                  Exit Dungeon GM
                </button>
              </div>
            ) : (
              <>
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
                {canDrawExact && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setActionMenuOpen(false);
                      withActionCheck(() => { setDrawExactCount(1); setModal("draw-exact"); });
                    }}
                    disabled={busy}
                  >
                    Draw X
                  </button>
                )}
                {isPlayerSelected && !selectedIsDown && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setActionMenuOpen(false);
                      withActionCheck(handleChannel);
                    }}
                    disabled={busy}
                    title={`Draw bonus pending: ${selectedEntity?.draw_bonus_pending ?? 0}/3`}
                  >
                    Channel{selectedEntity?.draw_bonus_pending > 0 ? ` (+${selectedEntity.draw_bonus_pending})` : ""}
                  </button>
                )}
                {isPlayerSelected && !selectedIsDown && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setActionMenuOpen(false);
                      withActionCheck(() => { setStrengthenCount(1); setModal("strengthen"); });
                    }}
                    disabled={busy}
                  >
                    Strengthen
                  </button>
                )}
                {canShed && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setActionMenuOpen(false);
                      withActionCheck(handleShed);
                    }}
                    disabled={busy}
                    title={`${selectedEntity?.wounds_in_hand ?? 0} wound(s) in hand`}
                  >
                    Shed
                  </button>
                )}
                {isPlayerSelected && selectedIsActive && (
                  <span className="action-counter" title="Gebruikte acties deze beurt (max 2 voor waarschuwing)">
                    {playerActionsUsed}/2 acties
                  </span>
                )}
                <button
                  className="primary-button"
                  onClick={() => {
                    setActionMenuOpen(false);
                    handleTurnAdvance();
                  }}
                  disabled={!canAdvanceTurn || busy}
                >
                  {turnAdvanceLabel}
                </button>
                <button
                  className={`secondary-button ${mapMode === MAP_MODES.MOVE ? "move-button-active" : ""}`.trim()}
                  onClick={() => {
                    setActionMenuOpen(false);
                    setMapMode((current) => (current === MAP_MODES.MOVE ? MAP_MODES.IDLE : MAP_MODES.MOVE));
                  }}
                  disabled={!canUseMove || busy}
                >
                  {mapMode === MAP_MODES.MOVE ? "Cancel Move" : "Move"}
                </button>
                {hasQuickAttackTarget ? (
                  <button
                    className="primary-button"
                    onClick={handleQuickAttack}
                    disabled={!canQuickAttack || busy}
                  >
                    Quick Attack
                  </button>
                ) : null}
                {adjacentDoors.map((door) => (
                  <button
                    key={door.key}
                    className="secondary-button"
                    type="button"
                    onClick={() => handleToggleDoor(door)}
                    disabled={busy}
                  >
                    {dungeon?.walls?.[door.key]?.wall_type === "secret_door"
                      ? dungeon?.walls?.[door.key]?.door_open ? "Close Secret Door" : "Open Secret Door"
                      : dungeon?.walls?.[door.key]?.door_open ? "Close Door" : "Open Door"}
                  </button>
                ))}
                {canSearch && (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => { setActionMenuOpen(false); withActionCheck(handleStartSearch); }}
                    disabled={busy}
                  >
                    Search Room
                  </button>
                )}
                {!canSearch && roomAlreadySearched && isPlayerSelected && !selectedIsDown && dungeon && (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled
                  >
                    Room Searched
                  </button>
                )}
                {adjacentSuspects.map((s) => (
                  <button
                    key={s.edge_key}
                    className="secondary-button"
                    type="button"
                    onClick={() => { setActionMenuOpen(false); withActionCheck(() => handleInteractSuspect(s.edge_key)); }}
                    disabled={busy}
                  >
                    Investigate Suspect
                  </button>
                ))}
                <button
                  className="secondary-button"
                  onClick={() => {
                    setActionMenuOpen(false);
                    setAttackForm(EMPTY_ATTACK_FORM);
                    setModal("attack");
                  }}
                  disabled={!canAttackOrHeal || busy}
                >
                  {`Attack ${selectedTargetNoun}`}
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
                        setMapMode((current) =>
                          current === MAP_MODES.REPOSITION ? MAP_MODES.IDLE : MAP_MODES.REPOSITION,
                        );
                      }}
                      disabled={!canReposition || busy}
                    >
                      Reposition unit
                    </button>
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
                        withActionCheck(handleDisengage);
                      }}
                      disabled={!canDisengage || busy}
                    >
                      Disengage
                    </button>
                    <button
                      className="secondary-button action-more-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setActionMenuOpen(false);
                        if (pcEntitiesInRange.length === 1) {
                          withActionCheck(() => handleHelp(pcEntitiesInRange[0].instance_id));
                        } else {
                          withActionCheck(() => { setHelpTargets(pcEntitiesInRange); setModal("help-select"); });
                        }
                      }}
                      disabled={!canHelp || busy}
                    >
                      Help
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
                      {`Heal ${selectedTargetNoun}`}
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
            </>
          )}
          </section>

          <section className="roster-strip">
            {orderedEnemies.length ? (
              orderedEnemies.filter(isEntityVisible).map((entity) => {
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
                              width: `${percent(entity.toughness_current, entity.toughness_max)}%`,
                              background: barTone(percent(entity.toughness_current, entity.toughness_max)),
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

        {drawReveal ? <DrawRevealPanel reveal={drawReveal} /> : null}

        <aside className="right-rail">
          <div className="unit-inspector">
            <Panel title="Unit Inspector">
              {visibleSelectedEntity ? (
                <div className={`selected-summary ${visibleSelectedEntity.is_player ? "selected-summary-player" : ""}`.trim()}>
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
                      {selectedEntity.is_down ? <span className="badge badge-down">{selectedIsKo ? "KO" : "Down"}</span> : null}
                    </div>
                    <div className="selected-meta-row">
                      {!selectedEntity.is_player && selectedEntity.status_text && selectedEntity.status_text !== "-" ? (
                        <span className="selected-meta">{selectedEntity.status_text}</span>
                      ) : null}
                      {activeDetachedEntity ? <span className="selected-meta">{`Turn: ${activeDetachedEntity.name}`}</span> : null}
                    </div>
                  </div>

                  {selectedHasDraw ? (
                    <div
                      className={`unit-inspector-section unit-inspector-draw-preview ${
                        selectedDrawPreviewHighlighted ? "unit-inspector-draw-preview-highlight" : ""
                      }`.trim()}
                    >
                      <div className="selected-draw-label">{selectedDrawIsStored ? "Previous draw" : "Current draw"}</div>
                      <DrawGroupsList
                        groups={selectedDrawGroups}
                        compact
                        onCardClick={() => {
                          setDrawDetail({
                            entityName: selectedEntity.name,
                            items: selectedEntity.current_draw_text || selectedDrawGroups.flatMap((group) => group.items),
                            groups: selectedDrawGroups,
                            kind: selectedDrawIsStored ? "previous draw" : "current draw",
                          });
                          setModal("draw-detail");
                        }}
                      />
                    </div>
                  ) : null}

                  <div className="unit-stat-strip">
                    <span className="unit-stat-chip unit-stat-toughness" title="Amount of damage a unit can take before going down. Player characters gain a wound instead and reset Toughness.">
                      <span>Toughness</span>
                      <strong>{`${selectedEntity.toughness_current}/${selectedEntity.toughness_max}`}</strong>
                    </span>
                    <span className="unit-stat-chip" title="Reduces incoming damage from all attacks.">
                      <span>Armor</span>
                      <strong>{`${selectedEntity.armor_current}/${selectedEntity.armor_max}`}</strong>
                    </span>
                    <span className="unit-stat-chip unit-stat-arcane" title="Reduces incoming damage like Armor, but cannot be ignored or reduced by normal effects.">
                      <span>M Armor</span>
                      <strong>{`${selectedEntity.magic_armor_current}/${selectedEntity.magic_armor_max}`}</strong>
                    </span>
                    <span className="unit-stat-chip unit-stat-guard" title="Temporary damage reduction that is consumed as it blocks damage.">
                      <span>Guard</span>
                      <strong>{selectedEntity.guard_current}</strong>
                    </span>
                    <span className="unit-stat-chip" title="Number of cards the unit draws at the start of its turn.">
                      <span>Power</span>
                      <strong>{selectedEntity.power_base}</strong>
                    </span>
                    <span className="unit-stat-chip unit-stat-move" title="Maximum distance the unit can move in a turn. Doubled when using a Dash action.">
                      <span>Move</span>
                      <strong>{selectedEntity.effective_movement}</strong>
                    </span>
                  </div>

                  {selectedEntity.toughness_max > 0 ? (
                    <ProgressBar label="Vitality" value={percent(selectedEntity.toughness_current, selectedEntity.toughness_max)} compact />
                  ) : null}
                  {selectedEntity.is_player ? (
                    <div className="unit-inspector-section wound-inspector" aria-label="Player wound counts">
                      <div className="selected-draw-label">Wounds</div>
                      <div className="wound-count-grid">
                        <LootBlock label="Hand" value={String(selectedWoundCounts.hand || 0)} />
                        <LootBlock label="Total" value={String(selectedWoundCounts.total || 0)} />
                        <LootBlock label="Discard" value={String(selectedWoundCounts.discard || 0)} />
                        <LootBlock label="Deck" value={String(selectedWoundCounts.draw_pile || 0)} />
                      </div>
                      <div className="wound-action-row">
                        <button
                          className="secondary-button wound-action-button"
                          type="button"
                          onClick={handleDiscardWound}
                          disabled={!canDiscardWound || busy}
                        >
                          Discard Wound
                        </button>
                        <button
                          className="secondary-button wound-action-button"
                          type="button"
                          onClick={() => handleRemoveWound()}
                          disabled={!canRemoveWound || busy}
                        >
                          Remove Wound
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {!selectedEntity.is_player && selectedStatuses.length ? (
                    <div className="selected-statuses">
                      {selectedStatuses.map(([statusKey, statusValue]) => (
                        <span className="status-pill" key={statusKey}>
                          {formatStatusLabel(statusKey, statusValue)}
                        </span>
                      ))}
                    </div>
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
                <div className="panel-header-actions">
                  {canRollInitiative && (
                    <button
                      className="secondary-button panel-header-button"
                      type="button"
                      onClick={() => {
                        setInitiativeOpenReason("manual");
                        setInitiativeModes({});
                        setModal("initiative");
                      }}
                      disabled={busy}
                    >
                      Roll Initiative
                    </button>
                  )}
                  <button className="icon-button" type="button" aria-label="Add unit" onClick={openAddUnitModal} disabled={busy}>
                    <PlusIcon />
                  </button>
                </div>
              }
            >
            <div className="initiative-list initiative-list-compact">
              {orderedEnemies.filter(isEntityVisible).map((entity) => {
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
                      <div className="initiative-right-col">
                        {entity.initiative_total != null && (
                          <span className="initiative-roll-badge" title={`Mod: +${entity.initiative_modifier}, Roll: ${entity.initiative_roll}`}>
                            {entity.initiative_total}
                          </span>
                        )}
                        {!entity.is_player ? (
                          <span className="initiative-toughness">
                            {entity.toughness_current}/{entity.toughness_max}
                          </span>
                        ) : (
                          <span className="initiative-toughness">Player</span>
                        )}
                      </div>
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

      {unitContextMenu && contextMenuEntity ? (
        <div
          ref={unitContextMenuRef}
          className="unit-context-menu"
          role="menu"
          aria-label={`Unit actions for ${contextMenuEntity.name}`}
          style={{ left: `${unitContextMenu.x}px`, top: `${unitContextMenu.y}px` }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenuEntity.is_down ? (
            canContextRollLoot ? (
              <button
                className="secondary-button unit-context-item"
                type="button"
                role="menuitem"
                onClick={() => rollLootForEntity(contextMenuEntity.instance_id)}
                disabled={busy}
              >
                Roll loot
              </button>
            ) : null
          ) : (
            <>
              {canContextQuickAttack ? (
                <button
                  className="secondary-button unit-context-item"
                  type="button"
                  role="menuitem"
                  onClick={handleQuickAttack}
                  disabled={busy}
                >
                  Quick Attack
                </button>
              ) : null}
              <button
                className="secondary-button unit-context-item"
                type="button"
                role="menuitem"
                onClick={() => openAttackForEntity(contextMenuEntity.instance_id)}
                disabled={busy}
              >
                {contextMenuEntity.is_player ? "Attack player" : "Attack unit"}
              </button>
              <button
                className="secondary-button unit-context-item"
                type="button"
                role="menuitem"
                onClick={() => openHealForEntity(contextMenuEntity.instance_id)}
                disabled={busy}
              >
                {contextMenuEntity.is_player ? "Heal player" : "Heal unit"}
              </button>
            </>
          )}
          <button
            className="secondary-button unit-context-item"
            type="button"
            role="menuitem"
            onClick={() => openRepositionForEntity(contextMenuEntity.instance_id)}
            disabled={busy}
          >
            Reposition unit
          </button>
          <button
            className="secondary-button unit-context-item"
            type="button"
            role="menuitem"
            onClick={() => openUnitPreview(contextMenuEntity.instance_id)}
            disabled={busy}
          >
            Show unit
          </button>
        </div>
      ) : null}

      <ModalShell
        open={modal === "unit-preview" && Boolean(previewEntity)}
        title={previewEntity?.name || "Show unit"}
        subtitle={previewEntity?.is_player ? "Player" : previewEntity ? titleCaseFromSnake(previewEntity.template_id) : ""}
        onClose={closeModal}
        size="wide"
      >
        {previewEntity ? (
          <div className="unit-preview-body">
            <div className="unit-preview-frame">
              <img
                className="unit-preview-image"
                src={previewEntity.image_url}
                alt={`${previewEntity.name} preview`}
              />
            </div>
          </div>
        ) : null}
      </ModalShell>

      <ModalShell
        open={modal === "attack"}
        title={`Attack ${selectedTargetNoun}`}
        subtitle={`Applies damage and optional status effects to the selected ${selectedTargetNoun} card.`}
        onClose={closeModal}
        closeOnOutsideClick={false}
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
        title={`Heal ${selectedTargetNoun}`}
        subtitle={`Restores the selected ${selectedTargetNoun} card using the backend heal model.`}
        onClose={closeModal}
      >
        <form className="modal-form" onSubmit={handleHealSubmit}>
          <div className="field-grid">
            <label className="field">
              <span>Toughness</span>
              <input
                type="number"
                min="0"
                value={healForm.toughness}
                onChange={(event) => setHealForm((current) => ({ ...current, toughness: event.target.value }))}
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
        open={modal === "wounds" && Boolean(woundNotice)}
        title="Player Wounds"
        onClose={closeModal}
        closeOnOutsideClick={false}
        className="modal-shell-wound"
      >
        {woundNotice ? (
          <div className="panel-body wound-modal-body">
            <div className="wound-mark" aria-hidden="true">
              <span className="wound-slash wound-slash-main" />
              <span className="wound-slash wound-slash-cross" />
            </div>
            <div className="wound-modal-content">
              <div className="wound-kicker">Wound taken</div>
              <div className="wound-headline">
                <strong>{woundNotice.name}</strong>
                {` gains ${woundNotice.wounds} wound${Number(woundNotice.wounds) === 1 ? "" : "s"}.`}
              </div>
              <div className="wound-card-row">
                <div className="wound-card-mini" aria-label={`${woundNotice.wounds} wound cards`}>
                  <span>Wound</span>
                  <strong>{`x${woundNotice.wounds}`}</strong>
                </div>
                <div
                  className="wound-toughness-box"
                  aria-label={`Toughness ${woundNotice.toughnessAfter}/${woundNotice.toughnessMax} after wounds`}
                >
                  <span>Toughness</span>
                  <strong>{`${woundNotice.toughnessAfter}/${woundNotice.toughnessMax}`}</strong>
                  <div className="wound-toughness-track" aria-hidden="true">
                    <div
                      className="wound-toughness-fill"
                      style={{ width: `${percent(woundNotice.toughnessAfter, woundNotice.toughnessMax)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="primary-button" type="button" onClick={closeModal}>
                OK
              </button>
            </div>
          </div>
        ) : null}
      </ModalShell>

      <ModalShell
        open={modal === "remove-wound-confirm" && Boolean(pendingWoundRemove)}
        title="Remove Wound From Deck"
        subtitle="This normally should not happen during combat."
        onClose={closeModal}
        closeOnOutsideClick={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">
            {pendingWoundRemove ? `Confirm removing one wound from ${pendingWoundRemove.name}'s draw pile.` : ""}
          </div>
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => handleRemoveWound({ confirmDeck: true })}
              disabled={busy}
            >
              Remove from deck
            </button>
            <button className="secondary-button" type="button" onClick={closeModal} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "add"}
        title="Add Unit"
        onClose={closeModal}
        size="wide"
      >
        <div className="panel-body add-unit-body">
          <div className="add-unit-tabs" role="tablist">
            {[["premade", "Premade"], ["pc", "Player Character"], ["custom", "Custom Enemy"]].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={addUnitTab === id}
                className={`add-unit-tab ${addUnitTab === id ? "add-unit-tab-active" : ""}`.trim()}
                onClick={() => setAddUnitTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {addUnitTab === "premade" && (
            <div className="add-unit-tab-panel">
              <div className="template-library-controls">
                <label className="field template-search-field">
                  <span>Search enemies</span>
                  <input
                    type="search"
                    value={templateSearch}
                    onChange={(event) => setTemplateSearch(event.target.value)}
                    placeholder="Name or id"
                  />
                </label>
                <div className="template-category-tabs" role="tablist" aria-label="Enemy categories">
                  {templateCategories.map((category) => (
                    <button
                      key={category}
                      type="button"
                      className={`template-category-tab ${templateCategory === category ? "template-category-tab-active" : ""}`.trim()}
                      onClick={() => setTemplateCategory(category)}
                      role="tab"
                      aria-selected={templateCategory === category}
                    >
                      {category === "All" ? "All" : titleCaseFromSnake(category)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="premade-grid">
                {shownTemplates.map((template) => (
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
                      <div className="premade-card-kicker">{titleCaseFromSnake(getTemplateCategory(template))}</div>
                      <div className="premade-card-name">{template.name}</div>
                      <div className="premade-card-meta">{titleCaseFromSnake(template.id)}</div>
                    </div>
                  </button>
                ))}
                {!shownTemplates.length ? <div className="empty-copy premade-empty">No enemies match these filters.</div> : null}
              </div>
            </div>
          )}

          {addUnitTab === "pc" && (
            <div className="add-unit-tab-panel">
              <form className="modal-form" onSubmit={handleAddPC}>
                <div className="field-grid">
                  <label className="field field-full">
                    <span>Name</span>
                    <input
                      type="text"
                      placeholder="Player 1"
                      value={pcForm.name}
                      onChange={(event) => setPcForm((current) => ({ ...current, name: event.target.value }))}
                    />
                  </label>
                  <label className="field field-full">
                    <span>Deck</span>
                    <select
                      value={pcForm.playerDeckId}
                      onChange={(event) => setPcForm((current) => ({ ...current, playerDeckId: event.target.value }))}
                    >
                      {(meta.playerDecks || []).map((deck) => (
                        <option key={deck.id} value={deck.id}>
                          {deck.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Toughness</span>
                    <input
                      type="number"
                      min="0"
                      value={pcForm.toughness}
                      onChange={(event) => setPcForm((current) => ({ ...current, toughness: Number(event.target.value) }))}
                    />
                  </label>
                  <label className="field">
                    <span>Armor</span>
                    <input
                      type="number"
                      min="0"
                      value={pcForm.armor}
                      onChange={(event) => setPcForm((current) => ({ ...current, armor: Number(event.target.value) }))}
                    />
                  </label>
                  <label className="field">
                    <span>Magic armor</span>
                    <input
                      type="number"
                      min="0"
                      value={pcForm.magicArmor}
                      onChange={(event) => setPcForm((current) => ({ ...current, magicArmor: Number(event.target.value) }))}
                    />
                  </label>
                  <label className="field">
                    <span>Base guard</span>
                    <input
                      type="number"
                      min="0"
                      value={pcForm.baseGuard}
                      onChange={(event) => setPcForm((current) => ({ ...current, baseGuard: Number(event.target.value) }))}
                    />
                  </label>
                  <label className="field">
                    <span>Power</span>
                    <input
                      type="number"
                      min="0"
                      value={pcForm.power}
                      onChange={(event) => setPcForm((current) => ({ ...current, power: Number(event.target.value) }))}
                    />
                  </label>
                  <label className="field">
                    <span>Movement</span>
                    <input
                      type="number"
                      min="0"
                      value={pcForm.movement}
                      onChange={(event) => setPcForm((current) => ({ ...current, movement: Number(event.target.value) }))}
                    />
                  </label>
                  <label className="field">
                    <span>Initiative</span>
                    <input
                      type="number"
                      min="0"
                      value={pcForm.initiativeModifier}
                      onChange={(event) => setPcForm((current) => ({ ...current, initiativeModifier: Number(event.target.value) }))}
                    />
                  </label>
                </div>
                <div className="modal-actions">
                  <button className="primary-button" type="submit" disabled={busy}>
                    Add player character
                  </button>
                  <button className="secondary-button" type="button" onClick={closeModal}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {addUnitTab === "custom" && (
            <div className="add-unit-tab-panel">
              <form className="modal-form" onSubmit={handleAddCustomEnemy}>
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
                    <span>Toughness</span>
                    <input
                      type="number"
                      min="1"
                      value={customForm.toughness}
                      onChange={(event) => setCustomForm((current) => ({ ...current, toughness: Number(event.target.value) }))}
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
                    <span>Power</span>
                    <input
                      type="number"
                      min="0"
                      value={customForm.power}
                      onChange={(event) => setCustomForm((current) => ({ ...current, power: Number(event.target.value) }))}
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
            </div>
          )}
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
              <div className="save-row" key={save.filename}>
                <button className="save-load-button" onClick={() => handleLoadSubmit(save.filename)} disabled={busy}>
                  <span>{save.label}</span>
                  <span>{save.savedAt || save.filename}</span>
                </button>
                <button
                  className="save-delete-button"
                  type="button"
                  aria-label={`Delete save ${save.label}`}
                  onClick={() => handleDeleteSave(save.filename)}
                  disabled={busy}
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          ) : (
            <div className="subtle-copy">No manual saves found for this workspace.</div>
          )}
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "dungeon-exit-confirm"}
        title="Geen zichtbare kamers"
        onClose={closeModal}
        closeOnOutsideClick={false}
        showCloseButton={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">Fog of war staat aan maar er zijn geen zichtbare kamers. Spelers zien een lege kaart.</div>
          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={closeModal}>
              Blijven
            </button>
            <button className="primary-button" type="button" onClick={() => { closeModal(); setSelectedUnitIds([]); setMapMode(MAP_MODES.IDLE); }}>
              Toch verlaten
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "large-tile-edit-confirm" && Boolean(pendingLargeTileEdit)}
        title="Large tile edit"
        onClose={closeModal}
        closeOnOutsideClick={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">
            This rectangle will update {pendingLargeTileEdit?.count || 0} dungeon cells.
          </div>
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={confirmLargeTileEdit} disabled={busy}>
              Apply edit
            </button>
            <button className="secondary-button" type="button" onClick={closeModal} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "new-session-confirm"}
        title="Confirm New Session"
        onClose={closeModal}
        closeOnOutsideClick={false}
        showCloseButton={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">Current session progress will be discarded.</div>
          <div className="modal-actions">
            <button className="primary-button danger-button" type="button" onClick={createNewSession} disabled={busy}>
              Start New Session
            </button>
            <button className="secondary-button" type="button" onClick={closeModal} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "draw-detail" && Boolean(drawDetail)}
        title="Draw card"
        subtitle={drawDetail?.entityName || ""}
        onClose={closeModal}
        size="wide"
      >
        {drawDetail ? (
          <div className="panel-body draw-detail-body">
            <DrawCardView
              entityName={drawDetail.entityName}
              items={drawDetail.items}
              groups={drawDetail.groups || []}
              kind={drawDetail.kind}
            />
          </div>
        ) : null}
      </ModalShell>

      <ModalShell
        open={modal === "dash-confirm" && Boolean(pendingDashMove)}
        title="Dash movement"
        onClose={closeModal}
        closeOnOutsideClick={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">This movement requires a Dash action.</div>
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={confirmDashMove} disabled={busy}>
              Continue
            </button>
            <button className="secondary-button" type="button" onClick={closeModal} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "initiative"}
        title={
          !snapshot?.encounterStarted
            ? "Roll Initiative — Before Encounter"
            : snapshot?.pendingNewRound
              ? `Roll Initiative — Round ${initiativeTargetRound ?? ""}`
              : "Roll Initiative"
        }
        onClose={closeModal}
        closeOnOutsideClick={false}
        size="wide"
      >
        <div className="panel-body modal-form">
          {[
            { label: "All enemies:", filter: (e) => !e.is_player && isEntityVisible(e) },
            { label: "All players:", filter: (e) => e.is_player },
          ].map(({ label, filter }) => (
            <div className="initiative-modal-bulk" key={label}>
              <span className="initiative-bulk-label">{label}</span>
              {[
                { mode: "normal", tip: null },
                { mode: "advantage", tip: "Rolls d6 + 2× modifier" },
                { mode: "disadvantage", tip: "Rolls d6 only, modifier ignored" },
                { mode: "surprised", tip: "Skips first turn this round" },
              ].map(({ mode, tip }) => (
                <button
                  key={mode}
                  type="button"
                  title={tip ?? undefined}
                  className="secondary-button initiative-bulk-btn"
                  onClick={() => {
                    const updates = {};
                    orderedEnemies.filter(filter).forEach((e) => { updates[e.instance_id] = mode; });
                    setInitiativeModes((prev) => ({ ...prev, ...updates }));
                  }}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          ))}

          <div className="initiative-modal-grid">
            <div className="initiative-modal-header">
              <span>Name</span>
              <span>Side</span>
              <span>Mod</span>
              <span>Roll</span>
              <span>Mode</span>
            </div>
            {orderedEnemies.filter(isEntityVisible).map((entity) => (
              <div className="initiative-modal-row" key={entity.instance_id}>
                <span className="initiative-modal-name">{entity.name}</span>
                <span>{entity.is_player ? "Player" : "Enemy"}</span>
                <span>+{entity.initiative_modifier ?? 2}</span>
                <span className="initiative-modal-total">
                  {entity.initiative_total != null
                    ? `${entity.initiative_total} (${entity.initiative_roll})`
                    : "—"}
                </span>
                <div className="initiative-mode-pills">
                  {[
                    { mode: "normal", label: "Normal", tip: null },
                    { mode: "advantage", label: "Advantage", tip: "Rolls d6 + 2× modifier — exceptionally fast or well-prepared" },
                    { mode: "disadvantage", label: "Disadvantage", tip: "Rolls d6 only, modifier ignored — sluggish or caught off guard" },
                    { mode: "surprised", label: "Surprised", tip: "Rolls d6 + modifier but skips their first turn this round" },
                  ].map(({ mode, label, tip }) => (
                    <button
                      key={mode}
                      type="button"
                      title={tip ?? undefined}
                      className={`initiative-mode-btn${(initiativeModes[entity.instance_id] ?? "normal") === mode ? " active" : ""}`}
                      onClick={() => setInitiativeModes((prev) => ({ ...prev, [entity.instance_id]: mode }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="modal-actions">
            <button
              className={initiativeRolledForTarget ? "secondary-button" : "primary-button"}
              type="button"
              onClick={handleRollInitiative}
              disabled={busy}
            >
              {initiativeRolledForTarget ? "Reroll Initiative" : "Roll Initiative"}
            </button>
            <button
              className={initiativeRolledForTarget ? "primary-button" : "secondary-button"}
              type="button"
              onClick={handleStartCurrentOrder}
              disabled={busy}
            >
              {!snapshot?.encounterStarted ? "Start Encounter" : "Start Round"}
            </button>
            <button className="secondary-button" type="button" onClick={closeModal} disabled={busy}>
              Close
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "action-warning"}
        title="Meer dan 2 acties"
        subtitle="Je gebruikt al je 3e actie deze beurt. Wil je doorgaan?"
        onClose={closeModal}
        closeOnOutsideClick={false}
      >
        <div className="panel-body modal-form">
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={handleConfirmActionWarning} disabled={busy}>
              Doorgaan
            </button>
            <button className="secondary-button" type="button" onClick={closeModal} disabled={busy}>
              Annuleer
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "search-resolve"}
        title="Fate getrokken — Willpower inzetten?"
        subtitle={pendingSearch ? `${pendingSearch.successCount} successen + ${pendingSearch.fateCount} fate` : ""}
        onClose={() => handleResolveSearch(false)}
        closeOnOutsideClick={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">
            Een fate-kaart is getrokken. Zet je willpower in om de fate als succes te tellen?
          </div>
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={() => handleResolveSearch(true)} disabled={busy}>
              Willpower inzetten
            </button>
            <button className="secondary-button" type="button" onClick={() => handleResolveSearch(false)} disabled={busy}>
              Overslaan
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "search-flavour"}
        title="Search"
        onClose={closeModal}
      >
        <div className="panel-body modal-form">
          <p style={{ fontStyle: "italic", lineHeight: 1.7, fontSize: "clamp(1rem, 2.5vw, 1.25rem)", margin: "0.5rem 0 1.25rem" }}>
            {flavourText}
          </p>
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={closeModal}>
              Understood
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "disengage-info"}
        title="Disengage"
        onClose={closeModal}
      >
        <div className="panel-body modal-form">
          <p className="subtle-copy">
            {selectedEntity?.name ?? "De speler"} mag deze beurt vrij bewegen zonder opportunity attacks uit te lokken.
          </p>
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={closeModal}>
              Begrepen
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "help-select"}
        title="Help"
        subtitle="Kies welke speler je helpt."
        onClose={closeModal}
      >
        <div className="panel-body modal-form">
          {helpTargets.map((target) => (
            <button
              key={target.instance_id}
              className="secondary-button"
              type="button"
              onClick={() => handleHelp(target.instance_id)}
              disabled={busy}
            >
              {target.name}
            </button>
          ))}
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "draw-exact"}
        title="Draw X kaarten"
        subtitle="Race- en class-kaarten trekken niet door."
        onClose={closeModal}
      >
        <div className="panel-body">
          <div className="draw-exact-row">
            <div className="draw-exact-presets">
              {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                <button
                  key={n}
                  type="button"
                  className="primary-button draw-exact-preset-btn"
                  onClick={() => handleDrawExact(n)}
                  disabled={busy}
                >
                  {n}
                </button>
              ))}
            </div>
            <span className="draw-exact-sep" aria-hidden="true" />
            <form
              className="draw-exact-custom"
              onSubmit={(e) => {
                e.preventDefault();
                handleDrawExact();
              }}
            >
              <input
                className="draw-exact-input"
                type="number"
                min="1"
                max="99"
                value={drawExactCount}
                onChange={(e) => setDrawExactCount(Number(e.target.value))}
              />
              <button className="primary-button" type="submit" disabled={busy}>
                Draw
              </button>
            </form>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "strengthen"}
        title="Strengthen"
        subtitle={`+1 toughness per punt tot max toughness; overgebleven punten worden +1 draw bonus (max +3 totaal).${selectedEntity?.draw_bonus_pending > 0 ? ` Al ${selectedEntity.draw_bonus_pending} bonus in reserve.` : ""}`}
        onClose={closeModal}
      >
        <div className="panel-body">
          <div className="draw-exact-row">
            <div className="draw-exact-presets">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  className="primary-button draw-exact-preset-btn"
                  onClick={() => handleStrengthen(n)}
                  disabled={busy}
                >
                  {n}
                </button>
              ))}
            </div>
            <span className="draw-exact-sep" aria-hidden="true" />
            <form
              className="draw-exact-custom"
              onSubmit={(e) => {
                e.preventDefault();
                handleStrengthen();
              }}
            >
              <input
                className="draw-exact-input"
                type="number"
                min="1"
                max="99"
                value={strengthenCount}
                onChange={(e) => setStrengthenCount(Number(e.target.value))}
              />
              <button className="primary-button" type="submit" disabled={busy}>
                Strengthen
              </button>
            </form>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "new-round" && pendingNewRound}
        title={`Round ${snapshot?.round || 1} complete`}
        subtitle="Continue to the next round or make GM adjustments first."
        onClose={closeModal}
        closeOnOutsideClick={false}
        showCloseButton={false}
      >
        <div className="panel-body modal-form">
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={handleContinueNewRound} disabled={busy}>
              Continue
            </button>
            <button className="secondary-button" type="button" onClick={closeModal} disabled={busy}>
              GM Adjustments
            </button>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}

function BattleRoom({
  room,
  entities,
  selectedEntity,
  selectedId,
  activeTurnId,
  mapMode,
  movementState,
  dungeon,
  gmDungeonInteractionMode,
  gmDungeonPalette,
  gmDungeonTool,
  gmDungeonDrawSubmode,
  gmDungeonWallPalette,
  selectedUnitIds,
  highlightedRoomId = null,
  drawPulse,
  busy,
  onSelect,
  onSelectionChange,
  onGroupMove,
  onMoveToCell,
  onTileEdit,
  onWallEdit,
  onSecretDoorClick,
  onUnitContextMenu,
  onUnitDoubleClick,
}) {
  const placedEntities = useMemo(
    () => entities.filter((entity) => hasGridPosition(entity, room, dungeon)),
    [entities, room.columns, room.rows, dungeon],
  );
  const unplacedEntities = useMemo(
    () => entities.filter((entity) => !hasGridPosition(entity, room, dungeon)),
    [entities, room.columns, room.rows, dungeon],
  );

  return (
    <div className="battle-map">
      <BattleMapSurface
        room={room}
        entities={placedEntities}
        selectedId={selectedId}
        activeTurnId={activeTurnId}
        selectedEntity={selectedEntity}
        mapMode={mapMode}
        movementState={movementState}
        dungeon={dungeon}
        gmDungeonInteractionMode={gmDungeonInteractionMode}
        gmDungeonPalette={gmDungeonPalette}
        gmDungeonTool={gmDungeonTool}
        gmDungeonDrawSubmode={gmDungeonDrawSubmode}
        gmDungeonWallPalette={gmDungeonWallPalette}
        selectedUnitIds={selectedUnitIds}
        highlightedRoomId={highlightedRoomId}
        drawPulse={drawPulse}
        busy={busy}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
        onGroupMove={onGroupMove}
        onMoveToCell={onMoveToCell}
        onTileEdit={onTileEdit}
        onWallEdit={onWallEdit}
        onSecretDoorClick={onSecretDoorClick}
        onUnitContextMenu={onUnitContextMenu}
        onUnitDoubleClick={onUnitDoubleClick}
      />

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

function DrawRevealPanel({ reveal }) {
  return (
    <aside
      className={`draw-reveal-panel draw-reveal-panel-${reveal.phase}`}
      aria-label="Draw Card Inspector"
      aria-live="polite"
      data-draw-reveal-phase={reveal.phase}
    >
      <DrawCardView entityName={reveal.entityName} items={reveal.items} groups={reveal.groups || []} kind={reveal.kind} />
    </aside>
  );
}

function DrawCardView({ entityName, items, groups = [], kind = "draw" }) {
  const title = kind === "redraw" ? "Redraw" : kind === "previous draw" ? "Previous draw" : "Current draw";
  const visibleGroups = groups.length ? groups : items?.length ? [{ label: "Draw 1", items }] : [];
  const count = visibleGroups.reduce((total, group) => total + group.items.length, 0);

  return (
    <div className="draw-card-view">
      <div className="draw-card-view-header">
        <div>
          <div className="selected-draw-label">{title}</div>
          <div className="draw-card-view-title">{entityName}</div>
        </div>
        <span className="draw-card-view-count">{count}</span>
      </div>
      <DrawGroupsList groups={visibleGroups} />
    </div>
  );
}

function DrawSummary({ summary }) {
  if (!summary) {
    return null;
  }
  const outcomes = summary.outcomes || {};
  const energies = summary.energies || {};
  const outcomeItems = ["success", "fate", "fail"].map((key) => [key, Number(outcomes[key] || 0)]);
  const energyItems = Object.entries(energies).filter(([, value]) => Number(value) > 0);
  const hasOutcomes = outcomeItems.some(([, value]) => value > 0);
  const hasEnergies = energyItems.length > 0;
  if (!hasOutcomes && !hasEnergies) {
    return null;
  }

  return (
    <div className="draw-summary">
      {hasOutcomes ? (
        <div className="draw-summary-row draw-summary-outcomes">
          {outcomeItems.map(([key, value]) => (
            <span className={`draw-summary-chip draw-summary-${key}`} key={key}>
              {key} {value}
            </span>
          ))}
        </div>
      ) : null}
      {hasEnergies ? (
        <div className="draw-summary-row draw-summary-energies">
          {energyItems.map(([key, value]) => (
            <span className="draw-summary-chip draw-summary-energy" key={key}>
              {key} {value}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DrawGroupsList({ groups, compact = false, onCardClick = null }) {
  return (
    <div className={`draw-groups ${compact ? "draw-groups-compact" : ""}`.trim()}>
      {groups.map((group, index) => (
        <div className="draw-group" key={`${group.label}-${index}`}>
          {groups.length > 1 || group.summary ? (
            <div className="draw-group-header">
              {groups.length > 1 ? <div className="draw-group-label">{group.label}</div> : null}
              <DrawSummary summary={group.summary} />
            </div>
          ) : null}
          <CardList items={group.items} compact={compact} onCardClick={onCardClick} />
        </div>
      ))}
    </div>
  );
}

function CardList({ items, compact = false, onCardClick = null }) {
  return (
    <div className={`card-list ${compact ? "card-list-compact" : ""}`}>
      {items.map((item, index) =>
        onCardClick ? (
          <button
            type="button"
            className={`draw-card ${compact ? "draw-card-compact" : ""}`.trim()}
            key={`${item}-${index}`}
            onClick={onCardClick}
            aria-label={`Open draw card detail: ${item}`}
          >
            {item}
          </button>
        ) : (
          <div className={`draw-card ${compact ? "draw-card-compact" : ""}`.trim()} key={`${item}-${index}`}>
            {item}
          </div>
        ),
      )}
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

function ModalShell({
  open,
  title,
  subtitle,
  onClose,
  children,
  size = "default",
  closeOnOutsideClick = true,
  showCloseButton = true,
  className = "",
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="modal-overlay" onClick={closeOnOutsideClick ? onClose : undefined}>
      <div
        className={`modal-shell ${size === "wide" ? "modal-shell-wide" : ""} ${className}`.trim()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <div className="panel-title">{title}</div>
            {subtitle ? <div className="panel-detail">{subtitle}</div> : null}
          </div>
          {showCloseButton ? (
            <button className="modal-close-x" onClick={onClose} aria-label="Close">
              ×
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export default App;
