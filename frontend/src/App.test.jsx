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
    status_text: "â€”",
    current_draw_text: [],
    last_draw_text: [],
    loot_rolled: false,
    rolled_loot: {},
    ...overrides,
  };
}

function buildSnapshot(overrides = {}) {
  const baseEnemy = {
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
    status_text: "—",
    current_draw_text: [],
    last_draw_text: [],
    loot_rolled: false,
    rolled_loot: {},
  };

  return {
    sid: "sid-123",
    round: 1,
    selectedId: "enemy-1",
    activeTurnId: null,
    turnInProgress: false,
    order: ["enemy-1"],
    enemies: [baseEnemy],
    combatLog: ["Goblin 1 is up next"],
    ...overrides,
  };
}

const metaPayload = {
  enemyTemplates: [{ id: "goblin", name: "Goblin" }],
  decks: [{ id: "basic", name: "Basic Deck" }],
};

function renderWithSnapshot(snapshot, extraFetch = () => undefined) {
  window.history.pushState({}, "", `/?sid=${snapshot.sid}`);
  global.fetch.mockImplementation((url, options) => {
    if (url === "/api/battle/meta") {
      return jsonResponse(metaPayload);
    }
    if (url === `/api/battle/sessions/${snapshot.sid}`) {
      return jsonResponse(snapshot);
    }
    const response = extraFetch(url, options);
    if (response !== undefined) {
      return response;
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  return render(<App />);
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
    global.fetch.mockImplementation((url, options) => {
      if (url === "/api/battle/meta") {
        return jsonResponse(metaPayload);
      }
      if (url === "/api/battle/sessions" && options?.method === "POST") {
        return jsonResponse(buildSnapshot());
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(<App />);

    await screen.findByText("Battle Simulator");
    await screen.findByText("Round 1");

    expect(window.location.search).toContain("sid=sid-123");
  });

  it("loads an existing sid, renders the snapshot, and disables player-only invalid actions", async () => {
    const playerSnapshot = buildSnapshot({
      selectedId: "player-1",
      order: ["player-1"],
      enemies: [
        {
          instance_id: "player-1",
          template_id: "player",
          name: "Player 1",
          image_url: "/images/anonymous.png",
          is_player: true,
          is_down: false,
          hp_current: 0,
          hp_max: 0,
          armor_current: 0,
          armor_max: 0,
          magic_armor_current: 0,
          magic_armor_max: 0,
          guard_current: 0,
          draws_base: 0,
          effective_movement: 0,
          statuses: {},
          status_text: "—",
          current_draw_text: [],
          last_draw_text: [],
          loot_rolled: false,
          rolled_loot: {},
        },
      ],
      combatLog: ["Player 1 is up next"],
    });

    window.history.pushState({}, "", "/?sid=player-sid");
    global.fetch.mockImplementation((url) => {
      if (url === "/api/battle/meta") {
        return jsonResponse(metaPayload);
      }
      if (url === "/api/battle/sessions/player-sid") {
        return jsonResponse({ ...playerSnapshot, sid: "player-sid" });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    render(<App />);

    await screen.findByRole("heading", { name: "Player 1" });
    expect(screen.getByRole("button", { name: "Attack enemy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Heal enemy" })).toBeDisabled();
    expect(screen.getByText("Player 1 is up next")).toBeInTheDocument();
  });

  it("renders a clear selected-only state when no active turn exists", async () => {
    const { container } = renderWithSnapshot(buildSnapshot());

    await screen.findByRole("heading", { name: "Goblin 1" });

    expect(screen.getByText("Selected: Goblin 1")).toBeInTheDocument();
    expect(screen.queryByText("Active Turn: Goblin 1")).not.toBeInTheDocument();
    expect(container.querySelector(".hero-card[data-state='state-selected']")).toBeInTheDocument();
    expect(container.querySelector(".initiative-row[data-state='state-selected']")).toHaveTextContent("Goblin 1");
    expect(container.querySelector(".roster-card[data-state='state-selected']")).toHaveTextContent("Goblin 1");
    expect(container.querySelector(".selected-stat-grid")).toHaveTextContent("HP");
    expect(container.querySelector(".selected-stat-grid")).toHaveTextContent("Move");
    expect(screen.getAllByText("Current Draw").length).toBeGreaterThan(0);
    expect(screen.queryByText("Last Draw")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move Goblin 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Goblin 1 down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Goblin 1" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Move up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move down" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("renders a combined selected and active state when the focused unit has the turn", async () => {
    const dualSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      turnInProgress: true,
      combatLog: ["Goblin 1 starts its turn"],
    });
    const { container } = renderWithSnapshot(dualSnapshot);

    await screen.findByRole("heading", { name: "Goblin 1" });

    expect(screen.getByText("Selected: Goblin 1")).toBeInTheDocument();
    expect(screen.getByText("Active Turn: Goblin 1")).toBeInTheDocument();
    expect(screen.getAllByText("Selected + Active").length).toBeGreaterThan(0);
    expect(container.querySelector(".hero-card[data-state='state-dual']")).toBeInTheDocument();
    expect(container.querySelector(".initiative-row[data-state='state-dual']")).toHaveTextContent("Goblin 1");
    expect(container.querySelector(".roster-card[data-state='state-dual']")).toHaveTextContent("Goblin 1");
  });

  it("keeps the active turn visible when manually selecting another unit", async () => {
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
    });
    const activeGoblinSnapshot = buildSnapshot({
      activeTurnId: "enemy-1",
      turnInProgress: true,
      order: ["enemy-1", "enemy-2"],
      enemies: [goblin, bandit],
      combatLog: ["Goblin 1 starts its turn"],
    });
    const selectedBanditSnapshot = {
      ...activeGoblinSnapshot,
      selectedId: "enemy-2",
    };

    const { container } = renderWithSnapshot(activeGoblinSnapshot, (url, options) => {
      if (url === "/api/battle/sessions/sid-123/select" && options?.method === "POST") {
        return jsonResponse(selectedBanditSnapshot);
      }
      return undefined;
    });

    await screen.findByRole("heading", { name: "Goblin 1" });
    await user.click(screen.getAllByRole("button", { name: /Bandit 1/i })[0]);

    await screen.findByRole("heading", { name: "Bandit 1" });

    expect(screen.getByText("Selected: Bandit 1")).toBeInTheDocument();
    expect(screen.getByText("Active Turn: Goblin 1")).toBeInTheDocument();
    expect(screen.getAllByText("Turn: Goblin 1")).toHaveLength(2);
    expect(screen.queryByText("Bandit 1 is selected, but Goblin 1 currently has the turn.")).not.toBeInTheDocument();
    expect(container.querySelector(".initiative-row[data-state='state-active']")).toHaveTextContent("Goblin 1");
    expect(container.querySelector(".initiative-row[data-state='state-selected']")).toHaveTextContent("Bandit 1");
    expect(container.querySelector(".roster-card[data-state='state-active']")).toHaveTextContent("Goblin 1");
    expect(container.querySelector(".roster-card[data-state='state-selected']")).toHaveTextContent("Bandit 1");
  });

  it("submits the attack dialog and refreshes the snapshot", async () => {
    const user = userEvent.setup();
    global.fetch.mockImplementation((url, options) => {
      if (url === "/api/battle/meta") {
        return jsonResponse(metaPayload);
      }
      if (url === "/api/battle/sessions/sid-123") {
        return jsonResponse(buildSnapshot());
      }
      if (url === "/api/battle/sessions/sid-123/attack" && options?.method === "POST") {
        return jsonResponse(
          buildSnapshot({
            combatLog: ["Attack on Goblin 1: 3 in, 3 to HP, HP 10->7"],
            enemies: [
              {
                ...buildSnapshot().enemies[0],
                hp_current: 7,
                last_draw_text: ["Attack 3"],
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    window.history.pushState({}, "", "/?sid=sid-123");
    render(<App />);

    await screen.findByRole("heading", { name: "Goblin 1" });
    await user.click(screen.getByRole("button", { name: "Attack enemy" }));
    await user.clear(screen.getByLabelText("Damage"));
    await user.type(screen.getByLabelText("Damage"), "3");
    await user.click(screen.getByRole("button", { name: "Apply attack" }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/battle/sessions/sid-123/attack",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Attack on Goblin 1: 3 in, 3 to HP, HP 10->7")).toBeInTheDocument();
  });

  it("shows API errors from failed actions", async () => {
    const user = userEvent.setup();
    global.fetch.mockImplementation((url, options) => {
      if (url === "/api/battle/meta") {
        return jsonResponse(metaPayload);
      }
      if (url === "/api/battle/sessions/sid-123") {
        return jsonResponse(buildSnapshot());
      }
      if (url === "/api/battle/sessions/sid-123/turn/draw" && options?.method === "POST") {
        return jsonResponse({ detail: "Another enemy has the active turn." }, { ok: false, status: 400, statusText: "Bad Request" });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    window.history.pushState({}, "", "/?sid=sid-123");
    render(<App />);

    await screen.findByRole("heading", { name: "Goblin 1" });
    await user.click(screen.getByRole("button", { name: "Draw" }));

    expect(await screen.findByText("Another enemy has the active turn.")).toBeInTheDocument();
  });
});
