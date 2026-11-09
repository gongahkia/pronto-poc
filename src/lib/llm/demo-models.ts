// Public labels/identifiers only. Credentials and endpoints stay server-side.
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2";
export const GEMINI_EMBEDDING_PROFILE = "gemini-embedding-2:question-answering:1536:v1";
export const DEFAULT_DEMO_MODEL = "groq-oss";
export const LOCAL_TEXT_RETRIEVAL_PROFILE = "postgres-fts-simple-v1";
export const demoModelChoices = [
  { id: "groq-oss", label: "Groq GPT-OSS 20B", provider: "groq", model: "openai/gpt-oss-20b" },
  { id: "openai-local", label: "OpenAI Luna (local evaluation)", provider: "openai", model: "gpt-6-luna" },
  { id: "gemini-flash", label: "Gemini 3.8 Flash", provider: "gemini", model: "gemini-3.8-flash" },
  { id: "gemini-lite", label: "Gemini 3.5 Flash-Lite", provider: "gemini", model: "gemini-3.5-flash-lite" },
  { id: "mock", label: "Mock • deterministic test", provider: "mock", model: "mock" },
  { id: "configured", label: "Configured real AI (OpenAI / Azure / Anthropic)", provider: null, model: null },
] as const;
export type DemoModelChoice = typeof demoModelChoices[number]["id"];
export type DemoAiProfile = {
  provider: string; model: string; embeddingProvider: string; embeddingModel: string;
  retrievalMode?: "local_text";
};
export function demoModelChoice(value: unknown) {
  return demoModelChoices.find(choice => choice.id === value);
}
