import { useMemo } from "react";
import type { ReactNode } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-json";
import { JwtText } from "./JwtText.tsx";

Prism.manual = true;
function languageFor(mime: string) {
  const type = mime.toLowerCase();
  if (type.includes("json")) return "json";
  if (/xml|html|svg/.test(type)) return "markup";
  if (/javascript|ecmascript/.test(type)) return "javascript";
  if (type.includes("css")) return "css";
  return undefined;
}
function renderTokens(
  tokens: (string | Prism.Token)[],
  budget: { left: number },
  depth = 0,
): ReactNode {
  if (depth > 30) throw new Error("Token depth limit");
  return tokens.map((token, index) => {
    if (--budget.left < 0) throw new Error("Token count limit");
    if (typeof token === "string") return <JwtText text={token} key={index} />;
    const content = Array.isArray(token.content)
      ? token.content
      : [token.content];
    return (
      <span className={`token ${token.type}`} key={index}>
        {renderTokens(content, budget, depth + 1)}
      </span>
    );
  });
}
export function CodeView({ text, mime }: { text: string; mime: string }) {
  const rendered = useMemo(() => {
    const language = languageFor(mime);
    if (!language || text.length > 100000) return undefined;
    try {
      // ~100 KB of pretty-printed JSON; tokenizing is cheap, rendering one element per token is not.
      return renderTokens(Prism.tokenize(text, Prism.languages[language]), {
        left: 40000,
      });
    } catch {
      return undefined;
    }
  }, [text, mime]);
  return (
    <>
      {rendered === undefined && languageFor(mime) && (
        <p className="syntax-note">
          Shown as plain text because the body is too large to highlight.
        </p>
      )}
      <pre className="response-text">{rendered ?? <JwtText text={text} />}</pre>
    </>
  );
}
