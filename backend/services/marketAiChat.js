const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_GROQ_MODEL = 'groq/compound-mini';
const REQUEST_TIMEOUT_MS = 60000;

const SYSTEM_PROMPT = `You are Market AI, an intelligent assistant for a stock market watchlist application.

Your primary task is to directly answer the user's current question.

IMPORTANT RULES:
1. Answer the user's exact question first.
2. Do not automatically summarize the entire watchlist.
3. Use watchlist data only when it is relevant to the question.
4. If the user says hello, hey, or another greeting, respond naturally and briefly.
5. If the user asks about a specific stock, focus on that stock.
6. If the user asks to explain selected text, explain only that selected text unless additional context is necessary.
7. Only provide a full watchlist summary when the user explicitly requests one.
8. Do not repeat the same market summary in every response.
9. If the question is ambiguous, explain what is available instead of inventing meaning.
10. Use simple, clear language unless the user requests technical analysis.

Use ONLY the supplied market context for factual claims about the user's watchlist.
You may explain attention scores, relative performance versus benchmarks, significant and notable movements, statistical unusualness, market patterns, data freshness, market status, and comparisons between stocks.

Do NOT invent prices, news, events, earnings information, or reasons that are not present in the supplied context.
If the user asks why a stock moved in the real world but the context does not contain a reason, clearly say that the current Market AI data identifies the movement but does not establish the real-world cause.
Do NOT provide personalized financial advice or tell the user to buy, sell, or invest.

Explain technical terms like z-score or relative movement simply when necessary.
Keep answers concise by default and use bullet points when comparing multiple stocks.
If a ticker is not in the current watchlist, say that you only have analysis for the current watchlist.`;

async function answerMarketQuestion({ question, context, contextType = 'general_question', history = [] }) {
  const effectiveHistory = isGreetingQuestion(question) ? [] : history;
  const provider = (process.env.LLM_PROVIDER || 'openai').trim().toLowerCase();
  try {
    if (provider === 'openai') {
      return await answerWithOpenAI({ question, context, contextType, history: effectiveHistory });
    }

    if (provider === 'gemini') {
      return await answerWithGemini({ question, context, contextType, history: effectiveHistory });
    }

    if (provider === 'groq') {
      return await answerWithGroq({ question, context, contextType, history: effectiveHistory });
    }

    throw createConfigurationError(`Unsupported LLM_PROVIDER: ${provider}`);
  } catch (error) {
    return buildDeterministicAnswer({ question, context, contextType, error });
  }
}

function buildDeterministicAnswer({ question, context, contextType }) {
  if (isGreetingQuestion(question)) return 'Hey! How can I help you with your watchlist today?';
  if (contextType === 'selected_text' && context?.selectedText) {
    return `Market AI is unavailable right now. The selected information says: ${context.selectedText}`;
  }

  const stocks = Array.isArray(context?.stocks) ? context.stocks : [];
  const stock = stocks[0];
  if (!stock) return 'Market AI is unavailable right now. No matching market context was found for this question.';

  const movement = Number.isFinite(stock.rawMove) ? `${stock.rawMove >= 0 ? '+' : ''}${(stock.rawMove * 100).toFixed(2)}%` : 'unavailable';
  const relative = Number.isFinite(stock.relativeMove) ? `${stock.relativeMove >= 0 ? '+' : ''}${(stock.relativeMove * 100).toFixed(2)}% versus its benchmark` : 'no benchmark comparison is available';
  const unusual = Number.isFinite(stock.zScore) ? ` Its z-score is ${stock.zScore.toFixed(2)}.` : '';
  return `${stock.ticker} moved ${movement} today with ${relative}.${unusual} ${stock.explanation || 'No additional deterministic explanation is available.'}`;
}

async function answerWithOpenAI({ question, context, contextType, history }) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw createConfigurationError(
      'Market AI chat is not configured. Add OPENAI_API_KEY to the backend environment.'
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history,
          {
            role: 'user',
            content: buildUserPrompt({ question, context, contextType }),
          },
        ],
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message || 'Market AI provider request failed');
      error.statusCode = response.status >= 500 ? 502 : 400;
      throw error;
    }

    const answer = payload.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      const error = new Error('Market AI provider returned an empty answer');
      error.statusCode = 502;
      throw error;
    }
    return answer;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Market AI request timed out. Please try again.');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function answerWithGroq({ question, context, contextType, history }) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw createConfigurationError('Market AI chat is not configured. Add GROQ_API_KEY to the backend environment.');
  }

  const client = new Groq({ apiKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await client.chat.completions.create({
      model: process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: buildUserPrompt({ question, context, contextType }) },
      ],
    }, { signal: controller.signal });

    const answer = response.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      const error = new Error('Groq returned an empty answer');
      error.statusCode = 502;
      error.category = 'malformed_response';
      throw error;
    }
    return answer;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Groq request timed out');
      timeoutError.statusCode = 504;
      timeoutError.category = 'timeout';
      throw timeoutError;
    }
    throw normalizeGroqError(error);
  } finally {
    clearTimeout(timeout);
  }
}

