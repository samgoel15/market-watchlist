require('dotenv').config();
const Groq = require('groq-sdk');

const DEFAULT_MODEL = 'groq/compound-mini';

function classifyError(error) {
  const status = Number(error.status ?? error.statusCode ?? error.code);
  const message = String(error.message || '').toLowerCase();
  if (status === 401 || status === 403 || /api key|auth|permission|unauthoriz|forbidden/.test(message)) return 'authentication error';
  if (status === 429 || /quota|rate limit|too many requests/.test(message)) return 'rate limit or quota error';
  if (status === 400 || status === 404 || /model|invalid/.test(message)) return 'model or request error';
  if (/timeout|network|fetch failed|enotfound|econn|socket/.test(message)) return 'network or timeout error';
  return 'provider error';
}

async function main() {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
  if (!apiKey || apiKey === 'your_api_key_here') {
    console.error('Groq configuration missing: GROQ_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }

  console.log('Groq configuration detected');
  console.log(`Configured model: ${model}`);
  try {
    const client = new Groq({ apiKey });
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    });
    if (!response.choices?.[0]?.message?.content?.trim()) {
      throw new Error('empty provider response');
    }
    console.log('Connection test: SUCCESS');
  } catch (error) {
    console.error(`Connection test: FAILED (${classifyError(error)})`);
    process.exitCode = 1;
  }
}

main();
