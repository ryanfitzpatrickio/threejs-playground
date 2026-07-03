export const TRAVERSAL_ACTION_DEFINITIONS = {
  ledgeAttach: {
    duration: 1.6,
    exitProgress: 0.88,
    motionWarp: {
      position: 'startToTarget',
      curve: 'attachArc',
      startProgress: 0.24,
      endProgress: 0.76,
    },
  },
  ledgeTopAttach: {
    duration: 1.05,
    exitProgress: 0.92,
    motionWarp: {
      position: 'startToTarget',
      curve: 'smoothStep',
      startProgress: 0.28,
      endProgress: 0.82,
    },
  },
  ledgeClimb: {
    drive: 'climb',
    duration: 1.25,
    exitProgress: 1,
    recoverySeconds: 0.35,
    motionWarp: {
      position: 'startToTarget',
      curve: 'ledgeClimb',
      verticalStartProgress: 0.1,
      verticalEndProgress: 0.97,
      inwardStartProgress: 0.76,
      inwardEndProgress: 0.99,
    },
  },
  ledgeDrop: {
    duration: 0.22,
    exitProgress: 0.86,
  },
  ledgeModeSwitch: {
    duration: 0.34,
    exitProgress: 0.94,
  },
  ledgeHop: {
    duration: 0.54,
    exitProgress: 0.94,
    motionWarp: {
      position: 'startToTarget',
      curve: 'smoothStep',
    },
  },
  ledgeContinueClimb: {
    drive: 'hang',
    duration: 1.67,
    exitProgress: 0.9,
  },
  ledgeCorner: {
    duration: 0.42,
    exitProgress: 0.92,
    motionWarp: {
      position: 'startToTarget',
      curve: 'smoothStep',
    },
  },
  ledgeWallJump: {
    duration: 0.48,
    exitProgress: 0.82,
  },
  vault: {
    drive: 'vault',
    duration: 0.9,
    exitProgress: 0.96,
    recoverySeconds: 0.12,
  },
  slide: {
    drive: 'slide',
    duration: 1.05,
    exitProgress: 0.94,
    recoverySeconds: 0.08,
  },
};

export function getTraversalActionDefinition(type) {
  return TRAVERSAL_ACTION_DEFINITIONS[type] ?? null;
}
