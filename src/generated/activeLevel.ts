import type { GeneratedLevelModule } from '../engine/types'

export const buildWorld: GeneratedLevelModule['buildWorld'] = () => ({
  stepBotAndRules: () => ({ botState: 'idle', goalReached: false }),
  dispose: () => {},
})
