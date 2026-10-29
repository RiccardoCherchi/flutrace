import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { JwtContext } from "./JwtText.tsx";
import { decodeJwt } from "../jwt.ts";
import type { DecodedJwt } from "../jwt.ts";
import { JsonViewer } from "./JsonTree.tsx";
import { CloseIcon } from "./Icons.tsx";

function JwtDialog({
  decoded,
  onClose,
}: {
  decoded: DecodedJwt;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const elements = [
        ...panel.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled),summary,[tabindex="0"]',
        ),
      ];
      const first = elements[0];
      const last = elements.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !panel.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !panel.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="jwt-dialog"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="jwt-title"
        aria-describedby="jwt-note"
      >
        <div className="dialog-heading">
          <h2 id="jwt-title">Decoded JWT</h2>
          <button
            className="close-button"
            aria-label="Close JWT decoder"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="dialog-body">
          <p id="jwt-note" className="jwt-disclaimer">
            Decoded locally. <strong>Signature not verified.</strong>
          </p>
          <h3>Header</h3>
          <JsonViewer value={decoded.header} />
          <h3>Payload</h3>
          <JsonViewer value={decoded.payload} />
          <dl className="jwt-dates">
            {(["iat", "nbf", "exp"] as const).map((claim) => {
              const value = decoded.payload[claim];
              if (typeof value !== "number" || !Number.isFinite(value))
                return null;
              const date = new Date(value * 1000);
              if (!Number.isFinite(date.getTime())) return null;
              return (
                <div key={claim}>
                  <dt>{claim}</dt>
                  <dd>{date.toISOString()}</dd>
                </div>
              );
            })}
          </dl>
        </div>
      </div>
    </div>,
    document.body,
  );
}
export function JwtInspector({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey: string;
}) {
  const [token, setToken] = useState<string>();
  useEffect(() => {
    setToken(undefined);
  }, [resetKey]);
  const inspect = useCallback((value: string) => setToken(value), []);
  const close = useCallback(() => setToken(undefined), []);
  const decoded = useMemo(
    () => (token ? decodeJwt(token) : undefined),
    [token],
  );
  return (
    <JwtContext.Provider value={inspect}>
      {children}
      {decoded && <JwtDialog decoded={decoded} onClose={close} />}
    </JwtContext.Provider>
  );
}
