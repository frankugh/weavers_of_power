import { useEffect, useMemo, useRef, useState } from "react";
import { requestJson } from "./api.js";
import BattleMapSurface from "./BattleMapSurface.jsx";
import ScenarioView from "./ScenarioView.jsx";
import { pickSearchFlavour } from "./roomSearchFlavour.js";

const ATTACK_MODIFIERS = [
  { key: "stab", label: "Stab" },
  { key: "pierce", label: "Pierce X" },
  { key: "magic_pierce", label: "Magic pierce" },
  { key: "overwhelm", label: "Overwhelm" },
  { key: "sunder", label: "Sunder X" },
  { key: "shatter", label: "Shatter" },
];

const ATTACK_STATUSES = [
  { key: "burn", label: "Burn" },
  { key: "poison", label: "Poison" },
  { key: "slow", label: "Slow" },
  { key: "paralyze", label: "Paralyze" },
];
const CREATURE_ACTION_ORDER = ["MISS", "A1", "A2", "A3", "A4", "A5", "S"];
const CREATURE_SKILL_LABELS = {
  intelligence: "Int",
  alertness: "Alert",
  stealth: "Stealth",
  social: "Social",
  arcana: "Arcana",
  athletics: "Athletics",
};
const TEMPLATE_AVAILABILITY_FILTERS = [
  { id: "spawnable", label: "Spawnable" },
  { id: "all", label: "All" },
  { id: "design", label: "To Design" },
];
const APP_VIEWS = {
  BATTLE: "battle",
  SCENARIO: "scenario",
  SIM: "sim",
};
const COMBAT_SIM_MODES = [
  { id: "quick", label: "Quick" },
  { id: "turn", label: "Turn-based" },
  { id: "batch", label: "Batch" },
];
const COMBAT_SIM_STRATEGIES = [
  { id: "highest_toughness", label: "Highest toughness" },
  { id: "highest_tl", label: "Highest TL" },
  { id: "lowest_toughness", label: "Lowest toughness" },
  { id: "random_focus", label: "Random focus" },
  { id: "full_random", label: "Full random" },
];
const COMBAT_SIM_STAT_FIELDS = [
  { key: "threatLevel", label: "TL", min: 0 },
  { key: "toughness", label: "T", min: 1 },
  { key: "armor", label: "AR", min: 0 },
  { key: "magicArmor", label: "MAR", min: 0 },
  { key: "baseGuard", label: "G", min: 0 },
  { key: "draw", label: "Draw", min: 0 },
  { key: "movement", label: "Move", min: 0 },
];
const COMBAT_SIM_SKILL_FIELDS = [
  { key: "intelligence", label: "Intelligence" },
  { key: "alertness", label: "Alertness", note: "Init" },
  { key: "stealth", label: "Stealth" },
  { key: "social", label: "Social" },
  { key: "arcana", label: "Arcana" },
  { key: "athletics", label: "Athletics" },
];
const COMBAT_SIM_COVERAGE_KEYS = ["full", "manual", "warning", "error"];

const DEFAULT_ROOM = { columns: 10, rows: 7 };
const MAP_MODES = {
  IDLE: "idle",
  MOVE: "move",
  WALK: "walk",
  PARTY_WALK: "party-walk",
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
  SPAWN: "spawn",
};
const GM_DUNGEON_WALL_PALETTES = ["wall", "door", "secret_door", "erase"];
const RECTANGLE_PALETTES = new Set(["floor", "void"]);
const RECTANGLE_CONFIRM_LIMIT = 2500;
const MAP_LIGHT_STORAGE_KEY = "weavers-map-light";
const MAP_LIGHT_DEFAULT = 100;
const MAP_LIGHT_MIN = 80;
const MAP_LIGHT_MAX = 140;
const MAP_LIGHT_STEP = 5;
const MAP_LIGHT_FILTER_BASE = 1.2;
const MAP_LIGHT_BASE_LIFT = 0.05;
const MAP_LIGHT_MAX_LIFT = 0.1;
const DRAW_REVEAL_TIMING = {
  enterMs: 80,
  holdMs: 3200,
  settleMs: 900,
};
const EMPTY_PC_PICKER_CUSTOM = {
  name: "",
  playerDeckId: "",
  toughness: 4,
  armor: 1,
  magicArmor: 0,
  power: 4,
  movement: 6,
  baseGuard: 1,
  initiativeModifier: 2,
};

const EMPTY_ATTACK_FORM = {
  damage: 1,
  targetMode: "creature",
  grappleId: "",
  pierceAmount: 1,
  sunderAmount: 1,
  modifiers: {
    stab: false,
    pierce: false,
    magic_pierce: false,
    overwhelm: false,
    sunder: false,
    shatter: false,
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
  temporaryToughness: 0,
  armor: 0,
  magicArmor: 0,
  guard: 0,
};

const BUILDER_UPGRADE_KEYS = [
  { key: "success_1", label: "Success 1" },
  { key: "success_2", label: "Success 2" },
  { key: "fate_1", label: "Fate" },
  { key: "fail_1", label: "Fail" },
];

const DEFAULT_CHARACTER_STATS = {
  toughness: 3,
  armor: 1,
  magicArmor: 0,
  power: 4,
  movement: 6,
  baseGuard: 1,
  initiativeModifier: 2,
};

function findCatalogClass(catalog, classId) {
  return (catalog?.classes || []).find((entry) => entry.id === classId) || null;
}

function findCatalogAncestry(catalog, ancestryId) {
  return (catalog?.ancestries || []).find((entry) => entry.id === ancestryId) || null;
}

function defaultStatsForClass(catalog, classEntry) {
  return {
    ...DEFAULT_CHARACTER_STATS,
    ...(catalog?.defaultStats || {}),
    ...(classEntry?.statOverrides || {}),
  };
}

function defaultGearPresetId(classEntry) {
  return classEntry?.gearPresets?.[0]?.id || "";
}

function defaultEnergyTypesForClass(catalog, classEntry) {
  const energyTypes = catalog?.energyTypes || [];
  if (!classEntry) {
    return energyTypes.slice(0, 3);
  }
  const chosen = [...(classEntry.requiredEnergyTypes || [])];
  const addEnergy = (energyType) => {
    if (chosen.length < 3 && energyType && !chosen.includes(energyType)) {
      chosen.push(energyType);
    }
  };
  if (classEntry.choiceRule === "monk") {
    addEnergy("Elemental");
  }
  for (const energyType of energyTypes) {
    if (classEntry.choiceRule === "twoNonMartial" && energyType === "Martial") {
      continue;
    }
    if (classEntry.forbiddenEnergyTypes?.includes(energyType)) {
      continue;
    }
    addEnergy(energyType);
  }
  return chosen.slice(0, 3);
}

function anonymousCharacterArt(catalog) {
  return catalog?.characterArt?.anonymous || {
    source: "anonymous",
    imagePath: "anonymous.png",
    imageUrl: "/images/anonymous.png",
    label: "Anonymous",
  };
}

function matchingCharacterArtOptions(catalog, classId, ancestryId) {
  return (catalog?.characterArt?.options || []).filter(
    (option) => option.classId === classId && option.ancestryId === ancestryId,
  );
}

function sameCharacterArt(left, right) {
  return Boolean(left && right && left.imagePath === right.imagePath && left.source === right.source);
}

function defaultCharacterArt(catalog, classId, ancestryId, currentArt = null) {
  if (currentArt?.source === "upload") {
    return currentArt;
  }
  const options = matchingCharacterArtOptions(catalog, classId, ancestryId);
  if (currentArt?.source === "catalog" && options.some((option) => sameCharacterArt(option, currentArt))) {
    return currentArt;
  }
  if (options.length === 1) {
    return options[0];
  }
  return anonymousCharacterArt(catalog);
}

function emptyDeckUpgrades(energyTypes) {
  const result = {};
  energyTypes.forEach((energyType) => {
    result[energyType] = { success_1: 1, success_2: 1, fate_1: 0, fail_1: 0 };
  });
  return result;
}

function createCharacterBuilderForm(catalog, classId = null) {
  const classEntry = findCatalogClass(catalog, classId) || catalog?.classes?.[0] || null;
  const ancestryId = catalog?.ancestries?.[0]?.id || "";
  const energyTypes = defaultEnergyTypesForClass(catalog, classEntry);
  return {
    name: "",
    classId: classEntry?.id || "",
    ancestryId,
    energyTypes,
    mainArt: classEntry?.mainArtOptions?.find((energyType) => energyTypes.includes(energyType)) || energyTypes[0] || "",
    gmOverride: false,
    deckUpgrades: emptyDeckUpgrades(energyTypes),
    classImprovementTarget: "success_1",
    gearPresetId: defaultGearPresetId(classEntry),
    stats: defaultStatsForClass(catalog, classEntry),
    art: defaultCharacterArt(catalog, classEntry?.id || "", ancestryId),
    physicalCards: false,
  };
}

function normalizeBuilderUpgrades(current, energyTypes) {
  const next = {};
  energyTypes.forEach((energyType) => {
    const source = current?.[energyType] || { success_1: 1, success_2: 1, fate_1: 0, fail_1: 0 };
    next[energyType] = {};
    BUILDER_UPGRADE_KEYS.forEach(({ key }) => {
      next[energyType][key] = Math.max(0, Number(source[key] || 0));
    });
  });
  return next;
}

function builderValidationErrors(catalog, form) {
  const errors = [];
  const classEntry = findCatalogClass(catalog, form.classId);
  if (!classEntry) {
    errors.push("Choose a class.");
    return errors;
  }
  if (!findCatalogAncestry(catalog, form.ancestryId)) {
    errors.push("Choose an ancestry.");
  }
  if (!form.name.trim()) {
    errors.push("Name is required.");
  }
  if (form.energyTypes.length !== 3 || new Set(form.energyTypes).size !== 3) {
    errors.push("Choose exactly 3 unique energy types.");
  }
  const missing = (classEntry.requiredEnergyTypes || []).filter((energyType) => !form.energyTypes.includes(energyType));
  if (missing.length) {
    errors.push(`Missing required energy: ${missing.join(", ")}.`);
  }
  const blocked = (classEntry.forbiddenEnergyTypes || []).filter((energyType) => form.energyTypes.includes(energyType));
  if (blocked.length && !form.gmOverride) {
    errors.push(`GM approval required for: ${blocked.join(", ")}.`);
  }
  if (!classEntry.mainArtOptions?.includes(form.mainArt) || !form.energyTypes.includes(form.mainArt)) {
    errors.push("Main art must be an allowed selected energy type.");
  }
  form.energyTypes.forEach((energyType) => {
    const total = BUILDER_UPGRADE_KEYS.reduce((sum, { key }) => sum + Number(form.deckUpgrades?.[energyType]?.[key] || 0), 0);
    if (total !== 2) {
      errors.push(`${energyType} must spend exactly 2 deck upgrade points.`);
    }
  });
  const classTargetValue = 1 + Number(form.deckUpgrades?.[form.mainArt]?.[form.classImprovementTarget] || 0);
  if (classTargetValue >= 3) {
    errors.push("Class improvement target must be below energy value 3 before the class improvement.");
  }
  return errors;
}

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

function clampMapLight(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return MAP_LIGHT_DEFAULT;
  }
  return Math.max(MAP_LIGHT_MIN, Math.min(MAP_LIGHT_MAX, Math.round(numericValue)));
}

