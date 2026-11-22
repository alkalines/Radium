export type FunctionSchema = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: any; // z.object() with no shape → empty object type
    strict?: boolean;
  };
};

export type CustomSchema = {
  type: "custom";
  custom: {
    name: string;
    description?: string;
    format?:
      | { type: "text" }
      | {
          type: "grammar";
          grammar: {
            definition: string;
            syntax: string;
          };
        };
  };
};

export type ToolsSchema = FunctionSchema | CustomSchema;
