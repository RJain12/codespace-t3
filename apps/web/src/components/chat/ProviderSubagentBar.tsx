import {
  formatProviderSubagentStatus,
  type ProviderSubagentStatus,
} from "@t3tools/client-runtime/state/thread-execution";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { ArrowUpLeftIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import { Button } from "../ui/button";

/**
 * Stands in for the composer on a provider-native subagent thread. The
 * provider runs that conversation, so there is nothing to send; the bar says
 * which model is working, for how long, and leads back to the parent.
 */
export function ProviderSubagentBar(props: {
  readonly modelLabel: string;
  /** Null until the subagent's root turn arrives. */
  readonly status: ProviderSubagentStatus | null;
  readonly onOpenParent: (() => void) | null;
}) {
  const statusRef = useRef<HTMLSpanElement>(null);
  const { status } = props;
  const live = status !== null && isOrchestrationV2WorkActive(status.status);
  // Announced once per transition; the ticking label below is not.
  const announcement = formatProviderSubagentStatus(
    status === null ? null : { ...status, startedAt: null },
    0,
  );

  // The label is written from an effect, and live bars tick through DOM
  // writes, so a running timer never re-renders the chat view.
  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) {
        statusRef.current.textContent = formatProviderSubagentStatus(status, Date.now());
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [live, status]);

  return (
    <div className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm">
      <span className="min-w-0 truncate font-medium text-foreground">{props.modelLabel}</span>
      <span
        ref={statusRef}
        aria-hidden
        className="min-w-0 truncate text-muted-foreground tabular-nums"
      />
      <span role="status" className="sr-only">
        {`${props.modelLabel} subagent: ${announcement}`}
      </span>
      <span className="ms-auto shrink-0 text-muted-foreground max-sm:hidden">Runs on its own</span>
      {props.onOpenParent ? (
        <Button size="sm" variant="ghost" onClick={props.onOpenParent}>
          <ArrowUpLeftIcon />
          Open parent
        </Button>
      ) : null}
    </div>
  );
}