function getInitialMapLight() {
  if (typeof window === "undefined") {
    return MAP_LIGHT_DEFAULT;
  }
  try {
    const storedValue = window.localStorage.getItem(MAP_LIGHT_STORAGE_KEY);
    return storedValue == null ? MAP_LIGHT_DEFAULT : clampMapLight(storedValue);
  } catch {
    return MAP_LIGHT_DEFAULT;
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
  return template?.part || template?.category || "Uncategorized";
}

function getTemplateSection(template) {
  return template?.section || "Uncategorized";
}

function uniqueInOrder(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function getTemplateThreatLevel(template) {
  const value = Number.parseInt(template?.threatLevel, 10);
  return Number.isFinite(value) ? value : null;
}

function isTemplateSpawnable(template) {
  return template?.spawnable !== false;
}

function isTemplateDesignCandidate(template) {
  const status = normalizePlaytestStatus(template?.playtestStatus).toLowerCase();
  return template?.spawnable === false || status.includes("design");
}

function summarizeTemplates(templates) {
  return templates.reduce(
    (summary, template) => {
      summary.total += 1;
      if (isTemplateSpawnable(template)) {
        summary.spawnable += 1;
      }
      if (isTemplateDesignCandidate(template)) {
        summary.design += 1;
      }
      return summary;
    },
    { total: 0, spawnable: 0, design: 0 },
  );
}

function statCountForAvailability(summary, availability) {
  if (availability === "spawnable") {
    return summary.spawnable;
  }
  if (availability === "design") {
    return summary.design;
  }
  return summary.total;
}

function getTemplateStatusLabel(template) {
  if (!isTemplateSpawnable(template)) {
    return isTemplateDesignCandidate(template) ? "To Design" : "Blocked";
  }
  const status = normalizePlaytestStatus(template?.playtestStatus);
  return status ? titleCaseFromSnake(status) : "Ready";
}

function getTemplateInitials(template) {
  const words = String(template?.name || template?.id || "?")
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join("") || "?";
}

function filterTemplates(templates, filters) {
  const { search, category, section, availability, threatMin, threatMax } = filters;
  const normalizedSearch = normalizeSearch(search);
  const minThreat = threatMin === "" ? null : Number(threatMin);
  const maxThreat = threatMax === "" ? null : Number(threatMax);

  return templates.filter((template) => {
    const matchesCategory = category === "All" || getTemplateCategory(template) === category;
    const matchesSection = section === "All" || getTemplateSection(template) === section;
    const threatLevel = getTemplateThreatLevel(template);
    const matchesAvailability =
      availability === "all" ||
      (availability === "spawnable" && isTemplateSpawnable(template)) ||
      (availability === "design" && isTemplateDesignCandidate(template));
    const matchesThreatMin = minThreat === null || (threatLevel !== null && threatLevel >= minThreat);
    const matchesThreatMax = maxThreat === null || (threatLevel !== null && threatLevel <= maxThreat);
    const haystack = [
      template.name,
      template.id,
      template.shortFlavour,
      template.part,
      template.section,
      template.threatTier,
      template.playtestStatus,
    ].filter(Boolean).join(" ").toLowerCase();
    return (
      matchesCategory &&
      matchesSection &&
      matchesAvailability &&
      matchesThreatMin &&
      matchesThreatMax &&
      (!normalizedSearch || haystack.includes(normalizedSearch))
    );
  }).sort((a, b) => {
    const spawnSort = Number(isTemplateSpawnable(b)) - Number(isTemplateSpawnable(a));
    if (spawnSort) return spawnSort;

    const threatA = getTemplateThreatLevel(a) ?? 999;
    const threatB = getTemplateThreatLevel(b) ?? 999;
    if (threatA !== threatB) return threatA - threatB;

    return String(a.name || a.id).localeCompare(String(b.name || b.id));
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

function gridDistance(first, second) {
  if (!Number.isInteger(first?.grid_x) || !Number.isInteger(first?.grid_y) || !Number.isInteger(second?.grid_x) || !Number.isInteger(second?.grid_y)) {
    return Infinity;
  }
  return Math.max(Math.abs(first.grid_x - second.grid_x), Math.abs(first.grid_y - second.grid_y));
}

function isClericEntity(entity) {
  const className = String(entity?.character_profile?.className || "").trim().toLowerCase();
  const deckId = String(entity?.core_deck_id || "").trim().toLowerCase();
  return className === "cleric" || deckId.includes("cleric");
}

function strengthenRangeFor(entity) {
  return isClericEntity(entity) ? 6 : 1;
}

function isTemplateLootable(entity) {
  return Boolean(
    entity &&
    !entity.is_player &&
    entity.template_id !== "custom" &&
    entity.template_id !== "player" &&
    entity.has_loot !== false
  );
}

function normalizeLootPayload(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  return {
    currency: payload.currency && typeof payload.currency === "object" ? payload.currency : {},
    resources: payload.resources && typeof payload.resources === "object" ? payload.resources : {},
    other: Array.isArray(payload.other) ? payload.other : [],
  };
}

function hasAnyLoot(raw) {
  const loot = normalizeLootPayload(raw);
  return Object.keys(loot.currency).length > 0 || Object.keys(loot.resources).length > 0 || loot.other.length > 0;
}

function lootPairsText(values) {
  return Object.entries(values || {})
    .filter(([, amount]) => Number(amount) !== 0)
    .map(([key, amount]) => `${key}: ${amount}`)
    .join(", ");
}

const ENERGY_TYPE_LABELS = {
  master: "Master",
  martial: "Martial",
  elemental: "Elemental",
  radiance: "Radiance",
  nature: "Nature",
  necromancy: "Necromancy",
  void: "Void",
  race: "Race",
  class: "Class",
};

const POWER_ENERGY_ORDER = ["master", "martial", "elemental", "radiance", "nature", "necromancy"];

const POWER_ENERGY_ICONS = {
  master: "✦",
  martial: "⚔",
  elemental: "✹",
  radiance: "☀",
  nature: "☘",
  necromancy: "☠",
};

const OUTCOME_SYMBOLS = { success: "✓", fate: "★", fail: "✗" };

function normalizeEnergyKey(value) {
  return String(value || "").trim().toLowerCase();
}

function getEnergyLabel(typeKey) {
  return ENERGY_TYPE_LABELS[typeKey] || titleCaseFromSnake(typeKey);
}

function collectPowerEnergyItems(cards = [], summary = null) {
  const totals = {};
  const summaryEnergies = summary?.energies ?? null;

  if (summaryEnergies && typeof summaryEnergies === "object") {
    Object.entries(summaryEnergies).forEach(([rawType, rawAmount]) => {
      const typeKey = normalizeEnergyKey(rawType);
      const amount = Number(rawAmount || 0);
      if (!typeKey || amount <= 0) return;
      totals[typeKey] = (totals[typeKey] || 0) + amount;
    });
  }

  if (Object.keys(totals).length === 0 && Array.isArray(cards)) {
    cards.forEach((card) => {
      const typeKey = normalizeEnergyKey(card?.energy_type);
      const amount = Number(card?.energy_amount || 0);
      if (!typeKey || amount <= 0) return;
      totals[typeKey] = (totals[typeKey] || 0) + amount;
    });
  }

  const orderedKeys = [
    ...POWER_ENERGY_ORDER.filter((typeKey) => totals[typeKey] > 0),
    ...Object.keys(totals)
      .filter((typeKey) => !POWER_ENERGY_ORDER.includes(typeKey) && totals[typeKey] > 0)
      .sort(),
  ];

  return orderedKeys.map((typeKey) => ({
    typeKey,
    amount: totals[typeKey],
    label: getEnergyLabel(typeKey),
    icon: POWER_ENERGY_ICONS[typeKey] || "◆",
  }));
}

function collectFreePowerCards(cards = []) {
  return cards
    .filter((card) => ["class", "race"].includes(normalizeEnergyKey(card?.energy_type)))
    .map((card) => card.title || getEnergyLabel(normalizeEnergyKey(card?.energy_type)))
    .filter(Boolean);
}

function PowerEnergyBar({ entity, summary, onOpenDetail }) {
  const cards = Array.isArray(entity?.power_draw_cards) ? entity.power_draw_cards : [];
  const energyItems = collectPowerEnergyItems(cards, summary);
  const freeCards = collectFreePowerCards(cards);

  return (
    <section className="power-energy-bar" aria-label={`Draw of Power energy pool for ${entity.name}`}>
      <div className="power-energy-copy">
        <div className="power-energy-kicker">Draw of Power</div>
        <div className="power-energy-title">{entity.name} energy pool</div>
      </div>

      <div className="power-energy-chips">
        {energyItems.length > 0 ? (
          energyItems.map((item) => (
            <span
              key={item.typeKey}
              className={`power-energy-chip power-energy-${item.typeKey}`}
              title={`${item.amount} ${item.label} energy available`}
            >
              <span className="power-energy-icon" aria-hidden="true">{item.icon}</span>
              <strong>{item.amount}</strong>
              <span>{item.label}</span>
            </span>
          ))
        ) : (
          <span className="power-energy-empty">No spendable energy drawn</span>
        )}
      </div>

      {freeCards.length > 0 ? (
        <div className="power-energy-free" title={freeCards.join(", ")}>
          Free: {freeCards.join(" · ")}
        </div>
      ) : null}

      <button className="secondary-button power-energy-detail-button" type="button" onClick={onOpenDetail}>
        Cards
      </button>
    </section>
  );
}

function DopHandPanel({ cards, summary }) {
  const outcomes = summary?.outcomes ?? {};
  const energies = summary?.energies ?? {};
  return (
    <div className="unit-inspector-section dop-hand-section">
      <div className="selected-draw-label">Draw of Power</div>
      <div className="dop-hand-chips">
        {cards.map((card, i) => {
          const typeKey = normalizeEnergyKey(card.energy_type);
          const label = ENERGY_TYPE_LABELS[typeKey] || card.energy_type || "Wound";
          const symbol = OUTCOME_SYMBOLS[card.outcome] ?? "";
          return (
            <span
              key={i}
              className={`dop-chip dop-energy-${typeKey || "wound"} dop-outcome-${card.outcome || "fail"}`}
              title={card.title}
            >
              {label}
              {card.energy_amount > 0 ? <sup>{card.energy_amount}</sup> : null}
              {symbol ? <span className="dop-chip-symbol">{symbol}</span> : null}
            </span>
          );
        })}
      </div>
      {(outcomes.success > 0 || outcomes.fate > 0 || outcomes.fail > 0 || Object.keys(energies).length > 0) ? (
        <div className="dop-summary-row">
          {Object.entries(energies).map(([type, amount]) => (
            <span key={type} className={`dop-summary-energy dop-energy-${normalizeEnergyKey(type)}`}>
              {type} {amount}
            </span>
          ))}
          <span className="dop-summary-sep" />
          {outcomes.success > 0 && <span className="dop-summary-success">{outcomes.success}✓</span>}
          {outcomes.fate > 0 && <span className="dop-summary-fate">{outcomes.fate}★</span>}
          {outcomes.fail > 0 && <span className="dop-summary-fail">{outcomes.fail}✗</span>}
        </div>
      ) : null}
    </div>
  );
}

function opportunityHitDrawLabel(text) {
  const value = String(text || "").trim();
  if (/\bsuccess\b/i.test(value)) return "Success";
  if (/\bfate\b/i.test(value)) return "Fate";
  if (/\bfail\b/i.test(value)) return "Fail";
  return value || "Card";
}

function opportunityHitDrawGroups(pendingOpportunity) {
  const drawnText = pendingOpportunity?.drawnText || [];
  if (!drawnText.length) return [];
  return [
    {
      label: "Hit draw",
      items: drawnText.map(opportunityHitDrawLabel),
      summary: pendingOpportunity.summary || null,
    },
  ];
}

function opportunityNoWillpowerLabel(pendingOpportunity) {
  const successes = Number(pendingOpportunity?.successCount || 0);
  if (successes <= 0) return "Miss";
  if (successes === 1) return "Hit";
  if (successes === 2) return "Precise hit";
  return "Critical hit";
}

function successCountLabel(count) {
  const successes = Number(count || 0);
  return `${successes} ${successes === 1 ? "succes" : "successen"}`;
}

function searchNoWillpowerLabel(pendingSearch) {
  return successCountLabel(pendingSearch?.successCount);
}

function searchWillpowerLabel(pendingSearch) {
  const successes = Number(pendingSearch?.successCount || 0);
  const fate = Number(pendingSearch?.fateCount || 0);
  return `Willpower inzetten voor ${successCountLabel(successes + fate)}`;
}

function searchNeedsManualResult(pendingSearch) {
  return Boolean(pendingSearch?.searcherPhysicalCards && pendingSearch?.successCount == null);
}

function opportunityWillpowerLabel(pendingOpportunity) {
  const successes = Number(pendingOpportunity?.successCount || 0);
  const fate = Number(pendingOpportunity?.fateCount || 0);
  const total = successes + fate;
  if (total >= 3) return "Willpower inzetten voor critical hit";
  if (total === 2) return "Willpower inzetten voor precise hit";
  if (total === 1) return "Willpower inzetten voor hit";
  return "Willpower inzetten";
}

function opportunityHasFate(pendingOpportunity) {
  return Number(pendingOpportunity?.fateCount || 0) > 0;
}

function opportunityModalForPending(pendingOpportunity) {
  const phase = pendingOpportunity?.phase;
  if (phase === "willpower" || phase === "confirm") return "opportunity-willpower";
  return "opportunity";
}

function opportunityResultTitle(pendingOpportunity) {
  return opportunityHasFate(pendingOpportunity) ? "Fate getrokken - Willpower inzetten?" : "Opportunity Attack";
}

function opportunityResultSubtitle(pendingOpportunity) {
  if (!pendingOpportunity) return "";
  const successes = Number(pendingOpportunity.successCount || 0);
  const fate = Number(pendingOpportunity.fateCount || 0);
  return fate > 0 ? `${successes} successen + ${fate} fate` : `${successes} successen`;
}

function opportunityResolutionTitle(opportunityResolution) {
  const count = opportunityResolution?.events?.length || 0;
  return count === 1 ? "Enemy Opportunity Attack" : "Enemy Opportunity Attacks";
}

function opportunityResolutionSubtitle(opportunityResolution) {
  const count = opportunityResolution?.events?.length || 0;
  if (count <= 0) return "";
  const stopped = opportunityResolution.events.some((event) => event?.stopped);
  return `${count} attack${count === 1 ? "" : "s"} resolved${stopped ? " - movement stopped" : ""}`;
}

function opportunityEventDamageLine(event) {
  const damage = Number(event?.damage || 0);
  const toughness = Number(event?.damageToToughness || 0);
  if (damage <= 0) return "No regular attack damage.";
  const parts = [`Attack ${damage}`, `${toughness} to Toughness`];
  if (event?.unpreventable) parts.push("unpreventable");
  return `${parts.join(", ")}.`;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function woundTargetEntity(woundEvent, entities) {
  if (!woundEvent || !Array.isArray(entities)) return null;
  const targetId = woundEvent.instanceId || woundEvent.instance_id || "";
  if (targetId) {
    const byId = entities.find((entity) => entity?.instance_id === targetId || entity?.instanceId === targetId);
    if (byId) return byId;
  }
  const targetName = woundEvent.name || "";
  if (!targetName) return null;
  return entities.find((entity) => entity?.name === targetName) || null;
}

function woundEventWithCurrentToughness(woundEvent, entities = []) {
  if (!woundEvent) return null;
  const entity = woundTargetEntity(woundEvent, entities);
  if (!entity) return woundEvent;
  const finalToughness = firstFiniteNumber(entity?.toughness_current, entity?.toughnessCurrent);
  const finalMax = firstFiniteNumber(entity?.toughness_max, entity?.toughnessMax);
  if (finalToughness === null && finalMax === null) return woundEvent;
  return {
    ...woundEvent,
    toughnessAfter: finalToughness ?? woundEvent.toughnessAfter,
    toughnessMax: finalMax ?? woundEvent.toughnessMax,
  };
}

function combinedWoundEvent(woundEvents, entities = []) {
  const events = Array.isArray(woundEvents)
    ? woundEvents.filter((event) => event && Number(event.wounds || 0) > 0)
    : [];
  if (!events.length) return null;
  const first = events[0];
  const firstTarget = first.instanceId || first.name || "";
  if (!events.every((event) => (event.instanceId || event.name || "") === firstTarget)) {
    return woundEventWithCurrentToughness(first, entities);
  }
  const merged = events.reduce(
    (merged, event) => ({
      ...merged,
      ...event,
      wounds: Number(merged.wounds || 0) + Number(event.wounds || 0),
      toughnessAfter: event.toughnessAfter ?? merged.toughnessAfter,
      toughnessMax: event.toughnessMax ?? merged.toughnessMax,
    }),
    { ...first, wounds: 0 },
  );
  return woundEventWithCurrentToughness(merged, entities);
}

function CreatureInfoPanel({ info }) {
  if (!info) return null;
  const skills = Object.entries(info.skills || {});
  const actions = CREATURE_ACTION_ORDER
    .map((key) => [key, info.actions?.[key]])
    .filter(([, value]) => value);

  return (
    <div className="unit-inspector-section creature-info-section">
      <div className="selected-draw-label">Creature</div>
      <div className="creature-taxonomy-line">
        {[info.part, info.section, info.threatLevel != null ? `TL ${info.threatLevel}` : null]
          .filter(Boolean)
          .join(" / ")}
      </div>
      {info.shortFlavour ? <div className="creature-flavour">{info.shortFlavour}</div> : null}
      {info.traits ? <div className="creature-traits">{info.traits}</div> : null}
      {skills.length > 0 ? (
        <div className="creature-skill-grid">
          {skills.map(([key, value]) => (
            <span key={key} className="creature-skill-pill">
              <span>{CREATURE_SKILL_LABELS[key] || titleCaseFromSnake(key)}</span>
              <strong>{value}</strong>
            </span>
          ))}
        </div>
      ) : null}
      {actions.length > 0 ? (
        <details className="creature-actions-list">
          <summary>Actions</summary>
          {actions.map(([key, value]) => (
            <div key={key} className="creature-action-row">
              <strong>{key}</strong>
              <span>{value}</span>
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}

function App() {
  const bootstrapped = useRef(false);
  const actionMenuRef = useRef(null);
  const unitContextMenuRef = useRef(null);
  const repositionReturnModeRef = useRef(null);

  const [snapshot, setSnapshot] = useState(null);
  const [meta, setMeta] = useState(null);
  const [characterCatalog, setCharacterCatalog] = useState(null);
  const [savedCharacters, setSavedCharacters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState(null);
  const [activeView, setActiveView] = useState(APP_VIEWS.BATTLE);
  const [flavourText, setFlavourText] = useState(null);
  const [addUnitTab, setAddUnitTab] = useState("premade");
  const [templateSearch, setTemplateSearch] = useState("");
  const [templateCategory, setTemplateCategory] = useState("All");
  const [templateSection, setTemplateSection] = useState("All");
  const [templateAvailability, setTemplateAvailability] = useState("spawnable");
  const [templateThreatMin, setTemplateThreatMin] = useState("");
  const [templateThreatMax, setTemplateThreatMax] = useState("");
  const [mapMode, setMapMode] = useState(MAP_MODES.IDLE);
  const [pendingDashMove, setPendingDashMove] = useState(null);
  const [saveName, setSaveName] = useState("session");
  const [saves, setSaves] = useState([]);
  const [mapTemplateName, setMapTemplateName] = useState("map template");
  const [mapTemplates, setMapTemplates] = useState([]);
  const [pendingGuardAction, setPendingGuardAction] = useState(null);
  const [pcPicker, setPcPicker] = useState(null);
  const [pcPickerSelection, setPcPickerSelection] = useState([]);
  const [pcPickerTab, setPcPickerTab] = useState("premade");
  const [pcPickerCustom, setPcPickerCustom] = useState(EMPTY_PC_PICKER_CUSTOM);
  const [attackForm, setAttackForm] = useState(EMPTY_ATTACK_FORM);
  const [attackTarget, setAttackTarget] = useState(null);
  const [healForm, setHealForm] = useState(EMPTY_HEAL_FORM);
  const [drawExactCount, setDrawExactCount] = useState(1);
  const [strengthenCount, setStrengthenCount] = useState(1);
  const [strengthenTargetId, setStrengthenTargetId] = useState("");
  const [guardCount, setGuardCount] = useState(1);
  const [actionWarningAcknowledged, setActionWarningAcknowledged] = useState(false);
  const [pendingActionFn, setPendingActionFn] = useState(null);
  const [actionTargeting, setActionTargeting] = useState(null);
  const [helpTargets, setHelpTargets] = useState([]);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [unitContextMenu, setUnitContextMenu] = useState(null);
  const [previewEntityId, setPreviewEntityId] = useState(null);
  const [lootPopoverOpen, setLootPopoverOpen] = useState(false);
  const [drawReveal, setDrawReveal] = useState(null);
  const [drawDetail, setDrawDetail] = useState(null);
  const [woundNotice, setWoundNotice] = useState(null);
  const [pendingWoundRemove, setPendingWoundRemove] = useState(null);
  const [opportunityResolution, setOpportunityResolution] = useState(null);
  const [opportunityManual, setOpportunityManual] = useState({ successes: 0, fate: 0 });
  const [manualSearchSuccesses, setManualSearchSuccesses] = useState(0);
  const [customForm, setCustomForm] = useState({
    name: "Custom",
    toughness: 10,
    armor: 0,
    magicArmor: 0,
    draw: 1,
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
    physicalCards: false,
  });
  const [characterBuilderForm, setCharacterBuilderForm] = useState(() => createCharacterBuilderForm(null));
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
  const [mapLight, setMapLight] = useState(getInitialMapLight);

  useEffect(() => {
    try {
      window.localStorage.setItem(MAP_LIGHT_STORAGE_KEY, String(mapLight));
    } catch {
      // Local storage is a convenience only; the slider should keep working without it.
    }
  }, [mapLight]);

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
      current === MAP_MODES.GM_REPOSITION || current === MAP_MODES.GM_DUNGEON || current === MAP_MODES.PARTY_WALK
        ? current
        : MAP_MODES.IDLE,
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
    setLootPopoverOpen(false);
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
    if (activeView === APP_VIEWS.BATTLE && snapshot?.pendingNewRound) {
      setModal("new-round");
    }
  }, [activeView, snapshot?.pendingNewRound]);

  useEffect(() => {
    if (activeView !== APP_VIEWS.BATTLE || !snapshot?.pendingSearch) {
      return;
    }
    if (searchNeedsManualResult(snapshot.pendingSearch)) {
      setModal("search-manual");
    } else if (snapshot.pendingSearch.hasFate) {
      setModal("search-resolve");
    }
  }, [
    activeView,
    snapshot?.pendingSearch?.entityId,
    snapshot?.pendingSearch?.edgeKey,
    snapshot?.pendingSearch?.phase,
    snapshot?.pendingSearch?.searcherPhysicalCards,
    snapshot?.pendingSearch?.hasFate,
    snapshot?.pendingSearch?.successCount,
  ]);

  useEffect(() => {
    if (activeView !== APP_VIEWS.BATTLE || !snapshot?.pendingOpportunity) {
      return;
    }
    setModal(opportunityModalForPending(snapshot.pendingOpportunity));
  }, [
    activeView,
    snapshot?.pendingOpportunity?.attackerId,
    snapshot?.pendingOpportunity?.targetId,
    snapshot?.pendingOpportunity?.phase,
  ]);

  useEffect(() => {
    setOpportunityManual({ successes: 0, fate: 0 });
  }, [snapshot?.pendingOpportunity?.attackerId, snapshot?.pendingOpportunity?.targetId]);

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
        const [metaPayload, snapshotPayload, characterCatalogPayload, charactersPayload] = await Promise.all([
          requestJson("/api/battle/meta"),
          sid ? requestJson(`/api/battle/sessions/${sid}`) : requestJson("/api/battle/sessions", { method: "POST" }),
          requestJson("/api/battle/character-builder/catalog"),
          requestJson("/api/battle/characters"),
        ]);
        setMeta(metaPayload);
        setSnapshot(snapshotPayload);
        setCharacterCatalog(characterCatalogPayload);
        setSavedCharacters(charactersPayload.characters || []);
        setCharacterBuilderForm(createCharacterBuilderForm(characterCatalogPayload));
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
  const activeSave = snapshot?.activeSave || null;
  const orderedEnemies = orderEntities(orderIds, enemies);
  const selectedEntity =
    orderedEnemies.find((entity) => entity.instance_id === snapshot?.selectedId) || orderedEnemies[0] || null;
  const activeEntity = orderedEnemies.find((entity) => entity.instance_id === snapshot?.activeTurnId) || null;
  const contextMenuEntity = unitContextMenu
    ? orderedEnemies.find((entity) => entity.instance_id === unitContextMenu.entityId) || null
    : null;
  const contextMenuActor = unitContextMenu?.actorId
    ? orderedEnemies.find((entity) => entity.instance_id === unitContextMenu.actorId) || null
    : null;
  const previewEntity = previewEntityId
    ? orderedEnemies.find((entity) => entity.instance_id === previewEntityId) || null
    : null;
  const selectedEntityState = selectedEntity ? getEntityState(selectedEntity, snapshot.selectedId, snapshot.activeTurnId) : null;
  const selectedDrawIsStored = Boolean(snapshot?.activeTurnId && selectedEntity && snapshot.activeTurnId !== selectedEntity.instance_id);
  const activeDetachedEntity =
    activeEntity && activeEntity.instance_id !== selectedEntity?.instance_id ? activeEntity : null;
  const isPlayerSelected = Boolean(selectedEntity?.is_player);
  const selectedUsesPhysicalCards = Boolean(isPlayerSelected && selectedEntity?.physical_cards);
  const selectedIsDown = Boolean(selectedEntity?.is_down);
  const selectedIsKo = Boolean(selectedEntity?.is_ko);
  const selectedPowerDrawUsed = Boolean(selectedEntity?.power_draw_used);
  const selectedWoundCounts = selectedEntity?.wound_counts || { hand: 0, discard: 0, draw_pile: 0, total: 0 };
  const selectedGrappledBy = selectedEntity?.grappled_by || [];
  const selectedGrappling = selectedEntity?.grappling || [];
  const movementState = snapshot?.movementState || null;
  const dungeon = snapshot?.dungeon || null;
  const selectedIsActive = Boolean(selectedEntity && snapshot?.activeTurnId === selectedEntity.instance_id);
  const hasActiveTurn = Boolean(snapshot?.activeTurnId);
  const pendingNewRound = Boolean(snapshot?.pendingNewRound);
  const hasStartableUnit = orderedEnemies.some((entity) => !entity.is_down);
  const hasLiveOrderedEnemy = Boolean(snapshot?.hasLiveOrderedEnemy) || orderIds.some((instanceId) => {
    const entity = orderedEnemies.find((candidate) => candidate.instance_id === instanceId);
    return entity && !entity.is_player && !entity.is_down;
  });
  const hasLiveEnemy = orderedEnemies.some((entity) => !entity.is_player && !entity.is_down);
  const combatIsRunning = Boolean(snapshot?.encounterStarted || hasActiveTurn || pendingNewRound);
  const canEndCombat = Boolean(snapshot?.encounterStarted && !hasLiveEnemy);
  const canManualEndCombat = Boolean(snapshot?.encounterStarted);
  const turnAdvanceLabel = canEndCombat
    ? "End Combat"
    : pendingNewRound
      ? "Start Round"
      : hasActiveTurn || (snapshot?.encounterStarted && hasStartableUnit)
        ? "Next"
        : "Start encounter";
  const canAdvanceTurn = Boolean(canEndCombat || hasActiveTurn || hasStartableUnit || pendingNewRound);
  const canUseTurnAction = Boolean(combatIsRunning && selectedIsActive && !selectedIsDown);
  const selectedMovementBase =
    selectedIsActive && movementState?.entityId === selectedEntity?.instance_id
      ? Number(movementState.baseMovement)
      : Number(selectedEntity?.effective_movement || 0);
  const selectedMovementUsed =
    selectedIsActive && movementState?.entityId === selectedEntity?.instance_id
      ? Number(movementState.movementUsed)
      : 0;
  const selectedMovementRemaining =
    selectedIsActive && movementState?.entityId === selectedEntity?.instance_id && movementState?.movementStopped
      ? 0
      : Math.max(0, selectedMovementBase * 2 - selectedMovementUsed);
  const pendingOpportunity = snapshot?.pendingOpportunity ?? null;
  const pendingSearch = snapshot?.pendingSearch ?? null;
  const pendingEncounterRoomIds = dungeon?.pendingEncounterRoomIds || [];
  const partyWalkBlockedByCombat = Boolean(
    (snapshot?.encounterStarted || pendingNewRound) && hasLiveOrderedEnemy,
  );
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
  const isWalkMode = mapMode === MAP_MODES.WALK;
  const isPartyWalkMode = mapMode === MAP_MODES.PARTY_WALK;
  const canUseGmReposition = orderedEnemies.length > 0;
  const canUseMapWalk = Boolean(
    !snapshot?.encounterStarted &&
    !snapshot?.activeTurnId &&
    !snapshot?.turnInProgress &&
    !partyWalkBlockedByCombat &&
    !pendingOpportunity &&
    pendingEncounterRoomIds.length === 0,
  );
  const canUseWalk = Boolean(
    selectedEntity &&
      !selectedIsDown &&
      hasGridPosition(selectedEntity, room, dungeon) &&
      canUseMapWalk,
  );
  const canUsePartyWalk = Boolean(
    selectedEntity &&
      isPlayerSelected &&
      !selectedIsDown &&
      hasGridPosition(selectedEntity, room, dungeon) &&
      !snapshot?.encounterStarted &&
      !snapshot?.activeTurnId &&
      !snapshot?.turnInProgress &&
      !partyWalkBlockedByCombat &&
      !pendingOpportunity &&
      pendingEncounterRoomIds.length === 0,
  );
  const showPartyWalkButton = Boolean(isPlayerSelected && !combatIsRunning);
  const fogOfWarEnabled = dungeon?.fogOfWarEnabled ?? true;
  const visibleRoomIds = new Set(dungeon?.visibleRoomIds || []);
  const revealedRoomIdSet = new Set(dungeon?.revealedRoomIds || []);

  useEffect(() => {
    if (mapMode === MAP_MODES.WALK && !canUseWalk) {
      setMapMode(MAP_MODES.IDLE);
    }
  }, [mapMode, canUseWalk]);

  useEffect(() => {
    if (mapMode === MAP_MODES.PARTY_WALK && !canUsePartyWalk) {
      setMapMode(MAP_MODES.IDLE);
    }
  }, [mapMode, canUsePartyWalk]);

  useEffect(() => {
    if (actionTargeting && (activeView !== APP_VIEWS.BATTLE || actionTargeting.actorId !== selectedEntity?.instance_id)) {
      setActionTargeting(null);
      setStrengthenTargetId("");
    }
  }, [actionTargeting, activeView, selectedEntity?.instance_id]);

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
  const activeEntityGrappled = Boolean(activeEntity?.grappled_by?.length);
  const hasQuickAttackTarget = Boolean(
    activeEntity &&
      !activeEntity.is_player &&
      snapshot.turnInProgress &&
      (activeEntityGrappled ||
        (selectedEntity &&
          activeEntity.instance_id !== selectedEntity.instance_id &&
          !selectedIsDown)) &&
      activeDrawAttacks.length > 0,
  );
  const canQuickAttack = hasQuickAttackTarget && !quickAttackAlreadyUsed;

  const canDraw = Boolean(
    selectedEntity &&
      !selectedIsDown &&
      canUseTurnAction &&
      !selectedUsesPhysicalCards &&
      (isPlayerSelected ? !selectedPowerDrawUsed : !snapshot.turnInProgress),
  );
  const canHitdraw = Boolean(
    selectedEntity &&
      isPlayerSelected &&
      !selectedIsDown &&
      canUseTurnAction &&
      !selectedUsesPhysicalCards &&
      selectedPowerDrawUsed,
  );
  const canDrawExact = Boolean(selectedEntity && isPlayerSelected && !selectedUsesPhysicalCards && canUseTurnAction);
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
  const canHelp = isPlayerSelected && canUseTurnAction && pcEntitiesInRange.length > 0;
  const strengthenRangeCells = selectedEntity ? strengthenRangeFor(selectedEntity) : 1;
  const strengthenTargetEntities = isPlayerSelected
    ? orderedEnemies.filter(
        (entity) =>
          entity.is_player &&
          !entity.is_down &&
          (entity.instance_id === selectedEntity?.instance_id || gridDistance(selectedEntity, entity) <= strengthenRangeCells),
      )
    : [];
  const strengthenTargetIds = strengthenTargetEntities.map((entity) => entity.instance_id);
  const activeActionTargeting = actionTargeting?.actorId === selectedEntity?.instance_id ? actionTargeting : null;
  const mapActionTargeting = activeActionTargeting
    ? {
        ...activeActionTargeting,
        validTargetIds: activeActionTargeting.action === "strengthen" ? strengthenTargetIds : activeActionTargeting.validTargetIds || [],
        validGrappleIds: activeActionTargeting.validGrappleIds || [],
      }
    : null;

  const currentPcRoomId = selectedEntity?.room_id ?? null;
  const roomAlreadySearched = Boolean(currentPcRoomId && (dungeon?.searchedRoomIds || []).includes(currentPcRoomId));
  const canUseSearchAction = Boolean(
    isPlayerSelected &&
      !selectedIsDown &&
      !combatIsRunning &&
      !pendingOpportunity &&
      pendingEncounterRoomIds.length === 0,
  );
  const canUseInvestigateAction = Boolean(
    isPlayerSelected &&
      !selectedIsDown &&
      (canUseTurnAction || !combatIsRunning) &&
      !pendingOpportunity &&
      pendingEncounterRoomIds.length === 0,
  );
  const canSearch = Boolean(
    canUseSearchAction &&
      dungeon &&
      !roomAlreadySearched &&
      !pendingSearch
  );

  const adjacentSuspects = useMemo(() => {
    if (!canUseInvestigateAction) return [];
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
  }, [dungeon?.secretSuspects, dungeon?.rooms, canUseInvestigateAction, selectedEntity?.grid_x, selectedEntity?.grid_y, selectedEntity?.instance_id]);
  const canShed = isPlayerSelected && !selectedUsesPhysicalCards && canUseTurnAction && (selectedEntity?.wounds_in_hand ?? 0) > 0;
  const canRedraw = Boolean(
    selectedEntity &&
      !selectedIsDown &&
      !selectedUsesPhysicalCards &&
      snapshot.turnInProgress &&
      snapshot?.activeTurnId === selectedEntity.instance_id,
  ) && (!isPlayerSelected || selectedPowerDrawUsed);
  const canDiscardWound = Boolean(isPlayerSelected && !selectedUsesPhysicalCards && Number(selectedWoundCounts.hand) > 0);
  const canRemoveWound = Boolean(isPlayerSelected && !selectedUsesPhysicalCards && Number(selectedWoundCounts.total) > 0);
  const canAdjustPhysicalWounds = Boolean(isPlayerSelected && selectedUsesPhysicalCards);
  const removeWoundNeedsDeckConfirm = Boolean(
    isPlayerSelected &&
      Number(selectedWoundCounts.hand) === 0 &&
      Number(selectedWoundCounts.discard) === 0 &&
      Number(selectedWoundCounts.draw_pile) > 0,
  );
  const canAttackOrHeal = Boolean(visibleSelectedEntity && !selectedIsDown);
  const selectedTargetNoun = isPlayerSelected ? "player" : "enemy";
  const attackTargetLabel = attackTarget?.label || selectedTargetNoun;
  const strengthenTarget = strengthenTargetId
    ? orderedEnemies.find((entity) => entity.instance_id === strengthenTargetId) || null
    : selectedEntity;
  const canInspectSelectedLoot = Boolean(
    visibleSelectedEntity?.is_down &&
      !visibleSelectedEntity?.loot_rolled &&
      isTemplateLootable(visibleSelectedEntity),
  );
  const visibleUninspectedLootEnemies = orderedEnemies.filter(
    (entity) => entity.is_down && !entity.is_player && !entity.loot_rolled && isTemplateLootable(entity) && isEntityVisible(entity),
  );
  const canInspectAllLoot = Boolean(!combatIsRunning && visibleUninspectedLootEnemies.length > 0);
  const canDisengage = Boolean(selectedEntity && canUseTurnAction);
  const canContextInspectLoot = Boolean(contextMenuEntity?.is_down && !contextMenuEntity?.loot_rolled && isTemplateLootable(contextMenuEntity));
  const contextActorAdjacentToLoot = Boolean(
    contextMenuActor &&
      contextMenuEntity &&
      contextMenuActor.grid_x != null &&
      contextMenuActor.grid_y != null &&
      contextMenuEntity.grid_x != null &&
      contextMenuEntity.grid_y != null &&
      Math.max(
        Math.abs(contextMenuActor.grid_x - contextMenuEntity.grid_x),
        Math.abs(contextMenuActor.grid_y - contextMenuEntity.grid_y),
      ) <= 1,
  );
  const canContextTakeLoot = Boolean(
    contextMenuEntity?.is_down &&
      contextMenuEntity?.loot_rolled &&
      !contextMenuEntity?.loot_taken_by &&
      contextMenuActor?.is_player &&
      !contextMenuActor?.is_down &&
      contextActorAdjacentToLoot,
  );
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
  const selectedHasDraw = !selectedUsesPhysicalCards && selectedDrawGroups.length > 0;
  const selectedHasLoot = Boolean(selectedEntity?.loot_rolled);
  const selectedInventory = normalizeLootPayload(selectedEntity?.inventory);
  const selectedHasInventory = Boolean(selectedEntity?.is_player && hasAnyLoot(selectedInventory));
  const canOpenActionMore = Boolean(canRedraw || canAttackOrHeal || canInspectSelectedLoot || canReposition || canDisengage || canHelp);
  const sessionHasHistory = Boolean(snapshot?.canUndo || snapshot?.canRedo || snapshot?.undoDepth || snapshot?.redoDepth);
  const canRollInitiative = Boolean(snapshot?.canRollInitiative) && orderIds.length > 0;
  const initiativeTargetRound = snapshot?.initiativeTargetRound ?? null;
  const initiativeRolledRound = snapshot?.initiativeRolledRound ?? null;
  const initiativeRolledForTarget =
    initiativeTargetRound !== null && initiativeRolledRound === initiativeTargetRound;
  const allTemplates = meta?.enemyTemplates || [];
  const templateCategories = useMemo(() => ["All", ...uniqueInOrder(allTemplates.map(getTemplateCategory))], [allTemplates]);
  const templateCategoryStats = useMemo(() => {
    const stats = new Map();
    stats.set("All", summarizeTemplates(allTemplates));
    templateCategories.filter((category) => category !== "All").forEach((category) => {
      stats.set(category, summarizeTemplates(allTemplates.filter((template) => getTemplateCategory(template) === category)));
    });
    return stats;
  }, [allTemplates, templateCategories]);
  const templateSections = useMemo(() => {
    if (templateCategory === "All") {
      return ["All"];
    }
    const scoped = templateCategory === "All"
      ? allTemplates
      : allTemplates.filter((template) => getTemplateCategory(template) === templateCategory);
    return ["All", ...uniqueInOrder(scoped.map(getTemplateSection))];
  }, [allTemplates, templateCategory]);
  const templateSectionStats = useMemo(() => {
    const scoped = templateCategory === "All"
      ? allTemplates
      : allTemplates.filter((template) => getTemplateCategory(template) === templateCategory);
    const stats = new Map();
    stats.set("All", summarizeTemplates(scoped));
    templateSections.filter((section) => section !== "All").forEach((section) => {
      stats.set(section, summarizeTemplates(scoped.filter((template) => getTemplateSection(template) === section)));
    });
    return stats;
  }, [allTemplates, templateCategory, templateSections]);
  const templateThreatLevels = useMemo(
    () => Array.from(new Set(allTemplates.map(getTemplateThreatLevel).filter((value) => value !== null))).sort((a, b) => a - b),
    [allTemplates],
  );
  const shownTemplates = useMemo(
    () => filterTemplates(allTemplates, {
      search: templateSearch,
      category: templateCategory,
      section: templateSection,
      availability: templateAvailability,
      threatMin: templateThreatMin,
      threatMax: templateThreatMax,
    }),
    [allTemplates, templateSearch, templateCategory, templateSection, templateAvailability, templateThreatMin, templateThreatMax],
  );
  const builderClass = useMemo(
    () => findCatalogClass(characterCatalog, characterBuilderForm.classId),
    [characterCatalog, characterBuilderForm.classId],
  );
  const builderAncestry = useMemo(
    () => findCatalogAncestry(characterCatalog, characterBuilderForm.ancestryId),
    [characterCatalog, characterBuilderForm.ancestryId],
  );
  const builderArtOptions = useMemo(
    () => matchingCharacterArtOptions(characterCatalog, characterBuilderForm.classId, characterBuilderForm.ancestryId),
    [characterCatalog, characterBuilderForm.classId, characterBuilderForm.ancestryId],
  );
  const builderAnonymousArt = useMemo(
    () => anonymousCharacterArt(characterCatalog),
    [characterCatalog],
  );
  const builderShownArtOptions = useMemo(() => {
    const options = [builderAnonymousArt, ...builderArtOptions];
    if (
      characterBuilderForm.art?.source === "upload" &&
      !options.some((option) => sameCharacterArt(option, characterBuilderForm.art))
    ) {
      options.push(characterBuilderForm.art);
    }
    return options;
  }, [builderAnonymousArt, builderArtOptions, characterBuilderForm.art]);
  const builderForbiddenEnergyTypes = builderClass?.forbiddenEnergyTypes || [];
  const builderSelectedForbiddenEnergyTypes = useMemo(
    () => builderForbiddenEnergyTypes.filter((energyType) => characterBuilderForm.energyTypes.includes(energyType)),
    [builderForbiddenEnergyTypes, characterBuilderForm.energyTypes],
  );
  const builderSelectedForbiddenLabel = builderSelectedForbiddenEnergyTypes.join(", ");
  const builderErrors = useMemo(
    () => builderValidationErrors(characterCatalog, characterBuilderForm),
    [characterCatalog, characterBuilderForm],
  );
  const builderCanSave = Boolean(characterCatalog && builderErrors.length === 0);
  const builderClassTargetOptions = useMemo(() => {
    const upgrades = characterBuilderForm.deckUpgrades?.[characterBuilderForm.mainArt] || {};
    return BUILDER_UPGRADE_KEYS.filter(({ key }) => 1 + Number(upgrades[key] || 0) < 3);
  }, [characterBuilderForm.deckUpgrades, characterBuilderForm.mainArt]);
  const selectedDrawPreviewHighlighted = Boolean(
    drawReveal?.phase === "settle" && selectedEntity?.instance_id === drawReveal.entityId,
  );

  useEffect(() => {
    if (!characterBuilderForm.gmOverride || builderSelectedForbiddenEnergyTypes.length > 0) {
      return;
    }
    setCharacterBuilderForm((current) => (
      current.gmOverride ? { ...current, gmOverride: false } : current
    ));
  }, [characterBuilderForm.gmOverride, builderSelectedForbiddenEnergyTypes.length]);

  function closeModal() {
    setModal(null);
    setAddUnitTab("premade");
    setTemplateSearch("");
    setTemplateCategory("All");
    setTemplateSection("All");
    setTemplateAvailability("spawnable");
    setTemplateThreatMin("");
    setTemplateThreatMax("");
    setPendingDashMove(null);
    setPendingLargeTileEdit(null);
    setActionTargeting(null);
    setAttackTarget(null);
    setStrengthenTargetId("");
    setDrawDetail(null);
    setPreviewEntityId(null);
    setWoundNotice(null);
    setPendingWoundRemove(null);
    setOpportunityResolution(null);
    setOpportunityManual({ successes: 0, fate: 0 });
    setManualSearchSuccesses(0);
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

  function showHitDrawReveal(payload) {
    const hitDraw = payload?.hitDraw;
    const cardItems = Array.isArray(hitDraw?.drawnCards) ? hitDraw.drawnCards : [];
    const items = cardItems.length ? cardItems : Array.isArray(hitDraw?.drawnText) ? hitDraw.drawnText : [];
    if (!hitDraw || !items.length) {
      return;
    }
    setDrawReveal({
      key: `hitdraw-${hitDraw.entityId}-${Date.now()}`,
      entityId: hitDraw.entityId,
      entityName: hitDraw.entityName,
      items,
      groups: [{ label: "Hit draw", items, summary: null }],
      sticky: true,
      kind: "hit draw",
      showEnergies: false,
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
    if (snapshot?.sessionDirty) {
      runWithUnsavedGuard(createNewSession);
      return;
    }
    if (!sessionHasHistory) {
      createNewSession();
      return;
    }
    setModal("new-session-confirm");
  }

  // ── Unsaved-changes guard ────────────────────────────────────────────────
  // Any action that discards/replaces the live session routes through this.
  // If the session has unsaved changes, ask Save / Continue / Cancel first.
  function runWithUnsavedGuard(action) {
    if (!snapshot?.sessionDirty) {
      return action();
    }
    setPendingGuardAction(() => action);
    setModal("unsaved-guard");
    return undefined;
  }

  async function handleGuardContinue() {
    const action = pendingGuardAction;
    setPendingGuardAction(null);
    closeModal();
    if (action) await action();
  }

  function handleGuardCancel() {
    setPendingGuardAction(null);
    closeModal();
  }

  async function handleGuardSave() {
    if (activeSave?.filename) {
      closeModal();
      const payload = await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/saves/${encodeURIComponent(activeSave.filename)}`,
        { method: "PUT" },
        "Session saved",
      );
      const action = pendingGuardAction;
      setPendingGuardAction(null);
      if (payload && action) await action();
    } else {
      // No active save slot yet — route to Save As; the pending action runs
      // after a successful save (see handleSaveSubmit).
      await openSaveAsModal();
    }
  }

  function handleStartPlay() {
    openPcPicker(async (players) => {
      const payload = await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/start-play`,
        { method: "POST", body: JSON.stringify({ players }) },
        "Play session started",
      );
      if (payload) {
        setMapMode(MAP_MODES.IDLE);
      }
    });
  }

  // ── PC picker (which PCs spawn on Start / Load Encounter) ─────────────────
  function openPcPicker(onConfirm) {
    setPcPickerSelection([]);
    setPcPickerTab("premade");
    setPcPickerCustom({ ...EMPTY_PC_PICKER_CUSTOM, playerDeckId: meta?.playerDecks?.[0]?.id || "" });
    setPcPicker({ onConfirm });
    refreshSavedCharacters();
    setModal("pc-picker");
  }

  function addPremadePc(character) {
    setPcPickerSelection((current) => [
      ...current,
      { kind: "premade", characterId: character.id, name: character.name },
    ]);
  }

  function addCustomPc() {
    const name = pcPickerCustom.name.trim() || "Player";
    setPcPickerSelection((current) => [
      ...current,
      {
        kind: "custom",
        name,
        playerDeckId: pcPickerCustom.playerDeckId || (meta?.playerDecks?.[0]?.id || ""),
        toughness: pcPickerCustom.toughness,
        armor: pcPickerCustom.armor,
        magicArmor: pcPickerCustom.magicArmor,
        power: pcPickerCustom.power,
        movement: pcPickerCustom.movement,
        baseGuard: pcPickerCustom.baseGuard,
        initiativeModifier: pcPickerCustom.initiativeModifier,
      },
    ]);
    setPcPickerCustom((current) => ({ ...current, name: "" }));
  }

  function removePcFromSelection(index) {
    setPcPickerSelection((current) => current.filter((_, i) => i !== index));
  }

  async function confirmPcPicker() {
    const onConfirm = pcPicker?.onConfirm;
    const players = pcPickerSelection.map(({ kind, ...spec }) => spec);
    setPcPicker(null);
    closeModal();
    if (onConfirm) await onConfirm(players);
  }

  function cancelPcPicker() {
    setPcPicker(null);
    closeModal();
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
      const nextSaves = payload.saves || [];
      setSaves(nextSaves);
      return nextSaves;
    } catch (requestError) {
      setError(requestError.message);
      return [];
    } finally {
      setBusy(false);
    }
  }

  async function openSaveAsModal() {
    await refreshSaveList();
    setSaveName(activeSave?.name || "session");
    setModal("save-as");
  }

  async function openLoadModal() {
    await refreshSaveList();
    setModal("load");
  }

  function openAddUnitModal() {
    setAddUnitTab("premade");
    setTemplateSearch("");
    setTemplateCategory("All");
    setTemplateSection("All");
    setTemplateAvailability("spawnable");
    setTemplateThreatMin("");
    setTemplateThreatMax("");
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

  async function submitSetPlayerSpawn(cell) {
    if (!snapshot?.sid || !cell) return null;
    return applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/player-spawn`, {
      method: "POST",
      body: JSON.stringify({ x: cell.x, y: cell.y }),
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
    if (searchNeedsManualResult(payload.pendingSearch)) {
      setManualSearchSuccesses(0);
      setModal("search-manual");
    } else if (payload.pendingSearch?.hasFate) {
      setModal("search-resolve");
    } else {
      const resolved = await applySnapshotRequest(
        `/api/battle/sessions/${snapshot.sid}/dungeon/search/resolve`,
        { method: "POST", body: JSON.stringify({ useWillpower: false, partyWalk: mapMode === MAP_MODES.PARTY_WALK }) },
      );
      showSearchFlavour(resolved);
    }
  }

  async function handleResolveSearch(useWillpower, manualResult = {}) {
    const resolvePath = pendingSearch?.kind === "suspect"
      ? "dungeon/suspects/resolve"
      : "dungeon/search/resolve";
    const body = pendingSearch?.kind === "suspect"
      ? { useWillpower }
      : { useWillpower, partyWalk: mapMode === MAP_MODES.PARTY_WALK };
    if (manualResult.successes != null) {
      body.successes = Math.max(0, Number(manualResult.successes || 0));
      body.fate = Math.max(0, Number(manualResult.fate || 0));
    }
    closeModal();
    const resolved = await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/${resolvePath}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    showSearchFlavour(resolved);
  }

  function handleResolveManualSearch(successes = manualSearchSuccesses) {
    handleResolveSearch(false, { successes, fate: 0 });
  }

  function handleOpportunityPayload(payload) {
    if (!payload) return;
    if (payload.opportunityNotice) {
      setNotice(payload.opportunityNotice);
    }
    const nextPending = payload.pendingOpportunity;
    if (nextPending) {
      setModal(opportunityModalForPending(nextPending));
      return;
    }
    const opportunityEvents = Array.isArray(payload.opportunityEvents) ? payload.opportunityEvents : [];
    const woundEvent = combinedWoundEvent(payload.woundEvents, payload.enemies);
    if (opportunityEvents.length > 0) {
      setOpportunityResolution({ events: opportunityEvents, woundEvent });
      setModal("opportunity-resolved");
      return;
    }
    if (woundEvent && Number(woundEvent.wounds) > 0) {
      setWoundNotice(woundEvent);
      setModal("wounds");
      return;
    }
    setModal(null);
  }

  function handleOpportunityResolutionClose() {
    const woundEvent = opportunityResolution?.woundEvent;
    setOpportunityResolution(null);
    if (woundEvent && Number(woundEvent.wounds) > 0) {
      setWoundNotice(woundEvent);
      setModal("wounds");
      return;
    }
    setModal(null);
  }

  async function handleInteractSuspect(edgeKey) {
    const payload = await applySnapshotRequest(`/api/battle/sessions/${snapshot.sid}/dungeon/suspects/interact`, {
      method: "POST",
      body: JSON.stringify({ edgeKey }),
    });
    if (!payload) return;
    showDrawReveal(payload, "draw");
    if (searchNeedsManualResult(payload.pendingSearch)) {
      setManualSearchSuccesses(0);
      setModal("search-manual");
    } else if (payload.pendingSearch?.hasFate) {
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
    } else if (mapMode !== MAP_MODES.GM_REPOSITION && mapMode !== MAP_MODES.GM_DUNGEON) {
      setSelectedUnitIds([]);
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
    const actorId = activeEntity?.is_player
      ? activeEntity.instance_id
      : selectedEntity?.is_player
        ? selectedEntity.instance_id
        : null;
    setActionMenuOpen(false);
    setUnitContextMenu(null);
    const payload = await selectEntityForAction(instanceId);
    if (!payload?.enemies?.some((entity) => entity.instance_id === instanceId)) {
      return;
    }
    setUnitContextMenu({ entityId: instanceId, actorId, x: clientX, y: clientY });
  }

  async function openAttackForEntity(instanceId, options = {}) {
    const payload = await selectEntityForAction(instanceId, options);
    if (!payload) {
      return;
    }
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    setMapMode((m) => (m === MAP_MODES.GM_DUNGEON ? m : MAP_MODES.IDLE));
    setAttackTarget(null);
    setAttackForm(EMPTY_ATTACK_FORM);
    setModal("attack");
  }

  function openAttackForGrapple(grappleId) {
    const grapple = (snapshot?.grapples || []).find((entry) => entry.id === grappleId);
    if (!grapple) {
      setNotice("Grapple no longer exists.");
      return;
    }
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    setMapMode((m) => (m === MAP_MODES.GM_DUNGEON ? m : MAP_MODES.IDLE));
    setAttackTarget({
      targetId: grapple.targetId,
      targetMode: "grapple",
      grappleId: grapple.id,
      label: `${grapple.label || "Grapple"} on ${grapple.targetName || "target"}`,
    });
    setAttackForm({ ...EMPTY_ATTACK_FORM, targetMode: "grapple", grappleId: grapple.id });
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

  async function inspectLootForEntity(instanceId) {
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    setMapMode((m) => (m === MAP_MODES.GM_DUNGEON ? m : MAP_MODES.IDLE));
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${instanceId}/loot/inspect`,
      {
        method: "POST",
      },
      "Loot inspected",
    );
  }

  async function inspectAllLoot() {
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/loot/inspect-all`,
      {
        method: "POST",
      },
      "Loot inspected",
    );
  }

  async function takeLootForEntity(instanceId, actorId) {
    if (!actorId) {
      setError("Select a player character to take loot.");
      return;
    }
    setUnitContextMenu(null);
    setActionMenuOpen(false);
    setMapMode((m) => (m === MAP_MODES.GM_DUNGEON ? m : MAP_MODES.IDLE));
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${instanceId}/loot/take`,
      {
        method: "POST",
        body: JSON.stringify({ playerId: actorId }),
      },
      "Loot taken",
    );
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
      setMapModeAfterMovement(payload);
      handleOpportunityPayload(payload);
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

  async function submitWalk(instanceId, x, y, options = {}) {
    const entity = orderedEnemies.find((candidate) => candidate.instance_id === instanceId) || selectedEntity;
    if (!entity || !snapshot?.sid || busy) {
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${entity.instance_id}/walk`,
      {
        method: "POST",
        body: JSON.stringify({ x, y }),
      },
      "",
    );
    if (payload) {
      const stopped = Boolean(payload.walk?.stoppedForEncounter || payload.dungeon?.pendingEncounterRoomIds?.length);
      setSelectedUnitIds([]);
      setMapMode(stopped || options.returnToIdle ? MAP_MODES.IDLE : MAP_MODES.WALK);
      setNotice(stopped ? "Walk stopped: encounter discovered" : "Walk");
    }
  }

  async function submitPartyWalk(x, y, options = {}) {
    const leaderId = options.leaderId || selectedEntity?.instance_id;
    const leader = orderedEnemies.find((entity) => entity.instance_id === leaderId) || selectedEntity;
    if (!leader || !snapshot?.sid || busy) {
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/party-walk`,
      {
        method: "POST",
        body: JSON.stringify({ leaderId: leader.instance_id, x, y }),
      },
      "",
    );
    if (payload) {
      const stopped = Boolean(payload.partyWalk?.stoppedForEncounter || payload.dungeon?.pendingEncounterRoomIds?.length);
      setSelectedUnitIds([]);
      setMapMode(stopped ? MAP_MODES.IDLE : MAP_MODES.PARTY_WALK);
      setNotice(stopped ? "Party walk stopped: encounter discovered" : "Party walk");
    }
  }

  async function handleMoveSelectedToCell(x, y, target = {}) {
    if (mapMode === MAP_MODES.REPOSITION || mapMode === MAP_MODES.GM_REPOSITION || target.mode === "reposition") {
      await submitReposition(x, y);
      return;
    }
    if (mapMode === MAP_MODES.WALK || target.mode === "walk") {
      await submitWalk(target.instanceId || selectedEntity?.instance_id, x, y, {
        returnToIdle: target.input === "drag",
      });
      return;
    }
    if (mapMode === MAP_MODES.PARTY_WALK || target.mode === "party-walk") {
      await submitPartyWalk(x, y, { leaderId: target.instanceId });
      return;
    }
    if (mapMode !== MAP_MODES.MOVE && target.mode !== "move") {
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

  function updateBuilderClass(classId) {
    const classEntry = findCatalogClass(characterCatalog, classId);
    const energyTypes = defaultEnergyTypesForClass(characterCatalog, classEntry);
    setCharacterBuilderForm((current) => ({
      ...createCharacterBuilderForm(characterCatalog, classId),
      name: current.name,
      ancestryId: current.ancestryId || characterCatalog?.ancestries?.[0]?.id || "",
      energyTypes,
      deckUpgrades: emptyDeckUpgrades(energyTypes),
      stats: defaultStatsForClass(characterCatalog, classEntry),
      art: defaultCharacterArt(
        characterCatalog,
        classId,
        current.ancestryId || characterCatalog?.ancestries?.[0]?.id || "",
        current.art,
      ),
    }));
  }

  function updateBuilderAncestry(ancestryId) {
    setCharacterBuilderForm((current) => ({
      ...current,
      ancestryId,
      art: defaultCharacterArt(characterCatalog, current.classId, ancestryId, current.art),
    }));
  }

  function toggleBuilderEnergy(energyType) {
    setCharacterBuilderForm((current) => {
      const classEntry = findCatalogClass(characterCatalog, current.classId);
      if (classEntry?.requiredEnergyTypes?.includes(energyType)) {
        return current;
      }
      const selected = current.energyTypes.includes(energyType)
        ? current.energyTypes.filter((item) => item !== energyType)
        : current.energyTypes.length < 3
          ? [...current.energyTypes, energyType]
          : current.energyTypes;
      const mainArt = selected.includes(current.mainArt)
        ? current.mainArt
        : classEntry?.mainArtOptions?.find((item) => selected.includes(item)) || selected[0] || "";
      const deckUpgrades = normalizeBuilderUpgrades(current.deckUpgrades, selected);
      return { ...current, energyTypes: selected, mainArt, deckUpgrades };
    });
  }

  function updateBuilderUpgrade(energyType, cardKey, value) {
    setCharacterBuilderForm((current) => ({
      ...current,
      deckUpgrades: {
        ...current.deckUpgrades,
        [energyType]: {
          ...(current.deckUpgrades?.[energyType] || {}),
          [cardKey]: Math.max(0, Number(value || 0)),
        },
      },
    }));
  }

  async function refreshSavedCharacters() {
    try {
      const payload = await requestJson("/api/battle/characters");
      setSavedCharacters(payload.characters || []);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function handleSaveBuilderCharacter(event) {
    event.preventDefault();
    if (!builderCanSave) {
      setError(builderErrors[0] || "Character builder is incomplete.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson("/api/battle/characters", {
        method: "POST",
        body: JSON.stringify({
          name: characterBuilderForm.name,
          classId: characterBuilderForm.classId,
          ancestryId: characterBuilderForm.ancestryId,
          energyTypes: characterBuilderForm.energyTypes,
          mainArt: characterBuilderForm.mainArt,
          gmOverride: characterBuilderForm.gmOverride,
          deckUpgrades: characterBuilderForm.deckUpgrades,
          classImprovementTarget: characterBuilderForm.classImprovementTarget,
          gearPresetId: characterBuilderForm.gearPresetId,
          stats: characterBuilderForm.stats,
          art: characterBuilderForm.art,
        }),
      });
      setSavedCharacters((current) => [payload.character, ...current.filter((item) => item.id !== payload.character.id)]);
      setNotice("Character saved");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSpawnSavedCharacter(characterId, physicalCards = false) {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/players/from-character`,
      {
        method: "POST",
        body: JSON.stringify({ characterId, physicalCards }),
      },
      "Player added",
    );
    if (payload) {
      closeModal();
    }
  }

  async function handleCharacterArtUpload(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const payload = await requestJson("/api/battle/character-builder/art/upload", {
        method: "POST",
        body: formData,
      });
      if (payload?.art) {
        setCharacterBuilderForm((current) => ({ ...current, art: payload.art }));
        setNotice("Character art uploaded");
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      event.target.value = "";
      setBusy(false);
    }
  }

  async function handleDeleteSavedCharacter(characterId) {
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(`/api/battle/characters/${encodeURIComponent(characterId)}`, { method: "DELETE" });
      setSavedCharacters(payload.characters || []);
      setNotice("Character deleted");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
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

  async function handlePrepare() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/prepare`,
      { method: "POST" },
      "Prepared",
    );
  }

  function cancelActionTargeting() {
    setActionTargeting(null);
    setStrengthenTargetId("");
  }

  function beginStrengthenTargeting() {
    if (!selectedEntity) {
      return;
    }
    setActionMenuOpen(false);
    setUnitContextMenu(null);
    setMapMode((current) => (current === MAP_MODES.GM_DUNGEON ? current : MAP_MODES.IDLE));
    setStrengthenTargetId("");
    setActionTargeting({
      action: "strengthen",
      actorId: selectedEntity.instance_id,
      label: "Strengthen",
      targetKind: "player",
    });
    setNotice(`Choose a Strengthen target (${strengthenRangeCells * 5}ft).`);
  }

  function handleActionTarget(target) {
    if (!mapActionTargeting) {
      if (target?.type === "grapple" && target.grappleId) {
        openAttackForGrapple(target.grappleId);
      }
      return;
    }
    if (mapActionTargeting.action === "strengthen") {
      if (target?.type !== "unit" || !strengthenTargetIds.includes(target.instanceId)) {
        setNotice("Invalid Strengthen target.");
        return;
      }
      setStrengthenTargetId(target.instanceId);
      setStrengthenCount(1);
      setActionTargeting(null);
      setModal("strengthen");
    }
  }

  async function handleStrengthen(explicitX) {
    const x = explicitX !== undefined ? explicitX : Number(strengthenCount);
    const targetId = strengthenTargetId || selectedEntity?.instance_id || "";
    closeModal();
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/strengthen`,
      { method: "POST", body: JSON.stringify({ x, targetId }) },
      `Strengthened +${x}`,
    );
  }

  async function handleGuard(explicitX) {
    const x = explicitX !== undefined ? explicitX : Number(guardCount);
    closeModal();
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/guard`,
      { method: "POST", body: JSON.stringify({ x }) },
      `Guard +${x}`,
    );
  }

  async function handleHitdraw() {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/action/hitdraw`,
      { method: "POST" },
      "Hitdraw",
    );
    if (payload) {
      showHitDrawReveal(payload);
    }
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
    if (isPlayerSelected && canUseTurnAction && playerActionsUsed >= 2 && !actionWarningAcknowledged) {
      setPendingActionFn(() => fn);
      setModal("action-warning");
    } else {
      fn();
    }
  }

  function withActionCheckForActor(actorId, fn) {
    const actor = orderedEnemies.find((entity) => entity.instance_id === actorId);
    const actorActionsUsed =
      (actor?.actions_used ?? 0) +
      (snapshot?.movementState?.entityId === actorId && snapshot?.movementState?.dashUsed ? 1 : 0);
    const actorCanUseTurnAction = Boolean(
      actor?.is_player &&
        combatIsRunning &&
        snapshot?.activeTurnId === actorId &&
        !actor?.is_down,
    );
    if (actorCanUseTurnAction && actorActionsUsed >= 2 && !actionWarningAcknowledged) {
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
    if (canEndCombat) {
      await handleEndCombat();
      return;
    }

    if (!snapshot?.encounterStarted && !hasActiveTurn && !pendingNewRound && hasStartableUnit && !initiativeRolledForTarget) {
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

    if (snapshot?.encounterStarted && hasStartableUnit) {
      const path = pendingEncounterRoomIds.length && !hasLiveOrderedEnemy
        ? `/api/battle/sessions/${snapshot.sid}/round/start`
        : `/api/battle/sessions/${snapshot.sid}/encounter/start`;
      await applySnapshotRequest(
        path,
        { method: "POST" },
        pendingEncounterRoomIds.length && !hasLiveOrderedEnemy ? "Started new round" : "Advanced round order",
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

  async function handleEndCombat() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/encounter/end`,
      { method: "POST" },
      "Combat ended",
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

  async function handleInspectSelectedLoot() {
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/loot`,
      {
        method: "POST",
      },
      "Loot inspected",
    );
  }

  async function handleAttackSubmit(event) {
    event.preventDefault();
    const modifiers = Object.entries(attackForm.modifiers)
      .filter(([, enabled]) => enabled)
      .map(([key]) => {
        if (key === "pierce") {
          return `pierce:${Math.max(0, Number(attackForm.pierceAmount || 0))}`;
        }
        if (key === "sunder") {
          return `sunder:${Math.max(0, Number(attackForm.sunderAmount || 0))}`;
        }
        return key;
      })
      .filter((key) => !["pierce:0", "sunder:0"].includes(key));
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/attack`,
      {
        method: "POST",
        body: JSON.stringify({
          damage: Number(attackForm.damage),
          modifiers,
          targetId: attackTarget?.targetId || undefined,
          targetMode: attackForm.targetMode || "creature",
          grappleId: attackForm.targetMode === "grapple" ? attackForm.grappleId || attackTarget?.grappleId || null : null,
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
      setAttackTarget(null);
      const woundEvent = combinedWoundEvent(payload.woundEvents, payload.enemies);
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
    const woundEvent = combinedWoundEvent(payload.woundEvents, payload.enemies);
    if (woundEvent && Number(woundEvent.wounds) > 0) {
      setWoundNotice(woundEvent);
      setModal("wounds");
    }
  }

  async function handleOpportunityResolve(action, extra = {}) {
    const body = { action, ...extra };
    if (action === "attack" && pendingOpportunity?.attackerPhysicalCards && pendingOpportunity?.successCount == null) {
      body.manualSuccesses = Math.max(0, Number(opportunityManual.successes || 0));
      body.manualFate = Math.max(0, Number(opportunityManual.fate || 0));
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/opportunity/resolve`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      action === "skip" ? "Opportunity attack skipped" : "Opportunity attack resolved",
    );
    handleOpportunityPayload(payload);
  }

  function handleOpportunityWillpower(useWillpower) {
    handleOpportunityResolve("attack", { useWillpower });
  }

  async function handleHealSubmit(event) {
    event.preventDefault();
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/heal`,
      {
        method: "POST",
        body: JSON.stringify({
          toughness: Number(healForm.toughness),
          temporaryToughness: Number(healForm.temporaryToughness),
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

  async function handleAdjustPhysicalWounds(delta) {
    if (!selectedEntity) return;
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${selectedEntity.instance_id}/wounds/adjust`,
      {
        method: "POST",
        body: JSON.stringify({ delta }),
      },
      delta > 0 ? "Wound added" : "Wound removed",
    );
  }

  async function handleSetPlayerCardMode(physicalCards, { deckReset = false } = {}) {
    if (!selectedEntity) return;
    if (!physicalCards && selectedUsesPhysicalCards && Number(selectedWoundCounts.total) > 0 && !deckReset) {
      setModal("digital-card-reset-confirm");
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/entities/${selectedEntity.instance_id}/player-card-mode`,
      {
        method: "POST",
        body: JSON.stringify({ physicalCards, deckReset }),
      },
      physicalCards ? "Physical cards enabled" : deckReset ? "Digital cards enabled with deck reset" : "Digital cards enabled",
    );
    if (payload && modal === "digital-card-reset-confirm") {
      closeModal();
    }
  }

  async function handleSaveClick() {
    if (!activeSave?.filename) {
      await openSaveAsModal();
      return;
    }
    await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/saves/${encodeURIComponent(activeSave.filename)}`,
      {
        method: "PUT",
      },
      "Session saved",
    );
  }

  async function handleSaveSubmit(event) {
    event.preventDefault();
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/saves`,
      {
        method: "POST",
        body: JSON.stringify({ name: saveName }),
      },
      "Session save created",
    );
    if (payload) {
      closeModal();
      const action = pendingGuardAction;
      setPendingGuardAction(null);
      if (action) await action();
    }
  }

  async function handleOverwriteSave(filename) {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/saves/${encodeURIComponent(filename)}`,
      {
        method: "PUT",
      },
      "Session save updated",
    );
    if (payload) {
      closeModal();
    }
  }

  async function doLoadSession(filename) {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/load`,
      {
        method: "POST",
        body: JSON.stringify({ filename }),
      },
      "Session save loaded",
    );
    if (payload) {
      closeModal();
    }
  }

  function handleLoadSubmit(filename) {
    closeModal();
    runWithUnsavedGuard(() => doLoadSession(filename));
  }

  async function fetchMapTemplates() {
    try {
      const data = await requestJson("/api/map-templates");
      setMapTemplates(data.templates || []);
    } catch {
      // non-fatal
    }
  }

  async function openSaveMapTemplateModal() {
    await fetchMapTemplates();
    setMapTemplateName(snapshot?.activeMapTemplate?.name || "map template");
    setModal("save-map-template");
  }

  async function openLoadMapTemplateModal() {
    await fetchMapTemplates();
    setModal("load-map-template");
  }

  async function handleSaveMapClick() {
    const templateId = snapshot?.activeMapTemplate?.id;
    if (!templateId || snapshot?.activeMapTemplate?.missing) {
      await openSaveMapTemplateModal();
      return;
    }
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/dungeon/save-template/${encodeURIComponent(templateId)}`,
      { method: "POST" },
      "Map template saved",
    );
    if (payload) {
      await fetchMapTemplates();
    }
  }

  async function handleSaveMapTemplateSubmit(event) {
    event.preventDefault();
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/dungeon/save-as-template`,
      { method: "POST", body: JSON.stringify({ name: mapTemplateName }) },
      "Map template saved",
    );
    if (payload) {
      await fetchMapTemplates();
      closeModal();
    }
  }

  async function handleOverwriteMapTemplate(templateId) {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/dungeon/save-template/${encodeURIComponent(templateId)}`,
      { method: "POST" },
      "Map template updated",
    );
    if (payload) {
      await fetchMapTemplates();
      closeModal();
    }
  }

  async function handleLoadMapTemplate(templateId) {
    const payload = await applySnapshotRequest(
      `/api/battle/sessions/${snapshot.sid}/dungeon/load-template/${encodeURIComponent(templateId)}`,
      { method: "POST" },
      "Map template loaded",
    );
    if (payload) {
      await fetchMapTemplates();
      closeModal();
    }
  }

  async function handleDeleteMapTemplate(templateId) {
    setBusy(true);
    setError("");
    try {
      const data = await requestJson(`/api/map-templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
      setMapTemplates(data.templates || []);
      if (snapshot?.activeMapTemplate?.id === templateId) {
        setSnapshot((current) => current ? {
          ...current,
          activeMapTemplate: {
            ...current.activeMapTemplate,
            missing: true,
          },
        } : current);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
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
      if (Object.prototype.hasOwnProperty.call(payload, "activeSave")) {
        setSnapshot((current) => (current ? { ...current, activeSave: payload.activeSave } : current));
      }
      setNotice("Session save deleted");
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

  const mapLightScale = MAP_LIGHT_FILTER_BASE * (mapLight / MAP_LIGHT_DEFAULT);
  const mapLightAboveBaseRatio = (mapLight - MAP_LIGHT_DEFAULT) / (MAP_LIGHT_MAX - MAP_LIGHT_DEFAULT);
  const mapLightBelowBaseRatio = (mapLight - MAP_LIGHT_MIN) / (MAP_LIGHT_DEFAULT - MAP_LIGHT_MIN);
  const mapLightLift = mapLight >= MAP_LIGHT_DEFAULT
    ? MAP_LIGHT_BASE_LIFT + mapLightAboveBaseRatio * (MAP_LIGHT_MAX_LIFT - MAP_LIGHT_BASE_LIFT)
    : mapLightBelowBaseRatio * MAP_LIGHT_BASE_LIFT;
  const mapLightStyle = {
    "--display-brightness": mapLightScale.toFixed(2),
    "--display-brightness-lift": mapLightLift.toFixed(3),
  };
  const visibleWoundNotice = woundEventWithCurrentToughness(woundNotice, snapshot?.enemies);

  return (
    <div className="shell" style={mapLightStyle}>
      <div className="shell-noise" />

      <header className="topbar">
        <div className="brand-block">
          <div className="brand-kicker">Weavers of Power</div>
          <div className="brand-title">Weave Forge</div>
        </div>

        <div className="round-cluster">
          {activeView === APP_VIEWS.SIM ? (
            <>
              <span className="pill pill-turn">Combat Sim</span>
              <span className="pill pill-muted">No positioning</span>
              <span className="pill pill-muted">Initiative once</span>
            </>
          ) : activeView === APP_VIEWS.SCENARIO ? (
            <>
              <span className="pill pill-turn">Scenario</span>
              <span className="pill pill-muted">
                {snapshot?.scenarioRun?.active || snapshot?.scenario?.scenarioRun?.active
                  ? `Run: ${snapshot?.scenarioRun?.sourceTemplateMissing || snapshot?.scenario?.scenarioRun?.sourceTemplateMissing
                    ? "Source template deleted"
                    : snapshot?.scenarioRun?.sourceScenarioName || snapshot?.scenario?.scenarioRun?.sourceScenarioName || snapshot?.scenario?.definition?.name || "Scenario"}`
                  : "No run"}
              </span>
              <span className="pill pill-muted">sid {snapshot.sid}</span>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="menu-actions">
          <div className="view-switch" role="group" aria-label="App view">
            <button
              className={`menu-button ${activeView === APP_VIEWS.SCENARIO ? "menu-button-active" : ""}`.trim()}
              type="button"
              onClick={() => {
                setActiveView(APP_VIEWS.SCENARIO);
                setModal(null);
                setUnitContextMenu(null);
              }}
              disabled={busy}
            >
              Scenario
            </button>
            <button
              className={`menu-button ${activeView === APP_VIEWS.BATTLE ? "menu-button-active" : ""}`.trim()}
              type="button"
              onClick={() => {
                setActiveView(APP_VIEWS.BATTLE);
                setModal(null);
              }}
              disabled={busy}
            >
              Map
            </button>
            <button
              className={`menu-button ${activeView === APP_VIEWS.SIM ? "menu-button-active" : ""}`.trim()}
              type="button"
              onClick={() => {
                setActiveView(APP_VIEWS.SIM);
                setModal(null);
                setUnitContextMenu(null);
              }}
              disabled={busy}
            >
              Combat Sim
            </button>
          </div>
          <label className="brightness-control">
            <span>Map light</span>
            <input
              aria-label="Map light"
              type="range"
              min={MAP_LIGHT_MIN}
              max={MAP_LIGHT_MAX}
              step={MAP_LIGHT_STEP}
              value={mapLight}
              onChange={(event) => setMapLight(clampMapLight(event.target.value))}
            />
            <output>{mapLight}%</output>
          </label>
          {activeView === APP_VIEWS.BATTLE ? (
            <>
              <button className="menu-button" onClick={requestNewSession} disabled={busy}>
                New
              </button>
              <button className="menu-button" onClick={handleUndo} disabled={busy || !snapshot.canUndo}>
                Undo
              </button>
              <button className="menu-button" onClick={handleRedo} disabled={busy || !snapshot.canRedo}>
                Redo
              </button>
              {isGmDungeonMode ? (
                <>
                  <button
                    className="menu-button"
                    type="button"
                    onClick={handleSaveMapClick}
                    disabled={busy || !snapshot.dungeon}
                    title={
                      snapshot?.activeMapTemplate && !snapshot.activeMapTemplate.missing
                        ? `Overwrite ${snapshot.activeMapTemplate.name}`
                        : "Create a new saved map"
                    }
                  >
                    Save Map
                  </button>
                  <button
                    className="menu-button"
                    type="button"
                    onClick={openSaveMapTemplateModal}
                    disabled={busy || !snapshot.dungeon}
                    title="Create a new saved map or overwrite an existing one"
                  >
                    Save As
                  </button>
                  <button
                    className="menu-button"
                    type="button"
                    onClick={openLoadMapTemplateModal}
                    disabled={busy}
                    title="Load a saved map"
                  >
                    Load Map
                  </button>
                  <button
                    className="menu-button start-play-button"
                    onClick={handleStartPlay}
                    disabled={busy}
                    title="Begin a fresh play session from this map (resets fog, doors and unit positions)"
                  >
                    Start
                  </button>
                </>
              ) : (
                <>
                  <button className="menu-button" onClick={handleSaveClick} disabled={busy}>
                    Save Session
                  </button>
                  <button className="menu-button" onClick={openSaveAsModal} disabled={busy}>
                    Save As
                  </button>
                  <button className="menu-button" onClick={openLoadModal} disabled={busy}>
                    Load Session
                  </button>
                </>
              )}
              <button
                className={`menu-button gm-reposition-button ${isGmRepositionMode ? "gm-reposition-active" : ""}`.trim()}
                type="button"
                title="Click a unit, then click an empty map cell to reposition it."
                onClick={toggleGmRepositionMode}
                disabled={busy || !canUseGmReposition}
              >
                {isGmRepositionMode ? "Exit GM Mode" : "GM Mode"}
              </button>
              <button
                className={`menu-button gm-dungeon-button ${isGmDungeonMode ? "gm-dungeon-active" : ""}`.trim()}
                type="button"
                title="Edit dungeon terrain, walls, and doors."
                onClick={toggleGmDungeonMode}
                disabled={busy}
              >
                {isGmDungeonMode ? "Exit Map Edit" : "Map Edit"}
              </button>
            </>
          ) : null}
        </div>
      </header>

      {activeView === APP_VIEWS.SIM ? (
        <CombatSimView meta={meta} onMetaUpdate={setMeta} />
      ) : activeView === APP_VIEWS.SCENARIO ? (
        <ScenarioView
          snapshot={snapshot}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          setNotice={setNotice}
          setSnapshot={setSnapshot}
          meta={meta}
          runWithUnsavedGuard={runWithUnsavedGuard}
          openPcPicker={openPcPicker}
          onOpenCombat={() => {
            setActiveView(APP_VIEWS.BATTLE);
            setModal(null);
            setUnitContextMenu(null);
          }}
        />
      ) : (
      <main className="main-grid">
        <section className="stage-column">
          {isPlayerSelected && !selectedUsesPhysicalCards && selectedIsActive && selectedPowerDrawUsed && selectedEntity.power_draw_cards?.length > 0 ? (
            <PowerEnergyBar
              entity={selectedEntity}
              summary={selectedEntity.current_draw_groups?.[0]?.summary ?? selectedEntity.current_draw_summary ?? null}
              onOpenDetail={() => {
                const items =
                  Array.isArray(selectedEntity.current_draw_text) && selectedEntity.current_draw_text.length > 0
                    ? selectedEntity.current_draw_text
                    : selectedDrawGroups.flatMap((group) => group.items);

                setDrawDetail({
                  entityName: selectedEntity.name,
                  items,
                  groups: selectedDrawGroups,
                  kind: "draw of power",
                });
                setModal("draw-detail");
              }}
            />
          ) : null}

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
              grapples={snapshot.grapples || []}
              actionTargeting={mapActionTargeting}
              highlightedRoomId={isGmDungeonMode ? highlightedRoomId : null}
              drawPulse={drawReveal ? { entityId: drawReveal.entityId, key: drawReveal.key } : null}
              busy={busy}
              canUseMove={canUseMove}
              canUseMapWalk={canUseMapWalk}
              canUseWalk={canUseWalk}
              canUsePartyWalk={canUsePartyWalk}
              onSelect={handleSelect}
              onSelectionChange={handleMapSelectionChange}
              onGroupMove={submitGroupPositions}
              onMoveToCell={handleMoveSelectedToCell}
              onTileEdit={submitTileEdit}
              onWallEdit={submitWallEdit}
              onSetPlayerSpawn={submitSetPlayerSpawn}
              onSecretDoorClick={(key) => {
                setGmSelectedSecretDoorKey((prev) => (prev === key ? null : key));
                setGmSecretDcInput(String(dungeon?.walls?.[key]?.secret_dc ?? 2));
              }}
              onActionTarget={handleActionTarget}
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
                    {gmDungeonDrawSubmode === GM_DUNGEON_DRAW_SUBMODES.SPAWN ? (
                      <>
                        <span className="subtle-copy dungeon-spawn-hint">
                          Click a cell to set the player spawn area. Click it again to clear.
                        </span>
                        <div className="dungeon-toolbar-sep" />
                      </>
                    ) : gmDungeonDrawSubmode === GM_DUNGEON_DRAW_SUBMODES.TERRAIN ? (
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
                {!selectedUsesPhysicalCards && combatIsRunning ? (
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
                ) : null}
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
                {isPlayerSelected && canUseTurnAction && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setActionMenuOpen(false);
                      withActionCheck(handlePrepare);
                    }}
                    disabled={busy}
                    title={`Current turn draw bonus: ${selectedEntity?.draw_bonus_pending ?? 0}/3; next turn: ${selectedEntity?.draw_bonus_next_turn ?? 0}/3`}
                  >
                    Prepare
                    {selectedEntity?.draw_bonus_next_turn > 0
                      ? ` (+${selectedEntity.draw_bonus_next_turn} next)`
                      : selectedEntity?.draw_bonus_pending > 0
                        ? ` (ready +${selectedEntity.draw_bonus_pending})`
                        : ""}
                  </button>
                )}
                {isPlayerSelected && canUseTurnAction && (
                  <button
                    className={`secondary-button ${mapActionTargeting?.action === "strengthen" ? "move-button-active" : ""}`.trim()}
                    onClick={() => {
                      setActionMenuOpen(false);
                      if (mapActionTargeting?.action === "strengthen") {
                        cancelActionTargeting();
                      } else {
                        withActionCheck(beginStrengthenTargeting);
                      }
                    }}
                    disabled={busy}
                  >
                    {mapActionTargeting?.action === "strengthen" ? "Cancel Strengthen" : "Strengthen"}
                  </button>
                )}
                {isPlayerSelected && canUseTurnAction && (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setActionMenuOpen(false);
                      withActionCheck(() => { setGuardCount(1); setModal("guard"); });
                    }}
                    disabled={busy}
                  >
                    Guard
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
                {canManualEndCombat && !canEndCombat ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      setActionMenuOpen(false);
                      handleEndCombat();
                    }}
                    disabled={busy}
                  >
                    End Combat
                  </button>
                ) : null}
                {combatIsRunning ? (
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
                ) : null}
                {!combatIsRunning ? (
                  <button
                    className={`secondary-button ${isWalkMode ? "move-button-active" : ""}`.trim()}
                    onClick={() => {
                      setActionMenuOpen(false);
                      setMapMode((current) => (current === MAP_MODES.WALK ? MAP_MODES.IDLE : MAP_MODES.WALK));
                    }}
                    disabled={!canUseWalk || busy}
                  >
                    {isWalkMode ? "Cancel Walk" : "Walk"}
                  </button>
                ) : null}
                {showPartyWalkButton ? (
                  <button
                    className={`secondary-button ${isPartyWalkMode ? "move-button-active" : ""}`.trim()}
                    onClick={() => {
                      setActionMenuOpen(false);
                      setMapMode((current) => (current === MAP_MODES.PARTY_WALK ? MAP_MODES.IDLE : MAP_MODES.PARTY_WALK));
                    }}
                    disabled={!canUsePartyWalk || busy}
                  >
                    {isPartyWalkMode ? "Cancel Party Walk" : "Party Walk"}
                  </button>
                ) : null}
                {canInspectAllLoot ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={inspectAllLoot}
                    disabled={busy}
                  >
                    Inspect all loot
                  </button>
                ) : null}
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
                    onClick={() => { setActionMenuOpen(false); handleStartSearch(); }}
                    disabled={busy}
                  >
                    Search Room
                  </button>
                )}
                {!canSearch && roomAlreadySearched && isPlayerSelected && canUseTurnAction && dungeon && (
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
                    {!selectedUsesPhysicalCards && combatIsRunning ? (
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
                    ) : null}
                    {combatIsRunning ? (
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
                    ) : null}
                    {combatIsRunning ? (
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
                    ) : null}
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
                    {canInspectSelectedLoot ? (
                      <button
                        className="secondary-button action-more-item"
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setActionMenuOpen(false);
                          handleInspectSelectedLoot();
                        }}
                        disabled={busy}
                      >
                        Inspect loot
                      </button>
                    ) : null}
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
                      {selectedUsesPhysicalCards ? <span className="badge badge-status">Physical cards</span> : null}
                      {selectedEntity.is_down ? <span className="badge badge-down">{selectedIsKo ? "KO" : "Down"}</span> : null}
                      {selectedHasInventory ? (
                        <span className="loot-inventory-anchor">
                          <button
                            className="loot-inventory-button"
                            type="button"
                            aria-label="Loot inventory"
                            onClick={() => setLootPopoverOpen((open) => !open)}
                            title="Loot inventory"
                          >
                            $
                          </button>
                          <div className={`loot-popover ${lootPopoverOpen ? "loot-popover-open" : ""}`.trim()} role="tooltip">
                            <LootSummary loot={selectedInventory} />
                          </div>
                        </span>
                      ) : null}
                    </div>
                    <div className="selected-meta-row">
                      {!selectedEntity.is_player && selectedEntity.status_text && selectedEntity.status_text !== "-" ? (
                        <span className="selected-meta">{selectedEntity.status_text}</span>
                      ) : null}
                      {activeDetachedEntity ? <span className="selected-meta">{`Turn: ${activeDetachedEntity.name}`}</span> : null}
                    </div>
                    {selectedGrappledBy.length || selectedGrappling.length ? (
                      <div className="selected-meta-row">
                        {selectedGrappledBy.map((grapple) => (
                          <span className="badge badge-status" key={grapple.id}>
                            {`Grappled T ${grapple.toughnessCurrent}/${grapple.toughnessMax}`}
                          </span>
                        ))}
                        {selectedGrappling.map((grapple) => (
                          <span className="badge badge-status" key={grapple.id}>
                            {`Grappling ${grapple.targetName || "target"} T ${grapple.toughnessCurrent}/${grapple.toughnessMax}`}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {isPlayerSelected && !selectedUsesPhysicalCards && selectedPowerDrawUsed && selectedEntity.power_draw_cards?.length > 0 ? (
                    <DopHandPanel
                      cards={selectedEntity.power_draw_cards}
                      summary={selectedEntity.current_draw_groups?.[0]?.summary ?? null}
                    />
                  ) : null}

                  {!selectedEntity.is_player ? <CreatureInfoPanel info={selectedEntity.template_info} /> : null}

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
                      <span>Draw</span>
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
                      {selectedUsesPhysicalCards ? (
                        <>
                          <div className="wound-count-grid wound-count-grid-physical">
                            <LootBlock label="Total" value={String(selectedWoundCounts.total || 0)} />
                          </div>
                          <div className="wound-action-row">
                            <button
                              className="secondary-button wound-adjust-button"
                              type="button"
                              aria-label="Remove physical wound"
                              onClick={() => handleAdjustPhysicalWounds(-1)}
                              disabled={!canAdjustPhysicalWounds || Number(selectedWoundCounts.total) <= 0 || busy}
                            >
                              -
                            </button>
                            <button
                              className="secondary-button wound-adjust-button"
                              type="button"
                              aria-label="Add physical wound"
                              onClick={() => handleAdjustPhysicalWounds(1)}
                              disabled={!canAdjustPhysicalWounds || busy}
                            >
                              +
                            </button>
                            <button
                              className="secondary-button wound-action-button"
                              type="button"
                              onClick={() => handleSetPlayerCardMode(false)}
                              disabled={busy}
                            >
                              Digital cards
                            </button>
                          </div>
                          {Number(selectedWoundCounts.total) > 0 ? (
                            <div className="subtle-copy wound-mode-note">
                              Switching to digital cards will reset the digital deck and shuffle these wounds into it.
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <>
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
                            <button
                              className="secondary-button wound-action-button"
                              type="button"
                              onClick={() => handleSetPlayerCardMode(true)}
                              disabled={busy}
                            >
                              Physical cards
                            </button>
                          </div>
                        </>
                      )}
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
                      {selectedEntity.loot_taken_by ? (
                        <div className="subtle-copy">{`Loot taken${selectedEntity.loot_taken_by_name ? ` by ${selectedEntity.loot_taken_by_name}` : ""}`}</div>
                      ) : (
                        <LootSummary loot={selectedEntity.rolled_loot} />
                      )}
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
      )}

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
            <>
              {canContextInspectLoot ? (
                <button
                  className="secondary-button unit-context-item"
                  type="button"
                  role="menuitem"
                  onClick={() => inspectLootForEntity(contextMenuEntity.instance_id)}
                  disabled={busy}
                >
                  Inspect loot
                </button>
              ) : null}
              {canContextTakeLoot ? (
                <button
                  className="secondary-button unit-context-item"
                  type="button"
                  role="menuitem"
                  onClick={() => withActionCheckForActor(
                    unitContextMenu.actorId,
                    () => takeLootForEntity(contextMenuEntity.instance_id, unitContextMenu.actorId),
                  )}
                  disabled={busy}
                >
                  Take loot
                </button>
              ) : null}
            </>
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
        title={`Attack ${attackTargetLabel}`}
        subtitle={
          attackTarget
            ? "Applies damage and optional status effects to the chosen map target."
            : `Applies damage and optional status effects to the selected ${selectedTargetNoun} card.`
        }
        onClose={closeModal}
        closeOnOutsideClick={false}
      >
        <form className="modal-form" onSubmit={handleAttackSubmit}>
          {selectedGrappledBy.length ? (
            <div className="form-section">
              <div className="form-section-title">Target</div>
              <div className="segmented-control">
                <button
                  type="button"
                  className={attackForm.targetMode !== "grapple" ? "active" : ""}
                  onClick={() => setAttackForm((current) => ({ ...current, targetMode: "creature", grappleId: "" }))}
                >
                  Creature
                </button>
                <button
                  type="button"
                  className={attackForm.targetMode === "grapple" ? "active" : ""}
                  onClick={() =>
                    setAttackForm((current) => ({
                      ...current,
                      targetMode: "grapple",
                      grappleId: current.grappleId || selectedGrappledBy[0]?.id || "",
                    }))
                  }
                >
                  Target Grapple
                </button>
              </div>
              {attackForm.targetMode === "grapple" && selectedGrappledBy.length > 1 ? (
                <label className="field">
                  <span>Grapple</span>
                  <select
                    value={attackForm.grappleId || selectedGrappledBy[0]?.id || ""}
                    onChange={(event) => setAttackForm((current) => ({ ...current, grappleId: event.target.value }))}
                  >
                    {selectedGrappledBy.map((grapple) => (
                      <option key={grapple.id} value={grapple.id}>
                        {`${grapple.grapplerName || "Grappler"} T ${grapple.toughnessCurrent}/${grapple.toughnessMax}`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
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
            {attackForm.modifiers.pierce ? (
              <label className="field attack-pierce-field">
                <span>Pierce amount</span>
                <input
                  type="number"
                  min="1"
                  value={attackForm.pierceAmount}
                  onChange={(event) =>
                    setAttackForm((current) => ({ ...current, pierceAmount: event.target.value }))
                  }
                />
              </label>
            ) : null}
            {attackForm.modifiers.sunder ? (
              <label className="field attack-pierce-field">
                <span>Sunder amount</span>
                <input
                  type="number"
                  min="1"
                  value={attackForm.sunderAmount}
                  onChange={(event) =>
                    setAttackForm((current) => ({ ...current, sunderAmount: event.target.value }))
                  }
                />
              </label>
            ) : null}
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
            {isPlayerSelected ? (
              <label className="field">
                <span>Temp toughness</span>
                <input
                  type="number"
                  min="0"
                  value={healForm.temporaryToughness}
                  onChange={(event) => setHealForm((current) => ({ ...current, temporaryToughness: event.target.value }))}
                />
              </label>
            ) : null}
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
        open={modal === "opportunity-resolved" && Boolean(opportunityResolution)}
        title={opportunityResolutionTitle(opportunityResolution)}
        subtitle={opportunityResolutionSubtitle(opportunityResolution)}
        onClose={handleOpportunityResolutionClose}
        closeOnOutsideClick={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">
            {opportunityResolution?.events?.length === 1
              ? "An enemy resolved an opportunity attack."
              : `${opportunityResolution?.events?.length || 0} enemies resolved opportunity attacks.`}
          </div>
          <div className="draw-groups">
            {(opportunityResolution?.events || []).map((event, index) => (
              <div className="draw-group" key={`${event.attackerId || "enemy"}-${index}`}>
                <div className="draw-group-header">
                  <div className="draw-group-label">
                    {event.attackerName} {"->"} {event.targetName}
                  </div>
                </div>
                <div className="card-list">
                  <div className="draw-card">
                    {event.cardText || "No card drawn"}
                    {event.reshuffled ? " (reshuffled first)" : ""}
                  </div>
                  <div className="draw-card">
                    {opportunityEventDamageLine(event)}
                  </div>
                  {event.special || event.stopped ? (
                    <div className="draw-card">
                      {event.special ? "Special: movement stopped." : "Movement stopped."}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={handleOpportunityResolutionClose}>
              OK
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "wounds" && Boolean(visibleWoundNotice)}
        title="Player Wounds"
        onClose={closeModal}
        closeOnOutsideClick={false}
        className="modal-shell-wound"
      >
        {visibleWoundNotice ? (
          <div className="panel-body wound-modal-body">
            <div className="wound-mark" aria-hidden="true">
              <span className="wound-slash wound-slash-main" />
              <span className="wound-slash wound-slash-cross" />
            </div>
            <div className="wound-modal-content">
              <div className="wound-kicker">Wound taken</div>
              <div className="wound-headline">
                <strong>{visibleWoundNotice.name}</strong>
                {` gains ${visibleWoundNotice.wounds} wound${Number(visibleWoundNotice.wounds) === 1 ? "" : "s"}.`}
              </div>
              <div className="wound-card-row">
                <div className="wound-card-mini" aria-label={`${visibleWoundNotice.wounds} wound cards`}>
                  <span>Wound</span>
                  <strong>{`x${visibleWoundNotice.wounds}`}</strong>
                </div>
                <div
                  className="wound-toughness-box"
                  aria-label={`Toughness ${visibleWoundNotice.toughnessAfter}/${visibleWoundNotice.toughnessMax} after wounds`}
                >
                  <span>Toughness</span>
                  <strong>{`${visibleWoundNotice.toughnessAfter}/${visibleWoundNotice.toughnessMax}`}</strong>
                  <div className="wound-toughness-track" aria-hidden="true">
                    <div
                      className="wound-toughness-fill"
                      style={{ width: `${percent(visibleWoundNotice.toughnessAfter, visibleWoundNotice.toughnessMax)}%` }}
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
        open={modal === "digital-card-reset-confirm" && Boolean(selectedEntity)}
        title="Switch To Digital Cards"
        subtitle="This resets the digital deck, then shuffles the tracked physical wounds into it."
        onClose={closeModal}
        closeOnOutsideClick={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">
            {selectedEntity
              ? `${selectedEntity.name} has ${selectedWoundCounts.total || 0} tracked wound${Number(selectedWoundCounts.total || 0) === 1 ? "" : "s"}.`
              : ""}
          </div>
          <div className="modal-actions">
            <button
              className="primary-button"
              type="button"
              onClick={() => handleSetPlayerCardMode(false, { deckReset: true })}
              disabled={busy}
            >
              Reset deck and switch
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
        className="modal-shell-add-unit"
      >
        <div className="panel-body add-unit-body">
          <div className="add-unit-tabs" role="tablist">
            {[["premade", "Premade"], ["pc", "Player Character"], ["builder", "Character Builder"], ["custom", "Custom Enemy"]].map(([id, label]) => (
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
              <div className="creature-browser">
                <aside className="creature-browser-sidebar" aria-label="Enemy parts">
                  {templateCategories.map((category) => {
                    const stats = templateCategoryStats.get(category) || summarizeTemplates([]);
                    const count = statCountForAvailability(stats, templateAvailability);
                    const label = category === "All" ? "All" : titleCaseFromSnake(category);
                    return (
                      <button
                        key={category}
                        type="button"
                        className={`creature-part-button ${templateCategory === category ? "creature-part-button-active" : ""}`.trim()}
                        onClick={() => {
                          setTemplateCategory(category);
                          setTemplateSection("All");
                        }}
                        aria-pressed={templateCategory === category}
                        aria-label={`Filter part ${label}`}
                      >
                        <span>{label}</span>
                        <strong>{count}</strong>
                      </button>
                    );
                  })}
                </aside>

                <div className="creature-browser-main">
                  <div className="creature-browser-toolbar">
                    <label className="field template-search-field">
                      <span>Search enemies</span>
                      <input
                        type="search"
                        value={templateSearch}
                        onChange={(event) => setTemplateSearch(event.target.value)}
                        placeholder="Name, id, trait"
                      />
                    </label>

                    <div className="creature-status-segment" role="group" aria-label="Enemy availability">
                      {TEMPLATE_AVAILABILITY_FILTERS.map((filter) => (
                        <button
                          key={filter.id}
                          type="button"
                          className={`creature-status-button ${templateAvailability === filter.id ? "creature-status-button-active" : ""}`.trim()}
                          onClick={() => setTemplateAvailability(filter.id)}
                          aria-pressed={templateAvailability === filter.id}
                          aria-label={`Show ${filter.label} templates`}
                        >
                          {filter.label}
                        </button>
                      ))}
                    </div>

                    <div className="creature-threat-filters">
                      <label className="field creature-threat-field">
                        <span>TL min</span>
                        <select
                          aria-label="Minimum threat level"
                          value={templateThreatMin}
                          onChange={(event) => setTemplateThreatMin(event.target.value)}
                        >
                          <option value="">Any</option>
                          {templateThreatLevels.map((level) => (
                            <option key={level} value={level}>TL {level}</option>
                          ))}
                        </select>
                      </label>
                      <label className="field creature-threat-field">
                        <span>TL max</span>
                        <select
                          aria-label="Maximum threat level"
                          value={templateThreatMax}
                          onChange={(event) => setTemplateThreatMax(event.target.value)}
                        >
                          <option value="">Any</option>
                          {templateThreatLevels.map((level) => (
                            <option key={level} value={level}>TL {level}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>

                  {templateCategory !== "All" && templateSections.length > 1 ? (
                    <div className="creature-section-tabs" role="group" aria-label="Enemy sections">
                      {templateSections.map((section) => {
                        const stats = templateSectionStats.get(section) || summarizeTemplates([]);
                        const count = statCountForAvailability(stats, templateAvailability);
                        const label = section === "All" ? "All sections" : section;
                        return (
                          <button
                            key={section}
                            type="button"
                            className={`creature-section-tab ${templateSection === section ? "creature-section-tab-active" : ""}`.trim()}
                            onClick={() => setTemplateSection(section)}
                            aria-pressed={templateSection === section}
                            aria-label={`Filter section ${label}`}
                          >
                            <span>{label}</span>
                            <strong>{count}</strong>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  <div className="creature-results-summary">
                    <span>{shownTemplates.length} results</span>
                  </div>

                  <div className="creature-result-list">
                    {shownTemplates.map((template) => {
                      const isSpawnable = isTemplateSpawnable(template);
                      const showImage = template.imageUrl && template.imageUrl !== "/images/anonymous.png" && template.imageMissing !== true;
                      const taxonomy = [getTemplateCategory(template), getTemplateSection(template)].filter(Boolean).join(" / ");
                      const blockers = template.spawnBlockers || ["Incomplete creature row"];
                      return (
                        <div
                          key={template.id}
                          className={`creature-result-row ${isSpawnable ? "" : "creature-result-row-disabled"}`.trim()}
                        >
                          <div className="creature-result-thumb" aria-hidden="true">
                            {showImage ? <img src={template.imageUrl} alt="" /> : <span>{getTemplateInitials(template)}</span>}
                          </div>
                          <div className="creature-result-main">
                            <div className="creature-result-topline">
                              <span>{taxonomy}</span>
                              <span className={`creature-result-status ${isSpawnable ? "creature-result-status-ready" : "creature-result-status-design"}`.trim()}>
                                {getTemplateStatusLabel(template)}
                              </span>
                            </div>
                            <div className="creature-result-name-row">
                              <div className="creature-result-name">{template.name}</div>
                              <div className="creature-result-tl">TL {template.threatLevel ?? "-"}</div>
                            </div>
                            {template.shortFlavour ? <div className="creature-result-flavour">{template.shortFlavour}</div> : null}
                            {!isSpawnable ? (
                              <div className="creature-result-blocker">{blockers.slice(0, 2).join(" · ")}</div>
                            ) : null}
                          </div>
                          <button
                            className="creature-result-add"
                            type="button"
                            onClick={() => handleAddEnemyFromTemplate(template.id)}
                            disabled={busy || !isSpawnable}
                            aria-label={`Add ${template.name}`}
                            title={!isSpawnable ? blockers.join(", ") : template.shortFlavour || template.name}
                          >
                            <PlusIcon />
                            <span>Add</span>
                          </button>
                        </div>
                      );
                    })}
                    {!shownTemplates.length ? <div className="empty-copy premade-empty">No enemies match these filters.</div> : null}
                  </div>
                </div>
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
                  <label className={`toggle-field field-full ${pcForm.physicalCards ? "toggle-active" : ""}`.trim()}>
                    <input
                      type="checkbox"
                      checked={pcForm.physicalCards}
                      onChange={(event) => setPcForm((current) => ({ ...current, physicalCards: event.target.checked }))}
                    />
                    <span>Physical cards</span>
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

          {addUnitTab === "builder" && (
            <div className="add-unit-tab-panel character-builder-panel">
              <div className="character-builder-layout">
                <section className="character-builder-saved" aria-label="Saved characters">
                  <div className="builder-section-header">
                    <div>
                      <h3>Saved characters</h3>
                    </div>
                    <button className="secondary-button compact-button" type="button" onClick={refreshSavedCharacters} disabled={busy}>
                      Refresh
                    </button>
                  </div>
                  <div className="saved-character-list">
                    {savedCharacters.map((character) => (
                      <div className="saved-character-row" key={character.id}>
                        <div>
                          <strong>{character.name}</strong>
                          <span>{[character.className, character.ancestryName].filter(Boolean).join(" / ")}</span>
                          <small>{(character.energyTypes || []).join(", ")}</small>
                        </div>
                        <div className="saved-character-actions">
                          <button
                            className="primary-button compact-button"
                            type="button"
                            onClick={() => handleSpawnSavedCharacter(character.id)}
                            disabled={busy}
                          >
                            Spawn
                          </button>
                          <button
                            className="secondary-button compact-button"
                            type="button"
                            onClick={() => handleDeleteSavedCharacter(character.id)}
                            disabled={busy}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                    {!savedCharacters.length ? <div className="empty-copy">No saved characters yet.</div> : null}
                  </div>
                </section>

                <form className="modal-form character-builder-form" onSubmit={handleSaveBuilderCharacter}>
                  <div className="builder-section-header">
                    <div>
                      <h3>Build character</h3>
                    </div>
                  </div>

                  <div className="field-grid">
                    <label className="field field-full">
                      <span>Name</span>
                      <input
                        type="text"
                        value={characterBuilderForm.name}
                        onChange={(event) => setCharacterBuilderForm((current) => ({ ...current, name: event.target.value }))}
                        placeholder="Mira"
                      />
                    </label>
                    <label className="field">
                      <span>Class</span>
                      <select value={characterBuilderForm.classId} onChange={(event) => updateBuilderClass(event.target.value)}>
                        {(characterCatalog?.classes || []).map((classEntry) => (
                          <option key={classEntry.id} value={classEntry.id}>
                            {classEntry.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Ancestry</span>
                      <select
                        value={characterBuilderForm.ancestryId}
                        onChange={(event) => updateBuilderAncestry(event.target.value)}
                      >
                        {(characterCatalog?.ancestries || []).map((ancestry) => (
                          <option key={ancestry.id} value={ancestry.id}>
                            {ancestry.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="builder-card">
                    <div className="builder-card-title">Character art</div>
                    <div className="builder-art-grid">
                      {builderShownArtOptions.map((artOption) => {
                        const selected = sameCharacterArt(artOption, characterBuilderForm.art);
                        return (
                          <button
                            className={`builder-art-option ${selected ? "builder-art-selected" : ""}`.trim()}
                            type="button"
                            key={`${artOption.source}-${artOption.imagePath}`}
                            onClick={() => setCharacterBuilderForm((current) => ({ ...current, art: artOption }))}
                            aria-pressed={selected}
                          >
                            <span className="builder-art-thumb">
                              <img src={artOption.imageUrl} alt="" aria-hidden="true" />
                            </span>
                            <span>{artOption.label}</span>
                            {artOption.source === "upload" ? <small>custom</small> : null}
                          </button>
                        );
                      })}
                    </div>
                    {!builderArtOptions.length ? (
                      <div className="empty-copy">No matching class/ancestry art yet. Anonymous or custom upload will be used.</div>
                    ) : null}
                    <label className="secondary-button character-art-upload">
                      Upload custom art
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={handleCharacterArtUpload}
                        disabled={busy}
                      />
                    </label>
                  </div>

                  <div className="builder-card">
                    <div className="builder-card-title">Energy types</div>
                    <div className="builder-energy-grid">
                      {(characterCatalog?.energyTypes || []).map((energyType) => {
                        const checked = characterBuilderForm.energyTypes.includes(energyType);
                        const required = builderClass?.requiredEnergyTypes?.includes(energyType);
                        const blocked = builderClass?.forbiddenEnergyTypes?.includes(energyType);
                        const disabled = required || (!checked && characterBuilderForm.energyTypes.length >= 3);
                        return (
                          <label
                            key={energyType}
                            className={`builder-energy-option ${checked ? "builder-energy-selected" : ""} ${blocked ? "builder-energy-blocked" : ""}`.trim()}
                          >
                                <input
                                  type="checkbox"
                                  aria-label={energyType}
                                  checked={checked}
                                  disabled={disabled}
                                  onChange={() => toggleBuilderEnergy(energyType)}
                                />
                            <span>{energyType}</span>
                            {required ? <small>required</small> : blocked ? <small>GM approval</small> : null}
                          </label>
                        );
                      })}
                    </div>
                    {builderSelectedForbiddenEnergyTypes.length ? (
                      <label className={`builder-approval-warning ${characterBuilderForm.gmOverride ? "builder-approval-checked" : ""}`.trim()}>
                        <input
                          type="checkbox"
                          checked={characterBuilderForm.gmOverride}
                          onChange={(event) => setCharacterBuilderForm((current) => ({ ...current, gmOverride: event.target.checked }))}
                        />
                        <span>
                          <strong>Requires GM approval</strong>
                          <small>
                            {builderClass?.name || "This class"} normally cannot choose {builderSelectedForbiddenLabel}. Confirm that the GM approves this exception.
                          </small>
                        </span>
                      </label>
                    ) : null}
                    <label className="field">
                      <span>Main art</span>
                      <select
                        value={characterBuilderForm.mainArt}
                        onChange={(event) => setCharacterBuilderForm((current) => ({ ...current, mainArt: event.target.value }))}
                      >
                        {(builderClass?.mainArtOptions || []).map((energyType) => (
                          <option key={energyType} value={energyType} disabled={!characterBuilderForm.energyTypes.includes(energyType)}>
                            {energyType}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <details className="builder-card builder-card-disclosure">
                    <summary className="builder-card-summary">
                      <span className="builder-card-title">Deck upgrades</span>
                      <span className="builder-card-summary-meta">Advanced</span>
                    </summary>
                    <div className="builder-card-disclosure-body">
                      <div className="builder-upgrade-grid">
                        {characterBuilderForm.energyTypes.map((energyType) => (
                          <div className="builder-upgrade-row" key={energyType}>
                            <strong>{energyType}</strong>
                            {BUILDER_UPGRADE_KEYS.map(({ key, label }) => (
                              <label className="builder-upgrade-field" key={key}>
                                <span>{label}</span>
                                <input
                                  type="number"
                                  min="0"
                                  max="2"
                                  value={characterBuilderForm.deckUpgrades?.[energyType]?.[key] || 0}
                                  onChange={(event) => updateBuilderUpgrade(energyType, key, event.target.value)}
                                />
                              </label>
                            ))}
                          </div>
                        ))}
                      </div>
                      <label className="field">
                        <span>Class improvement</span>
                        <select
                          value={characterBuilderForm.classImprovementTarget}
                          onChange={(event) => setCharacterBuilderForm((current) => ({ ...current, classImprovementTarget: event.target.value }))}
                        >
                          {BUILDER_UPGRADE_KEYS.map(({ key, label }) => (
                            <option key={key} value={key} disabled={!builderClassTargetOptions.some((option) => option.key === key)}>
                              {characterBuilderForm.mainArt} {label} to 3
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </details>

                  <div className="field-grid">
                    <label className="field">
                      <span>Gear</span>
                      <select
                        value={characterBuilderForm.gearPresetId}
                        onChange={(event) => setCharacterBuilderForm((current) => ({ ...current, gearPresetId: event.target.value }))}
                      >
                        {(builderClass?.gearPresets || []).map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={`toggle-field ${characterBuilderForm.physicalCards ? "toggle-active" : ""}`.trim()}>
                      <input
                        type="checkbox"
                        checked={characterBuilderForm.physicalCards}
                        onChange={(event) => setCharacterBuilderForm((current) => ({ ...current, physicalCards: event.target.checked }))}
                      />
                      <span>Physical cards when spawned</span>
                    </label>
                  </div>

                  <div className="builder-review">
                    <div>
                      <span>Class</span>
                      <strong>{builderClass?.name || "-"}</strong>
                    </div>
                    <div>
                      <span>Ancestry</span>
                      <strong>{builderAncestry?.name || "-"}</strong>
                    </div>
                    <div>
                      <span>Art</span>
                      <strong>{characterBuilderForm.art?.label || "Anonymous"}</strong>
                    </div>
                    <div>
                      <span>Energies</span>
                      <strong>{characterBuilderForm.energyTypes.join(", ") || "-"}</strong>
                    </div>
                    <div>
                      <span>Deck</span>
                      <strong>20 cards</strong>
                    </div>
                    <div className="builder-review-wide">
                      <span>Gear</span>
                      <strong>{(builderClass?.gearPresets || []).find((preset) => preset.id === characterBuilderForm.gearPresetId)?.items?.join(", ") || "-"}</strong>
                    </div>
                  </div>

                  {builderErrors.length ? (
                    <div className="error-banner">
                      {builderErrors.slice(0, 3).join(" ")}
                    </div>
                  ) : null}

                  <div className="modal-actions">
                    <button className="primary-button" type="submit" disabled={busy || !builderCanSave}>
                      Save character
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={busy || !savedCharacters.length}
                      onClick={() => savedCharacters[0] && handleSpawnSavedCharacter(savedCharacters[0].id, characterBuilderForm.physicalCards)}
                    >
                      Spawn latest
                    </button>
                  </div>
                </form>
              </div>
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
                    <span>Draw</span>
                    <input
                      type="number"
                      min="0"
                      value={customForm.draw}
                      onChange={(event) => setCustomForm((current) => ({ ...current, draw: Number(event.target.value) }))}
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
        open={modal === "save-as"}
        title="Save session"
        subtitle="Create a new session save or overwrite an existing one."
        onClose={closeModal}
      >
        <form className="modal-form" onSubmit={handleSaveSubmit}>
          <label className="field">
            <span>New save name</span>
            <input type="text" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
          </label>
          <div className="modal-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              Create new save
            </button>
            <button className="secondary-button" type="button" onClick={closeModal}>
              Cancel
            </button>
          </div>
        </form>
        <div className="form-section">
          <div className="form-section-title">Overwrite existing save</div>
          <div className="save-list">
            {saves.length ? (
              saves.map((save) => (
                <div className={`save-row ${save.active ? "save-row-active" : ""}`.trim()} key={save.filename}>
                  <div className="save-slot-info">
                    <span className="save-slot-title">
                      <span>{save.label}</span>
                      {save.active ? <span className="save-active-badge">Active</span> : null}
                    </span>
                    <span className="save-slot-meta">{save.updatedAt || save.savedAt || save.filename}</span>
                  </div>
                  <button className="small-button" type="button" onClick={() => handleOverwriteSave(save.filename)} disabled={busy}>
                    Overwrite
                  </button>
                </div>
              ))
            ) : (
              <div className="subtle-copy">No session saves to overwrite.</div>
            )}
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "load"}
        title="Load session save"
        subtitle="Loads a saved session into the current session id."
        onClose={closeModal}
      >
        <div className="save-list">
          {saves.length ? (
            saves.map((save) => (
              <div className={`save-row ${save.active ? "save-row-active" : ""}`.trim()} key={save.filename}>
                <div className="save-slot-info">
                  <span className="save-slot-title">
                    <span>{save.label}</span>
                    {save.active ? <span className="save-active-badge">Active</span> : null}
                  </span>
                  <span className="save-slot-meta">{save.updatedAt || save.savedAt || save.filename}</span>
                </div>
                <button className="small-button" type="button" onClick={() => handleLoadSubmit(save.filename)} disabled={busy}>
                  Load
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
            <div className="subtle-copy">No session saves found for this workspace.</div>
          )}
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "pc-picker"}
        title="Which PCs spawn?"
        subtitle="Add pre-made or custom player characters to spawn at the map's spawn area."
        onClose={cancelPcPicker}
        size="wide"
        className="modal-shell-pc-picker"
      >
        <div className="pc-picker">
          <div className="pc-picker-tabs">
            <button
              type="button"
              className={`add-unit-tab ${pcPickerTab === "premade" ? "add-unit-tab-active" : ""}`.trim()}
              onClick={() => setPcPickerTab("premade")}
            >
              Pre-made
            </button>
            <button
              type="button"
              className={`add-unit-tab ${pcPickerTab === "custom" ? "add-unit-tab-active" : ""}`.trim()}
              onClick={() => setPcPickerTab("custom")}
            >
              Custom
            </button>
          </div>

          <div className="pc-picker-body">
            <div className="pc-picker-source">
              {pcPickerTab === "premade" ? (
                <div className="saved-character-list">
                  {savedCharacters.map((character) => (
                    <div className="saved-character-row" key={character.id}>
                      <div>
                        <strong>{character.name}</strong>
                        <span>{[character.className, character.ancestryName].filter(Boolean).join(" / ")}</span>
                      </div>
                      <button className="primary-button compact-button" type="button" onClick={() => addPremadePc(character)} disabled={busy}>
                        Add
                      </button>
                    </div>
                  ))}
                  {!savedCharacters.length ? <div className="empty-copy">No saved characters yet. Use the Custom tab.</div> : null}
                </div>
              ) : (
                <div className="modal-form">
                  <label className="field">
                    <span>Name</span>
                    <input type="text" value={pcPickerCustom.name} onChange={(e) => setPcPickerCustom((c) => ({ ...c, name: e.target.value }))} placeholder="Player" />
                  </label>
                  <label className="field">
                    <span>Deck</span>
                    <select value={pcPickerCustom.playerDeckId} onChange={(e) => setPcPickerCustom((c) => ({ ...c, playerDeckId: e.target.value }))}>
                      {(meta?.playerDecks || []).map((deck) => (
                        <option key={deck.id} value={deck.id}>{deck.name || deck.id}</option>
                      ))}
                    </select>
                  </label>
                  <div className="field-grid">
                    {[
                      ["toughness", "Toughness"],
                      ["armor", "Armor"],
                      ["magicArmor", "Magic armor"],
                      ["power", "Power"],
                      ["movement", "Movement"],
                      ["baseGuard", "Base guard"],
                    ].map(([key, label]) => (
                      <label className="field" key={key}>
                        <span>{label}</span>
                        <input
                          type="number"
                          min="0"
                          value={pcPickerCustom[key]}
                          onChange={(e) => setPcPickerCustom((c) => ({ ...c, [key]: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                        />
                      </label>
                    ))}
                  </div>
                  <button type="button" className="secondary-button" onClick={addCustomPc} disabled={busy}>
                    Add custom PC
                  </button>
                </div>
              )}
            </div>

            <div className="pc-picker-selection">
              <div className="form-section-title">Spawning ({pcPickerSelection.length})</div>
              {pcPickerSelection.length ? (
                pcPickerSelection.map((pc, index) => (
                  <div className="pc-picker-selected-row" key={index}>
                    <span>{pc.name}{pc.kind === "premade" ? "" : " (custom)"}</span>
                    <button
                      type="button"
                      className="icon-button pc-picker-remove"
                      onClick={() => removePcFromSelection(index)}
                      aria-label={`Remove ${pc.name}`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                ))
              ) : (
                <div className="subtle-copy">No PCs selected. You can start with none and add them later.</div>
              )}
            </div>
          </div>

          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={confirmPcPicker} disabled={busy}>
              Start with these PCs
            </button>
            <button className="secondary-button" type="button" onClick={cancelPcPicker} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "save-map-template"}
        title="Save map"
        subtitle="Create a new saved map or overwrite an existing one."
        onClose={closeModal}
      >
        <form className="modal-form" onSubmit={handleSaveMapTemplateSubmit}>
          <label className="field">
            <span>New map name</span>
            <input
              type="text"
              value={mapTemplateName}
              onChange={(e) => setMapTemplateName(e.target.value)}
              autoFocus
            />
          </label>
          <div className="modal-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              Create new map
            </button>
            <button className="secondary-button" type="button" onClick={closeModal}>
              Cancel
            </button>
          </div>
        </form>
        <div className="form-section">
          <div className="form-section-title">Overwrite existing map</div>
          <div className="save-list">
            {mapTemplates.length ? (
              mapTemplates.map((t) => (
                <div
                  className={`save-row ${snapshot?.activeMapTemplate?.id === t.id && !snapshot?.activeMapTemplate?.missing ? "save-row-active" : ""}`.trim()}
                  key={t.id}
                >
                  <div className="save-slot-info">
                    <span className="save-slot-title">
                      <span>{t.name}</span>
                      {snapshot?.activeMapTemplate?.id === t.id && !snapshot?.activeMapTemplate?.missing ? (
                        <span className="save-active-badge">Current</span>
                      ) : null}
                    </span>
                    <span className="save-slot-meta">{t.savedAt || t.filename}</span>
                  </div>
                  <button className="small-button" type="button" onClick={() => handleOverwriteMapTemplate(t.id)} disabled={busy}>
                    Overwrite
                  </button>
                </div>
              ))
            ) : (
              <div className="subtle-copy">No saved maps to overwrite.</div>
            )}
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "load-map-template"}
        title="Load map"
        subtitle="Replace the current map with a saved map. Runtime state (revealed rooms, doors) will reset."
        onClose={closeModal}
      >
        <div className="save-list">
          {mapTemplates.length ? (
            mapTemplates.map((t) => (
              <div className="save-row" key={t.id}>
                <div className="save-slot-info">
                  <span className="save-slot-title">{t.name}</span>
                  <span className="save-slot-meta">{t.savedAt || t.filename}</span>
                </div>
                <button className="small-button" type="button" onClick={() => handleLoadMapTemplate(t.id)} disabled={busy}>
                  Load
                </button>
                <button
                  className="save-delete-button"
                  type="button"
                  aria-label={`Delete template ${t.name}`}
                  onClick={() => handleDeleteMapTemplate(t.id)}
                  disabled={busy}
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          ) : (
            <div className="subtle-copy">No map templates saved yet.</div>
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
        open={modal === "unsaved-guard"}
        title="Unsaved changes"
        onClose={handleGuardCancel}
        closeOnOutsideClick={false}
        showCloseButton={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">
            The current session has unsaved changes. Continuing will replace it.
            {activeSave?.filename ? null : " There is no active session save yet — Save will let you name one."}
          </div>
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={handleGuardSave} disabled={busy}>
              Save
            </button>
            <button className="secondary-button danger-button" type="button" onClick={handleGuardContinue} disabled={busy}>
              Continue without saving
            </button>
            <button className="secondary-button" type="button" onClick={handleGuardCancel} disabled={busy}>
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
        open={modal === "search-manual" && Boolean(pendingSearch)}
        title={pendingSearch?.kind === "suspect" ? "Investigate result" : "Search result"}
        subtitle="Physical cards"
        onClose={closeModal}
        closeOnOutsideClick={false}
      >
        <div className="panel-body">
          <div className="subtle-copy">
            Voer het aantal getrokken successen in voor deze fysieke kaartactie.
          </div>
          <div className="draw-exact-row">
            <div className="draw-exact-presets">
              {[0, 1, 2, 3].map((n) => (
                <button
                  key={n}
                  type="button"
                  className="primary-button draw-exact-preset-btn"
                  onClick={() => handleResolveManualSearch(n)}
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
                handleResolveManualSearch();
              }}
            >
              <input
                className="draw-exact-input"
                type="number"
                min="0"
                max="99"
                value={manualSearchSuccesses}
                onChange={(e) => setManualSearchSuccesses(Number(e.target.value))}
              />
              <button className="primary-button" type="submit" disabled={busy}>
                Resolve
              </button>
            </form>
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
              {searchWillpowerLabel(pendingSearch)}
            </button>
            <button className="secondary-button" type="button" onClick={() => handleResolveSearch(false)} disabled={busy}>
              {searchNoWillpowerLabel(pendingSearch)}
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "opportunity" && Boolean(pendingOpportunity)}
        title="Opportunity Attack"
        subtitle={pendingOpportunity ? `${pendingOpportunity.attackerName} vs ${pendingOpportunity.targetName}` : ""}
        onClose={() => handleOpportunityResolve("skip")}
        closeOnOutsideClick={false}
      >
        <div className="panel-body modal-form">
          <div className="subtle-copy">
            {pendingOpportunity
              ? `${pendingOpportunity.targetName} moves away from ${pendingOpportunity.attackerName}. Base DMG ${pendingOpportunity.baseDamage}, reach ${pendingOpportunity.reach}, hit draw ${pendingOpportunity.hitDrawCount || 3}.`
              : ""}
          </div>
          {pendingOpportunity?.drawnText?.length ? (
            <DrawCardView
              entityName={pendingOpportunity.attackerName}
              items={opportunityHitDrawGroups(pendingOpportunity)[0]?.items || []}
              groups={opportunityHitDrawGroups(pendingOpportunity)}
              kind="hit draw"
              showEnergies={false}
            />
          ) : null}
          {pendingOpportunity?.attackerPhysicalCards && pendingOpportunity?.successCount == null ? (
            <div className="form-grid compact-grid">
              <label className="field">
                <span>Successes</span>
                <input
                  type="number"
                  min="0"
                  value={opportunityManual.successes}
                  onChange={(event) => setOpportunityManual((current) => ({ ...current, successes: event.target.value }))}
                />
              </label>
              <label className="field">
                <span>Fate</span>
                <input
                  type="number"
                  min="0"
                  value={opportunityManual.fate}
                  onChange={(event) => setOpportunityManual((current) => ({ ...current, fate: event.target.value }))}
                />
              </label>
            </div>
          ) : null}
          <div className="modal-actions">
            <button className="primary-button" type="button" onClick={() => handleOpportunityResolve("attack")} disabled={busy}>
              Attack
            </button>
            <button className="secondary-button" type="button" onClick={() => handleOpportunityResolve("skip")} disabled={busy}>
              Skip
            </button>
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={modal === "opportunity-willpower" && Boolean(pendingOpportunity)}
        title={opportunityResultTitle(pendingOpportunity)}
        subtitle={opportunityResultSubtitle(pendingOpportunity)}
        onClose={() => handleOpportunityWillpower(false)}
        closeOnOutsideClick={false}
      >
        <div className="panel-body modal-form">
          {opportunityHasFate(pendingOpportunity) ? (
            <div className="subtle-copy">
              Zet willpower in om alle fate-kaarten als successen te tellen voor deze opportunity attack.
            </div>
          ) : null}
          {pendingOpportunity?.drawnText?.length ? (
            <DrawCardView
              entityName={pendingOpportunity.attackerName}
              items={opportunityHitDrawGroups(pendingOpportunity)[0]?.items || []}
              groups={opportunityHitDrawGroups(pendingOpportunity)}
              kind="hit draw"
              showEnergies={false}
            />
          ) : null}
          <div className="modal-actions">
            {opportunityHasFate(pendingOpportunity) ? (
              <button className="primary-button" type="button" onClick={() => handleOpportunityWillpower(true)} disabled={busy}>
                {opportunityWillpowerLabel(pendingOpportunity)}
              </button>
            ) : null}
            <button
              className={opportunityHasFate(pendingOpportunity) ? "secondary-button" : "primary-button"}
              type="button"
              onClick={() => handleOpportunityWillpower(false)}
              disabled={busy}
            >
              {opportunityNoWillpowerLabel(pendingOpportunity)}
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
            {selectedEntity?.name ?? "Deze unit"} mag deze beurt vrij bewegen zonder opportunity attacks uit te lokken.
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
        title={`Strengthen ${strengthenTarget?.name || selectedEntity?.name || ""}`.trim()}
        subtitle={`Actor: ${selectedEntity?.name || "Selected unit"}. +1 toughness per punt tot max toughness; overgebleven punten worden temporary toughness.${selectedEntity?.draw_bonus_pending > 0 ? ` Nu +${selectedEntity.draw_bonus_pending} beschikbaar.` : ""}${selectedEntity?.draw_bonus_next_turn > 0 ? ` Volgende beurt +${selectedEntity.draw_bonus_next_turn}.` : ""}`}
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
        open={modal === "guard"}
        title="Guard"
        subtitle="Gain Guard X. Guard is added to the current temporary guard pool."
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
                  onClick={() => handleGuard(n)}
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
                handleGuard();
              }}
            >
              <input
                className="draw-exact-input"
                type="number"
                min="1"
                max="99"
                value={guardCount}
                onChange={(e) => setGuardCount(Number(e.target.value))}
              />
              <button className="primary-button" type="submit" disabled={busy}>
                Guard
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

function splitCombatActionText(actionText) {
  const text = String(actionText || "").trim();
  if (text.includes("\u2014")) {
    const [title, ...rest] = text.split("\u2014");
    return { title: title.trim(), body: rest.join("\u2014").trim() };
  }
  if (text.includes(" - ")) {
    const [title, ...rest] = text.split(" - ");
    return { title: title.trim(), body: rest.join(" - ").trim() };
  }
  return { title: text, body: text };
}

function parseCombatActionPreview(result, actionText, sourceAction = {}) {
  const text = String(actionText || "").trim();
  const { title, body } = splitCombatActionText(text);
  const effects = [];
  let simplified = body;
  const attack = body.match(/\b(?:ranged\s+)?(?:magic\s+)?attack\s+(\d+)\b/i);
  if (attack) {
    effects.push({ type: "attack", amount: Number(attack[1]), modifiers: parseCombatAttackModifiers(body) });
    simplified = `${simplified.slice(0, attack.index)}${simplified.slice((attack.index || 0) + attack[0].length)}`;
  }
  for (const match of combatConditionalAttackMatches(body)) {
    const conditionText = match.conditionText || "";
    const conditionModifiers = parseCombatConditionalAttackConditions(conditionText);
    const amount = Number(match.amount || 0);
    if (conditionModifiers.length && amount > 0) {
      effects.push({
        type: "conditional_attack",
        amount,
        modifiers: [
          "replace_attack",
          ...conditionModifiers,
          conditionTextUsesAll(conditionText) ? "condition_all" : "condition_any",
        ],
      });
      simplified = simplified.replace(match.text, "");
    }
  }
  for (const match of body.matchAll(/\bcharged?\s+(\d+)\b/gi)) {
    const amount = Math.max(0, Number(match[1]) || 0);
    if (amount <= 0) continue;
    const matchIndex = match.index || 0;
    const sentenceStart = Math.max(body.lastIndexOf(".", matchIndex) + 1, body.lastIndexOf(";", matchIndex) + 1);
    const prefix = body.slice(sentenceStart, matchIndex);
    let conditionalPrefix = prefix.toLowerCase().replace(/^if\s+this\s+deals\s+damage\s*,?\s*/, "");
    conditionalPrefix = conditionalPrefix.replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "");
    if (conditionalPrefix && /\b(adjacent|nearby|within|range|prone|already|another|bloodied|down)\b/i.test(conditionalPrefix)) {
      continue;
    }
    const modifiers = /\bif\s+this\s+deals\s+damage\b/i.test(prefix) ? ["on_damage"] : [];
    effects.push({ type: "charge", amount, modifiers });
    simplified = simplified.replace(match[0], "");
  }
  for (const match of body.matchAll(/\bgrappled?\s+(\d+)\b/gi)) {
    const amount = Math.max(0, Number(match[1]) || 0);
    if (amount <= 0) continue;
    const matchIndex = match.index || 0;
    const sentenceStart = Math.max(body.lastIndexOf(".", matchIndex) + 1, body.lastIndexOf(";", matchIndex) + 1);
    const prefix = body.slice(sentenceStart, matchIndex);
    let conditionalPrefix = prefix.toLowerCase().replace(/^if\s+this\s+deals\s+damage\s*,?\s*/, "");
    conditionalPrefix = conditionalPrefix.replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "");
    if (conditionalPrefix && /\b(adjacent|nearby|within|range|prone|already|another|bloodied|down)\b/i.test(conditionalPrefix)) {
      continue;
    }
    const modifiers = /\bif\s+this\s+deals\s+damage\b/i.test(prefix) ? ["on_damage"] : [];
    effects.push({ type: "grapple", amount, modifiers });
    simplified = simplified.replace(match[0], "");
  }
  const proneSource = simplified;
  for (const match of proneSource.matchAll(/\bprone\b/gi)) {
    const matchIndex = match.index || 0;
    const sentenceStart = Math.max(proneSource.lastIndexOf(".", matchIndex) + 1, proneSource.lastIndexOf(";", matchIndex) + 1);
    const prefix = proneSource.slice(sentenceStart, matchIndex);
    let conditionalPrefix = prefix.toLowerCase().replace(/^if\s+this\s+deals\s+damage\s*,?\s*/, "");
    conditionalPrefix = conditionalPrefix.replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "");
    if (conditionalPrefix && /\b(adjacent|nearby|within|range|already|another|bloodied|down)\b/i.test(conditionalPrefix)) {
      continue;
    }
    const modifiers = /\bif\s+this\s+deals\s+damage\b/i.test(prefix) ? ["on_damage"] : [];
    effects.push({ type: "prone", amount: 1, modifiers });
    simplified = simplified.replace(/\bprone\b/i, "");
  }
  for (const match of body.matchAll(/\bgain\s+(\d+)\s+guard\b/gi)) {
    effects.push({ type: "guard", amount: Number(match[1]), modifiers: [] });
    simplified = simplified.replace(match[0], "");
  }
  for (const match of body.matchAll(/\bdraw\s+(\d+)\b/gi)) {
    effects.push({ type: "draw", amount: Number(match[1]), modifiers: [] });
    simplified = simplified.replace(match[0], "");
  }
  [
    /\branged\s+magic\s+/gi,
    /\bmagic\s+pierce\b/gi,
    /\bpierce\s+\d+\b/gi,
    /\bsunder\s+\d+\b/gi,
    /\bstab\b/gi,
    /\bsunder\b/gi,
    /\boverwhelm\b/gi,
    /\bshatter\b/gi,
    /\bparaly[sz]e\b/gi,
    /\bif\s+this\s+deals\s+damage,?\b/gi,
    /\bthe\s+target\s+becomes\b/gi,
    /\btarget\s+becomes\b/gi,
    /\branged\s+/gi,
    /\bmagic\s+/gi,
  ].forEach((pattern) => {
    simplified = simplified.replace(pattern, "");
  });
  simplified = simplified.replace(/\b(?:and|or)\b\s*$/gi, "");
  simplified = simplified.replace(/^[\s,.;:\u2014-]+|[\s,.;:\u2014-]+$/g, "").replace(/\s+/g, " ").trim();
  const manualNotes = simplified ? [simplified] : [];
  const coverageStatus = combatActionCoverageStatus(text, effects, manualNotes);
  return {
    id: sourceAction.id || `${result}-preview`,
    result,
    title: title || text || result,
    text,
    weight: sourceAction.weight ?? 1,
    reshuffle: Boolean(sourceAction.reshuffle),
    effects,
    manualNotes,
    coverage: { status: coverageStatus, label: combatCoverageLabel(coverageStatus), notes: manualNotes },
    coverageStatus,
  };
}

function combatConditionalAttackMatches(body) {
  const matches = [];
  const seen = new Set();
  const patterns = [
    /\bif\s+(?:the\s+)?target\s+(?:(?:is|has|is affected by)\s+)?(?:already\s+)?(.+?)\s*,?\s+(?:deal\s+)?(?:attack\s+(\d+)|(\d+)\s*(?:dmg|damage))\s+instead\b/gi,
    /\bif\s+((?:(?:an?\s+|another\s+)?(?:ally|allied|friendly|friend|[a-z][\w-]*)\s+(?:is\s+)?adjacent(?:\s+to\s+(?:the\s+)?target)?)|(?:(?:the\s+)?target\s+has\s+(?:an?\s+)?adjacent\s+(?:ally|allied|friendly|friend|[a-z][\w-]*)))\s*,?\s+(?:deal\s+)?(?:attack\s+(\d+)|(\d+)\s*(?:dmg|damage))\s+instead\b/gi,
  ];
  patterns.forEach((pattern) => {
    for (const match of body.matchAll(pattern)) {
      if (seen.has(match[0])) continue;
      const amount = match[2] || match[3] || 0;
      matches.push({ text: match[0], conditionText: match[1] || "", amount });
      seen.add(match[0]);
    }
  });
  return matches;
}

function parseCombatAttackModifiers(body) {
  const modifiers = [];
  if (/\branged\s+(?:magic\s+)?attack\b/i.test(body)) modifiers.push("ranged");
  for (const match of body.matchAll(/\bpierce\s+(\d+)\b/gi)) {
    const amount = Math.max(0, Number(match[1]) || 0);
    if (amount > 0) modifiers.push(`pierce:${amount}`);
  }
  if (/\bstab\b/i.test(body)) modifiers.push("stab");
  for (const match of body.matchAll(/\bsunder(?:\s+(\d+))?\b/gi)) {
    const amount = Math.max(0, Number(match[1] || 1) || 0);
    if (amount > 0) modifiers.push(`sunder:${amount}`);
  }
  if (/\boverwhelm\b/i.test(body)) modifiers.push("overwhelm");
  if (/\bshatter\b/i.test(body)) modifiers.push("shatter");
  if (/\bmagic\s+pierce\b/i.test(body)) modifiers.push("magic_pierce");
  if (/\bparaly[sz]e\b/i.test(body)) modifiers.push("paralyse");
  return [...new Set(modifiers)];
}

function combatActionCoverageStatus(actionText, effects, manualNotes) {
  const text = String(actionText || "").trim();
  if (!text) return "error";
  const { body } = splitCombatActionText(text);
  if (/\battack\b/i.test(body) && !effects.some((effect) => effect.type === "attack")) {
    return "error";
  }
  if (!manualNotes.length) return "full";
  if (
    manualNotes.some((note) =>
      /\bif\s+(?:the\s+)?target\b.+\b(?:attack\s+\d+|\d+\s*(?:dmg|damage))\s+instead\b/i.test(note),
    )
  ) {
    return "warning";
  }
  return manualNotes.every((note) => combatManualNoteIsKnown(note)) ? "manual" : "warning";
}

function combatManualNoteIsKnown(note) {
  return [
    /\bmove\b/i,
    /\bmoves\b/i,
    /\bshift\b/i,
    /\bteleport\b/i,
    /\bpush\b/i,
    /\bpull\b/i,
    /\bknock\b/i,
    /\bprone\b/i,
    /\badjacent\b/i,
    /\bnearby\b/i,
    /\bwithin\b/i,
    /\brange\b/i,
    /\bline\b/i,
    /\bcone\b/i,
    /\barea\b/i,
    /\ball\b/i,
    /\beach\b/i,
    /\btarget\b/i,
    /\btargets\b/i,
    /\btaunt\b/i,
    /\bfear\b/i,
    /\bstun\b/i,
    /\bslow\b/i,
    /\bburn\b/i,
    /\bpoison\b/i,
    /\bheal\b/i,
    /\bsummon\b/i,
    /\bspawn\b/i,
    /\buntil\b/i,
    /\bnext turn\b/i,
    /\bif\b/i,
    /\bwhen\b/i,
    /\bor\b/i,
    /\bmanual\b/i,
    /\bchoose\b/i,
    /\bdisengage\b/i,
  ].some((pattern) => pattern.test(String(note || "")));
}

function combatCoverageLabel(status) {
  if (status === "full") return "Fully simulated";
  if (status === "manual") return "Manual/ignored";
  if (status === "warning") return "Parse warning";
  if (status === "error") return "Sim blocker";
  return status || "Unknown";
}

function getTemplateSimActions(template) {
  if (Array.isArray(template?.simActions) && template.simActions.length) {
    return template.simActions.map((action) => normalizeSimAction(action));
  }
  const rawActions = template?.actions || {};
  return CREATURE_ACTION_ORDER.filter((result) => rawActions[result]).map((result) =>
    parseCombatActionPreview(result, rawActions[result]),
  );
}

function normalizeSimAction(action) {
  const coverageStatus = action.coverageStatus || action.coverage?.status || "full";
  return {
    ...action,
    result: action.result || action.actionResult,
    text: action.text || action.actionText || "",
    effects: action.effects || [],
    manualNotes: action.manualNotes || [],
    coverage: action.coverage || { status: coverageStatus, label: combatCoverageLabel(coverageStatus), notes: action.manualNotes || [] },
    coverageStatus,
  };
}

function getSourceActionText(template, result) {
  const action = getTemplateSimActions(template).find((item) => item.result === result);
  return action?.text || "";
}

function getEffectiveSimActions(template, overrides = {}) {
  const actionOverrides = overrides?.actionOverrides || {};
  return getTemplateSimActions(template).map((action) => {
    if (!Object.prototype.hasOwnProperty.call(actionOverrides, action.result)) {
      return action;
    }
    return parseCombatActionPreview(action.result, actionOverrides[action.result], action);
  });
}

function summarizeCombatCoverage(actions = []) {
  const counts = { total: actions.length, full: 0, manual: 0, warning: 0, error: 0 };
  actions.forEach((action) => {
    const status = action.coverageStatus || action.coverage?.status || "full";
    counts[status] = (counts[status] || 0) + 1;
  });
  return counts;
}

function sourceSimStatValue(template, key) {
  if (!template) return "";
  if (key === "threatLevel") return template.simStats?.threatLevel ?? template.threatLevel ?? "";
  const source = template.simStats?.[key];
  if (source && typeof source === "object") {
    if (source.value != null) return source.value;
    if (source.min != null && source.max != null && source.min === source.max) return source.min;
    if (source.min != null && source.max != null) return `${source.min}-${source.max}`;
  }
  if (source != null) return source;
  return "";
}

function sourceSimSkillValue(template, key) {
  if (!template) return "";
  return template.skills?.[key] ?? "";
}

function effectiveSimStatValue(template, overrides, key) {
  const statOverrides = overrides?.statOverrides || {};
  if (Object.prototype.hasOwnProperty.call(statOverrides, key) && statOverrides[key] !== "" && statOverrides[key] != null) {
    return statOverrides[key];
  }
  return sourceSimStatValue(template, key);
}

function effectiveSimSkillValue(template, overrides, key) {
  const skillOverrides = overrides?.skillOverrides || {};
  if (Object.prototype.hasOwnProperty.call(skillOverrides, key) && skillOverrides[key] !== "" && skillOverrides[key] != null) {
    return skillOverrides[key];
  }
  return sourceSimSkillValue(template, key);
}

function effectiveSimInitiativeValue(template, overrides) {
  const alertness = effectiveSimSkillValue(template, overrides, "alertness");
  return alertness === "" || alertness == null ? sourceSimStatValue(template, "initiativeModifier") : alertness;
}

function displaySimValue(value) {
  return value === "" || value == null ? "-" : value;
}

function buildCombatOverridesPayload(overrides, template) {
  overrides = overrides || {};
  const statOverrides = {};
  Object.entries(overrides.statOverrides || {}).forEach(([key, value]) => {
    if (value === "" || value == null) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const sourceValue = Number(sourceSimStatValue(template, key));
    if (Number.isFinite(sourceValue) && sourceValue === numeric) return;
    statOverrides[key] = numeric;
  });

  const skillOverrides = {};
  Object.entries(overrides.skillOverrides || {}).forEach(([key, value]) => {
    if (value === "" || value == null) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const sourceValue = Number(sourceSimSkillValue(template, key));
    if (Number.isFinite(sourceValue) && sourceValue === numeric) return;
    skillOverrides[key] = numeric;
  });

  const actionOverrides = {};
  Object.entries(overrides.actionOverrides || {}).forEach(([result, value]) => {
    const text = String(value ?? "");
    if (text === getSourceActionText(template, result)) return;
    actionOverrides[result] = text;
  });

  const INFO_KEYS = ["shortFlavour", "loreNote", "traits", "size", "playtestStatus"];
  const infoOverrides = {};
  INFO_KEYS.forEach((key) => {
    const value = (overrides.infoOverrides || {})[key];
    if (value == null || value === "") return;
    if (value === (template[key] ?? "")) return;
    infoOverrides[key] = value;
  });

  const payload = {};
  if (Object.keys(statOverrides).length) payload.statOverrides = statOverrides;
  if (Object.keys(skillOverrides).length) payload.skillOverrides = skillOverrides;
  if (Object.keys(actionOverrides).length) payload.actionOverrides = actionOverrides;
  if (Object.keys(infoOverrides).length) payload.infoOverrides = infoOverrides;
  return Object.keys(payload).length ? payload : null;
}

function isEmptyCombatOverrides(overrides) {
  return (
    !Object.keys(overrides?.statOverrides || {}).length &&
    !Object.keys(overrides?.skillOverrides || {}).length &&
    !Object.keys(overrides?.actionOverrides || {}).length &&
    !Object.keys(overrides?.infoOverrides || {}).length
  );
}

function combatOverridesHaveNonStatusEdit(overrides) {
  if (!overrides) return false;
  if (Object.keys(overrides.statOverrides || {}).length) return true;
  if (Object.keys(overrides.skillOverrides || {}).length) return true;
  if (Object.keys(overrides.actionOverrides || {}).length) return true;
  return Object.keys(overrides.infoOverrides || {}).some((key) => key !== "playtestStatus");
}

function combatEntryHasSimulationOverrides(entry) {
  return Boolean(entry?.overrides && combatOverridesHaveNonStatusEdit(entry.overrides));
}

function isNormalGoblinTemplate(template) {
  const id = String(template?.id || "").trim().toLowerCase();
  const name = String(template?.name || "").trim().toLowerCase();
  return id === "goblin" || id === "c_goblin" || name === "goblin";
}

function autoRetestOverridesForSavedEdit(template, overrides) {
  if (!template || !overrides) return overrides;
  if (!EDIT_AUTO_RETEST_STATUSES.has(normalizePlaytestStatus(template.playtestStatus))) return overrides;
  if (!combatOverridesHaveNonStatusEdit(overrides)) return overrides;
  if (Object.prototype.hasOwnProperty.call(overrides.infoOverrides || {}, "playtestStatus")) return overrides;
  return {
    ...overrides,
    infoOverrides: {
      ...(overrides.infoOverrides || {}),
      playtestStatus: "Retest_Needed",
    },
  };
}

function combatSimPrecisionTargetMet(result, requestedPrecisionTargetPercent) {
  const target = Number(requestedPrecisionTargetPercent);
  if (!Number.isFinite(target) || target > SIM_PROMOTION_PRECISION_TARGET_PERCENT) return false;
  return Boolean(result?.summary?.precision?.targetMet);
}

function combatSimWinRatesAreBalanced(result) {
  const winRates = result?.summary?.winRates || {};
  const rateA = Number(winRates.A || 0);
  const rateB = Number(winRates.B || 0);
  const nonDraw = rateA + rateB;
  if (!Number.isFinite(rateA) || !Number.isFinite(rateB) || nonDraw <= 0) return false;
  const teamAShare = rateA / nonDraw;
  const winnerShare = Math.max(teamAShare, 1 - teamAShare);
  return winnerShare <= SIM_PROMOTION_MAX_NON_DRAW_WIN_SHARE;
}

function benchmarkCandidateForAutoSimulation(team, opposingTeam, templateLookup) {
  if (!Array.isArray(team) || !Array.isArray(opposingTeam) || team.length !== 1 || opposingTeam.length !== 1) {
    return null;
  }
  const candidateEntry = team[0];
  const goblinEntry = opposingTeam[0];
  if (combatEntryHasSimulationOverrides(candidateEntry) || combatEntryHasSimulationOverrides(goblinEntry)) return null;
  const candidate = templateLookup.get(candidateEntry.templateId);
  const goblin = templateLookup.get(goblinEntry.templateId);
  if (!candidate || !SIM_AUTO_PROMOTE_STATUSES.has(normalizePlaytestStatus(candidate.playtestStatus))) return null;
  if (Math.max(1, Number(candidateEntry.count) || 1) !== 1) return null;
  if (!isNormalGoblinTemplate(goblin)) return null;
  const expectedGoblins = Math.max(1, Number(getTemplateThreatLevel(candidate)) || 1);
  if (Math.max(1, Number(goblinEntry.count) || 1) !== expectedGoblins) return null;
  return candidate.id;
}

function autoSimulatedTemplateIds({ teamA, teamB, templateLookup, result, precisionTargetPercent }) {
  if (
    !combatSimPrecisionTargetMet(result, precisionTargetPercent) ||
    !combatSimWinRatesAreBalanced(result)
  ) {
    return [];
  }
  return [
    benchmarkCandidateForAutoSimulation(teamA, teamB, templateLookup),
    benchmarkCandidateForAutoSimulation(teamB, teamA, templateLookup),
  ].filter(Boolean);
}

function formatCombatEffect(effect) {
  if (!effect) return "-";
  if (effect.type === "attack") {
    const modifiers = (effect.modifiers || []).map(formatCombatModifier);
    return modifiers.length ? `Attack ${effect.amount} (${modifiers.join(", ")})` : `Attack ${effect.amount}`;
  }
  if (effect.type === "guard") return `Guard ${effect.amount}`;
  if (effect.type === "draw") return `Draw ${effect.amount}`;
  if (effect.type === "grapple") {
    return (effect.modifiers || []).includes("on_damage")
      ? `Grapple ${effect.amount} (on damage)`
      : `Grapple ${effect.amount}`;
  }
  if (effect.type === "charge") {
    return (effect.modifiers || []).includes("on_damage")
      ? `Charge ${effect.amount} (on damage)`
      : `Charge ${effect.amount}`;
  }
  if (effect.type === "prone") {
    return (effect.modifiers || []).includes("on_damage") ? "Prone (on damage)" : "Prone";
  }
  if (effect.type === "conditional_attack") {
    const conditions = (effect.modifiers || [])
      .filter((modifier) => String(modifier).startsWith("if_target_"))
      .map(formatCombatConditionModifier);
    return conditions.length
      ? `If target ${conditions.join((effect.modifiers || []).includes("condition_all") ? " and " : " or ")}: Attack ${effect.amount} instead`
      : `Conditional Attack ${effect.amount}`;
  }
  return `${effect.type} ${effect.amount ?? ""}`.trim();
}

function formatCombatConditionModifier(modifier) {
  if (modifier === "if_target_adjacent_ally") return "Has Adjacent Ally";
  return titleCaseFromSnake(String(modifier).replace(/^if_target_/, ""));
}

function conditionTextUsesAll(conditionText) {
  return /\band\b/i.test(conditionText) && !/\bor\b/i.test(conditionText);
}

function parseCombatConditionalAttackConditions(conditionText) {
  const pieces = String(conditionText || "")
    .split(/\b(?:or|and)\b|\/|,/i)
    .map((piece) =>
      piece
        .replace(/\balready\b/gi, "")
        .replace(/\b(?:another|is|has|the|target|a|an|to)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  const modifiers = [];
  for (const piece of pieces) {
    const modifier = combatConditionModifierForText(piece);
    if (!modifier) return [];
    modifiers.push(modifier);
  }
  return [...new Set(modifiers)];
}

function combatConditionModifierForText(text) {
  if (text.includes("adjacent") && text !== "adjacent") return "if_target_adjacent_ally";
  if (/^(grappled?|in a grapple)$/.test(text)) return "if_target_grappled";
  if (text === "prone") return "if_target_prone";
  if (["poisoned", "poison"].includes(text)) return "if_target_poisoned";
  if (["burning", "burned", "burn"].includes(text)) return "if_target_burning";
  if (["slowed", "slow"].includes(text)) return "if_target_slowed";
  if (["paralyzed", "paralysed", "paralyze", "paralyse"].includes(text)) return "if_target_paralyzed";
  if (["stunned", "stun"].includes(text)) return "if_target_stunned";
  return null;
}

function formatCombatModifier(modifier) {
  if (String(modifier).startsWith("pierce:")) return `Pierce ${String(modifier).split(":")[1]}`;
  if (String(modifier).startsWith("sunder:")) return `Sunder ${String(modifier).split(":")[1]}`;
  if (modifier === "magic_pierce") return "Magic pierce";
  if (modifier === "overwhelm") return "Overwhelm";
  if (modifier === "shatter") return "Shatter";
  if (modifier === "paralyse") return "Paralyze";
  return titleCaseFromSnake(String(modifier));
}

function outcomeValue(collection, key) {
  if (!collection) return 0;
  return collection[key] ?? collection[key.toUpperCase()] ?? collection[titleCaseFromSnake(key)] ?? 0;
}

function CombatSimView({ meta, onMetaUpdate }) {
  const spawnableTemplates = useMemo(
    () => (meta?.enemyTemplates || []).filter((template) => template.spawnable !== false),
    [meta],
  );
  const templateLookup = useMemo(
    () => new Map(spawnableTemplates.map((template) => [template.id, template])),
    [spawnableTemplates],
  );
  const firstTemplateId = spawnableTemplates[0]?.id || "";
  const secondTemplateId = spawnableTemplates[1]?.id || firstTemplateId;

  const [mode, setMode] = useState("batch");
  const [teamA, setTeamA] = useState([]);
  const [teamB, setTeamB] = useState([]);
  const [strategyA, setStrategyA] = useState("highest_toughness");
  const [strategyB, setStrategyB] = useState("highest_toughness");
  const [seed, setSeed] = useState("");
  const [runs, setRuns] = useState(1000);
  const [precisionTargetPercent, setPrecisionTargetPercent] = useState("5");
  const [maxRounds, setMaxRounds] = useState(100);
  const [simResult, setSimResult] = useState(null);
  const [simError, setSimError] = useState("");
  const [simNotice, setSimNotice] = useState("");
  const [simBusy, setSimBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [turnIndex, setTurnIndex] = useState(0);
  const [editingEntry, setEditingEntry] = useState(null);
  const [templateOverrides, setTemplateOverrides] = useState({});

  useEffect(() => {
    if (!firstTemplateId) {
      return;
    }
    setTeamA((current) => current.length ? current : [{ templateId: firstTemplateId, count: 1 }]);
    setTeamB((current) => current.length ? current : [{ templateId: secondTemplateId, count: 1 }]);
  }, [firstTemplateId, secondTemplateId]);

  function updateTeam(setTeam, index, patch) {
    setTeam((current) => current.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)));
  }

  function updateTemplateOverrides(templateId, updater) {
    if (!templateId) return;
    setTemplateOverrides((current) => {
      const nextOverrides = updater(current[templateId] || {});
      const next = { ...current };
      if (isEmptyCombatOverrides(nextOverrides)) {
        delete next[templateId];
      } else {
        next[templateId] = nextOverrides;
      }
      return next;
    });
  }

  function clearTemplateOverrides(templateId) {
    setTemplateOverrides((current) => {
      const next = { ...current };
      delete next[templateId];
      return next;
    });
  }

  function addTeamEntry(setTeam) {
    setTeam((current) => [...current, { templateId: firstTemplateId, count: 1 }]);
  }

  function removeTeamEntry(setTeam, index) {
    setTeam((current) => current.filter((_, entryIndex) => entryIndex !== index));
  }

  function normalizeTeam(entries) {
    return entries
      .filter((entry) => entry.templateId)
      .map((entry) => {
        const template = templateLookup.get(entry.templateId);
        const overrides = buildCombatOverridesPayload(templateOverrides[entry.templateId], template);
        return {
          templateId: entry.templateId,
          count: Math.max(1, Math.min(20, Number(entry.count) || 1)),
          ...(overrides ? { overrides } : {}),
        };
      });
  }

  async function submitSimulation(event) {
    event.preventDefault();
    const normalizedA = normalizeTeam(teamA);
    const normalizedB = normalizeTeam(teamB);
    const seedText = String(seed || "").trim();
    const requestedSeed = Number(seedText);
    const hasFixedSeed = seedText !== "" && Number.isFinite(requestedSeed) && requestedSeed > 0;
    if (!normalizedA.length || !normalizedB.length) {
      setSimError("Both teams need at least one creature.");
      return;
    }
    setSimBusy(true);
    setSimError("");
    setSimNotice("");
    const requestedPrecisionTargetPercent =
      mode === "batch" && precisionTargetPercent !== ""
        ? Math.max(0.1, Number(precisionTargetPercent) || SIM_PROMOTION_PRECISION_TARGET_PERCENT)
        : null;
    try {
      const payload = await requestJson("/api/combat-sim/simulate", {
        method: "POST",
        body: JSON.stringify({
          teamA: normalizedA,
          teamB: normalizedB,
          strategyA,
          strategyB,
          seed: hasFixedSeed ? requestedSeed : null,
          runs: mode === "batch" ? Math.max(1, Math.min(1000, Number(runs) || 100)) : 1,
          precisionTargetPercent: requestedPrecisionTargetPercent,
          maxRounds: Math.max(1, Number(maxRounds) || 100),
        }),
      });
      setSimResult(payload);
      setTurnIndex(0);
      const usedSeed = payload.result?.seed ?? payload.lastCombat?.seed;
      if (hasFixedSeed && usedSeed != null) {
        setSeed(String(usedSeed));
      } else {
        setSeed("");
      }
      if (mode === "batch") {
        const autoIds = [
          ...new Set(autoSimulatedTemplateIds({
            teamA: normalizedA,
            teamB: normalizedB,
            templateLookup,
            result: payload.result,
            precisionTargetPercent: requestedPrecisionTargetPercent,
          })),
        ];
        const autoSavedNames = [];
        const autoSaveFailures = [];
        for (const templateId of autoIds) {
          const templateName = templateLookup.get(templateId)?.name || templateId;
          try {
            const saved = await requestJson(`/api/battle/creature-templates/${encodeURIComponent(templateId)}/save-overrides`, {
              method: "POST",
              body: JSON.stringify({ infoOverrides: { playtestStatus: "Simulated" } }),
            });
            if (saved.metadata) onMetaUpdate?.(saved.metadata);
            autoSavedNames.push(templateName);
          } catch (saveError) {
            autoSaveFailures.push(`${templateName}: ${saveError.message}`);
          }
        }
        const autoStatusMessages = [];
        if (autoSavedNames.length) {
          autoStatusMessages.push(`Auto-marked ${autoSavedNames.join(", ")} as Simulated.`);
        }
        if (autoSaveFailures.length) {
          autoStatusMessages.push(`Auto status update failed: ${autoSaveFailures.join("; ")}`);
        }
        if (autoStatusMessages.length) {
          setSimNotice(autoStatusMessages.join(" "));
        }
      }
    } catch (requestError) {
      setSimError(requestError.message);
    } finally {
      setSimBusy(false);
    }
  }

  async function saveTemplateOverrides(templateId) {
    const template = templateLookup.get(templateId);
    const overrides = autoRetestOverridesForSavedEdit(
      template,
      buildCombatOverridesPayload(templateOverrides[templateId], template),
    );
    if (!template || !overrides) {
      return;
    }
    if (!window.confirm(`Save ${template.name} changes to the Excel source data?`)) {
      return;
    }
    setSaveBusy(true);
    setSimError("");
    setSimNotice("");
    try {
      const payload = await requestJson(`/api/battle/creature-templates/${encodeURIComponent(templateId)}/save-overrides`, {
        method: "POST",
        body: JSON.stringify(overrides),
      });
      if (payload.metadata) {
        onMetaUpdate?.(payload.metadata);
      }
      clearTemplateOverrides(templateId);
      setSimNotice(
        `Saved ${template.name} to Excel${payload.backupFilename ? `; backup ${payload.backupFilename}` : ""}.`,
      );
    } catch (requestError) {
      setSimError(requestError.message);
    } finally {
      setSaveBusy(false);
    }
  }

  const batchResult = simResult?.mode === "batch" ? simResult.result : null;
  const singleResult = simResult?.mode === "single" ? simResult.result : batchResult?.lastCombat || null;
  const currentTurn = mode === "turn" && singleResult && turnIndex > 0 ? singleResult.timeline[turnIndex - 1] : null;
  const visibleUnits =
    mode === "turn" && singleResult
      ? turnIndex === 0
        ? singleResult.initialUnits
        : currentTurn?.units || singleResult.finalUnits
      : singleResult?.finalUnits || [];
  const editingTeam = editingEntry ? (editingEntry.team === "A" ? teamA : teamB) : [];
  const editingTeamEntry = editingEntry ? editingTeam[editingEntry.index] : null;
  const editingTemplateId = editingTeamEntry?.templateId || "";
  const editingTemplate = editingTemplateId ? templateLookup.get(editingTemplateId) : null;

  if (!spawnableTemplates.length) {
    return (
      <main className="combat-sim-view">
        <Panel title="Combat Sim">
          <div className="subtle-copy">No spawnable creature templates are available.</div>
        </Panel>
      </main>
    );
  }

  return (
    <main className="combat-sim-view">
      <form className="combat-sim-controls" onSubmit={submitSimulation}>
        <Panel title="Combat Sim" detail="Creature vs creature simulation without movement or positioning.">
          <div className="combat-sim-mode-row">
            <div className="combat-sim-segment" role="group" aria-label="Simulation mode">
              {COMBAT_SIM_MODES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`combat-sim-segment-button ${mode === item.id ? "active" : ""}`.trim()}
                  onClick={() => {
                    setMode(item.id);
                    setSimResult(null);
                    setTurnIndex(0);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="field combat-sim-seed-field">
              <span>Fixed seed</span>
              <input
                type="number"
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
                placeholder="Auto each run"
              />
            </label>
            {mode === "batch" ? (
              <label className="field combat-sim-runs-field">
                <span>Target +/- %</span>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={precisionTargetPercent}
                  onChange={(event) => setPrecisionTargetPercent(event.target.value)}
                />
              </label>
            ) : null}
            {mode === "batch" ? (
              <label className="field combat-sim-runs-field">
                <span>Max runs</span>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={runs}
                  onChange={(event) => setRuns(event.target.value)}
                />
              </label>
            ) : null}
            <label className="field combat-sim-runs-field">
              <span>Max rounds</span>
              <input
                type="number"
                min="1"
                value={maxRounds}
                onChange={(event) => setMaxRounds(event.target.value)}
              />
            </label>
            <button className="primary-button combat-sim-run-button" type="submit" disabled={simBusy}>
              {mode === "batch" ? "Run Batch" : mode === "turn" ? "Start Playback" : "Quick Simulate"}
            </button>
          </div>
        </Panel>

        <div className="combat-team-grid">
          <CombatSimTeamBuilder
            title="Team A"
            team={teamA}
            templates={spawnableTemplates}
            templateLookup={templateLookup}
            templateOverrides={templateOverrides}
            strategy={strategyA}
            setStrategy={setStrategyA}
            onUpdate={(index, patch) => updateTeam(setTeamA, index, patch)}
            onEdit={(index) => setEditingEntry({ team: "A", index })}
            onAdd={() => addTeamEntry(setTeamA)}
            onRemove={(index) => {
              removeTeamEntry(setTeamA, index);
              setEditingEntry(null);
            }}
          />
          <CombatSimTeamBuilder
            title="Team B"
            team={teamB}
            templates={spawnableTemplates}
            templateLookup={templateLookup}
            templateOverrides={templateOverrides}
            strategy={strategyB}
            setStrategy={setStrategyB}
            onUpdate={(index, patch) => updateTeam(setTeamB, index, patch)}
            onEdit={(index) => setEditingEntry({ team: "B", index })}
            onAdd={() => addTeamEntry(setTeamB)}
            onRemove={(index) => {
              removeTeamEntry(setTeamB, index);
              setEditingEntry(null);
            }}
          />
        </div>
      </form>

      {editingEntry ? (
        <CombatSimEntryEditorModal
          teamLabel={`Team ${editingEntry.team}`}
          entry={editingTeamEntry}
          template={editingTemplate}
          overrides={templateOverrides[editingTemplateId] || {}}
          onClose={() => setEditingEntry(null)}
          onUpdateOverrides={(updater) =>
            updateTemplateOverrides(editingTemplateId, updater)
          }
          onSaveOverrides={() => saveTemplateOverrides(editingTemplateId)}
          saveBusy={saveBusy}
        />
      ) : null}

      {(simError || simNotice) ? (
        <div className={`status-banner ${simError ? "status-error" : "status-notice"} combat-sim-error`}>
          <span>{simError || simNotice}</span>
          <button
            className="status-dismiss"
            type="button"
            onClick={() => {
              setSimError("");
              setSimNotice("");
            }}
          >
            Close
          </button>
        </div>
      ) : null}

      {batchResult ? <CombatSimBatchSummary result={batchResult} /> : null}

      {singleResult ? (
        <CombatSimDetails
          result={singleResult}
          mode={mode}
          turnIndex={turnIndex}
          currentTurn={currentTurn}
          visibleUnits={visibleUnits}
          onNextTurn={() => setTurnIndex((current) => Math.min(current + 1, singleResult.timeline.length))}
          onResetTurn={() => setTurnIndex(0)}
        />
      ) : (
        <Panel title="Simulation Output">
          <div className="subtle-copy">Run a quick simulation, playback, or batch to inspect results.</div>
        </Panel>
      )}
    </main>
  );
}

function CombatSimTeamBuilder({
  title,
  team,
  templates,
  templateLookup,
  templateOverrides,
  strategy,
  setStrategy,
  onUpdate,
  onEdit,
  onAdd,
  onRemove,
}) {
  return (
    <Panel
      title={title}
      actions={
        <button className="secondary-button panel-header-button" type="button" onClick={onAdd}>
          Add
        </button>
      }
    >
      <div className="combat-team-builder">
        <label className="field">
          <span>Target priority</span>
          <select value={strategy} onChange={(event) => setStrategy(event.target.value)}>
            {COMBAT_SIM_STRATEGIES.map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <div className="combat-team-entries">
          {team.map((entry, index) => {
            const template = templateLookup.get(entry.templateId);
            const overrides = templateOverrides[entry.templateId] || {};
            const actions = getEffectiveSimActions(template, overrides);
            const coverage = summarizeCombatCoverage(actions);
            return (
              <div className="combat-team-entry" key={`${entry.templateId}-${index}`}>
                <div className="combat-team-entry-image">
                  {template?.imageUrl ? <img src={template.imageUrl} alt="" aria-hidden="true" /> : null}
                </div>
                <label className="field combat-team-template-field">
                  <span>Creature</span>
                  <select
                    value={entry.templateId}
                    onChange={(event) => onUpdate(index, { templateId: event.target.value })}
                  >
                    {templates.map((templateOption) => (
                      <option value={templateOption.id} key={templateOption.id}>
                        {templateOption.name}
                        {templateOption.threatLevel != null ? ` (TL ${templateOption.threatLevel})` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field combat-team-count-field">
                  <span>Count</span>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={entry.count}
                    onChange={(event) => onUpdate(index, { count: event.target.value })}
                  />
                </label>
                <div className="combat-team-entry-tools">
                  <button
                    className="secondary-button panel-header-button"
                    type="button"
                    onClick={() => onEdit(index)}
                  >
                    Edit
                  </button>
                  <CombatCoverageChip coverage={coverage} />
                </div>
                <button
                  className="icon-button combat-team-remove"
                  type="button"
                  aria-label={`Remove ${title} creature ${index + 1}`}
                  onClick={() => onRemove(index)}
                  disabled={team.length <= 1}
                >
                  <TrashIcon />
                </button>
                <div className="combat-team-stat-preview">
                  {COMBAT_SIM_STAT_FIELDS.filter((field) => field.key !== "movement").map((field) => (
                    <span key={field.key}>
                      {field.label} {displaySimValue(effectiveSimStatValue(template, overrides, field.key))}
                    </span>
                  ))}
                  <span>Init {displaySimValue(effectiveSimInitiativeValue(template, overrides))}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

function CombatCoverageChip({ coverage }) {
  if (!coverage?.total) return null;
  const parts = [];
  if (coverage.error) parts.push(`${coverage.error} error`);
  if (coverage.warning) parts.push(`${coverage.warning} warning`);
  if (coverage.manual) parts.push(`${coverage.manual} manual`);
  if (!parts.length) return null;
  const tone = coverage.error ? "error" : coverage.warning ? "warning" : "manual";
  return (
    <span className={`combat-coverage-chip combat-coverage-${tone}`} title={`${coverage.full || 0}/${coverage.total} fully simulated`}>
      {parts.join(" | ")}
    </span>
  );
}

const PLAYTEST_STATUSES = ["To_Design", "Untested", "Simulated", "Playtested", "Retest_Needed"];
const SIM_AUTO_PROMOTE_STATUSES = new Set(["Untested", "Retest_Needed"]);
const EDIT_AUTO_RETEST_STATUSES = new Set(["Simulated", "Playtested"]);
const SIM_PROMOTION_MAX_NON_DRAW_WIN_SHARE = 0.65;
const SIM_PROMOTION_PRECISION_TARGET_PERCENT = 5;
const CREATURE_SIZES = ["Tiny", "Small", "Medium", "Large", "Huge", "Gargantuan"];

function normalizePlaytestStatus(status) {
  const text = String(status ?? "").trim();
  if (!text) return "";
  const key = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const alias = {
    todesign: "To_Design",
    to_design: "To_Design",
    untested: "Untested",
    simulated: "Simulated",
    playtested: "Playtested",
    retestneeded: "Retest_Needed",
    retest_needed: "Retest_Needed",
  }[key];
  return alias || text;
}

function playtestStatusClass(status) {
  switch (normalizePlaytestStatus(status)) {
    case "To_Design": return "playtest-to-design";
    case "Untested": return "playtest-untested";
    case "Simulated": return "playtest-simulated";
    case "Playtested": return "playtest-tested";
    case "Retest_Needed": return "playtest-retest";
    default: return "playtest-none";
  }
}

function playtestStatusLabel(status) {
  const normalized = normalizePlaytestStatus(status);
  if (!normalized) return "No status";
  return normalized.replace(/_/g, " ");
}

function CombatSimEntryEditorModal({ teamLabel, entry, template, overrides, onClose, onUpdateOverrides, onSaveOverrides, saveBusy }) {
  if (!entry || !template) return null;
  const [activeTab, setActiveTab] = useState("stats");
  const statOverrides = overrides?.statOverrides || {};
  const skillOverrides = overrides?.skillOverrides || {};
  const actionOverrides = overrides?.actionOverrides || {};
  const infoOverrides = overrides?.infoOverrides || {};
  const actions = getEffectiveSimActions(template, overrides);
  const coverage = summarizeCombatCoverage(actions);
  const savePayload = buildCombatOverridesPayload(overrides, template);

  const effectivePlaytestStatus = normalizePlaytestStatus(infoOverrides.playtestStatus ?? template.playtestStatus);

  function updateStatOverride(key, value) {
    onUpdateOverrides((current) => {
      const nextStats = { ...(current.statOverrides || {}) };
      if (value === "") delete nextStats[key];
      else nextStats[key] = value;
      return { ...current, statOverrides: nextStats };
    });
  }

  function updateSkillOverride(key, value) {
    onUpdateOverrides((current) => {
      const nextSkills = { ...(current.skillOverrides || {}) };
      if (value === "") delete nextSkills[key];
      else nextSkills[key] = value;
      return { ...current, skillOverrides: nextSkills };
    });
  }

  function updateActionOverride(result, value) {
    onUpdateOverrides((current) => ({
      ...current,
      actionOverrides: { ...(current.actionOverrides || {}), [result]: value },
    }));
  }

  function resetActionOverride(result) {
    onUpdateOverrides((current) => {
      const nextActions = { ...(current.actionOverrides || {}) };
      delete nextActions[result];
      return { ...current, actionOverrides: nextActions };
    });
  }

  function updateInfoOverride(key, value) {
    onUpdateOverrides((current) => ({
      ...current,
      infoOverrides: { ...(current.infoOverrides || {}), [key]: value },
    }));
  }

  return (
    <ModalShell
      open
      title={`${teamLabel}: ${template.name}`}
      subtitle={`Stat/skill/action overrides are temporary. Info & lore edits save directly to Excel.`}
      onClose={onClose}
      size="wide"
      className="combat-sim-editor-modal"
    >
      <div className="combat-sim-editor">
        <div className="combat-editor-header">
          <div className="combat-editor-title-row">
            <span className="pill pill-muted">{template.id}</span>
            <CombatCoverageChip coverage={coverage} />
            {effectivePlaytestStatus ? (
              <span className={`pill pill-muted playtest-status-pill ${playtestStatusClass(effectivePlaytestStatus)}`}>
                <span className="playtest-dot" />
                {playtestStatusLabel(effectivePlaytestStatus)}
              </span>
            ) : null}
          </div>
          <button className="secondary-button panel-header-button" type="button" onClick={() => onUpdateOverrides(() => ({}))}>
            Reset all
          </button>
        </div>

        <div className="combat-editor-tabs">
          <button
            className={`combat-editor-tab ${activeTab === "stats" ? "active" : ""}`}
            type="button"
            onClick={() => setActiveTab("stats")}
          >
            Stats &amp; Actions
          </button>
          <button
            className={`combat-editor-tab ${activeTab === "lore" ? "active" : ""}`}
            type="button"
            onClick={() => setActiveTab("lore")}
          >
            Lore &amp; Info
          </button>
        </div>

        {activeTab === "stats" ? (
          <div className="combat-editor-grid">
            <div className="combat-editor-side">
              <section className="combat-editor-section">
                <div className="selected-draw-label">Stats</div>
                <div className="combat-stat-editor-grid">
                  {COMBAT_SIM_STAT_FIELDS.map((field) => (
                    <label className="field" key={field.key}>
                      <span>{field.label}</span>
                      <input
                        type="number"
                        min={field.min}
                        value={statOverrides[field.key] ?? ""}
                        placeholder={String(displaySimValue(sourceSimStatValue(template, field.key)))}
                        onChange={(event) => updateStatOverride(field.key, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </section>

              <section className="combat-editor-section">
                <div className="selected-draw-label">Skills</div>
                <div className="combat-stat-editor-grid">
                  {COMBAT_SIM_SKILL_FIELDS.map((field) => (
                    <label className="field" key={field.key}>
                      <span>
                        {field.label}
                        {field.note ? <small> {field.note}</small> : null}
                      </span>
                      <input
                        type="number"
                        min="0"
                        value={skillOverrides[field.key] ?? ""}
                        placeholder={String(displaySimValue(sourceSimSkillValue(template, field.key)))}
                        onChange={(event) => updateSkillOverride(field.key, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </section>
            </div>

            <section className="combat-editor-section combat-action-editor-section">
              <div className="selected-draw-label">Actions</div>
              <div className="combat-action-editor-list">
                {actions.map((action) => {
                  const sourceText = getSourceActionText(template, action.result);
                  const isOverridden = Object.prototype.hasOwnProperty.call(actionOverrides, action.result);
                  const status = action.coverageStatus || action.coverage?.status || "full";
                  return (
                    <div className={`combat-action-editor-card combat-coverage-${status}`} key={action.result}>
                      <div className="combat-action-editor-head">
                        <div>
                          <strong>{action.result}</strong>
                          <span>{action.title}</span>
                        </div>
                        <button
                          className="secondary-button panel-header-button"
                          type="button"
                          disabled={!isOverridden}
                          onClick={() => resetActionOverride(action.result)}
                        >
                          Reset
                        </button>
                      </div>
                      <textarea
                        aria-label={`${action.result} action text`}
                        value={isOverridden ? actionOverrides[action.result] : sourceText}
                        onChange={(event) => updateActionOverride(action.result, event.target.value)}
                        rows={2}
                      />
                      <div className="combat-action-parse-preview">
                        <span className={`combat-coverage-dot combat-coverage-${status}`}>{combatCoverageLabel(status)}</span>
                        <span>
                          {action.effects?.length ? action.effects.map(formatCombatEffect).join(" + ") : "No automatic effects"}
                        </span>
                        {action.manualNotes?.length ? <span>Manual: {action.manualNotes.join("; ")}</span> : null}
                      </div>
                    </div>
                  );
                })}
                {!actions.length ? <div className="subtle-copy">No action cards available.</div> : null}
              </div>
            </section>
          </div>
        ) : (
          <div className="combat-lore-editor">
            <label className="field">
              <span>Playtest Status</span>
              <select
                value={effectivePlaytestStatus}
                onChange={(e) => updateInfoOverride("playtestStatus", e.target.value)}
              >
                <option value="">— No status —</option>
                {PLAYTEST_STATUSES.map((s) => (
                  <option key={s} value={s}>{playtestStatusLabel(s)}</option>
                ))}
              </select>
            </label>
            <div className="combat-lore-row">
              <label className="field">
                <span>Short Flavour</span>
                <input
                  type="text"
                  value={infoOverrides.shortFlavour ?? template.shortFlavour ?? ""}
                  placeholder="—"
                  onChange={(e) => updateInfoOverride("shortFlavour", e.target.value)}
                />
              </label>
              <label className="field">
                <span>Size</span>
                <select
                  value={infoOverrides.size ?? template.size ?? ""}
                  onChange={(e) => updateInfoOverride("size", e.target.value)}
                >
                  <option value="">—</option>
                  {CREATURE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Traits</span>
                <input
                  type="text"
                  value={infoOverrides.traits ?? template.traits ?? ""}
                  placeholder="—"
                  onChange={(e) => updateInfoOverride("traits", e.target.value)}
                />
              </label>
            </div>
            <label className="field combat-lore-note-field">
              <span>Lore Note</span>
              <textarea
                rows={6}
                value={infoOverrides.loreNote ?? template.loreNote ?? ""}
                placeholder="—"
                onChange={(e) => updateInfoOverride("loreNote", e.target.value)}
              />
            </label>
          </div>
        )}

        <div className="modal-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={onSaveOverrides}
            disabled={!savePayload || saveBusy}
          >
            {saveBusy ? "Saving..." : "Save to Excel"}
          </button>
          <button className="primary-button" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function CombatSimBatchSummary({ result }) {
  const summary = result.summary || {};
  const wins = summary.wins || {};
  const winRates = summary.winRates || {};
  const averages = summary.teamAverages || {};
  const precision = summary.precision || {};
  return (
    <Panel title="Batch Summary" detail={`Runs ${result.runs}, seed ${result.seed}`}>
      <div className="combat-sim-metrics">
        <MetricCard label="Team A wins" value={`${outcomeValue(wins, "A")} (${formatPercent(outcomeValue(winRates, "A"))})`} />
        <MetricCard label="Team B wins" value={`${outcomeValue(wins, "B")} (${formatPercent(outcomeValue(winRates, "B"))})`} />
        <MetricCard label="Draw result" value={`${outcomeValue(wins, "draw")} (${formatPercent(outcomeValue(winRates, "draw"))})`} />
        <MetricCard label="Avg rounds" value={formatAverage(summary.avgRounds)} />
        <MetricCard label="Avg turns" value={formatAverage(summary.avgTurns)} />
        <MetricCard label="Avg attacks" value={formatAverage(summary.avgAttackActions)} />
        <MetricCard label="Winner T left" value={summary.avgWinnerRemainingToughness == null ? "-" : formatAverage(summary.avgWinnerRemainingToughness)} />
      </div>
      <CombatSimPrecisionSummary precision={precision} />
      <CombatSimCoverageSummary summary={result.lastCombat?.coverageSummary} />
      <div className="combat-batch-team-grid">
        {["A", "B"].map((team) => (
          <div className="combat-batch-team" key={team}>
            <div className="selected-draw-label">Team {team} averages</div>
            <div className="loot-grid">
              <LootBlock label="Damage" value={formatAverage(averages[team]?.damageDealt)} />
              <LootBlock label="Prevented" value={formatAverage(averages[team]?.damagePrevented)} />
              <LootBlock label="Lost" value={formatAverage(averages[team]?.unitsLost)} />
              <LootBlock label="T left" value={formatAverage(averages[team]?.remainingToughness)} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function CombatSimCoverageSummary({ summary }) {
  if (!summary?.available) return null;
  const available = summary.available;
  const used = summary.used || {};
  const issueText = COMBAT_SIM_COVERAGE_KEYS
    .filter((key) => key !== "full" && ((available[key] || 0) > 0 || (used[key] || 0) > 0))
    .map((key) => `${available[key] || 0} ${key}`)
    .join(" | ");
  return (
    <div className="combat-sim-coverage-summary">
      <span>
        Simulation coverage: {available.full || 0}/{available.total || 0} available actions fully simulated
      </span>
      <span>{used.total ? `${used.full || 0}/${used.total} used this combat fully simulated` : "No actions used yet"}</span>
      {issueText ? <span>{issueText}</span> : null}
    </div>
  );
}

function CombatSimPrecisionSummary({ precision }) {
  const target = precision.targetRerunFluctuation;
  const outcomes = precision.outcomes || {};
  const rerunEstimate = precision.adjustedRerunFluctuation95 ?? precision.observedRerunFluctuation95 ?? precision.worstCaseRerunFluctuation95;
  return (
    <div className="combat-precision-panel">
      <div className="combat-precision-header">
        <div>
          <div className="selected-draw-label">Batch precision</div>
          <div className="combat-precision-title">{precision.verdict || "Fixed runs"}</div>
        </div>
        <span className={`pill ${precision.targetMet ? "pill-turn" : "pill-muted"}`}>
          95% rerun +/- {formatPercent(rerunEstimate)}
        </span>
      </div>
      <div className="combat-sim-metrics combat-precision-metrics">
        <MetricCard label="Target" value={target == null ? "Fixed" : `+/- ${formatPercent(target)}`} />
        <MetricCard label="Run cap" value={precision.runCap ?? "-"} />
        <MetricCard label="Needed" value={precision.observedRequiredRunsForTarget ?? precision.requiredRunsForTarget ?? "-"} />
        <MetricCard label="Worst needed" value={precision.worstCaseRequiredRunsForTarget ?? "-"} />
        <MetricCard label="Worst-case now" value={formatPercent(precision.worstCaseRerunFluctuation95)} />
      </div>
      <div className="combat-precision-outcomes">
        {["A", "B", "draw"].map((key) => {
          const stats = outcomes[key];
          if (!stats) {
            return null;
          }
          const label = key === "draw" ? "Draw" : `Team ${key}`;
          return (
            <div className="combat-precision-row" key={key}>
              <strong>{label}</strong>
              <span>WR {formatPercent(stats.rate)}</span>
              <span>CI {formatPercent(stats.ciLow)}-{formatPercent(stats.ciHigh)}</span>
              <span>Std {formatPercent(stats.std)}</span>
              <span>Rerun +/- {formatPercent(stats.rerunFluctuation95)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CombatSimDetails({ result, mode, turnIndex, currentTurn, visibleUnits, onNextTurn, onResetTurn }) {
  const isTurnMode = mode === "turn";
  const atEnd = turnIndex >= (result.timeline?.length || 0);
  const logEntries = isTurnMode && currentTurn ? currentTurn.log : result.combatLog || [];
  return (
    <div className="combat-sim-results">
      <Panel title={isTurnMode ? "Turn Playback" : "Result"} detail={`Seed ${result.seed}`}>
        <div className="combat-sim-metrics">
          <MetricCard label="Winner" value={result.winner === "draw" ? "Draw" : `Team ${result.winner}`} />
          <MetricCard label="Rounds" value={result.rounds} />
          <MetricCard label="Turns" value={result.turns} />
          <MetricCard label="Attack actions" value={result.attackActions} />
        </div>
        <CombatSimCoverageSummary summary={result.coverageSummary} />
        {isTurnMode ? (
          <div className="combat-turn-controls">
            <button className="primary-button" type="button" onClick={onNextTurn} disabled={atEnd}>
              Next Turn
            </button>
            <button className="secondary-button" type="button" onClick={onResetTurn} disabled={turnIndex === 0}>
              Reset
            </button>
            <span className="pill pill-muted">
              {turnIndex === 0 ? "Initial state" : `Turn ${turnIndex}/${result.timeline.length}`}
            </span>
            {currentTurn ? <span className="pill pill-turn">{currentTurn.actorName}</span> : null}
          </div>
        ) : null}
      </Panel>

      {!isTurnMode ? (
        <div className="combat-unit-grid">
          <CombatSimUnitTable title="Initial Team A" units={(result.initialUnits || []).filter((unit) => unit.team === "A")} />
          <CombatSimUnitTable title="Initial Team B" units={(result.initialUnits || []).filter((unit) => unit.team === "B")} />
        </div>
      ) : null}

      <div className="combat-unit-grid">
        <CombatSimUnitTable
          title={isTurnMode ? "Team A" : "Final Team A"}
          units={(visibleUnits || []).filter((unit) => unit.team === "A")}
          activeActorId={currentTurn?.actorId}
        />
        <CombatSimUnitTable
          title={isTurnMode ? "Team B" : "Final Team B"}
          units={(visibleUnits || []).filter((unit) => unit.team === "B")}
          activeActorId={currentTurn?.actorId}
        />
      </div>

      <Panel title={isTurnMode ? "Turn Log" : "Combat Log"}>
        <CombatSimLog entries={logEntries} />
      </Panel>
    </div>
  );
}

function CombatSimUnitTable({ title, units, activeActorId = null }) {
  return (
    <Panel title={title}>
      <div className="combat-unit-list">
        {units.map((unit) => (
          <div
            className={`combat-unit-row ${unit.isDown ? "combat-unit-down" : ""} ${activeActorId === unit.id ? "combat-unit-active" : ""}`.trim()}
            key={unit.id}
          >
            <div className="combat-unit-main">
              {unit.imageUrl ? <img className="combat-unit-image" src={unit.imageUrl} alt="" aria-hidden="true" /> : null}
              <div>
                <div className="combat-unit-name">{unit.name}</div>
                <div className="initiative-meta">
                  {unit.templateId}
                  {unit.threatLevel != null ? ` | TL ${unit.threatLevel}` : ""}
                </div>
              </div>
            </div>
            <div className="combat-unit-stats">
              <span>T {unit.toughnessCurrent}/{unit.toughnessMax}</span>
              <span>AR {unit.armorCurrent}/{unit.armorMax}</span>
              <span>MAR {unit.magicArmorCurrent}/{unit.magicArmorMax}</span>
              <span>G {unit.guardCurrent}/{unit.guardBase}</span>
              <span>Draw {unit.draw}</span>
              <span>{unit.initiativeText}</span>
            </div>
            <div className="combat-unit-footer">
              <span>{unit.statusText || "-"}</span>
              <span>
                Deck {unit.deckCounts?.draw ?? 0} | Hand {unit.deckCounts?.hand ?? 0} | Discard {unit.deckCounts?.discard ?? 0}
              </span>
            </div>
            {unit.grappledBy?.length || unit.grappling?.length ? (
              <div className="combat-unit-draw">
                {(unit.grappledBy || []).map((grapple) => (
                  <span key={`grappled-${grapple.id}`}>{`Grappled T ${grapple.toughnessCurrent}/${grapple.toughnessMax}`}</span>
                ))}
                {(unit.grappling || []).map((grapple) => (
                  <span key={`grappling-${grapple.id}`}>{`Grappling T ${grapple.toughnessCurrent}/${grapple.toughnessMax}`}</span>
                ))}
              </div>
            ) : null}
            {unit.currentDraw?.length ? (
              <div className="combat-unit-draw">
                {unit.currentDraw.map((item, index) => (
                  <span key={`${item}-${index}`}>{item}</span>
                ))}
              </div>
            ) : null}
            <ProgressBar label="Toughness" value={percent(unit.toughnessCurrent, unit.toughnessMax)} compact />
          </div>
        ))}
        {!units.length ? <div className="subtle-copy">No units.</div> : null}
      </div>
    </Panel>
  );
}

function CombatSimLog({ entries }) {
  return (
    <div className="log-list combat-sim-log">
      {entries?.length ? (
        entries.map((entry, index) => (
          <div className="log-entry" key={`${entry}-${index}`}>
            {entry}
          </div>
        ))
      ) : (
        <div className="subtle-copy">No log entries.</div>
      )}
    </div>
  );
}

function formatPercent(value) {
  return `${((Number(value) || 0) * 100).toFixed(1)}%`;
}

function formatAverage(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toFixed(1);
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
  grapples = [],
  actionTargeting = null,
  highlightedRoomId = null,
  drawPulse,
  busy,
  canUseMove,
  canUseMapWalk,
  canUseWalk,
  canUsePartyWalk,
  onSelect,
  onSelectionChange,
  onGroupMove,
  onMoveToCell,
  onTileEdit,
  onWallEdit,
  onSetPlayerSpawn,
  onSecretDoorClick,
  onActionTarget,
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
        grapples={grapples}
        actionTargeting={actionTargeting}
        highlightedRoomId={highlightedRoomId}
        drawPulse={drawPulse}
        busy={busy}
        canUseMove={canUseMove}
        canUseMapWalk={canUseMapWalk}
        canUseWalk={canUseWalk}
        canUsePartyWalk={canUsePartyWalk}
        onSelect={onSelect}
        onSelectionChange={onSelectionChange}
        onGroupMove={onGroupMove}
        onMoveToCell={onMoveToCell}
        onTileEdit={onTileEdit}
        onWallEdit={onWallEdit}
        onSetPlayerSpawn={onSetPlayerSpawn}
        onSecretDoorClick={onSecretDoorClick}
        onActionTarget={onActionTarget}
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
      <DrawCardView
        entityName={reveal.entityName}
        items={reveal.items}
        groups={reveal.groups || []}
        kind={reveal.kind}
        showEnergies={reveal.showEnergies !== false}
      />
    </aside>
  );
}

function DrawCardView({ entityName, items, groups = [], kind = "draw", showEnergies = true }) {
  const title =
    kind === "redraw"
      ? "Redraw"
      : kind === "previous draw"
        ? "Previous draw"
        : kind === "hit draw"
          ? "Hit draw"
          : "Current draw";
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
      <DrawGroupsList groups={visibleGroups} showEnergies={showEnergies} />
    </div>
  );
}

function DrawSummary({ summary, showEnergies = true }) {
  if (!summary) {
    return null;
  }
  const outcomes = summary.outcomes || {};
  const energies = summary.energies || {};
  const outcomeItems = ["success", "fate", "fail"].map((key) => [key, Number(outcomes[key] || 0)]);
  const energyItems = Object.entries(energies).filter(([, value]) => Number(value) > 0);
  const hasOutcomes = outcomeItems.some(([, value]) => value > 0);
  const hasEnergies = showEnergies && energyItems.length > 0;
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

function DrawGroupsList({ groups, compact = false, onCardClick = null, showEnergies = true }) {
  return (
    <div className={`draw-groups ${compact ? "draw-groups-compact" : ""}`.trim()}>
      {groups.map((group, index) => (
        <div className="draw-group" key={`${group.label}-${index}`}>
          {groups.length > 1 || group.summary ? (
            <div className="draw-group-header">
              {groups.length > 1 ? <div className="draw-group-label">{group.label}</div> : null}
              <DrawSummary summary={group.summary} showEnergies={showEnergies} />
            </div>
          ) : null}
          <CardList items={group.items} compact={compact} onCardClick={onCardClick} />
        </div>
      ))}
    </div>
  );
}

function CardList({ items, compact = false, onCardClick = null }) {
  const cardText = (item) => (typeof item === "string" ? item : item?.label || "");
  const cardDetail = (item) => (typeof item === "string" ? "" : item?.detail || "");
  const renderContent = (item) => {
    const detail = cardDetail(item);
    if (!detail) return cardText(item);
    return (
      <>
        <span className="draw-card-detail">{detail}</span>
        <span className="draw-card-main">{cardText(item)}</span>
      </>
    );
  };
  return (
    <div className={`card-list ${compact ? "card-list-compact" : ""}`}>
      {items.map((item, index) =>
        onCardClick ? (
          <button
            type="button"
            className={`draw-card ${compact ? "draw-card-compact" : ""}`.trim()}
            key={`${cardText(item)}-${cardDetail(item)}-${index}`}
            onClick={onCardClick}
            aria-label={`Open draw card detail: ${cardText(item)}`}
          >
            {renderContent(item)}
          </button>
        ) : (
          <div className={`draw-card ${compact ? "draw-card-compact" : ""}`.trim()} key={`${cardText(item)}-${cardDetail(item)}-${index}`}>
            {renderContent(item)}
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

function LootSummary({ loot }) {
  const normalized = normalizeLootPayload(loot);
  return (
    <div className="loot-grid">
      <LootBlock label="Currency" value={lootPairsText(normalized.currency) || "-"} />
      <LootBlock label="Resources" value={lootPairsText(normalized.resources) || "-"} />
      <LootBlock label="Other" value={normalized.other.join(", ") || "-"} />
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
