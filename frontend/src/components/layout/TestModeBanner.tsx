import { useEffect, useState } from "react";
import { getDeliveryMode, type DeliveryMode } from "../../api/client";

const PARTS: { key: keyof DeliveryMode; label: string }[] = [
  { key: "dataForSeo", label: "rankings (DataForSEO)" },
  { key: "email", label: "client emails" },
  { key: "comments", label: "ClickUp comments" },
];

/**
 * Says so when the server runs in test mode: a mock send is marked SENT just like a real one, so without
 * this nobody could tell nothing went out (audit 2026-10-27). Hidden when everything is live, or if the
 * check fails -- it's a warning, never a blocker.
 */
export function TestModeBanner() {
  const [mode, setMode] = useState<DeliveryMode | null>(null);
  useEffect(() => {
    let active = true;
    getDeliveryMode()
      .then((m) => active && setMode(m))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const mocked = mode ? PARTS.filter((p) => mode[p.key] === "mock").map((p) => p.label) : [];
  if (mocked.length === 0) return null;
  return (
    <div role="status" className="border-b border-amber-500/30 bg-amber-500/10 px-10 py-2 text-xs text-amber-200">
      <strong>Test mode:</strong> {mocked.join(", ")} {mocked.length === 1 ? "is" : "are"} simulated — nothing is really fetched or sent for{" "}
      {mocked.length === 1 ? "it" : "them"}, even where the page says “Sent” or “Posted”.
    </div>
  );
}
