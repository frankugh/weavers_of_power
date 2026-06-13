import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import { MAP_GRID_GAP, MAP_VIEWPORT_PADDING, MAP_ZOOM, cellToWorld, mapStep } from "./mapGeometry.js";

function jsonResponse(payload, init = {}) {
  return Promise.resolve({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => payload,
  });
}

function buildEnemy(overrides = {}) {
  return {
    instance_id: "enemy-1",
    template_id: "goblin",
    name: "Goblin 1",
    image_url: "/images/Greenskins/goblin.png",
    is_player: false,
    is_down: false,
    hp_current: 10,
    hp_max: 12,
    armor_current: 1,
    armor_max: 1,
    magic_armor_current: 0,
    magic_armor_max: 0,
    guard_current: 0,
    draws_base: 1,
    power_base: 1,
    effective_movement: 6,
    statuses: {},
    status_text: "-",
    current_draw_text: [],
    current_draw_groups: [],
    current_draw_attacks: [],
    quick_attack_used: false,
    power_draw_used: false,
    draw_bonus_pending: 0,
    draw_bonus_next_turn: 0,
    physical_cards: false,
    physical_wounds: 0,
    is_ko: false,
    wound_counts: null,
    last_draw_text: [],
    loot_rolled: false,
    rolled_loot: {},
    loot_taken_by: null,
    loot_taken_by_name: null,
    loot_state: "uninspected",
    inventory: { currency: {}, resources: {}, other: [] },
    grid_x: 4,
    grid_y: 3,
    ...overrides,
  };
}

function buildSnapshot(overrides = {}) {
  const baseEnemy = buildEnemy();

  return {
    sid: "sid-123",
    round: 1,
    selectedId: "enemy-1",
    activeTurnId: null,
    turnInProgress: false,
    order: ["enemy-1"],
    enemies: [baseEnemy],
    room: { columns: 10, rows: 7 },
    combatLog: ["Goblin 1 is up next"],
    canUndo: false,
    undoDepth: 0,
    canRedo: false,
    redoDepth: 0,
    ...overrides,
  };
}

function buildDungeon(overrides = {}) {
  return {
    tiles: {
      "0,0": { tile_type: "floor", door_open: false },
      "1,0": { tile_type: "floor", door_open: false },
      "0,1": { tile_type: "floor", door_open: false },
      "1,1": { tile_type: "floor", door_open: false },
    },
    rooms: [{ room_id: "room-1", cells: [[0, 0], [1, 0], [0, 1], [1, 1]] }],
    revealedRoomIds: ["room-1"],
    pendingEncounterRoomIds: [],
    fogOfWarEnabled: false,
    currentPcRoomIds: [],
    visibleRoomIds: ["room-1"],
    issues: [],
    analysisVersion: 1,
    renderVersion: 1,
    walls: {},
    linkedDoors: {},
    extents: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 2, height: 2 },
    ...overrides,
  };
}

function buildMovementState(overrides = {}) {
  return {
    entityId: "enemy-1",
    movementUsed: 0,
    diagonalStepsUsed: 0,
    dashUsed: false,
    movementStopped: false,
    baseMovement: 6,
    maxMovement: 6,
    remainingMovement: 6,
    ...overrides,
  };
}

const metaPayload = {
  enemyTemplates: [
    {
      id: "goblin",
      name: "Goblin",
      imageUrl: "/images/Greenskins/goblin.png",
      category: "Greenskins",
      threatLevel: 1,
      skills: { intelligence: 1, alertness: 3, stealth: 2, social: 0, arcana: 0, athletics: 1 },
      simStats: {
        toughness: { min: 6, max: 6, value: 6 },
        armor: { min: 1, max: 1, value: 1 },
        magicArmor: { min: 0, max: 0, value: 0 },
        baseGuard: { min: 0, max: 0, value: 0 },
        power: 1,
        movement: 6,
        initiativeModifier: 3,
        threatLevel: 1,
      },
      simActions: [
        {
          id: "goblin_a1",
          result: "A1",
          title: "Stab",
          text: "Stab - Attack 2",
          weight: 1,
          reshuffle: false,
          effects: [{ type: "attack", amount: 2, modifiers: [] }],
          manualNotes: [],
          coverageStatus: "full",
          coverage: { status: "full", label: "Fully simulated", notes: [] },
        },
        {
          id: "goblin_s",
          result: "S",
          title: "Skitter",
          text: "Skitter - Move target 2",
          weight: 1,
          reshuffle: false,
          effects: [],
          manualNotes: ["Move target 2"],
          coverageStatus: "manual",
          coverage: { status: "manual", label: "Manual/ignored", notes: ["Move target 2"] },
        },
      ],
    },
    {
      id: "bandit",
      name: "Bandit",
      imageUrl: "/images/Outlaws/bandit.png",
      category: "Outlaws",
      threatLevel: 2,
      skills: { intelligence: 1, alertness: 2, stealth: 1, social: 1, arcana: 0, athletics: 2 },
      simStats: {
        toughness: { min: 7, max: 7, value: 7 },
        armor: { min: 1, max: 1, value: 1 },
        magicArmor: { min: 0, max: 0, value: 0 },
        baseGuard: { min: 0, max: 0, value: 0 },
        power: 1,
        movement: 6,
        initiativeModifier: 2,
        threatLevel: 2,
      },
      simActions: [
        {
          id: "bandit_a1",
          result: "A1",
          title: "Slash",
          text: "Slash - Attack 3",
          weight: 1,
          reshuffle: false,
          effects: [{ type: "attack", amount: 3, modifiers: [] }],
          manualNotes: [],
          coverageStatus: "full",
          coverage: { status: "full", label: "Fully simulated", notes: [] },
        },
      ],
    },
    { id: "guard", name: "Guard", imageUrl: "/images/Realms_and_order/guard.png", category: "Realms_and_order" },
    { id: "soldier", name: "Soldier", imageUrl: "/images/Realms_and_order/soldier.png", category: "Realms_and_order" },
    { id: "wraith", name: "Wraith", imageUrl: "/images/anonymous.png", category: "Uncategorized" },
  ],
  decks: [{ id: "basic", name: "Basic Deck" }],
  playerDecks: [
    { id: "human_fighter_lvl1", name: "Human Fighter Level 1" },
    { id: "human_wizzard_lvl1", name: "Human Wizard Level 1" },
  ],
};

const characterCatalogPayload = {
  energyTypes: ["Martial", "Elemental", "Light", "Nature", "Shadow"],
  defaultStats: {
    toughness: 3,
    armor: 1,
    magicArmor: 0,
    power: 4,
    movement: 6,
    baseGuard: 1,
    initiativeModifier: 2,
  },
  classes: [
    {
      id: "fighter",
      name: "Fighter",
      requiredEnergyTypes: ["Martial"],
      choiceRule: "anyTwo",
      mainArtOptions: ["Martial"],
      statOverrides: { toughness: 4 },
      card: { name: "Fighter's Resolve", text: "Choose one:\n- Draw 1 card.", autoDraw: 0 },
      gearPresets: [{ id: "melee", name: "Melee", items: ["basic weapon", "shield"] }],
    },
    {
      id: "cleric",
      name: "Cleric",
      requiredEnergyTypes: ["Martial", "Light"],
      choiceRule: "anyOne",
      mainArtOptions: ["Light"],
      forbiddenEnergyTypes: ["Shadow"],
      card: { name: "Light Channeled", text: "Choose one:\n- Draw 1 card.", autoDraw: 0 },
      gearPresets: [{ id: "default", name: "Recommended", items: ["mace", "shield"] }],
    },
  ],
  ancestries: [
    { id: "human", name: "Human", card: { name: "Human Ancestry", text: "Draw 2 cards.", autoDraw: 2 } },
    {
      id: "halfling",
      name: "Halfling",
      card: {
        name: "Halfling Ancestry",
        text: "Draw 1 card. You may Disengage without spending an action this turn.",
        autoDraw: 1,
      },
    },
  ],
  characterArt: {
    anonymous: {
      source: "anonymous",
      imagePath: "anonymous.png",
      imageUrl: "/images/anonymous.png",
      label: "Anonymous",
    },
    options: [
      {
        id: "fighter_human_male",
        classId: "fighter",
        ancestryId: "human",
        gender: "male",
        variant: "",
        source: "catalog",
        imagePath: "Playing_Characters/fighter_human_male.png",
        imageUrl: "/images/Playing_Characters/fighter_human_male.png",
        label: "Male",
      },
      {
        id: "fighter_human_female",
        classId: "fighter",
        ancestryId: "human",
        gender: "female",
        variant: "",
        source: "catalog",
        imagePath: "Playing_Characters/fighter_human_female.png",
        imageUrl: "/images/Playing_Characters/fighter_human_female.png",
        label: "Female",
      },
      {
        id: "cleric_human_female",
        classId: "cleric",
        ancestryId: "human",
        gender: "female",
        variant: "",
        source: "catalog",
        imagePath: "Playing_Characters/cleric_human_female.png",
        imageUrl: "/images/Playing_Characters/cleric_human_female.png",
        label: "Female",
      },
    ],
  },
};

