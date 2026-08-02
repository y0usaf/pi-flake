export type RenderDeps = {
  keyHint: (id: string, description: string) => string;
  visibleWidth: (s: string) => number;
  truncateToWidth: (s: string, width: number) => string;
};

type Renderer = (...args: any[]) => any;

export const skinDefinition = (definition: any, call: Renderer = () => undefined, result: Renderer = () => undefined) => ({
  ...definition,
  renderShell: "self",
  renderCall: (args: any, theme: any, context: any) => call(definition.name, args, theme, context),
  renderResult: (value: any, options: any, theme: any, context: any) => result(definition.name, value, options, theme, context),
});
