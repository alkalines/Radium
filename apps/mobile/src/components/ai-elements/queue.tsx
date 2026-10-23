import { Circle, CircleCheck, ListChecks, ListTodo } from "lucide-react-native";
import { Icon } from "@/components/ui/icon";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { Activity } from "./activity";

/** Display-only todo data, matching the current QueueDescriptions example. */
export type Todo = { title: string; description?: string; done: boolean };
/** Pending and completed activity groups; descriptions disclose independently. */
export function Queue({ todos }: { todos: Todo[] }) {
  return (
    <Trace>
      {[false, true].map((done) => {
        const items = todos.filter((todo) => todo.done === done);
        return (
          <Activity
            key={String(done)}
            title={`${items.length} ${done ? "completed" : "to do"}`}
            icon={done ? ListChecks : ListTodo}
            defaultOpen={!done}
            keepMounted
          >
            <Trace>
              {items.map((todo, index) =>
                todo.description ? (
                  <Activity key={index} title={todo.title} icon={done ? CircleCheck : Circle}>
                    {todo.description}
                  </Activity>
                ) : (
                  <TraceLine key={index}>
                    <TraceIcon>
                      <Icon as={done ? CircleCheck : Circle} className="size-4" />
                    </TraceIcon>
                    <TraceTitle>{todo.title}</TraceTitle>
                  </TraceLine>
                ),
              )}
            </Trace>
          </Activity>
        );
      })}
    </Trace>
  );
}
