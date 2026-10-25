import 'dotenv/config'
import { GoogleGenAI } from '@google/genai'
import { extractInteractionText } from './argonOrchestrator.ts'

/**
 * Live path findings (Task 1):
 * 1. Managed Agent (`antigravity-preview-09-2026`) requires `environment: 'remote'`
 *    (omitting it fails with `400 Missing required field 'environment'`) and rejects
 *    `{ type: 'video' }` inputs with `400 Video input is not supported`, whereas
 *    Gemini models (`gemini-4-argon`, `gemini-3.8-flash`) accept `{ type: 'video', uri, mime_type }`
 *    once the uploaded file state reaches `ACTIVE`.
 * 2. `previous_interaction_id` cannot chain across `model` and `agent` calls:
 *    - Model -> Agent fails with `400 Precondition check failed.`
 *    - Agent -> Model fails with `400 Previous interaction <id> belongs to an agent and cannot be continued with a model interaction.`
 * 3. `interaction.output_text` only returns the last consecutive `model_output` step;
 *    multi-step interactions must concatenate text across all `model_output` steps in `interaction.steps`.
 */
const apiKey = process.env.GEMINI_API_KEY
if (!apiKey) throw new Error('GEMINI_API_KEY is missing from physics-sandbox/.env')

const ai = new GoogleGenAI({ apiKey })
const created = await ai.interactions.create({
  model: process.env.ARGON_MODEL ?? 'gemini-4-argon',
  background: true,
  input: 'Reply with the exact text ARGON_API_OK.',
  generation_config: { max_output_tokens: 64, thinking_level: 'low' },
})

const deadline = Date.now() + 2 * 60_000
for (;;) {
  if (Date.now() > deadline) {
    throw new Error('Google Interactions API smoke test timed out after 120s.')
  }
  const interaction = await ai.interactions.get(created.id)
  if (interaction.status === 'completed') {
    const text = extractInteractionText(interaction).trim()
    if (!text.includes('ARGON_API_OK')) {
      throw new Error(`Unexpected smoke test output_text: ${JSON.stringify(text)}`)
    }
    console.log(`Google Interactions API smoke test passed (${interaction.status}: ${text}).`)
    break
  }
  if (interaction.status === 'failed' || interaction.status === 'cancelled' || interaction.status === 'requires_action') {
    throw new Error(`Google Interactions API smoke test failed (${interaction.status}).`)
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))
}

