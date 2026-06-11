# Weapon System (v7)

## Core Rules

## The Deck

### Overview

Each character has a personal deck of cards that powers all their actions.
The deck serves two functions, and a card is read differently depending on context:

* During a **Draw of Power**: read the card's **energy type and value**
* During a **skill check** (hit draw): read the card's **skill result** (Success / Fate / Fail)

Skill check draws are independent of your hand and your energy pool. Those cards are drawn from the deck, read for their result, and then discarded. They do not enter your hand.

Some scry effects let you peek across both functions at once.

### Card Types

There are five **energy types**:

* Martial
* Elemental
* Radiance
* Nature
* Necromancy

A starting deck contains:

* **Energy cards** — bear one energy type and an energy value (1, sometimes 2)
* **Master Energy** — joker cards that count as any energy type **already in your deck**
* **Class card** — a strong free-action effect, e.g. Fighter: draw 1 card, then perform a Martial action as a free action
* **Race card** — a slightly weaker free-action effect, e.g. Human: draw 2 cards
* **Void cards** — no energy value, but they still carry a skill result, making them useful in hit draws

### Starting Deck Composition

All characters have **Martial** energy.

Your class typically prescribes a second energy type.

At character creation, you pick 1–2 additional types so your deck contains **3 energy types total**.

A 26-card starting deck contains:

* **15 Energy cards**

  * 5 cards of each of your 3 chosen energy types

* **2 Master Energy cards**

  * Master Energy can be used as any energy type already in your deck

* **1 Class card**

  * Strong class effect
  * Example: Fighter — draw 1 card and perform a Martial action as a free action

* **1 Race card**

  * Strong race effect, usually slightly weaker than a Class card
  * Example: Human — draw 2 cards

* **7 Void cards**

Total: **26 cards**

The skill-result distribution across these 26 cards is:

* **10 Success** cards
* **8 Fate** cards
* **8 Fail** cards

### Drawing and Hand Management

At the **start of your turn**, perform a **Draw of Power**: draw cards until your hand contains a number of cards equal to your **effective Power level**.

Your effective Power level starts at your base Power level (typically 4) and may be increased by ongoing effects, such as Strengthen overflow granting +1 draw next turn.

**Wounds in your hand count against this limit.** If your effective Power level is 6 and you hold 3 Wounds, you draw 3 fresh cards.

**Class and Race cards** in your hand may be played as free actions at any point on your turn. They cost no action.

### End of Turn

* Discard all unused non-Wound cards from your hand
* **Wounds remain in your hand** unless removed
* If a reshuffle was triggered this turn, reshuffle now

### Reshuffling

Some cards carry a **reshuffle effect**. In the example fighter deck, this appears on 1 Master Energy and 2 Void cards.

When such a card is drawn — whether during a Draw of Power or a skill check — it flags an end-of-turn reshuffle.

At end of turn, after the discard step, the discard pile is shuffled back into the deck.

* Cards in your hand, including Wounds, do **not** shuffle in
* Because reshuffle cards are guaranteed to surface before the deck empties, the deck never runs out under normal play

### Wounds

When damage exceeds your Toughness, you gain a **Wound card**.

* The Wound enters your **hand directly** — it does not pass through the deck first
* Wounds occupy hand slots, reducing how many fresh cards you draw on subsequent turns
* During skill checks, Wounds drawn from the deck count as **Fail** cards
* During Draws of Power, Wounds drawn from the deck enter your hand and stay there; they never function as free draw slots

### Removing Wounds

Wounds are persistent. Once you take one, it stays in your character's deck ecosystem until properly treated.

* The **Heal action** discards a Wound from your hand into the discard pile. This is **temporary relief**: it frees the hand slot for now, but the Wound will cycle back through the deck and return to your hand on a future Draw of Power
* **Heal spells, long rests, and medical aid** remove Wounds from your deck entirely

The compounding effect: each Wound you take shrinks your effective draw and skews your skill checks toward failure. The Heal action buys breathing room in the moment, but real recovery requires rest, magic, or care.

### Example Starting Deck

Example character energy types: **Martial, Elemental, Radiance**

