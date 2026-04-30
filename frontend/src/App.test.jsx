import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";
import { MAP_ZOOM, cellToWorld } from "./mapGeometry.js";

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
    effective_movement: 6,
    statuses: {},
    status_text: "-",
    current_draw_text: [],
    current_draw_attacks: [],
    quick_attack_used: false,
    last_draw_text: [],
    loot_rolled: false,
    rolled_loot: {},
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

function buildMovementState(overrides = {}) {
  return {
    entityId: "enemy-1",
    movementUsed: 0,
    diagonalStepsUsed: 0,
    dashUsed: false,
    baseMovement: 6,
    maxMovement: 6,
    remainingMovement: 6,
    ...overrides,
  };
}

const metaPayload = {
  enemyTemplates: [
    { id: "goblin", name: "Goblin", imageUrl: "/images/Greenskins/goblin.png", category: "Greenskins" },
    { id: "bandit", name: "Bandit", imageUrl: "/images/Outlaws/bandit.png", category: "Outlaws" },
    { id: "guard", name: "Guard", imageUrl: "/images/Realms_and_order/guard.png", category: "Realms_and_order" },
    { id: "soldier", name: "Soldier", imageUrl: "/images/Realms_and_order/soldier.png", category: "Realms_and_order" },
    { id: "wraith", name: "Wraith", imageUrl: "/images/anonymous.png", category: "Uncategorized" },
  ],
  decks: [{ id: "basic", name: "Basic Deck" }],
};

