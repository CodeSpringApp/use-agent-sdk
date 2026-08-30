import type { HighlighterCore, ThemedToken } from "shiki/core";

export type AgentCodeLanguage =
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "dockerfile"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "jsx"
  | "json"
  | "kotlin"
  | "markdown"
  | "php"
  | "python"
  | "ruby"
  | "rust"
  | "shellscript"
  | "sql"
  | "swift"
  | "tsx"
  | "typescript"
  | "yaml";

export interface HighlightedCode {
  background: string;
  foreground: string;
  tokens: ThemedToken[][];
}

type LanguageModule = { default: Parameters<HighlighterCore["loadLanguage"]>[0] };
type LanguageLoader = () => Promise<LanguageModule>;

const languageAliases: Record<string, AgentCodeLanguage | "text"> = {
  bash: "shellscript",
  c: "c",
  "c#": "csharp",
  cpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  css: "css",
  dockerfile: "dockerfile",
  go: "go",
  golang: "go",
  html: "html",
  java: "java",
  js: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  json: "json",
  kotlin: "kotlin",
  md: "markdown",
  markdown: "markdown",
  plaintext: "text",
  php: "php",
  py: "python",
  python: "python",
  rb: "ruby",
  ruby: "ruby",
  rs: "rust",
  rust: "rust",
  sh: "shellscript",
  shell: "shellscript",
  shellscript: "shellscript",
  sql: "sql",
  swift: "swift",
  text: "text",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  txt: "text",
  yaml: "yaml",
  yml: "yaml",
};

const languageLoaders: Record<AgentCodeLanguage, LanguageLoader> = {
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  yaml: () => import("@shikijs/langs/yaml"),
};

const resultCache = new Map<string, HighlightedCode>();
const languagePromises = new Map<AgentCodeLanguage, Promise<void>>();
const MAX_CACHE_ENTRIES = 128;
let highlighterPromise: Promise<HighlighterCore> | null = null;

export function normalizeCodeLanguage(language: string | undefined): AgentCodeLanguage | "text" {
  if (!language) return "text";
  const normalized = language.trim().toLowerCase().replace(/^language-/u, "");
  return languageAliases[normalized] ?? "text";
}

async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("@shikijs/themes/github-light"),
    import("@shikijs/themes/github-dark"),
  ]).then(([core, engine, light, dark]) => core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(),
    langs: [],
    themes: [light.default, dark.default],
  }));
  return highlighterPromise;
}

async function loadLanguage(highlighter: HighlighterCore, language: AgentCodeLanguage): Promise<void> {
  const existing = languagePromises.get(language);
  if (existing) return existing;
  const loading = languageLoaders[language]().then(async (module) => {
    await highlighter.loadLanguage(module.default);
  });
  languagePromises.set(language, loading);
  try {
    await loading;
  } catch (error) {
    languagePromises.delete(language);
    throw error;
  }
}

export async function highlightAgentCode(
  code: string,
  languageInput: string | undefined,
  mode: "light" | "dark",
): Promise<HighlightedCode | null> {
  const language = normalizeCodeLanguage(languageInput);
  if (language === "text") return null;
  const cacheKey = `${mode}:${language}:${code}`;
  const cached = resultCache.get(cacheKey);
  if (cached) {
    resultCache.delete(cacheKey);
    resultCache.set(cacheKey, cached);
    return cached;
  }

  try {
    const highlighter = await getHighlighter();
    await loadLanguage(highlighter, language);
    const result = highlighter.codeToTokens(code, {
      lang: language,
      theme: mode === "dark" ? "github-dark" : "github-light",
    });
    const highlighted = {
      background: result.bg ?? "transparent",
      foreground: result.fg ?? "inherit",
      tokens: result.tokens,
    } satisfies HighlightedCode;
    resultCache.set(cacheKey, highlighted);
    if (resultCache.size > MAX_CACHE_ENTRIES) {
      const oldest = resultCache.keys().next().value;
      if (oldest !== undefined) resultCache.delete(oldest);
    }
    return highlighted;
  } catch {
    return null;
  }
}