| Card | Skill result | Extra effect |
|---|---:|---|
| Master Energy | Fate | Reshuffle your deck |
| Master Energy | Fate | — |
| Race card | Fate | Human: draw 2 cards |
| Class card | Fate | Fighter: draw 1 card and perform a Martial action as a free action |
| Martial 2 Energy | Success | — |
| Martial Energy | Success | — |
| Martial 2 Energy | Fate | — |
| Martial Energy | Fail | — |
| Martial 2 Energy | Fail | — |
| Elemental Energy | Success | — |
| Elemental Energy | Success | — |
| Elemental 2 Energy | Fate | — |
| Elemental Energy | Fail | — |
| Elemental Energy | Fail | — |
| Radiance Energy | Success | — |
| Radiance Energy | Success | — |
| Radiance 2 Energy | Fate | — |
| Radiance Energy | Fail | — |
| Radiance Energy | Fail | — |
| Void | Success | — |
| Void | Success | — |
| Void | Success | — |
| Void | Success | Reshuffle your deck |
| Void | Fate | — |
| Void | Fail | Reshuffle your deck |
| Void | Fail | — |

---

### Turn Structure & Resolution

### Turn Structure & Resolution

**Start of Turn**

* Perform a **Draw of Power**: draw cards until your hand contains a number of cards equal to your **effective Power level**
* Cards drawn this way provide their **energy type and value** for your turn

**On Your Turn**

* You have **movement** and **2 actions**
* Actions are either:

  * **Energy actions** (e.g., Martial Strike, Burn, Strengthen, Necrotic Strike, Vines, etc.)
  * **Non-energy actions**

**Performing an Energy Action**

* Spend **X energy** of a specific type from your Draw of Power
* For most actions, X determines the Base value of that action
* For weapon attacks, the weapon has a **Base DMG** value and surplus energy adds bonus DMG:

  * **DMG = weapon Base DMG + (X − 1)**
  * Example: a weapon with Base DMG 3 used with 3 energy deals **3 + 2 = 5 DMG** on a hit

### Action Resolution

**Offensive Actions**

* Offensive actions require a hit draw
* This includes attacks and hostile effects such as Strike, Elemental Strike, Burn, Cold, Whirlwind, Necrotic Strike, Sickness, and Vines
* When you perform an offensive action, draw **3 hit cards** by default
* Card results are: **Success / Fate / Fail**

**Defensive and Healing Actions**

* Defensive, healing, and supportive actions automatically succeed unless a specific rule says otherwise
* This includes Guard, Heal, Strengthen, Channel, and Stoneskin
* If defensive or healing actions prove too strong in play, they may be changed to use hit draws as well

**Vines**

* Vines require a hit draw when cast
* On a hit, the vines are placed
* Once placed, vines automatically deal their listed DMG when triggered

### Hit Draws

When cards are drawn as hit cards, only their skill result matters: **Success**, **Fate**, or **Fail**.

Hit draw cards are drawn from your deck, read for their result, and then discarded. They do not enter your hand and do not become part of your energy pool.

Wounds drawn during hit draws count as **Fail** cards.

### Advantage and Disadvantage

* **Advantage:** draw +1 hit card
* **Disadvantage:** draw −1 hit card
* Advantage and disadvantage do not stack

### Willpower

* You may spend **1 Willpower** (5 per day, 1 recovered on short rest)
* Convert all **Fate** results into **Successes**
* Willpower is a character resource, not a card
* Optional dungeon design may include Willpower recovery moments

### Outcome

* **0 Success**: Miss (no effect)
* **1+ Success**: Hit → apply **Base value** of the action/weapon
* **2+ Success**: Apply **weapon/ability bonus** (if any)
* **3 Success**: **Critical** (double DMG for attacks)

If more than 3 hit cards are drawn, choose the best 3 results for determining success count, bonuses, and criticals.

**Notes**

* Weapons/items define **Base values** and **bonuses**; the resolution rules are global
* Some weapons/abilities may place their bonus at **3+ Success** instead of 2+
* Special items may modify the number of cards drawn (e.g., draw 2 or draw 4)

