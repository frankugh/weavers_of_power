from pathlib import Path

from engine.loader import load_decks, load_enemies
from engine.runtime import spawn_enemy, roll_loot_for_enemy

ROOT = Path(__file__).parent
decks = load_decks(ROOT / "data" / "decks")
enemies = load_enemies(ROOT / "data" / "enemies", decks=decks, images_dir=ROOT / "images")

t = enemies["goblin"]

for i in range(10):
    g = spawn_enemy(t, decks)              # no seed
    roll_loot_for_enemy(g, t)              # no seed
    print(i, "hp=", g.hp_max, "loot=", g.rolled_loot)
