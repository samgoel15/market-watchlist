const path = require('node:path');
const { config } = require('dotenv');
const { GoogleGenAI } = require('@google/genai');

config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey || apiKey === 'your_api_key_here') {
  process.stderr.write('GEMINI_API_KEY is missing from backend/.env.\n');
  process.exitCode = 1;
} else {
  const ai = new GoogleGenAI({ apiKey });

  (async () => {
    try {
      const models = await ai.models.list({ config: { queryBase: true } });
      for await (const model of models) {
        if (model.supportedActions?.includes('generateContent') && model.name) {
          process.stdout.write(`${model.name}\n`);
        }
      }
    } catch (error) {
      process.stderr.write('Unable to list Gemini models. Check GEMINI_API_KEY and try again.\n');
      process.exitCode = 1;
    }
  })();
}
