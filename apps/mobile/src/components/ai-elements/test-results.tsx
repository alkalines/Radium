import { Check, CircleDashed, FileCode, FlaskConical, X } from "lucide-react-native";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { Icon } from "@/components/ui/icon";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { Activity } from "./activity";

/** Test result data from the current shadcn suites example, not a test execution API. */
export type Test = { name: string; status: "passed" | "failed" | "skipped"; error?: string };
/** A named collection of test results. */
export type TestSuite = { name: string; tests: Test[] };

/** Nested suite and failure disclosures. Failed suites begin open. */
export function TestResults({ suites }: { suites: TestSuite[] }) {
  const tests = suites.flatMap((suite) => suite.tests);
  const failed = tests.filter((test) => test.status === "failed").length;
  return (
    <Trace>
      <Activity
        title={`Ran ${tests.length} tests${failed ? `, ${failed} failed` : ""}`}
        icon={FlaskConical}
        status={failed ? "error" : undefined}
        defaultOpen={failed > 0}
        keepMounted
      >
        <Trace>
          {suites.map((suite, index) => {
            const failures = suite.tests.filter((test) => test.status === "failed").length;
            return (
              <Activity
                key={index}
                title={`${suite.name}, ${suite.tests.length} tests${failures ? `, ${failures} failed` : ""}`}
                icon={FileCode}
                status={failures ? "error" : undefined}
                defaultOpen={failures > 0}
                keepMounted
              >
                <Trace>
                  {suite.tests.map((test, testIndex) =>
                    test.status === "failed" ? (
                      <Activity key={testIndex} title={test.name} icon={X} status="error">
                        <CodeBlock size="sm" variant="destructive">
                          <CodeBlockContent wrap className="max-h-64">
                            {test.error ?? "Test failed."}
                          </CodeBlockContent>
                        </CodeBlock>
                      </Activity>
                    ) : (
                      <TraceLine key={testIndex}>
                        <TraceIcon>
                          <Icon
                            as={test.status === "skipped" ? CircleDashed : Check}
                            className="size-4"
                          />
                        </TraceIcon>
                        <TraceTitle>
                          {test.status === "skipped" ? `Skipped ${test.name}` : test.name}
                        </TraceTitle>
                      </TraceLine>
                    ),
                  )}
                </Trace>
              </Activity>
            );
          })}
        </Trace>
      </Activity>
    </Trace>
  );
}
