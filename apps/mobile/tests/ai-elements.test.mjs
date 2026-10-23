import { afterEach, describe, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";
import {
  messageAnchorSpacer,
  messageScrollOffset,
} from "../src/components/ui/message-scroller-layout.ts";

// These tests exercise our composition/state contracts, not native rendering or transport.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const host = (name) =>
  function Host({ children, ...props }) {
    return React.createElement(
      name,
      props,
      typeof children === "function" ? children({ pressed: false }) : children,
    );
  };
mock.module("react-native", () => ({
  View: host("View"),
  Text: host("Text"),
  Pressable: host("Pressable"),
  TextInput: host("TextInput"),
  ScrollView: host("ScrollView"),
  Platform: {
    OS: "android",
    select: (options) => options.android ?? options.native ?? options.default,
  },
  Linking: { openURL: async () => {} },
}));
mock.module("@/components/ui/icon", () => ({ Icon: host("Icon") }));
mock.module("@/components/ui/activity-text", () => ({ ActivityText: host("Text") }));
mock.module("lucide-react-native", () =>
  Object.fromEntries(
    [
      "ArrowUp",
      "ArrowDown",
      "Brain",
      "Check",
      "ChevronRight",
      "Copy",
      "File",
      "Plus",
      "Square",
      "Terminal",
      "X",
    ].map((name) => [name, host(name)]),
  ),
);
mock.module("@rn-primitives/slot", () => ({ Slot: host("Slot") }));
mock.module("@/components/ai-elements/markdown", () => ({ Markdown: host("Markdown") }));
let pickerResult = { canceled: true, assets: null };
mock.module("expo-document-picker", () => ({ getDocumentAsync: async () => pickerResult }));
mock.module("expo-clipboard", () => ({ setStringAsync: async () => true }));
const DisclosureContext = React.createContext(null);
mock.module("@rn-primitives/collapsible", () => ({
  Root: ({ open, onOpenChange, children }) =>
    React.createElement(DisclosureContext.Provider, { value: { open, onOpenChange } }, children),
  Trigger: ({ children, ...props }) => {
    const { open, onOpenChange } = React.useContext(DisclosureContext);
    return React.createElement(
      "Pressable",
      { ...props, accessibilityState: { expanded: open }, onPress: () => onOpenChange(!open) },
      typeof children === "function" ? children({ pressed: false }) : children,
    );
  },
  Content: ({ forceMount, children, ...props }) => {
    const { open } = React.useContext(DisclosureContext);
    return open || forceMount ? React.createElement("View", props, children) : null;
  },
}));

const { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } =
  await import("../src/components/ui/trace.tsx");
const { ReasoningLine } = await import("../src/components/ai-elements/reasoning.tsx");
const { Confirmation } = await import("../src/components/ai-elements/confirmation.tsx");
const { PromptInput } = await import("../src/components/ai-elements/prompt-input.tsx");
const { SourceLink } = await import("../src/components/ai-elements/links.tsx");
const { ToolLine } = await import("../src/components/ai-elements/tool.tsx");
const { InputGroup, InputGroupAddon, InputGroupInput } =
  await import("../src/components/ui/input-group.tsx");
const {
  MessageScrollerProvider,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  useMessageScroller,
} = await import("../src/components/ui/message-scroller.tsx");

const mounted = [];
async function render(element, options) {
  let renderer;
  await act(async () => {
    renderer = create(element, options);
  });
  mounted.push(renderer);
  return renderer;
}
const pressEvent = () => ({ isDefaultPrevented: () => false });
const button = (renderer, label) =>
  renderer.root.findAllByType("Pressable").find((node) => node.props.accessibilityLabel === label);
afterEach(async () => {
  await act(async () => mounted.splice(0).forEach((renderer) => renderer.unmount()));
});

describe("native AI pattern composition", () => {
  test("input addons honor alignment even when declared after the input", async () => {
    const renderer = await render(
      React.createElement(
        InputGroup,
        null,
        React.createElement(InputGroupInput, { testID: "control" }),
        React.createElement(InputGroupAddon, { align: "inline-end", testID: "after" }),
        React.createElement(InputGroupAddon, { align: "inline-start", testID: "before" }),
      ),
    );
    const order = renderer.root
      .findAll(
        (node) =>
          typeof node.type === "string" &&
          ["control", "before", "after"].includes(node.props.testID),
      )
      .map((node) => node.props.testID);
    expect(order).toEqual(["before", "control", "after"]);
  });

  test("denied tools never become running or request approval again", async () => {
    const renderer = await render(
      React.createElement(ToolLine, {
        part: {
          state: "approval-responded",
          input: { command: "delete files" },
          approval: { id: "approval", approved: false },
        },
        streaming: true,
      }),
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("Denied");
    expect(JSON.stringify(renderer.toJSON())).toContain("delete files");
    expect(renderer.root.findAllByType("Pressable")).toHaveLength(0);
  });
  test("controlled disclosures report a choice without overriding the caller", async () => {
    let requested;
    const renderer = await render(
      React.createElement(
        TraceCollapsible,
        {
          open: false,
          onOpenChange: (value) => {
            requested = value;
          },
        },
        React.createElement(TraceCollapsibleTrigger, null, "Details"),
        React.createElement(TraceCollapsibleContent, null, "Output"),
      ),
    );
    await act(async () => renderer.root.findByType("Pressable").props.onPress());
    expect(requested).toBe(true);
    expect(renderer.root.findByType("Pressable").props.accessibilityState.expanded).toBe(false);
  });

  test("keepMounted preserves nested state while closed", async () => {
    let mountCount = 0;
    function Child() {
      React.useEffect(() => {
        mountCount += 1;
      }, []);
      return React.createElement("Text", null, "Nested state");
    }
    const renderer = await render(
      React.createElement(
        TraceCollapsible,
        { defaultOpen: true },
        React.createElement(TraceCollapsibleTrigger, null, "Details"),
        React.createElement(
          TraceCollapsibleContent,
          { keepMounted: true },
          React.createElement(Child),
        ),
      ),
    );
    await act(async () => renderer.root.findByType("Pressable").props.onPress());
    expect(renderer.root.findAllByType(Child)).toHaveLength(1);
    expect(
      renderer.root
        .findAllByType("View")
        .some((node) => node.props.style?.some?.((style) => style?.display === "none")),
    ).toBe(true);
    await act(async () => renderer.root.findByType("Pressable").props.onPress());
    expect(mountCount).toBe(1);
  });

  test("reasoning follows streaming but a reader's choice wins", async () => {
    const renderer = await render(
      React.createElement(ReasoningLine, { text: "Checking the log", running: true }),
    );
    expect(renderer.root.findByType("Pressable").props.accessibilityState.expanded).toBe(true);
    await act(async () =>
      renderer.update(React.createElement(ReasoningLine, { text: "Checked", running: false })),
    );
    expect(renderer.root.findByType("Pressable").props.accessibilityState.expanded).toBe(false);
    await act(async () => renderer.root.findByType("Pressable").props.onPress());
    await act(async () =>
      renderer.update(
        React.createElement(ReasoningLine, { text: "Checking again", running: true }),
      ),
    );
    await act(async () =>
      renderer.update(React.createElement(ReasoningLine, { text: "Done", running: false })),
    );
    expect(renderer.root.findByType("Pressable").props.accessibilityState.expanded).toBe(true);
  });

  test("approval and denial cannot race while a response is pending", async () => {
    let finish;
    const responses = [];
    const renderer = await render(
      React.createElement(Confirmation, {
        title: "Run command?",
        approve: () => {
          responses.push(true);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        deny: () => {
          responses.push(false);
        },
      }),
    );
    const buttons = renderer.root.findAllByType("Pressable");
    await act(async () => {
      buttons[1].props.onPress();
      buttons[0].props.onPress();
    });
    expect(responses).toEqual([true]);
    expect(renderer.root.findAllByType("Pressable").every((node) => node.props.disabled)).toBe(
      true,
    );
    await act(async () => finish());
  });

  test("rejected sends retain the controlled draft and display actionable feedback", async () => {
    const drafts = [];
    const renderer = await render(
      React.createElement(PromptInput, {
        text: "Keep this draft",
        setText: (text) => drafts.push(text),
        onSubmit: async () => {
          throw new Error("PRIVATE_TRANSPORT_DETAILS");
        },
      }),
    );
    await act(async () => button(renderer, "Send message").props.onPress());
    expect(drafts).toEqual([]);
    expect(renderer.root.findByType("TextInput").props.value).toBe("Keep this draft");
    expect(JSON.stringify(renderer.toJSON())).toContain("Your draft is still here");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("PRIVATE_TRANSPORT_DETAILS");
  });

  test("oversize files are rejected before entering composer state", async () => {
    pickerResult = {
      canceled: false,
      assets: [{ name: "large.txt", uri: "file:///large.txt", size: 101 }],
    };
    const selected = [];
    const renderer = await render(
      React.createElement(PromptInput, {
        text: "",
        setText: () => {},
        setFiles: (files) => selected.push(files),
        maxFileSize: 100,
        onSubmit: () => {},
      }),
    );
    await act(async () => button(renderer, "Attach files").props.onPress());
    expect(selected).toEqual([]);
    expect(JSON.stringify(renderer.toJSON())).toContain("too large");
  });

  test("source links reject executable schemes", async () => {
    let error;
    const renderer = await render(
      React.createElement(SourceLink, {
        href: "javascript:alert(1)",
        onError: (value) => {
          error = value;
        },
      }),
    );
    await act(async () => renderer.root.findByType("Pressable").props.onPress(pressEvent()));
    expect(error.message).toContain("Only HTTP(S)");
  });
});

describe("transcript scroll targets", () => {
  const row = { y: 500, height: 100, scrollAnchor: true };
  const options = { viewport: 300, content: 1000, offset: 0, scrollMargin: 20 };
  test("supports all alignment options with bounded offsets", () => {
    expect(messageScrollOffset(row, { ...options, align: "start" })).toBe(480);
    expect(messageScrollOffset(row, { ...options, align: "center" })).toBe(400);
    expect(messageScrollOffset(row, { ...options, align: "end" })).toBe(320);
    expect(messageScrollOffset(row, { ...options, align: "nearest", offset: 400 })).toBe(400);
    expect(messageScrollOffset({ ...row, y: 0 }, { ...options, align: "start" })).toBe(0);
    expect(messageScrollOffset({ ...row, y: 990 }, { ...options, align: "start" })).toBe(700);
  });
  test("short turns reserve anchor space and release it as output grows", () => {
    expect(messageAnchorSpacer(500, 550, 300, 64)).toBe(186);
    expect(messageAnchorSpacer(500, 700, 300, 64)).toBe(36);
    expect(messageAnchorSpacer(500, 900, 300, 64)).toBe(0);
  });

  test("prepend preservation and follow-output respect the reader's position", async () => {
    const frames = new Map();
    let frameId = 0;
    globalThis.requestAnimationFrame = (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    };
    globalThis.cancelAnimationFrame = (id) => frames.delete(id);
    const flush = async () =>
      act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(0));
      });
    const scrolls = [];
    let controls;
    function Capture() {
      controls = useMessageScroller();
      return null;
    }
    const element = (prepend = false) =>
      React.createElement(
        MessageScrollerProvider,
        { autoScroll: true },
        React.createElement(Capture),
        React.createElement(
          MessageScrollerViewport,
          null,
          React.createElement(
            MessageScrollerContent,
            null,
            prepend &&
              React.createElement(MessageScrollerItem, { messageId: "history", testID: "history" }),
            React.createElement(MessageScrollerItem, { messageId: "first", testID: "first" }),
            React.createElement(MessageScrollerItem, { messageId: "second", testID: "second" }),
          ),
        ),
      );
    const renderer = await render(element(), {
      createNodeMock: (node) =>
        node.type === "ScrollView" ? { scrollTo: ({ y }) => scrolls.push(y) } : null,
    });
    const viewport = () => renderer.root.findByType("ScrollView");
    const row = (id, y, height) =>
      renderer.root
        .findAllByType("View")
        .find((node) => node.props.testID === id)
        .props.onLayout({ nativeEvent: { layout: { y, height } } });
    await act(async () => {
      viewport().props.onLayout({ nativeEvent: { layout: { height: 300 } } });
      row("first", 16, 250);
      row("second", 300, 650);
      viewport().props.onContentSizeChange(400, 1000);
    });
    await flush();
    expect(scrolls.at(-1)).toBe(700);
    expect(controls.scrollToMessage("missing")).toBe(false);
    await act(async () =>
      viewport().props.onScroll({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1000 },
          layoutMeasurement: { height: 300 },
        },
      }),
    );
    await act(async () => renderer.update(element(true)));
    await act(async () => {
      row("history", 16, 100);
      row("first", 132, 250);
      row("second", 416, 650);
      viewport().props.onContentSizeChange(400, 1116);
    });
    await flush();
    expect(scrolls.at(-1)).toBe(316);
    await act(async () => {
      row("second", 416, 850);
      viewport().props.onContentSizeChange(400, 1316);
    });
    await flush();
    expect(scrolls.at(-1)).toBe(316);
    await act(async () =>
      viewport().props.onScroll({
        nativeEvent: {
          contentOffset: { y: 1016 },
          contentSize: { height: 1316 },
          layoutMeasurement: { height: 300 },
        },
      }),
    );
    await act(async () => {
      row("second", 416, 1050);
      viewport().props.onContentSizeChange(400, 1516);
    });
    await flush();
    expect(scrolls.at(-1)).toBe(1216);
  });
});
