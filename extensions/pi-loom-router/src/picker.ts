/**
 * Startup workflow picker for the loom router (P5c of
 * extensions/pi-loom/DESIGN.md).
 *
 * The other two mechanisms in this package are subtractive: P5b-i takes `edit`
 * and `write` away from the chat agent, P5b-ii refuses the `bash` invocations
 * that write. Both tell the model what it may not do. Neither tells the *user*
 * what the stack is for, and a `loom` that opens on an empty prompt looks
 * exactly like a `pi` that has mysteriously lost its editing tools.
 *
 * This module is the additive half: at startup the session opens on the list of
 * workflows it can actually run, and Esc drops straight to chat. Nothing is
 * forced — the picker is a menu, not a gate.
 *
 * ## Why it prefills the editor instead of launching the run
 *
 * There is no extension API that dispatches a slash command. `pi.sendUserMessage`
 * looks close but calls the session's `prompt()` with command handling switched
 * off, so `/build fix the parser` would be sent to the model as literal text.
 *
 * That constraint turns out to match the requirement anyway. Since P3a every
 * workflow command declares an `argsSchema`, and every shipped workflow's first
 * argument is a task description the picker cannot possibly know. So a choice
 * lands as `"/build "` in the editor with the cursor after it: the user types
 * the task and presses Enter, and pi's own palette shows the usage hint that
 * the engine generated from the schema.
 *
 * ## Why discovery goes through pi.getCommands()
 *
 * The engine (`pi-loom`) discovers workflows from three scan roots and
 * registers one slash command per workflow. Re-implementing that scan here
 * would give the router a second, drifting copy of the engine's rules about
 * scope, shadowing and project trust. Instead the picker reads back what the
 * engine actually registered.
 *
 * The filter is self-anchoring rather than hardcoded. `/workflows` is
 * registered unconditionally by the engine, so its `sourceInfo.path` *is* the
 * engine's identity for this session; every other command registered from that
 * same path is a workflow, except `/workflow`, which controls runs. Measured,
 * not assumed: in a real `loom`, `/build`, `/quick`, `/workflows` and
 * `/workflow` all report
 * `sourceInfo.path = <store>/pi-loom-3.4.2/src/index.ts`, while every other
 * extension reports its own file.
 */

/**
 * The part of pi's `SlashCommandInfo` the picker reads.
 *
 * Declared structurally instead of importing the type so that a stub harness
 * can hand this module plain objects, and so a future field on pi's side
 * cannot break the build.
 */
export interface CommandListing {
	readonly name: string;
	readonly description?: string;
	readonly sourceInfo?: { readonly path?: string };
}

/** The engine's listing command. Its source path anchors the whole filter. */
const LISTING_COMMAND = "workflows";

/** The engine's run-control command. Registered from the same file, not a workflow. */
const CONTROL_COMMAND = "workflow";

/** The explicit way out of the picker, for anyone who does not think to press Esc. */
export const CHAT_OPTION = "Chat instead (Esc)";

/** Dialog title. Names the escape hatch, because a modal with no visible exit reads as a wall. */
export const PICKER_TITLE = "Start a workflow — or Esc to chat";

/**
 * The workflow commands in a `pi.getCommands()` listing.
 *
 * Returns empty when the engine is not loaded at all, which is the correct
 * answer for a `loom` stack someone has stripped down: no anchor, no picker,
 * no dialog in the way.
 */
export function workflowCommands(commands: readonly CommandListing[]): CommandListing[] {
	const anchor = commands.find((command) => command.name === LISTING_COMMAND);
	const enginePath = anchor?.sourceInfo?.path;
	if (typeof enginePath !== "string" || enginePath.length === 0) return [];
	return commands.filter(
		(command) =>
			command.sourceInfo?.path === enginePath &&
			command.name !== LISTING_COMMAND &&
			command.name !== CONTROL_COMMAND,
	);
}

/**
 * Drop the usage tail the engine appends to a workflow's description.
 *
 * With an `argsSchema` the engine builds `"<description> Usage: /name <args>"`
 * so the palette can show a hint. In a picker row that tail is noise: the same
 * hint reappears the moment the choice is prefilled into the editor. Cosmetic
 * only — if the engine ever changes that format, rows simply get longer.
 */
function summarise(description: string | undefined): string {
	if (!description) return "";
	const usageAt = description.indexOf(" Usage: ");
	return (usageAt === -1 ? description : description.slice(0, usageAt)).trim();
}

/** One picker row: `/build — Plan a change, implement it item by item…`. */
export function pickerOption(command: CommandListing): string {
	const summary = summarise(command.description);
	return summary ? `/${command.name} — ${summary}` : `/${command.name}`;
}

/** Every row, workflows first, with the explicit chat escape last. */
export function pickerOptions(commands: readonly CommandListing[]): string[] {
	return [...commands.map(pickerOption), CHAT_OPTION];
}

/**
 * The command name behind a chosen row, or undefined for "chat instead",
 * a cancelled dialog (Esc), or a row this module did not produce.
 *
 * Parsing the label back is deliberate: `ui.select` resolves to the chosen
 * *string*, so the row text is the only thing that crosses back.
 */
export function chosenCommand(option: string | undefined): string | undefined {
	if (!option || option === CHAT_OPTION) return undefined;
	const match = /^\/([A-Za-z0-9][\w.-]*)/.exec(option);
	return match?.[1];
}

/** The text a chosen workflow leaves in the editor, cursor at the end. */
export function editorPrefill(name: string): string {
	return `/${name} `;
}

/** The subset of pi's `ExtensionUIContext` the picker uses. */
export interface PickerUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	getEditorText(): string;
	setEditorText(text: string): void;
}

/** The subset of pi's `ExtensionContext` the picker uses. */
export interface PickerContext {
	readonly mode: string;
	readonly ui: PickerUI;
}

/**
 * Show the picker and land the choice in the editor.
 *
 * Returns the chosen command name, or undefined when nothing was chosen — which
 * covers all four ways to end up in chat: Esc, the explicit chat row, no
 * workflows installed, and a non-TUI mode.
 *
 * Two guards, both load-bearing:
 *
 *   * **`mode !== "tui"` shows nothing.** In RPC mode `ui.select` emits an
 *     `extension_ui_request` and waits for the client to answer it, with no
 *     timeout unless one is passed. Every nix check in this repo drives `loom`
 *     over RPC with a script that cannot answer a dialog, so an unguarded
 *     picker would hang all of them rather than fail them. `ctx.mode` is the
 *     documented guard for terminal-only UI.
 *
 *   * **A non-empty editor is left alone.** `setEditorText` replaces the
 *     buffer. A session started with text already in the editor belongs to the
 *     user, and no menu is worth overwriting it.
 */
export async function offerWorkflowPicker(
	commands: readonly CommandListing[],
	ctx: PickerContext,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") return undefined;

	const workflows = workflowCommands(commands);
	if (workflows.length === 0) return undefined;

	if (ctx.ui.getEditorText().trim().length > 0) return undefined;

	const chosen = chosenCommand(await ctx.ui.select(PICKER_TITLE, pickerOptions(workflows)));
	if (!chosen) return undefined;

	ctx.ui.setEditorText(editorPrefill(chosen));
	return chosen;
}
