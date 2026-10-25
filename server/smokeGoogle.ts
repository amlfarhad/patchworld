import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'

const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) throw new Error('GEMINI_API_KEY is missing; add it to .env in the project folder')

const ai = new GoogleGenAI({ apiKey })
const created = await ai.interactions.create({
  model: process.env.ARGON_MODEL ?? 'gemini-4-argon',
  background: true,
  input: 'Reply with the exact text ARGON_API_OK.',
  generation_config: { max_output_tokens: 24 },
})

for (;;) {
  const interaction = await ai.interactions.get(created.id)
  if (interaction.status === 'completed') {
    console.log(`Google Interactions API smoke test passed (${interaction.status}).`)
    break
  }
  if (interaction.status === 'failed' || interaction.status === 'cancelled' || interaction.status === 'requires_action') {
    throw new Error(`Google Interactions API smoke test failed (${interaction.status}).`)
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))
}
