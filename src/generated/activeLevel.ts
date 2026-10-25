import type { GeneratedLevelModule } from '../engine/types'

export const buildWorld: GeneratedLevelModule['buildWorld'] = () => ({
  stepBotAndRules: () => ({ botState: 'idle', goalReached: false }),
  stepHumanAndRules: () => ({ botState: 'human', goalReached: false }),
  controls: [],
  goal: { type: 'below-y', body: 'target', y: -1 },
  dispose: () => {},
})