---

## Toughness, Wounds, and Damage

* Characters have **Toughness**, not HP
* Damage is reduced in this order:

  1. Armor and Magic Armor
  2. Guard
  3. Toughness

* When your Toughness reaches 0, you gain **1 Wound**
* Excess damage after Toughness reaches 0 causes **1 additional Wound per DMG**
* After all Wounds from the damage instance are received, reset your Toughness

---

## Item Upgrades

* **Tier 1 (Mithril / Elven Wood):** +1
* **Tier 2 (Aestic / Ygdrasil Wood):** +2

Apply this bonus to **all Base values and tag effects** on the item (DMG, Guard, Armor, X-values, etc.).

---

## Defense Interaction

* **Stab:** ignore all normal armor
* **Overwhelm:** ignore all guard
* **Sunder:** guard reduction is doubled
* **Shatter:** destroy 1 armor
* **Pierce:** ignore up to 3 normal armor and/or guard
* **Magic Armor** cannot be ignored by Stab or Pierce

---

## Base Energy Actions

## Martial

### Strike X (Melee / Ranged)

* Make a weapon attack using X Martial energy
* DMG = weapon Base DMG + (X − 1)
* Unarmed: −3 DMG
* Close combat with a ranged weapon: −2 DMG

### Guard X

* Gain X Guard
* Guard is a damage reduction pool that depletes as damage is prevented

---

## Elemental

### Elemental Strike X (30 ft)

* Deal X DMG

### Burn X (30 ft)

* Apply X/2 Burn
* Burn deals unpreventable DMG at the start of the target’s turn
* After triggering, Burn is halved, rounded down
* Remaining Burn stays on the target

### Cold X (30 ft)

* Target has half movement on its next turn
* Target has -X DMG on its next attack

### Whirlwind X (30 ft)

* Push the target X ft directly away from you
* If the target is pushed into something and still has push movement remaining, it takes 1 DMG
* Large targets are pushed X/2 ft
* Huge targets are immune

### Stoneskin X

* Gain X/2 Armor until the start of your next turn

---

## Radiance

### Heal X

* Spend X healing points between:

  * Discarding Wound cards from your hand (1 point per Wound)
  * Removing Poison (1 point per Poison)

### Strengthen X

* Restore X Toughness
* If you are at max Toughness, each excess Strengthen point gives +1 draw on your next turn
* If you are at max bonus draw (which is +3 draw), each excess Strengthen point gives +1 Guard instead

---

## Nature

### Channel X (5 ft)

* Target yourself or an ally within range
* The next energy action of any type made by the target gains +X/2 energy
* The effect ends at the end of your next turn

### Vines X (15 ft)

* Target one 5x5 ft field within range
* Vines grow in that field
* When an enemy enters the field, it takes X DMG
* If vines are created in a field occupied by an enemy, that enemy takes X/2 DMG
* Entering the field immediately ends movement
* Vines have Toughness equal to your Power level
* If their Toughness becomes 0, they break and no longer deal DMG

---

## Necromancy

### Necrotic Strike X (15 ft)

* Deal X DMG
* For each point of DMG dealt, you may restore 1 Toughness to yourself

### Sickness X (15 ft)

* Apply X/2 Poison

### Necromancy Drawback

* After using a Necromancy action, you cannot be Strengthened or Healed by Radiance actions until the start of your next turn

---

## Armor

### Magic Robes

* Cost: 12 gp
* Gain **1 Magic Armor**

---

### Greater Magic Robes

* Cost: 30 gp
* Gain **2 Magic Armor**

---

### Leather

* Cost: 5 gp
* Passive: Gain 1 Guard at the start of your turn

---

### Studded Leather

* Cost: 8 gp
* Passive: Gain 2 Guard at the start of your turn

---

### Mail

* Cost: 20 gp
* Armor: 2
* Penalty: −1 draw on stealth checks

---

### Plate

* Cost: 40 gp
* Armor: 3
* Penalty: −1 draw on stealth checks and ranged attacks

---

**Notes:**

