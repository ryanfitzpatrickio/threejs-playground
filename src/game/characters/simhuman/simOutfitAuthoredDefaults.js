/**
 * Authored fit defaults for showcase / first-class outfits.
 * Applied when the user selects that outfit in the wardrobe so neck/sleeve/leg
 * loop cuts and limb reveal survive re-select (they live on the outfit, not only
 * on a one-time preset snapshot).
 */
export const SIM_OUTFIT_AUTHORED_DEFAULTS = Object.freeze({
  "executive-suit": {
    "outfitLoopCuts": [
      {
        "id": "loop-mrnnl38q",
        "target": "torso",
        "interpolation": "smooth",
        "hideSide": "positive",
        "edgeInset": 0.02,
        "frame": {
          "origin": [
            0,
            0,
            0
          ],
          "axis": [
            0,
            1,
            0
          ],
          "u": [
            1,
            0,
            0
          ],
          "v": [
            0,
            0,
            -1
          ]
        },
        "points": [
          [
            0.011232829324627672,
            2.9793071303619585,
            0.12107480742812424
          ],
          [
            0.09060197351604016,
            3.021703641496453,
            0.06132484020932112
          ],
          [
            0.12395345959703966,
            3.0830314384646256,
            -0.040188004678298084
          ],
          [
            0.07661150240363811,
            3.1059828064506725,
            -0.10458467162528318
          ],
          [
            -0.07927706441388914,
            3.1069082940338633,
            -0.10575630334991182
          ],
          [
            -0.13085451470098708,
            3.0633656611105904,
            -0.008809307350734598
          ],
          [
            -0.06991300536671835,
            2.990509509703017,
            0.09205532230719911
          ]
        ]
      },
      {
        "id": "loop-mrnodftc",
        "target": "rightArm",
        "interpolation": "sharp",
        "hideSide": "positive",
        "edgeInset": -0.015,
        "frame": {
          "origin": [
            -0.4210636115939713,
            2.796890100618105,
            -0.06741680705941462
          ],
          "axis": [
            -0.9824321350007199,
            -0.1856963069325237,
            -0.018546743906927243
          ],
          "u": [
            -0.1856632252616667,
            0.9826071858029646,
            -0.0035050240817496815
          ],
          "v": [
            0.018875033863884536,
            -4.336808689942019e-19,
            -0.9998218506797285
          ]
        },
        "points": [
          [
            -1.3324368080525244,
            2.722114497081802,
            -0.09582668729175285
          ],
          [
            -1.3032418582176621,
            2.6717876289315114,
            0.03427817928945151
          ],
          [
            -1.3307230417697222,
            2.59851617742825,
            -0.17697927775651723
          ]
        ]
      },
      {
        "id": "loop-mrnofguw",
        "target": "leftArm",
        "interpolation": "sharp",
        "hideSide": "positive",
        "edgeInset": -0.07,
        "frame": {
          "origin": [
            0.4210636115939713,
            2.796890100618105,
            -0.06741680705941462
          ],
          "axis": [
            0.9824321350007199,
            -0.1856963069325237,
            -0.018546743906927243
          ],
          "u": [
            0.1856632252616667,
            0.9826071858029646,
            -0.0035050240817496815
          ],
          "v": [
            0.018875033863884536,
            4.336808689942019e-19,
            0.9998218506797285
          ]
        },
        "points": [
          [
            1.3852488825628821,
            2.6627732650929623,
            0.04265171610756152
          ],
          [
            1.4000709935494762,
            2.7214953694749977,
            -0.08973914111647616
          ],
          [
            1.423249736330516,
            2.6428000994814025,
            -0.17124976466874792
          ],
          [
            1.382038381480055,
            2.542967744444851,
            -0.10227186582373328
          ]
        ]
      }
    ],
    "outfitLimbReveal": {
      "arms": 0.105,
      "legs": 0,
      "feet": 0
    },
    "outfitTuck": {
      "drop": 0,
      "width": 0.5
    },
    "outfitScale": {
      "x": 1.24,
      "y": 1,
      "z": 1
    },
    "outfitVariant": "morph"
  },
  "rose-sequin-cocktail": {
    // Two tube cuts: inner high ring removes the donor neck shell; wider lower
    // bib cut clears the AI-gen chest plate. radialReach keeps shoulder tops
    // and straps at the same height from being eaten by a radius-blind cut.
    "outfitLoopCuts": [
      {
        "id": "loop-inner-tube",
        "target": "torso",
        "interpolation": "smooth",
        "hideSide": "positive",
        "edgeInset": 0,
        "radialReach": 0.06,
        "frame": {
          "origin": [0, 0, 0],
          "axis": [0, 1, 0],
          "u": [1, 0, 0],
          "v": [0, 0, -1]
        },
        "points": [
          [0.14, 2.78, 0],
          [0.1, 2.85, -0.1],
          [0, 2.9, -0.14],
          [-0.1, 2.85, -0.1],
          [-0.14, 2.78, 0],
          [-0.1, 2.72, 0.1],
          [0, 2.68, 0.14],
          [0.1, 2.72, 0.1]
        ]
      },
      {
        "id": "loop-bib",
        "target": "torso",
        "interpolation": "sharp",
        "hideSide": "positive",
        "edgeInset": 0,
        "radialReach": 0.12,
        "frame": {
          "origin": [0, 0, 0],
          "axis": [0, 1, 0],
          "u": [1, 0, 0],
          "v": [0, 0, -1]
        },
        "points": [
          [0.22, 2.58, 0.02],
          [0.16, 2.7, -0.14],
          [0, 2.78, -0.22],
          [-0.16, 2.7, -0.14],
          [-0.22, 2.58, 0.02],
          [-0.16, 2.48, 0.16],
          [0, 2.36, 0.26],
          [0.16, 2.48, 0.16]
        ]
      }
    ],
    "outfitLimbReveal": {
      "arms": 1.47,
      "legs": 0,
      "feet": 0
    },
    "outfitTuck": {
      "drop": 1,
      "width": 1
    },
    "outfitScale": {
      "x": 1,
      "y": 1,
      "z": 1
    },
    "outfitVariant": "morph"
  },
  "charcoal-suit": {
    "outfitLoopCuts": [],
    "outfitLimbReveal": {
      "arms": 0.22,
      "legs": 0,
      "feet": 0
    },
    "outfitTuck": {
      "drop": 0.63,
      "width": 1
    },
    "outfitScale": {
      "x": 1,
      "y": 1,
      "z": 1
    },
    "outfitVariant": "morph"
  }
});

export function getSimOutfitAuthoredDefaults(outfitId) {
  if (!outfitId) return null;
  const entry = SIM_OUTFIT_AUTHORED_DEFAULTS[outfitId];
  if (!entry) return null;
  return {
    outfitLoopCuts: (entry.outfitLoopCuts ?? []).map((cut) => ({
      ...cut,
      points: (cut.points ?? []).map((p) => [...p]),
      frame: cut.frame ? {
        origin: [...(cut.frame.origin ?? [0, 0, 0])],
        axis: [...(cut.frame.axis ?? [0, 1, 0])],
        u: [...(cut.frame.u ?? [1, 0, 0])],
        v: [...(cut.frame.v ?? [0, 0, -1])],
      } : undefined,
    })),
    outfitLimbReveal: { ...(entry.outfitLimbReveal ?? { arms: 0, legs: 0, feet: 0 }) },
    outfitTuck: { ...(entry.outfitTuck ?? { drop: 0, width: 0.5 }) },
    outfitScale: { ...(entry.outfitScale ?? { x: 1, y: 1, z: 1 }) },
    outfitPosition: { ...(entry.outfitPosition ?? { x: 0, y: 0, z: 0 }) },
    outfitVariant: entry.outfitVariant ?? 'morph',
  };
}
