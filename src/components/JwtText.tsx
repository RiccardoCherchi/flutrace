import { createContext, Fragment, useContext, useMemo } from "react";
import { findJwts } from "../jwt.ts";

export const JwtContext = createContext<((token: string) => void) | null>(null);
export function JwtText({ text }: { text: string }) {
  const inspect = useContext(JwtContext);
  const matches = useMemo(
    () => (inspect ? findJwts(text) : []),
    [text, inspect],
  );
  if (!matches.length) return <>{text}</>;
  let position = 0;
  return (
    <>
      {matches.map((match) => {
        const before = text.slice(position, match.start);
        position = match.end;
        return (
          <Fragment key={match.start}>
            {before}
            <button
              type="button"
              className="jwt-link"
              aria-label="Decode JWT"
              title="Decode locally. Signature is not verified."
              onClick={() => inspect?.(match.token)}
            >
              {match.token}
            </button>
          </Fragment>
        );
      })}
      {text.slice(position)}
    </>
  );
}