function renderWithSnapshot(snapshot, options = {}) {
  const {
    extraFetch = () => undefined,
    meta = metaPayload,
    characterCatalog = characterCatalogPayload,
    characters = { characters: [] },
  } = options;

  window.history.pushState({}, "", `/?sid=${snapshot.sid}`);
  global.fetch.mockImplementation((url, requestOptions) => {
    if (url === "/api/battle/meta") {
      return jsonResponse(meta);
    }
    if (url === "/api/battle/character-builder/catalog") {
      return jsonResponse(characterCatalog);
    }
    if (url === "/api/battle/characters" && (!requestOptions?.method || requestOptions.method === "GET")) {
      return jsonResponse(characters);
    }
    if (url === `/api/battle/sessions/${snapshot.sid}`) {
      return jsonResponse(snapshot);
    }
    const response = extraFetch(url, requestOptions);
    if (response !== undefined) {
      return response;
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  return render(<App />);
}

async function findMapToken(name) {
  const matches = await screen.findAllByText(name);
  return matches[0];
}

function getMapViewport() {
  return screen.getByRole("region", { name: "Battle map viewport" });
}

function mapPointForCell(viewport, x, y) {
  const rect = viewport.getBoundingClientRect();
  const cellSize = Number(viewport.dataset.cellSize || MAP_ZOOM.defaultSize);
  const cameraX = Number(viewport.dataset.cameraX || 0);
  const cameraY = Number(viewport.dataset.cameraY || 0);
  const center = cellToWorld(x, y, cellSize);

  return {
    clientX: rect.left + cameraX + center.x,
    clientY: rect.top + cameraY + center.y,
  };
}

function mapPointForEdge(viewport, edge, options = {}) {
  const rect = viewport.getBoundingClientRect();
  const cellSize = Number(viewport.dataset.cellSize || MAP_ZOOM.defaultSize);
  const cameraX = Number(viewport.dataset.cameraX || 0);
  const cameraY = Number(viewport.dataset.cameraY || 0);
  const step = mapStep(cellSize);
  const halfGap = Math.floor(MAP_GRID_GAP / 2);
  const along = Number.isFinite(options.along) ? options.along : 0.5;
  let worldX;
  let worldY;

  if (edge.side === "e") {
    worldX = MAP_VIEWPORT_PADDING + (edge.x + 1) * step - halfGap;
    worldY = MAP_VIEWPORT_PADDING + edge.y * step + cellSize * along;
  } else {
    worldX = MAP_VIEWPORT_PADDING + edge.x * step + cellSize * along;
    worldY = MAP_VIEWPORT_PADDING + (edge.y + 1) * step - halfGap;
  }

  return {
    clientX: rect.left + cameraX + worldX + (options.dx || 0),
    clientY: rect.top + cameraY + worldY + (options.dy || 0),
  };
}

function expectedCameraForExtents(extents, cellSize = MAP_ZOOM.defaultSize) {
  const center = cellToWorld((extents.minX + extents.maxX) / 2, (extents.minY + extents.maxY) / 2, cellSize);

  return {
    x: 400 - center.x,
    y: 250 - center.y,
  };
}

function pointerClickMapCell(x, y, pointerId = 1, options = {}) {
  const viewport = getMapViewport();
  const point = mapPointForCell(viewport, x, y);
  const modifiers = {
    shiftKey: Boolean(options.shiftKey),
    ctrlKey: Boolean(options.ctrlKey),
    metaKey: Boolean(options.metaKey),
  };

  fireEvent.pointerDown(viewport, {
    pointerId,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    ...point,
    ...modifiers,
  });
  fireEvent.pointerUp(viewport, {
    pointerId,
    pointerType: "mouse",
    button: 0,
    buttons: 0,
    ...point,
    ...modifiers,
  });
}

function pointerClickMapEdge(edge, pointerId = 31) {
  const viewport = getMapViewport();
  const point = mapPointForEdge(viewport, edge);

  fireEvent.pointerDown(viewport, {
    pointerId,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    ...point,
  });
  fireEvent.pointerUp(viewport, {
    pointerId,
    pointerType: "mouse",
    button: 0,
    buttons: 0,
    ...point,
  });
}

function pointerRightClickMapCell(x, y, pointerId = 51) {
  const viewport = getMapViewport();
  const point = mapPointForCell(viewport, x, y);

  fireEvent.pointerDown(viewport, {
    pointerId,
    pointerType: "mouse",
    button: 2,
    buttons: 2,
    ...point,
  });
  fireEvent.pointerUp(viewport, {
    pointerId,
    pointerType: "mouse",
    button: 2,
    buttons: 0,
    ...point,
  });
  fireEvent.contextMenu(viewport, {
    button: 2,
    ...point,
  });
}

function pointerDoubleClickMapCell(x, y) {
  pointerClickMapCell(x, y, 61);
  pointerClickMapCell(x, y, 62);
}

function pointerDragFromCell(x, y, deltaX, deltaY, options = {}) {
  const viewport = getMapViewport();
  const point = mapPointForCell(viewport, x, y);
  const pointerId = options.pointerId || 1;
  const button = options.button ?? 0;
  const buttons = options.buttons ?? 1;

  fireEvent.pointerDown(viewport, {
    pointerId,
    pointerType: "mouse",
    button,
    buttons,
    ...point,
  });
  fireEvent.pointerMove(viewport, {
    pointerId,
    pointerType: "mouse",
    buttons,
    clientX: point.clientX + deltaX,
    clientY: point.clientY + deltaY,
  });
  fireEvent.pointerUp(viewport, {
    pointerId,
    pointerType: "mouse",
    button,
    buttons: 0,
    clientX: point.clientX + deltaX,
    clientY: point.clientY + deltaY,
  });
}

function pointerDragBetweenCells(startX, startY, endX, endY, options = {}) {
  const viewport = getMapViewport();
  const start = mapPointForCell(viewport, startX, startY);
  const end = mapPointForCell(viewport, endX, endY);
  const pointerId = options.pointerId || 1;
  const button = options.button ?? 0;
  const buttons = options.buttons ?? 1;
  const modifiers = {
    shiftKey: Boolean(options.shiftKey),
    ctrlKey: Boolean(options.ctrlKey),
    metaKey: Boolean(options.metaKey),
  };

  fireEvent.pointerDown(viewport, {
    pointerId,
    pointerType: "mouse",
    button,
    buttons,
    ...start,
    ...modifiers,
  });
  fireEvent.pointerMove(viewport, {
    pointerId,
    pointerType: "mouse",
    buttons,
    ...end,
    ...modifiers,
  });
  fireEvent.pointerUp(viewport, {
    pointerId,
    pointerType: "mouse",
    button,
    buttons: 0,
    ...end,
    ...modifiers,
  });
}

async function openAddUnitModal(user) {
  await user.click(screen.getAllByRole("button", { name: "Add unit" })[0]);
}

describe("App", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
    window.localStorage.clear();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a session when no sid is present and writes it to the URL", async () => {
    global.fetch.mockImplementation((url, requestOptions) => {
      if (url === "/api/battle/meta") {
        return jsonResponse(metaPayload);
      }
      if (url === "/api/battle/character-builder/catalog") {
        return jsonResponse(characterCatalogPayload);
      }
      if (url === "/api/battle/characters") {
        return jsonResponse({ characters: [] });
      }
      if (url === "/api/battle/sessions" && requestOptions?.method === "POST") {
        return jsonResponse(buildSnapshot());
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(<App />);

    await screen.findByText("Weave Forge");
    await screen.findByText("Round 1");

    expect(window.location.search).toContain("sid=sid-123");
  });

  it("lets the user brighten the display and stores the preference", async () => {
    renderWithSnapshot(buildSnapshot());

    await screen.findByText("Weave Forge");

    const brightnessSlider = screen.getByRole("slider", { name: "Display brightness" });
    expect(brightnessSlider).toHaveValue("115");

    fireEvent.change(brightnessSlider, { target: { value: "145" } });

    expect(brightnessSlider).toHaveValue("145");
    expect(screen.getByText("145%")).toBeInTheDocument();
    expect(document.querySelector(".shell")).toHaveStyle({
      "--display-brightness": "1.45",
      "--display-brightness-lift": "0.165",
    });
    expect(window.localStorage.getItem("weavers-display-brightness")).toBe("145");
  });

  it("opens the scenario library, creates a template, and starts a run", async () => {
    const user = userEvent.setup();
    const scenarioDefinition = {
      id: "scenario_1",
      name: "API Scenario",
      startNodeId: "start",
      nodes: [
        {
          id: "start",
          type: "scene",
          label: "Start",
          position: { x: 100, y: 100 },
          defaultPhaseId: "phase_default",
          phases: [{ id: "phase_default", label: "Default", text: "Opening text" }],
        },
      ],
      edges: [],
    };
    const attachedSnapshot = buildSnapshot({
      scenario: {
        definition: scenarioDefinition,
        runtime: {
          scenarioId: "scenario_1",
          currentNodeId: "start",
          visitedNodeIds: ["start"],
          nodeStates: {
            start: {
              phaseId: "phase_default",
              visitCount: 1,
              resolvedEventIds: [],
              flags: {},
              encounterOutcome: null,
              mapInstanceId: null,
            },
          },
          activeMapNodeId: null,
          sourceScenarioId: "scenario_1",
          sourceScenarioName: "API Scenario",
        },
        scenarioRun: {
          active: true,
          sourceScenarioId: "scenario_1",
          sourceScenarioName: "API Scenario",
          sourceTemplateMissing: false,
          currentNodeId: "start",
        },
      },
      scenarioRun: {
        active: true,
        sourceScenarioId: "scenario_1",
        sourceScenarioName: "API Scenario",
        sourceTemplateMissing: false,
        currentNodeId: "start",
      },
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/scenarios" && (!requestOptions?.method || requestOptions.method === "GET")) {
          return jsonResponse({ scenarios: [] });
        }
        if (url === "/api/map-templates" && (!requestOptions?.method || requestOptions.method === "GET")) {
          return jsonResponse({ templates: [] });
        }
        if (url === "/api/scenarios" && requestOptions?.method === "POST") {
          return jsonResponse({
            scenario: scenarioDefinition,
            scenarios: [{ id: "scenario_1", name: "API Scenario", nodeCount: 1 }],
          });
        }
        if (url === "/api/battle/sessions/sid-123/scenario/start-run" && requestOptions?.method === "POST") {
          return jsonResponse(attachedSnapshot);
        }
        return undefined;
      },
    });

    await screen.findByText("Weave Forge");
    const viewSwitch = screen.getByRole("group", { name: "App view" });
    expect(within(viewSwitch).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Scenario",
      "Map",
      "Combat Sim",
    ]);
    await user.click(screen.getByRole("button", { name: "Scenario" }));

    await screen.findByText("Scenario Library");
    expect(screen.queryByText(/Attach/i)).not.toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText("Scenario name"));
    await user.type(screen.getByPlaceholderText("Scenario name"), "API Scenario");
    await user.click(screen.getByRole("button", { name: "Create Template" }));

    await screen.findByText("Edit Template");
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Run" }));

    await screen.findByText("Opening text");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/battle/sessions/sid-123/scenario/start-run",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("renders initiative add controls and keeps main panel plus roster images visible", async () => {
    const goblin = buildEnemy();
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      hp_current: 14,
      hp_max: 16,
      armor_current: 2,
      armor_max: 2,
      effective_movement: 5,
      grid_x: 5,
      grid_y: 3,
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [goblin, bandit],
      }),
    );

    await findMapToken("Goblin 1");

    expect(screen.getAllByRole("button", { name: "Add unit" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /sort/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move Goblin 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Goblin 1 down" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "Delete Goblin 1" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Move Bandit 1 up" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move Bandit 1 down" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Delete Bandit 1" }).length).toBeGreaterThan(0);
    expect(screen.getAllByAltText("Goblin 1")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Goblin 1/i }).length).toBeGreaterThan(0);
  });

  it("renders history buttons disabled when no history exists", async () => {
    renderWithSnapshot(buildSnapshot({ canUndo: false, undoDepth: 0 }));

    await findMapToken("Goblin 1");

    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it("runs a quick combat simulation from the top-level sim view", async () => {
    const user = userEvent.setup();
    const simUnitA = {
      id: "A-1",
      team: "A",
      name: "Goblin 1",
      templateId: "goblin",
      imageUrl: "/images/Greenskins/goblin.png",
      threatLevel: 1,
      toughnessCurrent: 5,
      toughnessMax: 6,
      armorCurrent: 1,
      armorMax: 1,
      magicArmorCurrent: 0,
      magicArmorMax: 0,
      guardCurrent: 0,
      guardBase: 0,
      power: 1,
      initiativeRoll: 5,
      initiativeModifier: 3,
      initiativeTotal: 8,
      initiativeText: "Init 8 (5+3)",
      statuses: {},
      statusText: "-",
      currentDraw: [],
      deckCounts: { draw: 5, hand: 0, discard: 1 },
      isDown: false,
    };
    const simUnitB = {
      ...simUnitA,
      id: "B-1",
      team: "B",
      name: "Bandit 1",
      templateId: "bandit",
      imageUrl: "/images/Outlaws/bandit.png",
      toughnessCurrent: 0,
      isDown: true,
    };
    const simResult = {
      mode: "single",
      result: {
        seed: 123,
        winner: "A",
        rounds: 1,
        turns: 2,
        attackActions: 1,
        initialUnits: [{ ...simUnitA, toughnessCurrent: 6 }, { ...simUnitB, toughnessCurrent: 6, isDown: false }],
        finalUnits: [simUnitA, simUnitB],
        timeline: [
          {
            round: 1,
            turn: 1,
            actorId: "A-1",
            actorName: "Goblin 1",
            team: "A",
            units: [simUnitA, simUnitB],
            log: ["Goblin 1 attacks Bandit 1."],
            actions: [],
          },
        ],
        combatLog: ["Goblin 1 attacks Bandit 1.", "Team A wins in round 1."],
        teamTotals: {
          A: { damageDealt: 6, damagePrevented: 1, unitsLost: 0, remainingToughness: 5, units: 1 },
          B: { damageDealt: 1, damagePrevented: 0, unitsLost: 1, remainingToughness: 0, units: 1 },
        },
      },
    };
    const requestBodies = [];
    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/combat-sim/simulate") {
          const body = JSON.parse(requestOptions.body);
          requestBodies.push(body);
          expect(body.runs).toBe(1);
          expect(body.strategyA).toBe("highest_toughness");
          return jsonResponse(simResult);
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Combat Sim" }));
    await user.click(screen.getByRole("button", { name: "Quick" }));
    await user.click(screen.getByRole("button", { name: "Quick Simulate" }));

    await screen.findByText("Team A wins in round 1.");
    expect(requestBodies[0].seed).toBeNull();
    expect(screen.getByLabelText("Fixed seed")).toHaveValue(null);
    await user.click(screen.getByRole("button", { name: "Quick Simulate" }));
    await waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1].seed).toBeNull();
    expect(screen.getAllByText("Init 8 (5+3)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Bandit 1").length).toBeGreaterThan(0);
  });

  it("shows sim stats and sends shared template stat/action/skill overrides", async () => {
    const user = userEvent.setup();
    const simResult = {
      mode: "single",
      result: {
        seed: 321,
        winner: "A",
        rounds: 1,
        turns: 1,
        attackActions: 1,
        initialUnits: [],
        finalUnits: [],
        timeline: [],
        combatLog: ["Team A wins in round 1."],
        teamTotals: {
          A: { damageDealt: 9, damagePrevented: 0, unitsLost: 0, remainingToughness: 12, units: 1 },
          B: { damageDealt: 0, damagePrevented: 0, unitsLost: 1, remainingToughness: 0, units: 1 },
        },
        coverageSummary: {
          available: { total: 2, full: 1, manual: 1, warning: 0, error: 0 },
          used: { total: 1, full: 1, manual: 0, warning: 0, error: 0 },
        },
      },
    };
    let requestBody = null;

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/combat-sim/simulate") {
          requestBody = JSON.parse(requestOptions.body);
          return jsonResponse(simResult);
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Combat Sim" }));
    await user.selectOptions(screen.getAllByLabelText("Creature")[1], "goblin");
    expect(screen.getAllByText("T 6").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Init 3").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("1 manual").length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const modal = screen.getByText("Team A: Goblin").closest(".modal-shell");
    expect(within(modal).getByDisplayValue("Stab - Attack 2")).toBeInTheDocument();
    expect(within(modal).getByLabelText(/Stealth/)).toBeInTheDocument();
    await user.type(within(modal).getByLabelText("T"), "12");
    await user.type(within(modal).getByLabelText(/Alertness/), "8");
    await user.clear(within(modal).getByLabelText("A1 action text"));
    await user.type(within(modal).getByLabelText("A1 action text"), "Mega - Attack 9 sunder 2, overwhelm, shatter");
    expect(within(modal).getByText("Attack 9 (Sunder 2, Overwhelm, Shatter)")).toBeInTheDocument();
    await user.click(within(modal).getByRole("button", { name: "Done" }));
    expect(screen.getAllByText("T 12").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Init 8").length).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole("button", { name: "Quick" }));
    await user.click(screen.getByRole("button", { name: "Quick Simulate" }));

    await screen.findByText("Team A wins in round 1.");
    expect(requestBody.teamA[0].overrides.statOverrides.toughness).toBe(12);
    expect(requestBody.teamA[0].overrides.skillOverrides.alertness).toBe(8);
    expect(requestBody.teamA[0].overrides.actionOverrides.A1).toBe("Mega - Attack 9 sunder 2, overwhelm, shatter");
    expect(requestBody.teamB[0].templateId).toBe("goblin");
    expect(requestBody.teamB[0].overrides.statOverrides.toughness).toBe(12);
    expect(requestBody.teamB[0].overrides.skillOverrides.alertness).toBe(8);
    expect(requestBody.teamB[0].overrides.actionOverrides.A1).toBe("Mega - Attack 9 sunder 2, overwhelm, shatter");
  });

  it("saves shared template overrides to Excel and clears temporary overrides", async () => {
    const user = userEvent.setup();
    const savedMeta = {
      ...metaPayload,
      enemyTemplates: metaPayload.enemyTemplates.map((template) => {
        if (template.id !== "goblin") return template;
        return {
          ...template,
          skills: { ...template.skills, alertness: 8 },
          simStats: {
            ...template.simStats,
            toughness: { min: 12, max: 12, value: 12 },
            initiativeModifier: 8,
          },
          simActions: template.simActions.map((action) =>
            action.result === "A1"
              ? {
                ...action,
                title: "Mega",
                text: "Mega - Attack 9 pierce 2",
                effects: [{ type: "attack", amount: 9, modifiers: ["pierce:2"] }],
                coverageStatus: "full",
                coverage: { status: "full", label: "Fully simulated", notes: [] },
              }
              : action,
          ),
        };
      }),
    };
    let saveBody = null;
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/creature-templates/goblin/save-overrides") {
          saveBody = JSON.parse(requestOptions.body);
          return jsonResponse({
            metadata: savedMeta,
            backupFilename: "denizens_creature_database__20260530_120000.xlsx",
          });
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Combat Sim" }));
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    let modal = screen.getByText("Team A: Goblin").closest(".modal-shell");
    expect(within(modal).getByRole("button", { name: "Save to Excel" })).toBeDisabled();

    await user.type(within(modal).getByLabelText("T"), "12");
    await user.type(within(modal).getByLabelText(/Alertness/), "8");
    await user.clear(within(modal).getByLabelText("A1 action text"));
    await user.type(within(modal).getByLabelText("A1 action text"), "Mega - Attack 9 pierce 2");
    await user.click(within(modal).getByRole("button", { name: "Save to Excel" }));

    expect(window.confirm).toHaveBeenCalledWith("Save Goblin changes to the Excel source data?");
    expect(saveBody.statOverrides.toughness).toBe(12);
    expect(saveBody.skillOverrides.alertness).toBe(8);
    expect(saveBody.actionOverrides.A1).toBe("Mega - Attack 9 pierce 2");
    expect(await screen.findByText(/Saved Goblin to Excel/)).toBeInTheDocument();
    expect(screen.getByText(/denizens_creature_database__20260530_120000.xlsx/)).toBeInTheDocument();
    expect(screen.getAllByText("T 12").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Init 8").length).toBeGreaterThan(0);

    modal = screen.getByText("Team A: Goblin").closest(".modal-shell");
    expect(within(modal).getByRole("button", { name: "Save to Excel" })).toBeDisabled();
  });

  it("shows batch draw results and observed precision needs", async () => {
    const user = userEvent.setup();
    const batchResult = {
      mode: "batch",
      result: {
        seed: 900,
        runs: 42,
        runCap: 1000,
        summary: {
          wins: { A: 1, B: 39, draw: 2 },
          winRates: { A: 1 / 42, B: 39 / 42, draw: 2 / 42 },
          avgRounds: 2,
          avgTurns: 4,
          avgAttackActions: 3,
          avgWinnerRemainingToughness: 5,
          teamAverages: {
            A: { damageDealt: 3, damagePrevented: 1, unitsLost: 1, remainingToughness: 0 },
            B: { damageDealt: 7, damagePrevented: 2, unitsLost: 0, remainingToughness: 5 },
          },
          precision: {
            verdict: "Target met",
            targetMet: true,
            targetRerunFluctuation: 0.05,
            adjustedRerunFluctuation95: 0.04,
            observedRequiredRunsForTarget: 42,
            requiredRunsForTarget: 42,
            worstCaseRequiredRunsForTarget: 769,
            worstCaseRerunFluctuation95: 0.151,
            runCap: 1000,
            outcomes: {
              A: { rate: 1 / 42, ciLow: 0.004, ciHigh: 0.12, std: 0.15, rerunFluctuation95: 0.09 },
              B: { rate: 39 / 42, ciLow: 0.8, ciHigh: 0.98, std: 0.25, rerunFluctuation95: 0.11 },
              draw: { rate: 2 / 42, ciLow: 0.01, ciHigh: 0.16, std: 0.21, rerunFluctuation95: 0.09 },
            },
          },
        },
        lastCombat: {
          seed: 941,
          winner: "B",
          rounds: 2,
          turns: 4,
          attackActions: 3,
          initialUnits: [],
          finalUnits: [],
          timeline: [],
          combatLog: ["Team B wins in round 2."],
          teamTotals: {
            A: { damageDealt: 3, damagePrevented: 1, unitsLost: 1, remainingToughness: 0, units: 1 },
            B: { damageDealt: 7, damagePrevented: 2, unitsLost: 0, remainingToughness: 5, units: 1 },
          },
          coverageSummary: {
            available: { total: 2, full: 2, manual: 0, warning: 0, error: 0 },
            used: { total: 1, full: 1, manual: 0, warning: 0, error: 0 },
          },
        },
      },
    };

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/combat-sim/simulate") {
          return jsonResponse(batchResult);
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Combat Sim" }));
    await user.click(screen.getByRole("button", { name: "Run Batch" }));

    expect(await screen.findByText("2 (4.8%)")).toBeInTheDocument();
    expect(screen.getByText("Draw result")).toBeInTheDocument();
    expect(screen.getByText("Worst needed")).toBeInTheDocument();
    expect(screen.getByText("769")).toBeInTheDocument();
  });

  it("auto-marks a qualifying untested or retest benchmark batch as simulated", async () => {
    const user = userEvent.setup();
    const benchmarkMeta = {
      ...metaPayload,
      enemyTemplates: metaPayload.enemyTemplates.map((template) =>
        template.id === "bandit"
          ? { ...template, playtestStatus: "Retest_Needed", threatLevel: 2, simStats: { ...template.simStats, threatLevel: 2 } }
          : template,
      ),
    };
    const batchResult = {
      mode: "batch",
      result: {
        seed: 777,
        runs: 400,
        runCap: 1000,
        summary: {
          wins: { A: 220, B: 180, draw: 0 },
          winRates: { A: 0.55, B: 0.45, draw: 0 },
          avgRounds: 3,
          avgTurns: 6,
          avgAttackActions: 5,
          avgWinnerRemainingToughness: 2,
          teamAverages: {
            A: { damageDealt: 5, damagePrevented: 1, unitsLost: 0.4, remainingToughness: 2 },
            B: { damageDealt: 4, damagePrevented: 1, unitsLost: 1.5, remainingToughness: 1 },
          },
          precision: {
            verdict: "Target met",
            targetMet: true,
            adjustedRerunFluctuation95: 0.04,
            requiredRunsForTarget: 400,
            observedRequiredRunsForTarget: 400,
            worstCaseRequiredRunsForTarget: 769,
            runCap: 1000,
            outcomes: {},
          },
        },
        lastCombat: {
          seed: 778,
          winner: "A",
          rounds: 3,
          turns: 6,
          attackActions: 5,
          initialUnits: [],
          finalUnits: [],
          timeline: [],
          combatLog: ["Team A wins in round 3."],
          teamTotals: {
            A: { damageDealt: 5, damagePrevented: 1, unitsLost: 0, remainingToughness: 2, units: 1 },
            B: { damageDealt: 4, damagePrevented: 1, unitsLost: 2, remainingToughness: 0, units: 2 },
          },
          coverageSummary: {
            available: { total: 2, full: 2, manual: 0, warning: 0, error: 0 },
            used: { total: 1, full: 1, manual: 0, warning: 0, error: 0 },
          },
        },
      },
    };
    let simBody = null;
    let statusSaveBody = null;

    renderWithSnapshot(buildSnapshot(), {
      meta: benchmarkMeta,
      extraFetch: (url, requestOptions) => {
        if (url === "/api/combat-sim/simulate") {
          simBody = JSON.parse(requestOptions.body);
          return jsonResponse(batchResult);
        }
        if (url === "/api/battle/creature-templates/bandit/save-overrides") {
          statusSaveBody = JSON.parse(requestOptions.body);
          return jsonResponse({
            metadata: {
              ...benchmarkMeta,
              enemyTemplates: benchmarkMeta.enemyTemplates.map((template) =>
                template.id === "bandit" ? { ...template, playtestStatus: "Simulated" } : template,
              ),
            },
          });
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Combat Sim" }));
    const creatureSelects = screen.getAllByLabelText("Creature");
    await user.selectOptions(creatureSelects[0], "bandit");
    await user.selectOptions(creatureSelects[1], "goblin");
    fireEvent.change(screen.getAllByLabelText("Count")[1], { target: { value: "2" } });
    await user.click(screen.getByRole("button", { name: "Run Batch" }));

    await screen.findByText("Team A wins in round 3.");
    expect(simBody.precisionTargetPercent).toBe(5);
    expect(simBody.teamA).toEqual([{ templateId: "bandit", count: 1 }]);
    expect(simBody.teamB).toEqual([{ templateId: "goblin", count: 2 }]);
    expect(statusSaveBody).toEqual({ infoOverrides: { playtestStatus: "Simulated" } });
  });

  it("auto-marks an uppercase Great Bear versus tier-matched normal Goblins batch as simulated", async () => {
    const user = userEvent.setup();
    const sourceGoblin = metaPayload.enemyTemplates.find((template) => template.id === "goblin");
    const sourceBandit = metaPayload.enemyTemplates.find((template) => template.id === "bandit");
    const cGoblin = {
      ...sourceGoblin,
      id: "C_GOBLIN",
      imageUrl: "/images/Changelings/Greenskins/C_GOBLIN.png",
      playtestStatus: "Simulated",
    };
    const greatBear = {
      ...sourceBandit,
      id: "C_GREAT_BEAR",
      name: "Great Bear",
      imageUrl: "/images/Changelings/Beasts_and_Predators/C_GREAT_BEAR.png",
      category: "Changelings",
      threatLevel: 4,
      playtestStatus: " untested ",
      simStats: {
        ...sourceBandit.simStats,
        toughness: { min: 17, max: 17, value: 17 },
        armor: { min: 1, max: 1, value: 1 },
        magicArmor: { min: 0, max: 0, value: 0 },
        baseGuard: { min: 1, max: 1, value: 1 },
        movement: 8,
        initiativeModifier: 4,
        threatLevel: 4,
      },
    };
    const bearMeta = {
      ...metaPayload,
      enemyTemplates: [cGoblin, greatBear],
    };
    const batchResult = {
      mode: "batch",
      result: {
        seed: 430193556,
        runs: 759,
        runCap: 1000,
        summary: {
          wins: { A: 450, B: 309, draw: 0 },
          winRates: { A: 450 / 759, B: 309 / 759, draw: 0 },
          avgRounds: 3,
          avgTurns: 7,
          avgAttackActions: 6,
          avgWinnerRemainingToughness: 2,
          teamAverages: {
            A: { damageDealt: 9, damagePrevented: 2, unitsLost: 0.4, remainingToughness: 4 },
            B: { damageDealt: 8, damagePrevented: 1, unitsLost: 2.5, remainingToughness: 2 },
          },
          precision: {
            verdict: "Target met",
            targetMet: true,
            adjustedRerunFluctuation95: 0.05,
            requiredRunsForTarget: 759,
            observedRequiredRunsForTarget: 759,
            worstCaseRequiredRunsForTarget: 1000,
            runCap: 1000,
            outcomes: {},
          },
        },
        lastCombat: {
          seed: 430193557,
          winner: "A",
          rounds: 4,
          turns: 8,
          attackActions: 7,
          initialUnits: [],
          finalUnits: [],
          timeline: [],
          combatLog: ["Team A wins in round 4."],
          teamTotals: {
            A: { damageDealt: 12, damagePrevented: 2, unitsLost: 0, remainingToughness: 5, units: 1 },
            B: { damageDealt: 8, damagePrevented: 1, unitsLost: 4, remainingToughness: 0, units: 4 },
          },
          coverageSummary: {
            available: { total: 6, full: 1, manual: 5, warning: 0, error: 0 },
            used: { total: 5, full: 1, manual: 4, warning: 0, error: 0 },
          },
        },
      },
    };
    let simBody = null;
    let statusSaveBody = null;

    renderWithSnapshot(buildSnapshot(), {
      meta: bearMeta,
      extraFetch: (url, requestOptions) => {
        if (url === "/api/combat-sim/simulate") {
          simBody = JSON.parse(requestOptions.body);
          return jsonResponse(batchResult);
        }
        if (url === "/api/battle/creature-templates/C_GREAT_BEAR/save-overrides") {
          statusSaveBody = JSON.parse(requestOptions.body);
          return jsonResponse({
            metadata: {
              ...bearMeta,
              enemyTemplates: bearMeta.enemyTemplates.map((template) =>
                template.id === "C_GREAT_BEAR" ? { ...template, playtestStatus: "Simulated" } : template,
              ),
            },
          });
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Combat Sim" }));
    const creatureSelects = screen.getAllByLabelText("Creature");
    await user.selectOptions(creatureSelects[0], "C_GREAT_BEAR");
    await user.selectOptions(creatureSelects[1], "C_GOBLIN");
    fireEvent.change(screen.getAllByLabelText("Count")[1], { target: { value: "4" } });
    await user.click(screen.getByRole("button", { name: "Run Batch" }));

    expect(await screen.findByText("Team A wins in round 4.")).toBeInTheDocument();
    expect(simBody.teamA).toEqual([{ templateId: "C_GREAT_BEAR", count: 1 }]);
    expect(simBody.teamB).toEqual([{ templateId: "C_GOBLIN", count: 4 }]);
    expect(statusSaveBody).toEqual({ infoOverrides: { playtestStatus: "Simulated" } });
    expect(await screen.findByText("Auto-marked Great Bear as Simulated.")).toBeInTheDocument();
  });

  it("marks simulated or playtested templates as retest needed when saved edits change them", async () => {
    const user = userEvent.setup();
    const playtestedMeta = {
      ...metaPayload,
      enemyTemplates: metaPayload.enemyTemplates.map((template) =>
        template.id === "goblin" ? { ...template, playtestStatus: "Playtested" } : template,
      ),
    };
    let saveBody = null;
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithSnapshot(buildSnapshot(), {
      meta: playtestedMeta,
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/creature-templates/goblin/save-overrides") {
          saveBody = JSON.parse(requestOptions.body);
          return jsonResponse({
            metadata: {
              ...playtestedMeta,
              enemyTemplates: playtestedMeta.enemyTemplates.map((template) =>
                template.id === "goblin" ? { ...template, playtestStatus: "Retest_Needed" } : template,
              ),
            },
          });
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Combat Sim" }));
    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const modal = screen.getByText("Team A: Goblin").closest(".modal-shell");
    await user.type(within(modal).getByLabelText("T"), "12");
    await user.click(within(modal).getByRole("button", { name: "Save to Excel" }));

    expect(saveBody.statOverrides.toughness).toBe(12);
    expect(saveBody.infoOverrides.playtestStatus).toBe("Retest_Needed");
  });

  it("opens save as when saving without an active slot and creates a new session save", async () => {
    const user = userEvent.setup();
    let saveBody = null;
    const activeSave = {
      filename: "night_20260607_110000.json",
      name: "Night",
      label: "Night",
      updatedAt: "2026-06-07T11:00:00+00:00",
      active: true,
    };

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/saves" && !requestOptions?.method) {
          return jsonResponse({ saves: [] });
        }
        if (url === "/api/battle/sessions/sid-123/saves" && requestOptions?.method === "POST") {
          saveBody = JSON.parse(requestOptions.body);
          return jsonResponse({
            ...buildSnapshot({ activeSave, combatLog: ["Session save created: Night"] }),
            save: activeSave,
          });
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Save Session" }));
    expect(await screen.findByText("Save session")).toBeInTheDocument();

    const nameInput = screen.getByLabelText("New save name");
    await user.clear(nameInput);
    await user.type(nameInput, "Night");
    await user.click(screen.getByRole("button", { name: "Create new save" }));

    await waitFor(() => expect(saveBody).toEqual({ name: "Night" }));
    expect(await screen.findByText("Session save created")).toBeInTheDocument();
  });

  it("saves an active slot directly from the top bar", async () => {
    const user = userEvent.setup();
    const activeSave = {
      filename: "night_20260607_110000.json",
      name: "Night",
      label: "Night",
      updatedAt: "2026-06-07T11:00:00+00:00",
      active: true,
    };
    let putCalled = false;

    renderWithSnapshot(buildSnapshot({ activeSave }), {
      extraFetch: (url, requestOptions) => {
        if (
          url === `/api/battle/sessions/sid-123/saves/${encodeURIComponent(activeSave.filename)}`
          && requestOptions?.method === "PUT"
        ) {
          putCalled = true;
          return jsonResponse({ ...buildSnapshot({ activeSave }), save: activeSave });
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Save Session" }));

    await waitFor(() => expect(putCalled).toBe(true));
    expect(screen.queryByText("Save session")).not.toBeInTheDocument();
    expect(await screen.findByText("Session saved")).toBeInTheDocument();
  });

  it("overwrites an existing session save from save as", async () => {
    const user = userEvent.setup();
    const save = {
      filename: "old_load_20260101_162506.json",
      name: "Old Load",
      label: "Old Load",
      updatedAt: "2026-01-01T16:25:06+00:00",
      active: false,
    };
    let putCalled = false;

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/saves" && !requestOptions?.method) {
          return jsonResponse({ saves: [save] });
        }
        if (
          url === `/api/battle/sessions/sid-123/saves/${encodeURIComponent(save.filename)}`
          && requestOptions?.method === "PUT"
        ) {
          putCalled = true;
          return jsonResponse({ ...buildSnapshot({ activeSave: { ...save, active: true } }), save: { ...save, active: true } });
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Save As" }));
    expect(await screen.findByText("Old Load")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Overwrite" }));

    await waitFor(() => expect(putCalled).toBe(true));
    expect(await screen.findByText("Session save updated")).toBeInTheDocument();
  });

  it("deletes session saves from the load modal", async () => {
    const user = userEvent.setup();
    const save = {
      filename: "old_load_20260101_162506.json",
      name: "Old Load",
      label: "Old Load",
      updatedAt: "2026-01-01T16:25:06+00:00",
      active: true,
    };

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/saves" && !requestOptions?.method) {
          return jsonResponse({ saves: [save] });
        }
        if (
          url === `/api/battle/sessions/sid-123/saves/${encodeURIComponent(save.filename)}`
          && requestOptions?.method === "DELETE"
        ) {
          return jsonResponse({ saves: [], activeSave: null });
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Load Session" }));
    expect(await screen.findByText(save.label)).toBeInTheDocument();
    expect(await screen.findByText("Active")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: `Delete save ${save.label}` }));

    await waitFor(() => {
      expect(screen.getByText("No session saves found for this workspace.")).toBeInTheDocument();
    });
    expect(await screen.findByText("Session save deleted")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/battle/sessions/sid-123/saves/${encodeURIComponent(save.filename)}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("starts a new session directly when the current session has no history", async () => {
    const user = userEvent.setup();
    const newSnapshot = buildSnapshot({
      sid: "sid-456",
      selectedId: null,
      activeTurnId: null,
      order: [],
      enemies: [],
      combatLog: [],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions" && requestOptions?.method === "POST") {
          return jsonResponse(newSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "New" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/battle/sessions", expect.objectContaining({ method: "POST" }));
    });
    expect(screen.queryByText("Start New Session")).not.toBeInTheDocument();
    expect(window.location.search).toContain("sid=sid-456");
  });

  it("requires confirmation before starting a new session when history exists", async () => {
    const user = userEvent.setup();
    const newSnapshot = buildSnapshot({
      sid: "sid-456",
      selectedId: null,
      activeTurnId: null,
      order: [],
      enemies: [],
      combatLog: [],
    });

    renderWithSnapshot(buildSnapshot({ canUndo: true, undoDepth: 1 }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions" && requestOptions?.method === "POST") {
          return jsonResponse(newSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "New" }));

    expect(screen.getByText("Confirm New Session")).toBeInTheDocument();
    expect(screen.getByText("Current session progress will be discarded.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith("/api/battle/sessions", expect.objectContaining({ method: "POST" }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Confirm New Session")).not.toBeInTheDocument();
    expect(window.location.search).toContain("sid=sid-123");

    await user.click(screen.getByRole("button", { name: "New" }));
    await user.click(screen.getByRole("button", { name: "Start New Session" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/battle/sessions", expect.objectContaining({ method: "POST" }));
    });
    expect(await screen.findByText("Started a new session")).toBeInTheDocument();
    expect(window.location.search).toContain("sid=sid-456");
  });

  it("posts Undo from the top menu and updates the snapshot", async () => {
    const user = userEvent.setup();
    const undoSnapshot = buildSnapshot({
      canUndo: false,
      undoDepth: 0,
      canRedo: true,
      redoDepth: 1,
      enemies: [buildEnemy({ hp_current: 10, statuses: {} })],
      combatLog: ["Added enemy: Goblin 1"],
    });

    renderWithSnapshot(buildSnapshot({ canUndo: true, undoDepth: 1 }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/undo" && requestOptions?.method === "POST") {
          return jsonResponse(undoSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/undo",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Undid last action")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeEnabled();
  });

  it("posts Redo from the top menu and updates the snapshot", async () => {
    const user = userEvent.setup();
    const redoSnapshot = buildSnapshot({
      canUndo: true,
      undoDepth: 1,
      canRedo: false,
      redoDepth: 0,
      enemies: [buildEnemy({ hp_current: 7, statuses: { burn: true } })],
      combatLog: ["Goblin 1 takes 3 damage"],
    });

    renderWithSnapshot(buildSnapshot({ canUndo: true, undoDepth: 1, canRedo: true, redoDepth: 1 }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/redo" && requestOptions?.method === "POST") {
          return jsonResponse(redoSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Redo" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/redo",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Redid last action")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
  });

  it("keeps rare actions inside the More menu", async () => {
    const user = userEvent.setup();

    renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");

    expect(screen.queryByRole("button", { name: "Draw" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start encounter" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attack enemy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Heal enemy" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More" }));

    expect(screen.queryByRole("menuitem", { name: "Redraw" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reposition unit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Heal enemy" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Disengage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Help" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Enemy turn (no draw)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "End turn" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Inspect loot" })).not.toBeInTheDocument();
  });

  it("allows the active NPC to disengage from the More menu", async () => {
    const user = userEvent.setup();
    const disengagedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ disengaged: true }),
      combatLog: ["Goblin 1 disengages (no opportunity attacks this turn)."],
    });

    renderWithSnapshot(buildSnapshot({ activeTurnId: "enemy-1", movementState: buildMovementState() }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/action/disengage" && requestOptions?.method === "POST") {
          return jsonResponse(disengagedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "More" }));
    const disengageItem = screen.getByRole("menuitem", { name: "Disengage" });
    expect(disengageItem).toBeEnabled();

    await user.click(disengageItem);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/action/disengage",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Goblin 1 disengages (no opportunity attacks this turn).")).toBeInTheDocument();
  });

  it("starts an encounter from the turn button when no unit is active", async () => {
    const user = userEvent.setup();
    const startedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState(),
      combatLog: ["Active turn: Goblin 1"],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/encounter/start" && requestOptions?.method === "POST") {
          return jsonResponse(startedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    expect(screen.queryByText(/Active Turn:/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start encounter" }));
    expect((await screen.findAllByText((text) => text.includes("Roll Initiative"))).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Start Encounter" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/encounter/start",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Active Turn: Goblin 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draw" })).toBeEnabled();
  });

  it("keeps the turn button on Next when an active unit already exists", async () => {
    const user = userEvent.setup();
    const activeSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState(),
    });

    renderWithSnapshot(activeSnapshot, {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/turn/next" && requestOptions?.method === "POST") {
          return jsonResponse(activeSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/turn/next",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("turn button ends combat when no living enemies remain", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 1,
      grid_y: 1,
    });
    const endedSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: null,
      encounterStarted: false,
      order: ["player-1"],
      enemies: [player],
      combatLog: ["Combat ended."],
    });

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      encounterStarted: true,
      order: ["player-1"],
      enemies: [player],
    }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/encounter/end" && requestOptions?.method === "POST") {
          return jsonResponse(endedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "End Combat" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/encounter/end",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Combat ended.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start encounter" })).toBeInTheDocument();
  });

  it("keeps the primary turn button on Next when a new enemy appears before combat is ended", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 1,
      grid_y: 1,
    });
    const newEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Goblin 2",
      grid_x: 2,
      grid_y: 1,
    });
    const nextSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      activeTurnId: "enemy-2",
      encounterStarted: true,
      order: ["player-1", "enemy-2"],
      enemies: [player, newEnemy],
      movementState: buildMovementState({ entityId: "enemy-2" }),
      combatLog: ["Active turn: Goblin 2"],
    });

    renderWithSnapshot(buildSnapshot({
      selectedId: "enemy-2",
      activeTurnId: null,
      encounterStarted: true,
      hasLiveOrderedEnemy: false,
      order: ["player-1"],
      enemies: [player, newEnemy],
    }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/encounter/start" && requestOptions?.method === "POST") {
          return jsonResponse(nextSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 2");
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/encounter/start",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Active Turn: Goblin 2")).toBeInTheDocument();
  });

  it("disables Start encounter when every unit is down", async () => {
    renderWithSnapshot(
      buildSnapshot({
        enemies: [buildEnemy({ hp_current: 0, is_down: true })],
      }),
    );

    expect(await screen.findByRole("button", { name: "Start encounter" })).toBeDisabled();
  });

  it("keeps the attack modal open when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const { container } = renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Attack enemy" }));

    expect(screen.getByRole("button", { name: "Apply attack" })).toBeInTheDocument();
    await user.click(container.querySelector(".modal-overlay"));

    expect(screen.getByRole("button", { name: "Apply attack" })).toBeInTheDocument();
  });

  it("shows player attack and heal actions in the action bar", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      hp_current: 8,
      hp_max: 10,
      armor_current: 0,
      armor_max: 0,
      magic_armor_current: 0,
      magic_armor_max: 0,
      guard_current: 0,
      draws_base: 0,
      effective_movement: 6,
    });
    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        order: ["player-1"],
        enemies: [player],
      }),
    );

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "Attack player" }));
    expect((await screen.findAllByText("Attack player")).length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Heal player" })).toBeInTheDocument();
  });

  it("submits temporary toughness from the player heal modal", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 3,
      toughness_max: 4,
      grid_x: 0,
      grid_y: 0,
    });
    const healCalls = [];

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [player],
    }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/heal" && requestOptions?.method === "POST") {
          healCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["player-1"],
            enemies: [{ ...player, toughness_current: 6 }],
          }));
        }
        return undefined;
      },
    });

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Heal player" }));
    await user.clear(await screen.findByLabelText("Toughness"));
    await user.type(screen.getByLabelText("Toughness"), "1");
    await user.clear(screen.getByLabelText("Temp toughness"));
    await user.type(screen.getByLabelText("Temp toughness"), "2");
    await user.click(screen.getByRole("button", { name: "Apply healing" }));

    await waitFor(() => {
      expect(healCalls).toEqual([{
        toughness: 1,
        temporaryToughness: 2,
        armor: 0,
        magicArmor: 0,
        guard: 0,
      }]);
    });
  });

  it("only shows suspect investigation when the selected player is within 5ft", async () => {
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 3,
      grid_y: 3,
    });
    const dungeon = buildDungeon({
      currentPcRoomIds: ["room-1"],
      secretSuspects: [
        { room_id: "room-1", edge_key: "0,0,e", kind: "secret", exhausted: false },
      ],
    });

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [player],
      dungeon,
    }));

    await findMapToken("Player 1");
    expect(screen.queryByRole("button", { name: "Investigate Suspect" })).not.toBeInTheDocument();
  });

  it("keeps Search Room available for exploration outside combat", async () => {
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 0,
    });
    const dungeon = buildDungeon({
      currentPcRoomIds: ["room-1"],
    });

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [player],
      dungeon,
    }));

    await findMapToken("Player 1");
    expect(screen.getByRole("button", { name: "Search Room" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Draw" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Strengthen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guard" })).not.toBeInTheDocument();
  });

  it("resolves Search Room with partyWalk false when Party Walk mode is off", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 0,
      actions_used: 2,
    });
    const dungeon = buildDungeon({ currentPcRoomIds: ["room-1"] });
    const resolveCalls = [];

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [player],
      dungeon,
    }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/search/start" && requestOptions?.method === "POST") {
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["player-1"],
            enemies: [player],
            dungeon,
            pendingSearch: {
              kind: "search",
              entityId: "player-1",
              roomId: "room-1",
              hasFate: false,
              successCount: 2,
              fateCount: 0,
            },
          }));
        }
        if (url === "/api/battle/sessions/sid-123/dungeon/search/resolve" && requestOptions?.method === "POST") {
          resolveCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["player-1"],
            enemies: [player],
            dungeon,
            pendingSearch: null,
          }));
        }
        return undefined;
      },
    });

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "Search Room" }));

    await waitFor(() => {
      expect(resolveCalls).toEqual([{ useWillpower: false, partyWalk: false }]);
    });
    expect(screen.queryByRole("heading", { name: "Meer dan 2 acties" })).not.toBeInTheDocument();
  });

  it("resolves Search Room with partyWalk true when Party Walk mode is on", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 0,
    });
    const dungeon = buildDungeon({ currentPcRoomIds: ["room-1"] });
    const resolveCalls = [];

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [player],
      dungeon,
    }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/search/start" && requestOptions?.method === "POST") {
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["player-1"],
            enemies: [player],
            dungeon,
            pendingSearch: {
              kind: "search",
              entityId: "player-1",
              roomId: "room-1",
              hasFate: false,
              successCount: 2,
              fateCount: 0,
            },
          }));
        }
        if (url === "/api/battle/sessions/sid-123/dungeon/search/resolve" && requestOptions?.method === "POST") {
          resolveCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["player-1"],
            enemies: [player],
            dungeon,
            pendingSearch: null,
          }));
        }
        return undefined;
      },
    });

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "Party Walk" }));
    expect(screen.getByRole("button", { name: "Cancel Party Walk" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Search Room" }));

    await waitFor(() => {
      expect(resolveCalls).toEqual([{ useWillpower: false, partyWalk: true }]);
    });
  });

  it("hides Search Room during combat but keeps active-player suspect investigation", async () => {
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 0,
    });
    const dungeon = buildDungeon({
      currentPcRoomIds: ["room-1"],
      secretSuspects: [
        { room_id: "room-1", edge_key: "0,0,e", kind: "secret", exhausted: false },
      ],
    });

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      encounterStarted: true,
      order: ["player-1"],
      enemies: [player],
      dungeon,
    }));

    await findMapToken("Player 1");
    expect(screen.queryByRole("button", { name: "Search Room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Party Walk" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Investigate Suspect" })).toBeEnabled();
  });

  it("shows concrete willpower outcomes when room search draws fate", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 0,
    });
    const dungeon = buildDungeon({ currentPcRoomIds: ["room-1"] });
    const resolveCalls = [];

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [player],
      dungeon,
    }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/search/start" && requestOptions?.method === "POST") {
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["player-1"],
            enemies: [player],
            dungeon,
            pendingSearch: {
              kind: "search",
              entityId: "player-1",
              roomId: "room-1",
              hasFate: true,
              successCount: 1,
              fateCount: 2,
            },
          }));
        }
        if (url === "/api/battle/sessions/sid-123/dungeon/search/resolve" && requestOptions?.method === "POST") {
          resolveCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["player-1"],
            enemies: [player],
            dungeon,
            pendingSearch: null,
          }));
        }
        return undefined;
      },
    });

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "Search Room" }));

    expect(await screen.findByRole("button", { name: "Willpower inzetten voor 3 successen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 succes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overslaan" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "1 succes" }));
    expect(resolveCalls).toEqual([{ useWillpower: false, partyWalk: false }]);
  });

  it("asks for willpower when suspect investigation draws fate", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 0,
    });
    const dungeon = buildDungeon({
      currentPcRoomIds: ["room-1"],
      secretSuspects: [
        { room_id: "room-1", edge_key: "0,0,e", kind: "secret", exhausted: false },
      ],
    });
    const startedSnapshot = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [player],
      dungeon,
      pendingSearch: {
        kind: "suspect",
        entityId: "player-1",
        roomId: "room-1",
        edgeKey: "0,0,e",
        hasFate: true,
        successCount: 0,
        fateCount: 1,
      },
    });
    const resolveCalls = [];

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [player],
      dungeon,
    }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/suspects/interact" && requestOptions?.method === "POST") {
          return jsonResponse(startedSnapshot);
        }
        if (url === "/api/battle/sessions/sid-123/dungeon/suspects/resolve" && requestOptions?.method === "POST") {
          resolveCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["player-1"],
            enemies: [player],
            dungeon,
            pendingSearch: null,
          }));
        }
        return undefined;
      },
    });

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "Investigate Suspect" }));
    await user.click(await screen.findByRole("button", { name: "Willpower inzetten voor 1 succes" }));

    expect(resolveCalls).toEqual([{ useWillpower: true }]);
  });

  it("shows a wound popup when player damage resets toughness", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 5,
      toughness_max: 5,
      armor_current: 0,
      armor_max: 0,
      magic_armor_current: 0,
      magic_armor_max: 0,
      guard_current: 0,
      power_base: 0,
      effective_movement: 6,
    });
    const baseSnapshot = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [player],
    });
    const woundedSnapshot = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [{ ...player, toughness_current: 4 }],
      woundEvents: [
        {
          instanceId: "player-1",
          name: "Mira",
          wounds: 2,
          toughnessAfter: 4,
          toughnessMax: 5,
        },
      ],
    });

    renderWithSnapshot(baseSnapshot, {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/attack" && requestOptions?.method === "POST") {
          expect(JSON.parse(requestOptions.body).damage).toBe(11);
          return jsonResponse(woundedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Mira");
    await user.click(screen.getByRole("button", { name: "Attack player" }));
    await user.clear(screen.getByLabelText("Damage"));
    await user.type(screen.getByLabelText("Damage"), "11");
    await user.click(screen.getByRole("button", { name: "Apply attack" }));

    expect(await screen.findByText("Player Wounds")).toBeInTheDocument();
    expect(screen.getByText("Wound taken")).toBeInTheDocument();
    expect(screen.getByText((_, node) => node?.textContent === "Mira gains 2 wounds.")).toBeInTheDocument();
    expect(screen.getByLabelText("2 wound cards")).toBeInTheDocument();
    expect(screen.getByLabelText("Toughness 4/5 after wounds")).toBeInTheDocument();
  });

  it("shows grapple status and posts manual attacks against a selected grapple", async () => {
    const user = userEvent.setup();
    const grapple = {
      id: "grapple-1",
      grapplerId: "enemy-2",
      targetId: "enemy-1",
      grapplerName: "Wolf 1",
      targetName: "Goblin 1",
      toughnessCurrent: 5,
      toughnessMax: 8,
      createdOrder: 1,
    };
    const goblin = buildEnemy({
      toughness_current: 10,
      toughness_max: 10,
      grappled_by: [grapple],
      grappling: [],
      statuses: { grappled: { stacks: 1 } },
      status_text: "grappled(1)",
    });
    let postedAttack = null;

    renderWithSnapshot(buildSnapshot({ enemies: [goblin] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/attack" && requestOptions?.method === "POST") {
          postedAttack = JSON.parse(requestOptions.body);
          return jsonResponse(buildSnapshot({ enemies: [goblin] }));
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    expect(screen.getByText("Grappled T 5/8")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Attack enemy" }));
    await user.click(await screen.findByRole("button", { name: "Target Grapple" }));
    await user.click(screen.getByRole("button", { name: "Apply attack" }));

    expect(postedAttack).toMatchObject({
      damage: 1,
      targetMode: "grapple",
      grappleId: "grapple-1",
    });
  });

  it("posts quick attack from the action bar and shows player wounds", async () => {
    const user = userEvent.setup();
    const attacker = buildEnemy({
      instance_id: "enemy-1",
      name: "Goblin 1",
      current_draw_text: ["Attack 5"],
      current_draw_attacks: [{ damage: 5, modifiers: [], label: "Attack 5" }],
    });
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 3,
      toughness_max: 5,
      armor_current: 0,
      armor_max: 0,
      magic_armor_current: 0,
      magic_armor_max: 0,
      guard_current: 0,
      power_base: 0,
      effective_movement: 6,
      grid_x: 5,
      grid_y: 3,
    });
    const woundedSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "enemy-1",
      turnInProgress: true,
      order: ["enemy-1", "player-1"],
      enemies: [attacker, { ...player, toughness_current: 3 }],
      quickAttackNotice: "Quick Attack: Goblin 1 attacks Mira with Attack 5.",
      woundEvents: [
        {
          instanceId: "player-1",
          name: "Mira",
          wounds: 1,
          toughnessAfter: 3,
          toughnessMax: 5,
        },
      ],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        activeTurnId: "enemy-1",
        turnInProgress: true,
        order: ["enemy-1", "player-1"],
        enemies: [attacker, player],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/turn/quick-attack" && requestOptions?.method === "POST") {
            return jsonResponse(woundedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Mira");
    await user.click(screen.getByRole("button", { name: "Quick Attack" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/turn/quick-attack",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Player Wounds")).toBeInTheDocument();
    expect(screen.getByText((_, node) => node?.textContent === "Mira gains 1 wound.")).toBeInTheDocument();
  });

  it("posts quick attack without a selected target when the active NPC is grappled", async () => {
    const user = userEvent.setup();
    const grapple = {
      id: "grapple-1",
      grapplerId: "enemy-2",
      targetId: "enemy-1",
      grapplerName: "Wolf 1",
      targetName: "Goblin 1",
      toughnessCurrent: 2,
      toughnessMax: 4,
      createdOrder: 1,
    };
    const attacker = buildEnemy({
      instance_id: "enemy-1",
      name: "Goblin 1",
      current_draw_text: ["Attack 3"],
      current_draw_attacks: [{ damage: 3, modifiers: [], label: "Attack 3" }],
      grappled_by: [grapple],
      statuses: { grappled: { stacks: 1 } },
      status_text: "grappled(1)",
    });
    const other = buildEnemy({
      instance_id: "enemy-2",
      name: "Wolf 1",
      grid_x: 5,
      grid_y: 3,
    });
    const attackedSnapshot = buildSnapshot({
      selectedId: "enemy-1",
      activeTurnId: "enemy-1",
      turnInProgress: true,
      order: ["enemy-1", "enemy-2"],
      enemies: [{ ...attacker, grappled_by: [] }, other],
      quickAttackNotice: "Quick Attack: Goblin 1 attacks Grapple on Goblin 1 with Attack 3.",
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "enemy-1",
        activeTurnId: "enemy-1",
        turnInProgress: true,
        order: ["enemy-1", "enemy-2"],
        enemies: [attacker, other],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/turn/quick-attack" && requestOptions?.method === "POST") {
            return jsonResponse(attackedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Quick Attack" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/turn/quick-attack",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Quick Attack: Goblin 1 attacks Grapple on Goblin 1 with Attack 3.")).toBeInTheDocument();
  });

  it("shows player wound counts and confirms deck wound removal", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 4,
      toughness_max: 4,
      power_base: 4,
      wound_counts: { hand: 1, discard: 0, draw_pile: 1, total: 2 },
    });
    const afterDiscard = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [{ ...player, wound_counts: { hand: 0, discard: 0, draw_pile: 1, total: 1 } }],
    });
    const afterRemove = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [{ ...player, wound_counts: { hand: 0, discard: 0, draw_pile: 0, total: 0 } }],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        order: ["player-1"],
        enemies: [player],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/entities/player-1/wounds/discard" && requestOptions?.method === "POST") {
            return jsonResponse(afterDiscard);
          }
          if (url === "/api/battle/sessions/sid-123/entities/player-1/wounds/remove" && requestOptions?.method === "POST") {
            return jsonResponse(afterRemove);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Mira");
    expect(screen.getByText("Wounds")).toBeInTheDocument();
    expect(screen.getByText("Hand").closest(".loot-block")).toHaveTextContent("1");
    expect(screen.getByText("Total").closest(".loot-block")).toHaveTextContent("2");

    await user.click(screen.getByRole("button", { name: "Discard Wound" }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/player-1/wounds/discard",
        expect.objectContaining({ method: "POST" }),
      );
    });

    await user.click(screen.getByRole("button", { name: "Remove Wound" }));
    expect(screen.getByText("Remove Wound From Deck")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove from deck" }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/player-1/wounds/remove",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ confirmDeck: true }) }),
      );
    });
  });

  it("shows physical player wound total and hides digital card controls", async () => {
    const user = userEvent.setup();
    const playerModeCalls = [];
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 4,
      toughness_max: 4,
      power_base: 4,
      physical_cards: true,
      physical_wounds: 2,
      draw_bonus_next_turn: 1,
      wound_counts: { hand: 0, discard: 0, draw_pile: 0, total: 2 },
    });
    const afterAdd = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      order: ["player-1"],
      enemies: [{ ...player, physical_wounds: 3, wound_counts: { hand: 0, discard: 0, draw_pile: 0, total: 3 } }],
    });
    const afterReset = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      order: ["player-1"],
      enemies: [{
        ...player,
        physical_cards: false,
        physical_wounds: 0,
        wound_counts: { hand: 0, discard: 0, draw_pile: 3, total: 3 },
      }],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        activeTurnId: "player-1",
        order: ["player-1"],
        enemies: [player],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/entities/player-1/wounds/adjust" && requestOptions?.method === "POST") {
            return jsonResponse(afterAdd);
          }
          if (url === "/api/battle/sessions/sid-123/entities/player-1/player-card-mode" && requestOptions?.method === "POST") {
            playerModeCalls.push(JSON.parse(requestOptions.body));
            return jsonResponse(afterReset);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Mira");
    expect(screen.getByText("Physical cards")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draw" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draw X" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard Wound" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare (+1 next)" })).toBeInTheDocument();

    const woundPanel = screen.getByLabelText("Player wound counts");
    expect(within(woundPanel).getByText("Total").closest(".loot-block")).toHaveTextContent("2");
    expect(within(woundPanel).queryByText("Hand")).not.toBeInTheDocument();
    expect(within(woundPanel).getByText("Switching to digital cards will reset the digital deck and shuffle these wounds into it.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add physical wound" }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/player-1/wounds/adjust",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ delta: 1 }) }),
      );
    });

    await user.click(screen.getByRole("button", { name: "Digital cards" }));
    expect(screen.getByText("Switch To Digital Cards")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset deck and switch" }));
    await waitFor(() => {
      expect(playerModeCalls[0]).toEqual({ physicalCards: false, deckReset: true });
    });
  });

  it("disables quick attack after it has been used for the current draw", async () => {
    const user = userEvent.setup();
    const attacker = buildEnemy({
      instance_id: "enemy-1",
      name: "Goblin 1",
      current_draw_text: ["Attack 3"],
      current_draw_attacks: [{ damage: 3, modifiers: [], label: "Attack 3" }],
    });
    const target = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 5,
      grid_y: 3,
    });
    const attackedSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      activeTurnId: "enemy-1",
      turnInProgress: true,
      order: ["enemy-1", "enemy-2"],
      enemies: [{ ...attacker, quick_attack_used: true }, { ...target, toughness_current: 7 }],
      quickAttackNotice: "Quick Attack: Goblin 1 attacks Bandit 1 with Attack 3.",
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "enemy-2",
        activeTurnId: "enemy-1",
        turnInProgress: true,
        order: ["enemy-1", "enemy-2"],
        enemies: [attacker, target],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/turn/quick-attack" && requestOptions?.method === "POST") {
            return jsonResponse(attackedSnapshot);
          }
          return undefined;
        },
      },
    );

    const quickAttackButton = await screen.findByRole("button", { name: "Quick Attack" });
    expect(quickAttackButton).toBeEnabled();

    await user.click(quickAttackButton);

    expect(await screen.findByText("Quick Attack: Goblin 1 attacks Bandit 1 with Attack 3.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quick Attack" })).toBeDisabled();
  });

  it("shows a temporary draw card inspector and battle map pulse after a successful draw", async () => {
    const drawnSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      turnInProgress: true,
      enemies: [buildEnemy({ current_draw_text: ["Attack 3", "Guard 2"] })],
      combatLog: ["Goblin 1 draws: Attack 3, Guard 2"],
    });

    renderWithSnapshot(buildSnapshot({ activeTurnId: "enemy-1", movementState: buildMovementState() }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/turn/draw" && requestOptions?.method === "POST") {
          return jsonResponse(drawnSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Draw" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const reveal = screen.getByRole("complementary", { name: "Draw Card Inspector" });
    expect(within(reveal).getByText("Current draw")).toBeInTheDocument();
    expect(within(reveal).getByText("Attack 3")).toBeInTheDocument();
    expect(within(reveal).getByText("Guard 2")).toBeInTheDocument();

    const viewport = getMapViewport();
    expect(viewport.dataset.drawPulseEntityId).toBe("enemy-1");
    expect(viewport.dataset.drawPulseKey).toContain("draw-enemy-1-");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(reveal).toHaveAttribute("data-draw-reveal-phase", "hold");

    act(() => {
      vi.advanceTimersByTime(3201);
    });
    expect(reveal).toHaveAttribute("data-draw-reveal-phase", "settle");
    expect(screen.getByRole("button", { name: "Open draw card detail: Attack 3" }).closest(".unit-inspector-draw-preview")).toHaveClass(
      "unit-inspector-draw-preview-highlight",
    );

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.queryByRole("complementary", { name: "Draw Card Inspector" })).not.toBeInTheDocument();
  });

  it("changes player Draw of Power into Hitdraw and keeps Draw X available", async () => {
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 4,
      toughness_max: 4,
      armor_current: 1,
      armor_max: 1,
      guard_current: 1,
      power_base: 4,
      wound_counts: { hand: 0, discard: 0, draw_pile: 0, total: 0 },
    });
    const drawnSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      turnInProgress: true,
      order: ["player-1"],
      enemies: [
        {
          ...player,
          power_draw_used: true,
          current_draw_text: ["Martial energy success"],
          current_draw_groups: [
            {
              label: "Draw 1",
              items: ["Martial energy success"],
              summary: { outcomes: { success: 1, fate: 0, fail: 0 }, energies: { Martial: 1 } },
            },
          ],
        },
      ],
    });
    const exactSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      turnInProgress: true,
      order: ["player-1"],
      enemies: [
        {
          ...player,
          power_draw_used: true,
          current_draw_text: ["Martial energy success", "Wound"],
          current_draw_groups: [
            {
              label: "Draw 1",
              items: ["Martial energy success"],
              summary: { outcomes: { success: 1, fate: 0, fail: 0 }, energies: { Martial: 1 } },
            },
            {
              label: "Draw 2",
              items: ["Wound"],
              summary: { outcomes: { success: 0, fate: 0, fail: 1 }, energies: {} },
            },
          ],
          wound_counts: { hand: 1, discard: 0, draw_pile: 0, total: 1 },
        },
      ],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        activeTurnId: "player-1",
        turnInProgress: false,
        order: ["player-1"],
        enemies: [player],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/turn/draw" && requestOptions?.method === "POST") {
            return jsonResponse(drawnSnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/turn/draw-exact" && requestOptions?.method === "POST") {
            return jsonResponse(exactSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Mira");
    expect(screen.getByRole("button", { name: "Draw" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Draw X" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Draw" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/battle/sessions/sid-123/turn/draw",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.queryByRole("button", { name: "Draw" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hitdraw" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Draw X" })).toBeEnabled();
    const reveal = screen.getByRole("complementary", { name: "Draw Card Inspector" });
    expect(within(reveal).getByText("Martial energy success")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Draw X" }));
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/turn/draw-exact",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ count: 1 }) }),
      );
    });
    expect(screen.getByText("Wounds")).toBeInTheDocument();
    expect(screen.getByText("Hand").closest(".loot-block")).toHaveTextContent("1");
    const exactReveal = screen.getByRole("complementary", { name: "Draw Card Inspector" });
    expect(within(exactReveal).getByText("Wound")).toBeInTheDocument();
    expect(within(exactReveal).getByText("fail 1")).toBeInTheDocument();
    const draw1 = screen.getByText("Draw 1");
    const draw2 = screen.getByText("Draw 2");
    expect(draw2.compareDocumentPosition(draw1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
  });

  it("shows resolved Draw of Power energy instead of raw legacy card IDs", async () => {
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      power_draw_used: true,
      power_draw_cards: [
        { energy_type: "Martial", energy_amount: 1, outcome: "fail", title: "Martial energy fail" },
        { energy_type: "Master", energy_amount: 1, outcome: "fate", title: "Master energy fate (reshuffle at end turn)" },
        { energy_type: "Void", energy_amount: 0, outcome: "fate", title: "Void fate" },
        { energy_type: "Martial", energy_amount: 1, outcome: "fail", title: "Martial energy fail" },
      ],
      current_draw_text: [
        "Martial energy fail",
        "Master energy fate (reshuffle at end turn)",
        "Void fate",
        "Martial energy fail",
      ],
      current_draw_groups: [
        {
          label: "Draw 1",
          items: [
            "Martial energy fail",
            "Master energy fate (reshuffle at end turn)",
            "Void fate",
            "Martial energy fail",
          ],
          summary: { outcomes: { success: 0, fate: 2, fail: 2 }, energies: { Martial: 2, Master: 1 } },
        },
      ],
      current_draw_summary: { outcomes: { success: 0, fate: 2, fail: 2 }, energies: { Martial: 2, Master: 1 } },
      wound_counts: { hand: 0, discard: 0, draw_pile: 0, total: 0 },
    });

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      turnInProgress: true,
      order: ["player-1"],
      enemies: [player],
    }));

    const energyBar = await screen.findByRole("region", { name: "Draw of Power energy pool for Mira" });
    expect(within(energyBar).getByText("Martial")).toBeInTheDocument();
    expect(within(energyBar).getByText("Master")).toBeInTheDocument();
    expect(within(energyBar).getByText("2")).toBeInTheDocument();
    expect(within(energyBar).getByText("1")).toBeInTheDocument();
    expect(within(energyBar).queryByText("No spendable energy drawn")).not.toBeInTheDocument();
    expect(screen.queryByText("hf_martial_1_fail")).not.toBeInTheDocument();
    expect(screen.queryByText("hf_master_fate_reshuffle")).not.toBeInTheDocument();
  });

  it("opens Guard X from the action bar and posts the chosen guard amount", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 4,
      toughness_max: 4,
      guard_current: 0,
      guard_base: 1,
      power_base: 4,
      actions_used: 0,
      wound_counts: { hand: 0, discard: 0, draw_pile: 0, total: 0 },
    });
    const guardedSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      turnInProgress: true,
      order: ["player-1"],
      enemies: [{ ...player, guard_current: 3, actions_used: 1 }],
      combatLog: ["Mira guards: +3 guard."],
    });
    let guardBody = null;

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        activeTurnId: "player-1",
        turnInProgress: true,
        order: ["player-1"],
        enemies: [player],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/action/guard" && requestOptions?.method === "POST") {
            guardBody = JSON.parse(requestOptions.body);
            return jsonResponse(guardedSnapshot);
          }
          return undefined;
        },
      },
    );

    await user.click(await screen.findByRole("button", { name: "Guard" }));
    const modal = screen.getByText("Gain Guard X. Guard is added to the current temporary guard pool.").closest(".modal-shell");
    await user.click(within(modal).getByRole("button", { name: "3" }));

    expect(guardBody).toEqual({ x: 3 });
    expect(await screen.findByText("1/2 acties")).toBeInTheDocument();
    expect(screen.getByText("Mira guards: +3 guard.")).toBeInTheDocument();
  });

  it("posts Hitdraw and shows success/fate/fail without energy results", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 4,
      toughness_max: 4,
      guard_current: 0,
      guard_base: 1,
      power_base: 4,
      power_draw_used: true,
      current_draw_text: ["Martial energy success"],
      current_draw_groups: [
        {
          label: "Draw 1",
          items: ["Martial energy success"],
          summary: { outcomes: { success: 1, fate: 0, fail: 0 }, energies: { Martial: 1 } },
        },
      ],
      actions_used: 0,
      wound_counts: { hand: 0, discard: 0, draw_pile: 0, total: 0 },
    });
    const hitdrawSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      turnInProgress: true,
      order: ["player-1"],
      enemies: [{ ...player, actions_used: 1 }],
      hitDraw: {
        entityId: "player-1",
        entityName: "Mira",
        drawnCardIds: ["success-card", "fate-card", "fail-card"],
        drawnText: ["Success", "Fate", "Fail"],
        drawnCards: [
          { label: "Success", detail: "Martial 3 energy" },
          { label: "Fate", detail: "Class: Fighter's Resolve" },
          { label: "Fail", detail: "Ancestry: Human Ancestry" },
        ],
        summary: { outcomes: { success: 1, fate: 1, fail: 1 }, energies: { Martial: 9 } },
        reshuffled: false,
      },
      combatLog: ["Mira hits draw: Success, Fate, Fail (success 1, fate 1, fail 1)"],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        activeTurnId: "player-1",
        turnInProgress: true,
        order: ["player-1"],
        enemies: [player],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/action/hitdraw" && requestOptions?.method === "POST") {
            return jsonResponse(hitdrawSnapshot);
          }
          return undefined;
        },
      },
    );

    await user.click(await screen.findByRole("button", { name: "Hitdraw" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/action/hitdraw",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const reveal = await screen.findByRole("complementary", { name: "Draw Card Inspector" });
    expect(within(reveal).getByText("Hit draw")).toBeInTheDocument();
    expect(within(reveal).getByText("Success")).toBeInTheDocument();
    expect(within(reveal).getByText("Fate")).toBeInTheDocument();
    expect(within(reveal).getByText("Fail")).toBeInTheDocument();
    expect(within(reveal).getByText("Martial 3 energy")).toBeInTheDocument();
    expect(within(reveal).getByText("Class: Fighter's Resolve")).toBeInTheDocument();
    expect(within(reveal).getByText("Ancestry: Human Ancestry")).toBeInTheDocument();
    expect(within(reveal).queryByText("success 1")).not.toBeInTheDocument();
    expect(within(reveal).queryByText("fate 1")).not.toBeInTheDocument();
    expect(within(reveal).queryByText("fail 1")).not.toBeInTheDocument();
    expect(within(reveal).queryByText("Martial 9")).not.toBeInTheDocument();
    expect(screen.getByText("1/2 acties")).toBeInTheDocument();
  });

  it("does not show Hitdraw for physical-card player characters", async () => {
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      physical_cards: true,
      power_draw_used: true,
      toughness_current: 4,
      toughness_max: 4,
      wound_counts: { total: 0 },
    });

    renderWithSnapshot(buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      turnInProgress: true,
      order: ["player-1"],
      enemies: [player],
    }));

    await findMapToken("Mira");

    expect(screen.queryByRole("button", { name: "Hitdraw" })).not.toBeInTheDocument();
  });

  it("settles the draw card inspector immediately when the screen is clicked", async () => {
    const drawnSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      turnInProgress: true,
      enemies: [buildEnemy({ current_draw_text: ["Attack 3"] })],
    });

    renderWithSnapshot(buildSnapshot({ activeTurnId: "enemy-1", movementState: buildMovementState() }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/turn/draw" && requestOptions?.method === "POST") {
          return jsonResponse(drawnSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Draw" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const reveal = screen.getByRole("complementary", { name: "Draw Card Inspector" });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(reveal).toHaveAttribute("data-draw-reveal-phase", "hold");

    fireEvent.pointerDown(document.body);
    expect(reveal).toHaveAttribute("data-draw-reveal-phase", "settle");

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.queryByRole("complementary", { name: "Draw Card Inspector" })).not.toBeInTheDocument();
  });

  it("opens the compact draw preview as a detail modal", async () => {
    const user = userEvent.setup();

    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-1",
        turnInProgress: true,
        enemies: [buildEnemy({ current_draw_text: ["Attack 3", "Guard 2"] })],
      }),
    );

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Open draw card detail: Attack 3" }));

    expect(screen.getByText("Draw card")).toBeInTheDocument();
    expect(screen.getAllByText("Attack 3").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Guard 2").length).toBeGreaterThan(1);
  });

  it("posts redraw from the More menu during an active drawn turn", async () => {
    const user = userEvent.setup();
    const redrawnSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      turnInProgress: true,
      enemies: [buildEnemy({ current_draw_text: ["Guard 3"] })],
      combatLog: ["Goblin 1 redraws: Attack 5"],
    });

    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-1",
        turnInProgress: true,
        enemies: [buildEnemy({ current_draw_text: ["Attack 3"] })],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/turn/redraw" && requestOptions?.method === "POST") {
            return jsonResponse(redrawnSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Redraw" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/turn/redraw",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const reveal = await screen.findByRole("complementary", { name: "Draw Card Inspector" });
    expect(within(reveal).getByText("Redraw")).toBeInTheDocument();
    expect(within(reveal).getByText("Guard 3")).toBeInTheDocument();
  });

  it("posts player redraw from the More menu after Draw of Power", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 4,
      toughness_max: 4,
      power_base: 4,
      power_draw_used: true,
      current_draw_text: ["Martial energy success"],
      current_draw_groups: [
        {
          label: "Draw 1",
          items: ["Martial energy success"],
          summary: { outcomes: { success: 1, fate: 0, fail: 0 }, energies: { Martial: 1 } },
        },
      ],
      wound_counts: { hand: 1, discard: 0, draw_pile: 0, total: 1 },
    });
    const redrawnSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      turnInProgress: true,
      order: ["player-1"],
      enemies: [
        {
          ...player,
          current_draw_text: ["Elemental energy fail"],
          current_draw_groups: [
            {
              label: "Draw 1",
              items: ["Elemental energy fail"],
              summary: { outcomes: { success: 0, fate: 0, fail: 1 }, energies: { Elemental: 1 } },
            },
          ],
        },
      ],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        activeTurnId: "player-1",
        turnInProgress: true,
        order: ["player-1"],
        enemies: [player],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/turn/redraw" && requestOptions?.method === "POST") {
            return jsonResponse(redrawnSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Mira");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Redraw" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/turn/redraw",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const reveal = await screen.findByRole("complementary", { name: "Draw Card Inspector" });
    expect(within(reveal).getByText("Redraw")).toBeInTheDocument();
    expect(within(reveal).getByText("Elemental energy fail")).toBeInTheDocument();
  });

  it("renders separate selected and active turn indicators when different units are involved", async () => {
    const goblin = buildEnemy();
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      hp_current: 14,
      hp_max: 16,
      armor_current: 2,
      armor_max: 2,
      effective_movement: 5,
      grid_x: 5,
      grid_y: 3,
    });
    const { container } = renderWithSnapshot(
      buildSnapshot({
        selectedId: "enemy-1",
        activeTurnId: "enemy-2",
        order: ["enemy-1", "enemy-2"],
        enemies: [goblin, bandit],
        combatLog: ["Bandit 1 starts its turn"],
      }),
    );

    await findMapToken("Goblin 1");

    expect(screen.getByText("Selected: Goblin 1")).toBeInTheDocument();
    expect(screen.getByText("Active Turn: Bandit 1")).toBeInTheDocument();
    expect(container.querySelector(".initiative-row[data-state='state-selected']")).toHaveTextContent("Goblin 1");
    expect(container.querySelector(".initiative-row[data-state='state-active']")).toHaveTextContent("Bandit 1");
    expect(container.querySelector(".roster-card[data-state='state-selected']")).toHaveTextContent("Goblin 1");
    expect(container.querySelector(".roster-card[data-state='state-active']")).toHaveTextContent("Bandit 1");
  });

  it("renders the premade browser from meta", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);

    expect(screen.getByText("Add Unit")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Goblin" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Bandit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Guard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Soldier" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Wraith" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Player Character" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter part All" })).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum threat level")).toBeInTheDocument();
    expect(screen.getByLabelText("Maximum threat level")).toBeInTheDocument();
  });

  it("filters premade templates by search and category", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);

    await user.type(screen.getByLabelText("Search enemies"), "sold");
    expect(screen.getByRole("button", { name: "Add Soldier" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Goblin" })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search enemies"));
    await user.click(screen.getByRole("button", { name: "Filter part Realms And Order" }));

    expect(screen.getByRole("button", { name: "Add Guard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Soldier" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Goblin" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Bandit" })).not.toBeInTheDocument();
  });

  it("posts the selected premade template to the enemy endpoint", async () => {
    const user = userEvent.setup();
    const addedGoblinSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [
        buildEnemy(),
        buildEnemy({
          instance_id: "enemy-2",
          name: "Goblin 2",
          hp_current: 9,
          hp_max: 9,
          grid_x: 5,
          grid_y: 3,
        }),
      ],
      combatLog: ["Added enemy: Goblin 2"],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/enemies" && requestOptions?.method === "POST") {
          return jsonResponse(addedGoblinSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("button", { name: "Add Goblin" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/enemies",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ templateId: "goblin" }),
        }),
      );
    });
    expect(await findMapToken("Goblin 2")).toBeInTheDocument();
  });

  it("posts newly categorized premade templates through the existing enemy endpoint", async () => {
    const user = userEvent.setup();
    const addedGuardSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [
        buildEnemy(),
        buildEnemy({
          instance_id: "enemy-2",
          template_id: "guard",
          name: "Guard 1",
          image_url: "/images/Realms_and_order/guard.png",
          grid_x: 5,
          grid_y: 3,
        }),
      ],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/enemies" && requestOptions?.method === "POST") {
          return jsonResponse(addedGuardSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("button", { name: "Add Guard" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/enemies",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ templateId: "guard" }),
        }),
      );
    });
    expect(await findMapToken("Guard 1")).toBeInTheDocument();
  });

  it("uses the player endpoint from the same add-unit modal", async () => {
    const user = userEvent.setup();
    const playerSnapshot = buildSnapshot({
      selectedId: "player-1",
      order: ["enemy-1", "player-1"],
      enemies: [
        buildEnemy(),
        buildEnemy({
          instance_id: "player-1",
          template_id: "player",
          name: "Player 1",
          image_url: "/images/anonymous.png",
          is_player: true,
          hp_current: 0,
          hp_max: 0,
          armor_current: 0,
          armor_max: 0,
          magic_armor_current: 0,
          magic_armor_max: 0,
          guard_current: 0,
          draws_base: 0,
          effective_movement: 0,
          grid_x: 5,
          grid_y: 3,
        }),
      ],
      combatLog: ["Added player: Player 1"],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/players" && requestOptions?.method === "POST") {
          return jsonResponse(playerSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("tab", { name: "Player Character" }));
    await user.click(screen.getByRole("button", { name: "Add player character" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/players",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await findMapToken("Player 1")).toBeInTheDocument();
  });

  it("submits the selected player deck when adding a PC", async () => {
    const user = userEvent.setup();
    const playerCalls = [];
    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/players" && requestOptions?.method === "POST") {
          playerCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["enemy-1", "player-1"],
            enemies: [buildEnemy(), buildEnemy({
              instance_id: "player-1",
              template_id: "player",
              name: "Player 1",
              is_player: true,
            })],
          }));
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("tab", { name: "Player Character" }));
    await user.selectOptions(screen.getByLabelText("Deck"), "human_wizzard_lvl1");
    await user.click(screen.getByRole("button", { name: "Add player character" }));

    await waitFor(() => {
      expect(playerCalls[0]).toEqual(expect.objectContaining({ playerDeckId: "human_wizzard_lvl1" }));
    });
  });

  it("submits physical card mode when adding a PC", async () => {
    const user = userEvent.setup();
    const playerCalls = [];
    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/players" && requestOptions?.method === "POST") {
          playerCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["enemy-1", "player-1"],
            enemies: [buildEnemy(), buildEnemy({
              instance_id: "player-1",
              template_id: "player",
              name: "Player 1",
              is_player: true,
              physical_cards: true,
            })],
          }));
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("tab", { name: "Player Character" }));
    await user.click(screen.getByLabelText("Physical cards"));
    await user.click(screen.getByRole("button", { name: "Add player character" }));

    await waitFor(() => {
      expect(playerCalls[0]).toEqual(expect.objectContaining({ physicalCards: true }));
    });
  });

  it("locks required energy choices in the character builder", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("tab", { name: "Character Builder" }));

    expect(screen.getByRole("checkbox", { name: "Martial" })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Class"), "cleric");
    expect(screen.getByRole("checkbox", { name: "Light" })).toBeDisabled();
  });

  it("shows character art choices without auto-selecting when multiple matches exist", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("tab", { name: "Character Builder" }));

    expect(screen.getByRole("button", { name: "Anonymous" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Male" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Female" })).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: "Female" }));
    expect(screen.getByRole("button", { name: "Female" })).toHaveAttribute("aria-pressed", "true");
  });

  it("auto-selects character art when exactly one class and ancestry match exists", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("tab", { name: "Character Builder" }));
    await user.selectOptions(screen.getByLabelText("Class"), "cleric");

    expect(screen.getByRole("button", { name: "Female" })).toHaveAttribute("aria-pressed", "true");
  });

  it("uploads custom character art and sends it with the saved profile", async () => {
    const user = userEvent.setup();
    const uploadCalls = [];
    const characterCalls = [];
    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/character-builder/art/upload" && requestOptions?.method === "POST") {
          uploadCalls.push(requestOptions.body?.get("file")?.name);
          return jsonResponse({
            art: {
              source: "upload",
              imagePath: "Playing_Characters/extra/custom/portrait_20260611_203000.png",
              imageUrl: "/images/Playing_Characters/extra/custom/portrait_20260611_203000.png",
              label: "portrait",
            },
          });
        }
        if (url === "/api/battle/characters" && requestOptions?.method === "POST") {
          characterCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse({
            character: {
              id: "mira_20260611_203000",
              name: "Mira",
              classId: "fighter",
              className: "Fighter",
              ancestryId: "human",
              ancestryName: "Human",
              energyTypes: ["Martial", "Elemental", "Light"],
              mainArt: "Martial",
              art: {
                source: "upload",
                imagePath: "Playing_Characters/extra/custom/portrait_20260611_203000.png",
                imageUrl: "/images/Playing_Characters/extra/custom/portrait_20260611_203000.png",
                label: "portrait",
              },
              gearPreset: { id: "melee", name: "Melee", items: ["basic weapon", "shield"] },
            },
          });
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("tab", { name: "Character Builder" }));
    await user.type(screen.getByLabelText("Name"), "Mira");
    await user.upload(screen.getByLabelText("Upload custom art"), new File(["fake"], "portrait.png", { type: "image/png" }));
    await user.click(await screen.findByRole("button", { name: /portrait custom/ }));
    await user.click(screen.getByRole("button", { name: "Save character" }));

    expect(uploadCalls).toEqual(["portrait.png"]);
    await waitFor(() => {
      expect(characterCalls[0]).toEqual(expect.objectContaining({
        art: expect.objectContaining({
          source: "upload",
          imagePath: "Playing_Characters/extra/custom/portrait_20260611_203000.png",
        }),
      }));
    });
  });

  it("saves and spawns a character builder profile", async () => {
    const user = userEvent.setup();
    const characterCalls = [];
    const spawnCalls = [];
    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/characters" && requestOptions?.method === "POST") {
          characterCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse({
            character: {
              id: "mira_20260611_203000",
              name: "Mira",
              classId: "fighter",
              className: "Fighter",
              ancestryId: "halfling",
              ancestryName: "Halfling",
              energyTypes: ["Martial", "Elemental", "Light"],
              mainArt: "Martial",
              gearPreset: { id: "melee", name: "Melee", items: ["basic weapon", "shield"] },
            },
          });
        }
        if (url === "/api/battle/sessions/sid-123/players/from-character" && requestOptions?.method === "POST") {
          spawnCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({
            selectedId: "player-1",
            order: ["enemy-1", "player-1"],
            enemies: [buildEnemy(), buildEnemy({
              instance_id: "player-1",
              template_id: "player",
              name: "Mira",
              is_player: true,
            })],
          }));
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("tab", { name: "Character Builder" }));
    await user.type(screen.getByLabelText("Name"), "Mira");
    await user.selectOptions(screen.getByLabelText("Ancestry"), "halfling");
    await user.click(screen.getByRole("button", { name: "Save character" }));

    await waitFor(() => {
      expect(characterCalls[0]).toEqual(expect.objectContaining({
        name: "Mira",
        classId: "fighter",
        ancestryId: "halfling",
        energyTypes: ["Martial", "Elemental", "Light"],
        mainArt: "Martial",
        deckUpgrades: expect.objectContaining({
          Martial: expect.objectContaining({ success_1: 1, success_2: 1 }),
        }),
      }));
    });

    const savedRow = screen.getByText("Mira").closest(".saved-character-row");
    await user.click(within(savedRow).getByRole("button", { name: "Spawn" }));

    await waitFor(() => {
      expect(spawnCalls).toEqual([{ characterId: "mira_20260611_203000", physicalCards: false }]);
    });
    expect(await findMapToken("Mira")).toBeInTheDocument();
  });

  it("submits a custom enemy through the existing custom request shape", async () => {
    const user = userEvent.setup();
    const customSnapshot = buildSnapshot({
      selectedId: "enemy-9",
      order: ["enemy-1", "enemy-9"],
      enemies: [
        buildEnemy(),
        buildEnemy({
          instance_id: "enemy-9",
          template_id: "custom",
          name: "Shade",
          image_url: "/images/anonymous.png",
          hp_current: 7,
          hp_max: 7,
          armor_current: 1,
          armor_max: 1,
          draws_base: 2,
          effective_movement: 4,
          grid_x: 5,
          grid_y: 3,
        }),
      ],
      combatLog: ["Added custom enemy: Shade"],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/enemies" && requestOptions?.method === "POST") {
          const payload = JSON.parse(requestOptions.body);
          if (payload.custom) {
            return jsonResponse(customSnapshot);
          }
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);
    await user.click(screen.getByRole("tab", { name: "Custom Enemy" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Shade");
    await user.clear(screen.getByLabelText("Toughness"));
    await user.type(screen.getByLabelText("Toughness"), "7");
    await user.click(screen.getByRole("button", { name: "Add custom enemy" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/enemies",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            custom: {
              name: "Shade",
              toughness: 7,
              armor: 0,
              magicArmor: 0,
              draw: 1,
              movement: 6,
              coreDeckId: "basic",
            },
          }),
        }),
      );
    });
    expect(await findMapToken("Shade")).toBeInTheDocument();
  });

  it("keeps initiative tool clicks from triggering unit selection", async () => {
    const user = userEvent.setup();
    const goblin = buildEnemy();
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      hp_current: 14,
      hp_max: 16,
      armor_current: 2,
      armor_max: 2,
      effective_movement: 5,
      grid_x: 5,
      grid_y: 3,
    });
    const movedSnapshot = buildSnapshot({
      order: ["enemy-2", "enemy-1"],
      enemies: [goblin, bandit],
      combatLog: ["Moved Bandit 1 up in round order"],
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [goblin, bandit],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/order" && requestOptions?.method === "POST") {
            return jsonResponse(movedSnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/select") {
            throw new Error("Select should not fire from initiative tools");
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Move Bandit 1 up" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/order",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ instanceId: "enemy-2", direction: -1 }),
        }),
      );
    });
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/battle/sessions/sid-123/select",
      expect.anything(),
    );
    expect(await findMapToken("Goblin 1")).toBeInTheDocument();
  });

  it("moves the selected unit to a free battle map cell", async () => {
    const user = userEvent.setup();
    const movedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 4, remainingMovement: 2 }),
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Moved Goblin 1 to (1, 1)"],
    });

    renderWithSnapshot(buildSnapshot({ activeTurnId: "enemy-1", movementState: buildMovementState() }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Move" }));
    pointerClickMapCell(0, 0);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/move",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0, dash: false }),
        }),
      );
    });
    expect(await screen.findByText("Moved Goblin 1 to (1, 1)")).toBeInTheDocument();
  });

  it("party walks the selected player party and keeps Party Walk mode active", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 1,
    });
    const follower = buildEnemy({
      instance_id: "player-2",
      template_id: "player",
      name: "Player 2",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 2,
    });
    const movedSnapshot = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1", "player-2"],
      enemies: [
        buildEnemy({ ...player, grid_x: 4, grid_y: 1 }),
        buildEnemy({ ...follower, grid_x: 3, grid_y: 1 }),
      ],
      combatLog: ["Party walk: Player 1 led 2 PCs to (5, 2)."],
      partyWalk: {
        leaderId: "player-1",
        movedEntityIds: ["player-1", "player-2"],
        destination: { x: 4, y: 1 },
        actualDestination: { x: 4, y: 1 },
        stoppedForEncounter: false,
        revealedRoomIds: [],
        pendingEncounterRoomIds: [],
      },
    });

    renderWithSnapshot(buildSnapshot({ selectedId: "player-1", order: ["player-1", "player-2"], enemies: [player, follower] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/action/party-walk" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "Party Walk" }));
    expect(getMapViewport().dataset.mapMode).toBe("party-walk");
    pointerClickMapCell(4, 1);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/action/party-walk",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ leaderId: "player-1", x: 4, y: 1 }),
        }),
      );
    });
    await screen.findByText("Party walk: Player 1 led 2 PCs to (5, 2).");
    expect(getMapViewport().dataset.mapMode).toBe("party-walk");
  });

  it("leaves Party Walk mode when the response discovers an encounter", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 1,
    });
    const stoppedSnapshot = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [buildEnemy({ ...player, grid_x: 2, grid_y: 1 })],
      dungeon: buildDungeon({ pendingEncounterRoomIds: ["room-2"] }),
      combatLog: ["Party walk stopped: encounter discovered after Player 1 led 1 PC to (3, 2)."],
      partyWalk: {
        leaderId: "player-1",
        movedEntityIds: ["player-1"],
        destination: { x: 4, y: 1 },
        actualDestination: { x: 2, y: 1 },
        stoppedForEncounter: true,
        revealedRoomIds: ["room-2"],
        pendingEncounterRoomIds: ["room-2"],
      },
    });

    renderWithSnapshot(buildSnapshot({ selectedId: "player-1", order: ["player-1"], enemies: [player] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/action/party-walk" && requestOptions?.method === "POST") {
          return jsonResponse(stoppedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "Party Walk" }));
    pointerClickMapCell(4, 1);

    await screen.findByText("Party walk stopped: encounter discovered after Player 1 led 1 PC to (3, 2).");
    expect(getMapViewport().dataset.mapMode).toBe("idle");
  });

  it("walks the selected unit with the Walk button and a map click", async () => {
    const user = userEvent.setup();
    const walkedSnapshot = buildSnapshot({
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Walk: Goblin 1 moved to (1, 1)."],
      walk: {
        entityId: "enemy-1",
        destination: { x: 0, y: 0 },
        actualDestination: { x: 0, y: 0 },
        stoppedForEncounter: false,
        revealedRoomIds: [],
        pendingEncounterRoomIds: [],
      },
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/walk" && requestOptions?.method === "POST") {
          return jsonResponse(walkedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Walk" }));
    expect(getMapViewport().dataset.mapMode).toBe("walk");
    expect(getMapViewport().dataset.reachableNormal).toBe("0");
    pointerClickMapCell(4, 3);
    await waitFor(() => {
      expect(Number(getMapViewport().dataset.reachableNormal)).toBeGreaterThan(0);
    });
    pointerClickMapCell(0, 0);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/walk",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0 }),
        }),
      );
    });
    expect(await screen.findByText("Walk: Goblin 1 moved to (1, 1).")).toBeInTheDocument();
    await waitFor(() => {
      expect(getMapViewport().dataset.reachableNormal).toBe("0");
    });
  });

  it("walks a unit by dragging it outside combat", async () => {
    const walkedSnapshot = buildSnapshot({
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Walk: Goblin 1 moved to (1, 1)."],
      walk: {
        entityId: "enemy-1",
        destination: { x: 0, y: 0 },
        actualDestination: { x: 0, y: 0 },
        stoppedForEncounter: false,
        revealedRoomIds: [],
        pendingEncounterRoomIds: [],
      },
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/walk" && requestOptions?.method === "POST") {
          return jsonResponse(walkedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    pointerDragBetweenCells(4, 3, 0, 0, { pointerId: 101 });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/walk",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0 }),
        }),
      );
    });
    await waitFor(() => {
      expect(getMapViewport().dataset.mapMode).toBe("idle");
      expect(getMapViewport().dataset.selectedUnitIds).toBe("");
    });
  });

  it("moves the active combat unit by dragging it", async () => {
    const movedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 5, remainingMovement: 1 }),
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Moved Goblin 1 to (1, 1)"],
    });

    renderWithSnapshot(buildSnapshot({ activeTurnId: "enemy-1", movementState: buildMovementState() }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    pointerDragBetweenCells(4, 3, 0, 0, { pointerId: 102 });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/move",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0, dash: false }),
        }),
      );
    });
  });

  it("shows combat movement range immediately while dragging the active unit", async () => {
    renderWithSnapshot(buildSnapshot({ activeTurnId: "enemy-1", movementState: buildMovementState() }));

    await findMapToken("Goblin 1");
    const viewport = getMapViewport();
    expect(viewport.dataset.mapMode).toBe("idle");
    expect(Number(viewport.dataset.reachableNormal)).toBe(0);

    const start = mapPointForCell(viewport, 4, 3);
    const end = mapPointForCell(viewport, 3, 3);
    fireEvent.pointerDown(viewport, {
      pointerId: 105,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      ...start,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 105,
      pointerType: "mouse",
      buttons: 1,
      ...end,
    });

    await waitFor(() => {
      expect(Number(getMapViewport().dataset.reachableNormal)).toBeGreaterThan(0);
    });

    fireEvent.pointerUp(viewport, {
      pointerId: 105,
      pointerType: "mouse",
      button: 0,
      buttons: 0,
      ...start,
    });
  });

  it("party walks by dragging the selected leader while Party Walk mode is active", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 1,
    });
    const follower = buildEnemy({
      instance_id: "player-2",
      template_id: "player",
      name: "Player 2",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 2,
    });
    const movedSnapshot = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1", "player-2"],
      enemies: [
        buildEnemy({ ...player, grid_x: 4, grid_y: 1 }),
        buildEnemy({ ...follower, grid_x: 3, grid_y: 1 }),
      ],
      combatLog: ["Party walk: Player 1 led 2 PCs to (5, 2)."],
      partyWalk: {
        leaderId: "player-1",
        movedEntityIds: ["player-1", "player-2"],
        destination: { x: 4, y: 1 },
        actualDestination: { x: 4, y: 1 },
        stoppedForEncounter: false,
        revealedRoomIds: [],
        pendingEncounterRoomIds: [],
      },
    });

    renderWithSnapshot(buildSnapshot({ selectedId: "player-1", order: ["player-1", "player-2"], enemies: [player, follower] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/action/party-walk" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Player 1");
    await user.click(screen.getByRole("button", { name: "Party Walk" }));
    pointerDragBetweenCells(0, 1, 4, 1, { pointerId: 103 });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/action/party-walk",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ leaderId: "player-1", x: 4, y: 1 }),
        }),
      );
    });
    await waitFor(() => {
      expect(getMapViewport().dataset.selectedUnitIds).toBe("");
      expect(getMapViewport().dataset.mapMode).toBe("party-walk");
    });
  });

  it("party walks by dragging a non-selected player while Party Walk mode is active", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 1,
    });
    const follower = buildEnemy({
      instance_id: "player-2",
      template_id: "player",
      name: "Player 2",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 0,
      grid_y: 2,
    });
    const movedSnapshot = buildSnapshot({
      selectedId: "player-2",
      order: ["player-1", "player-2"],
      enemies: [
        buildEnemy({ ...player, grid_x: 3, grid_y: 1 }),
        buildEnemy({ ...follower, grid_x: 4, grid_y: 1 }),
      ],
      combatLog: ["Party walk: Player 2 led 2 PCs to (5, 2)."],
      partyWalk: {
        leaderId: "player-2",
        movedEntityIds: ["player-2", "player-1"],
        destination: { x: 4, y: 1 },
        actualDestination: { x: 4, y: 1 },
        stoppedForEncounter: false,
        revealedRoomIds: [],
        pendingEncounterRoomIds: [],
      },
    });

    renderWithSnapshot(buildSnapshot({ selectedId: "player-1", order: ["player-1", "player-2"], enemies: [player, follower] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/action/party-walk" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Player 2");
    await user.click(screen.getByRole("button", { name: "Party Walk" }));
    pointerDragBetweenCells(0, 2, 4, 1, { pointerId: 104 });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/action/party-walk",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ leaderId: "player-2", x: 4, y: 1 }),
        }),
      );
    });
    await waitFor(() => {
      expect(getMapViewport().dataset.selectedUnitIds).toBe("");
      expect(getMapViewport().dataset.mapMode).toBe("party-walk");
    });
  });

  it("opens and resolves the opportunity attack popup from a move response", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 1,
      grid_y: 0,
    });
    const enemies = [buildEnemy({ grid_x: 1, grid_y: 1 }), player];
    const pendingOpportunity = {
      phase: "choose",
      attackerId: "player-1",
      attackerName: "Mira",
      targetId: "enemy-1",
      targetName: "Goblin 1",
      attackerIsPlayer: true,
      targetIsPlayer: false,
      attackerPhysicalCards: false,
      baseDamage: 2,
      reach: 1,
      drawnCardIds: [],
      drawnText: [],
      summary: null,
      successCount: null,
      fateCount: null,
      useWillpower: null,
    };
    const pendingSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 1, remainingMovement: 5 }),
      order: ["enemy-1", "player-1"],
      enemies,
      pendingOpportunity,
      combatLog: ["Goblin 1 provokes an opportunity attack from Mira."],
    });
    const confirmSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 1, remainingMovement: 5 }),
      order: ["enemy-1", "player-1"],
      enemies,
      pendingOpportunity: {
        ...pendingOpportunity,
        phase: "confirm",
        drawnCardIds: ["hit-success-1", "hit-success-2", "hit-fail"],
        drawnText: ["Success", "Success", "Fail"],
        summary: { outcomes: { success: 2, fate: 0, fail: 1 }, energies: {} },
        successCount: 2,
        fateCount: 0,
      },
      combatLog: ["Mira resolves an opportunity hit draw against Goblin 1; waiting for confirmation."],
    });
    const resolvedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 2, remainingMovement: 4 }),
      order: ["enemy-1", "player-1"],
      enemies,
      combatLog: ["Opportunity Attack by Mira on Goblin 1: miss."],
    });
    const resolveBodies = [];

    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-1",
        movementState: buildMovementState(),
        order: ["enemy-1", "player-1"],
        enemies,
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
            return jsonResponse(pendingSnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/opportunity/resolve" && requestOptions?.method === "POST") {
            const body = JSON.parse(requestOptions.body);
            resolveBodies.push(body);
            return jsonResponse(body.useWillpower === false ? resolvedSnapshot : confirmSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Move" }));
    pointerClickMapCell(0, 0);

    expect(await screen.findByText("Opportunity Attack")).toBeInTheDocument();
    expect(screen.getByText("Goblin 1 moves away from Mira. Base DMG 2, reach 1, hit draw 3.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Attack" }));

    expect(await screen.findByText("Hit draw")).toBeInTheDocument();
    expect(screen.queryByText(/Willpower inzetten/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Precise hit" }));

    await waitFor(() => expect(resolveBodies).toEqual([{ action: "attack" }, { action: "attack", useWillpower: false }]));
  });

  it("shows automatic enemy opportunity attack resolution before wounds", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      hp_current: 1,
      hp_max: 5,
      grid_x: 1,
      grid_y: 1,
    });
    const goblin = buildEnemy({ grid_x: 2, grid_y: 1 });
    const goblinTwo = buildEnemy({
      instance_id: "enemy-2",
      name: "Goblin 2",
      grid_x: 2,
      grid_y: 0,
    });
    const movedSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      movementState: buildMovementState({ entityId: "player-1", movementUsed: 1, remainingMovement: 5 }),
      order: ["player-1", "enemy-1", "enemy-2"],
      enemies: [player, goblin, goblinTwo],
      opportunityEvents: [
        {
          attackerId: "enemy-1",
          attackerName: "Goblin 1",
          targetId: "player-1",
          targetName: "Mira",
          cardText: "Attack 3",
          damage: 3,
          damageToToughness: 3,
          special: false,
          unpreventable: false,
          stopped: false,
          reshuffled: false,
        },
        {
          attackerId: "enemy-2",
          attackerName: "Goblin 2",
          targetId: "player-1",
          targetName: "Mira",
          cardText: "Special Strike - Attack 4",
          damage: 4,
          damageToToughness: 4,
          special: true,
          unpreventable: true,
          stopped: true,
          reshuffled: false,
        },
      ],
      woundEvents: [
        {
          instanceId: "player-1",
          name: "Mira",
          wounds: 1,
          toughnessAfter: 2,
          toughnessMax: 5,
        },
        {
          instanceId: "player-1",
          name: "Mira",
          wounds: 1,
          toughnessAfter: 1,
          toughnessMax: 5,
        },
      ],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        activeTurnId: "player-1",
        movementState: buildMovementState({ entityId: "player-1" }),
        order: ["player-1", "enemy-1", "enemy-2"],
        enemies: [player, goblin, goblinTwo],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/entities/player-1/move" && requestOptions?.method === "POST") {
            return jsonResponse(movedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Mira");
    await user.click(screen.getByRole("button", { name: "Move" }));
    pointerClickMapCell(0, 1);

    expect(await screen.findByText("Enemy Opportunity Attacks")).toBeInTheDocument();
    expect(screen.getByText("2 attacks resolved - movement stopped")).toBeInTheDocument();
    expect(screen.getByText("Goblin 1 -> Mira")).toBeInTheDocument();
    expect(screen.getByText("Goblin 2 -> Mira")).toBeInTheDocument();
    expect(screen.getByText("Attack 3, 3 to Toughness.")).toBeInTheDocument();
    expect(screen.getByText("Attack 4, 4 to Toughness, unpreventable.")).toBeInTheDocument();
    expect(screen.getByText("Special: movement stopped.")).toBeInTheDocument();
    expect(screen.queryByText("Player Wounds")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(await screen.findByText("Player Wounds")).toBeInTheDocument();
    expect(screen.getByText(/gains 2 wounds/)).toBeInTheDocument();
    expect(screen.getByLabelText("Toughness 1/5 after wounds")).toBeInTheDocument();
  });

  it("uses final target toughness in the opportunity wound popup after later non-wound damage", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      toughness_current: 4,
      toughness_max: 4,
      grid_x: 1,
      grid_y: 1,
    });
    const finalPlayer = {
      ...player,
      toughness_current: 1,
      wound_counts: { hand: 1, discard: 0, draw_pile: 0, total: 1 },
    };
    const goblin = buildEnemy({ grid_x: 2, grid_y: 1 });
    const goblinTwo = buildEnemy({
      instance_id: "enemy-2",
      name: "Goblin 2",
      grid_x: 2,
      grid_y: 0,
    });
    const movedSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      movementState: buildMovementState({ entityId: "player-1", movementUsed: 1, remainingMovement: 0, movementStopped: true }),
      order: ["player-1", "enemy-1", "enemy-2"],
      enemies: [finalPlayer, goblin, goblinTwo],
      opportunityEvents: [
        {
          attackerId: "enemy-1",
          attackerName: "Goblin 1",
          targetId: "player-1",
          targetName: "Mira",
          cardText: "Dirty Stab - Attack 4",
          damage: 4,
          damageToToughness: 4,
          special: true,
          unpreventable: true,
          stopped: true,
          reshuffled: false,
        },
        {
          attackerId: "enemy-2",
          attackerName: "Goblin 2",
          targetId: "player-1",
          targetName: "Mira",
          cardText: "Attack 2",
          damage: 2,
          damageToToughness: 2,
          special: false,
          unpreventable: false,
          stopped: false,
          reshuffled: false,
        },
      ],
      woundEvents: [
        {
          instanceId: "player-1",
          name: "Mira",
          wounds: 1,
          toughnessAfter: 3,
          toughnessMax: 4,
        },
      ],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        activeTurnId: "player-1",
        movementState: buildMovementState({ entityId: "player-1" }),
        order: ["player-1", "enemy-1", "enemy-2"],
        enemies: [player, goblin, goblinTwo],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/entities/player-1/move" && requestOptions?.method === "POST") {
            return jsonResponse(movedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Mira");
    await user.click(screen.getByRole("button", { name: "Move" }));
    pointerClickMapCell(0, 1);

    expect(await screen.findByText("Enemy Opportunity Attacks")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(await screen.findByText("Player Wounds")).toBeInTheDocument();
    expect(screen.getByText(/gains 1 wound/)).toBeInTheDocument();
    expect(screen.getByLabelText("Toughness 1/4 after wounds")).toBeInTheDocument();
  });

  it("shows opportunity willpower choices without energy draw results", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Mira",
      image_url: "/images/anonymous.png",
      is_player: true,
      grid_x: 1,
      grid_y: 0,
    });
    const enemies = [buildEnemy({ grid_x: 1, grid_y: 1 }), player];
    const pendingOpportunity = {
      phase: "willpower",
      attackerId: "player-1",
      attackerName: "Mira",
      targetId: "enemy-1",
      targetName: "Goblin 1",
      attackerIsPlayer: true,
      targetIsPlayer: false,
      attackerPhysicalCards: false,
      baseDamage: 2,
      reach: 1,
      drawnCardIds: ["hf_void_fate_1", "hf_master_fate_1", "hf_martial_success_3"],
      drawnText: ["Void fate", "Master energy fate", "Martial 3 energy success"],
      summary: { outcomes: { success: 1, fate: 2, fail: 0 }, energies: { Martial: 3, Master: 1 } },
      successCount: 1,
      fateCount: 2,
      useWillpower: null,
    };
    const resolvedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 2, remainingMovement: 4 }),
      order: ["enemy-1", "player-1"],
      enemies,
      combatLog: ["Opportunity Attack by Mira on Goblin 1: hit."],
    });

    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-1",
        movementState: buildMovementState(),
        order: ["enemy-1", "player-1"],
        enemies,
        pendingOpportunity,
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/opportunity/resolve" && requestOptions?.method === "POST") {
            return jsonResponse(resolvedSnapshot);
          }
          return undefined;
        },
      },
    );

    expect(await screen.findByText("Hit draw")).toBeInTheDocument();
    expect(screen.queryByText("Master energy fate")).not.toBeInTheDocument();
    expect(screen.queryByText("Martial 3 energy success")).not.toBeInTheDocument();
    expect(screen.queryByText("Martial 3")).not.toBeInTheDocument();
    expect(screen.queryByText("Master 1")).not.toBeInTheDocument();
    expect(screen.getByText("Willpower inzetten voor critical hit")).toBeInTheDocument();
    expect(screen.queryByText("Willpower inzetten voor precise hit")).not.toBeInTheDocument();
    expect(screen.queryByText("Hit zonder willpower")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hit" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hit" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/opportunity/resolve",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "attack", useWillpower: false }),
        }),
      );
    });
  });

  it("does not offer diagonal movement past a target-corner wall", async () => {
    const user = userEvent.setup();
    const floor = { tile_type: "floor", door_open: false };
    const dungeon = buildDungeon({
      tiles: {
        "0,0": floor,
        "1,1": floor,
      },
      rooms: [{ room_id: "room-1", cells: [[0, 0], [1, 1]] }],
      walls: { "0,1,e": { wall_type: "wall", door_open: false } },
      extents: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 2, height: 2 },
    });
    const moveCalls = [];

    renderWithSnapshot(
      buildSnapshot({
        dungeon,
        activeTurnId: "enemy-1",
        movementState: buildMovementState(),
        enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
            moveCalls.push(JSON.parse(requestOptions.body));
            return jsonResponse(buildSnapshot({ dungeon }));
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(getMapViewport().dataset.reachableNormal).toBe("0");
    pointerClickMapCell(1, 1);
    expect(moveCalls).toEqual([]);
  });

  it("moves the selected unit onto a cell occupied only by a down unit", async () => {
    const user = userEvent.setup();
    const downEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Down Goblin",
      hp_current: 0,
      is_down: true,
      grid_x: 0,
      grid_y: 0,
    });
    const movedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 5, remainingMovement: 1 }),
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 }), downEnemy],
      combatLog: ["Moved Goblin 1 to (1, 1)"],
    });

    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-1",
        movementState: buildMovementState(),
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), downEnemy],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
            return jsonResponse(movedSnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/select") {
            throw new Error("Move onto down-only cell should not select the down unit");
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Move" }));
    pointerClickMapCell(0, 0);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/move",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0, dash: false }),
        }),
      );
    });
  });

  it("selects a down unit on the battle map outside move mode", async () => {
    const downEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Down Goblin",
      hp_current: 0,
      is_down: true,
      grid_x: 0,
      grid_y: 0,
    });
    const selectedSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), downEnemy],
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), downEnemy],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    pointerClickMapCell(0, 0);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/select",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ instanceId: "enemy-2" }),
        }),
      );
    });
    expect(await screen.findByText("Selected: Down Goblin")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draw" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Inspect loot" })).toBeEnabled();
  });

  it("selects a standing enemy before showing context actions on right-click", async () => {
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 5,
      grid_y: 3,
    });
    const selectedBanditSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), bandit],
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), bandit],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedBanditSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Bandit 1");
    pointerRightClickMapCell(5, 3);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/select",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ instanceId: "enemy-2" }),
        }),
      );
    });
    const menu = await screen.findByRole("menu", { name: "Unit actions for Bandit 1" });
    expect(within(menu).getByRole("menuitem", { name: "Attack unit" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Heal unit" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Reposition unit" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Show unit" })).toBeInTheDocument();
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Attack unit",
      "Heal unit",
      "Reposition unit",
      "Show unit",
    ]);
  });

  it("shows player and down enemy context actions", async () => {
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      hp_current: 0,
      hp_max: 0,
      armor_current: 0,
      armor_max: 0,
      magic_armor_current: 0,
      magic_armor_max: 0,
      guard_current: 0,
      draws_base: 0,
      effective_movement: 0,
      grid_x: 5,
      grid_y: 3,
    });
    const downEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Down Goblin",
      hp_current: 0,
      is_down: true,
      grid_x: 0,
      grid_y: 0,
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "player-1", "enemy-2"],
        enemies: [buildEnemy(), player, downEnemy],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            const { instanceId } = JSON.parse(requestOptions.body);
            return jsonResponse(
              buildSnapshot({
                selectedId: instanceId,
                order: ["enemy-1", "player-1", "enemy-2"],
                enemies: [buildEnemy(), player, downEnemy],
              }),
            );
          }
          return undefined;
        },
      },
    );

    await findMapToken("Player 1");
    pointerRightClickMapCell(5, 3);

    const playerMenu = await screen.findByRole("menu", { name: "Unit actions for Player 1" });
    expect(within(playerMenu).getByRole("menuitem", { name: "Attack player" })).toBeInTheDocument();
    expect(within(playerMenu).getByRole("menuitem", { name: "Heal player" })).toBeInTheDocument();
    expect(within(playerMenu).getByRole("menuitem", { name: "Reposition unit" })).toBeInTheDocument();
    expect(within(playerMenu).getByRole("menuitem", { name: "Show unit" })).toBeInTheDocument();
    expect(within(playerMenu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Attack player",
      "Heal player",
      "Reposition unit",
      "Show unit",
    ]);
    expect(within(playerMenu).queryByRole("menuitem", { name: "Inspect loot" })).not.toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    pointerRightClickMapCell(0, 0);

    const downMenu = await screen.findByRole("menu", { name: "Unit actions for Down Goblin" });
    expect(within(downMenu).getByRole("menuitem", { name: "Inspect loot" })).toBeInTheDocument();
    expect(within(downMenu).getByRole("menuitem", { name: "Reposition unit" })).toBeInTheDocument();
    expect(within(downMenu).getByRole("menuitem", { name: "Show unit" })).toBeInTheDocument();
    expect(within(downMenu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Inspect loot",
      "Reposition unit",
      "Show unit",
    ]);
    expect(within(downMenu).queryByRole("menuitem", { name: "Attack unit" })).not.toBeInTheDocument();
    expect(within(downMenu).queryByRole("menuitem", { name: "Heal unit" })).not.toBeInTheDocument();
  });

  it("opens a large unit preview from the context menu", async () => {
    const user = userEvent.setup();
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 5,
      grid_y: 3,
    });
    const selectedBanditSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), bandit],
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), bandit],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedBanditSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Bandit 1");
    pointerRightClickMapCell(5, 3);
    await user.click(await screen.findByRole("menuitem", { name: "Show unit" }));

    const previewImage = screen.getByRole("img", { name: "Bandit 1 preview" });
    const previewModal = previewImage.closest(".modal-shell");
    expect(within(previewModal).getByText("Bandit 1")).toBeInTheDocument();
    expect(within(previewModal).getByText("Bandit")).toBeInTheDocument();
    expect(previewImage).toHaveAttribute("src", "/images/Outlaws/bandit.png");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("img", { name: "Bandit 1 preview" })).not.toBeInTheDocument();
  });

  it("opens attack and heal modals from the unit context menu", async () => {
    const user = userEvent.setup();
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 5,
      grid_y: 3,
    });
    const selectedBanditSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), bandit],
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), bandit],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedBanditSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Bandit 1");
    pointerRightClickMapCell(5, 3);
    await user.click(await screen.findByRole("menuitem", { name: "Attack unit" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/select",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ instanceId: "enemy-2" }),
        }),
      );
    });
    expect(await screen.findByRole("button", { name: "Apply attack" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    pointerRightClickMapCell(5, 3);
    await user.click(await screen.findByRole("menuitem", { name: "Heal unit" }));

    expect(await screen.findByRole("button", { name: "Apply healing" })).toBeInTheDocument();
  });

  it("starts reposition for a context target and posts the selected target position", async () => {
    const user = userEvent.setup();
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 5,
      grid_y: 3,
    });
    const selectedBanditSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), bandit],
    });
    const repositionedSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), { ...bandit, grid_x: 0, grid_y: 0 }],
      combatLog: ["Repositioned Bandit 1 to (1, 1)"],
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), bandit],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedBanditSnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/entities/enemy-2/position" && requestOptions?.method === "POST") {
            return jsonResponse(repositionedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Bandit 1");
    pointerRightClickMapCell(5, 3);
    await user.click(await screen.findByRole("menuitem", { name: "Reposition unit" }));

    await waitFor(() => {
      expect(getMapViewport().dataset.mapMode).toBe("reposition");
    });
    pointerClickMapCell(0, 0);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-2/position",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0 }),
        }),
      );
    });
  });

  it("shows quick attack in a valid target context menu and posts it", async () => {
    const user = userEvent.setup();
    const attacker = buildEnemy({
      instance_id: "enemy-1",
      name: "Goblin 1",
      current_draw_text: ["Attack 3"],
      current_draw_attacks: [{ damage: 3, modifiers: [], label: "Attack 3" }],
    });
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 5,
      grid_y: 3,
    });
    const selectedBanditSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      activeTurnId: "enemy-1",
      turnInProgress: true,
      order: ["enemy-1", "enemy-2"],
      enemies: [attacker, bandit],
    });
    const attackedSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      activeTurnId: "enemy-1",
      turnInProgress: true,
      order: ["enemy-1", "enemy-2"],
      enemies: [attacker, { ...bandit, toughness_current: 7 }],
      quickAttackNotice: "Quick Attack: Goblin 1 attacks Bandit 1 with Attack 3.",
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "enemy-1",
        activeTurnId: "enemy-1",
        turnInProgress: true,
        order: ["enemy-1", "enemy-2"],
        enemies: [attacker, bandit],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedBanditSnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/turn/quick-attack" && requestOptions?.method === "POST") {
            return jsonResponse(attackedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Bandit 1");
    expect(screen.queryByRole("button", { name: "Quick Attack" })).not.toBeInTheDocument();
    pointerRightClickMapCell(5, 3);
    const menu = await screen.findByRole("menu", { name: "Unit actions for Bandit 1" });
    await user.click(within(menu).getByRole("menuitem", { name: "Quick Attack" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/turn/quick-attack",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Quick Attack: Goblin 1 attacks Bandit 1 with Attack 3.")).toBeInTheDocument();
  });

  it("keeps GM reposition mode active while selecting and placing units", async () => {
    const user = userEvent.setup();
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 5,
      grid_y: 3,
    });
    const selectedBanditSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), bandit],
    });
    const repositionedSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), { ...bandit, grid_x: 0, grid_y: 0 }],
      combatLog: ["Repositioned Bandit 1 to (1, 1)"],
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), bandit],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedBanditSnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/entities/enemy-2/position" && requestOptions?.method === "POST") {
            return jsonResponse(repositionedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Bandit 1");
    await user.click(screen.getByRole("button", { name: "GM Mode" }));
    expect(getMapViewport().dataset.mapMode).toBe("gm-reposition");

    pointerClickMapCell(5, 3);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/select",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ instanceId: "enemy-2" }),
        }),
      );
    });
    await waitFor(() => {
      expect(getMapViewport().dataset.mapMode).toBe("gm-reposition");
    });

    pointerClickMapCell(0, 0);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-2/position",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0 }),
        }),
      );
    });
    expect(screen.getByRole("button", { name: "Exit GM Mode" })).toBeInTheDocument();
    expect(getMapViewport().dataset.mapMode).toBe("gm-reposition");
  });

  it("lets GM reposition select and reveal a secret door edge", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon({
      walls: { "0,0,e": { wall_type: "secret_door", door_open: false, secret_discovered: false, secret_dc: 2 } },
    });
    const revealedDungeon = buildDungeon({
      walls: { "0,0,e": { wall_type: "secret_door", door_open: false, secret_discovered: true, secret_dc: 2 } },
    });
    const revealCalls = [];

    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 1, grid_y: 1 })] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/secret-doors/reveal" && requestOptions?.method === "POST") {
          revealCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({ dungeon: revealedDungeon }));
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "GM Mode" }));
    pointerClickMapEdge({ x: 0, y: 0, side: "e" });
    await user.click(await screen.findByRole("button", { name: "Reveal to players" }));

    expect(revealCalls).toEqual([{ x: 0, y: 0, side: "e" }]);
  });

  it("limits GM reposition dungeon targets to visible rooms", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon({
      tiles: {
        "0,0": { tile_type: "floor", door_open: false },
        "1,0": { tile_type: "floor", door_open: false },
        "3,0": { tile_type: "floor", door_open: false },
        "4,0": { tile_type: "floor", door_open: false },
      },
      rooms: [
        { room_id: "visible-room", cells: [[0, 0], [1, 0]] },
        { room_id: "hidden-room", cells: [[3, 0], [4, 0]] },
      ],
      revealedRoomIds: ["visible-room"],
      fogOfWarEnabled: true,
      currentPcRoomIds: ["visible-room"],
      visibleRoomIds: ["visible-room"],
      extents: { minX: 0, minY: 0, maxX: 4, maxY: 0, width: 5, height: 1 },
    });
    const goblin = buildEnemy({ grid_x: 0, grid_y: 0, room_id: "visible-room" });
    const movedSnapshot = buildSnapshot({
      dungeon,
      enemies: [{ ...goblin, grid_x: 1, grid_y: 0 }],
      combatLog: ["Repositioned Goblin 1 to (2, 1)"],
    });
    const positionCalls = [];

    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [goblin] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/position" && requestOptions?.method === "POST") {
          positionCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(movedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "GM Mode" }));

    pointerClickMapCell(3, 0, 93);
    expect(positionCalls).toEqual([]);

    pointerClickMapCell(1, 0, 94);
    await waitFor(() => {
      expect(positionCalls).toEqual([{ x: 1, y: 0 }]);
    });
  });

  it("inspects loot from a down enemy context menu and hides inspect after loot is known", async () => {
    const user = userEvent.setup();
    const downEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Down Goblin",
      hp_current: 0,
      is_down: true,
      grid_x: 0,
      grid_y: 0,
    });
    const selectedDownSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), downEnemy],
    });
    const lootedSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["enemy-1", "enemy-2"],
      enemies: [
        buildEnemy(),
        {
          ...downEnemy,
          loot_rolled: true,
          loot_state: "inspected",
          rolled_loot: { currency: { gold: 3 }, resources: {}, other: [] },
        },
      ],
      combatLog: ["Loot inspected for Down Goblin"],
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), downEnemy],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedDownSnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/entities/enemy-2/loot/inspect" && requestOptions?.method === "POST") {
            return jsonResponse(lootedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Down Goblin");
    pointerRightClickMapCell(0, 0);
    await user.click(await screen.findByRole("menuitem", { name: "Inspect loot" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-2/loot/inspect",
        expect.objectContaining({ method: "POST" }),
      );
    });

    pointerRightClickMapCell(0, 0);
    const menu = await screen.findByRole("menu", { name: "Unit actions for Down Goblin" });
    expect(within(menu).queryByRole("menuitem", { name: "Inspect loot" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Reposition unit" })).toBeInTheDocument();
  });

  it("takes inspected loot with the acting player from the context menu", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      is_player: true,
      grid_x: 1,
      grid_y: 0,
      inventory: { currency: {}, resources: {}, other: [] },
    });
    const downEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Down Goblin",
      hp_current: 0,
      is_down: true,
      grid_x: 0,
      grid_y: 0,
      loot_rolled: true,
      loot_state: "inspected",
      rolled_loot: { currency: { cp: 3 }, resources: {}, other: ["note"] },
    });
    const selectedEnemySnapshot = buildSnapshot({
      selectedId: "enemy-2",
      order: ["player-1", "enemy-2"],
      enemies: [player, downEnemy],
    });
    const takenSnapshot = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1", "enemy-2"],
      enemies: [
        {
          ...player,
          inventory: { currency: { cp: 3 }, resources: {}, other: ["note"] },
        },
        {
          ...downEnemy,
          loot_taken_by: "player-1",
          loot_taken_by_name: "Player 1",
          loot_state: "taken",
        },
      ],
      combatLog: ["Player 1 takes loot from Down Goblin."],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        order: ["player-1", "enemy-2"],
        enemies: [player, downEnemy],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedEnemySnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/entities/enemy-2/loot/take" && requestOptions?.method === "POST") {
            expect(JSON.parse(requestOptions.body)).toEqual({ playerId: "player-1" });
            return jsonResponse(takenSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Down Goblin");
    pointerRightClickMapCell(0, 0);
    await user.click(await screen.findByRole("menuitem", { name: "Take loot" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-2/loot/take",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ playerId: "player-1" }),
        }),
      );
    });
    expect(await screen.findByLabelText("Loot inventory")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Loot inventory"));
    expect(screen.getByText("cp: 3")).toBeInTheDocument();
    expect(screen.getByText("note")).toBeInTheDocument();
  });

  it("runs take loot through the combat action warning", async () => {
    const user = userEvent.setup();
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      is_player: true,
      grid_x: 1,
      grid_y: 0,
      actions_used: 2,
    });
    const downEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Down Goblin",
      hp_current: 0,
      is_down: true,
      grid_x: 0,
      grid_y: 0,
      loot_rolled: true,
      loot_state: "inspected",
      rolled_loot: { currency: { cp: 1 }, resources: {}, other: [] },
    });
    const selectedEnemySnapshot = buildSnapshot({
      selectedId: "enemy-2",
      activeTurnId: "player-1",
      encounterStarted: true,
      order: ["player-1", "enemy-2"],
      enemies: [player, downEnemy],
    });
    const takenSnapshot = buildSnapshot({
      selectedId: "player-1",
      activeTurnId: "player-1",
      encounterStarted: true,
      order: ["player-1", "enemy-2"],
      enemies: [{ ...player, actions_used: 3 }, { ...downEnemy, loot_taken_by: "player-1", loot_state: "taken" }],
    });

    renderWithSnapshot(
      buildSnapshot({
        selectedId: "player-1",
        activeTurnId: "player-1",
        encounterStarted: true,
        order: ["player-1", "enemy-2"],
        enemies: [player, downEnemy],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedEnemySnapshot);
          }
          if (url === "/api/battle/sessions/sid-123/entities/enemy-2/loot/take" && requestOptions?.method === "POST") {
            return jsonResponse(takenSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Down Goblin");
    pointerRightClickMapCell(0, 0);
    await user.click(await screen.findByRole("menuitem", { name: "Take loot" }));
    expect(await screen.findByText("Meer dan 2 acties")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Doorgaan" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-2/loot/take",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("shows inspect all loot out of combat for visible uninspected loot", async () => {
    const user = userEvent.setup();
    const downEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Down Goblin",
      hp_current: 0,
      is_down: true,
      grid_x: 0,
      grid_y: 0,
    });
    const inspectedSnapshot = buildSnapshot({
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), { ...downEnemy, loot_rolled: true, loot_state: "inspected" }],
    });

    renderWithSnapshot(
      buildSnapshot({
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), downEnemy],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/loot/inspect-all" && requestOptions?.method === "POST") {
            return jsonResponse(inspectedSnapshot);
          }
          return undefined;
        },
      },
    );

    await user.click(await screen.findByRole("button", { name: "Inspect all loot" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/loot/inspect-all",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("hides inspect all loot during combat", async () => {
    const downEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Down Goblin",
      hp_current: 0,
      is_down: true,
      grid_x: 0,
      grid_y: 0,
    });

    renderWithSnapshot(
      buildSnapshot({
        encounterStarted: true,
        activeTurnId: "enemy-1",
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), downEnemy],
      }),
    );

    await findMapToken("Down Goblin");
    expect(screen.queryByRole("button", { name: "Inspect all loot" })).not.toBeInTheDocument();
  });

  it("double-clicks a non-active standing enemy to open attack", async () => {
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 5,
      grid_y: 3,
    });
    const selectedBanditSnapshot = buildSnapshot({
      selectedId: "enemy-2",
      activeTurnId: "enemy-1",
      order: ["enemy-1", "enemy-2"],
      enemies: [buildEnemy(), bandit],
    });

    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-1",
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), bandit],
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            return jsonResponse(selectedBanditSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Bandit 1");
    pointerDoubleClickMapCell(5, 3);

    expect(await screen.findByRole("button", { name: "Apply attack" })).toBeInTheDocument();
  });

  it("does nothing special when double-clicking a player or down enemy", async () => {
    const player = buildEnemy({
      instance_id: "player-1",
      template_id: "player",
      name: "Player 1",
      image_url: "/images/anonymous.png",
      is_player: true,
      hp_current: 0,
      hp_max: 0,
      armor_current: 0,
      armor_max: 0,
      magic_armor_current: 0,
      magic_armor_max: 0,
      guard_current: 0,
      draws_base: 0,
      effective_movement: 0,
      grid_x: 5,
      grid_y: 3,
    });
    const downEnemy = buildEnemy({
      instance_id: "enemy-2",
      name: "Down Goblin",
      hp_current: 0,
      is_down: true,
      grid_x: 0,
      grid_y: 0,
    });
    const entities = [buildEnemy(), player, downEnemy];

    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-1",
        order: ["enemy-1", "player-1", "enemy-2"],
        enemies: entities,
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
            const { instanceId } = JSON.parse(requestOptions.body);
            return jsonResponse(
              buildSnapshot({
                selectedId: instanceId,
                activeTurnId: "enemy-1",
                order: ["enemy-1", "player-1", "enemy-2"],
                enemies: entities,
              }),
            );
          }
          return undefined;
        },
      },
    );

    await findMapToken("Player 1");
    pointerDoubleClickMapCell(5, 3);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Apply attack" })).not.toBeInTheDocument();

    pointerDoubleClickMapCell(0, 0);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Apply attack" })).not.toBeInTheDocument();
  });

  it("does not enter move mode when the selected unit is not active", async () => {
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 5,
      grid_y: 3,
      effective_movement: 6,
    });

    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-2",
        movementState: buildMovementState({ entityId: "enemy-2", baseMovement: 6, remainingMovement: 6 }),
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), bandit],
      }),
      {
        extraFetch: (url) => {
          if (url === "/api/battle/sessions/sid-123/select") {
            throw new Error("Clicking the already selected inactive unit should stay local");
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
    pointerClickMapCell(4, 3);

    expect(getMapViewport().dataset.mapMode).toBe("idle");
    expect(screen.queryByRole("button", { name: "Cancel Move" })).not.toBeInTheDocument();
  });

  it("disables movement when an opportunity attack stopped the active unit", async () => {
    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-1",
        movementState: buildMovementState({ movementUsed: 1, remainingMovement: 0, movementStopped: true }),
      }),
    );

    await findMapToken("Goblin 1");

    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
  });

  it("repositions the selected unit from the More menu without active-turn movement", async () => {
    const user = userEvent.setup();
    const repositionedSnapshot = buildSnapshot({
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Repositioned Goblin 1 to (1, 1)"],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/position" && requestOptions?.method === "POST") {
          return jsonResponse(repositionedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Reposition unit" }));
    expect(getMapViewport().dataset.mapMode).toBe("reposition");

    pointerClickMapCell(0, 0);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/position",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0 }),
        }),
      );
    });
  });

  it("confirms dash movement before posting a dash move", async () => {
    const user = userEvent.setup();
    const dashedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({
        movementUsed: 8,
        dashUsed: true,
        maxMovement: 12,
        remainingMovement: 4,
      }),
      enemies: [buildEnemy({ grid_x: 6, grid_y: 3 })],
      combatLog: ["Moved Goblin 1 to (7, 4) for 2 movement using Dash"],
    });

    renderWithSnapshot(
      buildSnapshot({
        activeTurnId: "enemy-1",
        movementState: buildMovementState({ movementUsed: 6, remainingMovement: 0 }),
      }),
      {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
            return jsonResponse(dashedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(Number(getMapViewport().dataset.reachableDash)).toBeGreaterThan(0);

    pointerClickMapCell(6, 3);
    expect(await screen.findByText("This movement requires a Dash action.")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/battle/sessions/sid-123/entities/enemy-1/move",
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(getMapViewport().dataset.mapMode).toBe("move");

    pointerClickMapCell(6, 3);
    await user.click(await screen.findByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/move",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 6, y: 3, dash: true }),
        }),
      );
    });
  });

  it("keeps a 99x99 battle map as a canvas surface without cell buttons", async () => {
    const user = userEvent.setup();
    const movedSnapshot = buildSnapshot({
      room: { columns: 99, rows: 99 },
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 5, remainingMovement: 1 }),
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Moved Goblin 1 to (1, 1)"],
    });

    renderWithSnapshot(buildSnapshot({ room: { columns: 99, rows: 99 }, activeTurnId: "enemy-1", movementState: buildMovementState() }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    expect(screen.queryAllByRole("button", { name: /^Cell / })).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Move" }));
    pointerClickMapCell(0, 0);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/move",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0, dash: false }),
        }),
      );
    });
  });

  it("does not capture click-only move targets before a drag starts", async () => {
    const user = userEvent.setup();
    const originalSetPointerCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "setPointerCapture");
    const originalReleasePointerCapture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "releasePointerCapture");
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const movedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 5, remainingMovement: 1 }),
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Moved Goblin 1 to (1, 1)"],
    });

    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: setPointerCapture,
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: releasePointerCapture,
    });

    try {
      renderWithSnapshot(buildSnapshot({ activeTurnId: "enemy-1", movementState: buildMovementState() }), {
        extraFetch: (url, requestOptions) => {
          if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
            return jsonResponse(movedSnapshot);
          }
          return undefined;
        },
      });

      await findMapToken("Goblin 1");
      await user.click(screen.getByRole("button", { name: "Move" }));
      const viewport = getMapViewport();
      const targetPoint = mapPointForCell(viewport, 0, 0);

      fireEvent.pointerDown(viewport, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, ...targetPoint });
      expect(setPointerCapture).not.toHaveBeenCalled();
      fireEvent.pointerUp(viewport, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 0, ...targetPoint });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          "/api/battle/sessions/sid-123/entities/enemy-1/move",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ x: 0, y: 0, dash: false }),
          }),
        );
      });
    } finally {
      if (originalSetPointerCapture) {
        Object.defineProperty(HTMLElement.prototype, "setPointerCapture", originalSetPointerCapture);
      } else {
        delete HTMLElement.prototype.setPointerCapture;
      }
      if (originalReleasePointerCapture) {
        Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", originalReleasePointerCapture);
      } else {
        delete HTMLElement.prototype.releasePointerCapture;
      }
    }
  });

  it("toggles move mode when clicking the already selected unit", async () => {
    const user = userEvent.setup();
    const movedSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 5, remainingMovement: 1 }),
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Moved Goblin 1 to (1, 1)"],
    });

    renderWithSnapshot(buildSnapshot({ activeTurnId: "enemy-1", movementState: buildMovementState() }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
          throw new Error("Selecting the active unit again should toggle move mode locally");
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    pointerClickMapCell(4, 3);

    expect(screen.getByRole("button", { name: "Cancel Move" })).toBeInTheDocument();

    pointerClickMapCell(0, 0);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/move",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0, dash: false }),
        }),
      );
    });
  });

  it("pans with left drag on an empty cell without moving the selected unit", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot({ room: { columns: 24, rows: 18 }, activeTurnId: "enemy-1", movementState: buildMovementState() }), {
      extraFetch: (url) => {
        if (url.includes("/move")) {
          throw new Error("Panning should not move a unit");
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Move" }));
    const viewport = getMapViewport();

    pointerDragFromCell(0, 0, -40, -50);

    expect(Number(viewport.dataset.cameraX)).toBe(-40);
    expect(Number(viewport.dataset.cameraY)).toBe(-50);
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/battle/sessions/sid-123/entities/enemy-1/move",
      expect.anything(),
    );
  });

  it("keeps normal move clicks working after a completed pan", async () => {
    const user = userEvent.setup();
    const movedSnapshot = buildSnapshot({
      room: { columns: 24, rows: 18 },
      activeTurnId: "enemy-1",
      movementState: buildMovementState({ movementUsed: 5, remainingMovement: 1 }),
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Moved Goblin 1 to (1, 1)"],
    });

    renderWithSnapshot(buildSnapshot({ room: { columns: 24, rows: 18 }, activeTurnId: "enemy-1", movementState: buildMovementState() }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/move" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Move" }));
    pointerDragFromCell(1, 0, -40, -50);

    pointerClickMapCell(0, 0);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/move",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0, dash: false }),
        }),
      );
    });
  });

  it("pans with middle drag on a token without selecting it", async () => {
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      hp_current: 14,
      hp_max: 16,
      grid_x: 6,
      grid_y: 4,
    });

    renderWithSnapshot(
      buildSnapshot({
        room: { columns: 24, rows: 18 },
        order: ["enemy-1", "enemy-2"],
        enemies: [buildEnemy(), bandit],
      }),
      {
        extraFetch: (url) => {
          if (url === "/api/battle/sessions/sid-123/select") {
            throw new Error("Middle-drag panning should not select a token");
          }
          return undefined;
        },
      },
    );

    await findMapToken("Goblin 1");
    const viewport = getMapViewport();
    await findMapToken("Bandit 1");

    pointerDragFromCell(6, 4, -30, -20, { pointerId: 2, button: 1, buttons: 4 });

    expect(Number(viewport.dataset.cameraX)).toBe(-30);
    expect(Number(viewport.dataset.cameraY)).toBe(-20);
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/battle/sessions/sid-123/select",
      expect.anything(),
    );
  });

  it("zooms with wheel and compact viewport controls", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot({ room: { columns: 24, rows: 18 } }));

    await findMapToken("Goblin 1");
    const viewport = getMapViewport();
    expect(viewport.dataset.cellSize).toBe("72");

    fireEvent.wheel(viewport, { deltaY: -120, clientX: 60, clientY: 60 });
    await waitFor(() => {
      expect(viewport.dataset.cellSize).toBe("76");
    });

    await user.click(screen.getByRole("button", { name: "Zoom in battle map" }));
    expect(viewport.dataset.cellSize).toBe("80");

    await user.click(screen.getByRole("button", { name: "Zoom out battle map" }));
    expect(viewport.dataset.cellSize).toBe("76");

    await user.click(screen.getByRole("button", { name: "Reset battle map zoom" }));
    expect(viewport.dataset.cellSize).toBe("72");
  });

  it("centers the selected unit from the viewport controls", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot({ room: { columns: 24, rows: 18 }, enemies: [buildEnemy({ grid_x: 12, grid_y: 9 })] }));

    await findMapToken("Goblin 1");
    const viewport = getMapViewport();

    await user.click(screen.getByRole("button", { name: "Center selected unit" }));

    expect(Number(viewport.dataset.cameraX)).toBeLessThan(0);
    expect(Number(viewport.dataset.cameraY)).toBeLessThan(0);
  });

  it("fits dungeon maps to visible rooms instead of the full dungeon", async () => {
    const user = userEvent.setup();
    const floor = { tile_type: "floor", door_open: false };
    const dungeon = buildDungeon({
      tiles: {
        "0,0": floor,
        "1,0": floor,
        "2,0": floor,
        "40,0": floor,
        "41,0": floor,
      },
      walls: { "1,0,e": { wall_type: "door", door_open: false } },
      rooms: [
        { room_id: "visible-near", cells: [[0, 0], [1, 0]] },
        { room_id: "hidden-adjacent", cells: [[2, 0]] },
        { room_id: "hidden-far", cells: [[40, 0], [41, 0]] },
      ],
      visibleRoomIds: ["visible-near"],
      currentPcRoomIds: [],
      linkedDoors: { "1,0,e": ["visible-near", "hidden-adjacent"] },
      extents: { minX: 0, minY: 0, maxX: 41, maxY: 0, width: 42, height: 1 },
    });

    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })] }));

    await screen.findByRole("button", { name: "Fit dungeon map" });
    const viewport = getMapViewport();
    await user.click(screen.getByRole("button", { name: "Fit dungeon map" }));

    const expectedCamera = expectedCameraForExtents({ minX: 0, minY: 0, maxX: 2, maxY: 0 });
    await waitFor(() => {
      expect(Number(viewport.dataset.cameraX)).toBeCloseTo(expectedCamera.x);
      expect(Number(viewport.dataset.cameraY)).toBeCloseTo(expectedCamera.y);
    });
  });

  it("fits dungeon maps to PC rooms plus directly adjacent visible rooms", async () => {
    const user = userEvent.setup();
    const floor = { tile_type: "floor", door_open: false };
    const dungeon = buildDungeon({
      tiles: {
        "0,0": floor,
        "1,0": floor,
        "2,0": floor,
        "3,0": floor,
        "0,1": floor,
        "40,0": floor,
        "41,0": floor,
      },
      walls: {
        "1,0,e": { wall_type: "door", door_open: false },
        "0,0,s": { wall_type: "door", door_open: false },
      },
      rooms: [
        { room_id: "pc-room", cells: [[0, 0], [1, 0]] },
        { room_id: "adjacent-visible", cells: [[2, 0], [3, 0]] },
        { room_id: "adjacent-hidden", cells: [[0, 1]] },
        { room_id: "visible-far", cells: [[40, 0], [41, 0]] },
      ],
      visibleRoomIds: ["pc-room", "adjacent-visible", "visible-far"],
      currentPcRoomIds: ["pc-room"],
      linkedDoors: {
        "1,0,e": ["pc-room", "adjacent-visible"],
        "0,0,s": ["pc-room", "adjacent-hidden"],
      },
      extents: { minX: 0, minY: 0, maxX: 41, maxY: 1, width: 42, height: 2 },
    });

    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })] }));

    await screen.findByRole("button", { name: "Fit dungeon map" });
    const viewport = getMapViewport();
    await user.click(screen.getByRole("button", { name: "Fit dungeon map" }));

    const expectedCamera = expectedCameraForExtents({ minX: 0, minY: 0, maxX: 3, maxY: 1 });
    await waitFor(() => {
      expect(Number(viewport.dataset.cameraX)).toBeCloseTo(expectedCamera.x);
      expect(Number(viewport.dataset.cameraY)).toBeCloseTo(expectedCamera.y);
    });
  });

  it("pinch zooms the map with two touch pointers", async () => {
    renderWithSnapshot(buildSnapshot({ room: { columns: 24, rows: 18 } }));

    await findMapToken("Goblin 1");
    const viewport = getMapViewport();

    fireEvent.pointerDown(viewport, { pointerId: 11, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerDown(viewport, { pointerId: 12, pointerType: "touch", clientX: 140, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 12, pointerType: "touch", clientX: 164, clientY: 100 });
    fireEvent.pointerUp(viewport, { pointerId: 11, pointerType: "touch" });
    fireEvent.pointerUp(viewport, { pointerId: 12, pointerType: "touch" });

    expect(Number.parseInt(viewport.dataset.cellSize, 10)).toBeGreaterThan(MAP_ZOOM.defaultSize);
  });

  it("switches GM Dungeon draw, select, and drag modes", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })] }));

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    const viewport = getMapViewport();
    expect(viewport.dataset.gmInteractionMode).toBe("draw");
    expect(screen.getByRole("button", { name: "Brush" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select" }));
    expect(viewport.dataset.gmInteractionMode).toBe("select");
    expect(screen.queryByRole("button", { name: "Brush" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Drag" }));
    expect(viewport.dataset.gmInteractionMode).toBe("drag");
    const beforeX = Number(viewport.dataset.cameraX);
    pointerDragFromCell(0, 0, 48, 0, { pointerId: 83 });

    await waitFor(() => {
      expect(Number(viewport.dataset.cameraX)).not.toBe(beforeX);
    });
  });

  it("opens visible map template save and load actions from Map Edit", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();

    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/map-templates" && (!requestOptions?.method || requestOptions.method === "GET")) {
          return jsonResponse({ templates: [{ id: "crypt", name: "Crypt", savedAt: "2026-06-13T12:00:00" }] });
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));

    expect(screen.queryByRole("button", { name: "Save Template" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Templates" }));

    expect(screen.getByText("Map Templates")).toBeInTheDocument();
    expect(screen.getByText("No template loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Crypt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save As" }));

    expect(screen.getByText("Save map as new template")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save As" })).toBeInTheDocument();
  });

  it("saves the active map template directly from the Map Templates modal", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    const saveCalls = [];

    renderWithSnapshot(buildSnapshot({
      dungeon,
      activeMapTemplate: {
        id: "crypt",
        filename: "crypt.json",
        name: "Crypt",
        savedAt: "2026-06-13T12:00:00",
        missing: false,
      },
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
    }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/map-templates" && (!requestOptions?.method || requestOptions.method === "GET")) {
          return jsonResponse({ templates: [{ id: "crypt", name: "Crypt", savedAt: "2026-06-13T12:00:00" }] });
        }
        if (url === "/api/battle/sessions/sid-123/dungeon/save-template/crypt" && requestOptions?.method === "POST") {
          saveCalls.push(url);
          return jsonResponse(buildSnapshot({
            dungeon,
            activeMapTemplate: {
              id: "crypt",
              filename: "crypt.json",
              name: "Crypt",
              savedAt: "2026-06-13T12:05:00",
              missing: false,
            },
            enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
          }));
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    await user.click(screen.getByRole("button", { name: "Templates" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(saveCalls).toEqual(["/api/battle/sessions/sid-123/dungeon/save-template/crypt"]);
    });
    expect(await screen.findByText("Map template saved")).toBeInTheDocument();
  });

  it("starts play from Map Edit without opening the session save guard", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    const startCalls = [];

    renderWithSnapshot(buildSnapshot({
      dungeon,
      sessionDirty: true,
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
    }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/start-play" && requestOptions?.method === "POST") {
          startCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({ dungeon, enemies: [] }));
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    await user.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Which PCs spawn?")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start with these PCs" }));

    await waitFor(() => {
      expect(startCalls).toEqual([{ players: [] }]);
    });
  });

  it("multiselects units in GM Dungeon Select mode with modifiers and rectangle select", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    const goblin = buildEnemy({ grid_x: 0, grid_y: 0 });
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 1,
      grid_y: 0,
    });
    const baseSnapshot = buildSnapshot({
      dungeon,
      enemies: [goblin, bandit],
      order: ["enemy-1", "enemy-2"],
    });

    renderWithSnapshot(baseSnapshot, {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
          const payload = JSON.parse(requestOptions.body);
          return jsonResponse({ ...baseSnapshot, selectedId: payload.instanceId });
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    await user.click(screen.getByRole("button", { name: "Select" }));
    const viewport = getMapViewport();
    expect(viewport.dataset.selectedUnitIds).toBe("enemy-1");

    pointerClickMapCell(1, 0, 84, { shiftKey: true });
    await waitFor(() => {
      expect(viewport.dataset.selectedUnitIds).toBe("enemy-1,enemy-2");
    });
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();

    pointerClickMapCell(1, 0, 85, { ctrlKey: true });
    await waitFor(() => {
      expect(viewport.dataset.selectedUnitIds).toBe("enemy-1");
    });

    pointerDragBetweenCells(0, 1, 1, 0, { pointerId: 86 });
    await waitFor(() => {
      expect(viewport.dataset.selectedUnitIds).toBe("enemy-1,enemy-2");
    });
  });

  it("moves selected GM Dungeon units with one batch position request", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon({
      tiles: {
        "0,0": { tile_type: "floor", door_open: false },
        "1,0": { tile_type: "floor", door_open: false },
        "2,0": { tile_type: "floor", door_open: false },
        "0,1": { tile_type: "floor", door_open: false },
        "1,1": { tile_type: "floor", door_open: false },
        "2,1": { tile_type: "floor", door_open: false },
      },
      rooms: [{ room_id: "room-1", cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]] }],
      extents: { minX: 0, minY: 0, maxX: 2, maxY: 1, width: 3, height: 2 },
    });
    const goblin = buildEnemy({ grid_x: 0, grid_y: 0 });
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/Outlaws/bandit.png",
      grid_x: 1,
      grid_y: 0,
    });
    let currentSnapshot = buildSnapshot({
      dungeon,
      enemies: [goblin, bandit],
      order: ["enemy-1", "enemy-2"],
    });
    const positionCalls = [];

    renderWithSnapshot(currentSnapshot, {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
          const payload = JSON.parse(requestOptions.body);
          currentSnapshot = { ...currentSnapshot, selectedId: payload.instanceId };
          return jsonResponse(currentSnapshot);
        }
        if (url === "/api/battle/sessions/sid-123/entities/positions" && requestOptions?.method === "POST") {
          const payload = JSON.parse(requestOptions.body);
          positionCalls.push(payload);
          const placements = new Map(payload.placements.map((placement) => [placement.instanceId, placement]));
          currentSnapshot = {
            ...currentSnapshot,
            selectedId: payload.placements[0]?.instanceId || currentSnapshot.selectedId,
            enemies: currentSnapshot.enemies.map((entity) => {
              const placement = placements.get(entity.instance_id);
              return placement ? { ...entity, grid_x: placement.x, grid_y: placement.y } : entity;
            }),
          };
          return jsonResponse(currentSnapshot);
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    await user.click(screen.getByRole("button", { name: "Select" }));
    pointerClickMapCell(1, 0, 87, { shiftKey: true });
    await waitFor(() => {
      expect(getMapViewport().dataset.selectedUnitIds).toBe("enemy-1,enemy-2");
    });

    pointerDragBetweenCells(0, 0, 1, 0, { pointerId: 88 });

    await waitFor(() => {
      expect(positionCalls).toEqual([
        {
          placements: [
            { instanceId: "enemy-1", x: 1, y: 0 },
            { instanceId: "enemy-2", x: 2, y: 0 },
          ],
        },
      ]);
    });
  });

  it("copies a single selected GM Dungeon enemy", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    const goblin = buildEnemy({ grid_x: 0, grid_y: 0 });
    const copiedGoblin = buildEnemy({
      instance_id: "enemy-copy",
      name: "Goblin 2",
      grid_x: 1,
      grid_y: 0,
    });
    const baseSnapshot = buildSnapshot({
      dungeon,
      enemies: [goblin],
      order: ["enemy-1"],
    });
    const copyCalls = [];

    renderWithSnapshot(baseSnapshot, {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/copy" && requestOptions?.method === "POST") {
          copyCalls.push(url);
          return jsonResponse({
            ...baseSnapshot,
            selectedId: "enemy-copy",
            enemies: [goblin, copiedGoblin],
            order: ["enemy-1", "enemy-copy"],
          });
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    await user.click(screen.getByRole("button", { name: "Select" }));
    const copyButton = screen.getByRole("button", { name: "Copy" });
    expect(copyButton).toBeEnabled();

    await user.click(copyButton);

    await waitFor(() => {
      expect(copyCalls).toEqual(["/api/battle/sessions/sid-123/entities/enemy-1/copy"]);
      expect(getMapViewport().dataset.selectedUnitIds).toBe("enemy-copy");
    });
  });

  it("paints dungeon cells at negative coordinates after panning", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/tiles" && requestOptions?.method === "POST") {
          return jsonResponse(buildSnapshot({ dungeon }));
        }
        if (url === "/api/battle/sessions/sid-123/dungeon/analyze" && requestOptions?.method === "POST") {
          return jsonResponse(buildSnapshot({ dungeon }));
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    pointerDragFromCell(0, 0, 100, 0, { pointerId: 81, button: 1, buttons: 4 });
    pointerClickMapCell(-1, 0, 82);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/dungeon/tiles",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ tileType: "floor", cells: [[-1, 0]] }),
        }),
      );
    });
  });

  it("rectangle-paints floor cells and keeps wall drawing edge-only", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/tiles" && requestOptions?.method === "POST") {
          return jsonResponse(buildSnapshot({ dungeon }));
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    await user.click(screen.getByRole("button", { name: "Rect" }));
    pointerDragBetweenCells(0, 0, 1, 1, { pointerId: 91 });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/dungeon/tiles",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ tileType: "floor", cells: [[0, 0], [1, 0], [0, 1], [1, 1]] }),
        }),
      );
    });

    await user.click(screen.getByRole("button", { name: "Walls" }));
    expect(screen.getByRole("button", { name: "Door" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rect" })).not.toBeInTheDocument();
  });

  it("posts wall edge strokes from GM Dungeon Walls submode", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    const wallCalls = [];
    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/walls" && requestOptions?.method === "POST") {
          wallCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({ dungeon }));
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    await user.click(screen.getByRole("button", { name: "Walls" }));
    await user.click(screen.getByRole("button", { name: "Door" }));
    pointerClickMapCell(0, 0, 93);

    await waitFor(() => {
      expect(wallCalls).toEqual([
        { wallType: "door", edges: [{ x: 0, y: 0, side: "e" }] },
      ]);
    });
  });

  it("keeps wall drag strokes on the first chosen grid line", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    const wallCalls = [];
    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/walls" && requestOptions?.method === "POST") {
          wallCalls.push(JSON.parse(requestOptions.body));
          return jsonResponse(buildSnapshot({ dungeon }));
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    await user.click(screen.getByRole("button", { name: "Walls" }));

    const viewport = getMapViewport();
    const start = mapPointForEdge(viewport, { x: 0, y: 0, side: "e" });
    const cornerWobble = mapPointForEdge(viewport, { x: 0, y: 0, side: "s" }, { along: 0.86 });
    const end = mapPointForEdge(viewport, { x: 0, y: 1, side: "e" });

    fireEvent.pointerDown(viewport, { pointerId: 94, pointerType: "mouse", button: 0, buttons: 1, ...start });
    fireEvent.pointerMove(viewport, { pointerId: 94, pointerType: "mouse", buttons: 1, ...cornerWobble });
    fireEvent.pointerMove(viewport, { pointerId: 94, pointerType: "mouse", buttons: 1, ...end });
    fireEvent.pointerUp(viewport, { pointerId: 94, pointerType: "mouse", button: 0, buttons: 0, ...end });

    await waitFor(() => {
      expect(wallCalls).toEqual([
        { wallType: "wall", edges: [{ x: 0, y: 0, side: "e" }, { x: 0, y: 1, side: "e" }] },
      ]);
    });
  });

  it("confirms very large rectangle tile edits before posting", async () => {
    const user = userEvent.setup();
    const dungeon = buildDungeon();
    renderWithSnapshot(buildSnapshot({ dungeon, enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })] }), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/dungeon/tiles" && requestOptions?.method === "POST") {
          return jsonResponse(buildSnapshot({ dungeon }));
        }
        return undefined;
      },
    });

    await user.click(await screen.findByRole("button", { name: "Map Edit" }));
    await user.click(screen.getByRole("button", { name: "Rect" }));
    pointerDragBetweenCells(0, 0, 50, 49, { pointerId: 92 });

    expect(await screen.findByText("Large tile edit")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/battle/sessions/sid-123/dungeon/tiles",
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Apply edit" }));

    await waitFor(() => {
      const tileCall = global.fetch.mock.calls.find(([url]) => url === "/api/battle/sessions/sid-123/dungeon/tiles");
      expect(JSON.parse(tileCall[1].body).cells).toHaveLength(2550);
    });
  });

  it("does not show the legacy map size control outside GM Dungeon mode", async () => {
    renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");
    expect(screen.queryByRole("button", { name: "Map size settings" })).not.toBeInTheDocument();
    expect(screen.queryByText("10 x 7")).not.toBeInTheDocument();
  });

  it("shows API errors from failed actions", async () => {
    const user = userEvent.setup();
    global.fetch.mockImplementation((url, requestOptions) => {
      if (url === "/api/battle/meta") {
        return jsonResponse(metaPayload);
      }
      if (url === "/api/battle/character-builder/catalog") {
        return jsonResponse(characterCatalogPayload);
      }
      if (url === "/api/battle/characters") {
        return jsonResponse({ characters: [] });
      }
      if (url === "/api/battle/sessions/sid-123") {
        return jsonResponse(buildSnapshot({ activeTurnId: "enemy-1", movementState: buildMovementState() }));
      }
      if (url === "/api/battle/sessions/sid-123/turn/draw" && requestOptions?.method === "POST") {
        return jsonResponse({ detail: "Another enemy has the active turn." }, { ok: false, status: 400, statusText: "Bad Request" });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    window.history.pushState({}, "", "/?sid=sid-123");
    render(<App />);

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Draw" }));

    expect(await screen.findByText("Another enemy has the active turn.")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Draw Card Inspector" })).not.toBeInTheDocument();
  });
});
