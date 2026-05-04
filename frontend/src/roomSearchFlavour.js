export const roomSearchFlavour = {
  searchRoom: {
    found: {
      secretDoor: [
        "Your search reveals a hairline seam in the wall. A secret door waits there.",
        "A concealed mechanism clicks beneath your hand. Part of the wall shifts open.",
        "You spot the trick in the stonework. This wall hides a door.",
        "Your fingers find the one stone that gives way. Somewhere inside the wall, something unlocks.",
        "What looked like solid masonry resolves into edges, hinges, and intent.",
        "A quiet click answers your search. The wall was never meant to stay closed.",
        "The pattern in the stone suddenly makes sense. A hidden doorway reveals itself.",
        "You press against a worn mark in the wall. With a low scrape, a secret passage opens.",
        "The room gives up its secret: a door hidden where no door should be.",
        "You find the catch, small and clever, tucked into the stonework.",
      ],

      suspect: [
        "Something along the wall catches your eye.",
        "A faint irregularity in the wall draws your attention.",
        "One section of the wall does not quite match the rest.",
        "Your gaze stops on a strange mark near the wall.",
        "There is something odd about the stonework here.",
        "A subtle line in the wall refuses to blend in with the rest.",
        "You notice a detail that feels deliberately hidden.",
        "The wall gives you the uneasy sense that it is not telling the whole truth.",
        "A patch of shadow near the wall seems just a little too neat.",
        "Something about this part of the room invites a closer look.",
        "The stones here sit almost perfectly — too perfectly.",
        "A small flaw in the wall keeps pulling your attention back.",
      ],
    },

    nothingFound: [
      "You search the room, but find nothing hidden.",
      "Dust, stone, old scratches. Nothing useful reveals itself.",
      "You check the walls, floor, and shadows, but uncover no secrets.",
      "The room offers no answer.",
      "Nothing here seems worth a closer look.",
      "Your search turns up no hidden feature.",
      "You make a careful sweep of the room. Whatever secrets it has, none reveal themselves.",
      "You inspect the room from corner to corner and find no sign of a hidden feature.",
      "For a moment the silence feels promising, but your search turns up nothing unusual.",
      "You study the room carefully. If there is a secret here, it is buried deeper than sight.",
      "The details blur into ordinary stone, dust, and age.",
      "You look twice, then a third time. Nothing answers your suspicion.",
    ],
  },

  investigateSuspect: {
    found: {
      secretDoor: [
        "You find the hidden mechanism. With a soft click, part of the wall shifts.",
        "Your fingers trace the seam until the trick of it becomes clear. This is a secret door.",
        "A concealed latch gives beneath your touch. The wall was never just a wall.",
        "You press the right stone, and the hidden doorway reveals itself.",
        "The strange marks resolve into a mechanism. A secret passage opens before you.",
        "You discover the catch hidden in the wall. The secret door yields.",
        "The illusion of solid stone breaks. There is a door here, cleverly hidden.",
        "You hear a quiet internal shift as the wall unlocks.",
        "The suspicious detail becomes a pattern, then a mechanism, then a door.",
        "Your patience pays off. The wall opens where no opening should be.",
      ],

      falseSuspect: [
        "After a closer look, the mark proves to be nothing more than old damage.",
        "The suspicious seam is only a crack in the stone.",
        "You study it carefully and decide there is no mechanism here.",
        "What seemed hidden at first is only a trick of light and wear.",
        "The pattern looked deliberate, but closer inspection reveals nothing useful.",
        "You test the wall and find no latch, hinge, hollow space, or secret.",
        "The strange detail loses its mystery under careful examination.",
        "It was worth checking, but this part of the wall is ordinary after all.",
        "The wall's secret turns out to be no secret at all.",
        "You follow the mark to its end and find only chipped stone.",
      ],
    },

    unresolved: [
      "You examine the spot, but cannot make sense of it.",
      "There may be a mechanism here, but if so, it remains beyond your grasp.",
      "You search for a latch, seam, or hidden catch, but the wall keeps its answer.",
      "The more you study it, the less certain you become.",
      "Something might be hidden here. Or nothing. You cannot tell.",
      "You test the suspicious area carefully, but nothing responds.",
      "You feel close to understanding it, then the pattern slips away.",
      "If this is a secret door, its mechanism stays hidden from you.",
      "You cannot prove there is anything here, but neither can you shake the suspicion.",
      "The wall remains silent, leaving you with doubt instead of answers.",
      "Every mark seems meaningful until you try to read it.",
      "You step back unsure whether you found a clue or invented one.",
    ],
  },
};

export function pickSearchFlavour(payload) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  if (payload?.searchResolved) {
    const { outcome } = payload.searchResolved;
    if (outcome === "discovered") return pick(roomSearchFlavour.searchRoom.found.secretDoor);
    // true_suspect and false_suspect both show the suspect text — the player can't tell which it is
    if (outcome === "true_suspect" || outcome === "false_suspect") return pick(roomSearchFlavour.searchRoom.found.suspect);
    return pick(roomSearchFlavour.searchRoom.nothingFound);
  }
  if (payload?.suspectInteraction) {
    const { outcome, kind, score } = payload.suspectInteraction;
    if (outcome === "discovered") return pick(roomSearchFlavour.investigateSuspect.found.secretDoor);
    // cleared = false suspect beaten; exhausted false suspect with 2+ successes = player saw through it
    if (outcome === "cleared" || (outcome === "exhausted" && kind === "false" && score >= 2)) {
      return pick(roomSearchFlavour.investigateSuspect.found.falseSuspect);
    }
    return pick(roomSearchFlavour.investigateSuspect.unresolved);
  }
  return null;
}