* **Passive Guard** is gained at the start of your turn
* **Armor** reduces DMG from all attacks
* **Magic Armor** cannot be ignored by Stab or Pierce

---

## Weapons (Martial)

### Dagger

* Cost: 1 gp
* Energy Types: Martial
* Tags: Stab
* Range: Melee
* Base DMG: 2

---

### Sword

* Cost: 10 gp
* Energy Types: Martial
* Tags: —
* Range: Melee
* Base DMG: 3
* 2+ success: Parry 1

---

### Longsword

* Cost: 15 gp
* Energy Types: Martial
* Tags: Versatile
* Range: Melee
* Base DMG: 3
* 2+ success: +1 DMG
* 3+ success: Parry 1

---

### Greatsword

* Cost: 25 gp
* Energy Types: Martial
* Tags: Two-Handed
* Range: Melee
* Base DMG: 5
* Attacks with this weapon draw one less card to hit
* Greatsword attacks can never draw more than 3 hit cards

---

### Axe

* Cost: 10 gp
* Energy Types: Martial
* Tags: Throwable
* Range: Melee / Throw
* Base DMG: 2
* 2+ success: Overwhelm

---

### Battleaxe

* Cost: 15 gp
* Energy Types: Martial
* Tags: Two-Handed
* Range: Melee
* Base DMG: 3
* 2+ success: Cleave (hit up to 2 adjacent enemies within 5 ft of you and each other)

---

### Mace

* Cost: 10 gp
* Energy Types: Martial
* Tags: Overwhelm
* Range: Melee
* Base DMG: 2

---

### Flail

* Cost: 12 gp
* Energy Types: Martial
* Tags: —
* Range: Melee
* Base DMG: 3
* 2+ success: Shatter

---

### Spear

* Cost: 12 gp
* Energy Types: Martial
* Tags: Versatile, Throwable
* Range: Reach (10 ft)
* Base DMG: 3
* Effect: +1 DMG when attacking a target that started your turn outside your reach

---

### Scimitar

* Cost: 12 gp
* Energy Types: Martial
* Tags: —
* Range: Melee
* Base DMG: 2
* 2+ success: Attack a second target within range, reusing the same energy but redrawing for hit
* This second attack cannot be modified by any spell, weapon, ability, or equipment, including this Scimitar effect
* The second attack cannot trigger another Scimitar attack
* The second attack can still critically hit on 3 successes

---

### Bow

* Cost: 15 gp
* Energy Types: Martial
* Tags: Pierce, Two-Handed
* Range: 40 / 80 ft
* Base DMG: 3
* Max range: disadvantage

---

### Longbow

* Cost: 20 gp
* Energy Types: Martial
* Tags: Pierce, Two-Handed
* Range: 80 / 160 ft
* Base DMG: 3
* Max range: disadvantage

---

### Crossbow

* Cost: 25 gp
* Energy Types: Martial
* Tags: Pierce, Two-Handed
* Range: 40 / 80 ft
* Base DMG: 5
* Reload: takes 2 actions to shoot
* Max range: disadvantage

---

### Sling

* Cost: 2 gp
* Energy Types: Martial
* Tags: —
* Range: 20 / 40 ft
* Base DMG: 2
* 2+ success: push

---

### Battlestaff

* Cost: 10 gp
* Energy Types: Martial
* Tags: Versatile
* Range: Melee
* Base DMG: 3
* 2+ success: Stagger (push target directly away from you)

---

### Shield

* Cost: 10 gp
* Energy Types: Martial
* Tags: —
* Passive: Gain 1 Guard at the start of your turn
* Guard Bonus: 2 (added to Guard actions)

---

## Energy-aligned Martial Weapon Variants

**Rule (simple balance):**

* This rule is used to create energy-aligned variants of existing Martial weapons such as swords, spears, axes, maces, etc.
* An energy-aligned variant has **−1 Base DMG on Martial strikes**
* It grants a **+1 bonus on one action of its energy type** (apply to Base value as specified)
* This rule does not modify staffs, wands, or orbs; those are separate item types with their own listed values

Example:

### Mace of Light (Radiance)

