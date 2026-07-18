/** Built-in showcase household. Do not hand-edit loop cuts without re-exporting from creator. */
export default [
  {
    "version": 10,
    "id": "showcase-base5",
    "name": "Base 5",
    "body": "human5",
    "morphs": {
      "id.body.global.mass": -0.33,
      "id.body.global.muscle": -1
    },
    "facs": {},
    "skin": {},
    "garmentIds": [],
    "outfitId": "executive-suit",
    "outfitVariant": "morph",
    "outfitScale": {
      "x": 1.24,
      "y": 1,
      "z": 1
    },
    "outfitTuck": {
      "drop": 0,
      "width": 0.5
    },
    "outfitLimbReveal": {
      "arms": 0.105,
      "legs": 0,
      "feet": 0
    },
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
    "armSpace": -0.37,
    "hairStyleId": null,
    "hairColor": "#4a2c1a",
    "hairFit": {
      "scale": 1,
      "position": {
        "x": 0,
        "y": 0,
        "z": 0
      },
      "rotation": {
        "x": 0,
        "y": 0,
        "z": 0
      }
    },
    "updatedAt": 1
  },
  {
    "version": 10,
    "id": "showcase-female",
    "name": "Showcase Female",
    "body": "female",
    "morphs": {
      "id.body.global.mass": -0.53,
      "id.body.global.fat": 0,
      "id.body.global.muscle": 0.32,
      "id.skull.braincase.topWidth": -0.17,
      "id.skull.forehead.width": -0.02,
      "id.skull.forehead.height": -0.44,
      "id.skull.forehead.depth": -0.32,
      "id.skull.forehead.slope": 0.03,
      "id.skull.forehead.lowerVolume": -0.01,
      "id.skull.forehead.upperVolume": 0.07,
      "id.skull.browRidge.width": -0.09,
      "id.skull.browRidge.height": -1,
      "id.skull.browRidge.depth": 0.25,
      "id.skull.browRidge.innerDepth": 1,
      "id.skull.browRidge.outerDepth": 0.05,
      "id.skull.temple.width": -1,
      "id.skull.eye.spacing": -0.16,
      "id.skull.eye.width": -0.21,
      "id.skull.eye.height": 1,
      "id.skull.eye.depth": -0.19,
      "id.skull.eye.tilt": 0.95,
      "id.skull.upperJaw.width": 0.25,
      "id.skull.upperJaw.height": 0.02,
      "id.skull.upperJaw.depth": -0.19,
      "id.skull.upperJaw.roundness": 0.4,
      "id.skull.lowerJaw.width": 0.26,
      "id.skull.chin.width": -1,
      "id.skull.chin.height": -0.69,
      "id.skull.cheekbone.width": -0.58,
      "id.skull.cheekbone.height": 0.61,
      "id.skull.cheekbone.angularity": 0.5
    },
    "facs": {},
    "skin": {},
    "garmentIds": [],
    "outfitId": "rose-sequin-cocktail",
    "outfitVariant": "morph",
    "outfitScale": {
      "x": 1,
      "y": 1,
      "z": 1
    },
    "outfitTuck": {
      "drop": 1,
      "width": 1
    },
    "outfitLimbReveal": {
      "arms": 1.47,
      "legs": 0,
      "feet": 0
    },
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
    "armSpace": -0.58,
    "hairStyleId": "chestnut-cascade",
    "hairColor": "#c8af97",
    "hairFit": {
      "scale": 0.43,
      "position": {
        "x": 0.005,
        "y": 0.485,
        "z": -0.065
      },
      "rotation": {
        "x": 0,
        "y": 0,
        "z": 0
      }
    },
    "updatedAt": 1
  },
  {
    "version": 10,
    "id": "showcase-male",
    "name": "Showcase Male",
    "body": "male",
    "morphs": {
      "id.body.global.fat": 0,
      "id.body.global.muscle": 0,
      "id.body.global.mass": 0
    },
    "facs": {},
    "skin": {},
    "garmentIds": [],
    "outfitId": "charcoal-suit",
    "outfitVariant": "morph",
    "outfitScale": {
      "x": 1,
      "y": 1,
      "z": 1
    },
    "outfitTuck": {
      "drop": 0.63,
      "width": 1
    },
    "outfitLimbReveal": {
      "arms": 0.22,
      "legs": 0,
      "feet": 0
    },
    "armSpace": -0.4,
    "hairStyleId": null,
    "hairColor": "#ffffff",
    "hairFit": {
      "scale": 0.43,
      "position": {
        "x": 0,
        "y": 0.49,
        "z": -0.08
      },
      "rotation": {
        "x": 0,
        "y": 0,
        "z": 0
      }
    },
    "updatedAt": 1
  }
];
