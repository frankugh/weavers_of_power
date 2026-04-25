import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App.jsx";

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
    image_url: "/images/goblin.png",
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
    ...overrides,
  };
}

const metaPayload = {
  enemyTemplates: [
    { id: "goblin", name: "Goblin", imageUrl: "/images/goblin.png" },
    { id: "bandit", name: "Bandit", imageUrl: "/images/bandit.png" },
    { id: "wraith", name: "Wraith", imageUrl: "/images/anonymous.png" },
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

function findMapToken(name) {
  return screen.findByRole("button", { name: new RegExp(`Cell .*: ${name}`) });
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
      image_url: "/images/bandit.png",
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

  it("renders separate selected and active turn indicators when different units are involved", async () => {
    const goblin = buildEnemy();
    const bandit = buildEnemy({
      instance_id: "enemy-2",
      template_id: "bandit",
      name: "Bandit 1",
      image_url: "/images/bandit.png",
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
    expect(screen.queryByAltText("Wraith")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add player card" })).toBeInTheDocument();
    expect(screen.queryByText(/\bmin\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bmax\b/i)).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "Add player card" }));

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
    await user.click(screen.getByRole("button", { name: "Show" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Shade");
    await user.clear(screen.getByLabelText("HP"));
    await user.type(screen.getByLabelText("HP"), "7");
    await user.click(screen.getByRole("button", { name: "Add custom enemy" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/enemies",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            custom: {
              name: "Shade",
              hp: 7,
              armor: 0,
              magicArmor: 0,
              draws: 1,
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
      image_url: "/images/bandit.png",
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
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Moved Goblin 1 to (1, 1)"],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/position" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        return undefined;
      },
    });

    await findMapToken("Goblin 1");
    await user.click(screen.getByRole("button", { name: "Move" }));
    await user.click(screen.getByRole("button", { name: "Cell 1, 1" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/entities/enemy-1/position",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ x: 0, y: 0 }),
        }),
      );
    });
    expect(await screen.findByRole("button", { name: "Cell 1, 1: Goblin 1" })).toBeInTheDocument();
  });

  it("toggles move mode when clicking the already selected unit", async () => {
    const user = userEvent.setup();
    const movedSnapshot = buildSnapshot({
      enemies: [buildEnemy({ grid_x: 0, grid_y: 0 })],
      combatLog: ["Moved Goblin 1 to (1, 1)"],
    });

    renderWithSnapshot(buildSnapshot(), {
      extraFetch: (url, requestOptions) => {
        if (url === "/api/battle/sessions/sid-123/entities/enemy-1/position" && requestOptions?.method === "POST") {
          return jsonResponse(movedSnapshot);
        }
        if (url === "/api/battle/sessions/sid-123/select" && requestOptions?.method === "POST") {
          throw new Error("Selecting the active unit again should toggle move mode locally");
        }
        return undefined;
      },
    });

    const selectedToken = await findMapToken("Goblin 1");
    await user.click(selectedToken);

    expect(screen.getByRole("button", { name: "Cancel Move" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cell 1, 1" }));

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
        return jsonResponse(buildSnapshot());
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
  });
});
