import * as React from "react";
import { Circle, CircleCheck, CircleDot, Route } from "lucide-react-native";
import { Icon } from "@/components/ui/icon";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { Activity, type ActivityProps } from "./activity";

/** A planned step. State is supplied by the caller, never inferred from display order. */
export type PlanStep = { title: string; status: "pending" | "running" | "done" };
/** Plan summary and progress, composed from Trace rather than the former Card wrapper. */
export function Plan({
  steps,
  children,
  ...props
}: Omit<ActivityProps, "description"> & { steps: PlanStep[] }) {
  const done = steps.filter((step) => step.status === "done").length;
  return (
    <Activity
      icon={Route}
      defaultOpen
      status={steps.some((step) => step.status === "running") ? "running" : undefined}
      description={`${done} of ${steps.length} done`}
      {...props}
    >
      {children}
      <Trace>
        {steps.map((step, index) => (
          <TraceLine
            key={`${index}-${step.title}`}
            status={step.status === "done" ? undefined : step.status}
          >
            <TraceIcon>
              <Icon
                as={
                  step.status === "done"
                    ? CircleCheck
                    : step.status === "running"
                      ? CircleDot
                      : Circle
                }
                className="size-4"
              />
            </TraceIcon>
            <TraceTitle>{step.title}</TraceTitle>
          </TraceLine>
        ))}
      </Trace>
    </Activity>
  );
}