* Energy Types: Martial, Radiance
* Tags: Overwhelm
* Range: Melee
* Base DMG: 1
* Bonus: **+1** on all your **Strengthen** actions

---

## Elemental Staffs

(All staffs cost 15 gp)

### Fire Staff

* Energy Types: Martial, Elemental
* Tags: Versatile
* Base DMG (Martial): 2
* Base DMG (Elemental): 2
* 2+ success: Your Elemental Strikes may target 2 enemies that are directly adjacent to each other

---

### Ice Staff

* Energy Types: Martial, Elemental
* Tags: Versatile
* Base DMG (Martial): 2
* Base DMG (Elemental): 3
* 2+ success: Apply Slow

---

### Wind Staff

* Energy Types: Martial, Elemental
* Tags: Versatile
* Base DMG (Martial): 2
* Base DMG (Elemental): 3
* 2+ success: Push X

---

### Earth Staff

* Energy Types: Martial, Elemental
* Tags: Versatile
* Base DMG (Martial): 2
* Base DMG (Elemental): 2
* 2+ success: Gain +1 Armor until the start of your next turn

---

## Nature Weapons

(All staffs cost 15 gp)

### Thorn Staff

* Energy Types: Martial, Nature
* Tags: Versatile
* Base DMG (Martial): 2
* When you perform the Vines action you may cast them on 2 adjacent fields.
* 2+ success: Your Vines deal +1 DMG when triggered

---

### Totem Staff

* Energy Types: Martial, Nature
* Tags: Versatile
* Base DMG (Martial): 2
* 3+ success: Channel grants +X instead of +X/2

---

### Root Staff

* Energy Types: Martial, Nature
* Tags: Versatile
* Base DMG (Martial): 2
* When you perform the Vines action you may cast them on 2 adjacent fields.
* 2+ success: Vines created by you gain +2 Toughness

---

## Radiance Weapons

(All staffs cost 15 gp)

### Sun Staff

* Energy Types: Martial, Radiance
* Tags: Versatile
* Base DMG (Martial): 2
* 2+ success: Your Heal and Strengthen may target an additional ally within 5 ft of the original target (split X as you choose)

---

### Beacon Staff

* Energy Types: Martial, Radiance
* Tags: Versatile
* Base DMG (Martial): 2
* 2+ success: When you Strengthen, gain +1 additional draw next turn (this does not stack beyond your max bonus draw)

---

### Aegis Staff

* Energy Types: Martial, Radiance
* Tags: Versatile
* Base DMG (Martial): 2
* **+1** on all your **Strengthen** and **Heal** actions

---

## Necromancy Weapons

(All staffs cost 15 gp)

### Bone Staff

* Energy Types: Martial, Necromancy
* Tags: Versatile
* Base DMG (Martial): 2
* Base DMG (Necromancy): 3
* When a Necromancy action restores Toughness, this Toughness can exceed your maximum; any excess is lost at the start of your next turn.

---

### Blood Staff

* Energy Types: Martial, Necromancy
* Tags: Versatile
* Base DMG (Martial): 2
* Base DMG (Necromancy): 2
* 2+ success: Your Sickness applies +1 additional Poison

---

### Grave Staff

* Energy Types: Martial, Necromancy
* Tags: Versatile
* Base DMG (Martial): 2
* Base DMG (Necromancy): 3
* Your range for necrotic strikes is 40 ft

---

## Wands & Orbs

Wands & Orbs follow the same rules as Elemental Staffs, except:

* They cannot perform Martial strikes
* They do not have the Versatile tag

---

## Amulets (Energy Modifiers) (Energy Modifiers)

### Amulet of Focus

* Effect: +1 draw on actions of your **main energy type**

---

### Radiant Amulet

* Effect: Excess healing is converted to guard

---

### Necromancy Amulet

* Effect: Lifesteal effects restore +1 additional Toughness per success

---

### Elemental Core

* Effect: 2+ success on elemental strikes applies a status (burn, freeze, shock – GM/player choice or predefined)

---

### Nature Totem

* Effect: Summons gain +1 draw on their first action

---

### Martial Crest

* Effect: 2+ success on martial strikes grants +1 guard