async function answerWithGemini({ question, context, contextType, history }) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw createConfigurationError(
      'Market AI chat is not configured. Add GEMINI_API_KEY to the backend environment.'
    );
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = normalizeGeminiModel(process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL);
  const contents = [
    ...history.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
    {
      role: 'user',
      parts: [{
        text: buildUserPrompt({ question, context, contextType }),
      }],
    },
  ];

  let timeout;
  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.2,
        },
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('Market AI request timed out. Please try again.');
          error.statusCode = 504;
          reject(error);
        }, REQUEST_TIMEOUT_MS);
      }),
    ]);

    const answer = response.text?.trim();
    if (!answer) {
      const error = new Error('Market AI provider returned an empty answer');
      error.statusCode = 502;
      error.provider = 'gemini';
      error.category = 'malformed_response';
      throw error;
    }
    return answer;
  } catch (error) {
    if (error.statusCode) {
      error.provider = 'gemini';
      error.category ||= error.statusCode === 504 ? 'timeout' : 'request';
      throw error;
    }
    throw normalizeGeminiError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function buildUserPrompt({ question, context, contextType }) {
  return `CURRENT USER QUESTION (answer this directly):\n<<<\n${question}\n>>>\n\nQUESTION TYPE:\n${contextType}\n\nRELEVANT MARKET CONTEXT (use only when relevant):\n<<<\n${JSON.stringify(context)}\n>>>\n\nNow answer the CURRENT USER QUESTION directly. Do not provide a full watchlist summary unless the question explicitly requests one.`;
}

function isGreetingQuestion(question) {
  return /^(hi|hello|hey|good morning|good afternoon|good evening)[!. ]*$/i.test(question.trim());
}

function normalizeGeminiError(error) {
  const status = Number(error.status ?? error.statusCode ?? error.code);
  const message = String(error.message || '').toLowerCase();
  const normalized = new Error('Market AI provider request failed. Please try again.');
  normalized.provider = 'gemini';

  if (status === 401 || status === 403 || /api key|permission|unauthoriz|forbidden|invalid key/.test(message)) {
    normalized.message = 'Gemini API key is invalid or not authorized.';
    normalized.statusCode = 502;
    normalized.category = 'authentication';
  } else if (status === 429 || /quota|rate limit|resource exhausted|too many requests/.test(message)) {
    normalized.message = 'Gemini is temporarily rate-limited or out of quota. Please try again later.';
    normalized.statusCode = 429;
    normalized.category = 'quota';
  } else if (/fetch failed|network|enotfound|econn|socket|timeout/.test(message)) {
    normalized.message = 'Could not reach Gemini. Please try again.';
    normalized.statusCode = 502;
    normalized.category = 'network';
  } else if (status === 400 || /invalid model|invalid argument/.test(message)) {
    const configuredModel = normalizeGeminiModel(process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL);
    normalized.message = `Gemini model name '${configuredModel}' is invalid. Run npm run check-gemini-models.`;
    normalized.statusCode = 400;
    normalized.category = 'invalid_model';
  } else if (status === 404 || /model not found|not found/.test(message)) {
    const configuredModel = normalizeGeminiModel(process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL);
    normalized.message = `Gemini model '${configuredModel}' is unavailable. Run npm run check-gemini-models.`;
    normalized.statusCode = 502;
    normalized.category = 'model_unavailable';
  } else {
    normalized.statusCode = 502;
    normalized.category = 'provider';
  }

  return normalized;
}

function normalizeGeminiModel(model) {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

function normalizeGroqError(error) {
  const status = Number(error.status ?? error.statusCode ?? error.code);
  const message = String(error.message || '').toLowerCase();
  const normalized = new Error('Groq provider request failed.');
  normalized.provider = 'groq';
  normalized.statusCode = status === 429 ? 429 : status === 401 || status === 403 ? 502 : 502;
  if (status === 401 || status === 403 || /api key|auth|permission|unauthoriz|forbidden/.test(message)) {
    normalized.category = 'authentication';
  } else if (status === 429 || /quota|rate limit|too many requests/.test(message)) {
    normalized.category = 'quota';
  } else if (/timeout|fetch failed|network|enotfound|econn|socket/.test(message)) {
    normalized.category = 'network';
  } else if (status === 400 || status === 404 || /model|invalid/.test(message)) {
    normalized.category = 'invalid_model';
  } else {
    normalized.category = 'provider';
  }
  return normalized;
}

function createConfigurationError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
}

module.exports = { answerMarketQuestion, answerWithGroq, buildDeterministicAnswer, buildUserPrompt, SYSTEM_PROMPT };
