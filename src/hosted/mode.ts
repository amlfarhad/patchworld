/**
 * True in the Vercel build: the loop runs in the page and Gemini runs in /api/argon.
 * (Read defensively: this module is also part of the server typecheck, which has no Vite env types.)
 */
export const isHosted = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_HOSTED === '1'