function renderWithSnapshot(snapshot, options = {}) {
  const { extraFetch = () => undefined, meta = metaPayload } = options;

  window.history.pushState({}, "", `/?sid=${snapshot.sid}`);
  global.fetch.mockImplementation((url, requestOptions) => {
    if (url === "/api/battle/meta") {
      return jsonResponse(meta);
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

function pointerClickMapCell(x, y, pointerId = 1) {
  const viewport = getMapViewport();
  const point = mapPointForCell(viewport, x, y);

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

async function openAddUnitModal(user) {
  await user.click(screen.getAllByRole("button", { name: "Add unit" })[0]);
}

describe("App", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/");
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
      if (url === "/api/battle/sessions" && requestOptions?.method === "POST") {
        return jsonResponse(buildSnapshot());
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(<App />);

    await screen.findByText("Battle Simulator");
    await screen.findByText("Round 1");

    expect(window.location.search).toContain("sid=sid-123");
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

  it("deletes manual saves from the load modal", async () => {
    const user = userEvent.setup();
    const save = {
      filename: "old_load_20260101_162506.json",
      label: "old_load_20260101_162506",
      savedAt: "2026-01-01T16:25:06+00:00",
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
          return jsonResponse({ saves: [] });
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Load" }));
    expect(await screen.findByText(save.label)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: `Delete save ${save.label}` }));

    await waitFor(() => {
      expect(screen.getByText("No manual saves found for this workspace.")).toBeInTheDocument();
    });
    expect(await screen.findByText("Manual save deleted")).toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: "Draw" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start encounter" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attack enemy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Heal enemy" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More" }));

    expect(screen.getByRole("menuitem", { name: "Redraw" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Reposition unit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Heal enemy" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Enemy turn (no draw)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "End turn" })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Roll loot" })).toBeInTheDocument();
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

  it("renders premade cards from meta without min max preview text", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);

    expect(screen.getByText("Add Unit")).toBeInTheDocument();
    expect(screen.getByAltText("Goblin")).toBeInTheDocument();
    expect(screen.getByAltText("Bandit")).toBeInTheDocument();
    expect(screen.getByAltText("Guard")).toBeInTheDocument();
    expect(screen.getByAltText("Soldier")).toBeInTheDocument();
    expect(screen.getByAltText("Wraith")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Player Character" })).toBeInTheDocument();
    expect(screen.queryByText(/\bmin\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bmax\b/i)).not.toBeInTheDocument();
  });

  it("filters premade templates by search and category", async () => {
    const user = userEvent.setup();
    renderWithSnapshot(buildSnapshot());

    await findMapToken("Goblin 1");
    await openAddUnitModal(user);

    await user.type(screen.getByLabelText("Search enemies"), "sold");
    expect(screen.getByAltText("Soldier")).toBeInTheDocument();
    expect(screen.queryByAltText("Goblin")).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search enemies"));
    await user.click(screen.getByRole("tab", { name: "Realms And Order" }));

    expect(screen.getByAltText("Guard")).toBeInTheDocument();
    expect(screen.getByAltText("Soldier")).toBeInTheDocument();
    expect(screen.queryByAltText("Goblin")).not.toBeInTheDocument();
    expect(screen.queryByAltText("Bandit")).not.toBeInTheDocument();
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
    const goblinCard = screen.getByAltText("Goblin").closest("button");
    if (!goblinCard) {
      throw new Error("Missing premade goblin card");
    }
    await user.click(goblinCard);

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
    await user.click(screen.getByAltText("Guard").closest("button"));

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
              power: 1,
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
    expect(screen.getByRole("button", { name: "Draw" })).toBeDisabled();
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
    expect(within(playerMenu).queryByRole("menuitem", { name: "Roll loot" })).not.toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    pointerRightClickMapCell(0, 0);

    const downMenu = await screen.findByRole("menu", { name: "Unit actions for Down Goblin" });
    expect(within(downMenu).getByRole("menuitem", { name: "Roll loot" })).toBeInTheDocument();
    expect(within(downMenu).getByRole("menuitem", { name: "Reposition unit" })).toBeInTheDocument();
    expect(within(downMenu).getByRole("menuitem", { name: "Show unit" })).toBeInTheDocument();
    expect(within(downMenu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Roll loot",
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
    await user.click(screen.getByRole("button", { name: "GM Reposition" }));
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
    expect(screen.getByRole("button", { name: "Exit GM" })).toBeInTheDocument();
    expect(getMapViewport().dataset.mapMode).toBe("gm-reposition");
  });

  it("rolls loot from a down enemy context menu and hides it after loot is rolled", async () => {
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
          rolled_loot: { currency: { gold: 3 }, resources: {}, other: [] },
        },
      ],
      combatLog: ["Loot rolled for Down Goblin"],
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
          if (url === "/api/battle/sessions/sid-123/loot" && requestOptions?.method === "POST") {
            return jsonResponse(lootedSnapshot);
          }
          return undefined;
        },
      },
    );

    await findMapToken("Down Goblin");
    pointerRightClickMapCell(0, 0);
    await user.click(await screen.findByRole("menuitem", { name: "Roll loot" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/loot",
        expect.objectContaining({ method: "POST" }),
      );
    });

    pointerRightClickMapCell(0, 0);
    const menu = await screen.findByRole("menu", { name: "Unit actions for Down Goblin" });
    expect(within(menu).queryByRole("menuitem", { name: "Roll loot" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Reposition unit" })).toBeInTheDocument();
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

  it("shows a resize warning and can confirm auto-placement", async () => {
    const user = userEvent.setup();
    const resizedSnapshot = buildSnapshot({
      room: { columns: 3, rows: 3 },
      enemies: [buildEnemy({ grid_x: 1, grid_y: 1 })],
      combatLog: ["Battle map resized to 3x3"],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/room" && requestOptions?.method === "POST") {
          const payload = JSON.parse(requestOptions.body);
          if (!payload.autoPlaceOutOfBounds) {
            return jsonResponse(
              { detail: "Resize would move 1 unit(s): Goblin 1" },
              { ok: false, status: 400, statusText: "Bad Request" },
            );
          }
          return jsonResponse(resizedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Map size settings" }));
    await user.clear(screen.getByLabelText("Map columns"));
    await user.type(screen.getByLabelText("Map columns"), "3");
    await user.clear(screen.getByLabelText("Map rows"));
    await user.type(screen.getByLabelText("Map rows"), "3");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByText("Resize would move 1 unit(s): Goblin 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Auto-place and resize" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/room",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ columns: 3, rows: 3, autoPlaceOutOfBounds: true }),
        }),
      );
    });
    expect(await screen.findByText("3 x 3")).toBeInTheDocument();
  });

  it("shows room validation errors from the API as readable text", async () => {
    const user = userEvent.setup();

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/room" && requestOptions?.method === "POST") {
          return jsonResponse(
            {
              detail: [
                {
                  loc: ["body", "columns"],
                  msg: "Input should be less than or equal to 30",
                },
              ],
            },
            { ok: false, status: 422, statusText: "Unprocessable Entity" },
          );
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Map size settings" }));
    await user.clear(screen.getByLabelText("Map columns"));
    await user.type(screen.getByLabelText("Map columns"), "60");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByText("columns: Input should be less than or equal to 30")).toBeInTheDocument();
  });

  it("shows API errors from failed actions", async () => {
    const user = userEvent.setup();
    global.fetch.mockImplementation((url, requestOptions) => {
      if (url === "/api/battle/meta") {
        return jsonResponse(metaPayload);
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
